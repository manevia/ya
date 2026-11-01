'use strict';
/*
 * New water connections, from application to first bill, with connection-fee financing:
 * submitted → survey_scheduled → surveyed → quoted → accepted → installing → connected   (or rejected / cancelled)
 * The deposit is charged to the new account when the quote is accepted; the remainder is split into monthly
 * instalments that appear as separate lines on the customer's normal water bills.
 */
const crypto = require('crypto');
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const channels = require('./channels');
const accounts = require('./accounts');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () => 'C-' + [...crypto.randomBytes(6)].map(x => ALPH[x % ALPH.length]).join('');
const STAGE_TEXT = { submitted: 'Application received', survey_scheduled: 'Site survey scheduled', surveyed: 'Site surveyed — quote being prepared', quoted: 'Quote ready — please accept to continue',
  accepted: 'Accepted — pay the deposit to book installation', installing: 'Installation in progress', connected: 'Connected', rejected: 'Not possible at this time', cancelled: 'Cancelled' };

function ev(ctx, id, status, note) { db.run('INSERT INTO connection_request_events(request_id, status, note, user_id) VALUES (?,?,?,?)', id, status, note || null, ctx.user ? ctx.user.id : null); }
const i18n = require('../lib/i18n');
const langOf = r => (r.customer_id ? i18n.langForCustomer(db.get('SELECT id, phone, language FROM customers WHERE id=?', r.customer_id)) : i18n.langForPhone(r.phone));
/** SMS the applicant in their language. vars whose value is {__money:[n,cur]} are formatted for that language. */
function sms(r, key, vars = {}) { if (!r.phone) return; const L = langOf(r); const v = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, x && x.__money ? channels.money(x.__money[0], x.__money[1], L) : x && x.__t ? channels.T(L, x.__t, x.vars) : x])); channels.sendT(r.phone, key, v, { customer_id: r.customer_id || null, purpose: 'connection' }, L); }
const get = id => { const r = db.get('SELECT * FROM connection_requests WHERE id=?', id); if (!r) throw new HttpError(404, 'Request not found'); return r; };
function need(r, ...st) { if (!st.includes(r.status)) throw new HttpError(409, `This step is not possible while the request is "${r.status.replace('_', ' ')}"`); }

