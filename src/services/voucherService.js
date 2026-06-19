const pool   = require('../config/db');
const { v4: uuidv4 } = require('uuid');

// ── Generate random voucher code ─────────────────────────────────────────────
function generateCode(prefix = 'SKY') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const suffix = Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  return `${prefix}-${suffix}`;
}

// ── Generate N unique vouchers ───────────────────────────────────────────────
async function generateVouchers({ planId, quantity, prefix = 'SKY', adminId }) {
  // Fetch plan
  const planRes = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (!planRes.rows.length) throw new Error('Plan not found');
  const plan = planRes.rows[0];

  const created = [];
  const client  = await pool.connect();

  try {
    await client.query('BEGIN');

    for (let i = 0; i < quantity; i++) {
      let code, exists = true;

      // Ensure unique code
      while (exists) {
        code = generateCode(prefix);
        const check = await client.query('SELECT id FROM vouchers WHERE code = $1', [code]);
        exists = check.rows.length > 0;
      }

      const res = await client.query(`
        INSERT INTO vouchers (code, plan_id, plan_name, duration_minutes, price, status, created_by)
        VALUES ($1, $2, $3, $4, $5, 'unused', $6)
        RETURNING *
      `, [code, plan.id, plan.name, plan.duration_minutes, plan.price, adminId]);

      created.push(res.rows[0]);
    }

    await client.query('COMMIT');

    // Log action
    await pool.query(`
      INSERT INTO admin_logs (admin_id, action, entity, detail)
      VALUES ($1, 'GENERATE_VOUCHERS', 'vouchers', $2)
    `, [adminId, `Generated ${quantity} ${plan.name} vouchers with prefix ${prefix}`]);

    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Validate and activate a voucher ─────────────────────────────────────────
async function validateVoucher({ code, macAddress, ipAddress, deviceName }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the voucher row
    const vRes = await client.query(
      'SELECT * FROM vouchers WHERE code = $1 FOR UPDATE',
      [code.toUpperCase()]
    );

    if (!vRes.rows.length) {
      throw { status: 404, message: 'Voucher not found' };
    }

    const voucher = vRes.rows[0];

    // Already expired
    if (voucher.status === 'expired') {
      throw { status: 410, message: 'Voucher has expired' };
    }

    // Already active — check if same device (reconnect)
    if (voucher.status === 'active') {
      if (voucher.mac_address !== macAddress) {
        throw { status: 403, message: 'Voucher is already in use by another device' };
      }
      // Same device reconnecting — check not expired
      if (new Date() > new Date(voucher.expiry_time)) {
        await client.query(
          "UPDATE vouchers SET status = 'expired' WHERE code = $1",
          [code.toUpperCase()]
        );
        await client.query('COMMIT');
        throw { status: 410, message: 'Session has expired' };
      }
      await client.query('COMMIT');
      return {
        voucher,
        reconnect: true,
        expiryTime: voucher.expiry_time,
      };
    }

    // First use — activate
    const now        = new Date();
    const expiryTime = new Date(now.getTime() + voucher.duration_minutes * 60 * 1000);

    await client.query(`
      UPDATE vouchers
      SET status       = 'active',
          mac_address  = $1,
          ip_address   = $2,
          device_name  = $3,
          start_time   = $4,
          expiry_time  = $5
      WHERE code = $6
    `, [macAddress, ipAddress, deviceName, now, expiryTime, code.toUpperCase()]);

    await client.query('COMMIT');

    return {
      voucher: { ...voucher, status: 'active', mac_address: macAddress, expiry_time: expiryTime },
      reconnect: false,
      expiryTime,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Get all vouchers with filters ────────────────────────────────────────────
async function getVouchers({ status, plan, search, page = 1, limit = 50 }) {
  let query  = 'SELECT * FROM vouchers WHERE 1=1';
  const params = [];
  let i = 1;

  if (status && status !== 'all') { query += ` AND status = $${i++}`; params.push(status); }
  if (plan)   { query += ` AND plan_name ILIKE $${i++}`; params.push(`%${plan}%`); }
  if (search) {
    query += ` AND (code ILIKE $${i} OR device_name ILIKE $${i} OR mac_address ILIKE $${i})`;
    params.push(`%${search}%`); i++;
  }

  query += ` ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`;
  params.push(limit, (page - 1) * limit);

  const res = await pool.query(query, params);
  return res.rows;
}

// ── Reset a voucher ───────────────────────────────────────────────────────────
async function resetVoucher({ code, adminId }) {
  await pool.query(`
    UPDATE vouchers
    SET status      = 'unused',
        mac_address = NULL,
        ip_address  = NULL,
        device_name = NULL,
        start_time  = NULL,
        expiry_time = NULL
    WHERE code = $1
  `, [code]);

  await pool.query(`
    INSERT INTO admin_logs (admin_id, action, entity, entity_id, detail)
    VALUES ($1, 'RESET_VOUCHER', 'vouchers', $2, 'Voucher reset to unused')
  `, [adminId, code]);
}

// ── Delete a voucher ──────────────────────────────────────────────────────────
async function deleteVoucher({ code, adminId }) {
  await pool.query('DELETE FROM vouchers WHERE code = $1', [code]);
  await pool.query(`
    INSERT INTO admin_logs (admin_id, action, entity, entity_id, detail)
    VALUES ($1, 'DELETE_VOUCHER', 'vouchers', $2, 'Voucher deleted')
  `, [adminId, code]);
}

module.exports = {
  generateVouchers,
  validateVoucher,
  getVouchers,
  resetVoucher,
  deleteVoucher,
};
