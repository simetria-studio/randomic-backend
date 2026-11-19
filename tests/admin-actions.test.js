const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-aa-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb, registerUser, auth, makeAdmin } = require('./helpers');
const { pool } = require('../src/db');
const hub = require('../src/hub');

let app;
beforeAll(() => {
  delete process.env.ADMIN_ORIGIN;
  process.env.ADMIN_DIST = path.join(os.tmpdir(), 'randomic-no-such-dist');
  app = createApp();
});
beforeEach(resetDb);
afterAll(() => pool.end());

const post = (u, url, body) => request(app).post(url).set(auth(u)).send(body);
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();

async function setup() {
  const admin = await makeAdmin(app, 'root@x.com');
  const a = await registerUser(app, 'a@x.com', 'ana');
  const b = await registerUser(app, 'b@x.com', 'bia');
  return { admin, a, b };
}
async function report(reporter, reported) {
  const { rows } = await pool.query(
    'INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3) RETURNING id',
    [reporter, reported, 'spam']
  );
  return rows[0].id;
}
async function photoMessage(a, b, fileName = 'pic.jpg', create = true) {
  const { rows: c } = await pool.query('INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) RETURNING id', [a, b]);
  if (create) fs.writeFileSync(path.join(uploadDir, fileName), 'x');
  const { rows } = await pool.query(
    "INSERT INTO messages (conversation_id, sender_id, type, media_url) VALUES ($1,$2,'photo',$3) RETURNING id",
    [c[0].id, a, `/uploads/${fileName}`]
  );
  return { convId: c[0].id, id: rows[0].id };
}
const actions = async () => (await pool.query('SELECT * FROM admin_actions ORDER BY created_at')).rows;

