/**
 * SKYLINK NET — MikroTik Voucher Sync Controller
 *
 * Used by the local relay-service.js. When a voucher is generated
 * (via admin panel, from anywhere), it's queued here. The relay
 * picks it up within 5 seconds and creates a matching MikroTik
 * hotspot user — so when the customer enters the voucher on the
 * captive portal, MikroTik already recognizes it instantly.
 */

const pool = require('../config/db');

async function getPending(req, res) {
  try {
    const result = await pool.query(`
      SELECT id, action, voucher_code, profile
      FROM mikrotik_sync_queue
      WHERE delivered = false
      ORDER BY created_at ASC
      LIMIT 50
    `);

    if (!result.rows.length) {
      return res.type('text/plain').send('');
    }

    const ids = result.rows.map(r => r.id);
    await pool.query(
      `UPDATE mikrotik_sync_queue SET delivered = true, delivered_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );

    // Format: ACTION,CODE,PROFILE  (one per line)
    const lines = result.rows.map(r =>
      `${r.action},${r.voucher_code},${r.profile || ''}`
    );

    return res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('getPending error:', err);
    return res.status(500).type('text/plain').send('');
  }
}

// ── Called when a voucher is generated ───────────────────────────────────────
async function queueVoucherCreate({ voucherCode, profile }) {
  await pool.query(`
    INSERT INTO mikrotik_sync_queue (action, voucher_code, profile)
    VALUES ('create', $1, $2)
  `, [voucherCode, profile]);
}

// ── Called when a voucher is reset or deleted ────────────────────────────────
async function queueVoucherRemove({ voucherCode }) {
  await pool.query(`
    INSERT INTO mikrotik_sync_queue (action, voucher_code)
    VALUES ('remove', $1)
  `, [voucherCode]);
}

module.exports = { getPending, queueVoucherCreate, queueVoucherRemove };