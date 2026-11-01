'use strict';
// Tariff selection, itemised bill generation, payment allocation, reversals and account ledger.
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const { eff, avgDaily } = require('./readings');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const endOf = d => d + 'T23:59:59.999Z';
const PREFIX = () => (db.MODE === 'demo' ? 'DEMO-' : '');

function nextNumber(kind, fmt) {
  const key = 'seq_' + kind;
  const cur = Number(db.setting(key, '0')) + 1;
  db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(cur));
  return PREFIX() + fmt(String(cur).padStart(6, '0'));
}

function selectTariff(customer, meter, onDate) {
  const rows = db.all(`SELECT * FROM tariffs WHERE active = 1 AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     AND (customer_type IS NULL OR customer_type = ?) AND (area_id IS NULL OR area_id = ?) AND (meter_size_mm IS NULL OR meter_size_mm = ?)
     AND (billing_mode = 'any' OR billing_mode = ?)`, onDate, onDate, customer.customer_type, customer.area_id, meter ? meter.size_mm : null, customer.billing_mode);
  const score = t => (t.customer_type ? 4 : 0) + (t.area_id ? 2 : 0) + (t.meter_size_mm ? 1 : 0) + (t.billing_mode !== 'any' ? 1 : 0);
  rows.sort((a, b) => score(b) - score(a) || (b.effective_from > a.effective_from ? 1 : -1));
  return rows[0] || null;
}

function computeCharges(tariff, consumption, estimated) {
  const lines = [];
  if (tariff.fixed_charge) lines.push({ line_type: 'fixed', description: 'Fixed service charge', quantity: 1, unit_price: tariff.fixed_charge, amount: r2(tariff.fixed_charge) });
  const bands = JSON.parse(tariff.bands_json || '[]');
  let remaining = Math.max(0, consumption); let lower = 0;
  for (const b of bands) {
    if (remaining <= 0) break;
    const upper = b.up_to == null || b.up_to === '' ? Infinity : Number(b.up_to);
    const qty = Math.min(remaining, upper - lower);
    if (qty > 0) {
      const label = upper === Infinity ? (lower === 0 ? 'all m³' : `above ${lower} m³`) : `${lower}–${upper} m³`;
      lines.push({ line_type: 'consumption', description: `Water consumption ${label}${estimated ? ' (ESTIMATED)' : ''}`, quantity: r2(qty * 1000) / 1000, unit_price: Number(b.rate), amount: r2(qty * Number(b.rate)) });
      remaining -= qty;
    }
    lower = upper;
  }
  let sub = lines.reduce((s, l) => s + l.amount, 0);
  for (const f of JSON.parse(tariff.fees_json || '[]')) {
    const amt = f.pct ? r2(sub * Number(f.pct) / 100) : r2(Number(f.amount || 0));
    if (amt) { lines.push({ line_type: 'fee', description: f.name + (f.pct ? ` (${f.pct}%)` : ''), quantity: 1, unit_price: amt, amount: amt }); sub += amt; }
  }
  if (tariff.minimum_charge && sub < tariff.minimum_charge) {
    const top = r2(tariff.minimum_charge - sub);
    lines.push({ line_type: 'fee', description: 'Minimum charge top-up', quantity: 1, unit_price: top, amount: top }); sub += top;
  }
  sub = r2(sub);
  const tax = r2(sub * (tariff.tax_pct || 0) / 100);
  if (tax) lines.push({ line_type: 'tax', description: `Tax (${tariff.tax_pct}%)`, quantity: 1, unit_price: tax, amount: tax });
  return { lines, subtotal: sub, tax, total: r2(sub + tax) };
}

