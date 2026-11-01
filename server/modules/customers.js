'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { route, HttpError } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const db = require('../lib/db');
const csv = require('../lib/csv');
const readings = require('../services/readings');
const billing = require('../services/billing');

const CUSTOMER_TYPES = ['household', 'business', 'institution', 'public_water_point', 'bulk'];
const METHODS = ['manual', 'csv', 'pulse', 'lorawan', 'nbiot', 'cellular', 'wmbus', 'serial', 'vendor_api', 'simulator'];
const INFO_FLAGS = ['offline_capture', 'simulated']; // informational only — do not block bulk approval
const event = (ctx, cid, type, desc) => db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', cid, type, desc, ctx.user ? ctx.user.id : null);

// ================= Customers =================
const custSchema = {
  name: { type: 'string', required: true, max: 150 }, customer_type: { type: 'enum', values: CUSTOMER_TYPES, required: true },
  contact_person: { type: 'string', max: 120 }, phone: { type: 'phone' }, email: { type: 'email' }, address: { type: 'string', required: true, max: 250 }, landmark: { type: 'string', max: 200 },
  area_id: { type: 'integer', required: true }, lat: { type: 'lat' }, lng: { type: 'lng' }, gps_source: { type: 'enum', values: ['device_gps', 'map', 'survey', 'unknown'] },
  status: { type: 'enum', values: ['pending', 'active', 'suspended', 'disconnected', 'closed'], default: 'active' },
  billing_mode: { type: 'enum', values: ['postpaid', 'prepaid'], default: 'postpaid' }, notes: { type: 'text', max: 2000 },
  essential_service: { type: 'boolean', default: false }, household_size: { type: 'integer', minVal: 1, maxVal: 100 }, supply_zone: { type: 'string', max: 60 }, supply_sms: { type: 'boolean', default: true }, language: { type: 'string', max: 10 }
};
route('GET', '/api/customers', { anyPerm: ['customers.view', 'customers.lookup'] }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (q.q) { where.push('(c.name LIKE ? OR c.customer_number LIKE ? OR c.phone LIKE ? OR c.address LIKE ? OR m.serial_number LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s, s, s); }
  if (q.area_id) { where.push('c.area_id=?'); p.push(Number(q.area_id)); }
  if (q.customer_type) { where.push('c.customer_type=?'); p.push(q.customer_type); }
  if (q.status) { where.push('c.status=?'); p.push(q.status); }
  if (ctx.user.area_id && !auth.can(ctx.user, 'customers.view')) { where.push('c.area_id=?'); p.push(ctx.user.area_id); }
  const lookupOnly = !auth.can(ctx.user, 'customers.view');
  const rows = db.all(`SELECT c.*, a.name area_name, a.currency, m.serial_number, m.id meter_id, m.status meter_status, m.comm_method FROM customers c JOIN service_areas a ON a.id=c.area_id
    LEFT JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.customer_number LIMIT ${Math.min(Number(q.limit) || 500, 2000)}`, ...p);
  return rows.map(r => {
    if (lookupOnly) return { id: r.id, customer_number: r.customer_number, name: r.name, address: r.address, landmark: r.landmark, area_name: r.area_name, customer_type: r.customer_type, status: r.status, serial_number: r.serial_number, meter_id: r.meter_id, lat: r.lat, lng: r.lng };
    return { ...r, balance: billing.balance(r.id) };
  });
});
route('GET', '/api/customers/:id', { anyPerm: ['customers.view', 'customers.lookup'] }, ctx => {
  const cid = id(ctx.params.id);
  const c = db.get('SELECT c.*, a.name area_name, a.currency, a.code area_code FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', cid);
  if (!c) throw new HttpError(404, 'Customer not found');
  const meters = db.all('SELECT * FROM meters WHERE customer_id=? ORDER BY id DESC', cid);
  const assignments = db.all('SELECT ma.*, m.serial_number FROM meter_assignments ma JOIN meters m ON m.id=ma.meter_id WHERE ma.customer_id=? ORDER BY ma.assigned_at DESC', cid);
  if (!auth.can(ctx.user, 'customers.view')) return { customer: { id: c.id, customer_number: c.customer_number, name: c.name, address: c.address, landmark: c.landmark, area_name: c.area_name, lat: c.lat, lng: c.lng, customer_type: c.customer_type, status: c.status }, meters };
  return {
    customer: c, meters, assignments, balance: billing.balance(cid),
    readings: db.all(`SELECT r.*, m.serial_number, u.full_name reader_name FROM readings r JOIN meters m ON m.id=r.meter_id LEFT JOIN users u ON u.id=r.reader_user_id WHERE r.customer_id=? ORDER BY r.reading_at DESC LIMIT 50`, cid),
    bills: db.all('SELECT * FROM bills WHERE customer_id=? ORDER BY period_end DESC', cid),
    payments: db.all('SELECT p.*, u.full_name received_by_name FROM payments p LEFT JOIN users u ON u.id=p.received_by WHERE p.customer_id=? ORDER BY p.received_at DESC', cid),
    adjustments: db.all('SELECT * FROM adjustments WHERE customer_id=? ORDER BY created_at DESC', cid),
    events: db.all('SELECT e.*, u.full_name user_name FROM customer_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.customer_id=? ORDER BY e.id DESC LIMIT 100', cid),
    alerts: db.all('SELECT * FROM alerts WHERE customer_id=? ORDER BY detected_at DESC LIMIT 20', cid),
    work_orders: db.all('SELECT * FROM work_orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 20', cid)
  };
});
route('POST', '/api/customers', { perm: 'customers.manage' }, ctx => {
  const b = validate(ctx.body, custSchema);
  const area = db.get('SELECT * FROM service_areas WHERE id=?', b.area_id); if (!area) throw new HttpError(400, 'Unknown service area');
  return db.tx(() => require('../services/accounts').createCustomer(ctx, b));
});
route('PUT', '/api/customers/:id', { perm: 'customers.manage' }, ctx => {
  const cid = id(ctx.params.id);
  const before = db.get('SELECT * FROM customers WHERE id=?', cid); if (!before) throw new HttpError(404, 'Customer not found');
  const b = validate(ctx.body, custSchema);
  if (before.area_id !== b.area_id) {
    const a1 = db.get('SELECT currency FROM service_areas WHERE id=?', before.area_id), a2 = db.get('SELECT currency FROM service_areas WHERE id=?', b.area_id);
    if (a1.currency !== a2.currency && db.get('SELECT 1 FROM bills WHERE customer_id=? LIMIT 1', cid)) throw new HttpError(409, 'Cannot move a billed account to an area with a different currency');
  }
  db.run(`UPDATE customers SET name=?, customer_type=?, contact_person=?, phone=?, email=?, address=?, landmark=?, area_id=?, lat=?, lng=?, gps_source=?, status=?, billing_mode=?, notes=?, essential_service=?, household_size=?, supply_zone=?, supply_sms=?, language=?, updated_at=datetime('now') WHERE id=?`,
    b.name, b.customer_type, b.contact_person, b.phone, b.email, b.address, b.landmark, b.area_id, b.lat, b.lng, b.lat != null ? (b.gps_source || before.gps_source || 'unknown') : null, b.status, b.billing_mode, b.notes, b.essential_service, b.household_size, b.supply_zone || null, b.supply_sms === false ? 0 : 1, b.language && require('../lib/i18n').isLang(b.language) ? b.language : null, cid);
  const changed = Object.keys(b).filter(k => String(before[k] ?? '') !== String(b[k] ?? ''));
  if (changed.length) event(ctx, cid, before.status !== b.status ? 'status' : 'update', `Updated: ${changed.join(', ')}${before.status !== b.status ? ` (status ${before.status} → ${b.status})` : ''}`);
  audit.log(ctx, 'customer.update', 'customer', cid, { changed, before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, b[k]])) });
  return { ok: true };
});

