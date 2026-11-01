'use strict';
// Shared account helpers: customer numbering and account creation (used by staff entry, new connections and bulk onboarding).
const db = require('../lib/db');
const audit = require('../lib/audit');

function nextCustomerNumber(area) {
  const prefix = (db.MODE === 'demo' ? 'DEMO-' : '') + area.code + '-';
  let seq = Number(db.setting('seq_customer_' + area.code, '0')) + 1;
  while (db.get('SELECT 1 FROM customers WHERE customer_number=?', prefix + String(seq).padStart(5, '0'))) seq++; // never reuse a number
  db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'seq_customer_' + area.code, String(seq));
  return prefix + String(seq).padStart(5, '0');
}

/** b: validated customer fields. Returns { id, customer_number }. Must be called inside a transaction. */
function createCustomer(ctx, b, eventText) {
  const area = db.get('SELECT * FROM service_areas WHERE id=?', b.area_id);
  if (!area) throw new Error('Unknown service area');
  const number = nextCustomerNumber(area);
  const r = db.run(`INSERT INTO customers(customer_number, name, customer_type, contact_person, phone, email, address, landmark, area_id, lat, lng, gps_source, status, billing_mode, notes, essential_service, household_size, legacy_ref, supply_zone, language)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, number, b.name, b.customer_type, b.contact_person || null, b.phone || null, b.email || null, b.address, b.landmark || null, b.area_id, b.lat ?? null, b.lng ?? null,
    b.lat != null ? (b.gps_source || 'unknown') : null, b.status || 'active', b.billing_mode || 'postpaid', b.notes || null, b.essential_service ? 1 : 0, b.household_size || null, b.legacy_ref || null, b.supply_zone || null, b.language && require('../lib/i18n').isLang(b.language) ? b.language : null);
  db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', r.id, 'created', eventText || `Account ${number} opened (${b.customer_type})`, ctx.user ? ctx.user.id : null);
  audit.log(ctx, 'customer.create', 'customer', r.id, { number, name: b.name, type: b.customer_type, area: area.code, legacy_ref: b.legacy_ref || undefined });
  return { id: r.id, customer_number: number };
}

/** Assign a meter to a customer and make both active. Must be called inside a transaction. */
function assignMeter(ctx, meterId, customerId, startReading, dateIso, reason) {
  const m = db.get('SELECT * FROM meters WHERE id=?', meterId); const c = db.get('SELECT * FROM customers WHERE id=?', customerId);
  const at = dateIso || new Date().toISOString();
  db.run(`UPDATE meters SET customer_id=?, status='active', area_id=?, install_date=COALESCE(install_date, ?) WHERE id=?`, customerId, c.area_id, at.slice(0, 10), meterId);
  db.run('INSERT INTO meter_assignments(meter_id, customer_id, assigned_at, start_reading, reason, user_id) VALUES (?,?,?,?,?,?)', meterId, customerId, at, startReading ?? m.initial_reading, reason, ctx.user ? ctx.user.id : null);
  db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', customerId, 'meter', `Meter ${m.serial_number} assigned (start reading ${startReading ?? m.initial_reading} m³)`, ctx.user ? ctx.user.id : null);
  audit.log(ctx, 'meter.assign', 'meter', meterId, { customer: c.customer_number, start_reading: startReading ?? m.initial_reading });
}

module.exports = { nextCustomerNumber, createCustomer, assignMeter };