function balance(customerId, asOf) {
  const lim = asOf ? endOf(asOf) : '9999';
  const b = db.get(`SELECT COALESCE(SUM(total),0) s FROM bills WHERE customer_id=? AND status!='cancelled' AND issue_date <= ?`, customerId, lim).s;
  const a = db.get(`SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE customer_id=? AND status='approved' AND COALESCE(decided_at, created_at) <= ?`, customerId, lim).s;
  const p = db.get(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE customer_id=? AND received_at <= ?`, customerId, lim).s;
  return r2(b + a - p);
}

function ledger(customerId, from, to) {
  const rows = [];
  for (const b of db.all(`SELECT * FROM bills WHERE customer_id=? ORDER BY issue_date`, customerId)) {
    rows.push({ date: b.issue_date, type: 'bill', ref: b.bill_number, id: b.id, description: `Bill ${b.period_start} to ${b.period_end} — ${b.consumption} m³${b.is_estimated ? ' (ESTIMATED)' : ''}`, debit: b.status === 'cancelled' ? 0 : b.total, credit: 0, note: b.status === 'cancelled' ? 'Cancelled: ' + (b.cancel_reason || '') : '' });
  }
  for (const p of db.all(`SELECT * FROM payments WHERE customer_id=? ORDER BY received_at`, customerId)) {
    const isRev = p.amount < 0;
    rows.push({ date: p.received_at.slice(0, 10), type: isRev ? 'reversal' : 'payment', ref: p.receipt_number, id: p.id,
      description: isRev ? `Payment reversal — ${p.reversal_reason || ''}` : `Payment (${p.method.replace(/_/g, ' ')})${p.reference ? ' ref ' + p.reference : ''}${p.tendered_currency && p.tendered_currency !== p.currency ? ` — tendered ${p.tendered_amount} ${p.tendered_currency} @ ${p.exchange_rate_used}` : ''}`,
      debit: isRev ? -p.amount : 0, credit: isRev ? 0 : p.amount });
  }
  for (const a of db.all(`SELECT * FROM adjustments WHERE customer_id=? AND status='approved'`, customerId)) {
    rows.push({ date: (a.decided_at || a.created_at).slice(0, 10), type: 'adjustment', ref: 'ADJ-' + a.id, id: a.id, description: `Adjustment (${a.category}): ${a.reason}`, debit: a.amount > 0 ? a.amount : 0, credit: a.amount < 0 ? -a.amount : 0 });
  }
  rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  let opening = 0; const out = [];
  for (const r of rows) {
    if (from && r.date < from) { opening = r2(opening + r.debit - r.credit); continue; }
    if (to && r.date > to) continue;
    out.push(r);
  }
  let bal = opening;
  for (const r of out) { bal = r2(bal + r.debit - r.credit); r.balance = bal; }
  return { opening_balance: opening, closing_balance: bal, rows: out };
}

function refreshBill(billId) {
  const b = db.get('SELECT * FROM bills WHERE id=?', billId);
  if (!b || b.status === 'cancelled') return;
  const paid = r2(db.get('SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE bill_id=?', billId).s);
  const adj = r2(db.get(`SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id=? AND status='approved'`, billId).s);
  const outstanding = r2(b.total + adj - paid);
  let status = outstanding <= 0.004 ? 'paid' : paid > 0 ? 'partially_paid' : 'issued';
  if (status !== 'paid' && b.due_date < today()) status = 'overdue';
  db.run('UPDATE bills SET paid=?, status=? WHERE id=?', paid, status, billId);
}
function refreshAllBills() { for (const b of db.all(`SELECT id FROM bills WHERE status != 'cancelled' AND status != 'paid'`)) refreshBill(b.id); }

function billOutstanding(b) {
  const paid = db.get('SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE bill_id=?', b.id).s;
  const adj = db.get(`SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id=? AND status='approved'`, b.id).s;
  return r2(b.total + adj - paid);
}

/** Generate (or preview) bills from APPROVED readings only. */
function generate(ctx, opts) {
  const { period_start, period_end, area_id, customer_ids, estimate_missing, commit } = opts;
  if (period_end < period_start) throw new HttpError(400, 'Period end must be after start');
  const dueDays = opts.due_days || db.settingNum('default_due_days', 21);
  let sql = `SELECT c.*, a.currency AS area_currency, a.name AS area_name FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.status IN ('active','suspended')`;
  const p = [];
  if (area_id) { sql += ' AND c.area_id=?'; p.push(area_id); }
  if (customer_ids && customer_ids.length) { sql += ` AND c.id IN (${customer_ids.map(() => '?').join(',')})`; p.push(...customer_ids); }
  const customers = db.all(sql + ' ORDER BY c.customer_number', ...p);
  const results = [];
  const work = () => {
    for (const c of customers) {
      const res = { customer_id: c.id, customer_number: c.customer_number, name: c.name, currency: c.area_currency };
      results.push(res);
      const meter = db.get(`SELECT * FROM meters WHERE customer_id=? AND status IN ('active','faulty') ORDER BY id DESC LIMIT 1`, c.id);
      if (!meter) { res.status = 'skipped'; res.reason = 'No active meter assigned'; continue; }
      const already = db.get(`SELECT bill_number FROM bills WHERE customer_id=? AND status!='cancelled' AND period_start <= ? AND period_end >= ?`, c.id, period_end, period_start);
      if (already) { res.status = 'skipped'; res.reason = `Already billed (${already.bill_number}) for an overlapping period`; continue; }
      const tariff = selectTariff(c, meter, period_end);
      if (!tariff) { res.status = 'skipped'; res.reason = `No active tariff for ${c.customer_type} in ${c.area_name}`; continue; }
      if (tariff.currency !== c.area_currency) { res.status = 'skipped'; res.reason = `Tariff ${tariff.code} currency ${tariff.currency} differs from area currency ${c.area_currency}`; continue; }
      // Opening = previous bill's closing value, else last approved reading on/before period start, else meter's initial reading.
      const lastBill = db.get(`SELECT * FROM bills WHERE customer_id=? AND meter_id=? AND status!='cancelled' ORDER BY period_end DESC LIMIT 1`, c.id, meter.id);
      let opening, openingAt, openingId = null;
      if (lastBill) { opening = lastBill.closing_value; openingAt = endOf(lastBill.period_end); openingId = lastBill.closing_reading_id; }
      else {
        const r = db.get(`SELECT * FROM readings WHERE meter_id=? AND status='approved' AND reading_at <= ? ORDER BY reading_at DESC LIMIT 1`, meter.id, period_start + 'T23:59:59.999Z');
        if (r) { opening = eff(r); openingAt = r.reading_at; openingId = r.id; }
        else { opening = meter.initial_reading || 0; openingAt = (meter.install_date || '1970-01-01') + 'T00:00:00.000Z'; }
      }
      const closingR = db.get(`SELECT * FROM readings WHERE meter_id=? AND status='approved' AND reading_at > ? AND reading_at <= ? ORDER BY reading_at DESC LIMIT 1`, meter.id, openingAt, endOf(period_end));
      let closing, estimated = false, simulated = false;
      if (closingR) {
        closing = eff(closingR); estimated = !!closingR.is_estimated; simulated = !!closingR.is_simulated;
        if (simulated && db.MODE === 'live') { res.status = 'skipped'; res.reason = 'Closing reading is simulated — not billable in live mode'; continue; }
      } else if (estimate_missing) {
        const avg = avgDaily(meter.id, endOf(period_end));
        if (avg == null) { res.status = 'skipped'; res.reason = 'No approved reading and not enough history to estimate'; continue; }
        const days = Math.max(1, Math.round((Date.parse(period_end) - Date.parse(period_start)) / 86400000) + 1);
        closing = Math.round((opening + avg * days) * 1000) / 1000; estimated = true;
      } else { res.status = 'skipped'; res.reason = 'No approved reading in this period (review pending readings or tick "estimate missing")'; continue; }
      const consumption = Math.round((closing - opening) * 1000) / 1000;
      if (consumption < 0) { res.status = 'skipped'; res.reason = `Negative consumption (${consumption} m³) — check meter readings`; continue; }
      const charges = computeCharges(tariff, consumption, estimated);
      // Financed connection-fee instalments due by this period are added as their own (untaxed) lines.
      const fin = require('./connections').dueCharges(c.id, period_end).filter(f => f.currency === c.area_currency);
      for (const f of fin) { charges.lines.push({ line_type: 'financed', description: `${f.description} ${f.seq}/${f.of_total}`, quantity: 1, unit_price: f.amount, amount: f.amount }); charges.subtotal = r2(charges.subtotal + f.amount); charges.total = r2(charges.total + f.amount); }
      Object.assign(res, { status: 'ok', tariff: tariff.code, opening, closing, consumption, estimated, simulated, ...charges, billing_mode: c.billing_mode });
      if (!commit) continue;
      const prevBal = balance(c.id);
      const issue = today();
      const due = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);
      const number = nextNumber('bill', n => `B${period_end.slice(0, 7).replace('-', '')}-${n}`);
      const ins = db.run(`INSERT INTO bills(bill_number, customer_id, period_start, period_end, issue_date, due_date, currency, tariff_id, billing_mode, meter_id,
        opening_reading_id, closing_reading_id, opening_value, closing_value, consumption, is_estimated, is_simulated, subtotal, tax, total, previous_balance, amount_due, created_by, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, number, c.id, period_start, period_end, issue, due, c.area_currency, tariff.id, c.billing_mode, meter.id,
        openingId, closingR ? closingR.id : null, opening, closing, consumption, estimated ? 1 : 0, simulated ? 1 : 0, charges.subtotal, charges.tax, charges.total,
        prevBal, r2(prevBal + charges.total), ctx.user.id, c.billing_mode === 'prepaid' ? 'Prepaid account: consumption charged against credit balance (future-ready mode)' : null);
      for (const l of charges.lines) db.run('INSERT INTO bill_lines(bill_id, line_type, description, quantity, unit_price, amount) VALUES (?,?,?,?,?,?)', ins.id, l.line_type, l.description, l.quantity, l.unit_price, l.amount);
      if (closingR) db.run('UPDATE readings SET billed_bill_id=? WHERE id=?', ins.id, closingR.id);
      // Apply any unallocated credit (prepayments / overpayments) to the new bill.
      applyCredit(c.id);
      refreshBill(ins.id);
      res.bill_id = ins.id; res.bill_number = number;
      db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', c.id, 'bill', `Bill ${number} issued: ${charges.total} ${c.area_currency}`, ctx.user.id);
      for (const f of fin) db.run('UPDATE financed_charges SET bill_id=? WHERE id=?', ins.id, f.id);
      require('./channels').notifyBill(db.get('SELECT * FROM bills WHERE id=?', ins.id), c);
      require('./shared').splitBill(ctx, db.get('SELECT * FROM bills WHERE id=?', ins.id), c);
      audit.log(ctx, 'bill.create', 'bill', ins.id, { number, customer: c.customer_number, total: charges.total, currency: c.area_currency, consumption, estimated, simulated });
    }
  };
  if (commit) db.tx(work); else work();
  return { committed: !!commit, period_start, period_end, results, summary: {
    ok: results.filter(r => r.status === 'ok').length, skipped: results.filter(r => r.status === 'skipped').length } };
}

