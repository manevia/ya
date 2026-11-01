'use strict';
// RFC 6238 TOTP (30 s, 6 digits, SHA-1 — the default every authenticator app supports) and AES-256-GCM secret encryption.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32decode(s) { const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = 0, val = 0; const out = []; for (const ch of clean) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function code(secretB32, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15; const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
const now = () => Math.floor(Date.now() / 30000);
/** Returns the matched time step, or null. Accepts ±1 step for clock drift. */
function verify(secretB32, input, lastStep = -1) {
  const c = String(input || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null;
  for (const d of [0, -1, 1]) { const st = now() + d; if (st <= lastStep) continue; const a = Buffer.from(code(secretB32, st)), b = Buffer.from(c); if (crypto.timingSafeEqual(a, b)) return st; }
  return null;
}
const newSecret = () => b32encode(crypto.randomBytes(20));

// ---- secret encryption at rest ----
let KEY = null;
function key() {
  if (KEY) return KEY;
  if (process.env.AQ_SECRET_KEY) { KEY = crypto.createHash('sha256').update(process.env.AQ_SECRET_KEY).digest(); return KEY; }
  const f = path.join(db.DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  KEY = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); return KEY;
}
function encrypt(text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]); return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); }
function decrypt(blob) { const raw = Buffer.from(String(blob).slice(3), 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'); }

module.exports = { code, verify, newSecret, b32encode, b32decode, encrypt, decrypt, now };
