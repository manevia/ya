'use strict';
const { route, HttpError } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const audit = require('../lib/audit');
const db = require('../lib/db');
const insights = require('../services/insights');

const dflt = q => ({ from: /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.now() - 182 * 86400e3).toISOString().slice(0, 10),
  to: /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : new Date().toISOString().slice(0, 10), area_id: q.area_id ? Number(q.area_id) : null });
route('GET', '/api/nrw/balance', { anyPerm: ['nrw.view', 'dashboard.view'] }, ctx => { const f = dflt(ctx.query); return { ...f, areas: insights.waterBalance(f) }; });
route('GET', '/api/nrw/suspicious', { perm: 'nrw.view' }, ctx => insights.suspiciousAccounts({ area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null }));

route('GET', '/api/share-links', { perm: 'share.manage' }, () => db.all(`SELECT l.id, l.title, l.area_ids, l.months, l.active, l.views, l.created_at, l.revoked_at, u.full_name created_by_name FROM share_links l LEFT JOIN users u ON u.id=l.created_by ORDER BY l.id DESC`));
route('POST', '/api/share-links', { perm: 'share.manage' }, ctx => {
  const b = validate(ctx.body, { title: { type: 'string', required: true, max: 120 }, area_ids: { type: 'array', max: 50 }, months: { type: 'integer', minVal: 1, maxVal: 36, default: 6 } });
  const ids = (b.area_ids || []).map(Number).filter(Number.isInteger);
  const t = insights.newToken();
  const r = db.run('INSERT INTO share_links(token_hash, title, area_ids, months, created_by) VALUES (?,?,?,?,?)', t.hash, b.title, ids.length ? JSON.stringify(ids) : null, b.months, ctx.user.id);
  audit.log(ctx, 'share.create', 'share_link', r.id, { title: b.title, areas: ids, months: b.months });
  return { id: r.id, url: `/t/${t.token}`, note: 'Anyone with this link can see the aggregated figures. Copy it now — it is shown only once.' };
});
route('POST', '/api/share-links/:id/revoke', { perm: 'share.manage' }, ctx => {
  const lid = id(ctx.params.id);
  db.run(`UPDATE share_links SET active=0, revoked_at=datetime('now') WHERE id=?`, lid);
  audit.log(ctx, 'share.revoke', 'share_link', lid); return { ok: true };
});
// Public, unauthenticated, aggregate-only.
const hits = new Map();
route('GET', '/api/public/:token', { public: true }, ctx => {
  const now = Date.now(); const h = hits.get(ctx.ip) || { n: 0, t: now }; if (now - h.t > 60e3) { h.n = 0; h.t = now; } h.n++; hits.set(ctx.ip, h);
  if (h.n > 60) throw new HttpError(429, 'Too many requests');
  const link = insights.linkByToken(ctx.params.token);
  if (!link) throw new HttpError(404, 'This link is not valid or has been revoked');
  db.run('UPDATE share_links SET views = views + 1 WHERE id=?', link.id);
  return insights.publicStats(link);
});
