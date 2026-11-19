const express = require('express');
const { pool } = require('../../db');
const hub = require('../../hub');
const { deleteFile } = require('../../storage');
const { userItem } = require('./users');
const { reportItemById } = require('./reportItem');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
const fail = (status, code) => {
  throw new ApiError(status, code);
};

function parseReason(body) {
  const r = body && body.reason;
  if (typeof r !== 'string') fail(400, 'motivo_invalido');
  const t = r.trim();
  if (t.length < 1 || t.length > 500) fail(400, 'motivo_invalido');
  return t;
}

// Optional reportId: must be a well-formed id of an existing report.
function parseReportId(body) {
  const id = body && body.reportId;
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string' || !UUID_RE.test(id)) fail(404, 'nao_encontrado');
  return id;
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

// Marks the (existing) report as actioned by the admin; 404 when it does not exist and
// 400 when the report does not involve the target user (reporter or reported).
async function actionReport(client, reportId, adminId, targetUserId) {
  const { rows } = await client.query('SELECT reporter_id, reported_id FROM reports WHERE id = $1 FOR UPDATE', [reportId]);
  if (!rows[0]) fail(404, 'nao_encontrado');
  if (rows[0].reporter_id !== targetUserId && rows[0].reported_id !== targetUserId) fail(400, 'denuncia_invalida');
  await client.query(
    "UPDATE reports SET status = 'actioned', resolved_by = $2, resolved_at = now() WHERE id = $1",
    [reportId, adminId]
  );
}

function logAction(client, { adminId, action, userId = null, messageId = null, reportId = null, reason }) {
  return client.query(
    `INSERT INTO admin_actions (admin_id, action, target_user_id, target_message_id, report_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, action, userId, messageId, reportId, reason]
  );
}

// Locks and validates the target user: exists, not the admin, not an admin.
async function lockTarget(client, id, adminId) {
  if (!UUID_RE.test(id)) fail(404, 'nao_encontrado');
  const { rows } = await client.query('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) fail(404, 'nao_encontrado');
  if (rows[0].id === adminId || rows[0].role === 'admin') fail(400, 'alvo_invalido');
}

function userAction(kind) {
  return async (req, res, next) => {
    try {
      const adminId = req.userId;
      const targetId = req.params.id;
      const reason = parseReason(req.body);
      const reportId = parseReportId(req.body);
      let until = null;
      if (kind === 'suspend') {
        const raw = req.body.until;
        const d = typeof raw === 'string' ? new Date(raw) : null;
        if (!d || Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) fail(400, 'data_invalida');
        until = d;
      }
      await withTx(async (client) => {
        await lockTarget(client, targetId, adminId);
        // token_version bump invalidates every token issued before this change
        if (kind === 'reactivate') {
          await client.query(
            `UPDATE users SET status = 'active', suspended_until = NULL, status_reason = NULL,
                    token_version = token_version + 1 WHERE id = $1`,
            [targetId]
          );
        } else {
          await client.query(
            `UPDATE users SET status = $2, suspended_until = $3, status_reason = $4,
                    token_version = token_version + 1 WHERE id = $1`,
            [targetId, kind === 'suspend' ? 'suspended' : 'banned', until, reason]
          );
        }
        if (reportId) await actionReport(client, reportId, adminId, targetId);
        await logAction(client, { adminId, action: kind, userId: targetId, reportId, reason });
      });
      if (kind !== 'reactivate') hub.emitRestricted(targetId);
      res.json(await userItem(targetId));
    } catch (e) {
      handle(e, res, next);
    }
  };
}

function handle(e, res, next) {
  if (e instanceof ApiError) return res.status(e.status).json({ error: e.message });
  return next(e);
}

router.post('/users/:id/suspend', userAction('suspend'));
router.post('/users/:id/ban', userAction('ban'));
router.post('/users/:id/reactivate', userAction('reactivate'));

router.post('/messages/:id/remove-media', async (req, res, next) => {
  try {
    const adminId = req.userId;
    const id = req.params.id;
    const reason = parseReason(req.body);
    const reportId = parseReportId(req.body);
    if (!UUID_RE.test(id)) fail(404, 'nao_encontrado');
    const oldUrl = await withTx(async (client) => {
      const { rows } = await client.query(
        'SELECT media_url, media_removed_at, sender_id FROM messages WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!rows[0]) fail(404, 'nao_encontrado');
      if (!rows[0].media_url || rows[0].media_removed_at) fail(409, 'sem_midia');
      await client.query('UPDATE messages SET media_removed_at = now(), media_url = NULL WHERE id = $1', [id]);
      if (reportId) await actionReport(client, reportId, adminId, rows[0].sender_id);
      await logAction(client, {
        adminId,
        action: 'remove_media',
        userId: rows[0].sender_id,
        messageId: id,
        reportId,
        reason,
      });
      // the same file may back a profile photo or another message (client-supplied mediaUrl)
      const url = rows[0].media_url;
      const { rows: used } = await client.query(
        `SELECT 1 FROM photos WHERE url = $1
         UNION ALL
         SELECT 1 FROM messages WHERE media_url = $1 AND media_removed_at IS NULL AND id <> $2
         LIMIT 1`,
        [url, id]
      );
      return used.length ? null : url;
    });
    // after commit: a missing/unremovable file must not fail the request (deleteFile swallows errors)
    if (oldUrl) {
      try {
        await deleteFile(oldUrl);
      } catch (e) {
        console.error('[admin] deleteFile', e);
      }
    }
    res.json({ id, mediaRemoved: true });
  } catch (e) {
    handle(e, res, next);
  }
});

// Only open reports can be dismissed (409 denuncia_ja_resolvida otherwise).
router.post('/reports/:id/dismiss', async (req, res, next) => {
  try {
    const adminId = req.userId;
    const id = req.params.id;
    const reason = parseReason(req.body);
    if (!UUID_RE.test(id)) fail(404, 'nao_encontrado');
    await withTx(async (client) => {
      const { rows } = await client.query(
        `UPDATE reports SET status = 'dismissed', resolved_by = $2, resolved_at = now()
         WHERE id = $1 AND status = 'open' RETURNING reported_id`,
        [id, adminId]
      );
      if (!rows[0]) {
        const { rowCount } = await client.query('SELECT 1 FROM reports WHERE id = $1', [id]);
        fail(rowCount ? 409 : 404, rowCount ? 'denuncia_ja_resolvida' : 'nao_encontrado');
      }
      await logAction(client, { adminId, action: 'dismiss_report', userId: rows[0].reported_id, reportId: id, reason });
    });
    res.json(await reportItemById(id));
  } catch (e) {
    handle(e, res, next);
  }
});

module.exports = router;
