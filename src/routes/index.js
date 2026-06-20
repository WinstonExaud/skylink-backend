const express = require('express');
const router  = express.Router();

const authController     = require('../controllers/authController');
const voucherController  = require('../controllers/voucherController');
const sessionController  = require('../controllers/sessionController');
const adminController    = require('../controllers/adminController');
const pollingController  = require('../controllers/pollingController');
const auth                = require('../middleware/authMiddleware');
const {
  validateVoucherLogin,
  validateAdminLogin,
  validateGenerateVouchers,
} = require('../middleware/validateVoucher');

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC  (no JWT required)
// ─────────────────────────────────────────────────────────────────────────────

router.post('/auth/admin-login',   validateAdminLogin, authController.adminLogin);
router.post('/auth/voucher-login', validateVoucherLogin, voucherController.voucherLogin);
router.post('/auth/heartbeat',     voucherController.heartbeat);

router.get('/health', (req, res) => res.json({
  status:  'OK',
  service: 'SKYLINK NET Backend',
  time:    new Date().toISOString(),
}));

// ─────────────────────────────────────────────────────────────────────────────
//  MIKROTIK SYNC  (called by local relay-service.js)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/mikrotik/pending', pollingController.getPending);

// ─────────────────────────────────────────────────────────────────────────────
//  PROTECTED  (JWT required)
// ─────────────────────────────────────────────────────────────────────────────

router.get ('/admin/me',              auth, authController.getMe);
router.put ('/admin/change-password', auth, authController.changePassword);

router.get('/admin/stats',         auth, adminController.getDashboardStats);
router.get('/admin/stats/revenue', auth, adminController.getRevenueChart);

router.get   ('/admin/vouchers',              auth, voucherController.getVouchers);
router.post  ('/admin/vouchers/generate',     auth, validateGenerateVouchers, voucherController.generateVouchers);
router.put   ('/admin/vouchers/:code/reset',  auth, voucherController.resetVoucher);
router.delete('/admin/vouchers/:code',        auth, voucherController.deleteVoucher);

router.get   ('/admin/sessions',             auth, sessionController.getSessions);
router.delete('/admin/sessions/:sessionId',  auth, sessionController.kickSession);

router.get('/admin/devices',              auth, adminController.getDevices);
router.put('/admin/devices/:mac/block',   auth, adminController.blockDevice);
router.put('/admin/devices/:mac/unblock', auth, adminController.unblockDevice);

router.get('/admin/logs', auth, adminController.getLogs);

router.get ('/admin/plans', auth, adminController.getPlans);
router.post('/admin/plans', auth, adminController.createPlan);

module.exports = router;