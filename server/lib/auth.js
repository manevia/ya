'use strict';
const crypto = require('crypto');
const db = require('./db');

// ---- Role-based permissions -------------------------------------------------
const P = {
  admin: ['*'],
  manager: ['dashboard.view', 'reports.view', 'customers.view', 'meters.view', 'readings.view', 'readings.review',
    'billing.view', 'adjustments.approve', 'alerts.view', 'alerts.manage', 'alerts.run', 'workorders.view', 'workorders.manage',
    'assets.view', 'telemetry.enter', 'supply.enter', 'audit.view', 'notices.manage', 'integrations.view', 'areas.view', 'tariffs.view', 'users.view',
    'channels.view', 'channels.simulate', 'momo.view', 'momo.match', 'wp.view', 'wp.manage', 'wp.wallets', 'nrw.view', 'share.manage',
    'wq.view', 'wq.record', 'collections.view', 'collections.manage', 'plans.manage', 'reminders.run', 'tariff.lab', 'briefing.view',
    'connections.view', 'connections.manage', 'kpi.view', 'kpi.manage', 'onboarding.import', 'shared.manage',
    'supply.view', 'supply.manage', 'supply.log', 'stock.view', 'stock.manage', 'stock.issue', 'fleet.view', 'feedback.view',
    'maintenance.view', 'maintenance.manage', 'servicelevels.view', 'cash.close', 'cash.review', 'wsp.view', 'wsp.manage', 'wsp.monitor', 'wsp.inspect'],
  meter_reader: ['field.read', 'readings.create', 'readings.view_own', 'customers.lookup', 'meters.view'],
  technician: ['workorders.view', 'workorders.update', 'alerts.view', 'assets.view', 'assets.inspect', 'telemetry.enter',
    'meters.view', 'meters.status', 'customers.lookup', 'users.view', 'wq.view', 'wq.record', 'connections.view', 'supply.view', 'supply.log', 'stock.view', 'stock.issue', 'maintenance.view', 'wsp.view', 'wsp.monitor', 'wsp.inspect'],
  cashier: ['customers.view', 'customers.manage', 'meters.view', 'readings.view', 'readings.review', 'readings.import', 'readings.create',
    'billing.view', 'billing.generate', 'payments.create', 'payments.reverse', 'adjustments.create', 'reports.view', 'areas.view', 'tariffs.view', 'dashboard.view',
    'channels.view', 'channels.simulate', 'momo.view', 'momo.match', 'momo.import', 'wp.view', 'wp.wallets', 'collections.view', 'plans.manage', 'reminders.run', 'connections.view', 'connections.manage', 'onboarding.import', 'shared.manage', 'supply.view', 'cash.close'],
  customer: ['portal.self'],
  attendant: ['wp.sell', 'wq.record']
};
const ROLE_LABELS = { admin: 'System Administrator', manager: 'Utility Manager', meter_reader: 'Meter Reader', technician: 'Technician', cashier: 'Cashier / Billing Officer', customer: 'Customer', attendant: 'Water Point Attendant' };
function can(user, perm) {
  const list = P[user.role] || [];
  return list.includes('*') || list.includes(perm);
}
function permsFor(role) { return P[role] || []; }

// ---- Passwords (scrypt, salted) ---------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

// ---- Sessions --------------------------------------------------------------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hours = db.settingNum('session_hours', 12);
  const expires = new Date(Date.now() + hours * 3600e3).toISOString();
  db.run('INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
    sha(token), userId, expires, require('./http').clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  return { token, expires };
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function userFromRequest(req) {
  const tok = parseCookies(req).sid;
  if (!tok) return null;
  const row = db.get(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha(tok));
  if (!row || !row.active || row.expires_at < new Date().toISOString()) return null;
  delete row.password_hash;
  row.needs_2fa_setup = needs2fa(row);
  return row;
}
/** True when this user's role must use two-factor sign-in but they have not set it up yet. */
function needs2fa(u) { const roles = (db.setting('require_2fa_roles', '') || '').split(',').map(x => x.trim()).filter(Boolean); return roles.includes(u.role) && !u.totp_enabled; }
function destroySession(req) { const tok = parseCookies(req).sid; if (tok) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(tok)); }
function cookie(token, expires, secure) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${expires ? '; Expires=' + new Date(expires).toUTCString() : '; Max-Age=0'}`;
}
function publicUser(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, role_label: ROLE_LABELS[u.role], customer_id: u.customer_id,
    area_id: u.area_id, must_change_password: !!u.must_change_password, needs_2fa_setup: !!u.needs_2fa_setup, two_factor: !!u.totp_enabled, language: u.language || null, perms: permsFor(u.role) };
}

module.exports = { needs2fa, can, permsFor, hashPassword, verifyPassword, passwordProblem, createSession, userFromRequest, destroySession, cookie, publicUser, ROLE_LABELS, sha };
