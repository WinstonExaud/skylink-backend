const { body, validationResult } = require('express-validator');

// Helper — run validators and return errors
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      message: 'Validation failed',
      errors:  errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

// ── Voucher login validation ──────────────────────────────────────────────────
const validateVoucherLogin = [
  body('voucherCode')
    .trim()
    .notEmpty().withMessage('Voucher code is required')
    .isLength({ min: 3, max: 30 }).withMessage('Invalid voucher code format'),

  // MAC address — accept all real formats MikroTik sends:
  //   AA:BB:CC:DD:EE:FF  (colon separated)
  //   AA-BB-CC-DD-EE-FF  (dash separated)
  //   AABBCCDDEEFF       (no separator)
  //   UNKNOWN            (browser testing before MikroTik injects it)
  body('macAddress')
    .trim()
    .notEmpty().withMessage('MAC address is required')
    .matches(
      /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{12}$|^UNKNOWN$/i
    )
    .withMessage('Invalid MAC address format'),

  // IP is fully optional — MikroTik may or may not inject it
  body('ipAddress')
    .optional({ checkFalsy: true })
    .isIP().withMessage('Invalid IP address'),

  validate,
];

// ── Admin login validation ────────────────────────────────────────────────────
const validateAdminLogin = [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
  validate,
];

// ── Generate vouchers validation ──────────────────────────────────────────────
const validateGenerateVouchers = [
  body('planId').isInt({ min: 1 }).withMessage('Valid plan ID is required'),
  body('quantity').isInt({ min: 1, max: 500 }).withMessage('Quantity must be 1–500'),
  body('prefix').optional().trim().isLength({ max: 8 }).withMessage('Prefix max 8 chars'),
  validate,
];

module.exports = {
  validateVoucherLogin,
  validateAdminLogin,
  validateGenerateVouchers,
};