const pool     = require('../config/db');
const mikrotik = require('../services/mikrotikService');

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
async function getDashboardStats(req, res) {
  try {
    const [vouchers, sessions, devices, revenue, logs] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'unused')  AS available,
          COUNT(*) FILTER (WHERE status = 'active')  AS active,
          COUNT(*) FILTER (WHERE status = 'expired') AS expired,
          COUNT(*) AS total
        FROM vouchers
      `),
      pool.query(`SELECT COUNT(*) AS active FROM sessions WHERE status = 'active'`),
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE blocked = true) AS blocked
        FROM devices
      `),
      pool.query(`
        SELECT COALESCE(SUM(price), 0) AS today
        FROM vouchers
        WHERE status IN ('active','expired')
          AND DATE(start_time) = CURRENT_DATE
      `),
      pool.query(`
        SELECT action, detail, created_at
        FROM admin_logs
        ORDER BY created_at DESC
        LIMIT 10
      `),
    ]);

    return res.json({
      todayRevenue:      parseInt(revenue.rows[0].today),
      activeSessions:    parseInt(sessions.rows[0].active),
      availableVouchers: parseInt(vouchers.rows[0].available),
      expiredVouchers:   parseInt(vouchers.rows[0].expired),
      totalVouchers:     parseInt(vouchers.rows[0].total),
      totalDevices:      parseInt(devices.rows[0].total),
      blockedDevices:    parseInt(devices.rows[0].blocked),
      recentLogs:        logs.rows,
    });
  } catch (err) {
    console.error('getDashboardStats error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── GET /api/admin/stats/revenue?period=week|month|year ──────────────────────
async function getRevenueChart(req, res) {
  try {
    const { period = 'week' } = req.query;

    let query;
    if (period === 'week') {
      query = `
        SELECT TO_CHAR(start_time, 'Dy') AS label,
               DATE(start_time)           AS day,
               COALESCE(SUM(price), 0)    AS revenue,
               COUNT(*)                   AS sessions
        FROM vouchers
        WHERE start_time >= NOW() - INTERVAL '7 days'
          AND status IN ('active','expired')
        GROUP BY DATE(start_time), TO_CHAR(start_time, 'Dy')
        ORDER BY day
      `;
    } else if (period === 'month') {
      query = `
        SELECT TO_CHAR(start_time, 'W')              AS label,
               DATE_TRUNC('week', start_time)         AS week,
               COALESCE(SUM(price), 0)               AS revenue,
               COUNT(*)                              AS sessions
        FROM vouchers
        WHERE start_time >= DATE_TRUNC('month', NOW())
          AND status IN ('active','expired')
        GROUP BY DATE_TRUNC('week', start_time), TO_CHAR(start_time, 'W')
        ORDER BY week
      `;
    } else {
      query = `
        SELECT TO_CHAR(start_time, 'Mon')           AS label,
               DATE_TRUNC('month', start_time)       AS month,
               COALESCE(SUM(price), 0)              AS revenue,
               COUNT(*)                             AS sessions
        FROM vouchers
        WHERE start_time >= NOW() - INTERVAL '12 months'
          AND status IN ('active','expired')
        GROUP BY DATE_TRUNC('month', start_time), TO_CHAR(start_time, 'Mon')
        ORDER BY month
      `;
    }

    const result = await pool.query(query);
    return res.json({ data: result.rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── GET /api/admin/devices ────────────────────────────────────────────────────
async function getDevices(req, res) {
  try {
    const { blocked, search } = req.query;
    let query  = 'SELECT * FROM devices WHERE 1=1';
    const params = [];
    let i = 1;

    if (blocked !== undefined) { query += ` AND blocked = $${i++}`; params.push(blocked === 'true'); }
    if (search) {
      query += ` AND (mac_address ILIKE $${i} OR device_name ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    query += ' ORDER BY last_seen DESC';

    const res2 = await pool.query(query, params);
    return res.json({ devices: res2.rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── PUT /api/admin/devices/:mac/block ────────────────────────────────────────
async function blockDevice(req, res) {
  try {
    const { mac } = req.params;
    const { reason } = req.body;

    await pool.query(`
      UPDATE devices
      SET blocked = true, block_reason = $1, blocked_at = NOW(), blocked_by = $2
      WHERE mac_address = $3
    `, [reason || 'Blocked by admin', req.admin.adminId, mac]);

    // Tell MikroTik
    await mikrotik.blockDevice({ mac });

    // Kill active sessions for this device
    const sessions = await pool.query(
      "SELECT session_id FROM sessions WHERE mac_address = $1 AND status = 'active'",
      [mac]
    );
    for (const s of sessions.rows) {
      await pool.query("UPDATE sessions SET status = 'kicked' WHERE session_id = $1", [s.session_id]);
    }

    await pool.query(`
      INSERT INTO admin_logs (admin_id, action, entity, entity_id, detail)
      VALUES ($1, 'BLOCK_DEVICE', 'devices', $2, $3)
    `, [req.admin.adminId, mac, `Device blocked. Reason: ${reason || 'No reason given'}`]);

    return res.json({ message: 'Device blocked successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── PUT /api/admin/devices/:mac/unblock ──────────────────────────────────────
async function unblockDevice(req, res) {
  try {
    const { mac } = req.params;

    await pool.query(`
      UPDATE devices
      SET blocked = false, block_reason = NULL, blocked_at = NULL, blocked_by = NULL
      WHERE mac_address = $1
    `, [mac]);

    await mikrotik.unblockDevice({ mac });

    await pool.query(`
      INSERT INTO admin_logs (admin_id, action, entity, entity_id, detail)
      VALUES ($1, 'UNBLOCK_DEVICE', 'devices', $2, 'Device unblocked')
    `, [req.admin.adminId, mac]);

    return res.json({ message: 'Device unblocked successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── GET /api/admin/logs ───────────────────────────────────────────────────────
async function getLogs(req, res) {
  try {
    const { page = 1, limit = 50 } = req.query;
    const result = await pool.query(`
      SELECT l.*, a.username AS admin_username
      FROM admin_logs l
      LEFT JOIN admins a ON a.id = l.admin_id
      ORDER BY l.created_at DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), (parseInt(page) - 1) * parseInt(limit)]);

    return res.json({ logs: result.rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── GET /api/admin/plans ──────────────────────────────────────────────────────
async function getPlans(req, res) {
  try {
    const result = await pool.query('SELECT * FROM plans WHERE active = true ORDER BY duration_minutes');
    return res.json({ plans: result.rows });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── POST /api/admin/plans ─────────────────────────────────────────────────────
async function createPlan(req, res) {
  try {
    const { name, duration_minutes, price, speed_limit } = req.body;
    const result = await pool.query(`
      INSERT INTO plans (name, duration_minutes, price, speed_limit)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, duration_minutes, price, speed_limit || 'Unlimited']);

    return res.status(201).json({ plan: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── GET /api/admin/mikrotik/status ───────────────────────────────────────────
async function getMikrotikStatus(req, res) {
  try {
    const status = await mikrotik.testConnection();
    return res.json(status);
  } catch (err) {
    return res.status(500).json({ connected: false, error: err.message });
  }
}

module.exports = {
  getDashboardStats,
  getRevenueChart,
  getDevices,
  blockDevice,
  unblockDevice,
  getLogs,
  getPlans,
  createPlan,
  getMikrotikStatus,
};
