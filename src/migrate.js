const fs = require('fs');
const path = require('path');

async function migrate(pool) {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return files;
}

module.exports = { migrate };

if (require.main === module) {
  const { pool } = require('./db');
  migrate(pool)
    .then((files) => console.log('applied:', files.join(', ')))
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
