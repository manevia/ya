'use strict';
/*
 * Community-facing services: anyone (no account) can report a leak / outage / water-quality problem by web, USSD or SMS,
 * gets a reference number, and is told by SMS when it is resolved ("closed loop"). A public status page shows supply
 * status, water points, prices and water-quality results per area — never any customer data.
 */
const crypto = require('crypto');
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const channels = require('./channels');

const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef() { const b = crypto.randomBytes(6); let s = ''; for (const x of b) s += ALPH[x % ALPH.length]; return 'R-' + s; }
const KIND = {
  leak: { rule: 'suspected_leak', sev: 'medium', title: 'Leak reported' }, burst: { rule: 'suspected_leak', sev: 'high', title: 'Burst pipe reported' },
  no_water: { rule: 'customer_report', sev: 'medium', title: 'No water reported' }, quality: { rule: 'water_quality', sev: 'high', title: 'Water quality complaint' },
  kiosk: { rule: 'customer_report', sev: 'low', title: 'Water point / kiosk problem reported' }, other: { rule: 'customer_report', sev: 'low', title: 'Community report' }
};
const ipHash = ip => crypto.createHash('sha256').update('aq-salt:' + String(ip || '')).digest('hex').slice(0, 24);

function report(ctx, b) {
  const k = KIND[b.kind]; if (!k) throw new HttpError(400, 'Unknown problem type');
  const ih = ipHash(ctx.ip);
  if (b.channel === 'web') {
    const n = db.get(`SELECT COUNT(*) n FROM public_reports WHERE ip_hash=? AND created_at >= datetime('now','-1 hour')`, ih).n;
    if (n >= 5) throw new HttpError(429, 'Too many reports from this device in the last hour. Please try again later or call the utility.');
  }
  if (b.phone) { const n = db.get(`SELECT COUNT(*) n FROM public_reports WHERE phone=? AND created_at >= datetime('now','-1 day')`, b.phone).n; if (n >= 5) throw new HttpError(429, 'Daily report limit reached for this phone number.'); }
  let area = b.area_id ? db.get('SELECT * FROM service_areas WHERE id=? AND active=1', b.area_id) : null;
  const asset = b.asset_id ? db.get('SELECT * FROM assets WHERE id=?', b.asset_id) : null;
  if (asset && !area) area = db.get('SELECT * FROM service_areas WHERE id=?', asset.area_id);
  return db.tx(() => {
    const ref = newRef();
    const where = [b.location_text, asset && asset.name, area && area.name].filter(Boolean).join(' — ') || 'location not given';
    const alertId = require('./alerts').raise({ ...ctx, actor: 'public:' + b.channel }, { rule_type: k.rule, severity: k.sev, title: `${k.title} by community member (${ref})`,
      description: `${where}${b.description ? ' — ' + b.description : ''}. Channel: ${b.channel}.${b.photo_path ? ' Photo attached.' : ''}`, area_id: area && area.id, asset_id: asset && asset.id,
      lat: b.lat ?? (asset && asset.lat), lng: b.lng ?? (asset && asset.lng), source: 'public', data_basis: 'manual' });
    const r = db.run(`INSERT INTO public_reports(ref, kind, area_id, asset_id, location_text, lat, lng, phone, photo_path, description, channel, alert_id, ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, b.kind, area && area.id, asset && asset.id, b.location_text || null, b.lat ?? null, b.lng ?? null, b.phone || null, b.photo_path || null, b.description || null, b.channel, alertId, ih);
    if (b.phone && b.channel !== 'sms') { const L = require('../lib/i18n').langForPhone(b.phone); channels.sendT(b.phone, 'report.ack', { ref, kind: channels.T(L, 'report.kind.' + b.kind) }, { purpose: 'report_ack' }, L); }
    audit.log({ ...ctx, actor: 'public:' + b.channel }, 'public.report', 'public_report', r.id, { ref, kind: b.kind, area: area && area.code, alert_id: alertId });
    return { ref, id: r.id, alert_id: alertId };
  });
}

function track(ref) {
  const r = db.get(`SELECT p.*, a.name area_name, al.status alert_status, al.resolved_at, s.name asset_name,
    (SELECT status FROM work_orders w WHERE w.alert_id=p.alert_id ORDER BY id DESC LIMIT 1) wo_status FROM public_reports p LEFT JOIN service_areas a ON a.id=p.area_id
    LEFT JOIN alerts al ON al.id=p.alert_id LEFT JOIN assets s ON s.id=p.asset_id WHERE p.ref=?`, String(ref || '').toUpperCase().trim());
  if (!r) return null;
  const stage = ['resolved'].includes(r.alert_status) ? 'resolved' : r.alert_status === 'dismissed' ? 'closed' : r.wo_status === 'in_progress' ? 'team_working' : r.alert_status === 'work_order' || r.wo_status ? 'team_assigned' : r.alert_status === 'acknowledged' ? 'acknowledged' : 'received';
  return { ref: r.ref, kind: r.kind, area: r.area_name, asset: r.asset_name, reported_at: r.created_at, stage, resolved_at: r.resolved_at };
}

/** Tell the people who reported a problem that it has been dealt with. Called when an alert is resolved/dismissed or its work order completes. */
function closeLoop(alertId) {
  const a = db.get('SELECT * FROM alerts WHERE id=?', alertId); if (!a || !['resolved', 'dismissed'].includes(a.status)) return 0;
  let n = 0; const fb = require('./feedback');
  const wo = db.get(`SELECT * FROM work_orders WHERE alert_id=? ORDER BY id DESC LIMIT 1`, alertId);
  const i18n = require('../lib/i18n');
  const ask = (phone, extra, L) => (a.status === 'resolved' && fb.request({}, { alert_id: a.id, work_order_id: wo ? wo.id : null, phone, area_id: a.area_id, technician_id: wo ? wo.assigned_to : null, send: false, ...extra }) ? ' ' + channels.T(L, 'feedback.ask') : '');
  for (const p of db.all('SELECT * FROM public_reports WHERE alert_id=? AND resolved_notified=0', alertId)) {
    if (p.phone) { const L = i18n.langForPhone(p.phone); channels.send(p.phone, `${channels.short()}: ${channels.T(L, a.status === 'resolved' ? 'report.resolved' : 'report.closed', { ref: p.ref })}${a.status === 'resolved' ? ask(p.phone, { public_report_id: p.id }, L) : ''}`, { purpose: 'report_closed' }); n++; }
    db.run('UPDATE public_reports SET resolved_notified=1 WHERE id=?', p.id);
  }
  if (a.rule_type === 'customer_report' && a.customer_id && a.source === 'customer') {
    const key = 'closed:' + a.id;
    const c = db.get('SELECT * FROM customers WHERE id=?', a.customer_id);
    if (c && c.phone && !db.get(`SELECT 1 FROM reminders_sent WHERE kind='report_closed' AND ref=?`, key)) {
      const L = i18n.langForCustomer(c); const sid = channels.send(c.phone, `${channels.short()}: ${channels.T(L, a.status === 'resolved' ? 'report.cust_resolved' : 'report.cust_closed', { id: a.id })}${wo ? ask(c.phone, { customer_id: c.id }, L) : ''}`, { customer_id: c.id, purpose: 'report_closed' });
      db.run(`INSERT OR IGNORE INTO reminders_sent(kind, ref, customer_id, sms_id) VALUES ('report_closed',?,?,?)`, key, c.id, sid); n++;
    }
  }
  return n;
}

/** Public, aggregate status per area. */
function statusPage() {
  const today = new Date().toISOString().slice(0, 10);
  const q = require('./quality');
  return db.all(`SELECT id, name, code, currency FROM service_areas WHERE active=1 ORDER BY name`).map(a => {
    const notices = db.all(`SELECT title, body, notice_type, starts_at, ends_at FROM service_notices WHERE (area_id=? OR area_id IS NULL) AND notice_type IN ('outage','maintenance','quality')
      AND (ends_at IS NULL OR ends_at >= ?) AND (starts_at IS NULL OR starts_at <= date(?, '+7 day')) ORDER BY starts_at`, a.id, today, today);
    const issues = db.get(`SELECT COUNT(*) n FROM alerts WHERE area_id=? AND status IN ('open','acknowledged','work_order') AND severity IN ('high','critical') AND rule_type IN ('suspected_leak','continuous_flow','supply_imbalance','customer_report','water_quality')`, a.id).n;
    const nowOutage = notices.find(n => n.notice_type === 'outage' && (!n.starts_at || n.starts_at <= today));
    const nowMaint = notices.find(n => n.notice_type === 'maintenance' && n.starts_at && n.starts_at <= today);
    const supply = nowOutage ? 'interrupted' : nowMaint ? 'maintenance' : issues ? 'issues_reported' : 'normal';
    const points = db.all(`SELECT s.id, s.name, s.status, s.lat, s.lng, w.mode, w.price_per_container, w.container_liters, w.opening_hours, w.active FROM assets s LEFT JOIN wp_config w ON w.asset_id=s.id
      WHERE s.asset_type='water_point' AND s.area_id=? AND s.status!='decommissioned' ORDER BY s.name`, a.id).map(p => ({ ...p, quality: q.latestOverall(p.id) }));
    const advisory = notices.some(n => n.notice_type === 'quality');
    const sched = require('./supply').upcoming({ area_id: a.id, days: 3 }).map(w => ({ zone: w.zone, date: w.date, start_time: w.start_time, end_time: w.end_time, flowing: w.flowing, cancelled: !!w.cancelled }));
    return { area: a.name, code: a.code, currency: a.currency, supply, open_issues: issues, quality_advisory: advisory, notices, water_points: points, schedule: sched };
  });
}

/** SMS everyone with a phone in an area (customers + water-card holders). Used for outages and health advisories. */
/** text may be a string, or { key, vars } to send each person the message in their own language. */
function broadcast(areaId, text, purpose) {
  const phones = new Map();
  for (const c of db.all(`SELECT id, phone FROM customers WHERE area_id=? AND status='active' AND phone IS NOT NULL`, areaId)) phones.set(channels.normPhone(c.phone), { phone: c.phone, customer_id: c.id });
  for (const w of db.all(`SELECT id, phone FROM wp_wallets WHERE area_id=? AND status='active' AND phone IS NOT NULL`, areaId)) if (!phones.has(channels.normPhone(w.phone))) phones.set(channels.normPhone(w.phone), { phone: w.phone, wallet_id: w.id });
  const i18n = require('../lib/i18n');
  for (const p of phones.values()) { if (typeof text === 'string') channels.send(p.phone, text, { ...p, purpose }); else channels.sendT(p.phone, text.key, text.vars, { ...p, purpose }, p.customer_id ? i18n.langForCustomer(db.get('SELECT id, phone, language FROM customers WHERE id=?', p.customer_id)) : i18n.langForPhone(p.phone)); }
  return phones.size;
}

module.exports = { report, track, closeLoop, statusPage, broadcast, KIND };
