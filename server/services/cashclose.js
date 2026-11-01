'use strict';
/*
 * Cashier end-of-day close. Each cashier counts the cash in their drawer per currency; the system works out what they
 * should hold (their own cash receipts that day that were not reversed, plus cash water-card top-ups they took),
 * records the difference, and a manager — not the same person — approves or rejects it. After a close is submitted,
 * that cashier cannot record more cash for that day in that currency unless a manager rejects (reopens) the close.
 * Days use the utility's local time zone.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const tz = require('../lib/tz');
const { HttpError } = require('../lib/http');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const next = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const win = date => [tz.toUtc(date, '00:00'), tz.toUtc(next(date), '00:00')];

/** What the cashier should hold for a local date, per currency, with the receipts behind it. */
function expected(userId, date) {
  const [a, b] = win(date);
  const pays = db.all(`SELECT p.id, p.receipt_number, p.received_at, COALESCE(p.tendered_currency, p.currency) cur, COALESCE(p.tendered_amount, p.amount) amt, c.customer_number, c.name customer_name
    FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.received_by=? AND p.method='cash' AND p.amount > 0 AND p.status != 'reversed' AND p.received_at >= ? AND p.received_at < ? ORDER BY p.received_at`, userId, a, b);
  const tops = db.all(`SELECT t.id, t.captured_at received_at, t.currency cur, t.amount amt, w.card_number FROM wp_transactions t JOIN wp_wallets w ON w.id=t.wallet_id
    WHERE t.attendant_user_id=? AND t.type='topup' AND t.method='cash' AND t.captured_at >= ? AND t.captured_at < ? AND (SELECT role FROM users WHERE id=?) != 'attendant'`, userId, a, b, userId);
  const by = {};
  for (const p of pays) { (by[p.cur] = by[p.cur] || { currency: p.cur, expected: 0, receipts: 0, items: [] }); by[p.cur].expected = r2(by[p.cur].expected + p.amt); by[p.cur].receipts++; by[p.cur].items.push({ kind: 'payment', ref: p.receipt_number, at: p.received_at, amount: p.amt, who: `${p.customer_number} ${p.customer_name}` }); }
  for (const t of tops) { (by[t.cur] = by[t.cur] || { currency: t.cur, expected: 0, receipts: 0, items: [] }); by[t.cur].expected = r2(by[t.cur].expected + t.amt); by[t.cur].receipts++; by[t.cur].items.push({ kind: 'card_topup', ref: t.card_number, at: t.received_at, amount: t.amt, who: t.card_number }); }
  const reversed = db.get(`SELECT COUNT(*) n FROM payments WHERE received_by=? AND method='cash' AND amount > 0 AND status='reversed' AND received_at >= ? AND received_at < ?`, userId, a, b).n;
  return { date, currencies: Object.values(by), reversed_excluded: reversed };
}
const isClosed = (userId, date, currency) => !!db.get(`SELECT 1 FROM cash_closes WHERE user_id=? AND close_date=? AND currency=? AND status IN ('submitted','approved')`, userId, date, currency);

function submit(ctx, { date, counts, note }) {
  const today = tz.localDate(); const d = date || today;
  if (d > today) throw new HttpError(400, 'Cannot close a future day');
  const exp = expected(ctx.user.id, d);
  const all = new Set([...exp.currencies.map(c => c.currency), ...counts.map(c => String(c.currency).toUpperCase())]);
  if (!all.size) throw new HttpError(400, 'No cash recorded and nothing counted — nothing to close');
  const curs = [...all].filter(cur => !isClosed(ctx.user.id, d, cur)); // currencies already closed (and not reopened) stay as they are
  if (!curs.length) throw new HttpError(409, `Your cash for ${d} is already closed`);
  return db.tx(() => {
    const out = [];
    for (const cur of curs) {
      const e = exp.currencies.find(c => c.currency === cur) || { expected: 0, receipts: 0 };
      const cnt = counts.find(c => String(c.currency).toUpperCase() === cur);
      if (!cnt || !(Number(cnt.counted) >= 0)) throw new HttpError(400, `Enter the cash counted in ${cur} (0 if none)`);
      const variance = r2(Number(cnt.counted) - e.expected);
      if (Math.abs(variance) > 0.004 && !(note && note.trim().length >= 5)) throw new HttpError(400, `The count differs from the receipts by ${variance} ${cur}: explain the difference`);
      const ex = db.get('SELECT * FROM cash_closes WHERE user_id=? AND close_date=? AND currency=?', ctx.user.id, d, cur);
      if (ex) db.run(`UPDATE cash_closes SET expected=?, counted=?, variance=?, receipts=?, note=?, status='submitted', reviewed_by=NULL, reviewed_at=NULL, review_note=NULL, created_at=datetime('now') WHERE id=?`, e.expected, Number(cnt.counted), variance, e.receipts, note || null, ex.id);
      else db.run('INSERT INTO cash_closes(user_id, close_date, currency, expected, counted, variance, receipts, note) VALUES (?,?,?,?,?,?,?,?)', ctx.user.id, d, cur, e.expected, Number(cnt.counted), variance, e.receipts, note || null);
      out.push({ currency: cur, expected: e.expected, counted: Number(cnt.counted), variance });
    }
    audit.log(ctx, 'cash.close', 'cash_close', `${ctx.user.id}:${d}`, { date: d, closes: out, note });
    return { date: d, closes: out };
  });
}
function review(ctx, id, { decision, note }) {
  const c = db.get('SELECT * FROM cash_closes WHERE id=?', id); if (!c) throw new HttpError(404, 'Not found');
  if (c.user_id === ctx.user.id) throw new HttpError(403, 'A different person must review your own cash close');
  if (c.status !== 'submitted') throw new HttpError(409, `Already ${c.status}`);
  if (decision === 'rejected' && !(note && note.length >= 5)) throw new HttpError(400, 'Say why the close is rejected (the cashier will recount)');
  db.run(`UPDATE cash_closes SET status=?, reviewed_by=?, reviewed_at=datetime('now'), review_note=? WHERE id=?`, decision, ctx.user.id, note || null, id);
  audit.log(ctx, 'cash.review', 'cash_close', id, { decision, note, variance: c.variance });
  return { ok: true };
}
/** Cash book: closes plus days on which someone took cash but has not closed. */
function book({ from, to }) {
  const closes = db.all(`SELECT k.*, u.full_name cashier, r.full_name reviewer FROM cash_closes k JOIN users u ON u.id=k.user_id LEFT JOIN users r ON r.id=k.reviewed_by WHERE close_date BETWEEN ? AND ? ORDER BY close_date DESC, u.full_name, currency`, from, to);
  const missing = []; const today = tz.localDate();
  const users = db.all(`SELECT DISTINCT received_by id FROM payments WHERE method='cash' AND amount > 0 AND received_at >= ? AND received_by IS NOT NULL`, tz.toUtc(from, '00:00'));
  for (const u of users) for (let d = from; d <= to && d < today; d = next(d)) {
    const e = expected(u.id, d); for (const c of e.currencies) if (!db.get('SELECT 1 FROM cash_closes WHERE user_id=? AND close_date=? AND currency=?', u.id, d, c.currency))
      missing.push({ user_id: u.id, cashier: (db.get('SELECT full_name FROM users WHERE id=?', u.id) || {}).full_name, date: d, currency: c.currency, expected: c.expected, receipts: c.receipts });
  }
  return { from, to, closes, missing: missing.sort((a, b) => b.date.localeCompare(a.date)), pending: closes.filter(c => c.status === 'submitted').length };
}

module.exports = { expected, submit, review, book, isClosed, win };
