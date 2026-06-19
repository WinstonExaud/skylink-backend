/**
 * SKYLINK NET — MikroTik Polling Controller (v3 — Native Hotspot Users)
 *
 * Instead of injecting into /ip hotspot active (which requires complex
 * parsing on MikroTik's side), we now have MikroTik create a proper
 * HOTSPOT USER (username + password = voucher code). This uses MikroTik's
 * native, battle-tested authentication system — the captive portal then
 * submits this username/password directly to MikroTik's own login form.
 *
 * Format returned: just the voucher code + profile, one per line,
 * separated by a single space (simplest possible parsing).
 */

const pool = require('../config/db');

async function getPending(req, res) {
  try {
    const result = await pool.query(`
      SELECT id, mac_address, profile, voucher_code
      FROM pending_activations
      WHERE delivered = false
      ORDER BY created_at ASC
      LIMIT 20
    `);

    if (!result.rows.length) {
      return res.type('text/plain').send('');
    }

    const ids = result.rows.map(r => r.id);
    await pool.query(
      `UPDATE pending_activations SET delivered = true, delivered_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );

    // Simplest possible format: VOUCHERCODE PROFILE (space separated, no special chars)
    const lines = result.rows.map(r => `${r.voucher_code} ${r.profile}`);

    return res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('getPending error:', err);
    return res.status(500).type('text/plain').send('');
  }
}

async function queueActivation({ mac, ip, profile, voucherCode }) {
  await pool.query(`
    INSERT INTO pending_activations (mac_address, ip_address, profile, voucher_code)
    VALUES ($1, $2, $3, $4)
  `, [mac, ip, profile, voucherCode]);
}

async function getPendingDisconnects(req, res) {
  try {
    const result = await pool.query(`
      SELECT id, mac_address
      FROM pending_disconnects
      WHERE delivered = false
      ORDER BY created_at ASC
      LIMIT 20
    `);
    if (!result.rows.length) return res.type('text/plain').send('');
    const ids = result.rows.map(r => r.id);
    await pool.query(
      `UPDATE pending_disconnects SET delivered = true, delivered_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );
    const lines = result.rows.map(r => r.mac_address);
    return res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('getPendingDisconnects error:', err);
    return res.status(500).type('text/plain').send('');
  }
}

async function queueDisconnect({ mac }) {
  await pool.query(`INSERT INTO pending_disconnects (mac_address) VALUES ($1)`, [mac]);
}

module.exports = { getPending, queueActivation, getPendingDisconnects, queueDisconnect };