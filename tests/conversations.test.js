const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-up-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb } = require('./helpers');
const { pool, query } = require('../src/db');
const conv = require('../src/conversations');

const app = createApp();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function register(email, nickname = 'ana') {
  const res = await request(app).post('/auth/register').send({
    email, password: 'senha1234', nickname, birthdate: '1990-01-01', gender: 'feminino',
  });
  const me = await request(app).get('/me').set({ Authorization: `Bearer ${res.body.token}` });
  return { token: res.body.token, id: me.body.id };
}
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (body) => ({ type: 'text', body });

let a;
let b;
let c;
beforeEach(async () => {
  await resetDb();
  a = await register('a@b.com', 'ana');
  b = await register('b@b.com', 'bia');
  c = await register('c@b.com', 'cris');
});
afterAll(async () => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await pool.end();
});

describe('getOrCreateConversation', () => {
  test('concurrent calls in both orders produce exactly one row', async () => {
    const rs = await Promise.all([
      conv.getOrCreateConversation(a.id, b.id),
      conv.getOrCreateConversation(b.id, a.id),
      conv.getOrCreateConversation(a.id, b.id),
      conv.getOrCreateConversation(b.id, a.id),
    ]);
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await query('SELECT count(*)::int AS n FROM conversations');
    expect(rows[0].n).toBe(1);
  });

  test('is idempotent: second call returns created=false', async () => {
    const first = await conv.getOrCreateConversation(a.id, b.id);
    const second = await conv.getOrCreateConversation(b.id, a.id);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
  });

  test('rejects blocked pair, same user and missing user', async () => {
    await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a.id, b.id]);
    await expect(conv.getOrCreateConversation(a.id, b.id)).rejects.toThrow('bloqueado');
    await expect(conv.getOrCreateConversation(b.id, a.id)).rejects.toThrow('bloqueado');
    await expect(conv.getOrCreateConversation(a.id, a.id)).rejects.toThrow();
    await expect(
      conv.getOrCreateConversation(a.id, '00000000-0000-4000-8000-000000000000')
    ).rejects.toThrow();
  });
});

describe('sendMessage', () => {
  test('blocked pair cannot message; non-participant is forbidden; validation', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await expect(conv.sendMessage(id, c.id, text('oi'))).rejects.toThrow('forbidden');
    await expect(conv.sendMessage(id, a.id, text('   '))).rejects.toThrow();
    await expect(conv.sendMessage(id, a.id, text('x'.repeat(4001)))).rejects.toThrow();
    await expect(conv.sendMessage(id, a.id, { type: 'audio', mediaUrl: 'http://x/y.mp3' })).rejects.toThrow();
    for (const bad of ['/uploads/../etc/passwd', '/uploads/a/b.jpg', '/uploads/', '/uploads/x.jpg?y', '/uploads/..']) {
      await expect(conv.sendMessage(id, a.id, { type: 'photo', mediaUrl: bad })).rejects.toThrow();
    }
    const ok = await conv.sendMessage(id, a.id, { type: 'audio', mediaUrl: '/uploads/x.mp3' });
    expect(ok).toMatchObject({ type: 'audio', mediaUrl: '/uploads/x.mp3', senderId: a.id });
    await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    await expect(conv.sendMessage(id, a.id, text('oi'))).rejects.toThrow('bloqueado');
    await expect(conv.sendMessage(id, b.id, text('oi'))).rejects.toThrow('bloqueado');
  });
});

