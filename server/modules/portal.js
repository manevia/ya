'use strict';
// Customer self-service. Every query is scoped to the signed-in user's own customer_id (never taken from the request).
const { route, HttpError } = require('../lib/http');
const { id } = require('../lib/validate');
const db = require('../lib/db');
const billing = require('../services/billing');

function me(ctx) {
  if (!ctx.user.customer_id) throw new HttpError(403, 'No customer account is linked to this login');
  return ctx.user.customer_id;
}
route('GET', '/api/portal/account', { perm: 'portal.self' }, ctx => {
  const cid = me(ctx);
  const c = db.get(`SELECT c.customer_number, c.name, c.customer_type, c.address, c.landmark, c.phone, c.email, c.status, c.billing_mode, a.name area_name, a.currency, c.area_id
    FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?`, cid);
  const meter = db.get(`SELECT serial_number, manufacturer, model, size_mm, comm_method, install_date FROM meters WHERE customer_id=? AND status IN ('active','faulty')`, cid);
  billing.refreshAllBills();
  return {
    account: c, meter, balance: billing.balance(cid), mode: db.MODE, org_name: db.setting('org_name'), ussd_code: db.setting('ussd_code'),
    plan: (() => { const p = db.get(`SELECT id FROM payment_plans WHERE customer_id=? AND status='active' ORDER BY id DESC LIMIT 1`, cid); if (!p) return null; const s = require('../services/collections').planStatus(p.id);
      return { arrears: s.arrears, currency: s.currency, paid: s.paid, progress_pct: s.progress_pct, health: s.health, instalments: s.instalments.map(i => ({ seq: i.seq, due_date: i.due_date, amount: i.amount, paid: i.paid, status: i.status })) }; })(),
    readings: db.all(`SELECT reading_at, COALESCE(corrected_value, value) value, consumption, source, status, is_estimated, is_simulated FROM readings WHERE customer_id=? AND status != 'rejected' ORDER BY reading_at DESC LIMIT 24`, cid),
    bills: db.all(`SELECT id, bill_number, period_start, period_end, issue_date, due_date, consumption, is_estimated, total, paid, currency, status FROM bills WHERE customer_id=? AND status!='cancelled' ORDER BY period_end DESC`, cid),
    payments: db.all(`SELECT receipt_number, received_at, amount, currency, method, reference, status FROM payments WHERE customer_id=? ORDER BY received_at DESC`, cid),
    notices: db.all(`SELECT title, body, notice_type, starts_at, ends_at, created_at FROM service_notices WHERE (area_id IS NULL OR area_id=?) AND (ends_at IS NULL OR ends_at >= date('now')) ORDER BY created_at DESC LIMIT 20`, c.area_id)
  };
});
route('GET', '/api/portal/bills/:id', { perm: 'portal.self' }, ctx => {
  const cid = me(ctx);
  const b = db.get(`SELECT b.*, t.name tariff_name, m.serial_number FROM bills b LEFT JOIN tariffs t ON t.id=b.tariff_id LEFT JOIN meters m ON m.id=b.meter_id WHERE b.id=? AND b.customer_id=?`, id(ctx.params.id), cid);
  if (!b) throw new HttpError(404, 'Bill not found');
  const c = db.get('SELECT c.name, c.customer_number, c.address, a.name area_name FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', cid);
  return { bill: { ...b, ...{ customer_name: c.name, customer_number: c.customer_number, address: c.address, area_name: c.area_name } }, lines: db.all('SELECT * FROM bill_lines WHERE bill_id=? ORDER BY id', b.id), outstanding: billing.billOutstanding(b), org_name: db.setting('org_name'), mode: db.MODE };
});
route('GET', '/api/portal/statement', { perm: 'portal.self' }, ctx => {
  const cid = me(ctx);
  return { ...billing.ledger(cid, ctx.query.from, ctx.query.to), from: ctx.query.from || null, to: ctx.query.to || null };
});

// Customer self-reading from a smartphone (photo + value; OCR suggestion from the device). Always goes to staff review.
route('POST', '/api/portal/reading', { perm: 'portal.self' }, ctx => {
  const cid = me(ctx);
  const { validate } = require('../lib/validate');
  const b = validate(ctx.body, { value: { type: 'number', required: true, minVal: 0, maxVal: 1e9 }, photo: { type: 'string', required: true, max: 6 * 1024 * 1024 },
    ocr_value: { type: 'number', minVal: 0, maxVal: 1e9 }, ocr_confidence: { type: 'number', minVal: 0, maxVal: 100 }, client_uuid: { type: 'string', max: 64, pattern: /^[A-Za-z0-9-]+$/ } });
  const m = db.get(`SELECT * FROM meters WHERE customer_id=? AND status IN ('active','faulty') ORDER BY id DESC LIMIT 1`, cid);
  if (!m) throw new HttpError(400, 'No active meter on your account');
  const recent = db.get(`SELECT COUNT(*) n FROM readings WHERE customer_id=? AND source='customer_self' AND received_at >= datetime('now','-1 day')`, cid).n;
  if (recent >= 3) throw new HttpError(429, 'You have already sent 3 readings today. Thank you!');
  const r = require('../services/readings').create(ctx, { meter_id: m.id, value: b.value, reading_at: new Date().toISOString(), source: 'customer_self', client_uuid: b.client_uuid,
    photo_path: require('./customers').savePhoto(b.photo), ocr_value: b.ocr_value, ocr_confidence: b.ocr_confidence, notes: 'Submitted by customer in the portal', sync_status: 'online' });
  return { id: r.id, status: r.status, flags: JSON.parse(r.flags_json) };
});
route('GET', '/api/portal/meter', { perm: 'portal.self' }, ctx => {
  const cid = me(ctx);
  return db.get(`SELECT serial_number, last_reading_value, last_reading_at, initial_reading FROM meters WHERE customer_id=? AND status IN ('active','faulty') ORDER BY id DESC LIMIT 1`, cid) || null;
});
