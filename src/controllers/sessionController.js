const sessionService = require('../services/sessionService');
const pool           = require('../config/db');

// ── GET /api/admin/sessions ───────────────────────────────────────────────────
async function getSessions(req, res) {
  try {
    const { status, search, page, limit } = req.query;
    const sessions = await sessionService.getSessions({ status, search, page, limit });
    return res.json({ sessions });
  } catch (err) {
    console.error('getSessions error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
}

// ── DELETE /api/admin/sessions/:sessionId  (kick user) ───────────────────────
async function kickSession(req, res) {
  try {
    await sessionService.kickSession({
      sessionId: req.params.sessionId,
      adminId:   req.admin.adminId,
    });
    return res.json({ message: 'User disconnected successfully' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return res.status(500).json({ message: 'Server error' });
  }
}

module.exports = { getSessions, kickSession };
