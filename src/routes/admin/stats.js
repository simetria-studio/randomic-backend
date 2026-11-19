const express = require('express');
const { query } = require('../../db');
const hub = require('../../hub');

const router = express.Router();

router.get('/stats', async (req, res, next) => {
  try {
    const u = (
      await query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new24h,
               count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7d,
               count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30d,
               count(*) FILTER (WHERE status = 'banned')::int AS banned,
               count(*) FILTER (WHERE status = 'suspended'
                                 AND (suspended_until IS NULL OR suspended_until > now()))::int AS suspended
        FROM users`)
    ).rows[0];
    const m = (
      await query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE type = 'text')::int AS text,
               count(*) FILTER (WHERE type = 'photo')::int AS photo,
               count(*) FILTER (WHERE type = 'audio')::int AS audio,
               count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7d,
               count(*) FILTER (WHERE created_at > now() - interval '7 days' AND type = 'text')::int AS l7text,
               count(*) FILTER (WHERE created_at > now() - interval '7 days' AND type = 'photo')::int AS l7photo,
               count(*) FILTER (WHERE created_at > now() - interval '7 days' AND type = 'audio')::int AS l7audio
        FROM messages`)
    ).rows[0];
    const conv = (await query('SELECT count(*)::int AS n FROM conversations')).rows[0].n;
    const open = (await query("SELECT count(*)::int AS n FROM reports WHERE status = 'open'")).rows[0].n;
    res.json({
      users: {
        total: u.total,
        new24h: u.new24h,
        new7d: u.new7d,
        new30d: u.new30d,
        online: hub.onlineCount(),
        active: u.total - u.suspended - u.banned,
        suspended: u.suspended,
        banned: u.banned,
      },
      conversations: { total: conv },
      messages: {
        total: m.total,
        last7d: m.last7d,
        byType: { text: m.text, photo: m.photo, audio: m.audio },
        last7dByType: { text: m.l7text, photo: m.l7photo, audio: m.l7audio },
      },
      reports: { open },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
