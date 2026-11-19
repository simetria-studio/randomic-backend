const { query } = require('./db');
const { isInteractionBlocked } = require('./routes/safety');

const SKIP_WINDOW_MS = 30 * 24 * 3600 * 1000;

function satisfies(profile, filter) {
  if (profile.age < filter.minAge || profile.age > filter.maxAge) return false;
  if (filter.genders && filter.genders.length > 0 && !filter.genders.includes(profile.gender)) {
    return false;
  }
  return profile.country === (filter.country || 'BR');
}

class Matchmaker {
  constructor({ now = () => Date.now(), timeoutMs = 60000, onMatch = () => {}, onTimeout = () => {} } = {}) {
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.onMatch = onMatch;
    this.onTimeout = onTimeout;
    this.queue = new Map();
    this.chain = Promise.resolve();
  }

  _serialize(fn) {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async enqueue(userId, profile, filter) {
    if (filter.minAge > filter.maxAge) throw new Error('filtro_invalido');
    this.queue.set(userId, { userId, profile, filter, enqueuedAt: this.now() });
    await this._serialize(() => this._tryMatch(userId));
  }

  dequeue(userId) {
    this.queue.delete(userId);
  }

  async recordSkip(skipper, skipped) {
    await query(
      `INSERT INTO skips (skipper_id, skipped_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (skipper_id, skipped_id) DO UPDATE SET created_at = EXCLUDED.created_at`,
      [skipper, skipped, new Date(this.now())]
    );
  }

  async tick() {
    const t = this.now();
    for (const [userId, entry] of [...this.queue]) {
      if (t - entry.enqueuedAt > this.timeoutMs) {
        this.queue.delete(userId);
        this.onTimeout(userId);
      }
    }
  }

  async _excluded(a, b) {
    if (await isInteractionBlocked(a, b)) return true;
    const conv = await query(
      `SELECT 1 FROM conversations
       WHERE LEAST(user_a, user_b) = LEAST($1::uuid, $2::uuid)
         AND GREATEST(user_a, user_b) = GREATEST($1::uuid, $2::uuid)`,
      [a, b]
    );
    if (conv.rowCount > 0) return true;
    const cutoff = new Date(this.now() - SKIP_WINDOW_MS);
    const skip = await query(
      `SELECT 1 FROM skips
       WHERE ((skipper_id = $1 AND skipped_id = $2) OR (skipper_id = $2 AND skipped_id = $1))
         AND created_at > $3`,
      [a, b, cutoff]
    );
    return skip.rowCount > 0;
  }

  async _tryMatch(userId) {
    const me = this.queue.get(userId);
    if (!me) return;
    for (const other of [...this.queue.values()]) {
      if (other.userId === userId) continue;
      if (!satisfies(me.profile, other.filter) || !satisfies(other.profile, me.filter)) continue;
      if (await this._excluded(userId, other.userId)) continue;
      // state may have changed while awaiting
      if (!this.queue.has(userId) || !this.queue.has(other.userId)) {
        if (!this.queue.has(userId)) return;
        continue;
      }
      this.queue.delete(userId);
      this.queue.delete(other.userId);
      this.onMatch(other.userId, userId);
      return;
    }
  }
}

module.exports = { Matchmaker };
