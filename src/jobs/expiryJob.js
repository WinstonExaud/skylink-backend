/**
 * SKYLINK NET — Expiry Enforcement Job
 *
 * Runs every minute (configurable via EXPIRY_CRON env var).
 * Finds all active sessions past their expiry_time and:
 *   1. Marks them expired in the DB
 *   2. Marks the voucher expired
 *   3. Tells MikroTik to disconnect the user
 *
 * This is the "24-hour hard rule" engine.
 */

const cron     = require('node-cron');
const pool     = require('../config/db');
const mikrotik = require('../services/mikrotikService');

async function runExpiryCheck() {
  try {
    // Find all active sessions that have passed expiry
    const expired = await pool.query(`
      SELECT session_id, mac_address, voucher_code
      FROM sessions
      WHERE status = 'active'
        AND expiry_time < NOW()
    `);

    if (!expired.rows.length) return;

    console.log(`[ExpiryJob] 🕐 Found ${expired.rows.length} expired session(s)`);

    for (const session of expired.rows) {
      try {
        // 1. Mark session expired
        await pool.query(
          "UPDATE sessions SET status = 'expired' WHERE session_id = $1",
          [session.session_id]
        );

        // 2. Mark voucher expired
        await pool.query(
          "UPDATE vouchers SET status = 'expired' WHERE code = $1",
          [session.voucher_code]
        );

        // 3. Disconnect from MikroTik
        await mikrotik.disconnectUser({ mac: session.mac_address });

        // 4. Log it
        await pool.query(`
          INSERT INTO admin_logs (action, entity, entity_id, detail)
          VALUES ('AUTO_EXPIRE', 'sessions', $1, $2)
        `, [session.session_id, `Auto-expired session for MAC ${session.mac_address}`]);

        console.log(`[ExpiryJob] ✅ Expired: ${session.voucher_code} (${session.mac_address})`);

      } catch (sessionErr) {
        console.error(`[ExpiryJob] ❌ Failed to expire session ${session.session_id}:`, sessionErr.message);
      }
    }

  } catch (err) {
    console.error('[ExpiryJob] ❌ Expiry check failed:', err.message);
  }
}

function startExpiryJob() {
  const cronExpr = process.env.EXPIRY_CRON || '* * * * *'; // every 1 minute
  console.log(`[ExpiryJob] ⏰ Scheduled: "${cronExpr}"`);

  cron.schedule(cronExpr, () => {
    runExpiryCheck();
  });

  // Also run once on startup
  runExpiryCheck();
}

module.exports = { startExpiryJob, runExpiryCheck };