function outstandingBills(customerId) {
  return db.all(`SELECT * FROM bills WHERE customer_id=? AND status IN ('issued','partially_paid','overdue') ORDER BY due_date, id`, customerId);
}

function unallocated(paymentId) {
  const p = db.get('SELECT amount FROM payments WHERE id=?', paymentId);
  const a = db.get('SELECT COALESCE(SUM(amount),0) s FROM payment_allocations WHERE payment_id=?', paymentId).s;
  return r2(p.amount - a);
}
function allocate(paymentId, amount, preferredBillId, customerId) {
  let left = amount;
  const bills = outstandingBills(customerId);
  if (preferredBillId) bills.sort((a, b) => (a.id === preferredBillId ? -1 : b.id === preferredBillId ? 1 : 0));
  for (const b of bills) {
    if (left <= 0.004) break;
    const out = billOutstanding(b);
    if (out <= 0) continue;
    const amt = r2(Math.min(out, left));
    db.run('INSERT INTO payment_allocations(payment_id, bill_id, amount) VALUES (?,?,?)', paymentId, b.id, amt);
    left = r2(left - amt);
    refreshBill(b.id);
  }
}
function applyCredit(customerId) {
  for (const p of db.all(`SELECT id FROM payments WHERE customer_id=? AND status='posted' AND amount > 0 ORDER BY received_at`, customerId)) {
    const left = unallocated(p.id);
    if (left > 0.004) allocate(p.id, left, null, customerId);
  }
}

