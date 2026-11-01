'use strict';
const { route, HttpError, csvResponse } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const audit = require('../lib/audit');
const db = require('../lib/db');
const csv = require('../lib/csv');
const connections = require('../services/connections');
const shared = require('../services/shared');
const kpi = require('../services/kpi');
const onboarding = require('../services/onboarding');

// ================= New connections =================
const appSchema = { applicant_name: { type: 'string', required: true, max: 120 }, phone: { type: 'phone' }, area_id: { type: 'integer' }, address: { type: 'string', required: true, max: 250 }, landmark: { type: 'string', max: 200 },
  lat: { type: 'lat' }, lng: { type: 'lng' }, customer_type: { type: 'enum', values: ['household', 'business', 'institution'], default: 'household' }, household_size: { type: 'integer', minVal: 1, maxVal: 100 } };
route('POST', '/api/public-connection', { public: true }, ctx => {
  if (db.setting('public_status_enabled', '1') !== '1') throw new HttpError(404, 'Online applications are switched off');
  if (ctx.body.website) throw new HttpError(400, 'Rejected');
  if (ctx.body.form_ms != null && Number(ctx.body.form_ms) < 3000) throw new HttpError(400, 'Please take a moment to fill in the form');
  const b = validate(ctx.body, { ...appSchema, phone: { type: 'phone', required: true }, area_id: { type: 'integer', required: true }, photo: { type: 'string', max: 6 * 1024 * 1024 } });
  const photo_path = b.photo ? require('./customers').savePhoto(b.photo) : null;
  const r = connections.submit(ctx, { ...b, photo: undefined, photo_path, channel: 'web' });
  return { ref: r.ref };
});
route('GET', '/api/public-connection/:ref', { public: true }, ctx => { const t = connections.track(ctx.params.ref); if (!t) throw new HttpError(404, 'Reference not found'); return t; });
route('GET', '/api/connections', { perm: 'connections.view' }, ctx => db.all(`SELECT r.*, a.name area_name, c.customer_number, m.serial_number, (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.customer_id=r.customer_id) paid
  FROM connection_requests r LEFT JOIN service_areas a ON a.id=r.area_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN meters m ON m.id=r.meter_id ${ctx.query.status ? 'WHERE r.status=?' : ''} ORDER BY r.id DESC LIMIT 500`, ...(ctx.query.status ? [ctx.query.status] : [])));
route('GET', '/api/connections/:id', { perm: 'connections.view' }, ctx => {
  const r = db.get(`SELECT r.*, a.name area_name, a.currency area_currency, c.customer_number FROM connection_requests r LEFT JOIN service_areas a ON a.id=r.area_id LEFT JOIN customers c ON c.id=r.customer_id WHERE r.id=?`, id(ctx.params.id));
  if (!r) throw new HttpError(404, 'Not found');
  return { request: r, events: db.all('SELECT e.*, u.full_name user_name FROM connection_request_events e LEFT JOIN users u ON u.id=e.user_id WHERE request_id=? ORDER BY e.id', r.id),
    default_quote: connections.defaultQuote(r), max_instalments: db.settingNum('connection_max_instalments', 12), paid: r.customer_id ? db.get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE customer_id=?', r.customer_id).s : 0,
    financed: r.customer_id ? db.all('SELECT f.*, b.bill_number FROM financed_charges f LEFT JOIN bills b ON b.id=f.bill_id WHERE f.request_id=? ORDER BY seq', r.id) : [],
    meters_in_stock: db.all(`SELECT id, serial_number, manufacturer, model, size_mm, initial_reading FROM meters WHERE status='in_stock' AND customer_id IS NULL ORDER BY serial_number`) };
});
route('POST', '/api/connections', { perm: 'connections.manage' }, ctx => ({ ...connections.submit(ctx, { ...validate(ctx.body, appSchema), channel: 'office' }) }));
route('POST', '/api/connections/:id/:action', { perm: 'connections.manage' }, ctx => {
  const action = ctx.params.action;
  const b = validate(ctx.body, { assigned_to: { type: 'integer' }, due_date: { type: 'date' }, area_id: { type: 'integer' }, distance_m: { type: 'number', minVal: 0, maxVal: 5000 }, notes: { type: 'text', max: 1000 },
    feasible: { type: 'boolean', default: true }, lines: { type: 'array', max: 20 }, deposit: { type: 'number', minVal: 0 }, instalments: { type: 'integer', minVal: 0, maxVal: 36 },
    override_reason: { type: 'string', max: 300 }, meter_id: { type: 'integer' }, initial_reading: { type: 'number', minVal: 0 }, reason: { type: 'string', max: 300 } });
  if (b.override_reason && ctx.user.role !== 'manager' && ctx.user.role !== 'admin') throw new HttpError(403, 'Only a manager can override the deposit requirement');
  return connections.advance(ctx, id(ctx.params.id), action, b);
});

// ================= Shared compound connections =================
route('GET', '/api/customers/:id/shared', { anyPerm: ['customers.view', 'billing.view'] }, ctx => shared.status(id(ctx.params.id)));
route('PUT', '/api/customers/:id/shared', { anyPerm: ['customers.manage', 'shared.manage'] }, ctx => {
  const b = validate(ctx.body, { split_method: { type: 'enum', values: ['equal', 'household_size', 'fixed_pct'], required: true }, members: { type: 'array', required: true, max: 30 }, active: { type: 'boolean', default: true }, notes: { type: 'text', max: 500 } });
  for (const m of b.members) { if (m.phone && !/^[+0-9 ()-]{6,20}$/.test(m.phone)) throw new HttpError(400, `Invalid phone for ${m.name}`); if (m.name && String(m.name).length > 120) throw new HttpError(400, 'Name too long'); }
  return shared.saveGroup(ctx, id(ctx.params.id), b);
});
route('POST', '/api/customers/:id/shared/pay', { perm: 'payments.create' }, ctx => { // cash payment for one household's share
  const b = validate(ctx.body, { member_id: { type: 'integer', required: true }, amount: { type: 'number', required: true, minVal: 0.01 }, method: { type: 'paymethod', default: 'cash' }, reference: { type: 'string', max: 80 } });
  const cid = id(ctx.params.id);
  const m = db.get('SELECT m.* FROM shared_members m JOIN shared_groups g ON g.id=m.group_id WHERE m.id=? AND g.customer_id=?', b.member_id, cid); if (!m) throw new HttpError(400, 'Household not in this shared connection');
  if (b.method !== 'cash' && !b.reference) throw new HttpError(400, 'Reference required for non-cash payments');
  return db.tx(() => { const p = require('../services/billing').recordPayment(ctx, { customer_id: cid, amount: b.amount, method: b.method, reference: b.reference, notes: `Share payment by household ${m.seq} (${m.name})` });
    const credited = shared.creditMember(m.id, p.amount); return { ...p, credited_to_share: credited }; });
});

