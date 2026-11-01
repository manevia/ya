'use strict';
const fs = require('fs');
const path = require('path');
const { route, HttpError, csvResponse } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const db = require('../lib/db');
const csv = require('../lib/csv');
const integ = require('../integrations');
const alerts = require('../services/alerts');

const STAFF = ['dashboard.view', 'customers.view', 'customers.lookup', 'workorders.view', 'field.read', 'billing.view', 'wp.sell', 'wp.view'];
const CUSTOMER_TYPES = ['household', 'business', 'institution', 'public_water_point', 'bulk'];
const METHODS = ['manual', 'csv', 'pulse', 'lorawan', 'nbiot', 'cellular', 'wmbus', 'serial', 'vendor_api', 'simulator'];

route('GET', '/api/lookups', { anyPerm: STAFF }, ctx => ({
  areas: db.all('SELECT id, code, name, currency, active FROM service_areas ORDER BY name'),
  staff: db.all(`SELECT id, full_name, role FROM users WHERE active=1 AND role != 'customer' ORDER BY full_name`),
  meter_models: db.all('SELECT * FROM meter_models ORDER BY manufacturer, model'),
  integrations: db.all('SELECT id, name, method, adapter, status, is_simulator FROM integrations ORDER BY name'),
  customer_types: CUSTOMER_TYPES, methods: METHODS
}));

// ---------------- Users ----------------
const userSchema = {
  username: { type: 'string', required: true, max: 60, pattern: /^[a-zA-Z0-9._-]{3,60}$/, patternMsg: 'letters, numbers, . _ - (3-60)' },
  full_name: { type: 'string', required: true, max: 120 }, email: { type: 'email' }, phone: { type: 'phone' },
  role: { type: 'enum', required: true, values: Object.keys(auth.ROLE_LABELS) }, customer_id: { type: 'integer' }, area_id: { type: 'integer' },
  active: { type: 'boolean', default: true }
};
route('GET', '/api/users', { perm: 'users.manage' }, () => db.all(`SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role, u.customer_id, u.area_id, u.active, u.last_login_at,
  u.locked_until, u.must_change_password, u.totp_enabled, c.customer_number, a.name area_name FROM users u LEFT JOIN customers c ON c.id=u.customer_id LEFT JOIN service_areas a ON a.id=u.area_id ORDER BY u.role, u.full_name`));
route('POST', '/api/users', { perm: 'users.manage' }, ctx => {
  const b = validate(ctx.body, { ...userSchema, password: { type: 'string', required: true, max: 200 } });
  const p = auth.passwordProblem(b.password); if (p) throw new HttpError(400, p);
  if (b.role === 'customer' && !b.customer_id) throw new HttpError(400, 'Customer users must be linked to a customer account');
  if (b.role !== 'customer') b.customer_id = null;
  const r = db.run(`INSERT INTO users(username, full_name, email, phone, role, customer_id, area_id, active, password_hash, must_change_password) VALUES (?,?,?,?,?,?,?,?,?,1)`,
    b.username, b.full_name, b.email, b.phone, b.role, b.customer_id, b.area_id, b.active, auth.hashPassword(b.password));
  audit.log(ctx, 'user.create', 'user', r.id, { username: b.username, role: b.role });
  return { id: r.id };
});
route('PUT', '/api/users/:id', { perm: 'users.manage' }, ctx => {
  const uid = id(ctx.params.id);
  const before = db.get('SELECT * FROM users WHERE id=?', uid); if (!before) throw new HttpError(404, 'User not found');
  const b = validate(ctx.body, { ...userSchema, username: { type: 'string', max: 60 } });
  if (uid === ctx.user.id && (b.role !== 'admin' || !b.active)) throw new HttpError(400, 'You cannot remove your own administrator access');
  if (b.role === 'customer' && !b.customer_id) throw new HttpError(400, 'Customer users must be linked to a customer account');
  db.run('UPDATE users SET full_name=?, email=?, phone=?, role=?, customer_id=?, area_id=?, active=? WHERE id=?', b.full_name, b.email, b.phone, b.role, b.role === 'customer' ? b.customer_id : null, b.area_id, b.active, uid);
  if (!b.active || b.role !== before.role) db.run('DELETE FROM sessions WHERE user_id=?', uid);
  audit.log(ctx, 'user.update', 'user', uid, { before: { role: before.role, active: before.active }, after: { role: b.role, active: b.active } });
  return { ok: true };
});
route('POST', '/api/users/:id/reset-2fa', { perm: 'users.manage' }, ctx => {
  const uid = id(ctx.params.id);
  db.run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?', uid); db.run('DELETE FROM recovery_codes WHERE user_id=?', uid); db.run('DELETE FROM sessions WHERE user_id=?', uid);
  audit.log(ctx, 'user.reset_2fa', 'user', uid); return { ok: true };
});
route('POST', '/api/users/:id/reset-password', { perm: 'users.manage' }, ctx => {
  const uid = id(ctx.params.id);
  const b = validate(ctx.body, { password: { type: 'string', required: true, max: 200 } });
  const p = auth.passwordProblem(b.password); if (p) throw new HttpError(400, p);
  db.run('UPDATE users SET password_hash=?, must_change_password=1, failed_attempts=0, locked_until=NULL WHERE id=?', auth.hashPassword(b.password), uid);
  db.run('DELETE FROM sessions WHERE user_id=?', uid);
  audit.log(ctx, 'user.reset_password', 'user', uid);
  return { ok: true };
});

