/**
 * SKYLINK NET — MikroTik Polling Controller
 *
 * Backend now returns the FULL MikroTik command as plain text.
 * MikroTik just executes it directly — zero client-side parsing,
 * eliminating all the nested :if / :pick / :find complexity that
 * kept failing due to RouterOS scripting quirks.
 */

const pool = require('../config/db');

// ── GET /api/mikrotik/pending ────────────────────────────────────────────────
// Returns ready-to-run MikroTik commands, one per line.
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

    // Return the FULL command MikroTik should run, one per line
    const lines = result.rows.map(r =>
      `/ip hotspot active add mac-address=${r.mac_address} address=${r.ip_address || '0.0.0.0'} server=hotspot1 profile=${r.profile}`
    );

    return res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('getPending error:', err);
    return res.status(500).type('text/plain').send('');
  }
}

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

    const lines = result.rows.map(r =>
      `/ip hotspot active remove [find mac-address=${r.mac_address}]`
    );
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