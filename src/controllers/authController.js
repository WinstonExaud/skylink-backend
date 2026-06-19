const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const pool   = require('../config/db');

// ── Admin Login ───────────────────────────────────────────────────────────────
async function adminLogin(req, res) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    // Find admin
    const result = await pool.query(
      'SELECT * FROM admins WHERE username = $1',
      [username.trim().toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const admin = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      // Log failed attempt
      await pool.query(`
        INSERT INTO admin_logs (action, detail, ip_address)
        VALUES ('FAILED_LOGIN', $1, $2)
      `, [`Failed login attempt for username: ${username}`, req.ip]);

      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Sign JWT
    const token = jwt.sign(
      { adminId: admin.id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET || 'skylink_secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Log success
    await pool.query(`
      INSERT INTO admin_logs (admin_id, action, detail, ip_address)
      VALUES ($1, 'ADMIN_LOGIN', 'Successful login', $2)
    `, [admin.id, req.ip]);

    return res.json({
      message: 'Login successful',
      token,
      admin: {
        id:       admin.id,
        username: admin.username,
        role:     admin.role,
      },
    });

  } catch (err) {
    console.error('adminLogin error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── Get current admin ─────────────────────────────────────────────────────────
async function getMe(req, res) {
  try {
    const result = await pool.query(
      'SELECT id, username, role, created_at FROM admins WHERE id = $1',
      [req.admin.adminId]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'Admin not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── Change password ───────────────────────────────────────────────────────────
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    const result = await pool.query('SELECT * FROM admins WHERE id = $1', [req.admin.adminId]);
    const admin  = result.rows[0];

    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) return res.status(401).json({ message: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE admins SET password = $1 WHERE id = $2', [hash, admin.id]);

    await pool.query(`
      INSERT INTO admin_logs (admin_id, action, detail)
      VALUES ($1, 'CHANGE_PASSWORD', 'Admin changed password')
    `, [admin.id]);

    return res.json({ message: 'Password changed successfully' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { adminLogin, getMe, changePassword };
