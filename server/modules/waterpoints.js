'use strict';
const { route, HttpError, csvResponse } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const db = require('../lib/db');
const csv = require('../lib/csv');
const wp = require('../services/waterpoints');

const today = () => new Date().toISOString().slice(0, 10);
const VIEW = ['wp.view', 'wp.sell', 'wp.manage'];
function ownOnly(ctx) { return !auth.can(ctx.user, 'wp.view') && !auth.can(ctx.user, 'wp.manage'); }

route('GET', '/api/wp/points', { anyPerm: VIEW }, ctx => {
  const own = ownOnly(ctx);
  const pts = db.all(`SELECT s.id asset_id, s.code, s.name, s.status asset_status, s.area_id, s.lat, s.lng, a.name area_name, w.mode, w.currency, w.container_liters, w.price_per_container, w.attendant_user_id,
    w.committee, w.meter_id, w.opening_hours, w.active, u.full_name attendant_name, m.serial_number meter_serial FROM assets s LEFT JOIN wp_config w ON w.asset_id=s.id LEFT JOIN service_areas a ON a.id=s.area_id
    LEFT JOIN users u ON u.id=w.attendant_user_id LEFT JOIN meters m ON m.id=w.meter_id WHERE s.asset_type='water_point' ${own ? 'AND w.attendant_user_id=?' : ''} ORDER BY a.name, s.name`, ...(own ? [ctx.user.id] : []));
  const t = today();
  return pts.map(p => ({ ...p, today: p.mode ? db.get(`SELECT COALESCE(SUM(CASE WHEN type IN ('sale','reversal') THEN containers END),0) containers, COALESCE(SUM(CASE WHEN type IN ('sale','reversal') AND method='cash' THEN amount END),0)
      + COALESCE(SUM(CASE WHEN type='topup' AND method='cash' THEN amount END),0) cash, COALESCE(SUM(CASE WHEN type IN ('sale','reversal') AND method='wallet' THEN amount END),0) card FROM wp_transactions WHERE asset_id=? AND captured_at >= ?`, p.asset_id, t) : null }));
});
route('PUT', '/api/wp/points/:id/config', { perm: 'wp.manage' }, ctx => {
  const aid = id(ctx.params.id);
  const s = db.get(`SELECT * FROM assets WHERE id=? AND asset_type='water_point'`, aid); if (!s) throw new HttpError(404, 'Water point asset not found');
  const b = validate(ctx.body, { mode: { type: 'enum', values: ['pay_per_container', 'free'], required: true }, currency: { type: 'currency', required: true },
    container_liters: { type: 'number', minVal: 1, maxVal: 1000, default: 20 }, price_per_container: { type: 'number', minVal: 0, maxVal: 1e5, default: 0 }, attendant_user_id: { type: 'integer' },
    committee: { type: 'string', max: 120 }, meter_id: { type: 'integer' }, opening_hours: { type: 'string', max: 80 }, active: { type: 'boolean', default: true } });
  if (b.attendant_user_id) { const u = db.get('SELECT role FROM users WHERE id=?', b.attendant_user_id); if (!u || !['attendant', 'manager', 'admin', 'technician'].includes(u.role)) throw new HttpError(400, 'Attendant must be a user with the Water Point Attendant role'); }
  const before = db.get('SELECT * FROM wp_config WHERE asset_id=?', aid);
  db.run(`INSERT INTO wp_config(asset_id, mode, currency, container_liters, price_per_container, attendant_user_id, committee, meter_id, opening_hours, active) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asset_id) DO UPDATE SET mode=excluded.mode, currency=excluded.currency, container_liters=excluded.container_liters, price_per_container=excluded.price_per_container,
    attendant_user_id=excluded.attendant_user_id, committee=excluded.committee, meter_id=excluded.meter_id, opening_hours=excluded.opening_hours, active=excluded.active`,
    aid, b.mode, b.currency, b.container_liters, b.price_per_container, b.attendant_user_id, b.committee, b.meter_id, b.opening_hours, b.active);
  audit.log(ctx, 'wp.config', 'asset', aid, { before, after: b });
  return { ok: true };
});

