'use strict';
const { route, HttpError } = require('../lib/http');
const { validate } = require('../lib/validate');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const db = require('../lib/db');

const attempts = new Map(); // per-IP throttle (in addition to per-account lockout)
const secure = () => process.env.COOKIE_SECURE === '1' || !!process.env.TLS_CERT;

route('POST', '/api/auth/login', { public: true }, ctx => {
  const now = Date.now();
  const a = attempts.get(ctx.ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
  if (a.n >= 20) throw new HttpError(429, 'Too many sign-in attempts from this device. Try again in 15 minutes.');
  const b = validate(ctx.body, { username: { type: 'string', required: true, max: 60 }, password: { type: 'string', required: true, max: 200 } });
  const u = db.get('SELECT * FROM users WHERE username = ?', b.username);
  const fail = msg => { a.n++; attempts.set(ctx.ip, a); throw new HttpError(401, msg || 'Incorrect username or password'); };
  if (!u || !u.active) { audit.log({ ...ctx, actor: b.username }, 'auth.login_failed', 'user', null, { username: b.username }); return fail(); }
  if (u.locked_until && u.locked_until > new Date().toISOString()) fail('Account temporarily locked after repeated failed sign-ins. Try again later or ask an administrator.');
  if (!auth.verifyPassword(b.password, u.password_hash)) {
    const n = u.failed_attempts + 1;
    db.run('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?', n, n >= 5 ? new Date(now + 15 * 60e3).toISOString() : null, u.id);
    audit.log({ ...ctx, actor: u.username }, 'auth.login_failed', 'user', u.id, { attempts: n });
    return fail();
  }
  if (u.totp_enabled) { // password was right; now require the authenticator code
    const ch = crypto.randomBytes(24).toString('base64url');
    challenges.set(ch, { user_id: u.id, exp: now + 5 * 60e3, tries: 0 });
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    return { two_factor_required: true, challenge: ch };
  }
  return finishLogin(ctx, u);
});

const crypto = require('crypto');
const totp = require('../lib/totp');
const challenges = new Map(); // short-lived second-factor challenges (5 min, 5 tries)
const lastStep = new Map();   // user_id → last accepted TOTP step (blocks code replay)
function finishLogin(ctx, u) {
  db.run('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=? WHERE id=?', new Date().toISOString(), u.id);
  db.run(`DELETE FROM sessions WHERE expires_at < ?`, new Date().toISOString());
  const s = auth.createSession(u.id, ctx.req);
  ctx.res.setHeader('Set-Cookie', auth.cookie(s.token, s.expires, secure()));
  audit.log({ ...ctx, user: u }, 'auth.login', 'user', u.id, { two_factor: !!u.totp_enabled });
  return { user: auth.publicUser({ ...u, needs_2fa_setup: auth.needs2fa(u) }), mode: db.MODE };
}
function checkSecondFactor(u, code) {
  const c = String(code || '').trim();
  if (/^\d{6}$/.test(c.replace(/\s/g, ''))) { const st = totp.verify(totp.decrypt(u.totp_secret), c, lastStep.get(u.id) ?? -1); if (st != null) { lastStep.set(u.id, st); return 'totp'; } return null; }
  const h = auth.sha(c.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const rc = db.get('SELECT * FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL', u.id, h);
  if (rc) { db.run(`UPDATE recovery_codes SET used_at=datetime('now') WHERE id=?`, rc.id); return 'recovery_code'; }
  return null;
}
route('POST', '/api/auth/login/2fa', { public: true }, ctx => {
  const b = validate(ctx.body, { challenge: { type: 'string', required: true, max: 64 }, code: { type: 'string', required: true, max: 20 } });
  const ch = challenges.get(b.challenge);
  if (!ch || ch.exp < Date.now()) { challenges.delete(b.challenge); throw new HttpError(401, 'Sign-in expired — enter your password again'); }
  const u = db.get('SELECT * FROM users WHERE id=?', ch.user_id);
  const how = u && u.active ? checkSecondFactor(u, b.code) : null;
  if (!how) { ch.tries++; audit.log({ ...ctx, actor: u && u.username }, 'auth.2fa_failed', 'user', ch.user_id, { tries: ch.tries }); if (ch.tries >= 5) challenges.delete(b.challenge); throw new HttpError(401, 'Code not accepted'); }
  challenges.delete(b.challenge);
  if (how === 'recovery_code') audit.log({ ...ctx, user: u }, 'auth.recovery_code_used', 'user', u.id, { remaining: db.get('SELECT COUNT(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL', u.id).n });
  return finishLogin(ctx, u);
});

// ---- Two-factor setup (works even while setup is being enforced) ----
route('GET', '/api/auth/2fa', { allowPwChange: true }, ctx => ({ enabled: !!ctx.user.totp_enabled, required: auth.needs2fa({ ...ctx.user, totp_enabled: 1 }) || (db.setting('require_2fa_roles', '') || '').split(',').map(x => x.trim()).includes(ctx.user.role),
  recovery_codes_left: db.get('SELECT COUNT(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NULL', ctx.user.id).n }));
route('POST', '/api/auth/2fa/setup', { allowPwChange: true }, ctx => {
  if (ctx.user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on. Turn it off first to re-register.');
  const secret = totp.newSecret();
  db.run('UPDATE users SET totp_secret=? WHERE id=?', totp.encrypt(secret), ctx.user.id);
  const issuer = encodeURIComponent((db.setting('org_name') || 'AquaTrack').replace(/[:()]/g, '').slice(0, 40));
  return { secret, otpauth: `otpauth://totp/${issuer}:${encodeURIComponent(ctx.user.username)}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
});
route('POST', '/api/auth/2fa/enable', { allowPwChange: true }, ctx => {
  const b = validate(ctx.body, { code: { type: 'string', required: true, max: 10 } });
  const u = db.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!u.totp_secret) throw new HttpError(400, 'Start setup first');
  const st = totp.verify(totp.decrypt(u.totp_secret), b.code); if (st == null) throw new HttpError(400, 'Code not accepted — check the time on your phone and try again');
  lastStep.set(u.id, st);
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})(.{5})/, '$1-$2'));
  db.run('DELETE FROM recovery_codes WHERE user_id=?', u.id);
  for (const c of codes) db.run('INSERT INTO recovery_codes(user_id, code_hash) VALUES (?,?)', u.id, auth.sha(c.replace(/-/g, '')));
  db.run('UPDATE users SET totp_enabled=1 WHERE id=?', u.id);
  audit.log(ctx, 'auth.2fa_enabled', 'user', u.id);
  return { enabled: true, recovery_codes: codes, note: 'Store these one-time recovery codes somewhere safe. Each works once if you lose your phone.' };
});
route('POST', '/api/auth/2fa/disable', { allowPwChange: true }, ctx => {
  const b = validate(ctx.body, { password: { type: 'string', required: true, max: 200 }, code: { type: 'string', required: true, max: 20 } });
  const u = db.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!u.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is not on');
  if (!auth.verifyPassword(b.password, u.password_hash) || !checkSecondFactor(u, b.code)) throw new HttpError(400, 'Password or code not accepted');
  if ((db.setting('require_2fa_roles', '') || '').split(',').map(x => x.trim()).includes(u.role)) throw new HttpError(409, 'Your role requires two-factor sign-in');
  db.run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', u.id); db.run('DELETE FROM recovery_codes WHERE user_id=?', u.id);
  audit.log(ctx, 'auth.2fa_disabled', 'user', u.id); return { ok: true };
});

// ---- Sessions (sign out other devices) ----
route('GET', '/api/auth/sessions', { allowPwChange: true }, ctx => {
  const cur = auth.sha(String(ctx.req.headers.cookie || '').match(/sid=([^;]+)/)?.[1] || '');
  return db.all(`SELECT token_hash, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id=? AND expires_at > ? ORDER BY created_at DESC`, ctx.user.id, new Date().toISOString())
    .map(s => ({ id: s.token_hash.slice(0, 16), created_at: s.created_at, expires_at: s.expires_at, ip: s.ip, device: s.user_agent, current: s.token_hash === cur }));
});
route('POST', '/api/auth/sessions/:id/revoke', { allowPwChange: true }, ctx => {
  const r = db.run(`DELETE FROM sessions WHERE user_id=? AND substr(token_hash,1,16)=?`, ctx.user.id, String(ctx.params.id).slice(0, 16));
  audit.log(ctx, 'auth.session_revoked', 'user', ctx.user.id, { session: ctx.params.id }); return { revoked: r.changes };
});
route('POST', '/api/auth/sessions/revoke-others', { allowPwChange: true }, ctx => {
  const cur = auth.sha(String(ctx.req.headers.cookie || '').match(/sid=([^;]+)/)?.[1] || '');
  const r = db.run('DELETE FROM sessions WHERE user_id=? AND token_hash != ?', ctx.user.id, cur);
  audit.log(ctx, 'auth.sessions_revoked', 'user', ctx.user.id, { count: r.changes }); return { revoked: r.changes };
});

route('POST', '/api/auth/logout', { public: true }, ctx => {
  auth.destroySession(ctx.req);
  ctx.res.setHeader('Set-Cookie', auth.cookie('', null, secure()));
  return { ok: true };
});

route('GET', '/api/auth/me', { allowPwChange: true }, ctx => ({ user: auth.publicUser(ctx.user), mode: db.MODE, org_name: db.setting('org_name'), config: require('../lib/i18n').publicConfig(),
  settings: { gps_capture_enabled: db.setting('gps_capture_enabled') === '1', photo_required: db.setting('photo_required') === '1' } }));

route('POST', '/api/auth/change-password', { allowPwChange: true }, ctx => {
  const b = validate(ctx.body, { current_password: { type: 'string', required: true, max: 200 }, new_password: { type: 'string', required: true, max: 200 } });
  const u = db.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!auth.verifyPassword(b.current_password, u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  const p = auth.passwordProblem(b.new_password); if (p) throw new HttpError(400, p);
  if (b.new_password === b.current_password) throw new HttpError(400, 'New password must be different');
  db.run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', auth.hashPassword(b.new_password), u.id);
  db.run('DELETE FROM sessions WHERE user_id=? AND token_hash != ?', u.id, auth.sha(String(ctx.req.headers.cookie || '').match(/sid=([^;]+)/)?.[1] || ''));
  audit.log(ctx, 'auth.change_password', 'user', u.id);
  return { ok: true };
});

route('GET', '/api/health', { public: true }, () => ({ ok: true, mode: db.MODE, time: new Date().toISOString() }));
