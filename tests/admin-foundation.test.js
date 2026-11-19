const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-af-'));

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb, registerUser, auth, setRole, setStatus, makeAdmin } = require('./helpers');
const { pool } = require('../src/db');
const { parsePaging, pageResult } = require('../src/routes/admin/paging');
const { setRole: setRoleByEmail, listAdmins } = require('../scripts/make-admin');

let app;
beforeAll(() => {
  delete process.env.ADMIN_ORIGIN;
  process.env.ADMIN_DIST = path.join(os.tmpdir(), 'randomic-no-such-dist');
  app = createApp();
});
beforeEach(resetDb);
afterAll(() => pool.end());

describe('GET /admin-api/me', () => {
  test('401 without token', async () => {
    const res = await request(app).get('/admin-api/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('nao_autenticado');
  });

  test('403 forbidden for regular user', async () => {
    const u = await registerUser(app, 'u@x.com');
    const res = await request(app).get('/admin-api/me').set(auth(u));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  test('200 for admin', async () => {
    const a = await makeAdmin(app, 'a@x.com', 'root');
    const res = await request(app).get('/admin-api/me').set(auth(a));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: a.id, nickname: 'root', email: 'a@x.com' });
  });

  test('demoted admin loses access immediately', async () => {
    const a = await makeAdmin(app, 'a@x.com');
    expect((await request(app).get('/admin-api/me').set(auth(a))).status).toBe(200);
    await setRole(a.id, 'user');
    expect((await request(app).get('/admin-api/me').set(auth(a))).status).toBe(403);
  });

  test('admin token of a banned admin gets 403 conta_banida', async () => {
    const a = await makeAdmin(app, 'a@x.com');
    await setStatus(a.id, { status: 'banned', reason: 'x' });
    const res = await request(app).get('/admin-api/me').set(auth(a));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('conta_banida');
  });
});

describe('paging', () => {
  test('defaults', () => {
    expect(parsePaging({})).toEqual({ page: 1, pageSize: 20, offset: 0 });
  });
  test('clamps pageSize to 100 and min 1', () => {
    expect(parsePaging({ pageSize: '500' }).pageSize).toBe(100);
    expect(parsePaging({ pageSize: '0' }).pageSize).toBe(1);
    expect(parsePaging({ pageSize: 'abc' }).pageSize).toBe(20);
  });
  test('invalid page becomes 1; offset computed', () => {
    expect(parsePaging({ page: '-3' }).page).toBe(1);
    expect(parsePaging({ page: 'x' }).page).toBe(1);
    expect(parsePaging({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10, offset: 20 });
  });
  test('pageResult', () => {
    expect(pageResult([1], 5, { page: 2, pageSize: 1, offset: 1 })).toEqual({
      items: [1], total: 5, page: 2, pageSize: 1,
    });
  });
});

describe('make-admin functions', () => {
  test('setRole promotes, demotes, returns false for unknown email, is case-insensitive', async () => {
    const u = await registerUser(app, 'bob@x.com', 'bob');
    expect(await setRoleByEmail(pool, 'BOB@X.com', 'admin')).toBe(true);
    let r = await pool.query('SELECT role FROM users WHERE id=$1', [u.id]);
    expect(r.rows[0].role).toBe('admin');
    expect(await setRoleByEmail(pool, 'bob@x.com', 'user')).toBe(true);
    r = await pool.query('SELECT role FROM users WHERE id=$1', [u.id]);
    expect(r.rows[0].role).toBe('user');
    expect(await setRoleByEmail(pool, 'nobody@x.com', 'admin')).toBe(false);
  });

  test('listAdmins', async () => {
    await registerUser(app, 'u@x.com', 'plain');
    await makeAdmin(app, 'a@x.com', 'boss');
    expect(await listAdmins(pool)).toEqual([{ email: 'a@x.com', nickname: 'boss' }]);
  });
});

describe('CORS', () => {
  afterEach(() => { delete process.env.ADMIN_ORIGIN; });

  test('no header without ADMIN_ORIGIN', async () => {
    const res = await request(app).get('/admin-api/me').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('headers and 204 preflight with ADMIN_ORIGIN', async () => {
    process.env.ADMIN_ORIGIN = 'http://localhost:5173';
    const res = await request(app).get('/admin-api/me');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const pre = await request(app).options('/admin-api/me').set('Origin', 'http://localhost:5173');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toBe('Authorization, Content-Type');
    expect(pre.headers['access-control-allow-methods']).toBe('GET,POST,OPTIONS');
  });

  test('no CORS headers outside /admin-api', async () => {
    process.env.ADMIN_ORIGIN = 'http://localhost:5173';
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('static serving', () => {
  test('without dist folder /admin is 404', async () => {
    // unauthenticated unknown paths hit the pre-existing root-level requireAuth (401); with a token it is a plain 404
    const u = await registerUser(app, 'u@x.com');
    expect((await request(app).get('/admin').set(auth(u))).status).toBe(404);
    expect((await request(app).get('/admin/x/y').set(auth(u))).status).toBe(404);
  });

  test('with dist: SPA fallback, API untouched', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-dist-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<html>PAINEL</html>');
    process.env.ADMIN_DIST = dist;
    const app2 = createApp();
    const res = await request(app2).get('/admin/qualquer/rota');
    expect(res.status).toBe(200);
    expect(res.text).toContain('PAINEL');
    expect((await request(app2).get('/admin')).text).toContain('PAINEL');
    const api = await request(app2).get('/admin-api/me');
    expect(api.status).toBe(401);
    expect(api.body.error).toBe('nao_autenticado');
  });
});