// ---------------- Service areas ----------------
const areaSchema = { code: { type: 'string', required: true, max: 20, pattern: /^[A-Z0-9-]+$/, patternMsg: 'UPPERCASE letters, digits, -' }, name: { type: 'string', required: true, max: 120 },
  county: { type: 'string', max: 60 }, district: { type: 'string', max: 60 }, currency: { type: 'currency', required: true }, description: { type: 'text', max: 1000 }, active: { type: 'boolean', default: true }, population: { type: 'integer', minVal: 0, maxVal: 100000000 } };
route('GET', '/api/areas', { anyPerm: ['areas.view', 'areas.manage'] }, () => db.all(`SELECT a.*, (SELECT COUNT(*) FROM customers c WHERE c.area_id=a.id) customers,
  (SELECT COUNT(*) FROM assets s WHERE s.area_id=a.id) assets FROM service_areas a ORDER BY a.name`));
route('POST', '/api/areas', { perm: 'areas.manage' }, ctx => {
  const b = validate(ctx.body, areaSchema);
  const r = db.run('INSERT INTO service_areas(code,name,county,district,currency,description,active,population) VALUES (?,?,?,?,?,?,?,?)', b.code, b.name, b.county, b.district, b.currency, b.description, b.active, b.population ?? null);
  audit.log(ctx, 'area.create', 'service_area', r.id, b); return { id: r.id };
});
route('PUT', '/api/areas/:id', { perm: 'areas.manage' }, ctx => {
  const aid = id(ctx.params.id); const b = validate(ctx.body, areaSchema);
  const before = db.get('SELECT * FROM service_areas WHERE id=?', aid); if (!before) throw new HttpError(404, 'Not found');
  if (before.currency !== b.currency && db.get('SELECT 1 FROM bills bl JOIN customers c ON c.id=bl.customer_id WHERE c.area_id=? LIMIT 1', aid))
    throw new HttpError(409, 'Currency cannot be changed after bills have been issued in this area. Create a new service area or contact support.');
  db.run('UPDATE service_areas SET code=?, name=?, county=?, district=?, currency=?, description=?, active=?, population=? WHERE id=?', b.code, b.name, b.county, b.district, b.currency, b.description, b.active, b.population ?? null, aid);
  audit.log(ctx, 'area.update', 'service_area', aid, { before, after: b }); return { ok: true };
});

