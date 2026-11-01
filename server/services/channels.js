'use strict';
/*
 * Feature-phone channels: USSD menu, SMS keywords and outbound SMS notifications.
 * Works for any customer with a basic phone (no smartphone, no data bundle).
 * Every customer-facing text comes from server/i18n/<lang>.json in the person's language (customer setting,
 * or the language chosen by USSD/SMS for that phone, or the utility's default). SMS keywords are accepted in
 * every enabled language (e.g. BAL, SOLDE, SALDO).
 * Outbound messages go to a provider; until a real SMS/USSD aggregator is configured the provider is the
 * built-in SIMULATOR, which stores every message with status "simulated" (nothing is actually sent).
 */
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const i18n = require('../lib/i18n');
const { HttpError } = require('../lib/http');

const normPhone = p => i18n.phoneKey(p); // last N digits are significant (Settings › Country › phone digits)
const normRef = r => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const money = (n, c, lang) => i18n.money(n, c, lang);
const T = (lang, key, vars) => i18n.t(lang, key, { org: short(), ussd: db.setting('ussd_code'), ...vars });

function customersByPhone(phone) {
  const key = normPhone(phone); if (key.length < 7) return [];
  return db.all(`SELECT c.*, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE c.phone IS NOT NULL AND c.status != 'closed'`).filter(c => normPhone(c.phone) === key);
}
function walletsByPhone(phone) { const key = normPhone(phone); return key.length < 7 ? [] : db.all(`SELECT * FROM wp_wallets WHERE phone IS NOT NULL AND status='active'`).filter(w => normPhone(w.phone) === key); }
function customerByRef(ref) {
  const r = normRef(ref); if (r.length < 4) return null;
  return db.all(`SELECT c.*, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id`).find(c => normRef(c.customer_number) === r || normRef(c.customer_number).replace(/^DEMO/, '') === r) || null;
}
function walletByRef(ref) { const r = normRef(ref); if (r.length < 4) return null; return db.all('SELECT * FROM wp_wallets').find(w => normRef(w.card_number) === r || normRef(w.card_number).replace(/^DEMO/, '') === r) || null; }

