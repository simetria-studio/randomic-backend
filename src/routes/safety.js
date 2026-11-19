const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function isBlockedEitherWay(a, b) {
  const { rows } = await query(
    `SELECT 1 FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [a, b]
  );
  return rows.length > 0;
}

// Blocked either way, or either user not effectively active (same rule as accountStatus.effectiveStatus).
async function isInteractionBlocked(a, b) {
  const { rows } = await query(
    `SELECT (
       EXISTS (SELECT 1 FROM blocks
               WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1))
       OR EXISTS (SELECT 1 FROM users
                  WHERE id IN ($1, $2)
                    AND (status = 'banned'
                         OR (status = 'suspended' AND (suspended_until IS NULL OR suspended_until > now()))))
     ) AS blocked`,
    [a, b]
  );
  return rows[0].blocked;
}

// Validates the :id target; sends the error response and returns false when invalid.
async function checkTarget(req, res) {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'usuario_nao_encontrado' });
    return false;
  }
  if (id === req.userId) {
    res.status(400).json({ error: 'usuario_invalido' });
    return false;
  }
  const { rows } = await query('SELECT 1 FROM users WHERE id = $1', [id]);
  if (!rows[0]) {
    res.status(404).json({ error: 'usuario_nao_encontrado' });
    return false;
  }
  return true;
}

router.post('/users/:id/block', requireAuth, async (req, res, next) => {
  try {
    if (!(await checkTarget(req, res))) return;
    await query(
      'INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.userId, req.params.id]
    );
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

router.delete('/users/:id/block', requireAuth, async (req, res, next) => {
  try {
    if (UUID_RE.test(req.params.id)) {
      await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.userId, req.params.id]);
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

router.get('/blocks', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id AS "userId", u.nickname,
              (SELECT p.url FROM photos p WHERE p.user_id = u.id ORDER BY p.position, p.id LIMIT 1) AS "photoUrl"
       FROM blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/users/:id/report', requireAuth, async (req, res, next) => {
  try {
    if (!(await checkTarget(req, res))) return;
    const { reason } = req.body || {};
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmed || trimmed.length > 500) return res.status(400).json({ error: 'motivo_invalido' });
    await query('INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1, $2, $3)', [
      req.userId,
      req.params.id,
      trimmed,
    ]);
    res.status(201).json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.isBlockedEitherWay = isBlockedEitherWay;
module.exports.isInteractionBlocked = isInteractionBlocked;
