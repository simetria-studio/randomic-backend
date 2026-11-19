const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-re-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachRealtime } = require('../src/realtime');
const hub = require('../src/hub');
const { resetDb, registerUser, auth, setStatus } = require('./helpers');
const { pool, query } = require('../src/db');
const { getOrCreateConversation, listConversations } = require('../src/conversations');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const FILTER = { minAge: 18, maxAge: 99, genders: [], country: 'BR' };

let server, url, rt, app;
const sockets = [];

beforeAll(async () => {
  app = createApp();
  server = http.createServer(app);
  rt = attachRealtime(server, { pushSender: jest.fn().mockResolvedValue() });
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await rt.io.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await pool.end();
});
beforeEach(resetDb);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.close());
  for (const id of [...rt.matchmaker.queue.keys()]) rt.matchmaker.dequeue(id);
});

async function user(email, nickname) {
  const u = await registerUser(app, email, nickname);
  await request(app).post('/me/photos').set(auth(u)).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' });
  return u;
}
function client(token) {
  const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const once = (s, ev, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${ev}`)), ms);
    s.once(ev, (d) => {
      clearTimeout(t);
      resolve(d);
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("emitRestricted disconnects the user's sockets and removes from queue", async () => {
  const a = await user('a@b.com', 'ana');
  const s = await client(a.token);
  s.emit('search:start', FILTER);
  await sleep(300);
  expect(rt.matchmaker.queue.has(a.id)).toBe(true);
  const gone = once(s, 'disconnect');
  hub.emitRestricted(a.id);
  await gone;
  expect(s.connected).toBe(false);
  expect(rt.matchmaker.queue.has(a.id)).toBe(false);
});

test('restricted user is never matched', async () => {
  const a = await user('a@b.com', 'ana');
  const b = await user('b@b.com', 'bia');
  const sa = await client(a.token);
  const sb = await client(b.token);
  sa.emit('search:start', FILTER);
  await sleep(300);
  await setStatus(a.id, { status: 'banned' });
  let found = false;
  sb.on('search:found', () => (found = true));
  sa.on('search:found', () => (found = true));
  sb.emit('search:start', FILTER);
  await sleep(500);
  expect(found).toBe(false);
});

test('partner cannot send or load messages with a suspended user', async () => {
  const a = await user('a@b.com', 'ana');
  const b = await user('b@b.com', 'bia');
  const { id } = await getOrCreateConversation(a.id, b.id);
  const sa = await client(a.token);
  await setStatus(b.id, { status: 'suspended', until: new Date(Date.now() + 3600e3) });
  await request(app).get(`/conversations/${id}/messages`).set(auth(a)).expect(403, { error: 'bloqueado' });
  const err = once(sa, 'error');
  sa.emit('message:send', { conversationId: id, type: 'text', body: 'oi' });
  expect((await err).code).toBe('bloqueado');
  await expect(getOrCreateConversation(a.id, b.id)).rejects.toThrow('bloqueado');
});

test("suspended partner's conversation disappears from list and returns after reactivation", async () => {
  const a = await user('a@b.com', 'ana');
  const b = await user('b@b.com', 'bia');
  await getOrCreateConversation(a.id, b.id);
  expect(await listConversations(a.id)).toHaveLength(1);
  await setStatus(b.id, { status: 'suspended', until: null });
  expect(await listConversations(a.id)).toHaveLength(0);
  await query("UPDATE users SET status='active', suspended_until=NULL WHERE id=$1", [b.id]);
  expect(await listConversations(a.id)).toHaveLength(1);
  // expired suspension also counts as active
  await setStatus(b.id, { status: 'suspended', until: new Date(Date.now() - 1000) });
  expect(await listConversations(a.id)).toHaveLength(1);
});

test('media upload to a conversation with a restricted partner is refused', async () => {
  const a = await user('a@b.com', 'ana');
  const b = await user('b@b.com', 'bia');
  const { id } = await getOrCreateConversation(a.id, b.id);
  await setStatus(b.id, { status: 'banned' });
  await request(app)
    .post(`/conversations/${id}/media`)
    .set(auth(a))
    .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
    .expect(403, { error: 'bloqueado' });
});

test('onlineCount counts distinct connected users', async () => {
  const a = await user('a@b.com', 'ana');
  const b = await user('b@b.com', 'bia');
  expect(hub.onlineCount()).toBe(0);
  await client(a.token);
  await client(a.token);
  expect(hub.onlineCount()).toBe(1);
  await client(b.token);
  expect(hub.onlineCount()).toBe(2);
});
