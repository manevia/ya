'use strict';
/*
 * Pumping energy. Energy (diesel, petrol, grid or solar electricity) is usually the largest running cost of a water
 * system, and a pump that needs more fuel for the same water is wearing out or fighting a leak or a falling water table.
 * Staff record, per pump and period: fuel or kWh used, what it cost, the water pumped and (optionally) the hours run.
 * The system works out energy and cost per m3, fuel per hour and output per hour, compares the latest period with the
 * pump's own earlier periods, and raises an alert when it has become clearly less efficient.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const UNIT = { diesel: 'L', petrol: 'L', grid: 'kWh', solar: 'kWh' };
const r2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const r3 = n => (n == null || !isFinite(n) ? null : Math.round(n * 1000) / 1000);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const PUMPING = ['pump', 'source', 'treatment'];

/** Hours run in a period from the asset's hour-meter readings, when both ends are known and the meter was not reset. */
function hoursFromMeter(assetId, from, to) {
  const a = db.get('SELECT reading FROM run_hours WHERE asset_id=? AND recorded_at <= ? ORDER BY recorded_at DESC, id DESC LIMIT 1', assetId, from + 'T23:59:59.999Z');
  const b = db.get('SELECT reading FROM run_hours WHERE asset_id=? AND recorded_at <= ? ORDER BY recorded_at DESC, id DESC LIMIT 1', assetId, to + 'T23:59:59.999Z');
  if (!a || !b || b.reading <= a.reading) return null;
  if (db.get('SELECT 1 FROM run_hours WHERE asset_id=? AND reset=1 AND recorded_at > ? AND recorded_at <= ?', assetId, from + 'T23:59:59.999Z', to + 'T23:59:59.999Z')) return null;
  return r2(b.reading - a.reading);
}
function metrics(e) {
  const days = Math.round((Date.parse(e.period_end) - Date.parse(e.period_start)) / 86400e3) + 1;
  const v = e.volume_m3 > 0 ? e.volume_m3 : null, h = e.run_hours > 0 ? e.run_hours : null, q = e.quantity > 0 ? e.quantity : null;
  return { ...e, unit: UNIT[e.energy_type], days, per_m3: q && v ? r3(q / v) : null, cost_per_m3: e.cost != null && v ? r3(e.cost / v) : null, per_hour: q && h ? r2(q / h) : null, m3_per_hour: v && h ? r2(v / h) : null, m3_per_day: v ? r2(v / days) : null };
}
/** Compare the latest period with the median of the pump's earlier periods on the same energy type (needs at least 3). */
function trend(rows) {
  const live = rows.filter(r => r.per_m3 != null); if (!live.length) return { state: 'no_data' };
  const last = live[live.length - 1]; const before = live.slice(0, -1).filter(r => r.energy_type === last.energy_type).slice(-6);
  if (before.length < 3) return { state: 'no_baseline', latest: last.per_m3, unit: last.unit };
  const base = median(before.map(r => r.per_m3)); const pct = Math.round((last.per_m3 - base) / base * 1000) / 10; const lim = db.settingNum('energy_alert_pct', 20);
  const out = before.filter(r => r.m3_per_hour != null); const baseOut = out.length >= 3 ? median(out.map(r => r.m3_per_hour)) : null;
  return { state: pct >= lim ? 'worse' : pct <= -10 ? 'better' : 'steady', latest: last.per_m3, baseline: r3(base), change_pct: pct, unit: last.unit, limit_pct: lim,
    output_change_pct: baseOut && last.m3_per_hour != null ? Math.round((last.m3_per_hour - baseOut) / baseOut * 1000) / 10 : null,
    extra_cost: last.cost != null && pct > 0 ? r2(last.cost - last.cost / (1 + pct / 100)) : null, currency: last.currency };
}
const entries = assetId => db.all('SELECT e.*, u.full_name entered_by_name FROM energy_logs e LEFT JOIN users u ON u.id=e.entered_by WHERE e.asset_id=? AND e.voided_at IS NULL ORDER BY e.period_end, e.id', assetId).map(metrics);

