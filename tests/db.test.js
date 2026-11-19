const { query, pool } = require('../src/db');
const { resetDb } = require('./helpers');

afterAll(() => pool.end());

test('schema applied and resetDb truncates', async () => {
  await query("INSERT INTO users(email,password_hash,nickname,birthdate,gender) VALUES('a@b.c','h','n','2000-01-01','m')");
  expect((await query('SELECT * FROM users')).rows[0].country).toBe('BR');
  await resetDb();
  expect((await query('SELECT count(*)::int c FROM users')).rows[0].c).toBe(0);
});
