'use strict';
const { route, HttpError } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const audit = require('../lib/audit');
const db = require('../lib/db');
const community = require('../services/community');
const quality = require('../services/quality');
const collections = require('../services/collections');
const labs = require('../services/labs');

// ================= Public (no login) =================
route('GET', '/api/public-status', { public: true }, () => {
  if (db.setting('public_status_enabled', '1') !== '1') throw new HttpError(404, 'Public status page is switched off');
  return { org_name: db.setting('org_name'), mode: db.MODE, ussd_code: db.setting('ussd_code'), generated_at: new Date().toISOString(), areas: community.statusPage(),
    areas_list: db.all('SELECT id, name FROM service_areas WHERE active=1 ORDER BY name'), points_list: db.all(`SELECT id, name, area_id FROM assets WHERE asset_type='water_point' AND status!='decommissioned' ORDER BY name`) };
});
route('POST', '/api/public-report', { public: true }, ctx => {
  if (db.setting('public_status_enabled', '1') !== '1') throw new HttpError(404, 'Reporting is switched off');
  if (ctx.body.website) throw new HttpError(400, 'Rejected'); // honeypot: real people never fill this hidden field
  if (ctx.body.form_ms != null && Number(ctx.body.form_ms) < 2500) throw new HttpError(400, 'Please take a moment to fill in the form');
  const b = validate(ctx.body, { kind: { type: 'enum', values: Object.keys(community.KIND), required: true }, area_id: { type: 'integer' }, asset_id: { type: 'integer' },
    location_text: { type: 'string', max: 200 }, description: { type: 'text', max: 600 }, lat: { type: 'lat' }, lng: { type: 'lng' }, phone: { type: 'phone' }, photo: { type: 'string', max: 6 * 1024 * 1024 } });
  if (!b.area_id && !b.asset_id && b.lat == null) throw new HttpError(400, 'Tell us the area, the water point, or share your location');
  if (!b.location_text && b.lat == null && !b.asset_id) throw new HttpError(400, 'Describe where the problem is (street, landmark)');
  const photo_path = b.photo ? require('./customers').savePhoto(b.photo) : null;
  return community.report(ctx, { ...b, photo: undefined, photo_path, channel: 'web' });
});
route('GET', '/api/public-report/:ref', { public: true }, ctx => { const t = /^C-/i.test(ctx.params.ref) ? require('../services/connections').track(ctx.params.ref) : community.track(ctx.params.ref); if (!t) throw new HttpError(404, 'Reference not found'); return t; });
route('GET', '/api/public-reports', { perm: 'alerts.view' }, () => db.all(`SELECT p.id, p.ref, p.kind, p.channel, p.location_text, p.description, p.created_at, p.phone IS NOT NULL has_phone, p.photo_path IS NOT NULL has_photo, p.resolved_notified,
  a.name area_name, al.status alert_status, al.id alert_id FROM public_reports p LEFT JOIN service_areas a ON a.id=p.area_id LEFT JOIN alerts al ON al.id=p.alert_id ORDER BY p.id DESC LIMIT 300`));
route('GET', '/api/public-reports/:id/photo', { perm: 'alerts.view' }, ctx => {
  const r = db.get('SELECT photo_path FROM public_reports WHERE id=?', id(ctx.params.id)); if (!r || !r.photo_path) throw new HttpError(404, 'No photo');
  const f = require('path').join(db.DATA_DIR, 'uploads', require('path').basename(r.photo_path));
  return { __raw: true, body: require('fs').readFileSync(f), headers: { 'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg' } };
});

// ================= Water quality =================
route('GET', '/api/wq', { anyPerm: ['wq.view', 'wq.record'] }, () => quality.summary());
route('GET', '/api/wq/tests', { anyPerm: ['wq.view', 'wq.record'] }, ctx => db.all(`SELECT t.*, s.name asset_name, s.code asset_code, u.full_name tested_by_name, p.name parameter_name, p.unit FROM wq_tests t JOIN assets s ON s.id=t.asset_id
  LEFT JOIN users u ON u.id=t.tested_by LEFT JOIN wq_parameters p ON p.code=t.parameter ${ctx.query.asset_id ? 'WHERE t.asset_id=?' : ''} ORDER BY t.sampled_at DESC LIMIT 500`, ...(ctx.query.asset_id ? [Number(ctx.query.asset_id)] : [])));
route('GET', '/api/wq/parameters', { anyPerm: ['wq.view', 'wq.record'] }, () => { quality.ensureParams(); return db.all('SELECT * FROM wq_parameters WHERE active=1 ORDER BY code'); });
route('POST', '/api/wq/tests', { perm: 'wq.record' }, ctx => quality.record(ctx, validate(ctx.body, { asset_id: { type: 'integer', required: true }, parameter: { type: 'string', required: true, max: 40 },
  value: { type: 'number', required: true, minVal: -1, maxVal: 1e7 }, sampled_at: { type: 'datetime' }, method: { type: 'enum', values: ['field_kit', 'lab', 'sensor'], default: 'field_kit' }, notes: { type: 'text', max: 500 },
  client_uuid: { type: 'string', max: 64, pattern: /^[A-Za-z0-9-]+$/ } })));
