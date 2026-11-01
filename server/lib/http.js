'use strict';
// Minimal dependency-free router with JSON handling, auth + permission enforcement.
const { URL } = require('url');

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const routes = [];
function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  return { re, keys };
}
/** route(method, path, { perm | perms | public | auth }, handler(ctx)) */
function route(method, pattern, opts, handler) {
  const { re, keys } = compile(pattern);
  routes.push({ method, pattern, re, keys, opts: opts || {}, handler });
}
function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { r, params };
    }
  }
  return null;
}

const MAX_BODY = 12 * 1024 * 1024; // photos (base64) and CSV imports
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

async function handleApi(req, res, auth) {
  const url = new URL(req.url, 'http://localhost');
  const found = match(req.method, url.pathname);
  if (!found) return send(res, 404, { error: 'Not found' });
  const { r, params } = found;
  const ctx = {
    req, res, params, query: Object.fromEntries(url.searchParams), body: {},
    ip: clientIp(req)
  };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // CSRF defence: browsers cannot set this header cross-site without CORS (which we never enable).
      if (!r.opts.machine && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Missing request header');
      const raw = await readBody(req);
      if (raw && r.opts.machine && /application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) {
        ctx.body = Object.fromEntries(new URLSearchParams(raw)); // USSD/SMS aggregators commonly post form data
      } else if (raw) {
        try { ctx.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
        if (typeof ctx.body !== 'object' || ctx.body === null || Array.isArray(ctx.body) && !r.opts.arrayBody) throw new HttpError(400, 'JSON object expected');
      }
    }
    if (!r.opts.public && !r.opts.machine) {
      ctx.user = auth.userFromRequest(req);
      if (!ctx.user) throw new HttpError(401, 'Please sign in');
      if (ctx.user.must_change_password && !r.opts.allowPwChange) throw new HttpError(403, 'Password change required', { code: 'PASSWORD_CHANGE_REQUIRED' });
      if (ctx.user.needs_2fa_setup && !r.opts.allowPwChange) throw new HttpError(403, 'Your role requires two-factor sign-in. Set it up to continue.', { code: 'TWO_FACTOR_SETUP_REQUIRED' });
      const need = r.opts.perm ? [r.opts.perm] : (r.opts.anyPerm || []);
      if (need.length && !need.some(p => auth.can(ctx.user, p))) throw new HttpError(403, 'Your role is not allowed to do this');
    }
    const out = await r.handler(ctx);
    if (out === undefined) { if (!res.headersSent) send(res, 204, ''); return; }
    if (out && out.__raw) return send(res, 200, out.body, out.headers);
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, details: e.details });
    const msg = String(e && e.message || e);
    if (/immutable|cannot be deleted|append-only/.test(msg)) return send(res, 409, { error: msg.replace(/^.*?: /, '') });
    if (/UNIQUE constraint failed: (\w+)\.(\w+)/.test(msg)) {
      const m = msg.match(/UNIQUE constraint failed: (\w+)\.(\w+)/);
      return send(res, 409, { error: `A record with this ${m[2].replace(/_/g, ' ')} already exists` });
    }
    if (/CHECK constraint failed|FOREIGN KEY/.test(msg)) return send(res, 400, { error: 'Invalid value: ' + msg });
    console.error('[api error]', req.method, url.pathname, e);
    send(res, 500, { error: 'Internal server error' });
  }
}

/**
 * The visitor's IP address, used for sign-in throttling and limits on public forms.
 * Forwarding headers can be forged by anyone, so they are trusted only when TRUST_PROXY says a proxy is in front
 * AND the request actually arrives from that proxy on this machine (loopback):
 *   TRUST_PROXY=cloudflare  → CF-Connecting-IP (Cloudflare Tunnel / cloudflared on the same server)
 *   TRUST_PROXY=1           → first X-Forwarded-For entry (e.g. Caddy or nginx on the same server)
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientIp(req) {
  const remote = req.socket.remoteAddress; const mode = String(process.env.TRUST_PROXY || '').toLowerCase();
  if (!mode || mode === '0' || !LOOPBACK.has(remote)) return remote;
  if (mode === 'cloudflare') return String(req.headers['cf-connecting-ip'] || '').trim() || remote;
  return (String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || remote;
}
function csvResponse(filename, text) {
  return { __raw: true, body: '﻿' + text, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` } };
}

module.exports = { route, routes, handleApi, HttpError, send, csvResponse, clientIp };