// ---------------- Tariffs ----------------
function checkBands(bands) {
  if (!Array.isArray(bands) || !bands.length) throw new HttpError(400, 'At least one consumption band is required');
  let last = 0;
  bands.forEach((b, i) => {
    if (!(Number(b.rate) >= 0)) throw new HttpError(400, `Band ${i + 1}: rate must be ≥ 0`);
    const up = b.up_to === null || b.up_to === '' || b.up_to === undefined ? null : Number(b.up_to);
    if (up !== null && !(up > last)) throw new HttpError(400, `Band ${i + 1}: upper limit must be greater than ${last}`);
    if (up === null && i !== bands.length - 1) throw new HttpError(400, 'Only the last band can be open-ended');
    b.up_to = up; b.rate = Number(b.rate); last = up ?? last;
  });
  return bands;
}
function checkFees(fees) {
  if (!Array.isArray(fees)) throw new HttpError(400, 'Fees must be a list');
  return fees.filter(f => f && f.name).map(f => ({ name: String(f.name).slice(0, 80), ...(f.pct ? { pct: Number(f.pct) } : { amount: Number(f.amount || 0) }) }));
}
const tariffSchema = { code: { type: 'string', required: true, max: 30 }, name: { type: 'string', required: true, max: 120 }, customer_type: { type: 'enum', values: CUSTOMER_TYPES },
  area_id: { type: 'integer' }, meter_size_mm: { type: 'integer', minVal: 1 }, billing_mode: { type: 'enum', values: ['any', 'postpaid', 'prepaid'], default: 'any' },
  currency: { type: 'currency', required: true }, fixed_charge: { type: 'number', minVal: 0, default: 0 }, tax_pct: { type: 'number', minVal: 0, maxVal: 100, default: 0 },
  minimum_charge: { type: 'number', minVal: 0, default: 0 }, effective_from: { type: 'date', required: true }, effective_to: { type: 'date' },
  bands: { type: 'array', required: true, max: 20 }, fees: { type: 'array', max: 20, default: [] }, active: { type: 'boolean', default: true }, notes: { type: 'text', max: 1000 } };