describe('common validation', () => {
  test.each([
    ['suspend', () => ({ until: future() })],
    ['ban', () => ({})],
    ['reactivate', () => ({})],
  ])('%s requires reason (empty/501 chars -> motivo_invalido)', async (act, extra) => {
    const { admin, a } = await setup();
    for (const reason of [undefined, '', '   ', 'x'.repeat(501), 5]) {
      const res = await post(admin, `/admin-api/users/${a.id}/${act}`, { ...extra(), reason });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('motivo_invalido');
    }
    expect(await actions()).toHaveLength(0);
  });

  test('dismiss and remove-media require reason', async () => {
    const { admin, a, b } = await setup();
    const r = await report(a.id, b.id);
    const m = await photoMessage(a.id, b.id);
    expect((await post(admin, `/admin-api/reports/${r}/dismiss`, { reason: '' })).body.error).toBe('motivo_invalido');
    expect((await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'x'.repeat(501) })).body.error).toBe('motivo_invalido');
  });

  test('suspend rejects missing/invalid/past until (data_invalida)', async () => {
    const { admin, a } = await setup();
    for (const until of [undefined, 'nope', past(), new Date().toISOString(), 123]) {
      const res = await post(admin, `/admin-api/users/${a.id}/suspend`, { reason: 'r', until });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('data_invalida');
    }
    const row = (await pool.query('SELECT status FROM users WHERE id=$1', [a.id])).rows[0];
    expect(row.status).toBe('active');
  });

  test('cannot target self or another admin (alvo_invalido)', async () => {
    const { admin } = await setup();
    const other = await makeAdmin(app, 'other@x.com', 'other');
    for (const target of [admin, other]) {
      for (const [act, body] of [
        ['suspend', { reason: 'r', until: future() }],
        ['ban', { reason: 'r' }],
        ['reactivate', { reason: 'r' }],
      ]) {
        const res = await post(admin, `/admin-api/users/${target.id}/${act}`, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('alvo_invalido');
      }
    }
    expect(await actions()).toHaveLength(0);
  });

  test('unknown/malformed user, report, message -> 404', async () => {
    const { admin, a } = await setup();
    const ghost = '00000000-0000-4000-8000-000000000000';
    for (const id of [ghost, 'nope']) {
      expect((await post(admin, `/admin-api/users/${id}/ban`, { reason: 'r' })).status).toBe(404);
      expect((await post(admin, `/admin-api/reports/${id}/dismiss`, { reason: 'r' })).status).toBe(404);
      expect((await post(admin, `/admin-api/messages/${id}/remove-media`, { reason: 'r' })).status).toBe(404);
      const res = await post(admin, `/admin-api/users/${a.id}/ban`, { reason: 'r', reportId: id });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('nao_encontrado');
    }
    expect((await pool.query('SELECT status FROM users WHERE id=$1', [a.id])).rows[0].status).toBe('active');
  });

  test('non-admin 403', async () => {
    const { a, b } = await setup();
    const res = await post(a, `/admin-api/users/${b.id}/ban`, { reason: 'r' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('suspend / ban / reactivate', () => {
  test('suspend writes admin_actions row with reason and links, returns user item', async () => {
    const { admin, a, b } = await setup();
    const r = await report(a.id, b.id);
    const until = future();
    const res = await post(admin, `/admin-api/users/${b.id}/suspend`, { reason: '  abuso  ', until, reportId: r });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: b.id, status: 'suspended', suspendedUntil: until });
    const [row] = await actions();
    expect(row).toMatchObject({ admin_id: admin.id, action: 'suspend', target_user_id: b.id, report_id: r, reason: 'abuso', target_message_id: null });
    const u = (await pool.query('SELECT status_reason, token_version FROM users WHERE id=$1', [b.id])).rows[0];
    expect(u).toMatchObject({ status_reason: 'abuso', token_version: 1 });
  });

  test('suspend makes old token fail with 403 conta_suspensa; reactivate: old 401, new login 200', async () => {
    const { admin, b } = await setup();
    await post(admin, `/admin-api/users/${b.id}/suspend`, { reason: 'r', until: future() });
    const blocked = await request(app).get('/me').set(auth(b));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('conta_suspensa');
    const res = await post(admin, `/admin-api/users/${b.id}/reactivate`, { reason: 'ok' });
    expect(res.body.status).toBe('active');
    expect((await request(app).get('/me').set(auth(b))).status).toBe(401);
    const login = await request(app).post('/auth/login').send({ email: 'b@x.com', password: 'senha1234' });
    expect(login.status).toBe(200);
    expect((await request(app).get('/me').set({ Authorization: `Bearer ${login.body.token}` })).status).toBe(200);
    const u = (await pool.query('SELECT token_version, status_reason, suspended_until FROM users WHERE id=$1', [b.id])).rows[0];
    expect(u).toMatchObject({ token_version: 2, status_reason: null, suspended_until: null });
  });

  test('ban + reactivate round trip', async () => {
    const { admin, b } = await setup();
    const ban = await post(admin, `/admin-api/users/${b.id}/ban`, { reason: 'grave' });
    expect(ban.body).toMatchObject({ status: 'banned', suspendedUntil: null });
    const login = await request(app).post('/auth/login').send({ email: 'b@x.com', password: 'senha1234' });
    expect(login.status).toBe(403);
    expect(login.body.error).toBe('conta_banida');
    await post(admin, `/admin-api/users/${b.id}/reactivate`, { reason: 'erro' });
    expect((await request(app).post('/auth/login').send({ email: 'b@x.com', password: 'senha1234' })).status).toBe(200);
    expect((await actions()).map((x) => x.action)).toEqual(['ban', 'reactivate']);
  });

  test('suspend and ban emit hub restriction', async () => {
    const { admin, a, b } = await setup();
    const seen = [];
    const off = hub.onRestricted((id) => seen.push(id));
    await post(admin, `/admin-api/users/${b.id}/suspend`, { reason: 'r', until: future() });
    await post(admin, `/admin-api/users/${a.id}/ban`, { reason: 'r' });
    off();
    expect(seen).toEqual([b.id, a.id]);
  });

  test('with reportId the report becomes actioned; other open reports stay open', async () => {
    const { admin, a, b } = await setup();
    const r1 = await report(a.id, b.id);
    const r2 = await report(a.id, b.id);
    await post(admin, `/admin-api/users/${b.id}/ban`, { reason: 'r', reportId: r1 });
    const rows = (await pool.query('SELECT id, status, resolved_by, resolved_at FROM reports')).rows;
    const x1 = rows.find((r) => r.id === r1);
    const x2 = rows.find((r) => r.id === r2);
    expect(x1.status).toBe('actioned');
    expect(x1.resolved_by).toBe(admin.id);
    expect(x1.resolved_at).not.toBeNull();
    expect(x2).toMatchObject({ status: 'open', resolved_by: null });
  });

  test('without reportId only the log is written', async () => {
    const { admin, a, b } = await setup();
    const r = await report(a.id, b.id);
    await post(admin, `/admin-api/users/${b.id}/ban`, { reason: 'r' });
    expect((await pool.query('SELECT status FROM reports WHERE id=$1', [r])).rows[0].status).toBe('open');
    const [row] = await actions();
    expect(row.report_id).toBeNull();
  });
});

describe('remove-media shared files', () => {
  test('file used by a profile photo is kept, message still marked removed', async () => {
    const { admin, a, b } = await setup();
    const m = await photoMessage(a.id, b.id, 'shared.jpg');
    await pool.query("INSERT INTO photos (user_id, url, position) VALUES ($1,'/uploads/shared.jpg',0)", [b.id]);
    const res = await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'r' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(uploadDir, 'shared.jpg'))).toBe(true);
    const row = (await pool.query('SELECT media_url, media_removed_at FROM messages WHERE id=$1', [m.id])).rows[0];
    expect(row.media_url).toBeNull();
    expect(row.media_removed_at).not.toBeNull();
  });

  test('file used by another message is kept; deleted once nothing references it', async () => {
    const { admin, a, b } = await setup();
    const m1 = await photoMessage(a.id, b.id, 'two.jpg');
    const c = await registerUser(app, 'c@x.com', 'cris');
    const m2 = await photoMessage(c.id, a.id, 'two.jpg', false);
    await post(admin, `/admin-api/messages/${m1.id}/remove-media`, { reason: 'r' });
    expect(fs.existsSync(path.join(uploadDir, 'two.jpg'))).toBe(true);
    await post(admin, `/admin-api/messages/${m2.id}/remove-media`, { reason: 'r' });
    expect(fs.existsSync(path.join(uploadDir, 'two.jpg'))).toBe(false);
  });
});

describe('remove-media', () => {
  test('nulls media_url, both sides see mediaRemoved, deletes file, logs', async () => {
    const { admin, a, b } = await setup();
    const m = await photoMessage(a.id, b.id);
    const r = await report(b.id, a.id);
    const res = await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'nudez', reportId: r });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: m.id, mediaRemoved: true });
    expect(fs.existsSync(path.join(uploadDir, 'pic.jpg'))).toBe(false);
    const row = (await pool.query('SELECT media_url, media_removed_at FROM messages WHERE id=$1', [m.id])).rows[0];
    expect(row.media_url).toBeNull();
    expect(row.media_removed_at).not.toBeNull();
    for (const u of [a, b]) {
      const list = await request(app).get(`/conversations/${m.convId}/messages`).set(auth(u));
      expect(list.status).toBe(200);
      expect(list.body.find((x) => x.id === m.id)).toMatchObject({ mediaUrl: null, mediaRemoved: true });
    }
    const [act] = await actions();
    expect(act).toMatchObject({ action: 'remove_media', target_message_id: m.id, report_id: r, reason: 'nudez', admin_id: admin.id });
    expect((await pool.query('SELECT status FROM reports WHERE id=$1', [r])).rows[0].status).toBe('actioned');
  });

  test('succeeds when the file is already gone', async () => {
    const { admin, a, b } = await setup();
    const m = await photoMessage(a.id, b.id, 'gone.jpg', false);
    const res = await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'r' });
    expect(res.status).toBe(200);
    expect((await pool.query('SELECT media_url FROM messages WHERE id=$1', [m.id])).rows[0].media_url).toBeNull();
  });

  test('second remove-media -> 409 sem_midia', async () => {
    const { admin, a, b } = await setup();
    const m = await photoMessage(a.id, b.id);
    await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'r' });
    const res = await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'r' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sem_midia');
    expect(await actions()).toHaveLength(1);
  });

  test('text message -> 409 sem_midia', async () => {
    const { admin, a, b } = await setup();
    const { rows: c } = await pool.query('INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) RETURNING id', [a.id, b.id]);
    const { rows } = await pool.query(
      "INSERT INTO messages (conversation_id, sender_id, type, body) VALUES ($1,$2,'text','oi') RETURNING id",
      [c[0].id, a.id]
    );
    const res = await post(admin, `/admin-api/messages/${rows[0].id}/remove-media`, { reason: 'r' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sem_midia');
  });
});

