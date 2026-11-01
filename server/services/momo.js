'use strict';
/*
 * Mobile-money reconciliation. Transactions arrive from (a) a provider/aggregator webhook, (b) a statement CSV exported
 * from the merchant portal, or (c) the demo simulator. Each is matched automatically:
 *   1. reference = water-card number  → top up that water card
 *   2. reference = customer number    → post a bill payment to that account
 *   3. sender phone = exactly one customer (or one water card) → post to it
 * Anything else lands in the "unmatched" queue for a cashier. A provider transaction ID is only ever used once.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const csv = require('../lib/csv');
const { HttpError } = require('../lib/http');
const channels = require('./channels');

const methodOf = provider => (require('../lib/i18n').momoProviders().some(p => p.code === provider) ? 'mobile_money_' + provider : 'other');

function ingest(ctx, t) {
  return db.tx(() => {
    const ex = db.get('SELECT * FROM momo_transactions WHERE provider=? AND txn_ref=?', t.provider, t.txn_ref);
    if (ex) return { ...ex, duplicate: true };
    if (t.source === 'simulator' && db.MODE === 'live') throw new HttpError(409, 'The mobile-money simulator is disabled in the live system');
    const ins = db.run(`INSERT INTO momo_transactions(provider, txn_ref, msisdn, amount, currency, account_ref, received_at, source, is_simulated, raw) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      t.provider, t.txn_ref, t.msisdn || null, t.amount, t.currency, t.account_ref || null, t.received_at || new Date().toISOString(), t.source, t.source === 'simulator' ? 1 : 0, t.raw ? JSON.stringify(t.raw).slice(0, 4000) : null);
    audit.log(ctx, 'momo.received', 'momo_transaction', ins.id, { provider: t.provider, txn_ref: t.txn_ref, amount: t.amount, currency: t.currency, ref: t.account_ref, source: t.source });
    return autoMatch(ctx, ins.id);
  });
}

function autoMatch(ctx, id) {
  const t = db.get('SELECT * FROM momo_transactions WHERE id=?', id);
  const shm = require('./shared').memberByRef(t.account_ref);
  if (shm) { try { return post(ctx, id, { customer_id: shm.customer.id, member_id: shm.member.id }, 'shared_member_reference'); } catch (e) { db.run('UPDATE momo_transactions SET note=? WHERE id=?', 'Auto-match failed: ' + e.message, id); return db.get('SELECT * FROM momo_transactions WHERE id=?', id); } }
  let w = channels.walletByRef(t.account_ref), c = !w && channels.customerByRef(t.account_ref), how = w ? 'card_reference' : c ? 'account_reference' : null;
  if (!w && !c && t.msisdn) {
    const cs = channels.customersByPhone(t.msisdn), ws = channels.walletsByPhone(t.msisdn);
    if (cs.length === 1 && !ws.length) { c = cs[0]; how = 'sender_phone'; } else if (ws.length === 1 && !cs.length) { w = ws[0]; how = 'sender_phone'; }
    else if (cs.length + ws.length > 1) { db.run(`UPDATE momo_transactions SET note=? WHERE id=?`, 'Sender phone matches several accounts — choose one', id); }
  }
  if (!w && !c) return db.get('SELECT * FROM momo_transactions WHERE id=?', id);
  try { return post(ctx, id, { customer_id: c && c.id, wallet_id: w && w.id }, how); }
  catch (e) { db.run('UPDATE momo_transactions SET note=? WHERE id=?', 'Auto-match failed: ' + e.message, id); return db.get('SELECT * FROM momo_transactions WHERE id=?', id); }
}

function post(ctx, id, target, how) { return db.tx(() => postInner(ctx, id, target, how)); }
function postInner(ctx, id, target, how) {
  const t = db.get('SELECT * FROM momo_transactions WHERE id=?', id);
  if (!t) throw new HttpError(404, 'Not found');
  if (t.status !== 'unmatched') throw new HttpError(409, 'Already ' + t.status);
  const actx = ctx.user ? ctx : { ...ctx, actor: 'momo:auto' };
  if (target.wallet_id) {
    const r = require('./waterpoints').topup(actx, { wallet_id: target.wallet_id, amount: t.amount, currency: t.currency, method: 'mobile_money', momo_id: t.id, is_simulated: !!t.is_simulated, note: `${t.provider.toUpperCase()} ${t.txn_ref}` });
    db.run(`UPDATE momo_transactions SET status='matched', match_method=?, wallet_id=?, wp_transaction_id=?, matched_by=?, note=NULL WHERE id=?`, how, target.wallet_id, r.id, ctx.user ? ctx.user.id : null, id);
  } else {
    const p = require('./billing').recordPayment(actx, { customer_id: target.customer_id, amount: t.amount, currency: t.currency, method: methodOf(t.provider), reference: t.txn_ref,
      received_at: t.received_at, notes: `${how === 'manual' ? 'Matched by cashier' : 'Auto-matched by ' + how.replace('_', ' ')} from ${t.provider.toUpperCase()} mobile money${t.is_simulated ? ' — SIMULATED' : ''}`, is_simulated: !!t.is_simulated, momo_id: t.id });
    if (target.member_id) { const credited = require('./shared').creditMember(target.member_id, p.amount); const m = db.get('SELECT * FROM shared_members WHERE id=?', target.member_id);
      db.run(`UPDATE payments SET notes = COALESCE(notes,'') || ? WHERE id=?`, ` — share of household ${m.seq} (${m.name}), ${credited} credited to their share`, p.id); }
    db.run(`UPDATE momo_transactions SET status='matched', match_method=?, customer_id=?, payment_id=?, matched_by=?, note=NULL WHERE id=?`, how, target.customer_id, p.id, ctx.user ? ctx.user.id : null, id);
  }
  audit.log(actx, 'momo.matched', 'momo_transaction', id, { how, ...target });
  return db.get('SELECT * FROM momo_transactions WHERE id=?', id);
}

function ignore(ctx, id, note) {
  if (!note || note.length < 5) throw new HttpError(400, 'Give a reason');
  const t = db.get('SELECT * FROM momo_transactions WHERE id=?', id); if (!t || t.status !== 'unmatched') throw new HttpError(409, 'Only unmatched transactions can be set aside');
  db.run(`UPDATE momo_transactions SET status='ignored', note=?, matched_by=? WHERE id=?`, note, ctx.user.id, id);
  audit.log(ctx, 'momo.ignored', 'momo_transaction', id, { note });
}

/** Statement CSV from the merchant portal. Column names are matched flexibly. */
function importStatement(ctx, { provider, content, commit, currency }) {
  const rows = csv.parse(content);
  if (!rows.length) throw new HttpError(400, 'No rows in file');
  if (rows.length > 5000) throw new HttpError(400, 'Max 5,000 rows');
  const pickCol = (r, names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
  const parsed = rows.map(r => {
    const o = { row: r.__row, txn_ref: pickCol(r, ['txn_ref', 'transaction_id', 'transaction_ref', 'financial_transaction_id', 'id', 'reference_id']).trim(),
      msisdn: pickCol(r, ['msisdn', 'phone', 'sender', 'from', 'payer']), account_ref: pickCol(r, ['account_ref', 'reference', 'account', 'message', 'narration', 'external_id']),
      amount: Number(String(pickCol(r, ['amount', 'value', 'credit'])).replace(/,/g, '')), currency: (pickCol(r, ['currency']) || currency || '').toUpperCase(), date: pickCol(r, ['date', 'received_at', 'timestamp', 'transaction_date']), errors: [] };
    if (!o.txn_ref) o.errors.push('Missing transaction ID');
    if (!(o.amount > 0)) o.errors.push('Amount must be positive');
    if (!require('../lib/i18n').currencies().includes(o.currency)) o.errors.push('Currency must be one of ' + require('../lib/i18n').currencies().join(', '));
    const d = o.date ? new Date(o.date) : null; if (!d || isNaN(d)) o.errors.push('Invalid date'); else o.received_at = d.toISOString();
    if (!o.errors.length && db.get('SELECT 1 FROM momo_transactions WHERE provider=? AND txn_ref=?', provider, o.txn_ref)) o.duplicate = true;
    if (!o.errors.length && !o.duplicate) {
      const w = channels.walletByRef(o.account_ref), c = !w && channels.customerByRef(o.account_ref);
      const cs = !w && !c && o.msisdn ? channels.customersByPhone(o.msisdn) : [];
      o.will_match = w ? `Water card ${w.card_number}` : c ? `${c.customer_number} (reference)` : cs.length === 1 ? `${cs[0].customer_number} (phone)` : null;
    }
    return o;
  });
  const valid = parsed.filter(p => !p.errors.length && !p.duplicate);
  if (!commit) return { preview: true, total: parsed.length, valid: valid.length, duplicates: parsed.filter(p => p.duplicate).length, invalid: parsed.filter(p => p.errors.length).length, rows: parsed };
  let matched = 0;
  for (const p of valid) { const r = ingest(ctx, { provider, txn_ref: p.txn_ref, msisdn: p.msisdn, amount: p.amount, currency: p.currency, account_ref: p.account_ref, received_at: p.received_at, source: 'statement_csv', raw: p }); if (r.status === 'matched') matched++; }
  audit.log(ctx, 'momo.statement_import', 'momo_transaction', null, { provider, rows: parsed.length, imported: valid.length, matched });
  return { committed: true, imported: valid.length, matched, unmatched: valid.length - matched, duplicates: parsed.filter(p => p.duplicate).length };
}

module.exports = { ingest, post, autoMatch, ignore, importStatement };
