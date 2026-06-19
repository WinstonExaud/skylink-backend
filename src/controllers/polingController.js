/**
 * SKYLINK NET — MikroTik Polling Controller
 *
 * Solves the "cloud backend can't reach local MikroTik" problem.
 * MikroTik polls this endpoint every 5 seconds asking for pending
 * activations, instead of the backend pushing to MikroTik directly.
 *
 * This works behind ANY NAT because MikroTik always INITIATES
 * the connection outward — which is never blocked by firewalls.
 */

const pool = require('../config/db');

// ── GET /api/mikrotik/pending ────────────────────────────────────────────────
// Called by MikroTik scheduler every few seconds.
// Returns pending activations as newline-separated "MAC|IP|PROFILE" lines,
// then marks them as delivered so they aren't processed twice.
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

    // Mark as delivered immediately to avoid double-processing
    const ids = result.rows.map(r => r.id);
    await pool.query(
      `UPDATE pending_activations SET delivered = true, delivered_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );

    // Format: one activation per line, fixed-width for easy MikroTik parsing
    // MAC (17 chars) | IP (15 chars, padded) | PROFILE
    const lines = result.rows.map(r => {
      const mac = r.mac_address.padEnd(17, ' ').substring(0, 17);
      const ip  = (r.ip_address || '').padEnd(15, ' ').substring(0, 15);
      return `${mac}${ip}${r.profile}`;
    });

    return res.type('text/plain').send(lines.join('\n'));
  } catch (err) {
    console.error('getPending error:', err);
    return res.status(500).type('text/plain').send('');
  }
}

// ── Internal helper — called by voucherController after successful login ────
// Queues an activation for MikroTik to pick up on its next poll
async function queueActivation({ mac, ip, profile }) {
  await pool.query(`
    INSERT INTO pending_activations (mac_address, ip_address, profile)
    VALUES ($1, $2, $3)
  `, [mac, ip, profile]);
}

// ── GET /api/mikrotik/disconnects ────────────────────────────────────────────
// Same polling pattern but for users that need to be KICKED
// (admin blocked them, or session expired via cron job)
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