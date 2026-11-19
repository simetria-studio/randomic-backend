const { query } = require('./db');
const { isInteractionBlocked } = require('./routes/safety');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = "date_trunc('milliseconds', clock_timestamp())";
const MSG_COLS = 'id, conversation_id, sender_id, type, body, media_url, created_at, delivered_at, read_at, media_removed_at';

async function getConversation(convId) {
  if (!UUID_RE.test(String(convId))) return null;
  const { rows } = await query('SELECT id, user_a, user_b FROM conversations WHERE id = $1', [convId]);
  return rows[0] || null;
}

function partnerOf(conv, userId) {
  if (conv.user_a === userId) return conv.user_b;
  if (conv.user_b === userId) return conv.user_a;
  return null;
}

async function getOrCreateConversation(a, b) {
  if (a === b) throw new Error('usuarios_invalidos');
  if (!UUID_RE.test(String(a)) || !UUID_RE.test(String(b))) throw new Error('usuarios_invalidos');
  const { rows: users } = await query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [[a, b]]);
  if (users.length !== 2) throw new Error('usuarios_invalidos');
  if (await isInteractionBlocked(a, b)) throw new Error('bloqueado');
  const ins = await query(
    `INSERT INTO conversations (user_a, user_b) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING id`,
    [a, b]
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const { rows } = await query(
    `SELECT id FROM conversations
     WHERE LEAST(user_a, user_b) = LEAST($1::uuid, $2::uuid) AND GREATEST(user_a, user_b) = GREATEST($1::uuid, $2::uuid)`,
    [a, b]
  );
  return { id: rows[0].id, created: false };
}

function validate(msg) {
  if (!msg || !['text', 'audio', 'photo'].includes(msg.type)) throw new Error('mensagem_invalida');
  if (msg.type === 'text') {
    if (typeof msg.body !== 'string' || !msg.body.trim() || msg.body.length > 4000) {
      throw new Error('mensagem_invalida');
    }
  } else if (typeof msg.mediaUrl !== 'string' || !/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(msg.mediaUrl) || msg.mediaUrl.includes('..')) {
    throw new Error('mensagem_invalida');
  }
}

function toMessage(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    type: r.type,
    body: r.body,
    mediaUrl: r.media_removed_at ? null : r.media_url,
    mediaRemoved: !!r.media_removed_at,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    readAt: r.read_at,
  };
}

