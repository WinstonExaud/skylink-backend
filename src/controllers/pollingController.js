/**
 * SKYLINK NET — MikroTik Polling Controller
 *
 * MikroTik polls this endpoint every 5 seconds asking for pending
 * activations, instead of the backend pushing to MikroTik directly.
 *
 * Format: comma-delimited, one activation per line:
 *   MAC,IP,PROFILE
 * Much more reliable than fixed-width parsing in MikroTik scripts.
 */

const pool = require('../config/db');

// ── GET /api/mikrotik/pending ────────────────────────────────────────────────
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

    // Comma-delimited format: MAC,IP,PROFILE — one per line
    const lines = result.rows.map(r =>
      `${r.mac_address},${r.ip_address || '0.0.0.0'},${r.profile}`
    );

    return res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('getPending error:', err);
    return res.status(500).type('text/plain').send('');
  }
}

// ── Internal helper — called by voucherController after successful login ────
async function queueActivation({ mac, ip, profile }) {
  await pool.query(`
    INSERT INTO pending_activations (mac_address, ip_address, profile)
    VALUES ($1, $2, $3)
  `, [mac, ip, profile]);
}

// ── GET /api/mikrotik/disconnects ────────────────────────────────────────────
async function getPendingDisconnects(req, res) {
  try {
    const result = await pool.query(`
      SELECT id, mac_address
      FROM pending_disconnects
      WHERE delivered = false
      ORDER BY created_at ASC
      LIMIT 20
    `);

    if (!result.rows.length) {
      return res.type('text/plain').send('');
    }

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
  await pool.query(`
    INSERT INTO pending_disconnects (mac_address)
    VALUES ($1)
  `, [mac]);
}

module.exports = {
  getPending,
  queueActivation,
  getPendingDisconnects,
  queueDisconnect,
};