// ---- SMS character set: by default keep messages in the GSM 7-bit alphabet (160 chars/part). Characters outside it
// (ê, ã, ç, —, ×, …) force the expensive UCS-2 encoding (70 chars/part), so they are folded to their nearest GSM form.
const GSM = new Set('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€');
const FOLD = { '—': '-', '–': '-', '×': 'x', '…': '...', '’': "'", '‘': "'", '“': '"', '”': '"', '·': '-', '≥': '>=', '≤': '<=', 'ç': 'c', 'ã': 'a', 'õ': 'o', 'â': 'a', 'ê': 'e', 'î': 'i', 'ô': 'o', 'û': 'u', 'á': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ë': 'e', 'ï': 'i', 'œ': 'oe', 'À': 'A', 'Â': 'A', 'Ê': 'E', 'È': 'E', 'Î': 'I', 'Ô': 'O', 'Û': 'U', 'Ú': 'U', 'Ó': 'O', 'Á': 'A', 'Í': 'I', 'Ã': 'A', 'Õ': 'O', 'Œ': 'OE', ' ': ' ', ' ': ' ' };
function gsmFold(s) { if (db.setting('sms_gsm7_only', '1') !== '1') return s; let o = ''; for (const ch of s) o += GSM.has(ch) ? ch : FOLD[ch] ?? (ch.normalize('NFD').replace(/[̀-ͯ]/g, '').split('').every(x => GSM.has(x)) ? ch.normalize('NFD').replace(/[̀-ͯ]/g, '') : '?'); return o; }

function provider() { return db.setting('sms_provider', 'simulator'); }
/** Queue/send an SMS. With the simulator provider the message is stored and marked "simulated" (not delivered to any phone). */
function send(phone, body, meta = {}) {
  if (!phone) return null;
  const p = provider();
  const r = db.run(`INSERT INTO sms_messages(direction, channel, phone, body, customer_id, wallet_id, purpose, status, provider) VALUES ('out','sms',?,?,?,?,?,?,?)`,
    phone, gsmFold(String(body)).slice(0, 480), meta.customer_id || null, meta.wallet_id || null, meta.purpose || null, p === 'simulator' ? 'simulated' : 'queued', p);
  return r.id;
}
/** Send a catalogue message in the recipient's language, prefixed with the utility's short name. */
function sendT(phone, key, vars = {}, meta = {}, lang) {
  if (!phone) return null;
  const L = lang || (meta.customer ? i18n.langForCustomer(meta.customer) : i18n.langForPhone(phone));
  return send(phone, `${short()}: ${T(L, key, vars)}`, { customer_id: meta.customer_id ?? (meta.customer && meta.customer.id), wallet_id: meta.wallet_id, purpose: meta.purpose });
}
function notifyEnabled() { return db.setting('sms_notifications', '1') === '1'; }
function notifyBill(bill, customer) {
  if (!notifyEnabled() || !customer.phone) return;
  const L = i18n.langForCustomer(customer);
  sendT(customer.phone, 'notify.bill', { bill: bill.bill_number, period: bill.period_end.slice(0, 7), m3: bill.consumption, est: bill.is_estimated ? T(L, 'notify.bill_est') : '', amount: money(bill.total, bill.currency, L), due: bill.due_date, hint: payHint(customer, L) },
    { customer, purpose: 'bill' }, L);
}
function notifyPayment(payment, customer, balance) {
  if (!notifyEnabled() || !customer.phone || payment.amount <= 0) return;
  const L = i18n.langForCustomer(customer);
  sendT(customer.phone, 'notify.payment', { amount: money(payment.amount, payment.currency, L), receipt: payment.receipt_number, balance: money(balance, payment.currency, L), credit: balance < 0 ? T(L, 'notify.credit') : '' }, { customer, purpose: 'receipt' }, L);
}
function short() { return (db.setting('org_name') || 'Water').split(/[ (]/)[0].slice(0, 12); }
function payHint(c, lang = i18n.langForCustomer(c)) {
  const ways = i18n.momoProviders().filter(p => p.merchant).map(p => `${p.name} ${p.merchant}`).join(T(lang, 'pay.or'));
  return ways ? T(lang, 'pay.hint', { ways, ref: c.customer_number }) : T(lang, 'pay.hint_none', { ref: c.customer_number });
}
const statusText = (L, s) => T(L, 'status.' + s) || s.replace('_', ' ');
function balanceText(L, bal, cur, cap) {
  const k = cap ? ['bal.Owe', 'bal.Credit', 'bal.Settled'] : ['bal.owe', 'bal.credit', 'bal.settled'];
  return bal > 0 ? T(L, k[0], { amount: money(bal, cur, L) }) : bal < 0 ? T(L, k[1], { amount: money(-bal, cur, L) }) : T(L, k[2]);
}

function balanceOf(cid) { return require('./billing').balance(cid); }
function lastBill(cid) { return db.get(`SELECT * FROM bills WHERE customer_id=? AND status!='cancelled' ORDER BY period_end DESC LIMIT 1`, cid); }
function activeMeter(cid) { return db.get(`SELECT * FROM meters WHERE customer_id=? AND status IN ('active','faulty') ORDER BY id DESC LIMIT 1`, cid); }

function submitSelfReading(ctx, c, value, channel) {
  const m = activeMeter(c.id); if (!m) throw new HttpError(400, T(i18n.langForCustomer(c), 'ussd.no_meter'));
  const r = require('./readings').create({ ...ctx, actor: channel + ':' + normPhone(c.phone) }, { meter_id: m.id, value, reading_at: new Date().toISOString(), source: 'customer_self',
    notes: `Submitted by customer via ${channel.toUpperCase()}`, sync_status: 'online', extra_flags: ['customer_submitted'] });
  return r;
}
function reportProblem(ctx, c, kind, text, channel) {
  const titles = { leak: 'Customer reports leak at meter / pipe', nowater: 'Customer reports no water', burst: 'Customer reports burst pipe on street' };
  return require('./alerts').raise({ ...ctx, actor: channel }, { rule_type: 'customer_report', severity: kind === 'burst' ? 'high' : 'medium', title: `${titles[kind] || 'Customer report'} — ${c.name}`,
    description: `${text ? text + ' — ' : ''}Reported via ${channel.toUpperCase()} from ${c.phone}`, customer_id: c.id, area_id: c.area_id, lat: c.lat, lng: c.lng, source: 'customer', data_basis: 'manual' });
}

// ---- language menu shared by both USSD menus (option 9) ----
function langMenu(L, phone, choice) {
  const langs = i18n.languages();
  if (choice === undefined) return 'CON ' + T(L, 'lang.choose') + '\n' + langs.slice(0, 8).map((l, i) => `${i + 1} ${l.native_name}`).join('\n');
  const l = langs[Number(choice) - 1]; if (!l) return 'END ' + T(L, 'ussd.invalid_choice');
  i18n.setPhoneLang(phone, l.code);
  return 'END ' + T(l.code, 'lang.set', { name: l.native_name });
}

// ---------------- USSD ----------------
// Follows the common aggregator convention: `text` holds all answers so far separated by "*". Reply starts with CON (continue) or END.
function ussd(ctx, { sessionId, phone, text }) {
  const parts = String(text || '').split('*').filter((x, i, a) => !(x === '' && a.length === 1));
  db.run(`INSERT INTO ussd_sessions(session_id, phone, last_text, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(session_id) DO UPDATE SET last_text=excluded.last_text, updated_at=excluded.updated_at`, sessionId, phone, text || '');
  const reply = ussdReply(ctx, phone, parts);
  db.run(`INSERT INTO sms_messages(direction, channel, phone, body, status, provider, purpose) VALUES ('in','ussd',?,?, 'received', ?, 'ussd')`, phone, `[${text || ''}] → ${reply}`.slice(0, 480), ctx.simulated ? 'simulator' : 'aggregator');
  return reply;
}
function ussdReply(ctx, phone, parts) {
  const custs = customersByPhone(phone); const wallets = walletsByPhone(phone);
  if (!custs.length && !wallets.length) return publicUssd(ctx, phone, parts);
  const L = i18n.langForPhone(phone);
  let c = custs[0];
  if (custs.length > 1) {
    if (!parts.length) return 'CON ' + T(L, 'ussd.choose_account') + '\n' + custs.slice(0, 6).map((x, i) => `${i + 1} ${x.customer_number}`).join('\n');
    c = custs[Number(parts[0]) - 1]; if (!c) return 'END ' + T(L, 'ussd.invalid_choice'); parts = parts.slice(1);
  }
  const menu = `CON ${short()}${c ? ' ' + c.customer_number : ''}\n` + [c && '1 ' + T(L, 'ussd.menu.balance'), c && '2 ' + T(L, 'ussd.menu.bill'), c && '3 ' + T(L, 'ussd.menu.reading'), c && '4 ' + T(L, 'ussd.menu.report'),
    c && '5 ' + T(L, 'ussd.menu.pay'), wallets.length && '6 ' + T(L, 'ussd.menu.card'), '9 ' + T(L, 'ussd.menu.language')].filter(Boolean).join('\n');
  if (!parts.length) return menu;
  const [choice, a, b] = parts;
  if (choice === '9') return langMenu(L, phone, a);
  if (!c && choice !== '6') return 'END ' + T(L, 'ussd.not_available');
  switch (choice) {
    case '1': { const bal = balanceOf(c.id); const p = db.get(`SELECT amount, received_at FROM payments WHERE customer_id=? AND amount>0 ORDER BY received_at DESC LIMIT 1`, c.id);
      return 'END ' + T(L, 'ussd.balance', { account: c.customer_number, status: balanceText(L, bal, c.currency, true), last: p ? T(L, 'ussd.last_payment', { amount: money(p.amount, c.currency, L), date: p.received_at.slice(0, 10) }) : '' }); }
    case '2': { const bl = lastBill(c.id); if (!bl) return 'END ' + T(L, 'ussd.no_bill');
      return 'END ' + T(L, 'ussd.bill', { bill: bl.bill_number, period: bl.period_end.slice(0, 7), m3: bl.consumption, est: bl.is_estimated ? T(L, 'ussd.est') : '', amount: money(bl.total, bl.currency, L), due: bl.due_date, status: statusText(L, bl.status) }); }
    case '3': {
      const m = activeMeter(c.id); if (!m) return 'END ' + T(L, 'ussd.no_meter');
      if (a === undefined) return 'CON ' + T(L, 'ussd.enter_reading', { serial: m.serial_number.slice(-4) });
      const v = Number(String(a).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 1e8) return 'END ' + T(L, 'ussd.invalid_number');
      const prev = m.last_reading_value ?? m.initial_reading;
      if (b === undefined) return 'CON ' + T(L, 'ussd.confirm_reading', { value: v, lower: v < prev ? T(L, 'ussd.lower', { prev }) : '' }) + `\n1 ${T(L, 'yes')}\n2 ${T(L, 'no')}`;
      if (b !== '1') return 'END ' + T(L, 'ussd.cancelled');
      const r = submitSelfReading(ctx, c, v, 'ussd');
      return 'END ' + T(L, 'reading.received', { value: v, ref: r.id });
    }
    case '4': {
      if (a === undefined) return 'CON ' + T(L, 'ussd.problem_menu');
      const kind = { 1: 'leak', 2: 'nowater', 3: 'burst' }[a]; if (!kind) return 'END ' + T(L, 'ussd.invalid_choice');
      const id = reportProblem(ctx, c, kind, null, 'ussd');
      return 'END ' + T(L, 'ussd.report_received', { ref: id ? T(L, 'ussd.report_ref', { id }) : T(L, 'ussd.report_dup') });
    }
    case '5': return 'END ' + T(L, 'ussd.pay', { hint: payHint(c, L), currency: c.currency });
    case '6': { const w = wallets[0]; if (!w) return 'END ' + T(L, 'ussd.no_card');
      return 'END ' + T(L, 'card.balance', { card: w.card_number, amount: money(w.balance, w.currency, L) }); }
    default: return menu.replace(/^CON /, 'CON ' + T(L, 'ussd.invalid_choice') + '\n');
  }
}

// Anyone — even without an account — can report a problem or check the water status in an area.
function publicUssd(ctx, phone, parts) {
  const L = i18n.langForPhone(phone);
  const areas = db.all('SELECT id, name FROM service_areas WHERE active=1 ORDER BY name');
  const [choice, areaIx, kindIx] = parts;
  if (!parts.length) return 'CON ' + T(L, 'pub.menu');
  if (choice === '9') return langMenu(L, phone, areaIx);
  const pickArea = 'CON ' + T(L, 'pub.choose_area') + '\n' + areas.slice(0, 8).map((a, i) => `${i + 1} ${a.name.replace(/ \(Demo\)/, '')}`).join('\n');
  if (areaIx === undefined) return pickArea;
  const area = areas[Number(areaIx) - 1]; if (!area) return 'END ' + T(L, 'ussd.invalid_choice');
  if (choice === '3') {
    const st = require('./community').statusPage().find(a => a.area === area.name);
    const wps = st.water_points.filter(p => p.status === 'operational').length;
    const sp = require('./supply'); const nx = sp.next(area.id, null);
    return 'END ' + T(L, 'pub.status', { area: area.name.replace(/ \(Demo\)/, ''), label: T(L, 'supply.' + st.supply), advisory: st.quality_advisory ? T(L, 'pub.advisory') : '', ok: wps, total: st.water_points.length,
      next: nx ? T(L, 'pub.next', { zone: nx.zone ? ' ' + nx.zone : '', when: sp.fmtWin(nx, L) }) : '' });
  }
  if (choice === '4') {
    const r = require('./connections').submit(ctx, { applicant_name: 'USSD applicant ' + String(phone).slice(-4), phone, area_id: area.id, address: 'To be confirmed by phone', channel: 'ussd' });
    return 'END ' + T(L, 'pub.connection', { ref: r.ref });
  }
  if (choice === '1' && kindIx === undefined) return 'CON ' + T(L, 'pub.what');
  const kind = choice === '2' ? 'no_water' : kindIx === '2' ? 'burst' : kindIx === '1' ? 'leak' : null;
  if (!kind) return 'END ' + T(L, 'ussd.invalid_choice');
  const r = require('./community').report(ctx, { kind, area_id: area.id, phone, channel: 'ussd', description: 'Reported by USSD from an unregistered number' });
  return 'END ' + T(L, 'pub.report', { ref: r.ref });
}

// ---------------- SMS keywords ----------------
// Keyword aliases from every language file: { SOLDE: 'BAL', SALDO: 'BAL', … }
let ALIAS = null;
function aliases() {
  if (ALIAS) return ALIAS; ALIAS = {};
  const dir = path.join(__dirname, '..', 'i18n');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) { try { const k = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).keywords || {}; for (const [canon, list] of Object.entries(k)) for (const w of list) ALIAS[w.toUpperCase()] = canon; } catch { /* ignore a broken file */ } }
  return ALIAS;
}
const canon = w => { const u = String(w || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); return aliases()[u] || u; };
const langOfKeyword = w => { const u = String(w || '').toUpperCase(); for (const l of i18n.languages()) { const f = path.join(__dirname, '..', 'i18n', l.code + '.json'); try { const k = JSON.parse(fs.readFileSync(f, 'utf8')).keywords || {}; if (Object.values(k).some(list => list.includes(u)) && l.code !== 'en') return l.code; } catch { /* custom language without file */ } } return null; };

