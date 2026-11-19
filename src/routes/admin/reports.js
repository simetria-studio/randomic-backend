const express = require('express');
const { query } = require('../../db');
const { toMessage } = require('../../conversations');
const { parsePaging, pageResult } = require('./paging');
const { listReportItems, reportRowById, toReportItem } = require('./reportItem');
const { userItem } = require('./users');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (res) => res.status(404).json({ error: 'nao_encontrado' });

async function profile(id) {
  if (!id) return null;
  const u = await userItem(id);
  if (!u) return null;
  const photos = (await query('SELECT url FROM photos WHERE user_id = $1 ORDER BY position, id', [id])).rows;
  return {
    id: u.id,
    nickname: u.nickname,
    age: u.age,
    gender: u.gender,
    country: u.country,
    status: u.status,
    photos: photos.map((p) => p.url),
  };
}

async function conversationIdFor(row) {
  if (!row.reporter_id || !row.reported_id) return null;
  const { rows } = await query(
    `SELECT id FROM conversations
     WHERE LEAST(user_a, user_b) = LEAST($1::uuid, $2::uuid) AND GREATEST(user_a, user_b) = GREATEST($1::uuid, $2::uuid)`,
    [row.reporter_id, row.reported_id]
  );
  return rows[0] ? rows[0].id : null;
}

async function loadRow(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return reportRowById(id);
}

router.get('/reports', async (req, res, next) => {
  try {
    const paging = parsePaging(req.query);
    const s = req.query.status;
    const status = ['open', 'dismissed', 'actioned', 'all'].includes(s) ? s : 'open';
    const where = status === 'all' ? 'TRUE' : 'r.status = $1';
    const params = status === 'all' ? [] : [status];
    const total = (await query(`SELECT count(*)::int AS n FROM reports r WHERE ${where}`, params)).rows[0].n;
    const items = await listReportItems({ where, params, limit: paging.pageSize, offset: paging.offset });
    res.json(pageResult(items, total, paging));
  } catch (e) {
    next(e);
  }
});

router.get('/reports/:id', async (req, res, next) => {
  try {
    const row = await loadRow(req.params.id);
    if (!row) return notFound(res);
    let resolvedBy = null;
    if (row.resolved_by) {
      const { rows } = await query('SELECT id, nickname FROM users WHERE id = $1', [row.resolved_by]);
      resolvedBy = rows[0] || null;
    }
    const [reporter, reported, conversationId] = await Promise.all([
      profile(row.reporter_id),
      profile(row.reported_id),
      conversationIdFor(row),
    ]);
    res.json({
      report: { ...toReportItem(row), resolvedAt: row.resolved_at, resolvedBy },
      reporter,
      reported,
      conversationId,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/reports/:id/messages', async (req, res, next) => {
  try {
    const row = await loadRow(req.params.id);
    if (!row) return notFound(res);
    const convId = await conversationIdFor(row);
    if (!convId) return res.json([]);
    let n = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(n)) n = 50;
    n = Math.min(100, Math.max(1, n));
    const params = [convId, n];
    let beforeSql = '';
    if (req.query.before) {
      const d = new Date(req.query.before);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'cursor_invalido' });
      params.push(d.toISOString());
      beforeSql = 'AND created_at < $3::timestamptz';
    }
    const { rows } = await query(
      `SELECT id, conversation_id, sender_id, type, body, media_url, created_at, media_removed_at
       FROM messages WHERE conversation_id = $1 ${beforeSql}
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      params
    );
    res.json(
      rows.reverse().map((r) => {
        const m = toMessage(r);
        return {
          id: m.id,
          senderId: m.senderId,
          type: m.type,
          body: m.body,
          mediaUrl: m.mediaUrl,
          mediaRemoved: m.mediaRemoved,
          createdAt: m.createdAt,
        };
      })
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;