// ---- Attendant app ----
route('GET', '/api/wp/my', { perm: 'wp.sell' }, ctx => {
  const pts = db.all(`SELECT w.*, s.name, s.code, s.area_id FROM wp_config w JOIN assets s ON s.id=w.asset_id WHERE w.attendant_user_id=? AND w.active=1`, ctx.user.id);
  const areaIds = [...new Set(pts.map(p => p.area_id))];
  const wallets = areaIds.length ? db.all(`SELECT id, card_number, holder_name, balance, currency, status FROM wp_wallets WHERE status='active' AND area_id IN (${areaIds.map(() => '?').join(',')}) ORDER BY card_number`, ...areaIds) : [];
  return { points: pts, wallets, at: new Date().toISOString() };
});
const saleSchema = { asset_id: { type: 'integer', required: true }, containers: { type: 'integer', required: true, minVal: 1, maxVal: 200 }, method: { type: 'enum', values: ['cash', 'wallet', 'free'], required: true },
  card_number: { type: 'string', max: 40 }, client_uuid: { type: 'string', max: 64, pattern: /^[A-Za-z0-9-]+$/ }, captured_at: { type: 'datetime' }, offline: { type: 'boolean', default: false } };
const topupSchema = { card_number: { type: 'string', required: true, max: 40 }, amount: { type: 'number', required: true, minVal: 0.01 }, asset_id: { type: 'integer' },
  client_uuid: { type: 'string', max: 64, pattern: /^[A-Za-z0-9-]+$/ }, captured_at: { type: 'datetime' }, offline: { type: 'boolean', default: false } };
route('POST', '/api/wp/sell', { anyPerm: ['wp.sell', 'wp.manage'] }, ctx => wp.sell(ctx, validate(ctx.body, saleSchema)));
route('POST', '/api/wp/topup', { anyPerm: ['wp.sell', 'wp.wallets'] }, ctx => wp.topup(ctx, { ...validate(ctx.body, topupSchema), method: 'cash' }));
route('POST', '/api/wp/sync', { anyPerm: ['wp.sell', 'wp.manage'] }, ctx => {
  const items = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 300) : [];
  return { results: items.map(it => { try {
    const r = it.kind === 'topup' ? wp.topup(ctx, { ...validate(it, topupSchema), method: 'cash' }) : wp.sell(ctx, validate(it, saleSchema));
    return { client_uuid: it.client_uuid, ok: true, id: r.id, duplicate: !!r.duplicate, wallet_balance: r.wallet_balance, flags: JSON.parse(r.flags || '[]') };
  } catch (e) { return { client_uuid: it.client_uuid, ok: false, error: e.message }; } }) };
});

// ---- Water cards (wallets) ----
route('GET', '/api/wp/wallets', { anyPerm: ['wp.wallets', 'wp.view'] }, ctx => {
  const q = ctx.query.q ? `%${ctx.query.q}%` : null;
  return db.all(`SELECT w.*, a.name area_name, (SELECT MAX(captured_at) FROM wp_transactions t WHERE t.wallet_id=w.id) last_used FROM wp_wallets w LEFT JOIN service_areas a ON a.id=w.area_id
    ${q ? 'WHERE w.card_number LIKE ? OR w.holder_name LIKE ? OR w.phone LIKE ?' : ''} ORDER BY w.card_number LIMIT 1000`, ...(q ? [q, q, q] : []));
});
route('POST', '/api/wp/wallets', { perm: 'wp.wallets' }, ctx => {
  const b = validate(ctx.body, { holder_name: { type: 'string', required: true, max: 120 }, phone: { type: 'phone' }, area_id: { type: 'integer', required: true }, household_size: { type: 'integer', minVal: 1, maxVal: 100 } });
  const area = db.get('SELECT * FROM service_areas WHERE id=?', b.area_id); if (!area) throw new HttpError(400, 'Unknown area');
  return db.tx(() => {
    let seq = Number(db.setting('seq_card_' + area.code, '0')) + 1;
    const pre = (db.MODE === 'demo' ? 'DEMO-' : '') + 'WC-' + area.code + '-';
    while (db.get('SELECT 1 FROM wp_wallets WHERE card_number=?', pre + String(seq).padStart(4, '0'))) seq++;
    db.run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, 'seq_card_' + area.code, String(seq));
    const card = pre + String(seq).padStart(4, '0');
    const r = db.run('INSERT INTO wp_wallets(card_number, holder_name, phone, area_id, currency, household_size, created_by) VALUES (?,?,?,?,?,?,?)', card, b.holder_name, b.phone, b.area_id, area.currency, b.household_size, ctx.user.id);
    audit.log(ctx, 'wp.wallet_create', 'wp_wallet', r.id, { card, holder: b.holder_name });
    return { id: r.id, card_number: card };
  });
});
route('PUT', '/api/wp/wallets/:id', { perm: 'wp.wallets' }, ctx => {
  const wid = id(ctx.params.id);
  const b = validate(ctx.body, { status: { type: 'enum', values: ['active', 'blocked', 'closed'], required: true }, phone: { type: 'phone' }, holder_name: { type: 'string', max: 120 } });
  const before = db.get('SELECT * FROM wp_wallets WHERE id=?', wid); if (!before) throw new HttpError(404, 'Not found');
  db.run('UPDATE wp_wallets SET status=?, phone=COALESCE(?, phone), holder_name=COALESCE(?, holder_name) WHERE id=?', b.status, b.phone, b.holder_name, wid);
  audit.log(ctx, 'wp.wallet_update', 'wp_wallet', wid, { before: { status: before.status, phone: before.phone }, after: b });
  return { ok: true };
});
route('GET', '/api/wp/wallets/:id/transactions', { anyPerm: ['wp.wallets', 'wp.view'] }, ctx => db.all(`SELECT t.*, s.name point_name FROM wp_transactions t LEFT JOIN assets s ON s.id=t.asset_id WHERE wallet_id=? ORDER BY captured_at DESC LIMIT 200`, id(ctx.params.id)));

