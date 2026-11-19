const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-up-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb } = require('./helpers');
const { pool, query } = require('../src/db');
const { isBlockedEitherWay } = require('../src/routes/safety');

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

beforeEach(resetDb);
afterAll(async () => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await pool.end();
});

describe('block', () => {
  test('requires auth', async () => {
    expect((await request(app).get('/blocks')).status).toBe(401);
  });

  test('block appears in GET /blocks, with first photo', async () => {
    const a = await register('a@b.com', 'ana');
    const b = await register('b@b.com', 'bia');
    await request(app).post('/me/photos').set(auth(b)).attach('photo', PNG, 'x.png');
    expect((await request(app).get('/blocks').set(auth(a))).body).toEqual([]);
    expect((await request(app).post(`/users/${b.id}/block`).set(auth(a))).status).toBe(204);
    const res = await request(app).get('/blocks').set(auth(a));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ userId: b.id, nickname: 'bia' });
    expect(res.body[0].photoUrl).toMatch(/\.png$/);
    expect((await request(app).get('/blocks').set(auth(b))).body).toEqual([]);
  });

  test('photoUrl null without photos; block is idempotent', async () => {
    const a = await register('a@b.com');
    const b = await register('b@b.com', 'bia');
    await request(app).post(`/users/${b.id}/block`).set(auth(a));
    expect((await request(app).post(`/users/${b.id}/block`).set(auth(a))).status).toBe(204);
    const res = await request(app).get('/blocks').set(auth(a));
    expect(res.body).toEqual([{ userId: b.id, nickname: 'bia', photoUrl: null }]);
  });

  test('isBlockedEitherWay both directions', async () => {
    const a = await register('a@b.com');
    const b = await register('b@b.com', 'bia');
    expect(await isBlockedEitherWay(a.id, b.id)).toBe(false);
    await request(app).post(`/users/${b.id}/block`).set(auth(a));
    expect(await isBlockedEitherWay(a.id, b.id)).toBe(true);
    expect(await isBlockedEitherWay(b.id, a.id)).toBe(true);
  });

  test('unblock removes, idempotent', async () => {
    const a = await register('a@b.com');
    const b = await register('b@b.com', 'bia');
    await request(app).post(`/users/${b.id}/block`).set(auth(a));
    expect((await request(app).delete(`/users/${b.id}/block`).set(auth(a))).status).toBe(204);
    expect((await request(app).delete(`/users/${b.id}/block`).set(auth(a))).status).toBe(204);
    expect((await request(app).get('/blocks').set(auth(a))).body).toEqual([]);
    expect(await isBlockedEitherWay(a.id, b.id)).toBe(false);
  });

  test('self block -> 400; unknown target -> 404', async () => {
    const a = await register('a@b.com');
    expect((await request(app).post(`/users/${a.id}/block`).set(auth(a))).status).toBe(400);
    expect((await request(app).post('/users/nao-uuid/block').set(auth(a))).status).toBe(404);
    expect(
      (await request(app).post('/users/00000000-0000-0000-0000-000000000000/block').set(auth(a))).status
    ).toBe(404);
  });
});

describe('report', () => {
  test('creates report -> 201', async () => {
    const a = await register('a@b.com');
    const b = await register('b@b.com', 'bia');
    const res = await request(app).post(`/users/${b.id}/report`).set(auth(a)).send({ reason: '  spam  ' });
    expect(res.status).toBe(201);
    const { rows } = await query('SELECT reporter_id, reported_id, reason FROM reports');
    expect(rows).toEqual([{ reporter_id: a.id, reported_id: b.id, reason: 'spam' }]);
  });

  test('invalid reason -> 400', async () => {
    const a = await register('a@b.com');
    const b = await register('b@b.com', 'bia');
    const post = (body) => request(app).post(`/users/${b.id}/report`).set(auth(a)).send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ reason: '   ' })).status).toBe(400);
    expect((await post({ reason: 5 })).status).toBe(400);
    expect((await post({ reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await post({ reason: 'x'.repeat(500) })).status).toBe(201);
  });

  test('report survives deletion of the reported user and of the reporter', async () => {
    const a = await register('a@b.com');
    const b = await register('b@b.com', 'bia');
    expect((await request(app).post(`/users/${b.id}/report`).set(auth(a)).send({ reason: 'spam' })).status).toBe(201);
    expect((await request(app).delete('/auth/account').set(auth(b))).status).toBe(204);
    let { rows } = await query('SELECT reporter_id, reported_id, reason FROM reports');
    expect(rows).toEqual([{ reporter_id: a.id, reported_id: null, reason: 'spam' }]);
    expect((await request(app).delete('/auth/account').set(auth(a))).status).toBe(204);
    ({ rows } = await query('SELECT reporter_id, reported_id, reason FROM reports'));
    expect(rows).toEqual([{ reporter_id: null, reported_id: null, reason: 'spam' }]);
  });

  test('self report -> 400; unknown target -> 404', async () => {
    const a = await register('a@b.com');
    expect((await request(app).post(`/users/${a.id}/report`).set(auth(a)).send({ reason: 'x' })).status).toBe(400);
    expect((await request(app).post('/users/zzz/report').set(auth(a)).send({ reason: 'x' })).status).toBe(404);
  });
});
