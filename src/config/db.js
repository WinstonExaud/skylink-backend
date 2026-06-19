const { Pool } = require('pg');
require('dotenv').config();

// Supabase (and most cloud Postgres providers) require SSL connections.
// Locally (development) SSL is usually not needed or configured differently.
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'skylink_db',
  user:     process.env.DB_USER     || 'skylink_user',
  password: process.env.DB_PASSWORD || 'skylink_pass',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Required for Supabase / most managed cloud Postgres providers
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌  Database connection failed:', err.message);
  } else {
    console.log('✅  PostgreSQL connected');
    release();
  }
});

module.exports = pool;