// ---- Reports, reconciliation, handovers ----
route('GET', '/api/wp/points/:id/transactions', { anyPerm: VIEW }, ctx => {
  const aid = id(ctx.params.id);
  if (ownOnly(ctx) && !db.get('SELECT 1 FROM wp_config WHERE asset_id=? AND attendant_user_id=?', aid, ctx.user.id)) throw new HttpError(403, 'Not your water point');
  const from = ctx.query.from || today(), to = ctx.query.to || today();
  return db.all(`SELECT t.*, w.card_number, u.full_name attendant_name FROM wp_transactions t LEFT JOIN wp_wallets w ON w.id=t.wallet_id LEFT JOIN users u ON u.id=t.attendant_user_id
    WHERE t.asset_id=? AND t.captured_at BETWEEN ? AND ? ORDER BY t.captured_at DESC LIMIT 2000`, aid, from, to + 'T23:59:59.999Z');
});
route('GET', '/api/wp/points/:id/reconcile', { anyPerm: ['wp.view', 'wp.manage'] }, ctx => wp.reconcile(id(ctx.params.id), ctx.query.from || today(), ctx.query.to || today()));
route('GET', '/api/wp/summary', { anyPerm: ['wp.view', 'wp.manage'] }, ctx => {
  const from = ctx.query.from || new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10), to = ctx.query.to || today();
  const rows = db.all('SELECT asset_id FROM wp_config').map(c => wp.reconcile(c.asset_id, from, to));
  if (ctx.query.format === 'csv') return csvResponse(`water-points_${from}_${to}${db.MODE === 'demo' ? '_DEMO' : ''}.csv`, csv.stringify(rows.map(r => ({ code: r.point.code, name: r.point.name, currency: r.point.currency, sales: r.sales, containers: r.containers,
    liters_sold: r.liters_sold, metered_liters: r.metered_liters, unaccounted_pct: r.unaccounted_pct, cash_sales: r.cash_sales, card_sales: r.card_sales, cash_topups: r.cash_topups, expected_cash: r.expected_cash,
    cash_handed_over: r.cash_handed_over, cash_variance: r.cash_variance, simulated_transactions: r.simulated_transactions })), null, [`# Water point reconciliation ${from} to ${to}`, db.MODE === 'demo' ? '# DEMO — fictional data' : '# LIVE DATA']));
  return { from, to, points: rows };
});
route('POST', '/api/wp/handovers', { anyPerm: ['wp.manage', 'wp.wallets'] }, ctx => wp.handover(ctx, validate(ctx.body, { asset_id: { type: 'integer', required: true }, period_from: { type: 'date', required: true },
  period_to: { type: 'date', required: true }, amount: { type: 'number', required: true, minVal: 0 }, note: { type: 'string', max: 300 } })));
route('GET', '/api/wp/handovers', { anyPerm: ['wp.view', 'wp.manage'] }, () => db.all(`SELECT h.*, s.name point_name, u.full_name received_by_name, a.full_name attendant_name FROM wp_handovers h JOIN assets s ON s.id=h.asset_id
  LEFT JOIN users u ON u.id=h.received_by LEFT JOIN users a ON a.id=h.attendant_user_id ORDER BY h.created_at DESC LIMIT 300`));
route('POST', '/api/wp/transactions/:id/reverse', { perm: 'wp.manage' }, ctx => ({ id: wp.reverse(ctx, id(ctx.params.id), String(ctx.body.reason || '').trim()) }));