describe('hide / reappear', () => {
  test('deleting hides only for the one who deleted', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await conv.sendMessage(id, a.id, text('oi'));
    await conv.hideConversation(id, a.id);
    expect(await conv.listConversations(a.id)).toHaveLength(0);
    const forB = await conv.listConversations(b.id);
    expect(forB).toHaveLength(1);
    expect(forB[0].lastMessage.body).toBe('oi');
    expect(await conv.listMessages(id, b.id)).toHaveLength(1);
    expect(await conv.listMessages(id, a.id)).toHaveLength(0);
  });

  test('new message from the other reappears it with only later messages', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await conv.sendMessage(id, b.id, text('antiga'));
    await sleep(5);
    await conv.hideConversation(id, a.id);
    await sleep(5);
    // sender's own message does not unhide for the sender
    expect(await conv.listConversations(a.id)).toHaveLength(0);
    await conv.sendMessage(id, b.id, text('nova'));
    const list = await conv.listConversations(a.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, unreadCount: 1 });
    expect(list[0].lastMessage.body).toBe('nova');
    expect(list[0].partner).toMatchObject({ id: b.id, nickname: 'bia' });
    const msgs = await conv.listMessages(id, a.id);
    expect(msgs.map((m) => m.body)).toEqual(['nova']);
    expect((await conv.listMessages(id, b.id)).map((m) => m.body)).toEqual(['antiga', 'nova']);
  });

  test('own message does not unhide the sender conversation', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await conv.hideConversation(id, a.id);
    await conv.sendMessage(id, a.id, text('oi'));
    expect(await conv.listConversations(a.id)).toHaveLength(0);
    expect(await conv.listConversations(b.id)).toHaveLength(1);
  });
});

describe('block visibility', () => {
  test('block removes from both lists; unblock restores with history', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await conv.sendMessage(id, a.id, text('oi'));
    await conv.sendMessage(id, b.id, text('olá'));
    expect(await conv.listConversations(a.id)).toHaveLength(1);
    expect((await request(app).post(`/users/${b.id}/block`).set(auth(a))).status).toBe(204);
    expect(await conv.listConversations(a.id)).toHaveLength(0);
    expect(await conv.listConversations(b.id)).toHaveLength(0);
    expect((await request(app).delete(`/users/${b.id}/block`).set(auth(a))).status).toBe(204);
    const list = await conv.listConversations(a.id);
    expect(list).toHaveLength(1);
    expect(list[0].unreadCount).toBe(1);
    expect((await conv.listMessages(id, a.id)).map((m) => m.body)).toEqual(['oi', 'olá']);
  });

  test('blocked pair cannot list messages (either side), REST 403 bloqueado', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await conv.sendMessage(id, a.id, text('oi'));
    await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a.id, b.id]);
    await expect(conv.listMessages(id, a.id)).rejects.toThrow('bloqueado');
    await expect(conv.listMessages(id, b.id)).rejects.toThrow('bloqueado');
    const res = await request(app).get(`/conversations/${id}/messages`).set(auth(b));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'bloqueado' });
  });

  test('blocked pair cannot upload media: 403 bloqueado', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [b.id, a.id]);
    for (const u of [a, b]) {
      const res = await request(app).post(`/conversations/${id}/media`).set(auth(u)).attach('file', PNG, 'x.png');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'bloqueado' });
    }
  });
});

describe('receipts and listing', () => {
  test('markDelivered and markRead fill timestamps; only the other side messages', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    const m1 = await conv.sendMessage(id, a.id, text('1'));
    const m2 = await conv.sendMessage(id, a.id, text('2'));
    const mine = await conv.sendMessage(id, b.id, text('3'));
    await conv.markDelivered(m1.id);
    const d1 = (await conv.listMessages(id, a.id)).find((m) => m.id === m1.id).deliveredAt;
    expect(d1).not.toBeNull();
    await conv.markDelivered(m1.id);
    expect((await conv.listMessages(id, a.id)).find((m) => m.id === m1.id).deliveredAt).toEqual(d1);
    expect((await conv.listConversations(b.id))[0].unreadCount).toBe(2);
    const ids = await conv.markRead(id, b.id);
    expect(ids.sort()).toEqual([m1.id, m2.id].sort());
    const all = await conv.listMessages(id, a.id);
    for (const m of all.filter((x) => x.senderId === a.id)) {
      expect(m.readAt).not.toBeNull();
      expect(m.deliveredAt).not.toBeNull();
    }
    expect(all.find((m) => m.id === mine.id).readAt).toBeNull();
    expect(await conv.markRead(id, b.id)).toEqual([]);
    expect((await conv.listConversations(b.id))[0].unreadCount).toBe(0);
  });

  test('conversations ordered by last activity; empty conversation uses created_at', async () => {
    const ab = await conv.getOrCreateConversation(a.id, b.id);
    await sleep(5);
    const ac = await conv.getOrCreateConversation(c.id, a.id);
    expect((await conv.listConversations(a.id)).map((x) => x.id)).toEqual([ac.id, ab.id]);
    await sleep(5);
    await conv.sendMessage(ab.id, b.id, text('oi'));
    const list = await conv.listConversations(a.id);
    expect(list.map((x) => x.id)).toEqual([ab.id, ac.id]);
    expect(list[1].lastMessage).toBeNull();
  });

  test('listMessages paginates with before and limit, oldest to newest', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    for (let i = 1; i <= 5; i++) {
      await conv.sendMessage(id, a.id, text(String(i)));
      await sleep(3);
    }
    const page1 = await conv.listMessages(id, b.id, undefined, 2);
    expect(page1.map((m) => m.body)).toEqual(['4', '5']);
    const page2 = await conv.listMessages(id, b.id, page1[0].createdAt.toISOString(), 2);
    expect(page2.map((m) => m.body)).toEqual(['2', '3']);
    expect(await conv.listMessages(id, b.id, undefined, 1000)).toHaveLength(5);
    await expect(conv.listMessages(id, c.id)).rejects.toThrow('forbidden');
  });
});

