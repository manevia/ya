'use strict';
/*
 * Preventive maintenance and asset functionality.
 *  - A plan is "every N days" and/or "every N run-hours" (whichever comes first) for a pump, generator, chlorinator…
 *  - Run-hours are cumulative hour-meter readings entered from the field; the average daily use projects when an
 *    hours-based service will fall due.
 *  - When a plan is due (within its lead time) a work order is created once; completing that work order resets the plan.
 *  - Every asset status change is logged, so functionality (% of time providing service), breakdowns and repair times
 *    can be reported — the indicator most WASH programmes track for water points.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const r1 = n => Math.round(n * 10) / 10;
const DAY = 86400e3;
const FUNCTIONAL = new Set(['operational', 'degraded']);

// ---- status log ----
function logStatus(assetId, status, userId, note, at) {
  const last = db.get('SELECT status FROM asset_status_log WHERE asset_id=? ORDER BY changed_at DESC, id DESC LIMIT 1', assetId);
  if (last && last.status === status) return;
  db.run('INSERT INTO asset_status_log(asset_id, status, changed_at, user_id, note) VALUES (?,?,?,?,?)', assetId, status, at || new Date().toISOString(), userId || null, note || null);
}
/** Make sure every asset has a starting entry (for databases created before status logging). */
function ensureLog() { for (const a of db.all(`SELECT id, status, created_at FROM assets WHERE NOT EXISTS (SELECT 1 FROM asset_status_log l WHERE l.asset_id=assets.id)`)) db.run('INSERT INTO asset_status_log(asset_id, status, changed_at, note) VALUES (?,?,?,?)', a.id, a.status, (a.created_at || '').replace(' ', 'T') + (a.created_at && !a.created_at.endsWith('Z') ? '.000Z' : ''), 'Starting status'); }

