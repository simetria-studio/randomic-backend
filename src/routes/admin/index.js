const express = require('express');
const { requireAuth, requireAdmin } = require('../../auth');
const { query } = require('../../db');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, nickname, email FROM users WHERE id = $1', [req.userId]);
    const u = rows[0];
    res.json({ id: u.id, nickname: u.nickname, email: u.email });
  } catch (e) {
    next(e);
  }
});

// Admin sub-routers are mounted here by later tasks (each exports a Router):
router.use(require('./stats'));
router.use(require('./users'));
router.use(require('./reports'));
router.use(require('./actions'));

module.exports = router;
