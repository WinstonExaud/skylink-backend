const pool = require('../config/db');
const pollingController = require('../controllers/pollingController');

// ── Map plan name → MikroTik User Profile name ───────────────────────────────
function getMikroTikProfile(planName) {
  const map = {
    'hourly':  '1H-500',
    'daily':   '1D-1000',
    'weekly':  '1W-7000',
    'monthly': '30D-30000',
    'hour':    '1H-500',
    'day':     '1D-1000',
    'week':    '1W-7000',
    'month':   '30D-30000',
  };
  const key = (planName || '').toLowerCase().trim();
  return map[key] || '1D-1000';
}

// ── Generate random voucher code ─────────────────────────────────────────────
function generateCode(prefix = 'SKY') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const suffix = Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  return `${prefix}-${suffix}`;
}

// ── Generate N unique vouchers + queue MikroTik sync ─────────────────────────
async function generateVouchers({ planId, quantity, prefix = 'SKY', adminId }) {
  const planRes = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (!planRes.rows.length) throw new Error('Plan not found');
  const plan = planRes.rows[0];
  const mikrotikProfile = getMikroTikProfile(plan.name);

  const created = [];
  const client  = await pool.connect();

  try {
    await client.query('BEGIN');

    for (let i = 0; i < quantity; i++) {
      let code, exists = true;

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

    // ── Queue MikroTik sync for each voucher ───────────────────────────────
    // The local relay will pick these up within 5 seconds and create
    // matching hotspot users on MikroTik — so by the time you send the
    // voucher code to your customer, it's already usable.
    for (const voucher of created) {
      await pollingController.queueVoucherCreate({
        voucherCode: voucher.code,
        profile: mikrotikProfile,
      });
    }

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

// ── Validate voucher (used by old runtime flow — kept for stats/tracking) ───
async function validateVoucher({ code, macAddress, ipAddress, deviceName }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const vRes = await client.query(
      'SELECT * FROM vouchers WHERE code = $1 FOR UPDATE',
      [code.toUpperCase()]
    );

    if (!vRes.rows.length) {
      throw { status: 404, message: 'Voucher not found' };
    }

    const voucher = vRes.rows[0];

    if (voucher.status === 'expired') {
      throw { status: 410, message: 'Voucher has expired' };
    }

    if (voucher.status === 'active') {
      if (voucher.mac_address !== macAddress) {
        throw { status: 403, message: 'Voucher is already in use by another device' };
      }
      if (new Date() > new Date(voucher.expiry_time)) {
        await client.query("UPDATE vouchers SET status = 'expired' WHERE code = $1", [code.toUpperCase()]);
        await client.query('COMMIT');
        throw { status: 410, message: 'Session has expired' };
      }
      await client.query('COMMIT');
      return { voucher, reconnect: true, expiryTime: voucher.expiry_time };
    }

    const now        = new Date();
    const expiryTime = new Date(now.getTime() + voucher.duration_minutes * 60 * 1000);

    await client.query(`
      UPDATE vouchers
      SET status = 'active', mac_address = $1, ip_address = $2,
          device_name = $3, start_time = $4, expiry_time = $5
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

// ── Reset voucher — also queue MikroTik removal so it can be re-synced ──────
async function resetVoucher({ code, adminId }) {
  await pool.query(`
    UPDATE vouchers
    SET status = 'unused', mac_address = NULL, ip_address = NULL,
        device_name = NULL, start_time = NULL, expiry_time = NULL
    WHERE code = $1
  `, [code]);

  // Re-queue creation in case it was somehow removed from MikroTik
  const vRes = await pool.query('SELECT plan_name FROM vouchers WHERE code = $1', [code]);
  if (vRes.rows.length) {
    const profile = getMikroTikProfile(vRes.rows[0].plan_name);
    await pollingController.queueVoucherCreate({ voucherCode: code, profile });
  }

  await pool.query(`
    INSERT INTO admin_logs (admin_id, action, entity, entity_id, detail)
    VALUES ($1, 'RESET_VOUCHER', 'vouchers', $2, 'Voucher reset to unused')
  `, [adminId, code]);
}

async function deleteVoucher({ code, adminId }) {
  await pool.query('DELETE FROM vouchers WHERE code = $1', [code]);

  // Queue removal from MikroTik too
  await pollingController.queueVoucherRemove({ voucherCode: code });

  await pool.query(`
  INSERT INTO admin_logs (admin_id, action, entity, detail)
  VALUES ($1, 'DELETE_VOUCHER', 'vouchers', $2)
`, [adminId, `Deleted voucher ${code}`]);
}

module.exports = {
  generateVouchers,
  validateVoucher,
  getVouchers,
  resetVoucher,
  deleteVoucher,
};