route('GET', '/api/tariffs', { anyPerm: ['tariffs.view', 'tariffs.manage'] }, () => db.all(`SELECT t.*, a.name area_name FROM tariffs t LEFT JOIN service_areas a ON a.id=t.area_id ORDER BY t.active DESC, t.effective_from DESC`));
function saveTariff(ctx, tid) {
  const b = validate(ctx.body, tariffSchema);
  const bands = checkBands(b.bands); const fees = checkFees(b.fees || []);
  if (b.effective_to && b.effective_to < b.effective_from) throw new HttpError(400, 'Effective-to must be after effective-from');
  if (b.area_id) { const a = db.get('SELECT currency FROM service_areas WHERE id=?', b.area_id); if (a && a.currency !== b.currency) throw new HttpError(400, `Area currency is ${a.currency}; tariff currency must match`); }
  const vals = [b.code, b.name, b.customer_type, b.area_id, b.meter_size_mm, b.billing_mode, b.currency, b.fixed_charge, JSON.stringify(bands), b.tax_pct, JSON.stringify(fees), b.minimum_charge, b.effective_from, b.effective_to, b.active, b.notes];
  if (tid) {
    const used = db.get('SELECT 1 FROM bills WHERE tariff_id=? LIMIT 1', tid);
    const before = db.get('SELECT * FROM tariffs WHERE id=?', tid);
    if (used && (before.bands_json !== JSON.stringify(bands) || before.fixed_charge !== b.fixed_charge || before.tax_pct !== b.tax_pct || before.fees_json !== JSON.stringify(fees) || before.currency !== b.currency))
      throw new HttpError(409, 'This tariff has been used on bills, so its rates cannot change. Set an effective-to date and create a new tariff version instead.');
    db.run(`UPDATE tariffs SET code=?, name=?, customer_type=?, area_id=?, meter_size_mm=?, billing_mode=?, currency=?, fixed_charge=?, bands_json=?, tax_pct=?, fees_json=?, minimum_charge=?, effective_from=?, effective_to=?, active=?, notes=? WHERE id=?`, ...vals, tid);
    audit.log(ctx, 'tariff.update', 'tariff', tid, { before, after: b }); return { ok: true };
  }
  const r = db.run(`INSERT INTO tariffs(code, name, customer_type, area_id, meter_size_mm, billing_mode, currency, fixed_charge, bands_json, tax_pct, fees_json, minimum_charge, effective_from, effective_to, active, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals, ctx.user.id);
  audit.log(ctx, 'tariff.create', 'tariff', r.id, b); return { id: r.id };
}
route('POST', '/api/tariffs', { perm: 'tariffs.manage' }, ctx => saveTariff(ctx));
route('PUT', '/api/tariffs/:id', { perm: 'tariffs.manage' }, ctx => saveTariff(ctx, id(ctx.params.id)));
route('POST', '/api/tariffs/preview', { anyPerm: ['tariffs.view', 'tariffs.manage'] }, ctx => {
  const b = validate(ctx.body, { consumption: { type: 'number', minVal: 0, required: true }, bands: { type: 'array', required: true }, fees: { type: 'array', default: [] },
    fixed_charge: { type: 'number', default: 0 }, tax_pct: { type: 'number', default: 0 }, minimum_charge: { type: 'number', default: 0 } });
  return require('../services/billing').computeCharges({ ...b, bands_json: JSON.stringify(checkBands(b.bands)), fees_json: JSON.stringify(checkFees(b.fees)) }, b.consumption);
});

// ---------------- Settings & exchange rates ----------------
const SETTING_KEYS = { org_name: { type: 'string', max: 120 }, default_due_days: { type: 'integer', minVal: 1, maxVal: 120 }, high_consumption_factor: { type: 'number', minVal: 1.1, maxVal: 20 },
  long_gap_days: { type: 'integer', minVal: 7, maxVal: 365 }, max_daily_m3_household: { type: 'number', minVal: 0.1 }, gps_capture_enabled: { type: 'boolean' }, photo_required: { type: 'boolean' },
  session_hours: { type: 'integer', minVal: 1, maxVal: 72 }, backup_retention: { type: 'integer', minVal: 1, maxVal: 365 }, report_conversion_currency: { type: 'currency' },
  sms_notifications: { type: 'boolean' }, momo_mtn_merchant: { type: 'string', max: 40 }, momo_orange_merchant: { type: 'string', max: 40 }, ussd_code: { type: 'string', max: 20 },
  unbilled_authorized_pct: { type: 'number', minVal: 0, maxVal: 20 }, meter_under_registration_pct: { type: 'number', minVal: 0, maxVal: 30 }, unauthorized_consumption_pct: { type: 'number', minVal: 0, maxVal: 30 },
  ocr_mismatch_tolerance: { type: 'number', minVal: 0, maxVal: 100 },
  reminder_days_before_due: { type: 'integer', minVal: 0, maxVal: 30 }, reminder_days_overdue: { type: 'integer', minVal: 1, maxVal: 90 }, plan_default_after_days: { type: 'integer', minVal: 7, maxVal: 180 }, auto_reminders: { type: 'boolean' },
  affordability_threshold_pct: { type: 'number', minVal: 0.5, maxVal: 20 }, median_household_income_LRD: { type: 'number', minVal: 0 }, median_household_income_USD: { type: 'number', minVal: 0 },
  avg_household_size: { type: 'number', minVal: 1, maxVal: 30 }, lifeline_lpcd: { type: 'number', minVal: 5, maxVal: 200 }, briefing_sms_phone: { type: 'string', max: 30 }, public_status_enabled: { type: 'boolean' },
  wq_sampling_days: { type: 'integer', minVal: 1, maxVal: 90 },
  connection_base_fee: { type: 'number', minVal: 0 }, connection_pipe_cost_per_m: { type: 'number', minVal: 0 }, connection_meter_cost: { type: 'number', minVal: 0 }, connection_max_instalments: { type: 'integer', minVal: 0, maxVal: 36 },
  require_2fa_roles: { type: 'string', max: 120, pattern: /^[a-z_, ]*$/, patternMsg: 'comma-separated role codes e.g. admin,cashier' },
  country_code: { type: 'string', pattern: /^[A-Z]{2}$/, patternMsg: 'two-letter ISO code' }, country_name: { type: 'string', max: 60 }, phone_prefix: { type: 'string', pattern: /^\+\d{1,4}$/, patternMsg: 'like +231' },
  phone_digits: { type: 'integer', minVal: 6, maxVal: 12 }, timezone: { type: 'string', max: 60 }, default_language: { type: 'string', max: 10 }, currencies: { type: 'string', max: 60, pattern: /^[A-Za-z]{3}( *, *[A-Za-z]{3})*$/, patternMsg: 'ISO codes separated by commas, e.g. USD,LRD' },
  currency_symbols: { type: 'string', max: 200 }, momo_providers: { type: 'string', max: 300, pattern: /^([a-z][a-z0-9]*=[^;=]{1,40})?(;[a-z][a-z0-9]*=[^;=]{1,40})*$/, patternMsg: 'code=Name pairs separated by ;, e.g. mpesa=M-Pesa;airtel=Airtel Money' },
  region_label: { type: 'string', max: 30 }, sms_gsm7_only: { type: 'boolean' },
  supply_sms_enabled: { type: 'boolean' }, supply_notice_hours: { type: 'number', minVal: 0.5, maxVal: 24 }, feedback_sms_enabled: { type: 'boolean' },
  meter_wear_pct_per_year: { type: 'number', minVal: 0, maxVal: 10 }, meter_wear_start_years: { type: 'number', minVal: 0, maxVal: 30 }, meter_life_years: { type: 'number', minVal: 1, maxVal: 40 },
  meter_life_volume_m3: { type: 'number', minVal: 0 }, meter_max_under_registration_pct: { type: 'number', minVal: 0, maxVal: 60 }, meter_replacement_labour_usd: { type: 'number', minVal: 0 } };
route('GET', '/api/settings', { perm: 'settings.manage' }, () => Object.fromEntries(db.all("SELECT key, value FROM settings WHERE key NOT LIKE 'seq_%' AND key NOT LIKE '%_hash'").map(r => [r.key, r.value])));
route('PUT', '/api/settings', { perm: 'settings.manage' }, ctx => {
  const merchants = Object.keys(ctx.body).filter(k => /^momo_[a-z][a-z0-9]*_merchant$/.test(k));
  const b = validate(ctx.body, { ...SETTING_KEYS, ...Object.fromEntries(merchants.map(k => [k, { type: 'string', max: 40 }])) }, { partial: true });
  if (b.currencies) { b.currencies = b.currencies.toUpperCase().replace(/ /g, ''); const used = db.all('SELECT DISTINCT currency FROM service_areas').map(r => r.currency).filter(c => !b.currencies.split(',').includes(c)); if (used.length) throw new HttpError(400, `Currencies in use by service areas cannot be removed: ${used.join(', ')}`); }
  if (b.timezone && !require('../lib/tz').valid(b.timezone)) throw new HttpError(400, 'Unknown time zone — use an IANA name such as Africa/Monrovia');
  if (b.default_language && !require('../lib/i18n').isLang(b.default_language)) throw new HttpError(400, 'Unknown or disabled language');
  // A field sent empty clears the setting (e.g. removing the 2FA role requirement); fields not sent are left alone.
  for (const [k, v0] of Object.entries(b)) { const v = v0 === null && Object.prototype.hasOwnProperty.call(ctx.body, k) ? '' : v0; if (v !== null) db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); }
  audit.log(ctx, 'settings.update', 'settings', null, b); return { ok: true };
});
route('GET', '/api/exchange-rates', { anyPerm: ['settings.manage', 'billing.view', 'dashboard.view'] }, () => db.all('SELECT e.*, u.full_name created_by_name FROM exchange_rates e LEFT JOIN users u ON u.id=e.created_by ORDER BY effective_date DESC, id DESC'));
route('POST', '/api/exchange-rates', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { from_currency: { type: 'currency', required: true }, to_currency: { type: 'currency', required: true },
    rate: { type: 'number', required: true, minVal: 0.000001 }, effective_date: { type: 'date', required: true }, source_note: { type: 'string', required: true, max: 200 } });
  if (b.from_currency === b.to_currency) throw new HttpError(400, 'Currencies must differ');
  const r = db.run('INSERT INTO exchange_rates(from_currency,to_currency,rate,effective_date,source_note,created_by) VALUES (?,?,?,?,?,?)', b.from_currency, b.to_currency, b.rate, b.effective_date, b.source_note, ctx.user.id);
  audit.log(ctx, 'exchange_rate.create', 'exchange_rate', r.id, b); return { id: r.id };
});

// ---------------- Meter models (capability registry) ----------------
route('GET', '/api/meter-models', { anyPerm: ['meters.view', 'meters.manage'] }, () => db.all('SELECT * FROM meter_models ORDER BY manufacturer, model'));
route('POST', '/api/meter-models', { perm: 'meters.manage' }, ctx => {
  const b = validate(ctx.body, { manufacturer: { type: 'string', required: true, max: 80 }, model: { type: 'string', required: true, max: 80 },
    meter_type: { type: 'enum', values: ['mechanical', 'ultrasonic', 'electromagnetic', 'prepaid', 'bulk'], required: true }, sizes_mm: { type: 'string', max: 80 },
    supported_methods: { type: 'array', required: true }, pulse_liters: { type: 'number', minVal: 0.001 }, notes: { type: 'text', max: 1000 } });
  if (b.supported_methods.some(m => !METHODS.includes(m))) throw new HttpError(400, 'Unknown reading method');
  const r = db.run('INSERT INTO meter_models(manufacturer, model, meter_type, sizes_mm, supported_methods, pulse_liters, notes) VALUES (?,?,?,?,?,?,?)',
    b.manufacturer, b.model, b.meter_type, b.sizes_mm, JSON.stringify(b.supported_methods), b.pulse_liters, b.notes);
  audit.log(ctx, 'meter_model.create', 'meter_model', r.id, b); return { id: r.id };
});

// ---------------- Service notices ----------------
route('GET', '/api/notices', { anyPerm: STAFF }, () => db.all('SELECT n.*, a.name area_name FROM service_notices n LEFT JOIN service_areas a ON a.id=n.area_id ORDER BY n.created_at DESC'));
route('POST', '/api/notices', { perm: 'notices.manage' }, ctx => {
  const b = validate(ctx.body, { title: { type: 'string', required: true, max: 120 }, body: { type: 'text', required: true, max: 2000 }, area_id: { type: 'integer' },
    notice_type: { type: 'enum', values: ['outage', 'maintenance', 'tariff', 'billing', 'general', 'quality'], default: 'general' }, starts_at: { type: 'date' }, ends_at: { type: 'date' }, sms_broadcast: { type: 'boolean', default: false } });
  const r = db.run('INSERT INTO service_notices(title, body, area_id, notice_type, starts_at, ends_at, created_by) VALUES (?,?,?,?,?,?,?)', b.title, b.body, b.area_id, b.notice_type, b.starts_at, b.ends_at, ctx.user.id);
  let sent = 0;
  if (b.sms_broadcast) {
    if (!b.area_id) throw new HttpError(400, 'Choose an area to send SMS to');
    sent = require('../services/community').broadcast(b.area_id, `${require('../services/channels').short()}: ${b.title}. ${b.body}`.slice(0, 480), 'notice');
  }
  audit.log(ctx, 'notice.create', 'notice', r.id, { title: b.title, sms_sent: sent }); return { id: r.id, sms_sent: sent };
});

// ---------------- Alert rules ----------------
route('GET', '/api/alert-rules', { anyPerm: ['alerts.view', 'settings.manage'] }, () => { alerts.ensureRules(); return db.all('SELECT * FROM alert_rules ORDER BY id'); });
route('PUT', '/api/alert-rules/:id', { perm: 'settings.manage' }, ctx => {
  const rid = id(ctx.params.id);
  const b = validate(ctx.body, { enabled: { type: 'boolean', required: true }, severity: { type: 'enum', values: ['low', 'medium', 'high', 'critical'], required: true }, params: { type: 'json', required: true } });
  const before = db.get('SELECT * FROM alert_rules WHERE id=?', rid); if (!before) throw new HttpError(404, 'Not found');
  const old = JSON.parse(before.params_json);
  for (const k of Object.keys(b.params)) { if (!(k in old)) throw new HttpError(400, 'Unknown parameter ' + k); if (!Number.isFinite(Number(b.params[k])) || Number(b.params[k]) < 0) throw new HttpError(400, `${k} must be a positive number`); b.params[k] = Number(b.params[k]); }
  db.run('UPDATE alert_rules SET enabled=?, severity=?, params_json=? WHERE id=?', b.enabled, b.severity, JSON.stringify({ ...old, ...b.params }), rid);
  audit.log(ctx, 'alert_rule.update', 'alert_rule', rid, { before: { enabled: before.enabled, severity: before.severity, params: old }, after: b }); return { ok: true };
});

// ---------------- Integrations ----------------
const integSchema = { name: { type: 'string', required: true, max: 120 }, method: { type: 'enum', values: METHODS.filter(m => !['manual', 'csv', 'simulator'].includes(m)), required: true },
  adapter: { type: 'enum', values: Object.keys(integ.ADAPTERS).filter(a => integ.ADAPTERS[a].normalize), required: true },
  vendor: { type: 'string', max: 120 }, meter_model: { type: 'string', max: 200 }, comm_band: { type: 'string', max: 200 }, protocol: { type: 'string', max: 200 },
  data_format: { type: 'text', max: 2000 }, encryption: { type: 'text', max: 1000 }, docs_url: { type: 'string', max: 400 }, vendor_access: { type: 'text', max: 2000 },
  network_server: { type: 'string', max: 200 }, field_mapping: { type: 'json' }, notes: { type: 'text', max: 2000 } };
function integView(i) {
  const missing = i.is_simulator ? [] : integ.missingInfo(i);
  const { api_key_hash, ...rest } = i;
  return { ...rest, has_api_key: !!api_key_hash, status_label: integ.statusLabel(i), missing_info: missing, adapter_label: integ.ADAPTERS[i.adapter]?.label,
    default_mapping: integ.ADAPTERS[i.adapter]?.defaultMapping || null, meters: db.get('SELECT COUNT(*) n FROM meters WHERE integration_id=?', i.id).n,
    ingest_url: `/api/ingest/${i.id}` };
}
route('GET', '/api/integrations', { anyPerm: ['integrations.view', 'integrations.manage'] }, () => ({
  integrations: db.all('SELECT * FROM integrations ORDER BY is_simulator DESC, name').map(integView),
  required_info: integ.REQUIRED_INFO, adapters: Object.entries(integ.ADAPTERS).map(([k, a]) => ({ key: k, label: a.label, methods: a.methods, inbound: !!a.normalize, defaultMapping: a.defaultMapping || null })),
  built_in: [{ method: 'manual', status: 'Available — no device connection needed' }, { method: 'csv', status: 'Available — upload in Readings › Import' }]
}));
route('GET', '/api/integrations/:id/messages', { perm: 'integrations.manage' }, ctx => db.all('SELECT * FROM integration_messages WHERE integration_id=? ORDER BY id DESC LIMIT 50', id(ctx.params.id)));
route('POST', '/api/integrations', { perm: 'integrations.manage' }, ctx => {
  const b = validate(ctx.body, integSchema);
  const status = integ.missingInfo(b).length ? 'info_required' : 'ready_for_implementation';
  const r = db.run(`INSERT INTO integrations(name, method, adapter, vendor, meter_model, comm_band, protocol, data_format, encryption, docs_url, vendor_access, network_server, field_mapping, notes, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.name, b.method, b.adapter, b.vendor, b.meter_model, b.comm_band, b.protocol, b.data_format, b.encryption, b.docs_url, b.vendor_access, b.network_server, b.field_mapping ? JSON.stringify(b.field_mapping) : null, b.notes, status);
  audit.log(ctx, 'integration.create', 'integration', r.id, { name: b.name, method: b.method, status }); return { id: r.id };
});
route('PUT', '/api/integrations/:id', { perm: 'integrations.manage' }, ctx => {
  const iid = id(ctx.params.id);
  const before = db.get('SELECT * FROM integrations WHERE id=?', iid); if (!before) throw new HttpError(404, 'Not found');
  if (before.is_simulator) throw new HttpError(400, 'The simulator cannot be edited');
  const b = validate(ctx.body, integSchema);
  const technicalChange = ['adapter', 'meter_model', 'comm_band', 'protocol', 'data_format', 'encryption'].some(k => (before[k] || '') !== (b[k] || '')) || (before.field_mapping || null) !== (b.field_mapping ? JSON.stringify(b.field_mapping) : null);
  let status = before.status;
  if (integ.missingInfo(b).length) status = 'info_required';
  else if (status === 'info_required') status = 'ready_for_implementation';
  if (technicalChange && status === 'verified') status = 'configured_unverified'; // any technical change requires re-verification
  db.run(`UPDATE integrations SET name=?, method=?, adapter=?, vendor=?, meter_model=?, comm_band=?, protocol=?, data_format=?, encryption=?, docs_url=?, vendor_access=?, network_server=?, field_mapping=?, notes=?, status=?,
    verified_at = CASE WHEN ?='verified' THEN verified_at ELSE NULL END WHERE id=?`, b.name, b.method, b.adapter, b.vendor, b.meter_model, b.comm_band, b.protocol, b.data_format, b.encryption, b.docs_url,
    b.vendor_access, b.network_server, b.field_mapping ? JSON.stringify(b.field_mapping) : null, b.notes, status, status, iid);
  if (status === 'info_required') db.run('UPDATE integrations SET api_key_hash=NULL, api_key_hint=NULL WHERE id=?', iid);
  audit.log(ctx, 'integration.update', 'integration', iid, { status_before: before.status, status_after: status, technicalChange }); return { ok: true, status };
});
route('POST', '/api/integrations/:id/api-key', { perm: 'integrations.manage' }, ctx => ({ api_key: integ.issueKey(ctx, id(ctx.params.id)), note: 'Shown once. Store it in the network server / gateway configuration as header X-Api-Key.' }));
route('POST', '/api/integrations/:id/verify', { perm: 'integrations.manage' }, ctx => { integ.verify(ctx, id(ctx.params.id), String(ctx.body.note || '').trim()); return { ok: true }; });
route('POST', '/api/integrations/:id/disable', { perm: 'integrations.manage' }, ctx => {
  const iid = id(ctx.params.id);
  db.run(`UPDATE integrations SET status='disabled', api_key_hash=NULL WHERE id=? AND is_simulator=0`, iid);
  audit.log(ctx, 'integration.disable', 'integration', iid); return { ok: true };
});
route('POST', '/api/integrations/:id/simulate', { perm: 'integrations.manage' }, ctx => {
  const b = validate(ctx.body, { scenario: { type: 'enum', values: ['normal', 'leak', 'reverse_flow', 'tamper', 'low_battery'], default: 'normal' }, meter_id: { type: 'integer' }, hours: { type: 'integer', minVal: 4, maxVal: 168, default: 24 } });
  return integ.simulate(ctx, id(ctx.params.id), b);
});
// Inbound endpoint for network servers / gateways / collectors (machine-to-machine, API-key auth, no cookies).
route('POST', '/api/ingest/:id', { machine: true, arrayBody: true }, ctx => integ.ingest(ctx, id(ctx.params.id), ctx.req.headers['x-api-key'], ctx.body));

