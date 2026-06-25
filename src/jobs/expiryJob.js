/**
 * SKYLINK NET — Expiry Enforcement Job (v2)
 *
 * Fix: separated the DB updates from the MikroTik queue step.
 * Each step is now its own try/catch — a missing column or any other
 * DB issue on step 2 will no longer block step 3 (the MikroTik removal),
 * which is the most critical part.
 */

const cron              = require('node-cron');
const pool              = require('../config/db');
const pollingController = require('../controllers/pollingController');

async function runExpiryCheck() {
  try {
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
      const { session_id, voucher_code, mac_address, plan_name, expiry_time } = session;

      // ── Step 1: Mark session expired ─────────────────────────────────────
      // ended_at is set here — run the migration first:
      //   ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
      try {
        await pool.query(`
          UPDATE sessions
          SET status = 'expired', ended_at = NOW()
          WHERE session_id = $1 AND status = 'active'
        `, [session_id]);
      } catch (err) {
        // Don't stop — log and continue to the MikroTik removal
        console.error(`[ExpiryJob] ⚠️  Could not update session ${session_id}: ${err.message}`);
        // Fallback: update without ended_at
        try {
          await pool.query(`
            UPDATE sessions SET status = 'expired'
            WHERE session_id = $1 AND status = 'active'
          `, [session_id]);
        } catch (fallbackErr) {
          console.error(`[ExpiryJob] ❌ Session update fallback also failed: ${fallbackErr.message}`);
        }
      }

      // ── Step 2: Mark voucher expired ─────────────────────────────────────
      try {
        await pool.query(`
          UPDATE vouchers SET status = 'expired'
          WHERE code = $1 AND status = 'active'
        `, [voucher_code]);
      } catch (err) {
        console.error(`[ExpiryJob] ⚠️  Could not expire voucher ${voucher_code}: ${err.message}`);
      }

      // ── Step 3: Queue MikroTik removal — ALWAYS runs even if steps above fail
      // This is the critical step. Without this, the user remains on the router
      // and can keep reconnecting after their time is up.
      try {
        await pollingController.queueVoucherRemove({ voucherCode: voucher_code });
        console.log(`[ExpiryJob] ✅ ${voucher_code} (${plan_name}) — removal queued | MAC: ${mac_address}`);
      } catch (err) {
        console.error(`[ExpiryJob] ❌ CRITICAL: Could not queue removal for ${voucher_code}: ${err.message}`);
      }

      // ── Step 4: Log ───────────────────────────────────────────────────────
      try {
        await pool.query(`
          INSERT INTO admin_logs (action, entity, entity_id, detail)
          VALUES ('AUTO_EXPIRE', 'sessions', $1, $2)
        `, [
          session_id,
          `Wall-clock expiry: ${voucher_code} (${plan_name}) | MAC: ${mac_address} | Expired: ${new Date(expiry_time).toISOString()}`
        ]);
      } catch (err) {
        // Logging failure is non-critical
        console.error(`[ExpiryJob] ⚠️  Could not write admin log: ${err.message}`);
      }
    }

  } catch (err) {
    console.error('[ExpiryJob] ❌ Expiry check crashed:', err.message);
  }
}

function startExpiryJob() {
  const cronExpr = process.env.EXPIRY_CRON || '* * * * *';
  console.log(`[ExpiryJob] ⏰ Wall-clock expiry enforcement started (${cronExpr})`);

  cron.schedule(cronExpr, () => {
    runExpiryCheck().catch(err =>
      console.error('[ExpiryJob] Unhandled error in scheduled run:', err.message)
    );
  });

  // Run immediately on boot — catches sessions that expired during downtime
  runExpiryCheck().catch(err =>
    console.error('[ExpiryJob] Unhandled error in boot run:', err.message)
  );
}

module.exports = { startExpiryJob, runExpiryCheck };