const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-ar-'));

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb, registerUser, auth, makeAdmin } = require('./helpers');
const { pool } = require('../src/db');

let app;
beforeAll(() => {
  delete process.env.ADMIN_ORIGIN;
  process.env.ADMIN_DIST = path.join(os.tmpdir(), 'randomic-no-such-dist');
  app = createApp();
});
beforeEach(resetDb);
afterAll(() => pool.end());

async function conversation(a, b) {
  const { rows } = await pool.query('INSERT INTO conversations (user_a, user_b) VALUES ($1, $2) RETURNING id', [a, b]);
  return rows[0].id;
}
async function message(convId, senderId, body, createdAt = new Date()) {
  const { rows } = await pool.query(
    "INSERT INTO messages (conversation_id, sender_id, type, body, created_at) VALUES ($1,$2,'text',$3,$4) RETURNING id",
    [convId, senderId, body, createdAt]
  );
  return rows[0].id;
}
async function report(reporter, reported, reason = 'spam', createdAt = new Date()) {
  const { rows } = await pool.query(
    'INSERT INTO reports (reporter_id, reported_id, reason, created_at) VALUES ($1,$2,$3,$4) RETURNING id',
    [reporter, reported, reason, createdAt]
  );
  return rows[0].id;
}
const get = (admin, url) => request(app).get(url).set(auth(admin));

async function setup() {
  const admin = await makeAdmin(app, 'root@x.com');
  const a = await registerUser(app, 'a@x.com', 'ana');
  const b = await registerUser(app, 'b@x.com', 'bia');
  return { admin, a, b };
}

describe('GET /admin-api/reports', () => {
  test('list defaults to open and filters by status/all', async () => {
    const { admin, a, b } = await setup();
    const r1 = await report(a.id, b.id);
    const r2 = await report(b.id, a.id);
    const r3 = await report(a.id, b.id);
    await pool.query("UPDATE reports SET status='dismissed' WHERE id=$1", [r2]);
    await pool.query("UPDATE reports SET status='actioned' WHERE id=$1", [r3]);
    const ids = (res) => res.body.items.map((i) => i.id).sort();
    expect(ids(await get(admin, '/admin-api/reports'))).toEqual([r1]);
    expect(ids(await get(admin, '/admin-api/reports?status=dismissed'))).toEqual([r2]);
    expect(ids(await get(admin, '/admin-api/reports?status=actioned'))).toEqual([r3]);
    const all = await get(admin, '/admin-api/reports?status=all');
    expect(all.body.total).toBe(3);
  });

  test('list orders newest first and paginates', async () => {
    const { admin, a, b } = await setup();
    const old = await report(a.id, b.id, 'old', new Date(Date.now() - 3000));
    const mid = await report(a.id, b.id, 'mid', new Date(Date.now() - 2000));
    const neu = await report(a.id, b.id, 'new', new Date(Date.now() - 1000));
    const p1 = await get(admin, '/admin-api/reports?page=1&pageSize=2');
    expect(p1.body.items.map((i) => i.id)).toEqual([neu, mid]);
    expect(p1.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    const p2 = await get(admin, '/admin-api/reports?page=2&pageSize=2');
    expect(p2.body.items.map((i) => i.id)).toEqual([old]);
  });

  test('report item flags hasConversation', async () => {
    const { admin, a, b } = await setup();
    const c = await registerUser(app, 'c@x.com', 'cris');
    await conversation(a.id, b.id);
    const withConv = await report(b.id, a.id);
    const without = await report(a.id, c.id, 'x', new Date(Date.now() - 5000));
    const res = await get(admin, '/admin-api/reports');
    const byId = Object.fromEntries(res.body.items.map((i) => [i.id, i]));
    expect(byId[withConv].hasConversation).toBe(true);
    expect(byId[without].hasConversation).toBe(false);
    expect(byId[withConv].reporter).toEqual({ id: b.id, nickname: 'bia' });
    expect(byId[withConv].reported).toMatchObject({ id: a.id, nickname: 'ana', status: 'active' });
  });
});

describe('GET /admin-api/reports/:id', () => {
  test('report detail returns both profiles with photo urls and conversationId', async () => {
    const { admin, a, b } = await setup();
    await pool.query("INSERT INTO photos (user_id, url, position) VALUES ($1,'/uploads/p1.jpg',0), ($1,'/uploads/p2.jpg',1)", [a.id]);
    const conv = await conversation(a.id, b.id);
    const id = await report(a.id, b.id, 'assedio');
    const res = await get(admin, `/admin-api/reports/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({
      id,
      status: 'open',
      reason: 'assedio',
      hasConversation: true,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(res.body.reporter).toMatchObject({
      id: a.id,
      nickname: 'ana',
      gender: 'feminino',
      status: 'active',
      photos: ['/uploads/p1.jpg', '/uploads/p2.jpg'],
    });
    expect(typeof res.body.reporter.age).toBe('number');
    expect(res.body.reported).toMatchObject({ id: b.id, nickname: 'bia', photos: [] });
    expect(res.body.conversationId).toBe(conv);
  });

  test('report without a conversation: conversationId null and messages []', async () => {
    const { admin, a, b } = await setup();
    const id = await report(a.id, b.id);
    const res = await get(admin, `/admin-api/reports/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBeNull();
    const msgs = await get(admin, `/admin-api/reports/${id}/messages`);
    expect(msgs.status).toBe(200);
    expect(msgs.body).toEqual([]);
  });

  test('report whose reporter account was deleted shows reporter null and still loads', async () => {
    const { admin, a, b } = await setup();
    const id = await report(a.id, b.id);
    await pool.query('DELETE FROM users WHERE id = $1', [a.id]);
    const res = await get(admin, `/admin-api/reports/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.reporter).toBeNull();
    expect(res.body.report.reporter).toBeNull();
    expect(res.body.reported.id).toBe(b.id);
    expect(res.body.conversationId).toBeNull();
    const list = await get(admin, '/admin-api/reports');
    expect(list.body.items[0].reporter).toBeNull();
    const msgs = await get(admin, `/admin-api/reports/${id}/messages`);
    expect(msgs.body).toEqual([]);
  });

  test('unknown or malformed id is 404 nao_encontrado', async () => {
    const { admin } = await setup();
    for (const id of ['00000000-0000-4000-8000-000000000000', 'xyz']) {
      for (const suffix of ['', '/messages']) {
        const res = await get(admin, `/admin-api/reports/${id}${suffix}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'nao_encontrado' });
      }
    }
  });

  test('non-admin 403', async () => {
    const { a, b } = await setup();
    const id = await report(a.id, b.id);
    for (const url of ['/admin-api/reports', `/admin-api/reports/${id}`, `/admin-api/reports/${id}/messages`]) {
      const res = await get(a, url);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    }
  });
});

