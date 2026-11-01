'use strict';
// Append-only, hash-chained audit log. Any edit/deletion of past rows breaks the chain and is detected by verify().
const crypto = require('crypto');
const db = require('./db');

function log(ctx, action, entity, entityId, details) {
  const u = ctx && ctx.user;
  const last = db.get('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const prev = last ? last.hash : 'GENESIS';
  const at = new Date().toISOString();
  const rec = { at, user_id: u ? u.id : null, username: u ? u.username : (ctx && ctx.actor) || 'system', role: u ? u.role : 'system',
    action, entity: entity || null, entity_id: entityId == null ? null : String(entityId), details: details ? JSON.stringify(details) : null, ip: ctx && ctx.ip || null };
  const hash = crypto.createHash('sha256').update(prev + JSON.stringify(rec)).digest('hex');
  db.run('INSERT INTO audit_log(at,user_id,username,role,action,entity,entity_id,details,ip,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    rec.at, rec.user_id, rec.username, rec.role, rec.action, rec.entity, rec.entity_id, rec.details, rec.ip, prev, hash);
}

function verify() {
  let prev = 'GENESIS'; let n = 0;
  for (const r of db.all('SELECT * FROM audit_log ORDER BY id')) {
    const rec = { at: r.at, user_id: r.user_id, username: r.username, role: r.role, action: r.action, entity: r.entity, entity_id: r.entity_id, details: r.details, ip: r.ip };
    const h = crypto.createHash('sha256').update(prev + JSON.stringify(rec)).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, broken_at_id: r.id, checked: n };
    prev = h; n++;
  }
  return { ok: true, checked: n };
}

module.exports = { log, verify };
