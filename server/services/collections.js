'use strict';
/*
 * Humane collections: friendly reminders before and after due dates, instalment plans for arrears, and a staged
 * escalation ladder. Nothing is ever disconnected automatically; essential services (clinics, schools, public water
 * points, flagged accounts) are excluded from disconnection review altogether.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const billing = require('./billing');
const channels = require('./channels');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const isEssential = c => !!c.essential_service || ['public_water_point', 'institution'].includes(c.customer_type);

function schedule(arrears, down, n, frequency, start) {
  const rest = r2(arrears - down); const each = Math.floor(rest / n * 100) / 100; const out = [];
  for (let i = 0; i < n; i++) out.push({ seq: i + 1, due_date: frequency === 'weekly' ? addDays(start, 7 * i) : addMonths(start, i), amount: i === n - 1 ? r2(rest - each * (n - 1)) : each });
  return out;
}

function createPlan(ctx, b) {
  return db.tx(() => {
    const c = db.get('SELECT c.*, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', b.customer_id); if (!c) throw new HttpError(404, 'Customer not found');
    if (db.get(`SELECT 1 FROM payment_plans WHERE customer_id=? AND status='active'`, c.id)) throw new HttpError(409, 'This customer already has an active payment plan');
    const arrears = billing.balance(c.id); if (arrears <= 0) throw new HttpError(400, 'No arrears to put on a plan');
    const down = b.down_payment || 0; if (down >= arrears) throw new HttpError(400, 'Down payment must be less than the arrears');
    const start = b.start_date || today();
    const sch = schedule(arrears, down, b.instalments, b.frequency, start);
    const r = db.run('INSERT INTO payment_plans(customer_id, arrears, currency, down_payment, instalments, frequency, start_date, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', c.id, arrears, c.currency, down, b.instalments, b.frequency, start, b.notes || null, ctx.user.id, new Date().toISOString());
    for (const s of sch) db.run('INSERT INTO plan_instalments(plan_id, seq, due_date, amount) VALUES (?,?,?,?)', r.id, s.seq, s.due_date, s.amount);
    db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', c.id, 'payment_plan', `Payment plan: ${channels.money(arrears, c.currency)} arrears${down ? `, ${channels.money(down, c.currency)} down` : ''}, ${b.instalments} ${b.frequency} instalments of about ${channels.money(sch[0].amount, c.currency)}`, ctx.user.id);
    if (c.phone) { const L = require('../lib/i18n').langForCustomer(c); channels.sendT(c.phone, 'plan.agreed', { account: c.customer_number, down: down ? channels.T(L, 'plan.down', { amount: channels.money(down, c.currency, L) }) : '', n: b.instalments, amount: channels.money(sch[0].amount, c.currency, L), freq: channels.T(L, 'freq.' + b.frequency), start }, { customer_id: c.id, purpose: 'plan' }, L); }
    audit.log(ctx, 'plan.create', 'payment_plan', r.id, { customer: c.customer_number, arrears, down, instalments: b.instalments, frequency: b.frequency });
    return planStatus(r.id);
  });
}

/** Progress is measured from payments received since the plan started (net of reversals). */
function planStatus(planId) {
  const p = db.get('SELECT pl.*, c.name customer_name, c.customer_number, c.phone FROM payment_plans pl JOIN customers c ON c.id=pl.customer_id WHERE pl.id=?', planId); if (!p) return null;
  const inst = db.all('SELECT * FROM plan_instalments WHERE plan_id=? ORDER BY seq', planId);
  const paid = r2(db.get(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE customer_id=? AND received_at >= ?`, p.customer_id, p.created_at.includes('T') ? p.created_at : p.created_at.replace(' ', 'T') + 'Z').s);
  let pool = r2(paid - p.down_payment); const t = today();
  const rows = inst.map(i => { const cover = Math.max(0, Math.min(i.amount, pool)); pool = r2(pool - cover);
    return { ...i, paid: r2(cover), status: cover >= i.amount - 0.004 ? 'paid' : i.due_date < t ? 'overdue' : cover > 0 ? 'part_paid' : i.due_date === t ? 'due_today' : 'upcoming' }; });
  const dueSoFar = r2(p.down_payment + inst.filter(i => i.due_date <= t).reduce((s, i) => s + i.amount, 0));
  const behind = r2(Math.max(0, dueSoFar - paid));
  const oldestOverdue = rows.find(r => r.status === 'overdue');
  const daysLate = oldestOverdue ? Math.floor((Date.parse(t) - Date.parse(oldestOverdue.due_date)) / 86400e3) : 0;
  let health = 'on_track';
  if (p.status === 'active') {
    if (paid >= r2(p.arrears) - 0.004 || billing.balance(p.customer_id) <= 0) { db.run(`UPDATE payment_plans SET status='completed', closed_at=datetime('now') WHERE id=?`, p.id); p.status = 'completed'; }
    else if (daysLate > db.settingNum('plan_default_after_days', 30)) { db.run(`UPDATE payment_plans SET status='defaulted', closed_at=datetime('now') WHERE id=?`, p.id); p.status = 'defaulted'; }
  }
  if (behind > 0) health = daysLate > 14 ? 'at_risk' : 'behind';
  return { ...p, paid, due_so_far: dueSoFar, behind, days_late: daysLate, health: p.status === 'active' ? health : p.status, progress_pct: r2(Math.min(100, paid / p.arrears * 100)), instalments: rows };
}

function cancelPlan(ctx, id, reason) {
  const p = db.get('SELECT * FROM payment_plans WHERE id=?', id); if (!p || p.status !== 'active') throw new HttpError(409, 'Only active plans can be cancelled');
  db.run(`UPDATE payment_plans SET status='cancelled', closed_at=datetime('now'), notes=COALESCE(notes,'') || ' | Cancelled: ' || ? WHERE id=?`, reason, id);
  audit.log(ctx, 'plan.cancel', 'payment_plan', id, { reason });
}

// ---------------- Reminders ----------------
function remind(kind, ref, c, key, vars) {
  if (!c.phone || db.get('SELECT 1 FROM reminders_sent WHERE kind=? AND ref=?', kind, ref)) return 0;
  const cust = db.get('SELECT id, phone, language FROM customers WHERE id=?', c.id) || c; const L = require('../lib/i18n').langForCustomer(cust);
  const v = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, x && x.__money ? channels.money(x.n, x.cur, L) : x]));
  const sid = channels.sendT(c.phone, key, v, { customer_id: c.id, purpose: 'reminder' }, L);
  db.run('INSERT INTO reminders_sent(kind, ref, customer_id, sms_id) VALUES (?,?,?,?)', kind, ref, c.id, sid);
  return 1;
}
function runReminders(ctx) {
  const t = today(); const before = db.settingNum('reminder_days_before_due', 3), after = db.settingNum('reminder_days_overdue', 7);
  const ussd = db.setting('ussd_code'); const out = { due_soon: 0, overdue: 0, instalment: 0 };
  for (const b of db.all(`SELECT b.*, c.phone, c.customer_number, c.id cid, c.billing_mode FROM bills b JOIN customers c ON c.id=b.customer_id WHERE b.status IN ('issued','partially_paid','overdue') AND c.status='active'`)) {
    const out_ = billing.billOutstanding(b); if (out_ <= 0 || b.billing_mode === 'prepaid') continue;
    const c = { id: b.cid, phone: b.phone, customer_number: b.customer_number };
    const inPlan = db.get(`SELECT 1 FROM payment_plans WHERE customer_id=? AND status='active'`, c.id);
    if (b.due_date > t && b.due_date <= addDays(t, before)) out.due_soon += remind('due_soon', 'bill:' + b.id, c, 'remind.due_soon', { bill: b.bill_number, amount: { __money: 1, n: out_, cur: b.currency }, due: b.due_date, account: c.customer_number, ussd });
    else if (!inPlan && b.due_date <= addDays(t, -after)) out.overdue += remind('overdue', 'bill:' + b.id, c, 'remind.overdue', { bill: b.bill_number, amount: { __money: 1, n: out_, cur: b.currency }, account: c.customer_number });
  }
  for (const p of db.all(`SELECT id FROM payment_plans WHERE status='active'`)) {
    const s = planStatus(p.id); if (s.status !== 'active') continue;
    for (const i of s.instalments.filter(x => ['upcoming', 'due_today', 'part_paid'].includes(x.status) && x.due_date <= addDays(t, 1))) {
      out.instalment += remind('instalment', `plan:${p.id}:${i.seq}`, { id: s.customer_id, phone: s.phone, customer_number: s.customer_number }, 'remind.instalment', { seq: i.seq, of: s.instalments.length ?? s.instalments, amount: { __money: 1, n: i.amount - i.paid, cur: s.currency }, due: i.due_date, account: s.customer_number });
    }
  }
  db.run(`INSERT INTO settings(key,value) VALUES('last_reminders_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, t);
  audit.log(ctx, 'reminders.run', 'reminders', null, out);
  return out;
}

// ---------------- Escalation ladder ----------------
const STAGES = { reminder: 'Reminder (SMS)', contact: 'Personal contact (call / visit)', offer_plan: 'Offer a payment plan', review: 'Disconnection review — manager decides', escalate: 'Essential service — escalate to management (no disconnection)', on_plan: 'On a payment plan' };
function ladder({ area_id } = {}) {
  const t = today(); const rows = [];
  for (const c of db.all(`SELECT c.*, a.currency, a.name area_name FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.status IN ('active','suspended') ${area_id ? 'AND c.area_id=?' : ''}`, ...(area_id ? [area_id] : []))) {
    const bal = billing.balance(c.id); if (bal <= 0.004) continue;
    const bills = db.all(`SELECT * FROM bills WHERE customer_id=? AND status IN ('issued','partially_paid','overdue') ORDER BY due_date`, c.id).filter(b => billing.billOutstanding(b) > 0);
    const oldest = bills[0]; const days = oldest ? Math.floor((Date.parse(t) - Date.parse(oldest.due_date)) / 86400e3) : 0;
    if (days <= 0) continue;
    const avgBill = db.get(`SELECT AVG(total) a FROM bills WHERE customer_id=? AND status!='cancelled'`, c.id).a || bal;
    const plan = db.get(`SELECT id FROM payment_plans WHERE customer_id=? AND status IN ('active','defaulted') ORDER BY id DESC LIMIT 1`, c.id);
    const ps = plan ? planStatus(plan.id) : null;
    let stage = days <= 30 ? 'reminder' : days <= 60 ? 'contact' : 'offer_plan';
    if (days > 90 || (ps && ps.status === 'defaulted')) stage = isEssential(c) ? 'escalate' : 'review';
    if (bal > 2 * avgBill && stage === 'contact') stage = 'offer_plan';
    const last = db.get(`SELECT received_at, amount FROM payments WHERE customer_id=? AND amount > 0 ORDER BY received_at DESC LIMIT 1`, c.id);
    // Humane caps: someone who is still paying, or owes less than one normal bill, is not escalated to review.
    const payingRecently = last && Date.parse(t) - Date.parse(last.received_at) < 31 * 86400e3;
    if (['review', 'escalate'].includes(stage) && payingRecently && !(ps && ps.status === 'defaulted')) stage = 'offer_plan';
    if (bal < avgBill && ['offer_plan', 'review', 'escalate'].includes(stage)) stage = 'contact';
    if (ps && ps.status === 'active') stage = 'on_plan';
    const review = db.get(`SELECT wo_number, status FROM work_orders WHERE customer_id=? AND type='connection' AND title LIKE 'Disconnection review%' AND status NOT IN ('completed','cancelled') LIMIT 1`, c.id);
    rows.push({ customer_id: c.id, customer_number: c.customer_number, name: c.name, customer_type: c.customer_type, area_name: c.area_name, phone: !!c.phone, currency: c.currency, balance: bal, oldest_days_overdue: days,
      avg_bill: r2(avgBill), stage, stage_label: STAGES[stage], essential: isEssential(c), plan: ps ? { id: ps.id, health: ps.health, progress_pct: ps.progress_pct, behind: ps.behind } : null,
      last_payment: last ? last.received_at : null, paying_recently: !!payingRecently, reminders: db.get('SELECT COUNT(*) n FROM reminders_sent WHERE customer_id=?', c.id).n, review_wo: review ? review.wo_number : null });
  }
  const order = ['review', 'escalate', 'offer_plan', 'contact', 'reminder', 'on_plan'];
  return rows.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage) || b.oldest_days_overdue - a.oldest_days_overdue);
}

function recommendReview(ctx, customerId, note) {
  const c = db.get('SELECT c.*, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.id=?', customerId); if (!c) throw new HttpError(404, 'Customer not found');
  if (isEssential(c)) throw new HttpError(409, 'Essential service (clinic, school, public water point or flagged account): disconnection is not allowed. Escalate to management instead.');
  if (!note || note.length < 10) throw new HttpError(400, 'Record what was tried (reminders, contact, plan offer) — at least 10 characters');
  const bal = billing.balance(c.id);
  const num = billing.nextNumber('wo', n => 'WO-' + n);
  const r = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, customer_id, area_id, lat, lng, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,'open',?)`, num, 'connection', 'medium',
    `Disconnection review — ${c.name} (manager decision required)`, `Balance ${channels.money(bal, c.currency)}. Steps taken: ${note}. A manager must review before any action; check for vulnerable occupants and offer a plan first.`, c.id, c.area_id, c.lat, c.lng, ctx.user.id);
  db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', r.id, ctx.user.id, 'open', 'Created from collections ladder');
  audit.log(ctx, 'collections.review', 'customer', c.id, { wo: num, balance: bal, note });
  return { id: r.id, wo_number: num };
}

module.exports = { createPlan, planStatus, cancelPlan, runReminders, ladder, recommendReview, schedule, isEssential, STAGES };