describe('GET /admin-api/reports/:id/messages', () => {
  test('messages include ones a participant cleared or hid', async () => {
    const { admin, a, b } = await setup();
    const conv = await conversation(a.id, b.id);
    await message(conv, a.id, 'um', new Date(Date.now() - 3000));
    await message(conv, b.id, 'dois', new Date(Date.now() - 2000));
    await pool.query(
      'INSERT INTO conversation_state (conversation_id, user_id, hidden_at, cleared_before) VALUES ($1,$2,now(),now())',
      [conv, a.id]
    );
    const id = await report(b.id, a.id);
    const res = await get(admin, `/admin-api/reports/${id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.map((m) => m.body)).toEqual(['um', 'dois']);
    expect(res.body[0]).toEqual({
      id: expect.any(String),
      senderId: a.id,
      type: 'text',
      body: 'um',
      mediaUrl: null,
      mediaRemoved: false,
      createdAt: expect.any(String),
    });
  });

  test('messages paginate with before/limit ascending', async () => {
    const { admin, a, b } = await setup();
    const conv = await conversation(a.id, b.id);
    const base = Date.now() - 10000;
    for (let i = 0; i < 5; i++) await message(conv, a.id, `m${i}`, new Date(base + i * 1000));
    const id = await report(b.id, a.id);
    const last = await get(admin, `/admin-api/reports/${id}/messages?limit=2`);
    expect(last.body.map((m) => m.body)).toEqual(['m3', 'm4']);
    const before = last.body[0].createdAt;
    const prev = await get(admin, `/admin-api/reports/${id}/messages?limit=2&before=${encodeURIComponent(before)}`);
    expect(prev.body.map((m) => m.body)).toEqual(['m1', 'm2']);
    const bad = await get(admin, `/admin-api/reports/${id}/messages?before=nope`);
    expect(bad.status).toBe(400);
  });

  test('removed media shows mediaRemoved true and mediaUrl null', async () => {
    const { admin, a, b } = await setup();
    const conv = await conversation(a.id, b.id);
    await pool.query(
      "INSERT INTO messages (conversation_id, sender_id, type, media_url, media_removed_at) VALUES ($1,$2,'photo','/uploads/x.jpg', now())",
      [conv, a.id]
    );
    const id = await report(b.id, a.id);
    const res = await get(admin, `/admin-api/reports/${id}/messages`);
    expect(res.body[0]).toMatchObject({ type: 'photo', mediaUrl: null, mediaRemoved: true });
  });
});

describe('app message payload', () => {
  test('message payload has mediaRemoved false by default', async () => {
    const { a, b } = await setup();
    const conv = await conversation(a.id, b.id);
    await message(conv, a.id, 'oi');
    const res = await request(app).get(`/conversations/${conv}/messages`).set(auth(b));
    expect(res.status).toBe(200);
    expect(res.body[0].mediaRemoved).toBe(false);
  });

  test('app REST hides mediaUrl when media was removed', async () => {
    const { a, b } = await setup();
    const conv = await conversation(a.id, b.id);
    await pool.query(
      "INSERT INTO messages (conversation_id, sender_id, type, media_url, media_removed_at) VALUES ($1,$2,'photo','/uploads/x.jpg', now())",
      [conv, a.id]
    );
    const res = await request(app).get(`/conversations/${conv}/messages`).set(auth(b));
    expect(res.body[0]).toMatchObject({ mediaRemoved: true, mediaUrl: null });
  });
});
