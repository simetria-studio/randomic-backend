const request = require('supertest');
const { createApp } = require('../src/app');
const { createLimiter } = require('../src/rateLimit');
const { pool } = require('../src/db');
const { resetDb, registerUser, setStatus } = require('./helpers');

describe('createLimiter', () => {
  test('blocks after max failures within the window', () => {
    let t = 0;
    const l = createLimiter({ max: 3, windowMs: 1000, now: () => t });
    l.fail('a'); l.fail('a');
    expect(l.isBlocked('a')).toBe(false);
    l.fail('a');
    expect(l.isBlocked('a')).toBe(true);
  });
  test('window expiry unblocks', () => {
    let t = 0;
    const l = createLimiter({ max: 2, windowMs: 1000, now: () => t });
    l.fail('a'); l.fail('a');
    expect(l.isBlocked('a')).toBe(true);
    t = 1001;
    expect(l.isBlocked('a')).toBe(false);
  });
  test('reset clears', () => {
    const l = createLimiter({ max: 1, windowMs: 1000 });
    l.fail('a'); l.fail('b');
    l.reset('a');
    expect(l.isBlocked('a')).toBe(false);
    expect(l.isBlocked('b')).toBe(true);
    l.reset();
    expect(l.isBlocked('b')).toBe(false);
  });
  test('expired entries are purged lazily so the map does not grow forever', () => {
    let t = 0;
    const l = createLimiter({ max: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 50; i++) l.fail(`ip${i}`);
    expect(l.size()).toBe(50);
    t = 5000;
    l.fail('fresh');
    expect(l.size()).toBe(1);
  });
  test('keys are independent', () => {
    const l = createLimiter({ max: 1, windowMs: 1000 });
    l.fail('a');
    expect(l.isBlocked('a')).toBe(true);
    expect(l.isBlocked('b')).toBe(false);
  });
});

describe('POST /auth/login rate limit', () => {
  const app = createApp();
  beforeEach(resetDb);
  afterAll(() => pool.end());

  const bad = (email = 'a@x.com') => request(app).post('/auth/login').send({ email, password: 'errada123' });
  const good = (email = 'a@x.com') => request(app).post('/auth/login').send({ email, password: 'senha1234' });

  test('11th wrong login returns 429 muitas_tentativas even with the right password', async () => {
    await registerUser(app, 'a@x.com');
    for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(401);
    const res = await bad();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('muitas_tentativas');
    expect((await good()).status).toBe(429);
  });

  test('a successful login does not wipe the IP failure count (interleaved bypass)', async () => {
    await registerUser(app, 'a@x.com');
    await registerUser(app, 'own@x.com');
    for (let i = 0; i < 9; i++) expect((await bad()).status).toBe(401);
    expect((await good('own@x.com')).status).toBe(200);
    expect((await bad()).status).toBe(401); // 10th failure
    const res = await bad();
    expect(res.status).toBe(429);
    expect((await good('own@x.com')).status).toBe(429);
  });

  test('restricted-account 403 does not count as failure', async () => {
    const u = await registerUser(app, 'a@x.com');
    await setStatus(u.id, { status: 'banned', reason: 'x' });
    for (let i = 0; i < 12; i++) expect((await good()).status).toBe(403);
  });
});