route('PUT', '/api/wq/parameters/:code', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { fail_below: { type: 'number' }, warn_below: { type: 'number' }, warn_above: { type: 'number' }, fail_above: { type: 'number' }, guidance: { type: 'text', max: 500 }, active: { type: 'boolean', default: true } });
  const before = db.get('SELECT * FROM wq_parameters WHERE code=?', ctx.params.code); if (!before) throw new HttpError(404, 'Not found');
  db.run('UPDATE wq_parameters SET fail_below=?, warn_below=?, warn_above=?, fail_above=?, guidance=COALESCE(?, guidance), active=? WHERE code=?', b.fail_below, b.warn_below, b.warn_above, b.fail_above, b.guidance, b.active, ctx.params.code);
  audit.log(ctx, 'wq.parameter', 'wq_parameter', ctx.params.code, { before, after: b }); return { ok: true };
});

// ================= Collections =================
route('GET', '/api/collections/ladder', { perm: 'collections.view' }, ctx => ({ stages: collections.STAGES, rows: collections.ladder({ area_id: ctx.query.area_id ? Number(ctx.query.area_id) : null }),
  last_reminders_run: db.setting('last_reminders_run', null) }));
route('GET', '/api/plans', { perm: 'collections.view' }, ctx => db.all(`SELECT id FROM payment_plans ${ctx.query.status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 300`, ...(ctx.query.status ? [ctx.query.status] : [])).map(p => collections.planStatus(p.id)));
route('GET', '/api/plans/:id', { perm: 'collections.view' }, ctx => { const p = collections.planStatus(id(ctx.params.id)); if (!p) throw new HttpError(404, 'Not found'); return p; });
route('POST', '/api/plans/preview', { perm: 'plans.manage' }, ctx => {
  const b = validate(ctx.body, { customer_id: { type: 'integer', required: true }, down_payment: { type: 'number', minVal: 0, default: 0 }, instalments: { type: 'integer', required: true, minVal: 1, maxVal: 36 }, frequency: { type: 'enum', values: ['weekly', 'monthly'], required: true }, start_date: { type: 'date' } });
  const bal = require('../services/billing').balance(b.customer_id);
  return { arrears: bal, schedule: bal > 0 ? collections.schedule(bal, b.down_payment, b.instalments, b.frequency, b.start_date || new Date().toISOString().slice(0, 10)) : [] };
});
route('POST', '/api/plans', { perm: 'plans.manage' }, ctx => collections.createPlan(ctx, validate(ctx.body, { customer_id: { type: 'integer', required: true }, down_payment: { type: 'number', minVal: 0, default: 0 },
  instalments: { type: 'integer', required: true, minVal: 1, maxVal: 36 }, frequency: { type: 'enum', values: ['weekly', 'monthly'], required: true }, start_date: { type: 'date' }, notes: { type: 'text', max: 500 } })));
route('POST', '/api/plans/:id/cancel', { perm: 'plans.manage' }, ctx => { collections.cancelPlan(ctx, id(ctx.params.id), String(ctx.body.reason || '').slice(0, 300) || 'no reason'); return { ok: true }; });
route('POST', '/api/collections/reminders', { perm: 'reminders.run' }, ctx => collections.runReminders(ctx));
route('POST', '/api/collections/review', { perm: 'collections.manage' }, ctx => { const b = validate(ctx.body, { customer_id: { type: 'integer', required: true }, note: { type: 'text', required: true, max: 1000 } }); return collections.recommendReview(ctx, b.customer_id, b.note); });

// ================= Tariff lab & briefing =================
route('POST', '/api/tariff-lab/simulate', { perm: 'tariff.lab' }, ctx => {
  const b = validate(ctx.body, { area_id: { type: 'integer', required: true }, customer_type: { type: 'enum', values: ['household', 'business', 'institution', 'public_water_point', 'bulk'] }, months: { type: 'integer', minVal: 1, maxVal: 24, default: 6 },
    fixed_charge: { type: 'number', minVal: 0, default: 0 }, tax_pct: { type: 'number', minVal: 0, maxVal: 100, default: 0 }, minimum_charge: { type: 'number', minVal: 0, default: 0 }, bands: { type: 'array', required: true, max: 20 }, fees: { type: 'array', default: [] } });
  const bands = b.bands.map(x => ({ up_to: x.up_to === '' || x.up_to == null ? null : Number(x.up_to), rate: Number(x.rate) }));
  if (bands.some(x => !(x.rate >= 0))) throw new HttpError(400, 'Every band needs a rate');
  return labs.simulate({ area_id: b.area_id, customer_type: b.customer_type, months: b.months, proposal: { fixed_charge: b.fixed_charge, tax_pct: b.tax_pct, minimum_charge: b.minimum_charge, bands, fees: b.fees } });
});
route('GET', '/api/briefing', { perm: 'briefing.view' }, () => labs.briefing());
route('POST', '/api/briefing/sms', { perm: 'briefing.view' }, ctx => {
  const phone = String(ctx.body.phone || db.setting('briefing_sms_phone') || ctx.user.phone || '').trim(); if (!phone) throw new HttpError(400, 'No phone number: add one to your user profile or in Settings › briefing SMS phone');
  const text = labs.briefingSms(labs.briefing()); require('../services/channels').send(phone, text, { purpose: 'briefing' });
  return { sent_to: phone, text, simulated: db.setting('sms_provider', 'simulator') === 'simulator' };
});
