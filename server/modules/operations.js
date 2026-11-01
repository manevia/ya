'use strict';
// Preventive maintenance & functionality, service levels (SDG 6.1), cashier end-of-day close.
const { route, HttpError, csvResponse } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const db = require('../lib/db');
const csv = require('../lib/csv');
const tz = require('../lib/tz');
const mt = require('../services/maintenance');
const sl = require('../services/servicelevels');
const cc = require('../services/cashclose');

const dateRange = (q, days = 90) => { const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : tz.localDate(); const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.parse(to) - (days - 1) * 86400e3).toISOString().slice(0, 10); return { from, to }; };
const demoTag = () => (db.MODE === 'demo' ? '_DEMO' : '');

// ================= Preventive maintenance =================
const planSchema = { asset_id: { type: 'integer', required: true }, title: { type: 'string', required: true, max: 120 }, tasks: { type: 'text', max: 2000 }, interval_days: { type: 'integer', minVal: 1, maxVal: 3650 },
  interval_hours: { type: 'number', minVal: 1, maxVal: 100000 }, lead_days: { type: 'integer', minVal: 0, maxVal: 90, default: 7 }, priority: { type: 'enum', values: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  last_done_at: { type: 'date' }, last_done_hours: { type: 'number', minVal: 0 }, active: { type: 'boolean', default: true } };
route('GET', '/api/maintenance', { perm: 'maintenance.view' }, ctx => ({ plans: mt.plans({ asset_id: ctx.query.asset_id ? Number(ctx.query.asset_id) : null }), last_run: db.setting('last_maint_run', null), auto: db.setting('maint_auto_wo', '1') === '1' }));
route('POST', '/api/maintenance/plans', { perm: 'maintenance.manage' }, ctx => { const b = validate(ctx.body, planSchema); if (b.last_done_at) b.last_done_at += 'T12:00:00.000Z'; return mt.savePlan(ctx, null, b); });
route('PUT', '/api/maintenance/plans/:id', { perm: 'maintenance.manage' }, ctx => { const b = validate(ctx.body, planSchema); if (b.last_done_at && b.last_done_at.length === 10) b.last_done_at += 'T12:00:00.000Z'; return mt.savePlan(ctx, id(ctx.params.id), b); });
route('POST', '/api/maintenance/run', { perm: 'maintenance.manage' }, ctx => mt.runDue(ctx));
route('GET', '/api/assets/:id/run-hours', { anyPerm: ['assets.view', 'maintenance.view'] }, ctx => ({ rows: db.all('SELECT r.*, u.full_name user_name FROM run_hours r LEFT JOIN users u ON u.id=r.user_id WHERE asset_id=? ORDER BY recorded_at DESC, id DESC LIMIT 100', id(ctx.params.id)),
  rate_per_day: mt.rateOf(id(ctx.params.id)), plans: mt.plans({ asset_id: id(ctx.params.id) }) }));
route('POST', '/api/assets/:id/run-hours', { anyPerm: ['telemetry.enter', 'maintenance.manage'] }, ctx => mt.addHours(ctx, id(ctx.params.id), validate(ctx.body, { reading: { type: 'number', required: true, minVal: 0, maxVal: 1e7 }, recorded_at: { type: 'datetime' }, note: { type: 'string', max: 300 }, reset: { type: 'boolean', default: false } })));
route('GET', '/api/functionality', { anyPerm: ['maintenance.view', 'assets.view'] }, ctx => {
  const r = mt.functionality({ ...dateRange(ctx.query), area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null, asset_type: ctx.query.asset_type || null });
  if (ctx.query.format === 'csv') return csvResponse(`functionality_${r.from}_${r.to}${demoTag()}.csv`, csv.stringify(r.rows.map(x => ({ code: x.code, name: x.name, type: x.asset_type, area: x.area, status_now: x.status, functional_pct: x.functional_pct, downtime_hours: x.downtime_hours, breakdowns: x.breakdowns, median_repair_hours: x.median_repair_hours })), null, [`# Asset functionality ${r.from} to ${r.to} (functional = operational or degraded)`, db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA']));
  return r;
});

// ================= Service levels (SDG 6.1 / JMP) =================
route('GET', '/api/service-levels', { perm: 'servicelevels.view' }, ctx => {
  const r = sl.estimate({ ...dateRange(ctx.query), area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null });
  if (ctx.query.format === 'csv') {
    const rows = []; for (const a of r.areas) for (const [k, v] of Object.entries(a.levels)) rows.push({ area: a.area, service_level: k, people: v.people, pct_of_served: v.pct_of_served, pct_of_population: v.pct_of_population, area_population: a.population });
    return csvResponse(`service-levels_${r.from}_${r.to}${demoTag()}.csv`, csv.stringify(rows, null, [`# Drinking-water service levels (JMP ladder) — ESTIMATES ${r.from} to ${r.to}`, '# ' + r.method, db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA']));
  }
  return r;
});

// ================= Cashier end-of-day close =================
route('GET', '/api/cash/my', { perm: 'cash.close' }, ctx => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.date || '') ? ctx.query.date : tz.localDate();
  return { ...cc.expected(ctx.user.id, date), today: tz.localDate(), closes: db.all('SELECT k.*, r.full_name reviewer FROM cash_closes k LEFT JOIN users r ON r.id=k.reviewed_by WHERE user_id=? ORDER BY close_date DESC, currency LIMIT 60', ctx.user.id) };
});
route('POST', '/api/cash/close', { perm: 'cash.close' }, ctx => cc.submit(ctx, validate(ctx.body, { date: { type: 'date' }, counts: { type: 'array', required: true, max: 10 }, note: { type: 'text', max: 1000 } })));
route('GET', '/api/cash/book', { perm: 'cash.review' }, ctx => {
  const r = cc.book(dateRange(ctx.query, 14));
  if (ctx.query.format === 'csv') return csvResponse(`cash-book_${r.from}_${r.to}${demoTag()}.csv`, csv.stringify(r.closes.map(c => ({ date: c.close_date, cashier: c.cashier, currency: c.currency, receipts: c.receipts, expected: c.expected, counted: c.counted, variance: c.variance, status: c.status, note: c.note, reviewer: c.reviewer, review_note: c.review_note })), null, [`# Cash book ${r.from} to ${r.to}`, db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA']));
  return r;
});
route('GET', '/api/cash/expected/:userId/:date', { perm: 'cash.review' }, ctx => { if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.params.date)) throw new HttpError(400, 'Bad date'); return cc.expected(id(ctx.params.userId), ctx.params.date); });
route('POST', '/api/cash/closes/:id/review', { perm: 'cash.review' }, ctx => cc.review(ctx, id(ctx.params.id), validate(ctx.body, { decision: { type: 'enum', values: ['approved', 'rejected'], required: true }, note: { type: 'text', max: 1000 } })));
