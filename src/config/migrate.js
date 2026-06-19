/**
 * SKYLINK NET — Database Migration
 * Run: node src/config/migrate.js
 *
 * Creates all tables fresh. Safe to re-run (uses IF NOT EXISTS).
 */

require('dotenv').config();
const pool = require('./db');

const SQL = `

-- ─── ADMINS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id         SERIAL PRIMARY KEY,
  username   VARCHAR(100) UNIQUE NOT NULL,
  password   VARCHAR(255) NOT NULL,          -- bcrypt hash
  role       VARCHAR(50)  DEFAULT 'admin',
  created_at TIMESTAMP    DEFAULT NOW()
);

-- ─── PLANS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(100) NOT NULL,   -- Hourly, Daily, Weekly, Monthly
  duration_minutes  INT NOT NULL,            -- 60, 1440, 10080, 43200
  price             INT NOT NULL,            -- TZS
  speed_limit       VARCHAR(50) DEFAULT 'Unlimited',
  active            BOOLEAN DEFAULT true,
  created_at        TIMESTAMP DEFAULT NOW()
);

-- ─── VOUCHERS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vouchers (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(20) UNIQUE NOT NULL,
  plan_id     INT REFERENCES plans(id),
  plan_name   VARCHAR(100),
  duration_minutes INT,
  price       INT,
  status      VARCHAR(20) DEFAULT 'unused',  -- unused | active | expired
  mac_address VARCHAR(50),                   -- bound MAC on first use
  ip_address  VARCHAR(20),
  device_name VARCHAR(100),
  start_time  TIMESTAMP,
  expiry_time TIMESTAMP,
  created_by  INT REFERENCES admins(id),
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vouchers_code   ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_mac    ON vouchers(mac_address);

-- ─── SESSIONS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           SERIAL PRIMARY KEY,
  session_id   VARCHAR(100) UNIQUE NOT NULL,
  voucher_code VARCHAR(20) REFERENCES vouchers(code),
  mac_address  VARCHAR(50) NOT NULL,
  ip_address   VARCHAR(20),
  device_name  VARCHAR(100),
  start_time   TIMESTAMP DEFAULT NOW(),
  last_seen    TIMESTAMP DEFAULT NOW(),
  expiry_time  TIMESTAMP NOT NULL,
  status       VARCHAR(20) DEFAULT 'active',  -- active | expired | kicked
  bytes_used   BIGINT DEFAULT 0,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_status      ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_mac         ON sessions(mac_address);
CREATE INDEX IF NOT EXISTS idx_sessions_voucher     ON sessions(voucher_code);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry      ON sessions(expiry_time);

-- ─── DEVICES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id              SERIAL PRIMARY KEY,
  mac_address     VARCHAR(50) UNIQUE NOT NULL,
  vendor          VARCHAR(100),
  device_name     VARCHAR(100),
  ip_address      VARCHAR(20),
  first_seen      TIMESTAMP DEFAULT NOW(),
  last_seen       TIMESTAMP DEFAULT NOW(),
  total_sessions  INT DEFAULT 0,
  total_bytes     BIGINT DEFAULT 0,
  blocked         BOOLEAN DEFAULT false,
  block_reason    TEXT,
  blocked_at      TIMESTAMP,
  blocked_by      INT REFERENCES admins(id)
);

CREATE INDEX IF NOT EXISTS idx_devices_mac     ON devices(mac_address);
CREATE INDEX IF NOT EXISTS idx_devices_blocked ON devices(blocked);

-- ─── ADMIN LOGS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_logs (
  id         SERIAL PRIMARY KEY,
  admin_id   INT REFERENCES admins(id),
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(100),
  entity_id  VARCHAR(100),
  detail     TEXT,
  ip_address VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON admin_logs(created_at DESC);

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄  Running migrations...');
    await client.query(SQL);
    console.log('✅  All tables created successfully.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
