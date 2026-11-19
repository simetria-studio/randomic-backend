// Usage: node scripts/make-admin.js email@x | --demote email@x | --list
async function setRole(pool, email, role) {
  const { rowCount } = await pool.query('UPDATE users SET role = $2 WHERE lower(email) = lower($1)', [email, role]);
  return rowCount > 0;
}

async function listAdmins(pool) {
  const { rows } = await pool.query("SELECT email, nickname FROM users WHERE role = 'admin' ORDER BY email");
  return rows.map((r) => ({ email: r.email, nickname: r.nickname }));
}

async function main(argv) {
  const { pool } = require('../src/db');
  try {
    if (argv[0] === '--list') {
      const admins = await listAdmins(pool);
      if (!admins.length) console.log('Nenhum admin.');
      admins.forEach((a) => console.log(`${a.email}\t${a.nickname}`));
      return 0;
    }
    const demote = argv[0] === '--demote';
    const email = demote ? argv[1] : argv[0];
    if (!email) {
      console.error('Uso: node scripts/make-admin.js email@x | --demote email@x | --list');
      return 1;
    }
    const ok = await setRole(pool, email, demote ? 'user' : 'admin');
    if (!ok) {
      console.error(`Usuário não encontrado: ${email}`);
      return 1;
    }
    console.log(`${email} agora é ${demote ? 'user' : 'admin'}.`);
    return 0;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    }
  );
}

module.exports = { setRole, listAdmins };
