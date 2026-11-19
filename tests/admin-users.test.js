const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-au-'));

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb, registerUser, auth, setStatus, makeAdmin } = require('./helpers');
const { pool } = require('../src/db');
const hub = require('../src/hub');
const { userItem } = require('../src/routes/admin/users');
const { reportItemById } = require('../src/routes/admin/reportItem');

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
async function message(convId, senderId, type, createdAt = new Date()) {
  const { rows } = await pool.query(
    'INSERT INTO messages (conversation_id, sender_id, type, body, media_url, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [convId, senderId, type, type === 'text' ? 'oi' : null, type === 'text' ? null : '/uploads/x', createdAt]
  );
  return rows[0].id;
}
async function report(reporter, reported, reason = 'spam') {
  const { rows } = await pool.query(
    'INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3) RETURNING id',
    [reporter, reported, reason]
  );
  return rows[0].id;
}
const get = (admin, url) => request(app).get(url).set(auth(admin));

describe('GET /admin-api/stats', () => {
  test('stats counts users, new windows, statuses, conversations, messages by type', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    const a = await registerUser(app, 'a@x.com', 'ana');
    const b = await registerUser(app, 'b@x.com', 'bia');
    const c = await registerUser(app, 'c@x.com', 'cris');
    const d = await registerUser(app, 'd@x.com', 'dani');
    const e = await registerUser(app, 'e@x.com', 'eva');
    await pool.query("UPDATE users SET created_at = now() - interval '3 days' WHERE id = $1", [b.id]);
    await pool.query("UPDATE users SET created_at = now() - interval '20 days' WHERE id = $1", [c.id]);
    await pool.query("UPDATE users SET created_at = now() - interval '60 days' WHERE id = $1", [d.id]);
    await setStatus(c.id, { status: 'suspended', until: new Date(Date.now() + 3600e3) });
    await setStatus(d.id, { status: 'banned' });
    await setStatus(e.id, { status: 'suspended', until: new Date(Date.now() - 3600e3) }); // expired -> active
    const conv = await conversation(a.id, b.id);
    const old = new Date(Date.now() - 10 * 86400e3);
    await message(conv, a.id, 'text');
    await message(conv, a.id, 'photo');
    await message(conv, b.id, 'audio', old);
    await message(conv, b.id, 'text', old);
    await message(conv, b.id, 'text', old);
    await report(a.id, b.id);
    const r2 = await report(b.id, a.id);
    await pool.query("UPDATE reports SET status = 'dismissed' WHERE id = $1", [r2]);

    const res = await get(admin, '/admin-api/stats');
    expect(res.status).toBe(200);
    expect(res.body.users).toMatchObject({
      total: 6, new24h: 3, new7d: 4, new30d: 5, online: 0, active: 4, suspended: 1, banned: 1,
    });
    expect(res.body.conversations).toEqual({ total: 1 });
    expect(res.body.messages).toEqual({
      total: 5,
      last7d: 2,
      byType: { text: 3, photo: 1, audio: 1 },
      last7dByType: { text: 1, photo: 1, audio: 0 },
    });
    expect(res.body.reports).toEqual({ open: 1 });
  });

  test('online comes from hub', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    hub.setOnlineCounter(() => 3);
    try {
      const res = await get(admin, '/admin-api/stats');
      expect(res.body.users.online).toBe(3);
    } finally {
      hub.setOnlineCounter(null);
    }
  });
});

describe('GET /admin-api/users', () => {
  test('users list paginates with total', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await registerUser(app, `u${i}@x.com`, `u${i}`)).id);
    for (let i = 0; i < 4; i++) {
      await pool.query("UPDATE users SET created_at = now() - ($2 || ' hours')::interval WHERE id = $1", [ids[i], String(i + 1)]);
    }
    const p1 = await get(admin, '/admin-api/users?page=1&pageSize=2');
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(p1.body.items.map((u) => u.nickname)).toEqual(['root', 'u0']);
    const p3 = await get(admin, '/admin-api/users?page=3&pageSize=2');
    expect(p3.body.items.map((u) => u.nickname)).toEqual(['u3']);
    expect(p1.body.items[1]).toEqual(
      expect.objectContaining({
        id: ids[0], email: 'u0@x.com', nickname: 'u0', gender: 'feminino', country: 'BR',
        status: 'active', suspendedUntil: null, reportsReceived: 0, reportsMade: 0,
      })
    );
    expect(typeof p1.body.items[1].age).toBe('number');
  });

  test('q matches nickname and email case-insensitively', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    await registerUser(app, 'zeca@mail.com', 'Joana');
    await registerUser(app, 'JOAO@mail.com', 'xuxa');
    await registerUser(app, 'other@mail.com', 'pedro');
    const byNick = await get(admin, '/admin-api/users?q=joAN');
    expect(byNick.body.items.map((u) => u.nickname)).toEqual(['Joana']);
    const byMail = await get(admin, '/admin-api/users?q=joao@');
    expect(byMail.body.items.map((u) => u.nickname)).toEqual(['xuxa']);
    const pct = await get(admin, '/admin-api/users?q=%25');
    expect(pct.body.total).toBe(0);
  });

  test('filters by status, country and gender (expired suspension is active)', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    const s = await registerUser(app, 's@x.com', 'susp');
    const x = await registerUser(app, 'x@x.com', 'expired');
    const bn = await registerUser(app, 'bn@x.com', 'banido');
    await setStatus(s.id, { status: 'suspended', until: new Date(Date.now() + 3600e3) });
    await setStatus(x.id, { status: 'suspended', until: new Date(Date.now() - 3600e3) });
    await setStatus(bn.id, { status: 'banned' });
    await pool.query("UPDATE users SET country = 'PT', gender = 'masculino' WHERE id = $1", [bn.id]);

    const susp = await get(admin, '/admin-api/users?status=suspended');
    expect(susp.body.items.map((u) => u.nickname)).toEqual(['susp']);
    expect(susp.body.items[0].suspendedUntil).toEqual(expect.any(String));
    const active = await get(admin, '/admin-api/users?status=active');
    expect(active.body.items.map((u) => u.nickname).sort()).toEqual(['expired', 'root']);
    expect(active.body.items.find((u) => u.nickname === 'expired').suspendedUntil).toBeNull();
    const banned = await get(admin, '/admin-api/users?status=banned');
    expect(banned.body.items.map((u) => u.nickname)).toEqual(['banido']);
    const pt = await get(admin, '/admin-api/users?country=pt');
    expect(pt.body.items.map((u) => u.nickname)).toEqual(['banido']);
    const masc = await get(admin, '/admin-api/users?gender=masculino');
    expect(masc.body.items.map((u) => u.nickname)).toEqual(['banido']);
  });

  test('list includes report counts', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    const a = await registerUser(app, 'a@x.com', 'ana');
    const b = await registerUser(app, 'b@x.com', 'bia');
    await report(a.id, b.id);
    await report(a.id, b.id);
    await report(b.id, a.id);
    const res = await get(admin, '/admin-api/users?q=ana');
    expect(res.body.items[0]).toMatchObject({ reportsReceived: 1, reportsMade: 2 });
    const res2 = await get(admin, '/admin-api/users?q=bia');
    expect(res2.body.items[0]).toMatchObject({ reportsReceived: 2, reportsMade: 1 });
  });
});

