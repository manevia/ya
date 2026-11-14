'use strict';
// Water Safety Plan: risk register, control measures and monitoring, sanitary inspections, improvement plan.
const { route, csvResponse } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const db = require('../lib/db');
const csv = require('../lib/csv');
const wsp = require('../services/wsp');

const area = q => (q.area_id ? Number(q.area_id) : null);
const score = { type: 'integer', minVal: 1, maxVal: 5 };

route('GET', '/api/wsp', { perm: 'wsp.view' }, ctx => wsp.summary({ area_id: area(ctx.query) }));
route('GET', '/api/wsp/library', { perm: 'wsp.view' }, () => wsp.library());
route('POST', '/api/wsp/library/apply', { perm: 'wsp.manage' }, ctx => wsp.applyTemplate(ctx, validate(ctx.body, { template: { type: 'string', required: true, max: 40 }, area_id: { type: 'integer' }, asset_id: { type: 'integer' } })));

// ---- risk register ----
const hazardSchema = { area_id: { type: 'integer' }, asset_id: { type: 'integer' }, step: { type: 'enum', values: wsp.STEPS, required: true }, hazard_type: { type: 'enum', values: wsp.TYPES, default: 'microbial' },
  event: { type: 'string', required: true, max: 300 }, cause: { type: 'text', max: 1000 }, likelihood: { ...score, required: true }, severity: { ...score, required: true }, res_likelihood: score, res_severity: score,
  owner_id: { type: 'integer' }, review_due: { type: 'date' }, status: { type: 'enum', values: ['open', 'closed'], default: 'open' } };
route('GET', '/api/wsp/hazards', { perm: 'wsp.view' }, ctx => {
  const rows = wsp.hazards({ area_id: area(ctx.query), asset_id: ctx.query.asset_id ? Number(ctx.query.asset_id) : null, status: ctx.query.status || 'open' });
  if (ctx.query.format === 'csv') return csvResponse(`water_safety_risk_register${db.MODE === 'demo' ? '_DEMO' : ''}.csv`, csv.stringify(rows.map(h => ({ ref: h.ref, area: h.area_name, asset: h.asset_name, step: h.step, hazard_type: h.hazard_type, hazardous_event: h.event, cause: h.cause,
    likelihood: h.likelihood, severity: h.severity, risk_score: h.raw_score, risk: h.raw_band, control_measures: h.controls.filter(c => c.active).map(c => c.description + (c.limit_text ? ` [${c.limit_text}]` : '') + (c.frequency_days ? ` every ${c.frequency_days} d` : '')).join(' | '),
    residual_likelihood: h.res_likelihood, residual_severity: h.res_severity, residual_score: h.res_score, residual_risk: h.res_band, monitoring: h.control_state, owner: h.owner_name, review_due: h.review_due,
    open_actions: h.actions.filter(a => ['planned', 'in_progress'].includes(a.status)).map(a => a.title).join(' | ') })), null,
  ['# Water Safety Plan risk register (score = likelihood x severity, 1-5 each; 1-5 low, 6-9 medium, 10-15 high, 16-25 very high)', db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA']));
  return rows;
});
route('GET', '/api/wsp/hazards/:id', { perm: 'wsp.view' }, ctx => wsp.hazard(id(ctx.params.id)));
route('POST', '/api/wsp/hazards', { perm: 'wsp.manage' }, ctx => wsp.saveHazard(ctx, null, validate(ctx.body, hazardSchema)));
route('PUT', '/api/wsp/hazards/:id', { perm: 'wsp.manage' }, ctx => wsp.saveHazard(ctx, id(ctx.params.id), validate(ctx.body, hazardSchema)));
route('POST', '/api/wsp/hazards/:id/review', { perm: 'wsp.manage' }, ctx => wsp.review(ctx, id(ctx.params.id), validate(ctx.body, { note: { type: 'string', max: 500 }, next_review: { type: 'date' } })));

// ---- control measures and operational monitoring ----
const controlSchema = { description: { type: 'string', required: true, max: 300 }, parameter: { type: 'string', max: 40 }, limit_low: { type: 'number' }, limit_high: { type: 'number' }, unit: { type: 'string', max: 20 },
  frequency_days: { type: 'integer', minVal: 1, maxVal: 730 }, corrective_action: { type: 'text', max: 1000 }, responsible_id: { type: 'integer' }, active: { type: 'boolean', default: true } };
route('POST', '/api/wsp/hazards/:id/controls', { perm: 'wsp.manage' }, ctx => wsp.saveControl(ctx, id(ctx.params.id), null, validate(ctx.body, controlSchema)));
route('PUT', '/api/wsp/controls/:id', { perm: 'wsp.manage' }, ctx => wsp.saveControl(ctx, null, id(ctx.params.id), validate(ctx.body, controlSchema)));
route('GET', '/api/wsp/monitoring', { anyPerm: ['wsp.view', 'wsp.monitor'] }, ctx => wsp.monitoring({ area_id: area(ctx.query) }));
route('POST', '/api/wsp/controls/:id/check', { anyPerm: ['wsp.monitor', 'wsp.manage'] }, ctx => wsp.check(ctx, id(ctx.params.id), validate(ctx.body, { value: { type: 'number' }, ok: { type: 'boolean' }, note: { type: 'string', max: 500 }, checked_at: { type: 'datetime' }, client_uuid: { type: 'string', max: 64 } })));

// ---- sanitary inspections ----
route('GET', '/api/wsp/inspections', { anyPerm: ['wsp.view', 'wsp.inspect'] }, ctx => wsp.inspections({ area_id: area(ctx.query) }));
route('GET', '/api/wsp/inspections/:id', { anyPerm: ['wsp.view', 'wsp.inspect'] }, ctx => wsp.inspection(id(ctx.params.id)));
route('POST', '/api/wsp/inspections', { anyPerm: ['wsp.inspect', 'wsp.manage'] }, ctx => wsp.recordInspection(ctx, validate(ctx.body, { asset_id: { type: 'integer', required: true }, form: { type: 'string', required: true, max: 40 }, answers: { type: 'json', required: true },
  notes: { type: 'string', max: 500 }, inspected_at: { type: 'datetime' }, lat: { type: 'lat' }, lng: { type: 'lng' }, create_hazards: { type: 'boolean', default: true }, client_uuid: { type: 'string', max: 64 } })));

// ---- improvement plan ----
const actionSchema = { hazard_id: { type: 'integer' }, title: { type: 'string', required: true, max: 200 }, description: { type: 'text', max: 1000 }, owner_id: { type: 'integer' }, due_date: { type: 'date' },
  cost: { type: 'number', minVal: 0, maxVal: 1e12 }, currency: { type: 'currency' }, status: { type: 'enum', values: ['planned', 'in_progress', 'done', 'cancelled'], default: 'planned' } };
route('GET', '/api/wsp/actions', { perm: 'wsp.view' }, ctx => wsp.actions({ status: ctx.query.status || 'open', area_id: area(ctx.query) }));
route('POST', '/api/wsp/actions', { perm: 'wsp.manage' }, ctx => wsp.saveAction(ctx, null, validate(ctx.body, actionSchema)));
route('PUT', '/api/wsp/actions/:id', { perm: 'wsp.manage' }, ctx => wsp.saveAction(ctx, id(ctx.params.id), validate(ctx.body, actionSchema)));
route('POST', '/api/wsp/actions/:id/work-order', { perm: 'wsp.manage' }, ctx => wsp.actionToWorkOrder(ctx, id(ctx.params.id), validate(ctx.body, { assigned_to: { type: 'integer' } })));