describe('REST', () => {
  test('requires auth', async () => {
    expect((await request(app).get('/conversations')).status).toBe(401);
  });

  test('list, messages and delete over HTTP', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    await conv.sendMessage(id, b.id, text('oi'));
    const list = await request(app).get('/conversations').set(auth(a));
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ id, unreadCount: 1, partner: { id: b.id } });
    const msgs = await request(app).get(`/conversations/${id}/messages?limit=10`).set(auth(a));
    expect(msgs.status).toBe(200);
    expect(msgs.body[0].body).toBe('oi');
    expect((await request(app).get(`/conversations/${id}/messages`).set(auth(c))).status).toBe(403);
    expect((await request(app).get('/conversations/xyz/messages').set(auth(a))).status).toBe(404);
    expect((await request(app).delete(`/conversations/${id}`).set(auth(c))).status).toBe(403);
    expect((await request(app).delete(`/conversations/${id}`).set(auth(a))).status).toBe(204);
    expect((await request(app).get('/conversations').set(auth(a))).body).toEqual([]);
    expect((await request(app).get('/conversations').set(auth(b))).body).toHaveLength(1);
  });

  test('media upload: photo and audio accepted', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    const p = await request(app).post(`/conversations/${id}/media`).set(auth(a)).attach('file', PNG, 'x.png');
    expect(p.status).toBe(201);
    expect(p.body.url).toMatch(/^\/uploads\/.+\.png$/);
    const au = await request(app)
      .post(`/conversations/${id}/media`)
      .set(auth(b))
      .attach('file', Buffer.from('abc'), { filename: 'v.m4a', contentType: 'audio/mp4' });
    expect(au.status).toBe(201);
    expect(au.body.url).toMatch(/\.m4a$/);
  });

  test('audio larger than 10 MB returns 413', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    const res = await request(app)
      .post(`/conversations/${id}/media`)
      .set(auth(a))
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'v.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(413);
  });

  test('photo larger than 5 MB returns 413', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    const res = await request(app)
      .post(`/conversations/${id}/media`)
      .set(auth(a))
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
  });

  test('.gif as photo returns 400', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    const res = await request(app)
      .post(`/conversations/${id}/media`)
      .set(auth(a))
      .attach('file', Buffer.from('GIF89a'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
    const mismatch = await request(app)
      .post(`/conversations/${id}/media`)
      .set(auth(a))
      .attach('file', PNG, { filename: 'x.gif', contentType: 'image/png' });
    expect(mismatch.status).toBe(400);
  });

  test('media: non-participant 403, non-UUID 404, missing file 400', async () => {
    const { id } = await conv.getOrCreateConversation(a.id, b.id);
    expect(
      (await request(app).post(`/conversations/${id}/media`).set(auth(c)).attach('file', PNG, 'x.png')).status
    ).toBe(403);
    expect(
      (await request(app).post('/conversations/nope/media').set(auth(a)).attach('file', PNG, 'x.png')).status
    ).toBe(404);
    expect((await request(app).post(`/conversations/${id}/media`).set(auth(a))).status).toBe(400);
  });
});
