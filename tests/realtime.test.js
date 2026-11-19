const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-rt-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachRealtime } = require('../src/realtime');
const { resetDb } = require('./helpers');
const { pool, query } = require('../src/db');
const { sendPush } = require('../src/push');
const { getOrCreateConversation } = require('../src/conversations');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const FILTER = { minAge: 18, maxAge: 99, genders: [], country: 'BR' };

let server, url, rt, pushSpy, app;
const clock = { t: 1_000_000 };
const sockets = [];

beforeAll(async () => {
  app = createApp();
  server = http.createServer(app);
  pushSpy = jest.fn().mockResolvedValue();
  rt = attachRealtime(server, { pushSender: pushSpy, now: () => clock.t });
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await rt.io.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await pool.end();
});
beforeEach(async () => {
  await resetDb();
  pushSpy.mockClear();
});
afterEach(() => {
  sockets.splice(0).forEach((s) => s.close());
  for (const id of [...rt.matchmaker.queue.keys()]) rt.matchmaker.dequeue(id);
});

async function register(email, nickname, photo = true) {
  const res = await request(app).post('/auth/register').send({
    email, password: 'senha1234', nickname, birthdate: '1990-01-01', gender: 'feminino',
  });
  const h = { Authorization: `Bearer ${res.body.token}` };
  if (photo) {
    await request(app).post('/me/photos').set(h).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' });
  }
  const me = await request(app).get('/me').set(h);
  return { token: res.body.token, id: me.body.id };
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

async function matched() {
  const a = await register('a@b.com', 'ana');
  const b = await register('b@b.com', 'bia');
  const sa = await client(a.token);
  const sb = await client(b.token);
  const fa = once(sa, 'search:found');
  const fb = once(sb, 'search:found');
  sa.emit('search:start', FILTER);
  sb.emit('search:start', FILTER);
  return { a, b, sa, sb, fa: await fa, fb: await fb };
}

test('unauthenticated socket is rejected', async () => {
  await expect(client('lixo')).rejects.toThrow();
});

test('two compatible clients receive search:found of each other', async () => {
  const { a, b, fa, fb } = await matched();
  expect(fa.partner).toMatchObject({ id: b.id, nickname: 'bia', age: expect.any(Number), gender: 'feminino' });
  expect(fa.partner.photos).toHaveLength(1);
  expect(fb.partner.id).toBe(a.id);
});

test('talk by only one user creates the conversation for both', async () => {
  const { b, sa, sb } = await matched();
  const ca = once(sa, 'match:conversation');
  const cb = once(sb, 'match:conversation');
  sa.emit('match:choose', { partnerId: b.id, action: 'talk' });
  const [x, y] = [await ca, await cb];
  expect(x.conversationId).toBeTruthy();
  expect(y.conversationId).toBe(x.conversationId);
});

test('skip records a skip and clears the pair', async () => {
  const { a, b, sa } = await matched();
  sa.emit('match:choose', { partnerId: b.id, action: 'skip' });
  await sleep(300);
  const { rowCount } = await query('SELECT 1 FROM skips WHERE skipper_id=$1 AND skipped_id=$2', [a.id, b.id]);
  expect(rowCount).toBe(1);
  const err = once(sa, 'error');
  sa.emit('match:choose', { partnerId: b.id, action: 'talk' });
  expect((await err).code).toBe('parceiro_invalido');
});

test('skip by one does not prevent the other from talking', async () => {
  const { a, b, sa, sb } = await matched();
  sb.emit('match:choose', { partnerId: a.id, action: 'skip' });
  await sleep(300);
  const ca = once(sa, 'match:conversation');
  const cb = once(sb, 'match:conversation');
  sa.emit('match:choose', { partnerId: b.id, action: 'talk' });
  const [x, y] = [await ca, await cb];
  expect(x.conversationId).toBeTruthy();
  expect(y.conversationId).toBe(x.conversationId);
  const err = once(sa, 'error');
  sa.emit('match:choose', { partnerId: b.id, action: 'talk' });
  expect((await err).code).toBe('parceiro_invalido');
});

test('partner disconnect keeps the remaining user able to talk; search:start clears own pair', async () => {
  const { a, b, sa, sb } = await matched();
  sb.close();
  await sleep(300);
  const ca = once(sa, 'match:conversation');
  sa.emit('match:choose', { partnerId: b.id, action: 'talk' });
  expect((await ca).conversationId).toBeTruthy();

  await resetDb();
  const m = await matched();
  m.sa.emit('search:start', FILTER);
  await sleep(300);
  const err = once(m.sa, 'error');
  m.sa.emit('match:choose', { partnerId: m.b.id, action: 'talk' });
  expect((await err).code).toBe('parceiro_invalido');
  expect(a).toBeTruthy();
});

test('pending messages are marked delivered when the recipient connects', async () => {
  const a = await register('a@b.com', 'ana');
  const b = await register('b@b.com', 'bia');
  const sa = await client(a.token);
  const { id } = await getOrCreateConversation(a.id, b.id);
  const na = once(sa, 'message:new');
  sa.emit('message:send', { conversationId: id, type: 'text', body: 'oi' });
  const { message } = await na;
  const st = once(sa, 'message:status');
  await client(b.token);
  expect(await st).toEqual({ messageId: message.id, status: 'delivered' });
  const { rows } = await query('SELECT delivered_at FROM messages WHERE id=$1', [message.id]);
  expect(rows[0].delivered_at).not.toBeNull();
});

test('invalid conversationId in message:read/send yields forbidden without erro_interno', async () => {
  const a = await register('a@b.com', 'ana');
  const sa = await client(a.token);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    let err = once(sa, 'error');
    sa.emit('message:read', { conversationId: 'xyz' });
    expect(await err).toEqual({ code: 'forbidden', event: 'message:read' });
    err = once(sa, 'error');
    sa.emit('message:send', { conversationId: 'xyz', type: 'text', body: 'oi' });
    expect((await err).code).toBe('forbidden');
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test('choose with wrong partnerId yields parceiro_invalido', async () => {
  const { sa } = await matched();
  const err = once(sa, 'error');
  sa.emit('match:choose', { partnerId: '00000000-0000-4000-8000-000000000000', action: 'talk' });
  expect((await err).code).toBe('parceiro_invalido');
});

test('message:send reaches the other user as message:new and marks delivered/read', async () => {
  const { b, sa, sb } = await matched();
  const ca = once(sa, 'match:conversation');
  sa.emit('match:choose', { partnerId: b.id, action: 'talk' });
  const { conversationId } = await ca;
  const nb = once(sb, 'message:new');
  const na = once(sa, 'message:new');
  const st = once(sa, 'message:status');
  sa.emit('message:send', { conversationId, type: 'text', body: 'oi' });
  expect((await nb).message.body).toBe('oi');
  expect((await na).message.body).toBe('oi');
  expect(await st).toMatchObject({ status: 'delivered' });
  expect(pushSpy).not.toHaveBeenCalled();
  const rd = once(sa, 'message:status');
  sb.emit('message:read', { conversationId });
  expect(await rd).toMatchObject({ status: 'read' });
});

test('offline recipient triggers push once', async () => {
  const a = await register('a@b.com', 'ana');
  const b = await register('b@b.com', 'bia');
  const sa = await client(a.token);
  const { id } = await getOrCreateConversation(a.id, b.id);
  const na = once(sa, 'message:new');
  sa.emit('message:send', { conversationId: id, type: 'text', body: 'oi' });
  await na;
  await sleep(300);
  expect(pushSpy).toHaveBeenCalledTimes(1);
  expect(pushSpy).toHaveBeenCalledWith(b.id, { title: 'ana', body: 'oi', conversationId: id });
});

test('disconnect removes user from queue; second tab disconnect keeps it', async () => {
  const a = await register('a@b.com', 'ana');
  const s1 = await client(a.token);
  const s2 = await client(a.token);
  s1.emit('search:start', FILTER);
  await sleep(300);
  expect(rt.matchmaker.queue.has(a.id)).toBe(true);
  s2.close();
  await sleep(300);
  expect(rt.matchmaker.queue.has(a.id)).toBe(true);
  s1.close();
  await sleep(300);
  expect(rt.matchmaker.queue.has(a.id)).toBe(false);
});

test('profile without photo gets perfil_incompleto', async () => {
  const a = await register('a@b.com', 'ana', false);
  const s = await client(a.token);
  const err = once(s, 'error');
  s.emit('search:start', FILTER);
  expect(await err).toEqual({ code: 'perfil_incompleto', event: 'search:start' });
});

test('invalid filter gets filtro_invalido; timeout emits search:none', async () => {
  const a = await register('a@b.com', 'ana');
  const s = await client(a.token);
  const err = once(s, 'error');
  s.emit('search:start', { minAge: 50, maxAge: 20 });
  expect((await err).code).toBe('filtro_invalido');
  const none = once(s, 'search:none');
  s.emit('search:start', FILTER);
  await sleep(200);
  clock.t += 61000;
  await rt.matchmaker.tick();
  await none;
});

describe('push', () => {
  const payload = { title: 't', body: 'b', conversationId: 'c' };

  test('no-op without token; sends with token; clears unregistered token', async () => {
    const a = await register('a@b.com', 'ana', false);
    const messaging = { send: jest.fn().mockResolvedValue('ok') };
    await sendPush(a.id, payload, { messaging });
    expect(messaging.send).not.toHaveBeenCalled();
    await request(app).put('/me/fcm-token').set({ Authorization: `Bearer ${a.token}` }).send({ token: 'tok' }).expect(204);
    await sendPush(a.id, payload, { messaging });
    expect(messaging.send).toHaveBeenCalledTimes(1);
    messaging.send.mockRejectedValue({ code: 'messaging/registration-token-not-registered' });
    await sendPush(a.id, payload, { messaging });
    const { rows } = await query('SELECT fcm_token FROM users WHERE id=$1', [a.id]);
    expect(rows[0].fcm_token).toBeNull();
  });

  test('fcm-token endpoints validate and delete', async () => {
    const a = await register('a@b.com', 'ana', false);
    const h = { Authorization: `Bearer ${a.token}` };
    await request(app).put('/me/fcm-token').set(h).send({ token: '' }).expect(400);
    await request(app).put('/me/fcm-token').set(h).send({ token: 'x' }).expect(204);
    await request(app).delete('/me/fcm-token').set(h).expect(204);
    const { rows } = await query('SELECT fcm_token FROM users WHERE id=$1', [a.id]);
    expect(rows[0].fcm_token).toBeNull();
  });

  test('registering a token moves it away from any other user', async () => {
    const a = await register('a@b.com', 'ana', false);
    const b = await register('b@b.com', 'bia', false);
    await request(app).put('/me/fcm-token').set({ Authorization: `Bearer ${a.token}` }).send({ token: 'dev1' }).expect(204);
    await request(app).put('/me/fcm-token').set({ Authorization: `Bearer ${b.token}` }).send({ token: 'dev1' }).expect(204);
    const { rows } = await query('SELECT id, fcm_token FROM users ORDER BY email');
    expect(rows).toEqual([{ id: a.id, fcm_token: null }, { id: b.id, fcm_token: 'dev1' }]);
  });
});
