/**
 * SKYLINK NET — Backend Server
 * Deployed on Render, database on Supabase
 */

require('dotenv').config();

const path      = require('path');
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const routes  = require('./routes');
const { startExpiryJob } = require('./jobs/expiryJob');

const app  = express();
const PORT = process.env.PORT || 3000; // Render sets PORT automatically

// ── Trust proxy ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
// Disable CSP so the portal page's inline scripts/styles work without issue
app.use(helmet({ contentSecurityPolicy: false }));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowAllOrigins = (process.env.ALLOWED_ORIGINS || '*').trim() === '*';
const envOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (allowAllOrigins) return callback(null, true);
    if (!origin) return callback(null, true);
    if (envOrigins.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── HTTP logging ──────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('[:date[iso]] :method :url :status :response-time ms'));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60*1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 300,
  message: { message: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const authLimiter = rateLimit({
  windowMs: 60*1000,
  max: 20,
  message: { message: 'Too many login attempts. Please wait 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/admin-login',   authLimiter);
app.use('/api/auth/voucher-login', authLimiter);

// ═════════════════════════════════════════════════════════════════════════════
//  CAPTIVE PORTAL — full page served here
//  MikroTik's tiny login.html redirects here WITH real ?mac=&ip=&dst=
//  (MikroTik substitutes $(mac)/$(ip) correctly during its own redirect,
//   even though it won't substitute them in a directly-served static file)
// ═════════════════════════════════════════════════════════════════════════════
app.use('/portal', express.static(path.join(__dirname, '..', 'public')));

app.get('/portal', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'portal.html'));
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ name: 'SKYLINK NET Backend', version: '1.0.0', status: 'running' });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ message: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('  🚀  SKYLINK NET Backend started              ');
  console.log(`  📡  Port: ${PORT}                              `);
  console.log(`  🌐  Portal: /portal                           `);
  console.log(`  🌍  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  startExpiryJob();
});

module.exports = app;