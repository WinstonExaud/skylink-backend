const voucherService = require('../services/voucherService');
const sessionService = require('../services/sessionService');
const mikrotik       = require('../services/mikrotikService');
const pool           = require('../config/db');

// ── POST /api/auth/voucher-login ─────────────────────────────────────────────
async function voucherLogin(req, res) {
  try {
    const { voucherCode, macAddress, ipAddress, deviceName } = req.body;

    if (!voucherCode || !macAddress) {
      return res.status(400).json({ message: 'Voucher code and MAC address are required' });
    }

    const mac = macAddress.toUpperCase();
    const ip  = ipAddress || '';

    // Check device not blocked
    if (mac !== 'UNKNOWN') {
      const devRes = await pool.query(
        'SELECT blocked FROM devices WHERE mac_address = $1',
        [mac]
      );
      if (devRes.rows.length && devRes.rows[0].blocked) {
        return res.status(403).json({
          status:  'BLOCKED',
          message: 'This device has been blocked by the administrator',
        });
      }
    }

    // Validate & activate voucher
    const { voucher, reconnect, expiryTime } = await voucherService.validateVoucher({
      code:       voucherCode,
      macAddress: mac,
      ipAddress:  ip,
      deviceName: deviceName || 'Unknown Device',
    });

    // Create session
    let session;
    if (!reconnect) {
      session = await sessionService.createSession({
        voucherCode:  voucher.code,
        macAddress:   mac,
        ipAddress:    ip,
        deviceName:   deviceName || 'Unknown Device',
        expiryTime,
      });
    }

    // ── DIRECTLY tell MikroTik to allow internet — no polling, no relay ─────
    let mikrotikResult = { success: false };
    if (mac === 'UNKNOWN' || !mac) {
      console.warn('[MikroTik] ⚠ MAC is UNKNOWN — skipping.');
    } else {
      const profile = getMikroTikProfile(voucher.plan_name);
      console.log(`[MikroTik] Allowing: ${mac} | IP: ${ip} | Profile: ${profile}`);
      mikrotikResult = await mikrotik.loginUser({
        mac,
        ip,
        profile,
        comment: `SKYLINK-${voucher.code}`,
      });
    }

    return res.json({
      status:      'ACTIVE',
      sessionId:   session?.session_id || 'reconnect',
      voucherCode: voucher.code,
      plan:        voucher.plan_name,
      expiryTime,
      startTime:   voucher.start_time || new Date().toISOString(),
      reconnect,
      macAddress:  mac,
      ipAddress:   ip,
      internetUnlocked: mikrotikResult.success,
      message:     reconnect ? 'Reconnected successfully' : 'Connected successfully',
    });

  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error('voucherLogin error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── Map plan name → MikroTik User Profile name ───────────────────────────────
function getMikroTikProfile(planName) {
  // IMPORTANT: these must match EXACTLY what /ip hotspot user profile print
  // shows on the router — verified against actual MikroTik config:
  //   1H-500, 1D-1000 (note: ONE, not capital I), 1W-7000, 30D-30000
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

// ── POST /api/auth/heartbeat ─────────────────────────────────────────────────
async function heartbeat(req, res) {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ message: 'sessionId required' });

    const session = await sessionService.heartbeat({ sessionId });
    if (!session) {
      return res.status(410).json({ status: 'EXPIRED', message: 'Session has expired' });
    }

    const remaining = Math.max(0, new Date(session.expiry_time) - new Date());
    return res.json({
      status:      'ACTIVE',
      sessionId,
      expiryTime:  session.expiry_time,
      remainingMs: remaining,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── GET /api/admin/vouchers ───────────────────────────────────────────────────
async function getVouchers(req, res) {
  try {
    const { status, plan, search, page, limit } = req.query;
    const vouchers = await voucherService.getVouchers({ status, plan, search, page, limit });
    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'unused')  AS unused,
        COUNT(*) FILTER (WHERE status = 'active')  AS active,
        COUNT(*) FILTER (WHERE status = 'expired') AS expired,
        COUNT(*) AS total
      FROM vouchers
    `);
    return res.json({ vouchers, counts: counts.rows[0] });
  } catch (err) {
    console.error('getVouchers error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── POST /api/admin/vouchers/generate ────────────────────────────────────────
async function generateVouchers(req, res) {
  try {
    const { planId, quantity, prefix } = req.body;
    if (!planId || !quantity) {
      return res.status(400).json({ message: 'planId and quantity are required' });
    }
    if (quantity > 500) {
      return res.status(400).json({ message: 'Maximum 500 vouchers per batch' });
    }
    const vouchers = await voucherService.generateVouchers({
      planId:   parseInt(planId),
      quantity: parseInt(quantity),
      prefix:   prefix || 'SKY',
      adminId:  req.admin.adminId,
    });
    return res.status(201).json({
      message:  `${vouchers.length} vouchers generated successfully`,
      vouchers,
    });
  } catch (err) {
    if (err.message === 'Plan not found') return res.status(404).json({ message: err.message });
    console.error('generateVouchers error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── PUT /api/admin/vouchers/:code/reset ──────────────────────────────────────
async function resetVoucher(req, res) {
  try {
    await voucherService.resetVoucher({ code: req.params.code, adminId: req.admin.adminId });
    return res.json({ message: 'Voucher reset successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── DELETE /api/admin/vouchers/:code ─────────────────────────────────────────
async function deleteVoucher(req, res) {
  try {
    await voucherService.deleteVoucher({ code: req.params.code, adminId: req.admin.adminId });
    return res.json({ message: 'Voucher deleted successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  voucherLogin,
  heartbeat,
  getVouchers,
  generateVouchers,
  resetVoucher,
  deleteVoucher,
};