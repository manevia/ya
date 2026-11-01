'use strict';
// Pay-as-you-fetch water points: attendant sales (cash / water card / free), water-card wallets, cash handovers and reconciliation.
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const channels = require('./channels');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

function config(assetId) {
  return db.get(`SELECT w.*, s.name, s.code, s.area_id, s.status asset_status, s.lat, s.lng, u.full_name attendant_name FROM wp_config w JOIN assets s ON s.id=w.asset_id
    LEFT JOIN users u ON u.id=w.attendant_user_id WHERE w.asset_id=?`, assetId);
}
function canOperate(ctx, cfg) {
  const auth = require('../lib/auth');
  if (auth.can(ctx.user, 'wp.manage')) return;
  if (ctx.user.role === 'attendant' && cfg.attendant_user_id === ctx.user.id) return;
  throw new HttpError(403, 'You are not the attendant for this water point');
}
function wallet(card) { const w = channels.walletByRef(card); if (!w) throw new HttpError(404, 'Water card not found'); return w; }

function sell(ctx, b) {
  return db.tx(() => {
    if (b.client_uuid) { const ex = db.get('SELECT * FROM wp_transactions WHERE client_uuid=?', b.client_uuid); if (ex) return { ...ex, duplicate: true }; }
    const cfg = config(b.asset_id); if (!cfg || !cfg.active) throw new HttpError(400, 'Water point is not set up for sales');
    canOperate(ctx, cfg);
    if (!(Number.isInteger(b.containers) && b.containers > 0 && b.containers <= 200)) throw new HttpError(400, 'Containers must be 1–200');
    const flags = [];
    let method = b.method, amount = r2(b.containers * cfg.price_per_container), w = null;
    if (cfg.mode === 'free' || amount === 0) { method = 'free'; amount = 0; }
    if (method === 'wallet') {
      w = wallet(b.card_number);
      if (w.status !== 'active') throw new HttpError(409, 'Water card is ' + w.status);
      if (w.currency !== cfg.currency) throw new HttpError(409, 'Card currency differs from water point currency');
      if (w.balance < amount) { if (!b.offline) throw new HttpError(409, `Insufficient card balance (${channels.money(w.balance, w.currency)})`); flags.push('overdraft_offline'); }
      db.run('UPDATE wp_wallets SET balance = round(balance - ?, 2) WHERE id=?', amount, w.id);
    } else if (!['cash', 'free'].includes(method)) throw new HttpError(400, 'Method must be cash, wallet or free');
    if (b.offline) flags.push('offline_capture');
    const at = b.captured_at && Date.parse(b.captured_at) <= Date.now() + 10 * 60e3 ? new Date(b.captured_at).toISOString() : new Date().toISOString();
    const ins = db.run(`INSERT INTO wp_transactions(asset_id, wallet_id, type, containers, liters, amount, currency, method, attendant_user_id, client_uuid, captured_at, offline, flags, is_simulated)
      VALUES (?,?,'sale',?,?,?,?,?,?,?,?,?,?,?)`, cfg.asset_id, w && w.id, b.containers, b.containers * cfg.container_liters, amount, cfg.currency, method, ctx.user.id, b.client_uuid || null, at, b.offline ? 1 : 0, JSON.stringify(flags), b.is_simulated ? 1 : 0);
    audit.log(ctx, 'wp.sale', 'wp_transaction', ins.id, { point: cfg.code, containers: b.containers, amount, method, card: w && w.card_number, flags });
    return { ...db.get('SELECT * FROM wp_transactions WHERE id=?', ins.id), wallet_balance: w ? db.get('SELECT balance FROM wp_wallets WHERE id=?', w.id).balance : null };
  });
}

