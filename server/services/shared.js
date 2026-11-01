'use strict';
/*
 * Shared compound connections: one meter and one account, several households.
 * Each bill is split into member shares (equal, by household size, or fixed %). Every household gets its own SMS and
 * its own mobile-money reference (<customer number>-<member no.>), so each can pay its part. The account holder
 * remains responsible for the account balance; shares are a fairness and collection aid.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const channels = require('./channels');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function getGroup(customerId) {
  const g = db.get('SELECT * FROM shared_groups WHERE customer_id=?', customerId); if (!g) return null;
  return { ...g, members: db.all('SELECT * FROM shared_members WHERE group_id=? ORDER BY seq', g.id) };
}

function saveGroup(ctx, customerId, b) {
  return db.tx(() => {
    const c = db.get('SELECT * FROM customers WHERE id=?', customerId); if (!c) throw new HttpError(404, 'Customer not found');
    const members = (b.members || []).filter(m => m && m.name);
    if (b.active !== false && members.length < 2) throw new HttpError(400, 'A shared connection needs at least two households');
    if (b.split_method === 'fixed_pct') { const t = members.reduce((s, m) => s + Number(m.share_pct || 0), 0); if (Math.abs(t - 100) > 0.01) throw new HttpError(400, `Fixed shares must add up to 100% (now ${t}%)`); }
    if (b.split_method === 'household_size' && members.some(m => !(Number(m.household_size) > 0))) throw new HttpError(400, 'Enter the number of people for every household');
    let g = db.get('SELECT * FROM shared_groups WHERE customer_id=?', customerId);
    if (!g) g = { id: db.run('INSERT INTO shared_groups(customer_id, split_method, active, notes, created_by) VALUES (?,?,?,?,?)', customerId, b.split_method, b.active === false ? 0 : 1, b.notes || null, ctx.user.id).id };
    else db.run('UPDATE shared_groups SET split_method=?, active=?, notes=? WHERE id=?', b.split_method, b.active === false ? 0 : 1, b.notes || null, g.id);
    const existing = db.all('SELECT * FROM shared_members WHERE group_id=?', g.id);
    let maxSeq = existing.reduce((m, x) => Math.max(m, x.seq), 0);
    const keep = new Set();
    for (const m of members) {
      const ex = m.seq && existing.find(x => x.seq === Number(m.seq));
      if (ex) { db.run('UPDATE shared_members SET name=?, phone=?, household_size=?, share_pct=?, active=1 WHERE id=?', m.name, m.phone || null, m.household_size || null, m.share_pct ?? null, ex.id); keep.add(ex.id); }
      else { const id = db.run('INSERT INTO shared_members(group_id, seq, name, phone, household_size, share_pct) VALUES (?,?,?,?,?,?)', g.id, ++maxSeq, m.name, m.phone || null, m.household_size || null, m.share_pct ?? null).id; keep.add(id); }
    }
    for (const x of existing) if (!keep.has(x.id)) db.run('UPDATE shared_members SET active=0 WHERE id=?', x.id);
    db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id) VALUES (?,?,?,?)', customerId, 'shared', `Shared connection: ${members.length} households, split ${b.split_method.replace('_', ' ')}`, ctx.user.id);
    // Split the current unpaid bill too, so the households can start paying their parts now
    const open = db.get(`SELECT * FROM bills b WHERE customer_id=? AND status NOT IN ('paid','cancelled') AND NOT EXISTS (SELECT 1 FROM bill_shares s WHERE s.bill_id=b.id) ORDER BY period_end DESC LIMIT 1`, customerId);
    if (open && b.active !== false) splitBill(ctx, open, c);
    audit.log(ctx, 'shared.save', 'customer', customerId, { split_method: b.split_method, members: members.length, active: b.active !== false });
    return getGroup(customerId);
  });
}

function weights(method, members) {
  if (method === 'household_size') return members.map(m => Number(m.household_size) || 1);
  if (method === 'fixed_pct') return members.map(m => Number(m.share_pct) || 0);
  return members.map(() => 1);
}

/** Called when a bill is issued. */
function splitBill(ctx, bill, customer) {
  const g = getGroup(bill.customer_id); if (!g || !g.active) return;
  const members = g.members.filter(m => m.active); if (members.length < 2) return;
  const w = weights(g.split_method, members); const tw = w.reduce((a, b) => a + b, 0) || 1;
  let left = bill.total;
  members.forEach((m, i) => {
    const amt = i === members.length - 1 ? r2(left) : r2(Math.floor(bill.total * w[i] / tw * 100) / 100); left = r2(left - amt);
    db.run('INSERT OR IGNORE INTO bill_shares(bill_id, member_id, amount) VALUES (?,?,?)', bill.id, m.id, amt);
    if (m.phone) { const L = require('../lib/i18n').langForPhone(m.phone); channels.sendT(m.phone, 'share.bill', { bill: bill.bill_number, name: customer.name, amount: channels.money(amt, bill.currency, L), due: bill.due_date, ref: `${customer.customer_number}-${m.seq}` }, { customer_id: customer.id, purpose: 'bill_share' }); }
  });
}

/** Mobile-money reference "<customer number>-<member no.>" → member. */
function memberByRef(ref) {
  const parts = String(ref || '').trim().split(/[\s\-\/_.]+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]; if (!/^\d{1,2}$/.test(last)) return null;
  const c = channels.customerByRef(parts.slice(0, -1).join('-')); if (!c) return null;
  const g = db.get('SELECT * FROM shared_groups WHERE customer_id=? AND active=1', c.id); if (!g) return null;
  const m = db.get('SELECT * FROM shared_members WHERE group_id=? AND seq=? AND active=1', g.id, Number(last));
  return m ? { customer: c, member: m } : null;
}

/** Credit a payment to a member's oldest unpaid shares. */
function creditMember(memberId, amount) {
  let left = amount;
  for (const s of db.all(`SELECT bs.* FROM bill_shares bs JOIN bills b ON b.id=bs.bill_id WHERE bs.member_id=? AND bs.paid < bs.amount AND b.status!='cancelled' ORDER BY b.period_end`, memberId)) {
    if (left <= 0.004) break; const x = r2(Math.min(left, s.amount - s.paid)); db.run('UPDATE bill_shares SET paid=round(paid + ?, 2) WHERE id=?', x, s.id); left = r2(left - x);
  }
  return r2(amount - left);
}

function status(customerId) {
  const g = getGroup(customerId); if (!g) return null;
  const bills = db.all(`SELECT id, bill_number, period_end, total, currency, status FROM bills WHERE customer_id=? AND status!='cancelled' ORDER BY period_end DESC LIMIT 6`, customerId);
  return { ...g, bills: bills.map(b => ({ ...b, shares: db.all('SELECT bs.*, m.name, m.seq FROM bill_shares bs JOIN shared_members m ON m.id=bs.member_id WHERE bs.bill_id=? ORDER BY m.seq', b.id) })),
    members: g.members.map(m => ({ ...m, owed: r2(db.get(`SELECT COALESCE(SUM(bs.amount - bs.paid),0) s FROM bill_shares bs JOIN bills b ON b.id=bs.bill_id WHERE bs.member_id=? AND b.status!='cancelled'`, m.id).s) })) };
}

module.exports = { getGroup, saveGroup, splitBill, memberByRef, creditMember, status };
