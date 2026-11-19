const os = require('os');
const fs = require('fs');
const path = require('path');
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'randomic-up-'));
process.env.UPLOAD_DIR = uploadDir;

const request = require('supertest');
const { createApp } = require('../src/app');
const { resetDb } = require('./helpers');
const { pool } = require('../src/db');

const app = createApp();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function register(email = 'a@b.com') {
  const res = await request(app).post('/auth/register').send({
    email, password: 'senha1234', nickname: 'ana', birthdate: '1990-01-01', gender: 'feminino',
  });
  return res.body.token;
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeEach(resetDb);
afterAll(async () => {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await pool.end();
});

describe('profile', () => {
  test('GET /me without token -> 401', async () => {
    expect((await request(app).get('/me')).status).toBe(401);
  });

  test('GET /me returns profile, incomplete without photos', async () => {
    const t = await register();
    const res = await request(app).get('/me').set(auth(t));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nickname: 'ana', gender: 'feminino', country: 'BR', photos: [], profileComplete: false });
    expect(res.body.age).toBeGreaterThanOrEqual(35);
  });

  test('GET /me for deleted user -> 401', async () => {
    const t = await register();
    await request(app).delete('/auth/account').set(auth(t));
    expect((await request(app).get('/me').set(auth(t))).status).toBe(401);
  });

  test('PATCH /me updates and validates', async () => {
    const t = await register();
    const ok = await request(app).patch('/me').set(auth(t)).send({ nickname: 'bia', gender: 'outro', country: 'pt' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ nickname: 'bia', gender: 'outro', country: 'PT' });
    for (const bad of [{ gender: 'x' }, { country: 'BRA' }, { country: 1 }, { nickname: '' }, { nickname: 'a'.repeat(31) }]) {
      expect((await request(app).patch('/me').set(auth(t)).send(bad)).status).toBe(400);
    }
  });
});

describe('photos', () => {
  test('upload PNG -> 201, profileComplete true, file served', async () => {
    const t = await register();
    const up = await request(app).post('/me/photos').set(auth(t)).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body).toEqual({ id: expect.any(String), url: expect.stringMatching(/^\/uploads\/.+\.png$/) });
    const me = await request(app).get('/me').set(auth(t));
    expect(me.body.profileComplete).toBe(true);
    expect(me.body.photos).toEqual([up.body]);
    const file = await request(app).get(up.body.url);
    expect(file.status).toBe(200);
  });

  test('.exe -> 400', async () => {
    const t = await register();
    const res = await request(app).post('/me/photos').set(auth(t))
      .attach('photo', Buffer.from('MZ'), { filename: 'a.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
  });

  test('missing file -> 400', async () => {
    const t = await register();
    expect((await request(app).post('/me/photos').set(auth(t))).status).toBe(400);
  });

  test('> 5 MB -> 413', async () => {
    const t = await register();
    const res = await request(app).post('/me/photos').set(auth(t))
      .attach('photo', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
  });

  test('delete last photo -> profileComplete false; other user cannot delete', async () => {
    const t = await register();
    const other = await register('c@d.com');
    const up = await request(app).post('/me/photos').set(auth(t)).attach('photo', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect((await request(app).delete(`/me/photos/${up.body.id}`).set(auth(other))).status).toBe(404);
    expect((await request(app).delete(`/me/photos/${up.body.id}`).set(auth(t))).status).toBe(204);
    const me = await request(app).get('/me').set(auth(t));
    expect(me.body.profileComplete).toBe(false);
    expect((await request(app).delete('/me/photos/abc').set(auth(t))).status).toBe(404);
  });
});