function findRate(from, to, onDate) {
  const r = db.get(`SELECT * FROM exchange_rates WHERE from_currency=? AND to_currency=? AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`, from, to, onDate);
  if (r) return { rate: r.rate, id: r.id, date: r.effective_date };
  const inv = db.get(`SELECT * FROM exchange_rates WHERE from_currency=? AND to_currency=? AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1`, to, from, onDate);
  if (inv) return { rate: 1 / inv.rate, id: inv.id, date: inv.effective_date };
  return null;
}

function recordPayment(ctx, data) {
  return db.tx(() => {
    const c = db.get('SELECT c.*, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', data.customer_id);
    if (!c) throw new HttpError(404, 'Customer not found');
    if (data.bill_id) {
      const b = db.get('SELECT * FROM bills WHERE id=? AND customer_id=?', data.bill_id, c.id);
      if (!b) throw new HttpError(400, 'Bill does not belong to this customer');
      if (b.status === 'cancelled') throw new HttpError(400, 'Bill is cancelled');
    }
    if (data.reference) {
      const dup = db.get(`SELECT receipt_number FROM payments WHERE reference=? AND method=? AND amount > 0`, data.reference, data.method);
      if (dup) throw new HttpError(409, `This ${data.method.replace(/_/g, ' ')} reference was already recorded on receipt ${dup.receipt_number}`);
    }
    const tenderedCur = data.currency || c.currency;
    if (data.method === 'cash' && ctx.user && data.purpose !== 'reversal') { const day = require('../lib/tz').localDate(new Date(data.received_at || Date.now()));
      if (require('./cashclose').isClosed(ctx.user.id, day, tenderedCur)) throw new HttpError(409, `You have already closed your ${tenderedCur} cash for ${day}. Ask a manager to reopen the close (reject it) before taking more cash.`); }
    let amount = data.amount, rateUsed = null;
    if (tenderedCur !== c.currency) {
      const rate = findRate(tenderedCur, c.currency, (data.received_at || new Date().toISOString()).slice(0, 10));
      if (!rate) throw new HttpError(400, `No ${tenderedCur}→${c.currency} exchange rate is configured. Ask an administrator to add one in Settings.`);
      amount = r2(data.amount * rate.rate); rateUsed = rate.rate;
    }
    const receipt = nextNumber('receipt', n => `R${(data.received_at || new Date().toISOString()).slice(0, 10).replace(/-/g, '')}-${n}`);
    const ins = db.run(`INSERT INTO payments(receipt_number, customer_id, bill_id, amount, currency, tendered_amount, tendered_currency, exchange_rate_used, method, purpose,
      reference, received_at, received_by, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, receipt, c.id, data.bill_id || null, amount, c.currency, data.amount, tenderedCur,
      rateUsed, data.method, data.purpose || (c.billing_mode === 'prepaid' ? 'prepaid_credit' : 'bill_payment'), data.reference || null,
      data.received_at || new Date().toISOString(), ctx.user ? ctx.user.id : null, data.notes || null);
    if (data.is_simulated || data.momo_id) db.run('UPDATE payments SET is_simulated=?, momo_id=? WHERE id=?', data.is_simulated ? 1 : 0, data.momo_id || null, ins.id);
    allocate(ins.id, amount, data.bill_id, c.id);
    db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', c.id, 'payment', `Payment ${receipt}: ${amount} ${c.currency} (${data.method})${data.is_simulated ? ' [SIMULATED]' : ''}`, ctx.user ? ctx.user.id : null);
    require('./channels').notifyPayment({ amount, currency: c.currency, receipt_number: receipt }, c, balance(c.id));
    audit.log(ctx, 'payment.create', 'payment', ins.id, { receipt, customer: c.customer_number, amount, currency: c.currency, tendered: data.amount, tendered_currency: tenderedCur, method: data.method, reference: data.reference });
    return db.get('SELECT * FROM payments WHERE id=?', ins.id);
  });
}

function reversePayment(ctx, id, reason) {
  if (!reason || reason.length < 5) throw new HttpError(400, 'A reversal reason (at least 5 characters) is required');
  return db.tx(() => {
    const p = db.get('SELECT * FROM payments WHERE id=?', id);
    if (!p) throw new HttpError(404, 'Payment not found');
    if (p.status !== 'posted' || p.amount <= 0) throw new HttpError(409, 'Only posted payments can be reversed (and only once)');
    if (p.received_by && p.received_by === ctx.user.id && ctx.user.role !== 'admin') throw new HttpError(403, 'A different authorised user must reverse a payment you recorded (segregation of duties)');
    const receipt = nextNumber('receipt', n => `RV${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${n}`);
    const ins = db.run(`INSERT INTO payments(receipt_number, customer_id, bill_id, amount, currency, method, purpose, reference, received_at, received_by, notes, status, reversal_of, reversal_reason)
      VALUES (?,?,?,?,?,?,'reversal',?,?,?,?,'reversal',?,?)`, receipt, p.customer_id, p.bill_id, -p.amount, p.currency, p.method, p.reference ? 'REV ' + p.reference : null,
      new Date().toISOString(), ctx.user.id, 'Reversal of ' + p.receipt_number, p.id, reason);
    db.run(`UPDATE payments SET status='reversed', reversal_reason=? WHERE id=?`, reason, p.id);
    for (const a of db.all('SELECT bill_id, SUM(amount) s FROM payment_allocations WHERE payment_id=? GROUP BY bill_id', p.id)) {
      if (a.s) db.run('INSERT INTO payment_allocations(payment_id, bill_id, amount) VALUES (?,?,?)', ins.id, a.bill_id, -a.s);
      refreshBill(a.bill_id);
    }
    audit.log(ctx, 'payment.reverse', 'payment', p.id, { receipt: p.receipt_number, reversal_receipt: receipt, amount: p.amount, reason });
    return db.get('SELECT * FROM payments WHERE id=?', ins.id);
  });
}

function cancelBill(ctx, id, reason) {
  if (!reason || reason.length < 5) throw new HttpError(400, 'A cancellation reason is required');
  return db.tx(() => {
    const b = db.get('SELECT * FROM bills WHERE id=?', id);
    if (!b) throw new HttpError(404, 'Bill not found');
    if (b.status === 'cancelled') throw new HttpError(409, 'Bill already cancelled');
    if (b.paid > 0) throw new HttpError(409, 'Bill has payments allocated. Reverse the payments or post a credit adjustment instead.');
    const later = db.get(`SELECT bill_number FROM bills WHERE customer_id=? AND meter_id=? AND status!='cancelled' AND period_end > ?`, b.customer_id, b.meter_id, b.period_end);
    if (later) throw new HttpError(409, `A later bill (${later.bill_number}) exists. Cancel later bills first so readings stay consistent.`);
    db.run(`UPDATE bills SET status='cancelled', cancel_reason=? WHERE id=?`, reason, id);
    db.run('UPDATE readings SET billed_bill_id=NULL WHERE billed_bill_id=?', id);
    db.run('UPDATE financed_charges SET bill_id=NULL WHERE bill_id=?', id);
    db.run('DELETE FROM bill_shares WHERE bill_id=?', id);
    audit.log(ctx, 'bill.cancel', 'bill', id, { number: b.bill_number, total: b.total, reason });
    return db.get('SELECT * FROM bills WHERE id=?', id);
  });
}

module.exports = { selectTariff, computeCharges, generate, balance, ledger, recordPayment, reversePayment, cancelBill, refreshBill, refreshAllBills, billOutstanding, findRate, nextNumber, applyCredit, r2 };
