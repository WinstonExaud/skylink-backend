/**
 * SKYLINK NET — Expiry Enforcement Job
 *
 * Runs every minute. Enforces WALL-CLOCK expiry:
 * "1 hour voucher = expires exactly 1 hour after first use,
 *  regardless of how many times the customer disconnects/reconnects."
 *
 * Flow:
 *   1. Find all active sessions where NOW() > expiry_time
 *   2. Mark session + voucher as 'expired' in DB
 *   3. Queue MikroTik REMOVE → relay picks it up → router deletes the user
 *   4. Log it in admin_logs
 *
 * The MikroTik removal is the critical step — without it, even after
 * the DB expires the voucher, the hotspot user still exists on the
 * router and the customer can reconnect by just re-entering the code.
 */

const cron              = require('node-cron');
const pool              = require('../config/db');
const pollingController = require('../controllers/pollingController');

async function runExpiryCheck() {
  try {
    // ── Step 1: Find all active sessions past wall-clock expiry ────────────
    const expired = await pool.query(`
      SELECT s.session_id, s.mac_address, s.voucher_code, s.expiry_time,
             v.plan_name
      FROM sessions s
      JOIN vouchers v ON v.code = s.voucher_code
      WHERE s.status = 'active'
        AND s.expiry_time IS NOT NULL
        AND s.expiry_time < NOW()
    `);

    if (!expired.rows.length) return;

    console.log(`[ExpiryJob] 🕐 Found ${expired.rows.length} expired session(s) — processing...`);

    for (const session of expired.rows) {
      try {
        const { session_id, voucher_code, mac_address, plan_name, expiry_time } = session;

        // ── Step 2a: Mark session expired ──────────────────────────────────
        await pool.query(`
          UPDATE sessions
          SET status = 'expired', ended_at = NOW()
          WHERE session_id = $1 AND status = 'active'
        `, [session_id]);

        // ── Step 2b: Mark voucher expired ──────────────────────────────────
        await pool.query(`
          UPDATE vouchers
          SET status = 'expired'
          WHERE code = $1 AND status = 'active'
        `, [voucher_code]);

        // ── Step 3: Queue MikroTik removal ─────────────────────────────────
        // This is what actually enforces the expiry on the router.
        // The relay will:
        //   a) kick any active hotspot session for this user
        //   b) delete the hotspot user entirely
        // After this, entering the voucher code on the portal returns
        // "login failed" because the user no longer exists on MikroTik.
        await pollingController.queueVoucherRemove({ voucherCode: voucher_code });

        // ── Step 4: Log ────────────────────────────────────────────────────
        await pool.query(`
          INSERT INTO admin_logs (action, entity, entity_id, detail)
          VALUES ('AUTO_EXPIRE', 'sessions', $1, $2)
        `, [
          session_id,
          `Wall-clock expiry: ${voucher_code} (${plan_name}) | MAC: ${mac_address} | Expired: ${new Date(expiry_time).toISOString()}`
        ]);

        console.log(`[ExpiryJob] ✅ ${voucher_code} (${plan_name}) — expired & removal queued | MAC: ${mac_address}`);

      } catch (rowErr) {
        // One row failing must never stop the rest
        console.error(`[ExpiryJob] ❌ Failed for session ${session.session_id}:`, rowErr.message);
      }
    }

  } catch (err) {
    console.error('[ExpiryJob] ❌ Expiry check crashed:', err.message);
  }
}

function startExpiryJob() {
  // Default: every 60 seconds. Override with EXPIRY_CRON env var.
  // Examples:
  //   '*/2 * * * *'  → every 2 minutes (more responsive)
  //   '* * * * *'    → every minute (default)
  const cronExpr = process.env.EXPIRY_CRON || '* * * * *';

  console.log(`[ExpiryJob] ⏰ Wall-clock expiry enforcement started (${cronExpr})`);

  cron.schedule(cronExpr, () => {
    runExpiryCheck().catch(err =>
      console.error('[ExpiryJob] Unhandled error in scheduled run:', err.message)
    );
  });

  // Also run immediately on boot — catches anything that expired
  // while the server was down (e.g. overnight restart)
  runExpiryCheck().catch(err =>
    console.error('[ExpiryJob] Unhandled error in boot run:', err.message)
  );
}

module.exports = { startExpiryJob, runExpiryCheck };