const { Pool } = require('pg');

const connectionString =
  process.env.NODE_ENV === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

const pool = new Pool({ connectionString });

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };
