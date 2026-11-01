'use strict';
const { route, HttpError, csvResponse } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const db = require('../lib/db');
const csv = require('../lib/csv');
const supply = require('../services/supply');
const stock = require('../services/stock');
const fleet = require('../services/fleet');
const feedback = require('../services/feedback');

const month = () => new Date().toISOString().slice(0, 10);
const range = q => { const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : month(); const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.parse(to) - 29 * 86400e3).toISOString().slice(0, 10); return { from, to }; };

// ================= Supply timetables =================
const schedSchema = { area_id: { type: 'integer', required: true }, zone: { type: 'string', max: 60 }, days: { type: 'string', required: true, max: 7 }, start_time: { type: 'string', required: true, max: 5 }, end_time: { type: 'string', required: true, max: 5 },
  active: { type: 'boolean', default: true }, notes: { type: 'string', max: 300 } };
route('GET', '/api/supply/schedules', { perm: 'supply.view' }, ctx => supply.schedules(ctx.query.area_id ? Number(ctx.query.area_id) : null, false).map(s => ({ ...s, hours: supply.hoursOf(s),
  customers: db.get(`SELECT COUNT(*) n FROM customers WHERE area_id=? AND status='active' ${s.zone ? 'AND supply_zone=?' : ''}`, s.area_id, ...(s.zone ? [s.zone] : [])).n,
  sms_customers: db.get(`SELECT COUNT(*) n FROM customers WHERE area_id=? AND status='active' AND phone IS NOT NULL AND supply_sms=1 ${s.zone ? 'AND supply_zone=?' : ''}`, s.area_id, ...(s.zone ? [s.zone] : [])).n })));
route('POST', '/api/supply/schedules', { perm: 'supply.manage' }, ctx => supply.save(ctx, null, validate(ctx.body, schedSchema)));
route('PUT', '/api/supply/schedules/:id', { perm: 'supply.manage' }, ctx => supply.save(ctx, id(ctx.params.id), validate(ctx.body, schedSchema)));
route('GET', '/api/supply/upcoming', { perm: 'supply.view' }, ctx => supply.upcoming({ area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null, days: Math.min(14, Number(ctx.query.days) || 7) }));
route('GET', '/api/supply/zones', { anyPerm: ['supply.view', 'customers.view'] }, () => db.all(`SELECT DISTINCT area_id, zone FROM supply_schedules WHERE zone IS NOT NULL AND active=1 ORDER BY area_id, zone`));
route('POST', '/api/supply/heads-up', { perm: 'supply.manage' }, ctx => supply.runHeadsUp(ctx));
route('GET', '/api/supply/log', { perm: 'supply.view' }, ctx => { const { from, to } = range(ctx.query);
  return { from, to, unlogged: supply.unlogged(7), rows: db.all(`SELECT l.*, a.name area_name, u.full_name entered_by_name FROM supply_log l JOIN service_areas a ON a.id=l.area_id LEFT JOIN users u ON u.id=l.entered_by
    WHERE l.supply_date BETWEEN ? AND ? ${ctx.query.area_id ? 'AND l.area_id=?' : ''} ORDER BY l.supply_date DESC, a.name, l.zone LIMIT 1000`, from, to, ...(ctx.query.area_id ? [Number(ctx.query.area_id)] : [])),
    reliability: supply.reliability({ from, to }) }; });
route('POST', '/api/supply/log', { perm: 'supply.log' }, ctx => supply.log(ctx, validate(ctx.body, { schedule_id: { type: 'integer' }, area_id: { type: 'integer' }, zone: { type: 'string', max: 60 },
  supply_date: { type: 'date', required: true }, delivered_hours: { type: 'number', required: true, minVal: 0, maxVal: 24 }, reason: { type: 'string', max: 200 } })));

// ================= Stores =================
const itemSchema = { code: { type: 'string', required: true, max: 30, pattern: /^[A-Za-z0-9._-]+$/, patternMsg: 'letters, digits . _ -' }, name: { type: 'string', required: true, max: 120 },
  category: { type: 'enum', values: ['pipe', 'fitting', 'meter_part', 'chemical', 'tool', 'other'], required: true }, unit: { type: 'string', required: true, max: 20 }, reorder_level: { type: 'number', minVal: 0, default: 0 },
  unit_cost: { type: 'number', minVal: 0 }, currency: { type: 'currency' }, location: { type: 'string', max: 80 }, active: { type: 'boolean', default: true } };
route('GET', '/api/stock/items', { anyPerm: ['stock.view', 'stock.issue'] }, ctx => ({ items: stock.items({ all: ctx.query.all === '1' }),
  meters_in_stock: db.all(`SELECT manufacturer, model, size_mm, COUNT(*) n FROM meters WHERE status='in_stock' AND customer_id IS NULL GROUP BY manufacturer, model, size_mm ORDER BY n DESC`) }));
route('POST', '/api/stock/items', { perm: 'stock.manage' }, ctx => stock.saveItem(ctx, null, validate(ctx.body, itemSchema)));
route('PUT', '/api/stock/items/:id', { perm: 'stock.manage' }, ctx => stock.saveItem(ctx, id(ctx.params.id), validate(ctx.body, { ...itemSchema, code: { type: 'string', max: 30 } })));
route('GET', '/api/stock/movements', { anyPerm: ['stock.view', 'stock.issue'] }, ctx => db.all(`SELECT m.*, i.code, i.name, i.unit, w.wo_number, u.full_name user_name FROM stock_movements m JOIN stock_items i ON i.id=m.item_id
  LEFT JOIN work_orders w ON w.id=m.work_order_id LEFT JOIN users u ON u.id=m.user_id ${ctx.query.item_id ? 'WHERE m.item_id=?' : ''} ORDER BY m.id DESC LIMIT 500`, ...(ctx.query.item_id ? [Number(ctx.query.item_id)] : [])));
route('POST', '/api/stock/move', { anyPerm: ['stock.manage', 'stock.issue'] }, ctx => {
  const b = validate(ctx.body, { item_id: { type: 'integer', required: true }, qty: { type: 'number', required: true }, kind: { type: 'enum', values: ['receive', 'issue', 'return', 'use', 'adjust'], required: true },
    work_order_id: { type: 'integer' }, unit_cost: { type: 'number', minVal: 0 }, reference: { type: 'string', max: 80 }, notes: { type: 'string', max: 300 } });
  if (['receive', 'adjust'].includes(b.kind) && !require('../lib/auth').can(ctx.user, 'stock.manage')) throw new HttpError(403, 'Only stores managers can receive or adjust stock');
  if (b.kind === 'issue' && ctx.user.role === 'technician') { const w = db.get('SELECT assigned_to FROM work_orders WHERE id=?', b.work_order_id); if (w && w.assigned_to && w.assigned_to !== ctx.user.id) throw new HttpError(403, 'Work order is assigned to another technician'); }
  return stock.move(ctx, b);
});
route('GET', '/api/work-orders/:id/materials', { perm: 'workorders.view' }, ctx => stock.materials(id(ctx.params.id)));

// ================= Meter replacement planner =================
route('GET', '/api/meter-fleet', { perm: 'fleet.view' }, ctx => {
  const r = fleet.analyse({ area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null });
  if (ctx.query.format === 'csv') return csvResponse(`meter-replacement-plan${db.MODE === 'demo' ? '_DEMO' : ''}.csv`, csv.stringify(r.rows.map(x => ({ priority: x.priority, serial: x.serial_number, type: x.meter_type, size_mm: x.size_mm, age_years: x.age_years,
    measured_m3: x.throughput_m3, customer: x.customer_number, area: x.area, annual_m3: x.annual_m3, est_under_registration_pct: x.under_registration_pct, est_lost_m3_year: x.lost_m3_year, est_lost_revenue_year: x.lost_revenue_year,
    currency: x.currency, replacement_cost: x.replacement_cost, payback_months: x.payback_months, reasons: x.reasons.join('; ') })), null, ['# Meter replacement plan — ESTIMATES from the wear assumptions in Settings', db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA']));
  return r;
});
route('POST', '/api/meter-fleet/:meterId/plan', { perm: 'workorders.manage' }, ctx => fleet.plan(ctx, id(ctx.params.meterId), String(ctx.body.note || '').slice(0, 300)));

// ================= Customer feedback =================
route('GET', '/api/feedback', { perm: 'feedback.view' }, ctx => ({ ...range(ctx.query), ...feedback.summary({ ...range(ctx.query), area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null }) }));
