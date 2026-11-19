const path = require('path');
const fs = require('fs');
const net = require('net');
const { Pool } = require('pg');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

module.exports = async () => {
  const EmbeddedPostgres = require('embedded-postgres').default;
  const databaseDir = path.join(__dirname, '..', '.pgdata');
  fs.rmSync(databaseDir, { recursive: true, force: true });
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir, user: 'postgres', password: 'postgres', port, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('randomic_test');
  const url = `postgres://postgres:postgres@localhost:${port}/randomic_test`;
  const pool = new Pool({ connectionString: url });
  const { migrate } = require('../src/migrate');
  await migrate(pool);
  await pool.end();
  process.env.TEST_DATABASE_URL = url;
  globalThis.__PG__ = pg;
};
