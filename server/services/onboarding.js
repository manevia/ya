'use strict';
/*
 * Bulk onboarding: bring an existing utility's customer ledger, meter list and opening balances in from spreadsheets (CSV).
 * Every file is checked first (preview); nothing is written until the user commits, and a commit is all-or-nothing.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const csv = require('../lib/csv');
const { HttpError } = require('../lib/http');
const accounts = require('./accounts');

const TYPES = ['household', 'business', 'institution', 'public_water_point', 'bulk'];
const TEMPLATES = {
  customers: ['legacy_ref', 'name', 'customer_type', 'area_code', 'address', 'landmark', 'phone', 'email', 'lat', 'lng', 'billing_mode', 'household_size', 'status'],
  meters: ['serial_number', 'manufacturer', 'model', 'meter_type', 'size_mm', 'install_date', 'initial_reading', 'customer_ref'],
  balances: ['customer_ref', 'amount', 'as_of', 'note']
};
const EXAMPLES = {
  customers: ['ACC-1001', 'Example Household (replace)', 'household', 'RVS', '12 Example Street', 'Near the market', '+231 770 000 000', '', '', '', 'postpaid', '5', 'active'],
  meters: ['EXAMPLE-0001', 'Manufacturer', 'Model', 'mechanical', '15', '2024-01-15', '0', 'ACC-1001'],
  balances: ['ACC-1001', '1250.00', '2026-09-30', 'Arrears carried over from old ledger']
};
const template = kind => csv.stringify([Object.fromEntries(TEMPLATES[kind].map((c, i) => [c, EXAMPLES[kind][i]]))], TEMPLATES[kind]);

const findCustomer = ref => { const r = String(ref || '').trim(); if (!r) return null; return db.get('SELECT c.*, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.legacy_ref=? OR c.customer_number=?', r, r); };
const PHONE = /^[+0-9 ()-]{6,20}$/, EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/, DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(kind, rows) {
  const seen = new Set();
  return rows.map(r => {
    const o = { row: r.__row, data: r, errors: [], warnings: [] }; const E = m => o.errors.push(m);
    if (kind === 'customers') {
      if (!r.name) E('name required'); if (!TYPES.includes(r.customer_type)) E('customer_type must be one of ' + TYPES.join('/'));
      const area = db.get('SELECT * FROM service_areas WHERE code=?', String(r.area_code || '').toUpperCase()); if (!area) E('unknown area_code'); else o.area_id = area.id;
      if (!r.address) E('address required'); if (r.phone && !PHONE.test(r.phone)) E('invalid phone'); if (r.email && !EMAIL.test(r.email)) E('invalid email');
      if ((r.lat || r.lng) && !(Math.abs(Number(r.lat)) <= 90 && Math.abs(Number(r.lng)) <= 180)) E('invalid lat/lng');
      if (r.billing_mode && !['postpaid', 'prepaid'].includes(r.billing_mode)) E('billing_mode postpaid/prepaid');
      if (r.status && !['pending', 'active', 'suspended', 'disconnected', 'closed'].includes(r.status)) E('invalid status');
      if (r.household_size && !(Number(r.household_size) > 0)) E('household_size must be a number');
      if (r.legacy_ref) { if (seen.has(r.legacy_ref)) E('duplicate legacy_ref in file'); seen.add(r.legacy_ref); if (db.get('SELECT 1 FROM customers WHERE legacy_ref=?', r.legacy_ref)) { o.skip = true; o.warnings.push('already imported (legacy_ref exists) — will be skipped'); } }
      else o.warnings.push('no legacy_ref — re-importing this file would create duplicates');
    } else if (kind === 'meters') {
      if (!r.serial_number || !/^[A-Za-z0-9._\/-]+$/.test(r.serial_number)) E('serial_number required (letters, digits . _ / -)');
      if (seen.has(r.serial_number)) E('duplicate serial in file'); seen.add(r.serial_number);
      if (r.serial_number && db.get('SELECT 1 FROM meters WHERE serial_number=?', r.serial_number)) { o.skip = true; o.warnings.push('serial already registered — will be skipped'); }
      if (!r.manufacturer || !r.model) E('manufacturer and model required');
      if (!['mechanical', 'ultrasonic', 'electromagnetic', 'prepaid', 'bulk'].includes(r.meter_type)) E('meter_type mechanical/ultrasonic/electromagnetic/prepaid/bulk');
      if (!(Number(r.size_mm) >= 10)) E('size_mm required'); if (r.install_date && !DATE.test(r.install_date)) E('install_date YYYY-MM-DD');
      if (r.initial_reading !== '' && r.initial_reading != null && !(Number(r.initial_reading) >= 0)) E('initial_reading must be ≥ 0');
      if (r.customer_ref) { const c = findCustomer(r.customer_ref); if (!c) E('customer_ref not found (import customers first)'); else { o.customer_id = c.id;
        if (db.get(`SELECT 1 FROM meters WHERE customer_id=? AND status IN ('active','faulty')`, c.id)) E('customer already has an active meter'); } }
    } else {
      const c = findCustomer(r.customer_ref); if (!c) E('customer_ref not found'); else { o.customer_id = c.id; o.currency = c.currency; }
      const amt = Number(String(r.amount).replace(/,/g, '')); if (!Number.isFinite(amt) || amt === 0) E('amount must be a non-zero number (positive = owed, negative = credit)'); else o.amount = amt;
      if (!DATE.test(r.as_of || '')) E('as_of YYYY-MM-DD');
      if (c && db.get(`SELECT 1 FROM adjustments WHERE customer_id=? AND category='opening_balance' AND status='approved'`, c.id)) { o.skip = true; o.warnings.push('opening balance already imported — will be skipped'); }
    }
    return o;
  });
}

function run(ctx, { kind, content, commit, filename }) {
  if (!TEMPLATES[kind]) throw new HttpError(400, 'Unknown import type');
  const rows = csv.parse(content);
  if (!rows.length) throw new HttpError(400, 'The file has no data rows');
  if (rows.length > 10000) throw new HttpError(400, 'Max 10,000 rows per file — split it');
  const missing = TEMPLATES[kind].filter(c => ['legacy_ref', 'landmark', 'phone', 'email', 'lat', 'lng', 'billing_mode', 'household_size', 'status', 'install_date', 'initial_reading', 'customer_ref', 'note'].includes(c) ? false : !(c in rows[0]));
  if (missing.length) throw new HttpError(400, 'Missing columns: ' + missing.join(', ') + '. Download the template.');
  const checked = check(kind, rows);
  const bad = checked.filter(c => c.errors.length).length, skip = checked.filter(c => !c.errors.length && c.skip).length;
  const summary = { kind, total: checked.length, ready: checked.length - bad - skip, skip, errors: bad };
  if (!commit) return { preview: true, ...summary, rows: checked.slice(0, 500).map(c => ({ row: c.row, key: c.data.legacy_ref || c.data.serial_number || c.data.customer_ref || c.data.name, errors: c.errors, warnings: c.warnings, skip: !!c.skip })) };
  if (bad) throw new HttpError(400, `Fix the ${bad} row(s) with errors first (nothing was imported)`);
  const created = db.tx(() => {
    let n = 0;
    for (const c of checked.filter(x => !x.skip)) {
      const r = c.data;
      if (kind === 'customers') {
        accounts.createCustomer(ctx, { name: r.name, customer_type: r.customer_type, area_id: c.area_id, address: r.address, landmark: r.landmark, phone: r.phone, email: r.email, lat: r.lat ? Number(r.lat) : null, lng: r.lng ? Number(r.lng) : null,
          gps_source: r.lat ? 'survey' : null, billing_mode: r.billing_mode || 'postpaid', household_size: r.household_size ? Number(r.household_size) : null, status: r.status || 'active', legacy_ref: r.legacy_ref || null, notes: 'Imported from ' + (filename || 'CSV') }, `Account imported${r.legacy_ref ? ' (old ref ' + r.legacy_ref + ')' : ''}`);
      } else if (kind === 'meters') {
        const id = db.run(`INSERT INTO meters(serial_number, manufacturer, model, meter_type, size_mm, install_date, initial_reading, status, comm_method) VALUES (?,?,?,?,?,?,?,'in_stock','manual')`,
          r.serial_number, r.manufacturer, r.model, r.meter_type, Number(r.size_mm), r.install_date || null, Number(r.initial_reading || 0)).id;
        audit.log(ctx, 'meter.create', 'meter', id, { serial: r.serial_number, imported: true });
        if (c.customer_id) accounts.assignMeter(ctx, id, c.customer_id, Number(r.initial_reading || 0), r.install_date ? r.install_date + 'T00:00:00.000Z' : null, 'Imported');
      } else {
        const aid = db.run(`INSERT INTO adjustments(customer_id, amount, currency, category, reason, status, created_by, approved_by, decided_at) VALUES (?,?,?,'opening_balance',?,'approved',?,?,?)`,
          c.customer_id, c.amount, c.currency, `Opening balance as of ${r.as_of}${r.note ? ' — ' + r.note : ''}`, ctx.user.id, ctx.user.id, r.as_of + 'T00:00:00.000Z').id;
        db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', c.customer_id, 'adjustment', `Opening balance ${c.amount} ${c.currency} imported (as of ${r.as_of})`, ctx.user.id);
        audit.log(ctx, 'adjustment.opening_balance', 'adjustment', aid, { amount: c.amount, as_of: r.as_of });
      }
      n++;
    }
    audit.log(ctx, 'onboarding.import', kind, null, { filename, created: n, skipped: skip });
    return n;
  });
  return { committed: true, ...summary, created };
}

module.exports = { run, template, TEMPLATES };
