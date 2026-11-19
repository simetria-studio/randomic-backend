const { query } = require('../../db');
const { effectiveStatus } = require('../../accountStatus');

// Shared by users detail (Task 6), reports endpoints (Task 7) and actions (Task 8).
// Rows come from REPORT_SELECT; extra report columns (resolved_at, resolved_by...) are available via r.*.
const REPORT_SELECT = `
  SELECT r.*,
         rp.nickname AS reporter_nickname,
         rd.nickname AS reported_nickname,
         rd.status AS reported_status,
         rd.suspended_until AS reported_suspended_until,
         (r.reporter_id IS NOT NULL AND r.reported_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM conversations c
            WHERE LEAST(c.user_a, c.user_b) = LEAST(r.reporter_id, r.reported_id)
              AND GREATEST(c.user_a, c.user_b) = GREATEST(r.reporter_id, r.reported_id)
         )) AS has_conversation
  FROM reports r
  LEFT JOIN users rp ON rp.id = r.reporter_id
  LEFT JOIN users rd ON rd.id = r.reported_id`;

function toReportItem(row, now = new Date()) {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    reporter: row.reporter_id ? { id: row.reporter_id, nickname: row.reporter_nickname } : null,
    reported: row.reported_id
      ? {
          id: row.reported_id,
          nickname: row.reported_nickname,
          status: effectiveStatus(
            { status: row.reported_status, suspended_until: row.reported_suspended_until },
            now
          ),
        }
      : null,
    hasConversation: !!row.has_conversation,
  };
}

// `where` is a SQL fragment over alias r (e.g. 'r.status = $1'), `params` its values.
// Ordered newest first; optional limit/offset are appended as extra params.
async function listReportItems({ where = 'TRUE', params = [], limit = null, offset = 0 } = {}) {
  const p = [...params];
  let tail = '';
  if (limit != null) {
    p.push(limit, offset);
    tail = ` LIMIT $${p.length - 1} OFFSET $${p.length}`;
  }
  const { rows } = await query(`${REPORT_SELECT} WHERE ${where} ORDER BY r.created_at DESC, r.id${tail}`, p);
  return rows.map((r) => toReportItem(r));
}

// Raw row (REPORT_SELECT columns) or null.
async function reportRowById(id) {
  const { rows } = await query(`${REPORT_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] || null;
}

async function reportItemById(id) {
  const row = await reportRowById(id);
  return row ? toReportItem(row) : null;
}

module.exports = { REPORT_SELECT, toReportItem, listReportItems, reportRowById, reportItemById };
