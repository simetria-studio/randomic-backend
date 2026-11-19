const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-as-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachRealtime } = require('../src/realtime');
const { resetDb, registerUser, auth, setStatus } = require('./helpers');
const { pool } = require('../src/db');

let app, server, url, rt;
const sockets = [];

beforeAll(async () => {
  app = createApp();
  server = http.createServer(app);
  rt = attachRealtime(server, { pushSender: jest.fn().mockResolvedValue() });
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
afterAll(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await rt.io.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await pool.end();
});
beforeEach(resetDb);
afterEach(() => sockets.splice(0).forEach((s) => s.close()));

function client(token) {
  const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const yesterday = () => new Date(Date.now() - 86400000).toISOString();
const tomorrow = () => new Date(Date.now() + 86400000).toISOString();

test('token without tv claim still works', async () => {
  const u = await registerUser(app, 'a@x.com');
  const token = jwt.sign({ sub: u.id }, 'test-secret', { expiresIn: '30d' });
  const res = await request(app).get('/me').set({ Authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
});

test('banned user gets 403 conta_banida with reason on any authenticated route', async () => {
  const u = await registerUser(app, 'a@x.com');
  await setStatus(u.id, { status: 'banned', reason: 'spam' });
  for (const p of ['/me', '/conversations']) {
    const res = await request(app).get(p).set(auth(u));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'conta_banida', until: null, reason: 'spam' });
  }
});

test('suspended user gets 403 conta_suspensa with until', async () => {
  const u = await registerUser(app, 'a@x.com');
  const until = tomorrow();
  await setStatus(u.id, { status: 'suspended', until, reason: 'abuso' });
  const res = await request(app).get('/me').set(auth(u));
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('conta_suspensa');
  expect(res.body.reason).toBe('abuso');
  expect(new Date(res.body.until).getTime()).toBe(new Date(until).getTime());
});

test('expired suspension acts as active', async () => {
  const u = await registerUser(app, 'a@x.com');
  await setStatus(u.id, { status: 'suspended', until: yesterday(), reason: 'x' });
  const res = await request(app).get('/me').set(auth(u));
  expect(res.status).toBe(200);
});

test('stale tv returns 401 token_invalido', async () => {
  const u = await registerUser(app, 'a@x.com');
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [u.id]);
  const res = await request(app).get('/me').set(auth(u));
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'token_invalido' });
});

test("deleted user's token returns 401", async () => {
  const u = await registerUser(app, 'a@x.com');
  await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
  const res = await request(app).get('/me').set(auth(u));
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'token_invalido' });
});

test('login refused for suspended/banned with correct password, 401 with wrong password', async () => {
  const u = await registerUser(app, 'a@x.com');
  const login = (password) => request(app).post('/auth/login').send({ email: 'a@x.com', password });

  await setStatus(u.id, { status: 'suspended', until: tomorrow(), reason: 'r1' });
  let res = await login('senha1234');
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('conta_suspensa');
  expect(res.body.reason).toBe('r1');
  expect(res.body.token).toBeUndefined();
  res = await login('errada123');
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'credenciais_invalidas' });

  await setStatus(u.id, { status: 'banned', reason: 'r2' });
  res = await login('senha1234');
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: 'conta_banida', until: null, reason: 'r2' });
  res = await login('errada123');
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: 'credenciais_invalidas' });
});

test('login token carries current token_version', async () => {
  const u = await registerUser(app, 'a@x.com');
  await pool.query('UPDATE users SET token_version = 3 WHERE id = $1', [u.id]);
  const res = await request(app).post('/auth/login').send({ email: 'a@x.com', password: 'senha1234' });
  expect(res.status).toBe(200);
  expect(jwt.verify(res.body.token, 'test-secret').tv).toBe(3);
  const me = await request(app).get('/me').set({ Authorization: `Bearer ${res.body.token}` });
  expect(me.status).toBe(200);
});

test('socket handshake rejected with connect_error message conta_banida and err.data.reason', async () => {
  const u = await registerUser(app, 'a@x.com');
  await setStatus(u.id, { status: 'banned', reason: 'spam' });
  const err = await client(u.token).then(
    () => null,
    (e) => e
  );
  expect(err).not.toBeNull();
  expect(err.message).toBe('conta_banida');
  expect(err.data.reason).toBe('spam');
});

test('socket handshake with garbage token still reports nao_autenticado', async () => {
  const err = await client('lixo').then(
    () => null,
    (e) => e
  );
  expect(err.message).toBe('nao_autenticado');
});

test('socket still connects for active users', async () => {
  const u = await registerUser(app, 'a@x.com');
  const s = await client(u.token);
  expect(s.connected).toBe(true);
});