// ================= Cost recovery & indicators =================
route('GET', '/api/kpi', { perm: 'kpi.view' }, ctx => {
  const to = /^\d{4}-\d{2}$/.test(ctx.query.to || '') ? ctx.query.to : new Date().toISOString().slice(0, 7);
  const from = /^\d{4}-\d{2}$/.test(ctx.query.from || '') ? ctx.query.from : (() => { const d = new Date(to + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 5); return d.toISOString().slice(0, 7); })();
  const out = kpi.compute({ from, to, area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null });
  if (ctx.query.format === 'csv') {
    const rows = []; for (const a of out.areas) for (const [k, v] of Object.entries(a.values)) rows.push({ area: a.area, indicator: (out.labels[k] || [k])[0], code: k, value: v, unit: ((out.labels[k] || [])[1] || '').replace('cur', a.currency), target: out.targets[k] ? `${out.targets[k].direction === 'min' ? '≥' : '≤'} ${out.targets[k].target}` : '', status: a.status[k] || 'n/a' });
    return csvResponse(`performance-indicators_${from}_${to}${db.MODE === 'demo' ? '_DEMO' : ''}.csv`, csv.stringify(rows, null, [`# Utility performance indicators ${from} to ${to} — ${db.setting('org_name')}`, db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA', '# Targets are set by the utility; defaults are indicative']));
  }
  return out;
});
route('GET', '/api/om-costs', { perm: 'kpi.view' }, ctx => db.all(`SELECT o.*, a.name area_name, u.full_name entered_by_name FROM om_costs o LEFT JOIN service_areas a ON a.id=o.area_id LEFT JOIN users u ON u.id=o.entered_by ORDER BY o.period DESC, o.id DESC LIMIT 500`));
route('POST', '/api/om-costs', { perm: 'kpi.manage' }, ctx => {
  const b = validate(ctx.body, { area_id: { type: 'integer', required: true }, period: { type: 'string', required: true, pattern: /^\d{4}-\d{2}$/, patternMsg: 'YYYY-MM' }, category: { type: 'enum', values: ['energy_fuel', 'electricity', 'chemicals', 'staff', 'repairs', 'transport', 'admin', 'other'], required: true },
    amount: { type: 'number', required: true, minVal: 0, maxVal: 1e9 }, currency: { type: 'currency', required: true }, notes: { type: 'string', max: 300 } });
  const r = db.run('INSERT INTO om_costs(area_id, period, category, amount, currency, notes, entered_by) VALUES (?,?,?,?,?,?,?)', b.area_id, b.period, b.category, b.amount, b.currency, b.notes, ctx.user.id);
  audit.log(ctx, 'om_cost.create', 'om_cost', r.id, b); return { id: r.id };
});
route('PUT', '/api/kpi-inputs', { perm: 'kpi.manage' }, ctx => {
  const b = validate(ctx.body, { area_id: { type: 'integer', required: true }, period: { type: 'string', required: true, pattern: /^\d{4}-\d{2}$/, patternMsg: 'YYYY-MM' }, staff_count: { type: 'number', minVal: 0, maxVal: 10000 }, supply_hours_per_day: { type: 'number', minVal: 0, maxVal: 24 } });
  db.run(`INSERT INTO kpi_inputs(area_id, period, staff_count, supply_hours_per_day) VALUES (?,?,?,?) ON CONFLICT(area_id, period) DO UPDATE SET staff_count=excluded.staff_count, supply_hours_per_day=excluded.supply_hours_per_day`, b.area_id, b.period, b.staff_count, b.supply_hours_per_day);
  audit.log(ctx, 'kpi.inputs', 'kpi_inputs', `${b.area_id}:${b.period}`, b); return { ok: true };
});
route('PUT', '/api/kpi-targets/:code', { perm: 'kpi.manage' }, ctx => {
  const b = validate(ctx.body, { target: { type: 'number', required: true }, direction: { type: 'enum', values: ['min', 'max'], required: true } });
  kpi.ensureTargets(); if (!db.get('SELECT 1 FROM kpi_targets WHERE code=?', ctx.params.code)) throw new HttpError(404, 'Unknown indicator');
  db.run('UPDATE kpi_targets SET target=?, direction=? WHERE code=?', b.target, b.direction, ctx.params.code); audit.log(ctx, 'kpi.target', 'kpi_target', ctx.params.code, b); return { ok: true };
});

// ================= Bulk onboarding =================
route('GET', '/api/onboarding/template/:kind', { perm: 'onboarding.import' }, ctx => { if (!onboarding.TEMPLATES[ctx.params.kind]) throw new HttpError(404, 'Unknown'); return csvResponse(`template-${ctx.params.kind}.csv`, onboarding.template(ctx.params.kind)); });
route('POST', '/api/onboarding/import', { perm: 'onboarding.import' }, ctx => onboarding.run(ctx, validate(ctx.body, { kind: { type: 'enum', values: ['customers', 'meters', 'balances'], required: true },
  content: { type: 'text', required: true, max: 8 * 1024 * 1024 }, commit: { type: 'boolean', default: false }, filename: { type: 'string', max: 200 } })));
