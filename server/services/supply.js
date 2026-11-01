'use strict';
/*
 * Supply timetables for intermittent / rationed supply.
 * Each schedule says when water flows to an area (optionally one zone of it): weekdays + a time window.
 * Customers get an SMS heads-up before their window; operators log the hours actually delivered,
 * which drives "hours of supply per day" and "supply reliability" in the performance indicators.
 * Times are local clock times in the utility's time zone (Settings › Country), converted to exact instants for comparisons.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const channels = require('./channels');
const tz = require('../lib/tz');
const i18n = require('../lib/i18n');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hoursOf = s => r2((mins(s.end_time) - mins(s.start_time)) / 60);
const dateAdd = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const todayStr = () => tz.localDate();
const zoneLabel = s => (s.zone ? `${s.zone}` : 'whole area');

function check(b) {
  if (!TIME.test(b.start_time || '') || !TIME.test(b.end_time || '')) throw new HttpError(400, 'Times must be HH:MM (24-hour)');
  if (mins(b.end_time) <= mins(b.start_time)) throw new HttpError(400, 'End time must be after start time (split overnight supply into two schedules)');
  const days = [...new Set(String(b.days || '').replace(/[^0-6]/g, ''))].sort().join('');
  if (!days) throw new HttpError(400, 'Choose at least one day');
  return days;
}
function save(ctx, id, b) {
  const days = check(b);
  if (!db.get('SELECT 1 FROM service_areas WHERE id=?', b.area_id)) throw new HttpError(400, 'Unknown area');
  const zone = b.zone ? String(b.zone).trim().slice(0, 60) : null;
  if (id) {
    if (!db.get('SELECT 1 FROM supply_schedules WHERE id=?', id)) throw new HttpError(404, 'Not found');
    db.run('UPDATE supply_schedules SET area_id=?, zone=?, days=?, start_time=?, end_time=?, active=?, notes=? WHERE id=?', b.area_id, zone, days, b.start_time, b.end_time, b.active === false ? 0 : 1, b.notes || null, id);
  } else id = db.run('INSERT INTO supply_schedules(area_id, zone, days, start_time, end_time, active, notes, created_by) VALUES (?,?,?,?,?,?,?,?)', b.area_id, zone, days, b.start_time, b.end_time, b.active === false ? 0 : 1, b.notes || null, ctx.user.id).id;
  audit.log(ctx, 'supply.schedule', 'supply_schedule', id, { ...b, days });
  return { id };
}

/** Scheduled windows between two dates (inclusive). */
function windows(s, from, to) {
  const out = [];
  for (let d = from; d <= to; d = dateAdd(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay(); // weekday of the local calendar date
    if (s.days.includes(String(wd))) out.push({ schedule_id: s.id, area_id: s.area_id, zone: s.zone, date: d, start: tz.toUtc(d, s.start_time), end: tz.toUtc(d, s.end_time), start_time: s.start_time, end_time: s.end_time, hours: hoursOf(s) });
  }
  return out;
}
const schedules = (areaId, activeOnly = true) => db.all(`SELECT s.*, a.name area_name, a.code area_code FROM supply_schedules s JOIN service_areas a ON a.id=s.area_id WHERE 1=1 ${activeOnly ? 'AND s.active=1' : ''} ${areaId ? 'AND s.area_id=?' : ''} ORDER BY a.name, s.zone, s.start_time`, ...(areaId ? [areaId] : []));

/** Outage/maintenance notice covering a date in an area (supply cancelled). */
const interruption = (areaId, date) => db.get(`SELECT title FROM service_notices WHERE (area_id=? OR area_id IS NULL) AND notice_type IN ('outage','maintenance') AND (starts_at IS NULL OR substr(starts_at,1,10) <= ?) AND (ends_at IS NULL OR substr(ends_at,1,10) >= ?) ORDER BY id DESC LIMIT 1`, areaId, date, date);

function upcoming({ area_id, days = 7, from } = {}) {
  const f = from || todayStr(); const t = dateAdd(f, Math.max(0, days - 1)); const now = new Date().toISOString();
  const out = [];
  for (const s of schedules(area_id)) for (const w of windows(s, f, t)) {
    if (w.end < now) continue;
    const intr = interruption(s.area_id, w.date);
    out.push({ ...w, area_name: s.area_name, flowing: w.start <= now && now < w.end && !intr, cancelled: intr ? intr.title : null });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
/** Next window for an area/zone (customers with no zone see the whole-area or first zone schedule). */
function next(areaId, zone) {
  const list = upcoming({ area_id: areaId, days: 8 }).filter(w => !w.cancelled);
  return list.find(w => (zone ? w.zone === zone : true) || !w.zone) || null;
}
const fmtWin = (w, lang = 'en') => `${(i18n.t(lang, 'days').split(',')[new Date(w.date + 'T00:00:00Z').getUTCDay()]) || DAY[new Date(w.date + 'T00:00:00Z').getUTCDay()]} ${w.date.slice(8, 10)}/${w.date.slice(5, 7)} ${w.start_time}-${w.end_time}`;

/** SMS heads-up to customers before their window (each window is announced once). */
function runHeadsUp(ctx = {}, { now = new Date() } = {}) {
  if (db.setting('supply_sms_enabled', '1') !== '1') return { windows: 0, recipients: 0, disabled: true };
  const lead = db.settingNum('supply_notice_hours', 2) * 3600e3; const nowIso = now.toISOString(); const until = new Date(now.getTime() + lead).toISOString();
  let nWin = 0, nRec = 0;
  const d0 = tz.localDate(now);
  for (const s of schedules()) for (const w of windows(s, d0, dateAdd(d0, 1))) {
    if (!(w.start >= nowIso && w.start <= until)) continue;
    if (db.get('SELECT 1 FROM supply_notices_sent WHERE schedule_id=? AND supply_date=?', s.id, w.date)) continue;
    const intr = interruption(s.area_id, w.date);
    const custs = db.all(`SELECT id, phone, language FROM customers WHERE area_id=? AND status='active' AND phone IS NOT NULL AND supply_sms=1 ${s.zone ? 'AND supply_zone=?' : ''}`, s.area_id, ...(s.zone ? [s.zone] : []));
    for (const c of custs) { const L = i18n.langForCustomer(c);
      channels.sendT(c.phone, intr ? 'supply.cancelled' : 'supply.heads_up', { when: fmtWin(w, L), zone: s.zone ? (intr ? ` (${s.zone})` : i18n.t(L, 'supply.in_zone', { zone: s.zone })) : '', reason: intr ? intr.title : '' }, { customer_id: c.id, purpose: 'supply' }, L); }
    db.run('INSERT INTO supply_notices_sent(schedule_id, supply_date, recipients) VALUES (?,?,?)', s.id, w.date, custs.length);
    nWin++; nRec += custs.length;
  }
  if (nWin) audit.log({ ...ctx, actor: ctx.user ? undefined : 'scheduler' }, 'supply.heads_up', 'supply', null, { windows: nWin, recipients: nRec });
  return { windows: nWin, recipients: nRec };
}

/** Record hours actually delivered for a scheduled window (or unscheduled extra supply). */
function log(ctx, b) {
  const date = b.supply_date;
  if (date > todayStr()) throw new HttpError(400, 'Cannot log supply for a future date');
  let s = null, planned = 0;
  if (b.schedule_id) {
    s = db.get('SELECT * FROM supply_schedules WHERE id=?', b.schedule_id); if (!s) throw new HttpError(400, 'Unknown schedule');
    const w = windows(s, date, date)[0]; if (!w) throw new HttpError(400, `This schedule has no supply on ${date}`); planned = w.hours;
  } else if (!b.area_id) throw new HttpError(400, 'Choose the schedule or the area');
  const delivered = r2(Number(b.delivered_hours));
  if (!(delivered >= 0 && delivered <= 24)) throw new HttpError(400, 'Delivered hours must be 0–24');
  const outcome = !s ? 'extra' : delivered <= 0 ? 'missed' : delivered >= planned * 0.9 ? 'delivered' : 'partial';
  if (s && outcome !== 'delivered' && !b.reason) throw new HttpError(400, 'Give a reason when supply was short or missed (e.g. generator fuel, pump fault, low source)');
  const areaId = s ? s.area_id : b.area_id, zone = s ? s.zone : (b.zone || null);
  if (s) db.run(`INSERT INTO supply_log(schedule_id, area_id, zone, supply_date, planned_hours, delivered_hours, outcome, reason, entered_by) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(schedule_id, supply_date) DO UPDATE SET delivered_hours=excluded.delivered_hours, outcome=excluded.outcome, reason=excluded.reason, entered_by=excluded.entered_by, created_at=datetime('now')`, s.id, areaId, zone, date, planned, delivered, outcome, b.reason || null, ctx.user.id);
  else db.run('INSERT INTO supply_log(schedule_id, area_id, zone, supply_date, planned_hours, delivered_hours, outcome, reason, entered_by) VALUES (NULL,?,?,?,0,?,?,?,?)', areaId, zone, date, delivered, 'extra', b.reason || null, ctx.user.id);
  audit.log(ctx, 'supply.log', 'supply_log', `${b.schedule_id || 'area' + areaId}:${date}`, { planned, delivered, outcome, reason: b.reason });
  return { outcome, planned_hours: planned, delivered_hours: delivered };
}

/** Past scheduled windows (last N days) with no delivery logged yet. */
function unlogged(days = 7) {
  const t = todayStr(); const nowIso = new Date().toISOString(); const out = [];
  for (const s of schedules()) for (const w of windows(s, dateAdd(t, -days), t)) {
    if (w.end > nowIso) continue;
    if (!db.get('SELECT 1 FROM supply_log WHERE schedule_id=? AND supply_date=?', s.id, w.date)) out.push({ ...w, area_name: s.area_name });
  }
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

/** Reliability per area for a date range: % of planned hours delivered, and average hours of supply per day per zone. */
function reliability({ from, to, area_id } = {}) {
  const t = to > todayStr() ? todayStr() : to;
  return db.all(`SELECT id, name, currency FROM service_areas WHERE active=1 ${area_id ? 'AND id=?' : ''} ORDER BY name`, ...(area_id ? [area_id] : [])).map(a => {
    const L = db.get(`SELECT COUNT(*) n, SUM(planned_hours) p, SUM(CASE WHEN schedule_id IS NOT NULL THEN MIN(delivered_hours, planned_hours) ELSE 0 END) dp, SUM(delivered_hours) d,
      SUM(outcome='missed') missed, SUM(outcome='partial') partial, MIN(supply_date) first FROM supply_log WHERE area_id=? AND supply_date BETWEEN ? AND ?`, a.id, from, t);
    if (!L.n) return { area_id: a.id, area: a.name, logged: 0 };
    const zones = Math.max(1, db.get(`SELECT COUNT(DISTINCT COALESCE(zone,'')) n FROM supply_schedules WHERE area_id=? AND active=1`, a.id).n);
    const start = L.first > from ? L.first : from;
    const days = Math.round((Date.parse(t) - Date.parse(start)) / 86400e3) + 1;
    return { area_id: a.id, area: a.name, logged: L.n, planned_hours: r2(L.p || 0), delivered_hours: r2(L.d || 0), reliability_pct: L.p ? r2((L.dp || 0) / L.p * 100) : null,
      hours_per_day: r2((L.d || 0) / (days * zones)), missed: L.missed || 0, partial: L.partial || 0, days, zones,
      reasons: db.all(`SELECT reason, COUNT(*) n FROM supply_log WHERE area_id=? AND supply_date BETWEEN ? AND ? AND outcome IN ('missed','partial') AND reason IS NOT NULL GROUP BY reason ORDER BY n DESC LIMIT 5`, a.id, from, t) };
  });
}

module.exports = { save, windows, schedules, upcoming, next, fmtWin, runHeadsUp, log, unlogged, reliability, DAY, hoursOf, interruption };