// ================= Meters =================
const meterSchema = {
  serial_number: { type: 'string', required: true, max: 60, pattern: /^[A-Za-z0-9._\/-]+$/, patternMsg: 'letters, digits . _ / -' }, manufacturer: { type: 'string', required: true, max: 80 },
  model: { type: 'string', required: true, max: 80 }, model_id: { type: 'integer' }, meter_type: { type: 'enum', values: ['mechanical', 'ultrasonic', 'electromagnetic', 'prepaid', 'bulk'], required: true },
  size_mm: { type: 'integer', required: true, minVal: 10, maxVal: 1200 }, install_date: { type: 'date' }, initial_reading: { type: 'number', minVal: 0, default: 0 },
  lat: { type: 'lat' }, lng: { type: 'lng' }, location_desc: { type: 'string', max: 200 }, area_id: { type: 'integer' }, asset_id: { type: 'integer' }, is_bulk: { type: 'boolean', default: false },
  status: { type: 'enum', values: ['in_stock', 'active', 'faulty', 'removed', 'replaced'], default: 'in_stock' }, comm_method: { type: 'enum', values: METHODS, default: 'manual' },
  integration_id: { type: 'integer' }, device_id: { type: 'string', max: 80 }, pulse_liters: { type: 'number', minVal: 0.001 }
};
function checkMeter(b) {
  if (b.model_id) {
    const mm = db.get('SELECT * FROM meter_models WHERE id=?', b.model_id);
    if (!mm) throw new HttpError(400, 'Unknown meter model');
    const sup = JSON.parse(mm.supported_methods);
    if (!sup.includes(b.comm_method)) throw new HttpError(400, `${mm.manufacturer} ${mm.model} is not registered as supporting "${b.comm_method}". Supported: ${sup.join(', ')}. Update the model capabilities only after confirming with the vendor.`);
    if (b.comm_method === 'pulse' && !b.pulse_liters) b.pulse_liters = mm.pulse_liters;
  }
  if (!['manual', 'csv'].includes(b.comm_method)) {
    if (!b.integration_id) throw new HttpError(400, `Meters read via ${b.comm_method} must be linked to an integration profile (Admin › Integrations).`);
    const i = db.get('SELECT * FROM integrations WHERE id=?', b.integration_id);
    if (!i) throw new HttpError(400, 'Unknown integration');
    if (b.comm_method === 'simulator' ? !i.is_simulator : i.method !== b.comm_method) throw new HttpError(400, `Integration "${i.name}" is for ${i.method}, not ${b.comm_method}`);
    if (!b.device_id && !i.is_simulator) throw new HttpError(400, 'Device ID / DevEUI / module ID is required for communicating meters');
    if (b.comm_method === 'pulse' && !b.pulse_liters) throw new HttpError(400, 'Litres per pulse is required for pulse-output meters');
  } else { b.integration_id = null; }
}
route('GET', '/api/meters', { perm: 'meters.view' }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (q.q) { where.push('(m.serial_number LIKE ? OR m.device_id LIKE ? OR c.name LIKE ? OR c.customer_number LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s, s); }
  if (q.status) { where.push('m.status=?'); p.push(q.status); }
  if (q.comm_method) { where.push('m.comm_method=?'); p.push(q.comm_method); }
  if (q.area_id) { where.push('COALESCE(c.area_id, m.area_id)=?'); p.push(Number(q.area_id)); }
  if (q.unassigned) where.push('m.customer_id IS NULL');
  return db.all(`SELECT m.*, c.name customer_name, c.customer_number, i.name integration_name, i.status integration_status, a.name area_name FROM meters m
    LEFT JOIN customers c ON c.id=m.customer_id LEFT JOIN integrations i ON i.id=m.integration_id LEFT JOIN service_areas a ON a.id=COALESCE(c.area_id, m.area_id)
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.serial_number LIMIT 2000`, ...p);
});
route('GET', '/api/meters/:id', { perm: 'meters.view' }, ctx => {
  const mid = id(ctx.params.id);
  const m = db.get(`SELECT m.*, c.name customer_name, c.customer_number, i.name integration_name, i.status integration_status FROM meters m LEFT JOIN customers c ON c.id=m.customer_id LEFT JOIN integrations i ON i.id=m.integration_id WHERE m.id=?`, mid);
  if (!m) throw new HttpError(404, 'Meter not found');
  return { meter: m, readings: db.all('SELECT r.*, u.full_name reader_name FROM readings r LEFT JOIN users u ON u.id=r.reader_user_id WHERE meter_id=? ORDER BY reading_at DESC LIMIT 100', mid),
    assignments: db.all('SELECT ma.*, c.name customer_name, c.customer_number FROM meter_assignments ma JOIN customers c ON c.id=ma.customer_id WHERE meter_id=? ORDER BY assigned_at DESC', mid) };
});
route('POST', '/api/meters', { perm: 'meters.manage' }, ctx => {
  const b = validate(ctx.body, { ...meterSchema, customer_id: { type: 'integer' } });
  checkMeter(b);
  return db.tx(() => {
    const r = db.run(`INSERT INTO meters(serial_number, manufacturer, model, model_id, meter_type, size_mm, install_date, initial_reading, lat, lng, location_desc, area_id, asset_id, is_bulk, status, comm_method, integration_id, device_id, pulse_liters)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.serial_number, b.manufacturer, b.model, b.model_id, b.meter_type, b.size_mm, b.install_date, b.initial_reading, b.lat, b.lng, b.location_desc,
      b.area_id, b.asset_id, b.is_bulk, b.customer_id ? 'in_stock' : b.status, b.comm_method, b.integration_id, b.device_id, b.pulse_liters);
    audit.log(ctx, 'meter.create', 'meter', r.id, b);
    if (b.customer_id) assign(ctx, r.id, b.customer_id, b.initial_reading, b.install_date, 'New installation');
    return { id: r.id };
  });
});
route('PUT', '/api/meters/:id', { perm: 'meters.manage' }, ctx => {
  const mid = id(ctx.params.id);
  const before = db.get('SELECT * FROM meters WHERE id=?', mid); if (!before) throw new HttpError(404, 'Meter not found');
  const b = validate(ctx.body, meterSchema);
  checkMeter(b);
  if (before.serial_number !== b.serial_number && db.get('SELECT 1 FROM readings WHERE meter_id=? LIMIT 1', mid)) throw new HttpError(409, 'Serial number cannot change once readings exist');
  if (before.initial_reading !== b.initial_reading && db.get('SELECT 1 FROM readings WHERE meter_id=? LIMIT 1', mid)) throw new HttpError(409, 'Initial reading cannot change once readings exist');
  db.run(`UPDATE meters SET serial_number=?, manufacturer=?, model=?, model_id=?, meter_type=?, size_mm=?, install_date=?, initial_reading=?, lat=?, lng=?, location_desc=?, area_id=?, asset_id=?, is_bulk=?, status=?, comm_method=?, integration_id=?, device_id=?, pulse_liters=? WHERE id=?`,
    b.serial_number, b.manufacturer, b.model, b.model_id, b.meter_type, b.size_mm, b.install_date, b.initial_reading, b.lat, b.lng, b.location_desc, b.area_id, b.asset_id, b.is_bulk, b.status, b.comm_method, b.integration_id, b.device_id, b.pulse_liters, mid);
  const changed = Object.keys(b).filter(k => String(before[k] ?? '') !== String(b[k] ?? ''));
  audit.log(ctx, 'meter.update', 'meter', mid, { changed, before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, b[k]])) });
  if (before.customer_id && before.status !== b.status) event(ctx, before.customer_id, 'meter', `Meter ${b.serial_number} status ${before.status} → ${b.status}`);
  return { ok: true };
});
route('POST', '/api/meters/:id/status', { anyPerm: ['meters.manage', 'meters.status'] }, ctx => {
  const mid = id(ctx.params.id);
  const b = validate(ctx.body, { status: { type: 'enum', values: ['active', 'faulty'], required: true }, note: { type: 'string', required: true, max: 300 } });
  const m = db.get('SELECT * FROM meters WHERE id=?', mid); if (!m) throw new HttpError(404, 'Meter not found');
  if (!['active', 'faulty'].includes(m.status)) throw new HttpError(409, 'Only active/faulty meters can be toggled here');
  db.run('UPDATE meters SET status=? WHERE id=?', b.status, mid);
  if (m.customer_id) event(ctx, m.customer_id, 'meter', `Meter ${m.serial_number} marked ${b.status}: ${b.note}`);
  audit.log(ctx, 'meter.status', 'meter', mid, { from: m.status, to: b.status, note: b.note }); return { ok: true };
});
function assign(ctx, meterId, customerId, startReading, date, reason) {
  const m = db.get('SELECT * FROM meters WHERE id=?', meterId);
  const c = db.get('SELECT * FROM customers WHERE id=?', customerId); if (!c) throw new HttpError(400, 'Unknown customer');
  if (m.customer_id) throw new HttpError(409, 'Meter is already assigned. Remove it from the current account first.');
  const existing = db.get(`SELECT serial_number FROM meters WHERE customer_id=? AND status IN ('active','faulty')`, customerId);
  if (existing) throw new HttpError(409, `Customer already has active meter ${existing.serial_number}. Remove or replace it first.`);
  const at = date ? date + 'T00:00:00.000Z' : new Date().toISOString();
  db.run(`UPDATE meters SET customer_id=?, status='active', area_id=?, install_date=COALESCE(install_date, ?) WHERE id=?`, customerId, c.area_id, at.slice(0, 10), meterId);
  db.run('INSERT INTO meter_assignments(meter_id, customer_id, assigned_at, start_reading, reason, user_id) VALUES (?,?,?,?,?,?)', meterId, customerId, at, startReading ?? m.initial_reading, reason, ctx.user.id);
  event(ctx, customerId, 'meter', `Meter ${m.serial_number} assigned (start reading ${startReading ?? m.initial_reading} m³)`);
  audit.log(ctx, 'meter.assign', 'meter', meterId, { customer: c.customer_number, start_reading: startReading ?? m.initial_reading });
}
route('POST', '/api/meters/:id/assign', { perm: 'meters.manage' }, ctx => {
  const b = validate(ctx.body, { customer_id: { type: 'integer', required: true }, start_reading: { type: 'number', minVal: 0 }, date: { type: 'date' }, reason: { type: 'string', max: 200 } });
  db.tx(() => assign(ctx, id(ctx.params.id), b.customer_id, b.start_reading, b.date, b.reason || 'Assignment')); return { ok: true };
});
route('POST', '/api/meters/:id/remove', { perm: 'meters.manage' }, ctx => {
  const mid = id(ctx.params.id);
  const b = validate(ctx.body, { end_reading: { type: 'number', minVal: 0, required: true }, reason: { type: 'string', required: true, max: 200 }, new_status: { type: 'enum', values: ['removed', 'replaced', 'in_stock', 'faulty'], default: 'removed' } });
  return db.tx(() => {
    const m = db.get('SELECT * FROM meters WHERE id=?', mid); if (!m || !m.customer_id) throw new HttpError(409, 'Meter is not assigned');
    // record the final reading so it can be billed
    readings.create(ctx, { meter_id: mid, value: b.end_reading, reading_at: new Date().toISOString(), source: 'manual', reader_user_id: ctx.user.id, notes: 'Final reading at removal: ' + b.reason });
    db.run(`UPDATE meter_assignments SET removed_at=?, end_reading=? WHERE meter_id=? AND removed_at IS NULL`, new Date().toISOString(), b.end_reading, mid);
    event(ctx, m.customer_id, 'meter', `Meter ${m.serial_number} removed (${b.reason}), final reading ${b.end_reading}`);
    db.run('UPDATE meters SET customer_id=NULL, status=? WHERE id=?', b.new_status, mid);
    audit.log(ctx, 'meter.remove', 'meter', mid, b); return { ok: true };
  });
});

// ================= Readings =================
const UPLOAD = path.join(db.DATA_DIR, 'uploads');
function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, 'Photo must be a JPEG/PNG/WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new HttpError(413, 'Photo larger than 4 MB');
  const name = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UPLOAD, name), buf);
  return name;
}
const readingSchema = {
  meter_id: { type: 'integer', required: true }, value: { type: 'number', required: true, minVal: 0, maxVal: 1e9 }, reading_at: { type: 'datetime' }, captured_at: { type: 'datetime' },
  is_estimated: { type: 'boolean', default: false }, notes: { type: 'text', max: 1000 }, lat: { type: 'lat' }, lng: { type: 'lng' }, gps_accuracy: { type: 'number', minVal: 0 },
  client_uuid: { type: 'string', max: 64, pattern: /^[A-Za-z0-9-]+$/ }, offline: { type: 'boolean', default: false }, photo: { type: 'string', max: 6 * 1024 * 1024 },
  ocr_value: { type: 'number', minVal: 0, maxVal: 1e9 }, ocr_confidence: { type: 'number', minVal: 0, maxVal: 100 }
};
function createManual(ctx, raw) {
  const b = validate(raw, readingSchema);
  if (b.client_uuid) { const ex = db.get('SELECT * FROM readings WHERE client_uuid=?', b.client_uuid); if (ex) return { ...ex, duplicate_submission: true }; }
  const m = db.get('SELECT m.*, c.area_id c_area FROM meters m LEFT JOIN customers c ON c.id=m.customer_id WHERE m.id=?', b.meter_id);
  if (!m) throw new HttpError(404, 'Meter not found');
  if (ctx.user.role === 'meter_reader' && ctx.user.area_id && m.c_area && m.c_area !== ctx.user.area_id) throw new HttpError(403, 'This meter is outside your assigned service area');
  if (db.setting('gps_capture_enabled') !== '1') { b.lat = null; b.lng = null; b.gps_accuracy = null; }
  const when = b.reading_at || b.captured_at || new Date().toISOString();
  if (Date.parse(when) > Date.now() + 10 * 60e3) throw new HttpError(400, 'Reading time cannot be in the future');
  const r = readings.create(ctx, { meter_id: m.id, value: b.value, reading_at: when, captured_at: b.captured_at, source: 'manual', reader_user_id: ctx.user.id,
    is_estimated: b.is_estimated, notes: b.notes, lat: b.lat, lng: b.lng, gps_accuracy: b.gps_accuracy, client_uuid: b.client_uuid,
    sync_status: b.offline ? 'offline_synced' : 'online', photo_path: savePhoto(b.photo), ocr_value: b.photo ? b.ocr_value : null, ocr_confidence: b.photo ? b.ocr_confidence : null });
  return r;
}
route('POST', '/api/readings', { perm: 'readings.create' }, ctx => createManual(ctx, ctx.body));
// Batch sync from offline field devices. Each item is independent; client_uuid makes re-sync safe (idempotent).
route('POST', '/api/readings/sync', { perm: 'readings.create' }, ctx => {
  const items = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 200) : [];
  return { results: items.map(it => { try { const r = createManual(ctx, { ...it, offline: true }); return { client_uuid: it.client_uuid, ok: true, id: r.id, duplicate: !!r.duplicate_submission, flags: JSON.parse(r.flags_json) }; } catch (e) { return { client_uuid: it.client_uuid, ok: false, error: e.message }; } }) };
});
route('GET', '/api/readings', { anyPerm: ['readings.view', 'readings.view_own'] }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (!auth.can(ctx.user, 'readings.view')) { where.push('r.reader_user_id=?'); p.push(ctx.user.id); }
  if (q.status) { where.push('r.status=?'); p.push(q.status); }
  if (q.source) { where.push('r.source=?'); p.push(q.source); }
  if (q.group === 'field') where.push(`r.source IN ('manual','csv_import','estimate')`);
  if (q.group === 'device') where.push(`r.source NOT IN ('manual','csv_import','estimate')`);
  if (q.flag === 'any') where.push(`r.flags_json != '[]'`);
  else if (q.flag === 'none') where.push(`r.flags_json = '[]'`);
  else if (q.flag) { where.push('r.flags_json LIKE ?'); p.push(`%"${q.flag}"%`); }
  if (q.area_id) { where.push('c.area_id=?'); p.push(Number(q.area_id)); }
  if (q.meter_id) { where.push('r.meter_id=?'); p.push(Number(q.meter_id)); }
  if (q.from) { where.push('r.reading_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('r.reading_at <= ?'); p.push(q.to + 'T23:59:59.999Z'); }
  if (q.q) { where.push('(m.serial_number LIKE ? OR c.name LIKE ? OR c.customer_number LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s); }
  return db.all(`SELECT r.id, r.meter_id, r.customer_id, r.value, r.corrected_value, r.correction_reason, r.reading_at, r.source, r.status, r.flags_json, r.previous_value, r.consumption, r.is_estimated, r.is_simulated,
    r.sync_status, r.photo_path IS NOT NULL has_photo, r.lat, r.lng, r.notes, r.review_note, r.billed_bill_id, r.received_at, r.captured_at, r.battery_pct, r.events_json, r.integration_id,
    m.serial_number, m.comm_method, c.name customer_name, c.customer_number, a.name area_name, u.full_name reader_name, i.status integration_status
    FROM readings r JOIN meters m ON m.id=r.meter_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN service_areas a ON a.id=c.area_id LEFT JOIN users u ON u.id=r.reader_user_id LEFT JOIN integrations i ON i.id=r.integration_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.reading_at DESC LIMIT ${Math.min(Number(q.limit) || 300, 3000)}`, ...p);
});
route('GET', '/api/readings/flags', { anyPerm: ['readings.view', 'readings.view_own'] }, () => readings.FLAG_LABELS);
route('GET', '/api/readings/:id/photo', { anyPerm: ['readings.view', 'readings.view_own'] }, ctx => {
  const r = db.get('SELECT photo_path, reader_user_id FROM readings WHERE id=?', id(ctx.params.id));
  if (!r || !r.photo_path) throw new HttpError(404, 'No photo');
  if (!auth.can(ctx.user, 'readings.view') && r.reader_user_id !== ctx.user.id) throw new HttpError(403, 'Not allowed');
  const f = path.join(UPLOAD, path.basename(r.photo_path));
  return { __raw: true, body: fs.readFileSync(f), headers: { 'Content-Type': f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } };
});
route('POST', '/api/readings/:id/approve', { perm: 'readings.review' }, ctx => readings.approve(ctx, id(ctx.params.id), ctx.body.note ? String(ctx.body.note).slice(0, 500) : null));
route('POST', '/api/readings/:id/reject', { perm: 'readings.review' }, ctx => readings.reject(ctx, id(ctx.params.id), String(ctx.body.reason || '').trim().slice(0, 500)));
route('POST', '/api/readings/:id/correct', { perm: 'readings.review' }, ctx => {
  const b = validate(ctx.body, { value: { type: 'number', required: true, minVal: 0 }, reason: { type: 'string', required: true, min: 5, max: 500 }, approve: { type: 'boolean', default: false } });
  const r = readings.correct(ctx, id(ctx.params.id), b.value, b.reason);
  return b.approve ? readings.approve(ctx, r.id, 'Approved with correction') : r;
});
route('POST', '/api/readings/bulk-approve', { perm: 'readings.review' }, ctx => {
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : [];
  const out = { approved: 0, skipped: [] };
  for (const rid of ids) {
    const r = db.get('SELECT flags_json, status FROM readings WHERE id=?', rid);
    if (!r || r.status !== 'pending') continue;
    const flags = JSON.parse(r.flags_json).filter(f => !INFO_FLAGS.includes(f));
    if (flags.length && !ctx.body.include_flagged) { out.skipped.push(rid); continue; }
    try { readings.approve(ctx, rid, 'Bulk approval'); out.approved++; } catch (e) { out.skipped.push(rid); }
  }
  return out;
});

// ---- CSV / spreadsheet import (preview, then commit) ----
route('POST', '/api/readings/import', { perm: 'readings.import' }, ctx => {
  const b = validate(ctx.body, { filename: { type: 'string', max: 200 }, content: { type: 'text', required: true, max: 5 * 1024 * 1024 }, commit: { type: 'boolean', default: false } });
  const rows = csv.parse(b.content);
  if (!rows.length) throw new HttpError(400, 'The file has no data rows');
  if (rows.length > 5000) throw new HttpError(400, 'Maximum 5,000 rows per import');
  const cols = Object.keys(rows[0]);
  if (!cols.includes('meter_serial') || !cols.includes('reading_value')) throw new HttpError(400, 'Required columns: meter_serial, reading_value (optional: reading_date, reading_time, reader, estimated, notes)');
  const checked = rows.map(r => {
    const out = { row: r.__row, meter_serial: r.meter_serial, reading_value: r.reading_value, reading_date: r.reading_date || r.reading_time || '', errors: [] };
    const m = db.get('SELECT * FROM meters WHERE serial_number=?', r.meter_serial);
    if (!m) out.errors.push('Unknown meter serial'); else { out.meter_id = m.id; if (!m.customer_id) out.errors.push('Meter not assigned to a customer'); }
    const v = Number(String(r.reading_value).replace(/,/g, ''));
    if (r.reading_value === '' || !Number.isFinite(v) || v < 0) out.errors.push('Reading value must be a non-negative number'); else out.value = v;
    const ts = out.reading_date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(out.reading_date) ? out.reading_date + 'T12:00:00Z' : out.reading_date) : null;
    if (!ts || isNaN(ts)) out.errors.push('reading_date missing or invalid (use YYYY-MM-DD or ISO date-time)');
    else if (ts.getTime() > Date.now() + 10 * 60e3) out.errors.push('Date in the future'); else out.reading_at = ts.toISOString();
    out.is_estimated = /^(1|y|yes|true)$/i.test(r.estimated || '');
    out.notes = (r.notes || '').slice(0, 500); out.reader = (r.reader || '').slice(0, 80);
    if (!out.errors.length) {
      const dupInFile = rows.filter(x => x.meter_serial === r.meter_serial && (x.reading_date || x.reading_time) === (r.reading_date || r.reading_time)).length > 1;
      if (dupInFile) out.errors.push('Duplicate row in file');
      else { const ev = readings.evaluate({ ...m, customer_type: null }, { value: v, reading_at: out.reading_at, is_estimated: out.is_estimated, source: 'csv_import' }); out.flags = ev.flags; out.consumption = ev.consumption; }
    }
    return out;
  });
  const valid = checked.filter(c => !c.errors.length);
  if (!b.commit) return { preview: true, total: checked.length, valid: valid.length, invalid: checked.length - valid.length, rows: checked };
  return db.tx(() => {
    const batch = db.run('INSERT INTO import_batches(filename, uploaded_by, row_count, accepted, rejected, errors_json) VALUES (?,?,?,?,?,?)', b.filename || 'upload.csv', ctx.user.id, checked.length, valid.length,
      checked.length - valid.length, JSON.stringify(checked.filter(c => c.errors.length).map(c => ({ row: c.row, errors: c.errors }))));
    for (const c of valid) readings.create(ctx, { meter_id: c.meter_id, value: c.value, reading_at: c.reading_at, source: 'csv_import', reader_user_id: ctx.user.id, is_estimated: c.is_estimated,
      notes: [c.reader ? 'Reader: ' + c.reader : '', c.notes].filter(Boolean).join(' — ') || null, sync_status: 'import', import_batch_id: batch.id });
    audit.log(ctx, 'readings.import', 'import_batch', batch.id, { filename: b.filename, accepted: valid.length, rejected: checked.length - valid.length });
    return { committed: true, batch_id: batch.id, accepted: valid.length, rejected: checked.length - valid.length, rows: checked };
  });
});

// ---- Field app: route list for meter readers (also cached offline by the app) ----
route('GET', '/api/field/route', { perm: 'field.read' }, ctx => {
  const p = []; let where = `m.status IN ('active','faulty') AND c.status != 'closed'`;
  if (ctx.user.area_id) { where += ' AND c.area_id=?'; p.push(ctx.user.area_id); }
  const since = new Date(Date.now() - 25 * 86400e3).toISOString();
  return db.all(`SELECT c.id customer_id, c.customer_number, c.name, c.address, c.landmark, c.customer_type, c.lat, c.lng, a.name area_name, m.id meter_id, m.serial_number, m.manufacturer, m.model, m.size_mm, m.comm_method, m.status meter_status,
    (SELECT COALESCE(r.corrected_value, r.value) FROM readings r WHERE r.meter_id=m.id AND r.status!='rejected' ORDER BY r.reading_at DESC LIMIT 1) last_value,
    (SELECT r.reading_at FROM readings r WHERE r.meter_id=m.id AND r.status!='rejected' ORDER BY r.reading_at DESC LIMIT 1) last_at,
    (SELECT COUNT(*) FROM readings r WHERE r.meter_id=m.id AND r.reading_at >= ? AND r.status!='rejected') read_this_cycle, m.initial_reading
    FROM meters m JOIN customers c ON c.id=m.customer_id JOIN service_areas a ON a.id=c.area_id WHERE ${where} ORDER BY a.name, c.address`, since, ...p);
});

module.exports = { savePhoto };