// ---- run-hours ----
function hoursOf(assetId) { const r = db.get('SELECT reading, recorded_at FROM run_hours WHERE asset_id=? ORDER BY recorded_at DESC, id DESC LIMIT 1', assetId); return r || null; }
/** Average run-hours per day over the last 90 days (since the last meter reset). */
function rateOf(assetId) {
  const rows = db.all(`SELECT reading, recorded_at, reset FROM run_hours WHERE asset_id=? AND recorded_at >= ? ORDER BY recorded_at, id`, assetId, new Date(Date.now() - 90 * DAY).toISOString());
  let i = rows.map(r => r.reset).lastIndexOf(1); const seg = rows.slice(Math.max(0, i));
  if (seg.length < 2) return null;
  const a = seg[0], b = seg[seg.length - 1]; const days = (Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / DAY;
  return days >= 1 ? r1((b.reading - a.reading) / days) : null;
}
function addHours(ctx, assetId, b) {
  if (!db.get('SELECT 1 FROM assets WHERE id=?', assetId)) throw new HttpError(404, 'Asset not found');
  const at = b.recorded_at || new Date().toISOString(); if (at > new Date(Date.now() + 5 * 60e3).toISOString()) throw new HttpError(400, 'Time is in the future');
  const prev = db.get('SELECT reading FROM run_hours WHERE asset_id=? AND recorded_at <= ? ORDER BY recorded_at DESC, id DESC LIMIT 1', assetId, at);
  if (prev && b.reading < prev.reading && !b.reset) throw new HttpError(400, `Lower than the last reading (${prev.reading} h). If the hour meter was replaced or reset, tick "meter reset" and say why.`);
  if (b.reset && !(b.note && b.note.length >= 5)) throw new HttpError(400, 'Say why the hour meter was reset or replaced');
  const r = db.run('INSERT INTO run_hours(asset_id, reading, recorded_at, user_id, note, reset) VALUES (?,?,?,?,?,?)', assetId, b.reading, at, ctx.user.id, b.note || null, b.reset ? 1 : 0);
  if (b.reset) for (const p of db.all('SELECT id FROM maint_plans WHERE asset_id=? AND interval_hours IS NOT NULL', assetId)) db.run('UPDATE maint_plans SET last_done_hours=? WHERE id=? AND (last_done_hours IS NULL OR last_done_hours > ?)', b.reading, p.id, b.reading);
  audit.log(ctx, 'asset.run_hours', 'asset', assetId, b);
  return { id: r.id, rate_per_day: rateOf(assetId) };
}

// ---- plans ----
function savePlan(ctx, id, b) {
  if (!b.interval_days && !b.interval_hours) throw new HttpError(400, 'Give an interval in days, in run-hours, or both');
  if (!db.get('SELECT 1 FROM assets WHERE id=?', b.asset_id)) throw new HttpError(400, 'Unknown asset');
  const f = [b.asset_id, b.title, b.tasks || null, b.interval_days || null, b.interval_hours || null, b.lead_days ?? 7, b.priority || 'medium', b.last_done_at || null, b.last_done_hours ?? null, b.active === false ? 0 : 1];
  if (id) { if (!db.get('SELECT 1 FROM maint_plans WHERE id=?', id)) throw new HttpError(404, 'Not found'); db.run('UPDATE maint_plans SET asset_id=?, title=?, tasks=?, interval_days=?, interval_hours=?, lead_days=?, priority=?, last_done_at=?, last_done_hours=?, active=? WHERE id=?', ...f, id); }
  else id = db.run('INSERT INTO maint_plans(asset_id, title, tasks, interval_days, interval_hours, lead_days, priority, last_done_at, last_done_hours, active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)', ...f, ctx.user.id).id;
  audit.log(ctx, 'maintenance.plan', 'maint_plan', id, b); return { id };
}
/** Due status: by date and/or by hours, whichever is sooner. */
function status(p) {
  const now = Date.now(); const out = { reasons: [] };
  const lastAt = p.last_done_at ? Date.parse(p.last_done_at) : null;
  let dueAt = null;
  if (p.interval_days) { dueAt = lastAt != null ? lastAt + p.interval_days * DAY : now; out.reasons.push(lastAt != null ? `every ${p.interval_days} days` : 'never serviced — due now'); }
  const h = hoursOf(p.asset_id); const rate = p.interval_hours ? rateOf(p.asset_id) : null;
  if (p.interval_hours) {
    out.current_hours = h ? h.reading : null; out.rate_per_day = rate;
    if (h && p.last_done_hours != null) {
      out.hours_left = r1(p.last_done_hours + p.interval_hours - h.reading);
      const byHours = out.hours_left <= 0 ? now : rate ? now + (out.hours_left / rate) * DAY : null;
      if (byHours != null && (dueAt == null || byHours < dueAt)) dueAt = byHours;
      out.reasons.push(`every ${p.interval_hours} run-hours (${out.hours_left} h left${rate ? `, ≈${rate} h/day` : ''})`);
    } else out.reasons.push(h ? 'set the run-hours at the last service' : 'no run-hours recorded yet');
  }
  out.due_at = dueAt == null ? null : new Date(dueAt).toISOString();
  out.days_left = dueAt == null ? null : Math.floor((dueAt - now) / DAY);
  out.state = dueAt == null ? 'unknown' : dueAt <= now ? 'overdue' : out.days_left <= p.lead_days ? 'due_soon' : 'ok';
  out.open_wo = db.get(`SELECT id, wo_number, status FROM work_orders WHERE maint_plan_id=? AND status NOT IN ('completed','cancelled') ORDER BY id DESC LIMIT 1`, p.id) || null;
  return out;
}
function plans({ asset_id } = {}) {
  return db.all(`SELECT p.*, s.name asset_name, s.code asset_code, s.asset_type, s.status asset_status, a.name area_name FROM maint_plans p JOIN assets s ON s.id=p.asset_id LEFT JOIN service_areas a ON a.id=s.area_id
    WHERE 1=1 ${asset_id ? 'AND p.asset_id=?' : ''} ORDER BY p.active DESC, s.name, p.title`, ...(asset_id ? [asset_id] : [])).map(p => ({ ...p, due: status(p) }));
}
/** Create one work order for each active plan that is overdue or due within its lead time. */
function runDue(ctx = {}) {
  const made = [];
  for (const p of plans().filter(x => x.active && ['overdue', 'due_soon'].includes(x.due.state) && !x.due.open_wo)) {
    const a = db.get('SELECT * FROM assets WHERE id=?', p.asset_id);
    const num = require('./billing').nextNumber('wo', n => 'WO-' + n);
    const wo = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, asset_id, area_id, lat, lng, status, due_date, created_by, maint_plan_id) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?)`, num, 'inspection', p.priority,
      `Service: ${p.title} — ${a.name}`, `Preventive maintenance (${p.due.reasons.join('; ')}).${p.tasks ? '\nTasks: ' + p.tasks : ''}\nRecord the hour-meter reading when done.`, a.id, a.area_id, a.lat, a.lng,
      p.due.due_at ? p.due.due_at.slice(0, 10) : null, ctx.user ? ctx.user.id : null, p.id).id;
    db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', wo, ctx.user ? ctx.user.id : null, 'open', 'Created by the preventive maintenance schedule');
    made.push({ plan_id: p.id, wo_number: num });
  }
  if (made.length) audit.log({ ...ctx, actor: ctx.user ? undefined : 'scheduler' }, 'maintenance.run', 'maint_plan', null, { created: made.length });
  db.run(`INSERT INTO settings(key,value) VALUES('last_maint_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, new Date().toISOString());
  return { created: made };
}
/** Called when a work order is completed: a maintenance work order resets its plan. */
function onWorkOrderCompleted(wo) {
  if (!wo.maint_plan_id) return;
  const p = db.get('SELECT * FROM maint_plans WHERE id=?', wo.maint_plan_id); if (!p) return;
  const h = hoursOf(p.asset_id);
  db.run('UPDATE maint_plans SET last_done_at=?, last_done_hours=COALESCE(?, last_done_hours) WHERE id=?', new Date().toISOString(), h ? h.reading : null, p.id);
}

// ---- functionality ----
/** % of time each asset was functional between two dates, number of breakdowns and median time to restore. */
function functionality({ from, to, area_id, asset_type } = {}) {
  ensureLog();
  const t0 = Date.parse(from + 'T00:00:00Z'), t1 = Math.min(Date.parse(to + 'T23:59:59Z'), Date.now());
  const assets = db.all(`SELECT s.*, a.name area_name FROM assets s LEFT JOIN service_areas a ON a.id=s.area_id WHERE s.status != 'decommissioned' AND s.asset_type IN ('water_point','pump','source','treatment','reservoir') ${area_id ? 'AND s.area_id=?' : ''} ${asset_type ? 'AND s.asset_type=?' : ''} ORDER BY s.asset_type, s.name`, ...[area_id, asset_type].filter(Boolean));
  const rows = assets.map(s => {
    const log = db.all('SELECT status, changed_at FROM asset_status_log WHERE asset_id=? ORDER BY changed_at, id', s.id);
    let cur = null; for (const e of log) if (Date.parse(e.changed_at) <= t0) cur = e.status;
    if (cur == null && log[0]) cur = null; // asset did not exist yet
    let t = t0, up = 0, total = 0, breakdowns = 0; const repairs = []; let downSince = cur && !FUNCTIONAL.has(cur) ? t0 : null;
    for (const e of log.filter(x => Date.parse(x.changed_at) > t0 && Date.parse(x.changed_at) <= t1)) {
      const et = Date.parse(e.changed_at); if (cur != null) { total += et - t; if (FUNCTIONAL.has(cur)) up += et - t; }
      if (cur && FUNCTIONAL.has(cur) && !FUNCTIONAL.has(e.status)) { breakdowns += e.status === 'down' ? 1 : 0; downSince = et; }
      if (cur && !FUNCTIONAL.has(cur) && FUNCTIONAL.has(e.status) && downSince != null) { repairs.push((et - downSince) / 3600e3); downSince = null; }
      cur = e.status; t = et;
    }
    if (cur != null) { total += t1 - t; if (FUNCTIONAL.has(cur)) up += t1 - t; }
    const med = repairs.length ? repairs.sort((a, b) => a - b)[Math.floor(repairs.length / 2)] : null;
    return { asset_id: s.id, code: s.code, name: s.name, asset_type: s.asset_type, area: s.area_name, status: s.status, functional_pct: total ? r1(up / total * 100) : null,
      downtime_hours: r1((total - up) / 3600e3), breakdowns, median_repair_hours: med == null ? null : r1(med), down_since: downSince && !FUNCTIONAL.has(s.status) ? new Date(downSince).toISOString() : null };
  });
  const wps = rows.filter(r => r.asset_type === 'water_point');
  return { from, to, rows,
    summary: { water_points: wps.length, functional_now: wps.filter(r => FUNCTIONAL.has(r.status)).length, functional_now_pct: wps.length ? r1(wps.filter(r => FUNCTIONAL.has(r.status)).length / wps.length * 100) : null,
      avg_functional_pct: wps.filter(r => r.functional_pct != null).length ? r1(wps.filter(r => r.functional_pct != null).reduce((a, r) => a + r.functional_pct, 0) / wps.filter(r => r.functional_pct != null).length) : null,
      breakdowns: rows.reduce((a, r) => a + r.breakdowns, 0) } };
}

module.exports = { logStatus, ensureLog, hoursOf, rateOf, addHours, savePlan, status, plans, runDue, onWorkOrderCompleted, functionality, FUNCTIONAL };