describe('report validation', () => {
  test('dismiss only works on open reports (409 denuncia_ja_resolvida)', async () => {
    const { admin, a, b } = await setup();
    const r = await report(a.id, b.id);
    expect((await post(admin, `/admin-api/reports/${r}/dismiss`, { reason: 'x' })).status).toBe(200);
    const again = await post(admin, `/admin-api/reports/${r}/dismiss`, { reason: 'y' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('denuncia_ja_resolvida');
    expect(await actions()).toHaveLength(1);
  });

  test('reportId must involve the target user (400 denuncia_invalida)', async () => {
    const { admin, a, b } = await setup();
    const c = await registerUser(app, 'c@x.com', 'cris');
    const d = await registerUser(app, 'd@x.com', 'dani');
    const r = await report(c.id, d.id);
    for (const [url, body] of [
      [`/admin-api/users/${a.id}/ban`, {}],
      [`/admin-api/users/${a.id}/suspend`, { until: future() }],
      [`/admin-api/users/${a.id}/reactivate`, {}],
    ]) {
      const res = await post(admin, url, { reason: 'r', reportId: r, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('denuncia_invalida');
    }
    const m = await photoMessage(a.id, b.id);
    const res = await post(admin, `/admin-api/messages/${m.id}/remove-media`, { reason: 'r', reportId: r });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('denuncia_invalida');
    expect((await pool.query('SELECT status FROM users WHERE id=$1', [a.id])).rows[0].status).toBe('active');
    expect((await pool.query('SELECT status FROM reports WHERE id=$1', [r])).rows[0].status).toBe('open');
    expect(await actions()).toHaveLength(0);
  });
});

describe('dismiss', () => {
  test('sets dismissed with resolver and logs dismiss_report', async () => {
    const { admin, a, b } = await setup();
    const r = await report(a.id, b.id);
    const res = await post(admin, `/admin-api/reports/${r}/dismiss`, { reason: 'infundada' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: r, status: 'dismissed' });
    const row = (await pool.query('SELECT status, resolved_by, resolved_at FROM reports WHERE id=$1', [r])).rows[0];
    expect(row.status).toBe('dismissed');
    expect(row.resolved_by).toBe(admin.id);
    expect(row.resolved_at).not.toBeNull();
    const [act] = await actions();
    expect(act).toMatchObject({ action: 'dismiss_report', report_id: r, reason: 'infundada', admin_id: admin.id, target_user_id: b.id });
  });

  test('dismissing an actioned report is refused', async () => {
    const { admin, a, b } = await setup();
    const r = await report(a.id, b.id);
    await post(admin, `/admin-api/users/${b.id}/ban`, { reason: 'r', reportId: r });
    const res = await post(admin, `/admin-api/reports/${r}/dismiss`, { reason: 'mudei de ideia' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('denuncia_ja_resolvida');
    expect((await pool.query('SELECT status FROM reports WHERE id=$1', [r])).rows[0].status).toBe('actioned');
    expect(await actions()).toHaveLength(1);
  });
});
