const express  = require('express');
const path     = require('path');
const rateLimit = require('express-rate-limit');
const helmet   = require('helmet');
const handler  = require('./api/index');

const app = express();

// ── Security headers (disables CSP so inline scripts work) ──────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── Body parsing ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting on API ─────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                  // 300 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please slow down and try again.' },
});

// ── Health check ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Portal landing page (root entry point) ───────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// ── FYP system (served at /fyp) ──────────────────────────────────────────
app.get('/fyp', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Static files (js, css, images, html pages) ───────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Named routes for special pages ──────────────────────────────────────
app.get('/examiner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'examiner.html')));
app.get('/peer',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'peer.html')));

// ── ECE Department Resources ─────────────────────────────────────────────
app.get('/ece-resources',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'ece-resources', 'index.html')));
app.get('/ece-resources/epme', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ece-resources', 'epme', 'index.html')));
app.get('/ece-resources/cee',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'ece-resources', 'cee',  'index.html')));
app.get('/ece-resources/ce',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'ece-resources', 'ce',   'index.html')));
app.get('/ece-resources/bme',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'ece-resources', 'bme',  'index.html')));

// ── API ───────────────────────────────────────────────────────────────────
app.post('/api', apiLimiter, handler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FYP server running on port ${PORT}`));
