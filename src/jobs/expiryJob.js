/**
 * SKYLINK NET — Expiry Enforcement Job
 *
 * Runs every minute. Enforces WALL-CLOCK expiry:
 * "1 hour voucher = expires exactly 1 hour after first use,
 *  regardless of how many times the customer disconnects/reconnects."
 *
 * Finds all sessions/vouchers past their wall-clock expiry_time and:
 *   1. Marks them expired in the DB
 *   2. Marks the voucher expired
 *   3. Queues a MikroTik user REMOVAL — this is what actually
 *      kicks them off and prevents reconnecting, overriding
 *      MikroTik's own usage-based session-timeout behavior.
 */

const cron     = require('node-cron');
const pool     = require('../config/db');
const pollingController = require('../controllers/pollingController');

async function runExpiryCheck() {
  try {
    // Find all active sessions that have passed WALL-CLOCK expiry
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

        // 3. Queue MikroTik removal — this enforces WALL-CLOCK cutoff.
        // Even if the customer disconnected early and MikroTik's own
        // session-timeout hasn't fired yet, this removes their hotspot
        // user entirely once the wall-clock expiry hits, so they can
        // no longer log back in.
        await pollingController.queueVoucherRemove({
          voucherCode: session.voucher_code,
        });

        // 4. Log it
        await pool.query(`
          INSERT INTO admin_logs (action, entity, entity_id, detail)
          VALUES ('AUTO_EXPIRE', 'sessions', $1, $2)
        `, [session.session_id, `Wall-clock expiry: ${session.voucher_code} (MAC ${session.mac_address})`]);

        console.log(`[ExpiryJob] ✅ Expired: ${session.voucher_code} (${session.mac_address}) — MikroTik removal queued`);

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
  console.log(`[ExpiryJob] ⏰ Scheduled: "${cronExpr}" (wall-clock enforcement)`);

  cron.schedule(cronExpr, () => {
    runExpiryCheck();
  });

  runExpiryCheck();
}

module.exports = { startExpiryJob, runExpiryCheck };