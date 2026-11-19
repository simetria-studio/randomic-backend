const express = require('express');
const bcrypt = require('bcrypt');
const { query } = require('../db');
const { signToken, requireAuth, isAdult } = require('../auth');
const { effectiveStatus, restrictionBody } = require('../accountStatus');

const { createLimiter } = require('../rateLimit');

const router = express.Router();
const loginLimiter = createLimiter({
  max: Number(process.env.LOGIN_MAX_FAILURES) || 10,
  windowMs: 15 * 60 * 1000,
});
const GENDERS = ['masculino', 'feminino', 'outro'];

function publicUser(row) {
  const b = row.birthdate;
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname,
    birthdate: b instanceof Date ? b.toISOString().slice(0, 10) : b,
    gender: row.gender,
    country: row.country,
  };
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, nickname, birthdate, gender, country } = req.body || {};
    if (typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'email_invalido' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'senha_curta' });
    if (typeof nickname !== 'string' || !nickname.trim()) return res.status(400).json({ error: 'apelido_invalido' });
    if (!validDate(birthdate)) return res.status(400).json({ error: 'data_invalida' });
    if (!GENDERS.includes(gender)) return res.status(400).json({ error: 'genero_invalido' });
    if (!isAdult(birthdate, new Date())) return res.status(400).json({ error: 'menor_de_18' });

    const hash = await bcrypt.hash(password, 10);
    try {
      const { rows } = await query(
        `INSERT INTO users (email, password_hash, nickname, birthdate, gender, country)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'BR')) RETURNING *`,
        [email.toLowerCase(), hash, nickname.trim(), birthdate, gender, country || null]
      );
      res.status(201).json({ token: signToken(rows[0].id, rows[0].token_version), user: publicUser(rows[0]) });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'email_em_uso' });
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const key = req.ip;
    if (loginLimiter.isBlocked(key)) return res.status(429).json({ error: 'muitas_tentativas' });
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      loginLimiter.fail(key);
      return res.status(401).json({ error: 'credenciais_invalidas' });
    }
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      loginLimiter.fail(key);
      return res.status(401).json({ error: 'credenciais_invalidas' });
    }
    // no reset on success: a per-IP counter must not be wipeable by logging into another account
    // password already verified: only now reveal the restriction
    if (effectiveStatus(user) !== 'active') return res.status(403).json(restrictionBody(user));
    res.json({ token: signToken(user.id, user.token_version), user: publicUser(user) });
  } catch (e) {
    next(e);
  }
});

router.delete('/account', requireAuth, async (req, res, next) => {
  try {
    await query('DELETE FROM users WHERE id = $1', [req.userId]);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.loginLimiter = loginLimiter;