function topup(ctx, b) {
  return db.tx(() => {
    if (b.client_uuid) { const ex = db.get('SELECT * FROM wp_transactions WHERE client_uuid=?', b.client_uuid); if (ex) return { ...ex, duplicate: true }; }
    const w = b.wallet_id ? db.get('SELECT * FROM wp_wallets WHERE id=?', b.wallet_id) : wallet(b.card_number);
    if (!w || w.status !== 'active') throw new HttpError(409, 'Water card not active');
    if (!(b.amount > 0 && b.amount < 1e7)) throw new HttpError(400, 'Amount must be positive');
    if (b.asset_id) { const cfg = config(b.asset_id); if (!cfg) throw new HttpError(400, 'Unknown water point'); if (ctx.user) canOperate(ctx, cfg); }
    let amount = b.amount;
    if (b.currency && b.currency !== w.currency) {
      const rate = require('./billing').findRate(b.currency, w.currency, new Date().toISOString().slice(0, 10));
      if (!rate) throw new HttpError(400, `No ${b.currency}→${w.currency} exchange rate configured`);
      amount = r2(b.amount * rate.rate);
    }
    db.run('UPDATE wp_wallets SET balance = round(balance + ?, 2) WHERE id=?', amount, w.id);
    const ins = db.run(`INSERT INTO wp_transactions(asset_id, wallet_id, type, amount, currency, method, momo_id, attendant_user_id, client_uuid, captured_at, offline, flags, is_simulated, note)
      VALUES (?,?,'topup',?,?,?,?,?,?,?,?,?,?,?)`, b.asset_id || null, w.id, amount, w.currency, b.method || 'cash', b.momo_id || null, ctx.user ? ctx.user.id : null, b.client_uuid || null,
      b.captured_at || new Date().toISOString(), b.offline ? 1 : 0, JSON.stringify(b.offline ? ['offline_capture'] : []), b.is_simulated ? 1 : 0, b.note || null);
    const bal = db.get('SELECT balance FROM wp_wallets WHERE id=?', w.id).balance;
    if (w.phone && db.setting('sms_notifications', '1') === '1') (L => channels.sendT(w.phone, 'card.topup', { card: w.card_number, amount: channels.money(amount, w.currency, L), sim: b.is_simulated ? channels.T(L, 'simulated') : '', balance: channels.money(bal, w.currency, L) }, { wallet_id: w.id, purpose: 'topup' }))(require('../lib/i18n').langForPhone(w.phone));
    audit.log(ctx, 'wp.topup', 'wp_wallet', w.id, { card: w.card_number, amount, method: b.method || 'cash', momo_id: b.momo_id, simulated: !!b.is_simulated });
    return { ...db.get('SELECT * FROM wp_transactions WHERE id=?', ins.id), wallet_balance: bal };
  });
}

function reverse(ctx, id, reason) {
  if (!reason || reason.length < 5) throw new HttpError(400, 'A reason is required');
  return db.tx(() => {
    const t = db.get('SELECT * FROM wp_transactions WHERE id=?', id); if (!t) throw new HttpError(404, 'Not found');
    if (t.type === 'reversal' || db.get('SELECT 1 FROM wp_transactions WHERE reversal_of=?', id)) throw new HttpError(409, 'Already reversed');
    if (t.wallet_id) db.run('UPDATE wp_wallets SET balance = round(balance + ?, 2) WHERE id=?', t.type === 'sale' ? t.amount : -t.amount, t.wallet_id);
    const ins = db.run(`INSERT INTO wp_transactions(asset_id, wallet_id, type, containers, liters, amount, currency, method, attendant_user_id, captured_at, reversal_of, note)
      VALUES (?,?,'reversal',?,?,?,?,?,?,?,?,?)`, t.asset_id, t.wallet_id, -t.containers, -t.liters, -t.amount, t.currency, t.method, ctx.user.id, new Date().toISOString(), t.id, reason);
    audit.log(ctx, 'wp.reverse', 'wp_transaction', id, { reason, amount: t.amount, type: t.type });
    return ins.id;
  });
}

