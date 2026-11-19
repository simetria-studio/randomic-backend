const { pool, query } = require('../src/db');
const { resetDb } = require('./helpers');
const { Matchmaker } = require('../src/matchmaking');

let seq = 0;
async function mkUser({ country = 'BR', gender = 'feminino' } = {}) {
  seq += 1;
  const r = await query(
    `INSERT INTO users (email, password_hash, nickname, birthdate, gender, country)
     VALUES ($1, 'x', 'n', '1990-01-01', $2, $3) RETURNING id`,
    [`u${seq}@t.com`, gender, country]
  );
  return r.rows[0].id;
}
const profile = (o = {}) => ({ age: 30, gender: 'feminino', country: 'BR', ...o });
const filter = (o = {}) => ({ minAge: 18, maxAge: 99, genders: [], country: 'BR', ...o });
const DAY = 24 * 3600 * 1000;

let clock;
let onMatch;
let onTimeout;
let mm;

beforeEach(async () => {
  await resetDb();
  clock = 1_700_000_000_000;
  onMatch = jest.fn();
  onTimeout = jest.fn();
  mm = new Matchmaker({ now: () => clock, onMatch, onTimeout });
});
afterAll(() => pool.end());

describe('Matchmaker', () => {
  test('two compatible users match once', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mm.enqueue(a, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(new Set(onMatch.mock.calls[0])).toEqual(new Set([a, b]));
    await mm.tick();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  test('gender filter that excludes prevents match', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mm.enqueue(a, profile({ gender: 'feminino' }), filter({ genders: ['masculino'] }));
    await mm.enqueue(b, profile({ gender: 'feminino' }), filter());
    expect(onMatch).not.toHaveBeenCalled();
  });

  test('compatibility is mutual (age)', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mm.enqueue(a, profile({ age: 30 }), filter({ minAge: 18, maxAge: 40 }));
    await mm.enqueue(b, profile({ age: 50 }), filter());
    expect(onMatch).not.toHaveBeenCalled();
  });

  test('default country BR excludes US', async () => {
    const a = await mkUser();
    const b = await mkUser({ country: 'US' });
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(b, profile({ country: 'US' }), filter({ country: 'US' }));
    expect(onMatch).not.toHaveBeenCalled();
  });

  test('blocked users never match', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)', [a, b]);
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
  });

  test('skip 29 days ago does not match, 31 days ago matches', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const c = await mkUser();
    await query('INSERT INTO skips (skipper_id, skipped_id, created_at) VALUES ($1,$2,$3)', [
      a, b, new Date(clock - 29 * DAY),
    ]);
    await query('INSERT INTO skips (skipper_id, skipped_id, created_at) VALUES ($1,$2,$3)', [
      c, a, new Date(clock - 31 * DAY),
    ]);
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
    await mm.dequeue(b);
    await mm.enqueue(c, profile(), filter());
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(new Set(onMatch.mock.calls[0])).toEqual(new Set([a, c]));
  });

  test('skip in the reverse direction also excludes; exactly 30 days is eligible', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const c = await mkUser();
    await query('INSERT INTO skips (skipper_id, skipped_id, created_at) VALUES ($1,$2,$3)', [
      b, a, new Date(clock - 5 * DAY),
    ]);
    await query('INSERT INTO skips (skipper_id, skipped_id, created_at) VALUES ($1,$2,$3)', [
      a, c, new Date(clock - 30 * DAY),
    ]);
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
    await mm.enqueue(c, profile(), filter());
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(new Set(onMatch.mock.calls[0])).toEqual(new Set([a, c]));
  });

  test('recordSkip upserts with injected clock time', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mm.recordSkip(a, b);
    await mm.recordSkip(a, b);
    const r = await query('SELECT created_at FROM skips WHERE skipper_id=$1 AND skipped_id=$2', [a, b]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].created_at.getTime()).toBe(clock);
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
  });

  test('existing conversation (even hidden) prevents match', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const conv = await query('INSERT INTO conversations (user_a, user_b) VALUES ($2,$1) RETURNING id', [a, b]);
    await query('INSERT INTO conversation_state (conversation_id, user_id, hidden_at) VALUES ($1,$2,now())', [
      conv.rows[0].id, a,
    ]);
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
  });

  test('same userId enqueued twice keeps one entry and never self-matches', async () => {
    const a = await mkUser();
    await mm.enqueue(a, profile(), filter());
    await mm.enqueue(a, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
    expect(mm.queue.size).toBe(1);
  });

  test('dequeue before partner arrives means no match', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await mm.enqueue(a, profile(), filter());
    mm.dequeue(a);
    await mm.enqueue(b, profile(), filter());
    expect(onMatch).not.toHaveBeenCalled();
    await mm.tick();
    clock += 61000;
    await mm.tick();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(b);
  });

  test('timeout: exactly 60s not expired, 61s expired once', async () => {
    const a = await mkUser();
    await mm.enqueue(a, profile(), filter());
    clock += 60000;
    await mm.tick();
    expect(onTimeout).not.toHaveBeenCalled();
    clock += 1000;
    await mm.tick();
    expect(onTimeout).toHaveBeenCalledWith(a);
    await mm.tick();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(mm.queue.size).toBe(0);
  });

  test('minAge > maxAge rejects', async () => {
    const a = await mkUser();
    await expect(mm.enqueue(a, profile(), filter({ minAge: 40, maxAge: 20 }))).rejects.toThrow(
      'filtro_invalido'
    );
    expect(mm.queue.size).toBe(0);
  });

  test('concurrent enqueues do not double-match', async () => {
    const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];
    await Promise.all([
      mm.enqueue(a, profile(), filter()),
      mm.enqueue(b, profile(), filter()),
      mm.enqueue(c, profile(), filter()),
    ]);
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(mm.queue.size).toBe(1);
  });
});