function add(ctx, b) {
  return db.tx(() => {
    const s = db.get('SELECT * FROM assets WHERE id=?', b.asset_id); if (!s) throw new HttpError(400, 'Unknown asset');
    if (!PUMPING.includes(s.asset_type)) throw new HttpError(400, 'Energy is recorded against a pump, source or treatment unit');
    if (b.period_end < b.period_start) throw new HttpError(400, 'The period ends before it starts');
    if (b.period_end > new Date(Date.now() + 86400e3).toISOString().slice(0, 10)) throw new HttpError(400, 'The period ends in the future');
    if ((Date.parse(b.period_end) - Date.parse(b.period_start)) / 86400e3 > 100) throw new HttpError(400, 'Record periods of about a month or less');
    const clash = db.get('SELECT period_start, period_end FROM energy_logs WHERE asset_id=? AND voided_at IS NULL AND period_start <= ? AND period_end >= ?', s.id, b.period_end, b.period_start);
    if (clash) throw new HttpError(409, `This pump already has a record for ${clash.period_start} to ${clash.period_end}. Void it first if it is wrong.`);
    if (b.energy_type !== 'solar' && !(b.quantity > 0)) throw new HttpError(400, `Enter the ${UNIT[b.energy_type] === 'L' ? 'litres of fuel' : 'kWh'} used`);
    if (b.cost != null && !b.currency) b.currency = require('../lib/i18n').currencies()[0];
    const hours = b.run_hours ?? hoursFromMeter(s.id, b.period_start, b.period_end);
    const id = db.run('INSERT INTO energy_logs(asset_id, period_start, period_end, energy_type, quantity, cost, currency, volume_m3, run_hours, notes, entered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      s.id, b.period_start, b.period_end, b.energy_type, b.quantity ?? null, b.cost ?? null, b.cost != null ? b.currency : null, b.volume_m3 ?? null, hours, b.notes || null, ctx && ctx.user ? ctx.user.id : null).id;
    audit.log(ctx, 'energy.record', 'asset', s.id, { id, ...b, run_hours: hours });
    const t = trend(entries(s.id)); let alertId = null;
    if (t.state === 'worse' && entries(s.id).slice(-1)[0].id === id) alertId = require('./alerts').raise(ctx, { rule_type: 'energy_efficiency', severity: t.change_pct >= 2 * t.limit_pct ? 'high' : 'medium',
      title: `${s.name} is using ${t.change_pct}% more ${UNIT[b.energy_type] === 'L' ? 'fuel' : 'electricity'} per m³`,
      description: `${t.latest} ${t.unit}/m³ in ${b.period_start} to ${b.period_end}, against a usual ${t.baseline} ${t.unit}/m³.${t.output_change_pct != null ? ` Output per hour changed by ${t.output_change_pct}%.` : ''}${t.extra_cost ? ` About ${t.extra_cost} ${t.currency} extra in this period.` : ''}\nCheck for a worn impeller or bearings, a clogged strainer or filter, a leak on the rising main, a falling water level, or an engine that needs service.`,
      asset_id: s.id, area_id: s.area_id, lat: s.lat, lng: s.lng, source: 'energy', data_basis: 'manual', dedupe_key: `energy-${s.id}-${b.period_end}` });
    return { id, run_hours: hours, trend: t, alert_id: alertId };
  });
}
function voidEntry(ctx, id, reason) {
  const e = db.get('SELECT * FROM energy_logs WHERE id=?', id); if (!e) throw new HttpError(404, 'Not found'); if (e.voided_at) throw new HttpError(409, 'Already voided');
  db.run('UPDATE energy_logs SET voided_at=?, void_reason=?, voided_by=? WHERE id=?', new Date().toISOString(), reason, ctx.user.id, id);
  audit.log(ctx, 'energy.void', 'asset', e.asset_id, { id, reason }); return { ok: true };
}
function report({ from, to, area_id } = {}) {
  const assets = db.all(`SELECT s.id, s.code, s.name, s.asset_type, s.status, s.area_id, a.name area_name FROM assets s LEFT JOIN service_areas a ON a.id=s.area_id
    WHERE s.status != 'decommissioned' AND (s.asset_type='pump' OR EXISTS (SELECT 1 FROM energy_logs e WHERE e.asset_id=s.id AND e.voided_at IS NULL)) ${area_id ? 'AND s.area_id=?' : ''} ORDER BY a.name, s.name`, ...(area_id ? [area_id] : []));
  const rows = assets.map(s => { const all = entries(s.id); const inP = all.filter(e => e.period_end >= from && e.period_start <= to);
    const sum = k => inP.reduce((t, e) => t + (e[k] || 0), 0); const types = [...new Set(inP.map(e => e.energy_type))];
    const cost = {}; for (const e of inP) if (e.cost != null) cost[e.currency] = (cost[e.currency] || 0) + e.cost;
    const costed = inP.filter(e => e.cost != null && e.volume_m3 > 0); const cur = costed.length && costed.every(e => e.currency === costed[0].currency) ? costed[0].currency : null;
    return { ...s, entries: inP, trend: trend(all), types, quantity: types.length === 1 ? r2(sum('quantity')) : null, unit: types.length === 1 ? UNIT[types[0]] : null, volume_m3: r2(sum('volume_m3')), run_hours: r2(sum('run_hours')),
      cost: Object.entries(cost).map(([currency, amount]) => ({ currency, amount: r2(amount) })), cost_per_m3: cur ? r3(costed.reduce((t, e) => t + e.cost, 0) / costed.reduce((t, e) => t + e.volume_m3, 0)) : null, cost_currency: cur,
      per_m3: types.length === 1 && sum('volume_m3') > 0 && sum('quantity') > 0 ? r3(inP.filter(e => e.volume_m3 > 0).reduce((t, e) => t + (e.quantity || 0), 0) / inP.filter(e => e.volume_m3 > 0).reduce((t, e) => t + e.volume_m3, 0)) : null }; });
  const tot = {}; for (const r of rows) for (const c of r.cost) tot[c.currency] = (tot[c.currency] || 0) + c.amount;
  return { from, to, rows, alert_pct: db.settingNum('energy_alert_pct', 20),
    summary: { cost: Object.entries(tot).map(([currency, amount]) => ({ currency, amount: r2(amount) })), volume_m3: r2(rows.reduce((t, r) => t + r.volume_m3, 0)), worse: rows.filter(r => r.trend.state === 'worse').length, no_data: rows.filter(r => !r.entries.length).length } };
}
function briefingItems() {
  const out = []; const since = new Date(Date.now() - 45 * 86400e3).toISOString().slice(0, 10);
  for (const s of db.all('SELECT DISTINCT asset_id FROM energy_logs WHERE voided_at IS NULL AND period_end >= ?', since)) { const all = entries(s.asset_id); const t = trend(all);
    if (t.state === 'worse' && all[all.length - 1].period_end >= since) out.push({ severity: 'high', title: `${db.get('SELECT name FROM assets WHERE id=?', s.asset_id).name}: ${t.change_pct}% more ${t.unit === 'L' ? 'fuel' : 'electricity'} per m³ than usual`, detail: 'Inspect the pump before it fails — worn parts, a blocked strainer or a leak', link: '#/maintenance?tab=energy' }); }
  return out;
}
module.exports = { add, voidEntry, report, entries, trend, metrics, hoursFromMeter, briefingItems, UNIT };