function submit(ctx, b) {
  if (b.channel === 'web') {
    const ih = crypto.createHash('sha256').update('aq-salt:' + String(ctx.ip || '')).digest('hex').slice(0, 24);
    if (db.get(`SELECT COUNT(*) n FROM connection_requests WHERE ip_hash=? AND created_at >= datetime('now','-1 day')`, ih).n >= 3) throw new HttpError(429, 'Too many applications from this device today.');
    b.ip_hash = ih;
  }
  return db.tx(() => {
    const ref = newRef();
    const r = db.run(`INSERT INTO connection_requests(ref, applicant_name, phone, area_id, address, landmark, lat, lng, customer_type, household_size, photo_path, channel, ip_hash, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, b.applicant_name, b.phone || null, b.area_id || null, b.address, b.landmark || null, b.lat ?? null, b.lng ?? null, b.customer_type || 'household', b.household_size || null, b.photo_path || null, b.channel || 'web', b.ip_hash || null, ctx.user ? ctx.user.id : null);
    ev(ctx, r.id, 'submitted', `Application via ${b.channel || 'web'}`);
    sms({ phone: b.phone }, 'conn.received', { ref });
    audit.log({ ...ctx, actor: ctx.user ? undefined : 'public:' + (b.channel || 'web') }, 'connection.submit', 'connection_request', r.id, { ref, area_id: b.area_id, channel: b.channel });
    return { id: r.id, ref };
  });
}

/** Suggested quote from the standard costs in Settings (entered in USD; converted at the latest recorded exchange rate for LRD areas). */
function defaultQuote(r) {
  const area = r.area_id ? db.get('SELECT currency FROM service_areas WHERE id=?', r.area_id) : null; const cur = area ? area.currency : 'USD';
  let fx = 1, note = null;
  if (cur !== 'USD') { const fr = require('./billing').findRate('USD', cur, new Date().toISOString().slice(0, 10)); if (!fr) return { lines: [], note: `No USD→${cur} exchange rate recorded — enter the quote manually` }; fx = fr.rate; note = `Converted from USD at ${r2(fr.rate)} (${fr.date})`; }
  const lines = []; const base = Number(db.setting('connection_base_fee', '')), pipe = Number(db.setting('connection_pipe_cost_per_m', '')), meter = Number(db.setting('connection_meter_cost', ''));
  if (base > 0) lines.push({ description: 'Connection fee (tapping, labour)', amount: r2(base * fx) });
  if (pipe > 0 && r.distance_m) lines.push({ description: `Service pipe ${r.distance_m} m`, amount: r2(pipe * r.distance_m * fx) });
  if (meter > 0) lines.push({ description: 'Water meter and box', amount: r2(meter * fx) });
  return { lines, currency: cur, note: lines.length ? note : 'Set standard connection costs in Settings to get a suggested quote' };
}

function advance(ctx, id, action, b = {}) {
  return db.tx(() => {
    const r = get(id);
    const area = r.area_id ? db.get('SELECT * FROM service_areas WHERE id=?', r.area_id) : null;
    const now = new Date().toISOString();
    const set = (fields) => { const k = Object.keys(fields); db.run(`UPDATE connection_requests SET ${k.map(x => x + '=?').join(', ')}, updated_at=? WHERE id=?`, ...k.map(x => fields[x]), now, id); };
    switch (action) {
      case 'schedule_survey': {
        need(r, 'submitted', 'survey_scheduled');
        if (!r.area_id && !b.area_id) throw new HttpError(400, 'Set the service area first');
        const areaId = r.area_id || b.area_id;
        const num = require('./billing').nextNumber('wo', n => 'WO-' + n);
        const wo = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, area_id, lat, lng, assigned_to, status, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, num, 'connection', 'medium',
          `Site survey — new connection ${r.ref}`, `Applicant: ${r.applicant_name}, ${r.phone || 'no phone'}. Address: ${r.address}${r.landmark ? ' (' + r.landmark + ')' : ''}. Measure distance to nearest main, check pressure and feasibility.`,
          areaId, r.lat, r.lng, b.assigned_to || null, b.assigned_to ? 'assigned' : 'open', b.due_date || null, ctx.user.id).id;
        db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', wo, ctx.user.id, 'open', 'Created from connection request ' + r.ref);
        set({ status: 'survey_scheduled', survey_wo_id: wo, area_id: areaId });
        ev(ctx, id, 'survey_scheduled', `Survey ${num}${b.due_date ? ' by ' + b.due_date : ''}`);
        sms(r, 'conn.survey', { ref: r.ref, by: b.due_date ? { __t: 'conn.by', vars: { date: b.due_date } } : '' });
        break;
      }
      case 'record_survey': {
        need(r, 'submitted', 'survey_scheduled', 'surveyed');
        if (b.feasible === false) { set({ status: 'rejected', survey_notes: b.notes || null, reject_reason: b.notes || 'Not feasible after survey' }); ev(ctx, id, 'rejected', b.notes); sms(r, 'conn.rejected', { ref: r.ref, reason: b.notes || 'not feasible' }); break; }
        if (!(b.distance_m >= 0)) throw new HttpError(400, 'Enter the pipe distance in metres');
        set({ status: 'surveyed', distance_m: b.distance_m, survey_notes: b.notes || null });
        ev(ctx, id, 'surveyed', `${b.distance_m} m to main. ${b.notes || ''}`);
        if (r.survey_wo_id) db.run(`UPDATE work_orders SET status='completed', completed_at=?, resolution=? WHERE id=? AND status NOT IN ('completed','cancelled')`, now, `Survey done: ${b.distance_m} m`, r.survey_wo_id);
        break;
      }
      case 'quote': {
        need(r, 'surveyed', 'quoted');
        if (!area) throw new HttpError(400, 'Request has no service area');
        const lines = (b.lines || []).filter(l => l && l.description && Number(l.amount) > 0).map(l => ({ description: String(l.description).slice(0, 120), amount: r2(Number(l.amount)) }));
        if (!lines.length) throw new HttpError(400, 'Add at least one quote line');
        const total = r2(lines.reduce((s, l) => s + l.amount, 0));
        const maxN = db.settingNum('connection_max_instalments', 12);
        set({ status: 'quoted', quote_json: JSON.stringify(lines), quote_total: total, currency: area.currency });
        ev(ctx, id, 'quoted', `Quote ${channels.money(total, area.currency)}`);
        sms(r, 'conn.quote', { ref: r.ref, amount: { __money: [total, area.currency] }, n: maxN });
        break;
      }
      case 'accept': {
        need(r, 'quoted');
        const maxN = db.settingNum('connection_max_instalments', 12);
        const deposit = r2(Number(b.deposit || 0)), n = Number(b.instalments || 0);
        if (deposit < 0 || deposit > r.quote_total) throw new HttpError(400, 'Deposit must be between 0 and the quote total');
        if (!(Number.isInteger(n) && n >= 0 && n <= maxN)) throw new HttpError(400, `Instalments must be 0–${maxN}`);
        if (n === 0 && deposit < r.quote_total) throw new HttpError(400, 'Without instalments the deposit must cover the full quote');
        const financed = r2(r.quote_total - deposit);
        const c = accounts.createCustomer(ctx, { name: r.applicant_name, customer_type: r.customer_type, phone: r.phone, address: r.address, landmark: r.landmark, area_id: r.area_id, lat: r.lat, lng: r.lng,
          gps_source: r.lat != null ? 'device_gps' : null, status: 'pending', household_size: r.household_size, notes: `New connection ${r.ref}` }, `Account opened from connection request ${r.ref}`);
        if (deposit > 0) db.run(`INSERT INTO adjustments(customer_id, amount, currency, category, reason, status, created_by, approved_by, decided_at) VALUES (?,?,?,?,?,'approved',?,?,?)`,
          c.id, deposit, r.currency, 'connection_fee', `Connection deposit ${r.ref}`, ctx.user.id, ctx.user.id, now);
        set({ status: 'accepted', deposit, instalments: n, instalment_amount: n ? r2(financed / n) : 0, customer_id: c.id });
        ev(ctx, id, 'accepted', `Account ${c.customer_number}; deposit ${deposit}; ${n} instalments`);
        { const L = langOf({ ...r, customer_id: c.id }); sms({ ...r, customer_id: c.id }, 'conn.accepted', { account: c.customer_number, ref: r.ref, deposit: deposit > 0 ? channels.T(L, 'conn.deposit', { amount: channels.money(deposit, r.currency, L), account: c.customer_number }) : '', financed: n ? channels.T(L, 'conn.financed', { amount: channels.money(financed, r.currency, L), n }) : '' }); }
        return { ...get(id), customer_number: c.customer_number };
      }
      case 'start_install': {
        need(r, 'accepted');
        const paid = r2(db.get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE customer_id=?', r.customer_id).s);
        if (r.deposit > 0 && paid + 0.004 < r.deposit && !b.override_reason) throw new HttpError(409, `Deposit not yet paid (${paid} of ${r.deposit}). A manager can override with a reason.`);
        const num = require('./billing').nextNumber('wo', n => 'WO-' + n);
        const wo = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, customer_id, area_id, lat, lng, assigned_to, status, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, num, 'connection', 'medium',
          `Install new connection ${r.ref}`, `Lay ${r.distance_m ?? '?'} m service pipe, fit meter and box, record serial and initial reading.${b.override_reason ? ' Deposit override: ' + b.override_reason : ''}`,
          r.customer_id, r.area_id, r.lat, r.lng, b.assigned_to || null, b.assigned_to ? 'assigned' : 'open', b.due_date || null, ctx.user.id).id;
        db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', wo, ctx.user.id, 'open', 'Created from connection request ' + r.ref);
        set({ status: 'installing', install_wo_id: wo });
        ev(ctx, id, 'installing', `Installation ${num}${b.override_reason ? ' (deposit override: ' + b.override_reason + ')' : ''}`);
        if (b.override_reason) audit.log(ctx, 'connection.deposit_override', 'connection_request', id, { reason: b.override_reason, paid, deposit: r.deposit });
        sms(r, 'conn.install', { ref: r.ref, when: b.due_date ? { __t: 'conn.for', vars: { date: b.due_date } } : '' });
        break;
      }
      case 'complete': {
        need(r, 'installing');
        const m = db.get('SELECT * FROM meters WHERE id=?', b.meter_id); if (!m) throw new HttpError(400, 'Choose the meter that was installed');
        if (m.customer_id || !['in_stock'].includes(m.status)) throw new HttpError(409, 'That meter is not in stock');
        accounts.assignMeter(ctx, m.id, r.customer_id, b.initial_reading ?? m.initial_reading, now, 'New connection ' + r.ref);
        db.run(`UPDATE customers SET status='active', updated_at=datetime('now') WHERE id=?`, r.customer_id);
        if (r.instalments > 0) {
          const financed = r2(r.quote_total - r.deposit); const each = Math.floor(financed / r.instalments * 100) / 100;
          const start = new Date(); start.setUTCDate(1);
          for (let i = 0; i < r.instalments; i++) {
            const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i); // first instalment on the first bill
            db.run('INSERT INTO financed_charges(customer_id, request_id, description, seq, of_total, amount, currency, due_month) VALUES (?,?,?,?,?,?,?,?)', r.customer_id, id, `Connection fee instalment`, i + 1, r.instalments,
              i === r.instalments - 1 ? r2(financed - each * (r.instalments - 1)) : each, r.currency, d.toISOString().slice(0, 7));
          }
        }
        if (r.install_wo_id) db.run(`UPDATE work_orders SET status='completed', completed_at=?, resolution=? WHERE id=? AND status NOT IN ('completed','cancelled')`, now, `Meter ${m.serial_number} installed`, r.install_wo_id);
        set({ status: 'connected', meter_id: m.id });
        ev(ctx, id, 'connected', `Meter ${m.serial_number}`);
        const c = db.get('SELECT * FROM customers WHERE id=?', r.customer_id);
        sms({ ...r, customer_id: c.id }, 'conn.live', { ref: r.ref, account: c.customer_number, meter: m.serial_number });
        break;
      }
      case 'reject': case 'cancel': {
        need(r, 'submitted', 'survey_scheduled', 'surveyed', 'quoted', 'accepted');
        if (!b.reason || b.reason.length < 5) throw new HttpError(400, 'Give a reason');
        if (r.customer_id && db.get('SELECT 1 FROM payments WHERE customer_id=? LIMIT 1', r.customer_id)) throw new HttpError(409, 'Payments exist on this account — refund or adjust first');
        if (r.customer_id) db.run(`UPDATE customers SET status='closed' WHERE id=?`, r.customer_id);
        set({ status: action === 'reject' ? 'rejected' : 'cancelled', reject_reason: b.reason });
        ev(ctx, id, action === 'reject' ? 'rejected' : 'cancelled', b.reason);
        sms(r, action === 'reject' ? 'conn.declined' : 'conn.cancelled', { ref: r.ref, reason: b.reason });
        break;
      }
      default: throw new HttpError(400, 'Unknown action');
    }
    audit.log(ctx, 'connection.' + action, 'connection_request', id, b);
    return get(id);
  });
}

function track(ref) {
  const r = db.get(`SELECT c.ref, c.status, c.created_at, c.updated_at, c.quote_total, c.currency, c.deposit, c.instalments, c.instalment_amount, a.name area_name FROM connection_requests c LEFT JOIN service_areas a ON a.id=c.area_id WHERE c.ref=?`, String(ref || '').toUpperCase().trim());
  if (!r) return null;
  return { ref: r.ref, kind: 'connection', area: r.area_name, reported_at: r.created_at, status: r.status, stage_text: STAGE_TEXT[r.status],
    quote: ['quoted', 'accepted', 'installing', 'connected'].includes(r.status) ? { total: r.quote_total, currency: r.currency, deposit: r.deposit, instalments: r.instalments, instalment_amount: r.instalment_amount } : null };
}

/** Financed instalments due by a billing period end; used by bill generation. */
function dueCharges(customerId, periodEnd) {
  return db.all(`SELECT * FROM financed_charges WHERE customer_id=? AND bill_id IS NULL AND due_month <= ? ORDER BY seq`, customerId, periodEnd.slice(0, 7));
}

module.exports = { submit, advance, track, defaultQuote, dueCharges, STAGE_TEXT };