function smsInbound(ctx, { phone, body }) {
  db.run(`INSERT INTO sms_messages(direction, channel, phone, body, status, provider, purpose) VALUES ('in','sms',?,?,'received',?, 'keyword')`, phone, String(body).slice(0, 480), ctx.simulated ? 'simulator' : 'aggregator');
  const rated = require('./feedback').handleReply(ctx, phone, body);
  if (rated) { send(phone, rated, { purpose: 'reply' }); return rated; }
  const [kw, ...rest] = String(body || '').trim().split(/\s+/); const arg = rest.join(' ');
  const custs = customersByPhone(phone); const c = custs[0]; const w = walletsByPhone(phone)[0];
  const K = canon(kw);
  // A person who writes a local-language keyword and has no language yet gets replies in that language.
  const kwLang = langOfKeyword(kw); if (kwLang && !db.get('SELECT 1 FROM phone_languages WHERE phone_key=?', normPhone(phone)) && !(c && c.language)) i18n.setPhoneLang(phone, kwLang);
  let L = i18n.langForPhone(phone);
  let reply;
  if (K === 'LANG') {
    const want = String(arg || '').trim().toLowerCase(); const langs = i18n.languages();
    const l = langs.find(x => x.code === want || x.name.toLowerCase() === want || x.native_name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') === want.normalize('NFD').replace(/[̀-ͯ]/g, ''));
    if (!l) reply = T(L, 'lang.unknown', { list: langs.map(x => x.code.toUpperCase()).join(', ') });
    else { i18n.setPhoneLang(phone, l.code); L = l.code; reply = T(L, 'lang.set', { name: l.native_name }); }
  }
  else if (!c && ['LEAK', 'BURST', 'NOWATER'].includes(K)) { // unregistered: still accept the report
    const r = require('./community').report(ctx, { kind: K === 'BURST' ? 'burst' : K === 'LEAK' ? 'leak' : 'no_water', phone, channel: 'sms', location_text: arg || null, description: 'Reported by SMS from an unregistered number' });
    reply = T(L, 'sms.unreg_report', { ref: r.ref, hint: arg ? '' : T(L, 'sms.unreg_hint') });
  }
  else if (!c && !(K === 'CARD' && w)) reply = T(L, 'sms.unregistered');
  else if (custs.length > 1 && !['HELP', 'PAY', 'CARD'].includes(K)) reply = T(L, 'sms.several', { list: custs.map(x => x.customer_number).join(', ') });
  else switch (K) {
    case 'BAL': { const bal = balanceOf(c.id); reply = T(L, 'sms.balance', { account: c.customer_number, status: balanceText(L, bal, c.currency) }); break; }
    case 'BILL': { const bl = lastBill(c.id); reply = bl ? T(L, 'sms.bill', { bill: bl.bill_number, m3: bl.consumption, amount: money(bl.total, bl.currency, L), due: bl.due_date, status: statusText(L, bl.status) }) : T(L, 'ussd.no_bill'); break; }
    case 'READ': { const v = Number(String(arg).replace(',', '.'));
      if (!arg || !Number.isFinite(v) || v < 0) { reply = T(L, 'sms.read_help'); break; }
      try { const r = submitSelfReading(ctx, c, v, 'sms'); reply = T(L, 'reading.received', { value: v, ref: r.id }); } catch (e) { reply = e.message; } break; }
    case 'LEAK': case 'NOWATER': case 'BURST': { const id = reportProblem(ctx, c, K === 'LEAK' ? 'leak' : K === 'BURST' ? 'burst' : 'nowater', arg, 'sms'); reply = T(L, 'sms.report', { ref: id ? T(L, 'ussd.report_ref', { id }) : '' }); break; }
    case 'PAY': reply = c ? payHint(c, L) : T(L, 'pay.visit'); break;
    case 'PLAN': {
      const bal = balanceOf(c.id);
      if (bal <= 0) { reply = T(L, 'sms.plan_none'); break; }
      require('./alerts').raise({ ...ctx, actor: 'sms' }, { rule_type: 'customer_report', severity: 'low', title: `Payment plan requested — ${c.name}`, description: `Customer asked for a payment plan by SMS. Balance ${money(bal, c.currency, 'en')}. Open Collections to agree a plan.`,
        customer_id: c.id, area_id: c.area_id, source: 'customer', data_basis: 'manual', dedupe_key: `planreq:${c.id}:${new Date().toISOString().slice(0, 7)}` });
      reply = T(L, 'sms.plan_requested', { amount: money(bal, c.currency, L) }); break; }
    case 'SUPPLY': {
      const a = canon(String(arg).split(/\s+/)[0]);
      if (a === 'OFF' || a === 'ON') { for (const x of custs) db.run('UPDATE customers SET supply_sms=? WHERE id=?', a === 'ON' ? 1 : 0, x.id); reply = T(L, a === 'ON' ? 'sms.supply_on' : 'sms.supply_off'); break; }
      const sp = require('./supply'); const nx = sp.next(c.area_id, c.supply_zone);
      reply = nx ? T(L, 'sms.supply_next', { zone: nx.zone ? ` (${nx.zone})` : '', when: sp.fmtWin(nx, L), now: nx.flowing ? T(L, 'sms.supply_now') : '' }) : T(L, 'sms.supply_none'); break; }
    case 'CARD': reply = w ? T(L, 'card.balance', { card: w.card_number, amount: money(w.balance, w.currency, L) }) : T(L, 'sms.no_card'); break;
    default: reply = T(L, 'sms.help');
  }
  send(phone, reply, { customer_id: c && c.id, wallet_id: w && w.id, purpose: 'reply' });
  return reply;
}

module.exports = { ussd, smsInbound, send, sendT, notifyBill, notifyPayment, customersByPhone, walletsByPhone, customerByRef, walletByRef, normPhone, normRef, money, short, payHint, T, gsmFold };
