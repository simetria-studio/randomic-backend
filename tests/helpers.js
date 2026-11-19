const request = require('supertest');
const { pool } = require('../src/db');
const { loginLimiter } = require('../src/routes/auth');

async function resetDb() {
  loginLimiter.reset();
  await pool.query(
    'TRUNCATE users, photos, conversations, conversation_state, messages, blocks, reports, skips, admin_actions RESTART IDENTITY CASCADE'
  );
}

async function registerUser(app, email, nickname = 'ana') {
  const res = await request(app).post('/auth/register').send({
    email,
    password: 'senha1234',
    nickname,
    birthdate: '1990-01-01',
    gender: 'feminino',
  });
  if (res.status !== 201) throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.token;
  const me = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
  return { token, id: me.body.id };
}

function auth(u) {
  return { Authorization: `Bearer ${u.token}` };
}

async function setRole(id, role) {
  await pool.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
}

async function setStatus(id, { status, until = null, reason = null }) {
  await pool.query(
    'UPDATE users SET status = $2, suspended_until = $3, status_reason = $4 WHERE id = $1',
    [id, status, until, reason]
  );
}

async function makeAdmin(app, email, nickname = 'root') {
  const u = await registerUser(app, email, nickname);
  await setRole(u.id, 'admin');
  return u;
}

module.exports = { resetDb, registerUser, auth, setRole, setStatus, makeAdmin };
