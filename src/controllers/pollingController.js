/**
 * SKYLINK NET — MikroTik Polling Controller
 *
 * Used by the LOCAL RELAY SERVICE (relay-service.js), not MikroTik
 * scripting directly. The relay runs on a device on your local
 * network and does the actual MikroTik API calls using proven,
 * tested Node.js code — completely avoiding RouterOS scripting.
 */

const pool = require('../config/db');

async function getPending(req, res) {
  try {
    const result = await pool.query(`
      SELECT id, mac_address, ip_address, profile
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

    const lines = result.rows.map(r =>
      `${r.mac_address},${r.ip_address || '0.0.0.0'},${r.profile}`
    );

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
  `, [mac, ip, profile, voucherCode || null]);
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