describe('GET /admin-api/users/:id', () => {
  test('detail returns photos, reports both ways, actions', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    const a = await registerUser(app, 'a@x.com', 'ana');
    const b = await registerUser(app, 'b@x.com', 'bia');
    await pool.query("INSERT INTO photos (user_id, url, position) VALUES ($1,'/uploads/p2',1),($1,'/uploads/p1',0)", [a.id]);
    await conversation(a.id, b.id);
    const made = await report(a.id, b.id, 'feita');
    const got = await report(b.id, a.id, 'recebida');
    await pool.query(
      "INSERT INTO admin_actions (admin_id, action, target_user_id, report_id, reason, created_at) VALUES ($1,'suspend',$2,$3,'r1', now() - interval '1 hour'), ($1,'reactivate',$2,NULL,'r2', now())",
      [admin.id, a.id, got]
    );
    await setStatus(a.id, { status: 'banned', reason: 'abuso' });

    const res = await get(admin, `/admin-api/users/${a.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: a.id, nickname: 'ana', role: 'user', status: 'banned', statusReason: 'abuso',
      reportsReceived: 1, reportsMade: 1,
    });
    expect(res.body.user.photos.map((p) => p.url)).toEqual(['/uploads/p1', '/uploads/p2']);
    expect(res.body.user.photos[0].id).toEqual(expect.any(String));
    expect(res.body.reportsMade).toHaveLength(1);
    expect(res.body.reportsMade[0]).toMatchObject({
      id: made, status: 'open', reason: 'feita', hasConversation: true,
      reporter: { id: a.id, nickname: 'ana' },
      reported: { id: b.id, nickname: 'bia', status: 'active' },
    });
    expect(res.body.reportsReceived.map((r) => r.id)).toEqual([got]);
    expect(res.body.reportsReceived[0].reported.status).toBe('banned');
    expect(res.body.actions.map((x) => x.action)).toEqual(['reactivate', 'suspend']);
    expect(res.body.actions[1]).toMatchObject({
      reason: 'r1', admin: { id: admin.id, nickname: 'root' }, reportId: got, messageId: null,
    });
  });

  test('detail copes with reports whose other party was deleted', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    const a = await registerUser(app, 'a@x.com', 'ana');
    const b = await registerUser(app, 'b@x.com', 'bia');
    await report(b.id, a.id);
    await pool.query('DELETE FROM users WHERE id = $1', [b.id]);
    const res = await get(admin, `/admin-api/users/${a.id}`);
    expect(res.status).toBe(200);
    expect(res.body.reportsReceived[0]).toMatchObject({ reporter: null, hasConversation: false });
  });

  test('detail of unknown or malformed id is 404', async () => {
    const admin = await makeAdmin(app, 'root@x.com');
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      const res = await get(admin, `/admin-api/users/${id}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'nao_encontrado' });
    }
  });

  test('exported helpers: userItem and reportItemById', async () => {
    const a = await registerUser(app, 'a@x.com', 'ana');
    const b = await registerUser(app, 'b@x.com', 'bia');
    const rid = await report(a.id, b.id);
    expect(await userItem(a.id)).toMatchObject({ id: a.id, nickname: 'ana', reportsMade: 1 });
    expect(await userItem('nope')).toBeNull();
    expect((await reportItemById(rid)).id).toBe(rid);
    expect(await reportItemById('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

test('non-admin gets 403 on all three', async () => {
  const u = await registerUser(app, 'u@x.com', 'ana');
  for (const url of ['/admin-api/stats', '/admin-api/users', `/admin-api/users/${u.id}`]) {
    const res = await get(u, url);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  }
});
