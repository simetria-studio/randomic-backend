const request = require('supertest');
const { createApp } = require('../src/app');
const { isAdult } = require('../src/auth');
const { resetDb } = require('./helpers');
const { pool, query } = require('../src/db');

const app = createApp();
const valid = {
  email: 'a@b.com',
  password: 'senha1234',
  nickname: 'ana',
  birthdate: '1990-01-01',
  gender: 'feminino',
};

beforeEach(resetDb);
afterAll(() => pool.end());

describe('isAdult', () => {
  test('exactly 18 today is adult', () => {
    expect(isAdult('2008-11-12', new Date('2026-11-12'))).toBe(true);
  });
  test('turns 18 tomorrow is not adult', () => {
    expect(isAdult('2008-11-13', new Date('2026-11-12'))).toBe(false);
  });
});

describe('POST /auth/register', () => {
  test('creates user and returns token', async () => {
    const res = await request(app).post('/auth/register').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'a@b.com', nickname: 'ana', country: 'BR' });
    expect(res.body.user.password_hash).toBeUndefined();
  });
  test('minor -> 400 menor_de_18', async () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 10);
    const res = await request(app)
      .post('/auth/register')
      .send({ ...valid, birthdate: d.toISOString().slice(0, 10) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'menor_de_18' });
  });
  test('duplicate email -> 409', async () => {
    await request(app).post('/auth/register').send(valid);
    const res = await request(app).post('/auth/register').send(valid);
    expect(res.status).toBe(409);
  });
  test('short password -> 400', async () => {
    const res = await request(app).post('/auth/register').send({ ...valid, password: '1234567' });
    expect(res.status).toBe(400);
  });
  test('invalid gender -> 400', async () => {
    const res = await request(app).post('/auth/register').send({ ...valid, gender: 'xyz' });
    expect(res.status).toBe(400);
  });
});

describe('login and delete', () => {
  test('login ok and wrong password 401', async () => {
    await request(app).post('/auth/register').send(valid);
    const ok = await request(app).post('/auth/login').send({ email: valid.email, password: valid.password });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toEqual(expect.any(String));
    const bad = await request(app).post('/auth/login').send({ email: valid.email, password: 'errada123' });
    expect(bad.status).toBe(401);
  });
  test('DELETE /auth/account requires auth', async () => {
    const res = await request(app).delete('/auth/account');
    expect(res.status).toBe(401);
  });
  test('DELETE /auth/account removes user', async () => {
    const reg = await request(app).post('/auth/register').send(valid);
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${reg.body.token}`);
    expect(res.status).toBe(204);
    const { rows } = await query('SELECT 1 FROM users');
    expect(rows).toHaveLength(0);
    const login = await request(app).post('/auth/login').send({ email: valid.email, password: valid.password });
    expect(login.status).toBe(401);
  });
  test('DELETE /auth/account removes the photo and media files from disk', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-del-'));
    const reg = await request(app).post('/auth/register').send(valid);
    const other = await request(app).post('/auth/register').send({ ...valid, email: 'c@d.com' });
    const dir = process.env.UPLOAD_DIR;
    for (const f of ['p.jpg', 'm.jpg']) fs.writeFileSync(path.join(dir, f), 'x');
    await query('INSERT INTO photos (user_id, url) VALUES ($1, $2)', [reg.body.user.id, '/uploads/p.jpg']);
    const [a, b] = [reg.body.user.id, other.body.user.id].sort();
    const { rows } = await query('INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) RETURNING id', [a, b]);
    await query(
      "INSERT INTO messages (conversation_id, sender_id, type, media_url) VALUES ($1,$2,'photo','/uploads/m.jpg')",
      [rows[0].id, other.body.user.id]
    );
    const res = await request(app).delete('/auth/account').set('Authorization', `Bearer ${reg.body.token}`);
    expect(res.status).toBe(204);
    expect(fs.existsSync(path.join(dir, 'p.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'm.jpg'))).toBe(false);
    const left = await query('SELECT 1 FROM users');
    expect(left.rows).toHaveLength(1);
  });
});