/** Sold vs metered volume and expected vs handed-over cash for one water point over a period. */
function reconcile(assetId, from, to) {
  const cfg = config(assetId); if (!cfg) throw new HttpError(404, 'Water point not configured');
  const end = to + 'T23:59:59.999Z';
  const s = db.get(`SELECT COALESCE(SUM(CASE WHEN type IN ('sale','reversal') THEN containers END),0) containers, COALESCE(SUM(CASE WHEN type IN ('sale','reversal') THEN liters END),0) liters,
    COALESCE(SUM(CASE WHEN type IN ('sale','reversal') AND method='cash' THEN amount END),0) cash_sales, COALESCE(SUM(CASE WHEN type IN ('sale','reversal') AND method='wallet' THEN amount END),0) card_sales,
    COALESCE(SUM(CASE WHEN type='topup' AND method='cash' THEN amount END),0) cash_topups, COALESCE(SUM(CASE WHEN type IN ('sale','reversal') AND method='free' THEN containers END),0) free_containers,
    COUNT(CASE WHEN type='sale' THEN 1 END) sales, SUM(is_simulated) simulated
    FROM wp_transactions WHERE asset_id=? AND captured_at BETWEEN ? AND ?`, assetId, from, end);
  let metered = null, soldInMeterWindow = null, meterNote = cfg.meter_id ? null : 'No tap meter linked — volume cannot be checked';
  if (cfg.meter_id) {
    const val = r => (r ? (r.corrected_value ?? r.value) : null);
    const a = db.get(`SELECT * FROM readings WHERE meter_id=? AND status!='rejected' AND reading_at <= ? ORDER BY reading_at DESC LIMIT 1`, cfg.meter_id, from + 'T00:00:00.000Z');
    const b = db.get(`SELECT * FROM readings WHERE meter_id=? AND status!='rejected' AND reading_at <= ? ORDER BY reading_at DESC LIMIT 1`, cfg.meter_id, end);
    if (a && b && b.id !== a.id) {
      metered = r2((val(b) - val(a)) * 1000);
      // compare like with like: sales recorded between the two meter readings
      soldInMeterWindow = db.get(`SELECT COALESCE(SUM(liters),0) l FROM wp_transactions WHERE asset_id=? AND type IN ('sale','reversal') AND captured_at > ? AND captured_at <= ?`, assetId, a.reading_at, b.reading_at).l;
      meterNote = `Tap meter ${val(a)} → ${val(b)} m³ between readings on ${a.reading_at.slice(0, 10)} and ${b.reading_at.slice(0, 10)}; sales in that window ${r2(soldInMeterWindow / 1000)} m³`;
    }
    else meterNote = 'Need tap-meter readings at both the start and the end of the period';
  }
  const handed = db.get(`SELECT COALESCE(SUM(amount),0) s FROM wp_handovers WHERE asset_id=? AND period_from >= ? AND period_to <= ?`, assetId, from, to).s;
  const expectedCash = r2(s.cash_sales + s.cash_topups);
  return {
    point: { id: assetId, name: cfg.name, code: cfg.code, currency: cfg.currency, price: cfg.price_per_container, container_liters: cfg.container_liters, mode: cfg.mode, attendant: cfg.attendant_name },
    from, to, sales: s.sales, containers: s.containers, free_containers: s.free_containers, liters_sold: r2(s.liters), cash_sales: r2(s.cash_sales), card_sales: r2(s.card_sales), cash_topups: r2(s.cash_topups),
    revenue: r2(s.cash_sales + s.card_sales), metered_liters: metered, sold_liters_meter_window: soldInMeterWindow == null ? null : r2(soldInMeterWindow),
    unaccounted_liters: metered == null ? null : r2(metered - soldInMeterWindow), unaccounted_pct: metered ? r2((metered - soldInMeterWindow) / metered * 100) : null, meter_note: meterNote,
    expected_cash: expectedCash, cash_handed_over: r2(handed), cash_variance: r2(handed - expectedCash), simulated_transactions: s.simulated || 0
  };
}

function handover(ctx, b) {
  const cfg = config(b.asset_id); if (!cfg) throw new HttpError(404, 'Water point not configured');
  const rec = reconcile(b.asset_id, b.period_from, b.period_to);
  const ins = db.run('INSERT INTO wp_handovers(asset_id, period_from, period_to, expected_cash, amount, currency, attendant_user_id, received_by, note) VALUES (?,?,?,?,?,?,?,?,?)',
    b.asset_id, b.period_from, b.period_to, rec.expected_cash, b.amount, cfg.currency, cfg.attendant_user_id, ctx.user.id, b.note || null);
  audit.log(ctx, 'wp.handover', 'wp_handover', ins.id, { point: cfg.code, expected: rec.expected_cash, amount: b.amount, variance: r2(b.amount - rec.expected_cash) });
  return { id: ins.id, expected_cash: rec.expected_cash, variance: r2(b.amount - rec.expected_cash) };
}

module.exports = { config, sell, topup, reverse, reconcile, handover };