// ---------------- Audit log & backups ----------------
route('GET', '/api/audit', { perm: 'audit.view' }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (q.entity) { where.push('entity=?'); p.push(q.entity); }
  if (q.entity_id) { where.push('entity_id=?'); p.push(q.entity_id); }
  if (q.action) { where.push('action LIKE ?'); p.push(q.action + '%'); }
  if (q.user) { where.push('username LIKE ?'); p.push('%' + q.user + '%'); }
  if (q.from) { where.push('at >= ?'); p.push(q.from); }
  if (q.to) { where.push('at <= ?'); p.push(q.to + 'T23:59:59Z'); }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(Number(q.limit) || 200, 5000)}`;
  const rows = db.all(sql, ...p);
  if (q.format === 'csv') return csvResponse('audit-log.csv', csv.stringify(rows, ['id', 'at', 'username', 'role', 'action', 'entity', 'entity_id', 'details', 'ip', 'hash']));
  return rows;
});
route('GET', '/api/audit/verify', { perm: 'audit.view' }, () => require('../lib/audit').verify());
const BK = path.join(db.DATA_DIR, 'backups');
route('GET', '/api/backups', { perm: 'backups.manage' }, () => fs.readdirSync(BK).filter(f => f.endsWith('.db')).sort().reverse().map(f => ({ file: f, size: fs.statSync(path.join(BK, f)).size, created: fs.statSync(path.join(BK, f)).mtime })));
route('POST', '/api/backups', { perm: 'backups.manage' }, ctx => { const f = db.backup('manual'); audit.log(ctx, 'backup.create', 'backup', f); return { file: f }; });
route('GET', '/api/backups/:file', { perm: 'backups.manage' }, ctx => {
  const f = path.basename(ctx.params.file);
  if (!/^aquatrack-[\w-]+\.db$/.test(f) || !fs.existsSync(path.join(BK, f))) throw new HttpError(404, 'Backup not found');
  audit.log(ctx, 'backup.download', 'backup', f);
  return { __raw: true, body: fs.readFileSync(path.join(BK, f)), headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f}"` } };
});
