'use strict';
const crypto = require('crypto');
const { route, HttpError } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const audit = require('../lib/audit');
const db = require('../lib/db');
const channels = require('../services/channels');
const momo = require('../services/momo');

// ---- Gateway authentication for aggregator / provider callbacks (machine-to-machine) ----
function gatewayAuth(ctx) {
  const h = db.setting('gateway_key_hash', '');
  const k = ctx.req.headers['x-api-key'] || ctx.query.key || '';
  if (!h) throw new HttpError(503, 'Gateway not configured. An administrator must issue a gateway key first.');
  const kh = crypto.createHash('sha256').update(String(k)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(kh), Buffer.from(h))) throw new HttpError(401, 'Invalid gateway key');
}
route('POST', '/api/channels/gateway-key', { perm: 'settings.manage' }, ctx => {
  const key = 'gw_' + crypto.randomBytes(24).toString('base64url');
  db.run(`INSERT INTO settings(key,value) VALUES('gateway_key_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, crypto.createHash('sha256').update(key).digest('hex'));
  db.run(`INSERT INTO settings(key,value) VALUES('gateway_key_hint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key.slice(-4));
  audit.log(ctx, 'channels.gateway_key', 'settings', null, { hint: key.slice(-4) });
  return { key, note: 'Shown once. Configure it in your USSD/SMS aggregator and mobile-money callback as header X-Api-Key (or ?key=).' };
});
route('GET', '/api/channels/status', { anyPerm: ['channels.view', 'settings.manage'] }, () => ({
  provider: db.setting('sms_provider', 'simulator'), gateway_key: !!db.setting('gateway_key_hash', ''), gateway_key_hint: db.setting('gateway_key_hint', ''), ussd_code: db.setting('ussd_code'),
  notifications: db.setting('sms_notifications') === '1', momo_mtn_merchant: db.setting('momo_mtn_merchant'), momo_orange_merchant: db.setting('momo_orange_merchant'), mode: db.MODE,
  endpoints: { ussd: '/api/gateway/ussd', sms: '/api/gateway/sms', momo: '/api/gateway/momo/{mtn|orange}' },
  counts: db.get(`SELECT SUM(direction='in') inbound, SUM(direction='out') outbound, SUM(status='simulated') simulated FROM sms_messages`)
}));

// ---- Live aggregator endpoints ----
route('POST', '/api/gateway/ussd', { machine: true }, ctx => {
  gatewayAuth(ctx);
  const b = ctx.body;
  const reply = channels.ussd({ ...ctx, actor: 'ussd' }, { sessionId: String(b.sessionId || b.session_id || '').slice(0, 80), phone: String(b.phoneNumber || b.msisdn || b.phone || '').slice(0, 20), text: String(b.text || '').slice(0, 200) });
  return { __raw: true, body: reply, headers: { 'Content-Type': 'text/plain; charset=utf-8' } };
});
route('POST', '/api/gateway/sms', { machine: true }, ctx => {
  gatewayAuth(ctx);
  const b = ctx.body;
  return { reply: channels.smsInbound({ ...ctx, actor: 'sms' }, { phone: String(b.from || b.msisdn || b.phone || '').slice(0, 20), body: String(b.text || b.body || b.message || '').slice(0, 480) }) };
});
route('POST', '/api/gateway/momo/:provider', { machine: true }, ctx => {
  gatewayAuth(ctx);
  const provider = ctx.params.provider; if (!require('../lib/i18n').momoProviders().some(p => p.code === provider)) throw new HttpError(404, 'Unknown provider');
  const b = ctx.body;
  const t = validate({ txn_ref: b.txn_ref || b.financialTransactionId || b.transactionId || b.txnid, msisdn: b.msisdn || b.payer || b.from, amount: b.amount, currency: b.currency,
    account_ref: b.reference || b.account_ref || b.externalId || b.payerMessage, received_at: b.timestamp || b.received_at }, {
    txn_ref: { type: 'string', required: true, max: 80 }, msisdn: { type: 'string', max: 30 }, amount: { type: 'number', required: true, minVal: 0.01 }, currency: { type: 'currency', required: true },
    account_ref: { type: 'string', max: 120 }, received_at: { type: 'datetime' } });
  const r = momo.ingest({ ...ctx, actor: 'momo:' + provider }, { ...t, provider, source: 'webhook', raw: b });
  return { ok: true, status: r.status, duplicate: !!r.duplicate };
});

// ---- Staff: simulator & message log ----
route('POST', '/api/channels/simulate/ussd', { perm: 'channels.simulate' }, ctx => {
  const b = validate(ctx.body, { phone: { type: 'string', required: true, max: 20 }, text: { type: 'string', max: 200 }, sessionId: { type: 'string', max: 80 } });
  return { reply: channels.ussd({ ...ctx, simulated: true }, { sessionId: b.sessionId || 'sim-' + Date.now(), phone: b.phone, text: b.text || '' }) };
});
route('POST', '/api/channels/simulate/sms', { perm: 'channels.simulate' }, ctx => {
  const b = validate(ctx.body, { phone: { type: 'string', required: true, max: 20 }, body: { type: 'string', required: true, max: 480 } });
  return { reply: channels.smsInbound({ ...ctx, simulated: true }, b) };
});
route('GET', '/api/channels/messages', { perm: 'channels.view' }, ctx => {
  const q = ctx.query; const w = []; const p = [];
  if (q.phone) { w.push("replace(replace(replace(replace(replace(m.phone,' ',''),'+',''),'-',''),'(',''),')','') LIKE ?"); p.push('%' + channels.normPhone(q.phone) + '%'); }
  if (q.direction) { w.push('m.direction=?'); p.push(q.direction); }
  if (q.channel) { w.push('m.channel=?'); p.push(q.channel); }
  if (q.purpose) { w.push('m.purpose=?'); p.push(q.purpose); }
  return db.all(`SELECT m.*, c.customer_number, c.name customer_name FROM sms_messages m LEFT JOIN customers c ON c.id=m.customer_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY m.id DESC LIMIT 300`, ...p);
});

// ---- Mobile money reconciliation ----
route('GET', '/api/momo', { perm: 'momo.view' }, ctx => {
  const st = ctx.query.status;
  return db.all(`SELECT t.*, c.customer_number, c.name customer_name, w.card_number, p.receipt_number FROM momo_transactions t LEFT JOIN customers c ON c.id=t.customer_id
    LEFT JOIN wp_wallets w ON w.id=t.wallet_id LEFT JOIN payments p ON p.id=t.payment_id ${st ? 'WHERE t.status=?' : ''} ORDER BY t.received_at DESC LIMIT 500`, ...(st ? [st] : []));
});
route('POST', '/api/momo/:id/match', { perm: 'momo.match' }, ctx => {
  const b = validate(ctx.body, { customer_id: { type: 'integer' }, wallet_id: { type: 'integer' } });
  if (!b.customer_id === !b.wallet_id) throw new HttpError(400, 'Choose either a customer account or a water card');
  return momo.post(ctx, id(ctx.params.id), b, 'manual');
});
route('POST', '/api/momo/:id/ignore', { perm: 'momo.match' }, ctx => { momo.ignore(ctx, id(ctx.params.id), String(ctx.body.note || '').trim()); return { ok: true }; });
route('POST', '/api/momo/import', { perm: 'momo.import' }, ctx => {
  const b = validate(ctx.body, { provider: { type: 'momoprovider', required: true }, content: { type: 'text', required: true, max: 5 * 1024 * 1024 }, commit: { type: 'boolean', default: false }, currency: { type: 'currency' } });
  return momo.importStatement(ctx, b);
});
route('POST', '/api/momo/simulate', { perm: 'channels.simulate' }, ctx => {
  if (db.MODE === 'live') throw new HttpError(409, 'The mobile-money simulator is disabled in the live system');
  const b = validate(ctx.body, { provider: { type: 'momoprovider', required: true }, msisdn: { type: 'string', max: 30 }, amount: { type: 'number', required: true, minVal: 0.01 },
    currency: { type: 'currency', required: true }, account_ref: { type: 'string', max: 120 } });
  return momo.ingest(ctx, { ...b, txn_ref: 'SIM' + Date.now() + Math.floor(Math.random() * 1000), source: 'simulator' });
});