async function sendMessage(convId, senderId, msg) {
  const conv = await getConversation(convId);
  const other = conv && partnerOf(conv, senderId);
  if (!other) throw new Error('forbidden');
  if (await isInteractionBlocked(senderId, other)) throw new Error('bloqueado');
  validate(msg);
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, sender_id, type, body, media_url, created_at)
     VALUES ($1, $2, $3, $4, $5, ${NOW}) RETURNING ${MSG_COLS}`,
    [convId, senderId, msg.type, msg.type === 'text' ? msg.body : null, msg.type === 'text' ? null : msg.mediaUrl]
  );
  await query(
    `INSERT INTO conversation_state (conversation_id, user_id, hidden_at) VALUES ($1, $2, NULL)
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET hidden_at = NULL`,
    [convId, other]
  );
  return toMessage(rows[0]);
}

async function markDelivered(messageId) {
  const { rows } = await query(
    `UPDATE messages SET delivered_at = ${NOW} WHERE id = $1 AND delivered_at IS NULL RETURNING id`,
    [messageId]
  );
  return rows.length > 0;
}

// Marks every pending message addressed to userId as delivered; returns [{id, senderId}].
async function markAllDeliveredFor(userId) {
  const { rows } = await query(
    `UPDATE messages m SET delivered_at = ${NOW}
     FROM conversations c
     WHERE c.id = m.conversation_id AND $1 IN (c.user_a, c.user_b)
       AND m.sender_id <> $1 AND m.delivered_at IS NULL
     RETURNING m.id, m.sender_id`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, senderId: r.sender_id }));
}

async function markRead(convId, readerId) {
  const { rows } = await query(
    `UPDATE messages SET read_at = ${NOW}, delivered_at = COALESCE(delivered_at, ${NOW})
     WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND $2 IN (c.user_a, c.user_b))
     RETURNING id`,
    [convId, readerId]
  );
  return rows.map((r) => r.id);
}

async function listConversations(userId) {
  const { rows } = await query(
    `SELECT c.id, p.id AS partner_id, p.nickname, ph.url AS photo_url,
            lm.id AS lm_id, lm.type AS lm_type, lm.body AS lm_body, lm.created_at AS lm_created_at,
            lm.sender_id AS lm_sender_id,
            (SELECT count(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.read_at IS NULL
                AND (cs.cleared_before IS NULL OR m.created_at > cs.cleared_before)) AS unread
     FROM conversations c
     JOIN users p ON p.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
     LEFT JOIN conversation_state cs ON cs.conversation_id = c.id AND cs.user_id = $1
     LEFT JOIN LATERAL (
       SELECT m.* FROM messages m
       WHERE m.conversation_id = c.id AND (cs.cleared_before IS NULL OR m.created_at > cs.cleared_before)
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1
     ) lm ON true
     LEFT JOIN LATERAL (
       SELECT url FROM photos WHERE user_id = p.id ORDER BY position, id LIMIT 1
     ) ph ON true
     WHERE $1 IN (c.user_a, c.user_b)
       AND cs.hidden_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE (b.blocker_id = c.user_a AND b.blocked_id = c.user_b)
            OR (b.blocker_id = c.user_b AND b.blocked_id = c.user_a))
       AND NOT (p.status = 'banned'
                OR (p.status = 'suspended' AND (p.suspended_until IS NULL OR p.suspended_until > now())))
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    partner: { id: r.partner_id, nickname: r.nickname, photoUrl: r.photo_url || null },
    lastMessage: r.lm_id
      ? { id: r.lm_id, type: r.lm_type, body: r.lm_body, createdAt: r.lm_created_at, senderId: r.lm_sender_id }
      : null,
    unreadCount: r.unread,
  }));
}

async function listMessages(convId, userId, before, limit = 50) {
  const conv = await getConversation(convId);
  const other = conv && partnerOf(conv, userId);
  if (!other) throw new Error('forbidden');
  if (await isInteractionBlocked(userId, other)) throw new Error('bloqueado');
  let n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n)) n = 50;
  n = Math.min(100, Math.max(1, n));
  const params = [convId, userId, n];
  let beforeSql = '';
  if (before) {
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) throw new Error('cursor_invalido');
    params.push(d.toISOString());
    beforeSql = 'AND m.created_at < $4::timestamptz';
  }
  const { rows } = await query(
    `SELECT m.id, m.conversation_id, m.sender_id, m.type, m.body, m.media_url, m.created_at, m.delivered_at, m.read_at, m.media_removed_at
     FROM messages m
     LEFT JOIN conversation_state cs ON cs.conversation_id = m.conversation_id AND cs.user_id = $2
     WHERE m.conversation_id = $1
       AND (cs.cleared_before IS NULL OR m.created_at > cs.cleared_before)
       ${beforeSql}
     ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
    params
  );
  return rows.reverse().map(toMessage);
}

async function hideConversation(convId, userId) {
  const conv = await getConversation(convId);
  if (!conv || !partnerOf(conv, userId)) throw new Error('forbidden');
  await query(
    `INSERT INTO conversation_state (conversation_id, user_id, hidden_at, cleared_before)
     VALUES ($1, $2, ${NOW}, ${NOW})
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET hidden_at = EXCLUDED.hidden_at, cleared_before = EXCLUDED.cleared_before`,
    [convId, userId]
  );
}

module.exports = {
  getOrCreateConversation,
  sendMessage,
  markDelivered,
  markAllDeliveredFor,
  markRead,
  listConversations,
  listMessages,
  hideConversation,
  getConversation,
  toMessage,
  MSG_COLS,
};
