'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
db.open();
const { handleApi, send } = require('./lib/http');
const auth = require('./lib/auth');
require('./modules/auth');
require('./modules/admin');
require('./modules/customers');
require('./modules/billing');
require('./modules/ops');
require('./modules/reports');
require('./modules/portal');
require('./modules/channels');
require('./modules/waterpoints');
require('./modules/insights');
require('./modules/community');
require('./modules/growth');
require('./modules/service');
require('./modules/i18n');
require('./modules/operations');
require('./modules/wsp');
require('./services/alerts').ensureRules();

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=()'
};
const tls = process.env.TLS_CERT && process.env.TLS_KEY;
if (tls) SEC['Strict-Transport-Security'] = 'max-age=31536000';

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/t/')) p = '/transparency.html';
  else if (p === '/status' || p === '/status/') p = '/status.html'; // public community status & reporting page // public donor/transparency page (token read by the page)
  else if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || p === '/sw.js' ? 'no-cache' : p.startsWith('/vendor/') ? 'public, max-age=604800' : 'public, max-age=300', ...SEC });
    res.end(buf);
  });
}

function handler(req, res) {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  if (req.url.startsWith('/api/')) return handleApi(req, res, auth);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res);
}

const PORT = Number(process.env.PORT || (db.MODE === 'live' ? 8443 : 3000));
const server = tls ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler) : http.createServer(handler);
server.requestTimeout = 120000;
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  const users = db.get('SELECT COUNT(*) n FROM users').n;
  console.log(`\n  AquaTrack — Smart Water Supply & Meter Management`);
  console.log(`  Mode: ${db.MODE.toUpperCase()}   Database: ${db.DB_FILE}`);
  console.log(`  Listening on ${tls ? 'https' : 'http'}://localhost:${PORT}`);
  if (!tls) console.log('  NOTE: serve behind an HTTPS reverse proxy (or set TLS_CERT/TLS_KEY) before real use.');
  if (!users) console.log(db.MODE === 'demo' ? '  No users yet — run "npm run seed-demo" first.' : '  No users yet — run "npm run create-admin" to create the first administrator.');
});

// Daily automatic backup + overdue refresh (tolerant of restarts: checks every hour).
function housekeeping() {
  try {
    const last = db.setting('last_auto_backup', '');
    const today = new Date().toISOString().slice(0, 10);
    if (last !== today && db.get('SELECT COUNT(*) n FROM users').n) {
      const f = db.backup('auto');
      db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'last_auto_backup', today);
      console.log('  Auto backup:', f);
    }
    require('./services/billing').refreshAllBills();
    if (db.setting('last_reminders_run', '') !== today && db.setting('auto_reminders', '1') === '1' && db.get('SELECT COUNT(*) n FROM users').n) {
      const r = require('./services/collections').runReminders({ actor: 'scheduler' }); console.log('  Reminders:', JSON.stringify(r));
    }
    if (db.setting('maint_auto_wo', '1') === '1' && String(db.setting('last_maint_run', '')).slice(0, 10) !== today && db.get('SELECT COUNT(*) n FROM users').n) { const r = require('./services/maintenance').runDue({}); if (r.created.length) console.log('  Maintenance work orders:', r.created.length); }
    if (String(db.setting('last_wsp_run', '')).slice(0, 10) !== today && db.get('SELECT 1 FROM wsp_hazards LIMIT 1')) { const r = require('./services/wsp').runDaily({}); if (r.raised) console.log('  Water safety checks overdue:', r.raised); }
    const ph = db.setting('briefing_sms_phone', '');
    if (ph && db.setting('last_briefing_sms', '') !== today && new Date().getUTCHours() >= 7) {
      const labs = require('./services/labs'); require('./services/channels').send(ph, labs.briefingSms(labs.briefing()), { purpose: 'briefing' });
      db.run(`INSERT INTO settings(key,value) VALUES('last_briefing_sms',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, today);
    }
  } catch (e) { console.error('housekeeping error', e.message); }
}
setTimeout(housekeeping, 5000);
// Supply-time SMS heads-up: checked every 10 minutes so each window is announced in good time.
function supplyTick() { try { if (db.get('SELECT COUNT(*) n FROM users').n) { const r = require('./services/supply').runHeadsUp({}); if (r.windows) console.log('  Supply heads-up:', JSON.stringify(r)); } } catch (e) { console.error('supply heads-up error', e.message); } }
setTimeout(supplyTick, 8000); setInterval(supplyTick, 600e3).unref();
setInterval(housekeeping, 3600e3).unref();

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
module.exports = server;
