/**
 * SKYLINK NET — Session Sync Controller
 *
 * Receives real-time active session data from the local relay
 * (which reads it directly from MikroTik's /ip hotspot active list).
 * This is what gives the admin panel real MAC, IP, uptime visibility.
 */

const pool = require('../config/db');

// ── POST /api/mikrotik/sessions ──────────────────────────────────────────────
// Called by relay-service.js every 10 seconds with current active sessions
async function syncSessions(req, res) {
  try {
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) {
      return res.status(400).json({ message: 'sessions array required' });
    }

    for (const s of sessions) {
      const { voucherCode, macAddress, ipAddress, uptime, bytesIn, bytesOut } = s;
      if (!voucherCode) continue;

      // Upsert into sessions table — update if exists, insert if new
      const existing = await pool.query(
        `SELECT id FROM sessions WHERE voucher_code = $1 AND status = 'active'`,
        [voucherCode]
      );

      if (existing.rows.length) {
        // Update existing session with fresh data from MikroTik
        await pool.query(`
          UPDATE sessions
          SET mac_address = $1, ip_address = $2, last_seen = NOW(),
              bytes_used = $3
          WHERE voucher_code = $4 AND status = 'active'
        `, [macAddress, ipAddress, parseInt(bytesIn || 0) + parseInt(bytesOut || 0), voucherCode]);
      } else {
        // New session MikroTik knows about that we don't have yet
        // (e.g. customer connected directly without going through our portal flow)
        const { v4: uuidv4 } = require('uuid');
        const sessionId = uuidv4();

        // Look up the voucher to get expiry info
        const voucherRes = await pool.query(
          'SELECT duration_minutes, plan_name FROM vouchers WHERE code = $1',
          [voucherCode]
        );

        if (voucherRes.rows.length) {
          const { duration_minutes } = voucherRes.rows[0];
          const expiryTime = new Date(Date.now() + duration_minutes * 60 * 1000);

          await pool.query(`
            INSERT INTO sessions (session_id, voucher_code, mac_address, ip_address, expiry_time, status, bytes_used)
            VALUES ($1, $2, $3, $4, $5, 'active', $6)
            ON CONFLICT (session_id) DO NOTHING
          `, [sessionId, voucherCode, macAddress, ipAddress, expiryTime, parseInt(bytesIn || 0) + parseInt(bytesOut || 0)]);

          // Mark voucher as active too
          await pool.query(`
            UPDATE vouchers
            SET status = 'active', mac_address = $1, ip_address = $2,
                start_time = COALESCE(start_time, NOW()),
                expiry_time = COALESCE(expiry_time, $3)
            WHERE code = $4 AND status != 'active'
          `, [macAddress, ipAddress, expiryTime, voucherCode]);

          // Update device tracking
          await pool.query(`
            INSERT INTO devices (mac_address, ip_address, last_seen, total_sessions)
            VALUES ($1, $2, NOW(), 1)
            ON CONFLICT (mac_address) DO UPDATE
              SET ip_address = EXCLUDED.ip_address,
                  last_seen  = NOW(),
                  total_sessions = devices.total_sessions + 1
          `, [macAddress, ipAddress]);
        }
      }
    }

    return res.json({ message: 'Sessions synced', count: sessions.length });
  } catch (err) {
    console.error('syncSessions error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { syncSessions };