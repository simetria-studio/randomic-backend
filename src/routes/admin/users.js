const express = require('express');
const { query } = require('../../db');
const { ageOf } = require('../../profile');
const { effectiveStatus } = require('../../accountStatus');
const { parsePaging, pageResult } = require('./paging');
const { listReportItems } = require('./reportItem');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Effective status in SQL (expired suspension counts as active).
const EFF_STATUS = `(CASE WHEN u.status = 'banned' THEN 'banned'
  WHEN u.status = 'suspended' AND (u.suspended_until IS NULL OR u.suspended_until > now()) THEN 'suspended'
  ELSE 'active' END)`;

const USER_SELECT = `
  SELECT u.id, u.email, u.nickname, u.gender, u.country, u.birthdate, u.status, u.suspended_until,
         u.created_at, u.role, u.status_reason,
         (SELECT count(*)::int FROM reports r WHERE r.reported_id = u.id) AS reports_received,
         (SELECT count(*)::int FROM reports r WHERE r.reporter_id = u.id) AS reports_made
  FROM users u`;

function toUserItem(r) {
  const status = effectiveStatus(r);
  return {
    id: r.id,
    email: r.email,
    nickname: r.nickname,
    gender: r.gender,
    country: r.country,
    age: ageOf(r.birthdate),
    status,
    suspendedUntil: status === 'suspended' && r.suspended_until ? new Date(r.suspended_until).toISOString() : null,
    createdAt: r.created_at,
    reportsReceived: r.reports_received,
    reportsMade: r.reports_made,
  };
}

async function userRow(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const { rows } = await query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] || null;
}

// User item (same shape as GET /users items) or null when the id is unknown/malformed.
async function userItem(id) {
  const row = await userRow(id);
  return row ? toUserItem(row) : null;
}

router.get('/users', async (req, res, next) => {
  try {
    const paging = parsePaging(req.query);
    const where = [];
    const params = [];
    const add = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const p = add(`%${req.query.q.trim().replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(u.nickname ILIKE ${p} OR u.email ILIKE ${p})`);
    }
    if (['active', 'suspended', 'banned'].includes(req.query.status)) {
      where.push(`${EFF_STATUS} = ${add(req.query.status)}`);
    }
    if (typeof req.query.country === 'string' && req.query.country) {
      where.push(`u.country = ${add(req.query.country.toUpperCase())}`);
    }
    if (typeof req.query.gender === 'string' && req.query.gender) {
      where.push(`u.gender = ${add(req.query.gender)}`);
    }
    const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = (await query(`SELECT count(*)::int AS n FROM users u${w}`, params)).rows[0].n;
    const limit = add(paging.pageSize);
    const offset = add(paging.offset);
    const { rows } = await query(
      `${USER_SELECT}${w} ORDER BY u.created_at DESC, u.id LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json(pageResult(rows.map(toUserItem), total, paging));
  } catch (e) {
    next(e);
  }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const row = await userRow(id);
    if (!row) return res.status(404).json({ error: 'nao_encontrado' });
    const photos = (await query('SELECT id, url FROM photos WHERE user_id = $1 ORDER BY position, id', [id])).rows;
    const [reportsReceived, reportsMade] = await Promise.all([
      listReportItems({ where: 'r.reported_id = $1', params: [id], limit: 50 }),
      listReportItems({ where: 'r.reporter_id = $1', params: [id], limit: 50 }),
    ]);
    const actions = (
      await query(
        `SELECT a.id, a.action, a.reason, a.created_at, a.admin_id, ad.nickname AS admin_nickname,
                a.report_id, a.target_message_id
         FROM admin_actions a LEFT JOIN users ad ON ad.id = a.admin_id
         WHERE a.target_user_id = $1 ORDER BY a.created_at DESC, a.id LIMIT 100`,
        [id]
      )
    ).rows.map((a) => ({
      id: a.id,
      action: a.action,
      reason: a.reason,
      createdAt: a.created_at,
      admin: a.admin_id ? { id: a.admin_id, nickname: a.admin_nickname } : null,
      reportId: a.report_id,
      messageId: a.target_message_id,
    }));
    res.json({
      user: { ...toUserItem(row), role: row.role, statusReason: row.status_reason, photos },
      reportsReceived,
      reportsMade,
      actions,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.userItem = userItem;
