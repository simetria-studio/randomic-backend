const request = require('supertest');
const { createApp } = require('../src/app');
const { migrate } = require('../src/migrate');
const { pool, query } = require('../src/db');
const { resetDb, registerUser } = require('./helpers');

const app = createApp();

beforeEach(resetDb);
afterAll(() => pool.end());

test('migrates idempotently', async () => {
  await migrate(pool);
  await migrate(pool);
});

test('new user defaults', async () => {
  const u = await registerUser(app, 'a@b.com');
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [u.id]);
  expect(rows[0].role).toBe('user');
  expect(rows[0].status).toBe('active');
  expect(rows[0].token_version).toBe(0);
  expect(rows[0].suspended_until).toBeNull();
  expect(rows[0].status_reason).toBeNull();
});

test('existing reports default to open', async () => {
  const a = await registerUser(app, 'a@b.com', 'ana');
  const b = await registerUser(app, 'b@b.com', 'bia');
  await query('INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3)', [a.id, b.id, 'x']);
  const { rows } = await query('SELECT status, resolved_by, resolved_at FROM reports');
  expect(rows[0]).toEqual({ status: 'open', resolved_by: null, resolved_at: null });
});

test('admin_actions rejects unknown action', async () => {
  const a = await registerUser(app, 'a@b.com');
  await expect(
    query('INSERT INTO admin_actions (admin_id, action, reason) VALUES ($1,$2,$3)', [a.id, 'explode', 'x'])
  ).rejects.toThrow();
  await query('INSERT INTO admin_actions (admin_id, action, reason) VALUES ($1,$2,$3)', [a.id, 'ban', 'x']);
});

test('reports FK survive user deletion', async () => {
  const a = await registerUser(app, 'a@b.com', 'ana');
  const b = await registerUser(app, 'b@b.com', 'bia');
  await query('INSERT INTO reports (reporter_id, reported_id, reason) VALUES ($1,$2,$3)', [a.id, b.id, 'x']);
  await query('DELETE FROM users WHERE id = $1', [a.id]);
  const { rows } = await query('SELECT reporter_id, reported_id, status FROM reports');
  expect(rows).toHaveLength(1);
  expect(rows[0].reporter_id).toBeNull();
  expect(rows[0].reported_id).toBe(b.id);
  expect(rows[0].status).toBe('open');
});
