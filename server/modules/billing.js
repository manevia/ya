'use strict';
const { route, HttpError } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const audit = require('../lib/audit');
const db = require('../lib/db');
const billing = require('../services/billing');

route('POST', '/api/bills/generate', { perm: 'billing.generate' }, ctx => {
  const b = validate(ctx.body, { period_start: { type: 'date', required: true }, period_end: { type: 'date', required: true }, area_id: { type: 'integer' },
    customer_ids: { type: 'array', max: 5000 }, due_days: { type: 'integer', minVal: 1, maxVal: 120 }, estimate_missing: { type: 'boolean', default: false }, commit: { type: 'boolean', default: false } });
  if (b.period_end > new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'Billing period cannot end in the future');
  if (b.customer_ids) b.customer_ids = b.customer_ids.map(Number).filter(Number.isInteger);
  const out = billing.generate(ctx, b);
  if (b.commit) audit.log(ctx, 'billing.run', 'billing', null, { ...b, customer_ids: undefined, ok: out.summary.ok, skipped: out.summary.skipped });
  return out;
});
route('GET', '/api/bills', { perm: 'billing.view' }, ctx => {
  billing.refreshAllBills();
  const q = ctx.query; const where = []; const p = [];
  if (q.status) { where.push('b.status=?'); p.push(q.status); }
  if (q.area_id) { where.push('c.area_id=?'); p.push(Number(q.area_id)); }
  if (q.customer_id) { where.push('b.customer_id=?'); p.push(Number(q.customer_id)); }
  if (q.from) { where.push('b.period_end >= ?'); p.push(q.from); }
  if (q.to) { where.push('b.period_end <= ?'); p.push(q.to); }
  if (q.q) { where.push('(b.bill_number LIKE ? OR c.name LIKE ? OR c.customer_number LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s); }
  return db.all(`SELECT b.*, c.name customer_name, c.customer_number, a.name area_name FROM bills b JOIN customers c ON c.id=b.customer_id JOIN service_areas a ON a.id=c.area_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.issue_date DESC, b.id DESC LIMIT 2000`, ...p);
});
function billDetail(bid) {
  const b = db.get(`SELECT b.*, c.name customer_name, c.customer_number, c.address, c.customer_type, c.billing_mode cust_mode, a.name area_name, t.code tariff_code, t.name tariff_name, m.serial_number
    FROM bills b JOIN customers c ON c.id=b.customer_id JOIN service_areas a ON a.id=c.area_id LEFT JOIN tariffs t ON t.id=b.tariff_id LEFT JOIN meters m ON m.id=b.meter_id WHERE b.id=?`, bid);
  if (!b) throw new HttpError(404, 'Bill not found');
  return { bill: b, lines: db.all('SELECT * FROM bill_lines WHERE bill_id=? ORDER BY id', bid), outstanding: billing.billOutstanding(b),
    payments: db.all('SELECT p.receipt_number, p.received_at, p.method, pa.amount FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.bill_id=? ORDER BY p.received_at', bid),
    adjustments: db.all(`SELECT * FROM adjustments WHERE bill_id=? AND status='approved'`, bid), org_name: db.setting('org_name'), mode: db.MODE };
}
route('GET', '/api/bills/:id', { perm: 'billing.view' }, ctx => { const bid = id(ctx.params.id); billing.refreshBill(bid); return billDetail(bid); });
route('POST', '/api/bills/:id/cancel', { perm: 'billing.generate' }, ctx => billing.cancelBill(ctx, id(ctx.params.id), String(ctx.body.reason || '').trim().slice(0, 300)));

route('GET', '/api/payments', { perm: 'billing.view' }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (q.customer_id) { where.push('p.customer_id=?'); p.push(Number(q.customer_id)); }
  if (q.method) { where.push('p.method=?'); p.push(q.method); }
  if (q.from) { where.push('p.received_at >= ?'); p.push(q.from); }
  if (q.to) { where.push('p.received_at <= ?'); p.push(q.to + 'T23:59:59.999Z'); }
  if (q.area_id) { where.push('c.area_id=?'); p.push(Number(q.area_id)); }
  if (q.q) { where.push('(p.receipt_number LIKE ? OR c.name LIKE ? OR c.customer_number LIKE ? OR p.reference LIKE ?)'); const s = `%${q.q}%`; p.push(s, s, s, s); }
  return db.all(`SELECT p.*, c.name customer_name, c.customer_number, u.full_name received_by_name FROM payments p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.received_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.received_at DESC, p.id DESC LIMIT 2000`, ...p);
});
route('GET', '/api/payments/:id', { perm: 'billing.view' }, ctx => {
  const p = db.get(`SELECT p.*, c.name customer_name, c.customer_number, c.address, u.full_name received_by_name FROM payments p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.received_by WHERE p.id=?`, id(ctx.params.id));
  if (!p) throw new HttpError(404, 'Payment not found');
  return { payment: p, allocations: db.all('SELECT pa.amount, b.bill_number FROM payment_allocations pa JOIN bills b ON b.id=pa.bill_id WHERE pa.payment_id=?', p.id), balance_after: billing.balance(p.customer_id), org_name: db.setting('org_name'), mode: db.MODE };
});
route('POST', '/api/payments', { perm: 'payments.create' }, ctx => {
  // NOTE: no payment-card data is accepted or stored. Mobile money / bank references only.
  if (ctx.body.card_number || ctx.body.pan || ctx.body.cvv) throw new HttpError(400, 'Card details must never be entered into this system');
  const b = validate(ctx.body, { customer_id: { type: 'integer', required: true }, bill_id: { type: 'integer' }, amount: { type: 'number', required: true, minVal: 0.01, maxVal: 1e8 },
    currency: { type: 'currency' }, method: { type: 'paymethod', required: true },
    reference: { type: 'string', max: 80 }, received_at: { type: 'datetime' }, notes: { type: 'text', max: 500 }, purpose: { type: 'enum', values: ['bill_payment', 'prepaid_credit', 'deposit'] } });
  if (b.method !== 'cash' && !b.reference) throw new HttpError(400, 'A transaction reference is required for non-cash payments');
  if (b.received_at && Date.parse(b.received_at) > Date.now() + 5 * 60e3) throw new HttpError(400, 'Payment date cannot be in the future');
  return billing.recordPayment(ctx, b);
});
route('POST', '/api/payments/:id/reverse', { perm: 'payments.reverse' }, ctx => billing.reversePayment(ctx, id(ctx.params.id), String(ctx.body.reason || '').trim().slice(0, 300)));

route('GET', '/api/adjustments', { anyPerm: ['adjustments.create', 'adjustments.approve'] }, ctx => db.all(`SELECT j.*, c.name customer_name, c.customer_number, u.full_name created_by_name, v.full_name approved_by_name, b.bill_number
  FROM adjustments j JOIN customers c ON c.id=j.customer_id LEFT JOIN users u ON u.id=j.created_by LEFT JOIN users v ON v.id=j.approved_by LEFT JOIN bills b ON b.id=j.bill_id
  ${ctx.query.status ? 'WHERE j.status=?' : ''} ORDER BY j.created_at DESC LIMIT 1000`, ...(ctx.query.status ? [ctx.query.status] : [])));
route('POST', '/api/adjustments', { perm: 'adjustments.create' }, ctx => {
  const b = validate(ctx.body, { customer_id: { type: 'integer', required: true }, bill_id: { type: 'integer' }, amount: { type: 'number', required: true, minVal: -1e7, maxVal: 1e7 },
    category: { type: 'enum', values: ['meter_error', 'leak_relief', 'billing_error', 'reconnection_fee', 'penalty', 'waiver', 'other'], required: true }, reason: { type: 'string', required: true, min: 5, max: 300 } });
  if (!b.amount) throw new HttpError(400, 'Amount cannot be zero');
  const c = db.get('SELECT c.id, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', b.customer_id); if (!c) throw new HttpError(404, 'Customer not found');
  if (b.bill_id && !db.get('SELECT 1 FROM bills WHERE id=? AND customer_id=?', b.bill_id, b.customer_id)) throw new HttpError(400, 'Bill does not belong to this customer');
  const needsApproval = db.setting('adjustment_approval_required') === '1';
  const r = db.run('INSERT INTO adjustments(customer_id, bill_id, amount, currency, category, reason, created_by, status, approved_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    b.customer_id, b.bill_id, b.amount, c.currency, b.category, b.reason, ctx.user.id, needsApproval ? 'pending' : 'approved', needsApproval ? null : ctx.user.id, needsApproval ? null : new Date().toISOString());
  audit.log(ctx, 'adjustment.create', 'adjustment', r.id, { ...b, currency: c.currency, status: needsApproval ? 'pending' : 'approved' });
  if (!needsApproval && b.bill_id) billing.refreshBill(b.bill_id);
  return { id: r.id, status: needsApproval ? 'pending' : 'approved' };
});
route('POST', '/api/adjustments/:id/decide', { perm: 'adjustments.approve' }, ctx => {
  const aid = id(ctx.params.id);
  const b = validate(ctx.body, { decision: { type: 'enum', values: ['approved', 'rejected'], required: true }, note: { type: 'string', max: 300 } });
  const a = db.get('SELECT * FROM adjustments WHERE id=?', aid); if (!a) throw new HttpError(404, 'Not found');
  if (a.status !== 'pending') throw new HttpError(409, 'Already decided');
  if (a.created_by === ctx.user.id) throw new HttpError(403, 'Maker-checker: you cannot approve an adjustment you created');
  db.tx(() => {
    db.run('UPDATE adjustments SET status=?, approved_by=?, decided_at=?, decision_note=? WHERE id=?', b.decision, ctx.user.id, new Date().toISOString(), b.note, aid);
    if (b.decision === 'approved') {
      db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', a.customer_id, 'adjustment', `Adjustment ${a.amount} ${a.currency} approved (${a.category})`, ctx.user.id);
      if (a.bill_id) billing.refreshBill(a.bill_id);
      if (a.amount < 0) billing.applyCredit(a.customer_id);
    }
    audit.log(ctx, 'adjustment.' + b.decision, 'adjustment', aid, { amount: a.amount, note: b.note });
  });
  return { ok: true };
});

route('GET', '/api/customers/:id/statement', { perm: 'billing.view' }, ctx => {
  const cid = id(ctx.params.id);
  const c = db.get('SELECT c.*, a.name area_name, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', cid); if (!c) throw new HttpError(404, 'Customer not found');
  return { customer: c, ...billing.ledger(cid, ctx.query.from, ctx.query.to), from: ctx.query.from || null, to: ctx.query.to || null, org_name: db.setting('org_name'), mode: db.MODE };
});
