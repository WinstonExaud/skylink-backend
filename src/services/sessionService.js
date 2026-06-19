const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const mikrotik = require('./mikrotikService');

// ── Create a new session ──────────────────────────────────────────────────────
async function createSession({ voucherCode, macAddress, ipAddress, deviceName, expiryTime }) {
  const sessionId = uuidv4();

  const res = await pool.query(`
    INSERT INTO sessions (session_id, voucher_code, mac_address, ip_address, device_name, expiry_time)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING *
  `, [sessionId, voucherCode, macAddress, ipAddress, deviceName, expiryTime]);

  // Update/insert device record
  await pool.query(`
    INSERT INTO devices (mac_address, device_name, ip_address, last_seen, total_sessions)
    VALUES ($1, $2, $3, NOW(), 1)
    ON CONFLICT (mac_address) DO UPDATE
      SET device_name    = COALESCE(EXCLUDED.device_name, devices.device_name),
          ip_address     = EXCLUDED.ip_address,
          last_seen      = NOW(),
          total_sessions = devices.total_sessions + 1
  `, [macAddress, deviceName, ipAddress]);

  return res.rows[0];
}

// ── Heartbeat — keep session alive ────────────────────────────────────────────
async function heartbeat({ sessionId }) {
  const res = await pool.query(`
    UPDATE sessions
    SET last_seen = NOW()
    WHERE session_id = $1 AND status = 'active'
    RETURNING *
  `, [sessionId]);

  if (!res.rows.length) return null;

  const session = res.rows[0];

  // Check expiry
  if (new Date() > new Date(session.expiry_time)) {
    await expireSession(sessionId);
    return null;
  }

  return session;
}

// ── Expire a single session ────────────────────────────────────────────────────
async function expireSession(sessionId) {
  const res = await pool.query(`
    UPDATE sessions
    SET status = 'expired'
    WHERE session_id = $1
    RETURNING mac_address, voucher_code
  `, [sessionId]);

  if (res.rows.length) {
    const { mac_address, voucher_code } = res.rows[0];

    // Mark voucher expired
    await pool.query(
      "UPDATE vouchers SET status = 'expired' WHERE code = $1",
      [voucher_code]
    );

    // Tell MikroTik to disconnect
    await mikrotik.disconnectUser({ mac: mac_address });
  }
}

// ── Kick a session (admin) ────────────────────────────────────────────────────
async function kickSession({ sessionId, adminId }) {
  const res = await pool.query(`
    UPDATE sessions
    SET status = 'kicked'
    WHERE session_id = $1
    RETURNING mac_address, voucher_code
  `, [sessionId]);

  if (!res.rows.length) throw { status: 404, message: 'Session not found' };

  const { mac_address, voucher_code } = res.rows[0];

  await mikrotik.disconnectUser({ mac: mac_address });

  await pool.query(`
    INSERT INTO admin_logs (admin_id, action, entity, entity_id, detail)
    VALUES ($1, 'KICK_SESSION', 'sessions', $2, $3)
  `, [adminId, sessionId, `Kicked session for MAC ${mac_address}`]);

  return res.rows[0];
}

// ── Get all sessions ──────────────────────────────────────────────────────────
async function getSessions({ status, search, page = 1, limit = 50 }) {
  let query  = `
    SELECT s.*, v.plan_name, v.duration_minutes
    FROM sessions s
    LEFT JOIN vouchers v ON v.code = s.voucher_code
    WHERE 1=1
  `;
  const params = [];
  let i = 1;

  if (status && status !== 'all') { query += ` AND s.status = $${i++}`; params.push(status); }
  if (search) {
    query += ` AND (s.voucher_code ILIKE $${i} OR s.mac_address ILIKE $${i} OR s.device_name ILIKE $${i})`;
    params.push(`%${search}%`); i++;
  }

  query += ` ORDER BY s.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
  params.push(limit, (page - 1) * limit);

  const res = await pool.query(query, params);
  return res.rows;
}

module.exports = { createSession, heartbeat, expireSession, kickSession, getSessions };
