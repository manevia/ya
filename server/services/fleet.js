'use strict';
/*
 * Meter replacement planner.
 * Mechanical meters slowly under-read as they wear, so every m³ they miss is water the utility produced but never billed.
 * For each installed customer meter we estimate under-registration from age and the volume it has measured
 * (rates are Settings you can tune from your own bench tests), turn it into revenue lost per year at the
 * customer's own consumption charge, and rank replacements by payback time. All figures are ESTIMATES.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const S = k => db.settingNum(k, 0);

function settings() {
  return { wear: S('meter_wear_pct_per_year'), start: S('meter_wear_start_years'), life: S('meter_life_years'), lifeVol: S('meter_life_volume_m3'), maxUR: S('meter_max_under_registration_pct') || 20,
    meterUsd: Number(db.setting('connection_meter_cost', '')) || null, labourUsd: Number(db.setting('meter_replacement_labour_usd', '')) || 0 };
}

function analyse({ area_id } = {}) {
  const st = settings(); const today = Date.now(); const billing = require('./billing');
  const since = new Date(today - 365 * 86400e3).toISOString().slice(0, 10);
  const meters = db.all(`SELECT m.*, c.name customer_name, c.customer_number, c.customer_type, c.area_id c_area, a.name area_name, a.currency,
      (SELECT id FROM work_orders w WHERE w.meter_id=m.id AND w.type='meter' AND w.status NOT IN ('completed','cancelled') LIMIT 1) open_wo
    FROM meters m JOIN customers c ON c.id=m.customer_id JOIN service_areas a ON a.id=c.area_id
    WHERE m.status IN ('active','faulty') AND m.is_bulk=0 AND c.status IN ('active','suspended') ${area_id ? 'AND c.area_id=?' : ''}`, ...(area_id ? [area_id] : []));
  const fx = {}; const rate = cur => { if (cur === 'USD') return 1; if (!(cur in fx)) { const r = billing.findRate('USD', cur, new Date().toISOString().slice(0, 10)); fx[cur] = r ? r.rate : null; } return fx[cur]; };
  const rows = meters.map(m => {
    const reasons = [];
    const age = m.install_date ? (today - Date.parse(m.install_date)) / (365.25 * 86400e3) : null;
    const throughput = Math.max(0, m.last_reading_value ?? m.initial_reading ?? 0); // the register counts the meter's lifetime volume (meters leave the factory at zero)
    const b = db.get(`SELECT COUNT(*) n, SUM(b.consumption) m3, MIN(b.period_start) first, MAX(b.period_end) last FROM bills b WHERE b.customer_id=? AND b.meter_id=? AND b.status!='cancelled' AND b.period_end >= ?`, m.customer_id, m.id, since);
    const vol = db.get(`SELECT SUM(l.amount) amt FROM bill_lines l JOIN bills b ON b.id=l.bill_id WHERE b.customer_id=? AND b.status!='cancelled' AND b.period_end >= ? AND l.line_type='consumption'`, m.customer_id, since).amt || 0;
    const months = b.n ? Math.max(1, Math.round((Date.parse(b.last) - Date.parse(b.first)) / (30.44 * 86400e3))) : 0;
    const annualM3 = months ? (b.m3 || 0) / months * 12 : null;
    const pricePerM3 = b.m3 > 0 ? vol / b.m3 : null;
    // under-registration estimate
    const typeFactor = ['mechanical', 'prepaid'].includes(m.meter_type) ? 1 : 0.25; // static meters wear far less
    let ur = 0;
    if (age != null && age > st.start) ur += st.wear * (age - st.start) * typeFactor;
    if (st.lifeVol > 0 && throughput > st.lifeVol) { ur += 3 * typeFactor; reasons.push(`Measured ${Math.round(throughput)} m³ — beyond the ${st.lifeVol} m³ design volume`); }
    ur = Math.min(st.maxUR, r2(ur));
    if (age == null) reasons.push('Installation date unknown — record it to estimate wear');
    else if (st.life && age >= st.life) reasons.push(`${age.toFixed(1)} years old (design life ${st.life})`);
    else if (age > st.start && typeFactor === 1) reasons.push(`${age.toFixed(1)} years old — wear expected`);
    if (m.status === 'faulty') reasons.unshift('Marked FAULTY — readings cannot be trusted');
    const recent = db.all(`SELECT consumption FROM bills WHERE customer_id=? AND meter_id=? AND status!='cancelled' ORDER BY period_end DESC LIMIT 9`, m.customer_id, m.id).map(x => x.consumption);
    if (recent.length >= 6) { const a3 = (recent[0] + recent[1] + recent[2]) / 3, p = recent.slice(3).reduce((s, x) => s + x, 0) / (recent.length - 3); if (p > 2 && a3 < p * 0.6) reasons.push(`Use fell ${Math.round((1 - a3 / p) * 100)}% recently — check for a stuck or slowing meter`); }
    const lostM3 = annualM3 != null && ur > 0 ? annualM3 * ur / (100 - ur) : 0;
    const lostYear = pricePerM3 != null ? r2(lostM3 * pricePerM3) : null;
    const fxr = rate(m.currency);
    const cost = st.meterUsd && fxr ? r2((st.meterUsd + st.labourUsd) * fxr) : null;
    const payback = cost != null && lostYear > 0 ? r2(cost / (lostYear / 12)) : null;
    const old = st.life && age != null && age >= st.life;
    const priority = m.status === 'faulty' ? 'replace_now' : (payback != null && payback <= 24) || (old && (payback == null ? cost == null : payback <= 60)) ? 'replace' : old || ur >= 3 || reasons.some(r => /fell/.test(r)) ? 'test' : 'ok';
    return { meter_id: m.id, serial_number: m.serial_number, meter_type: m.meter_type, size_mm: m.size_mm, status: m.status, install_date: m.install_date, age_years: age == null ? null : r2(age), throughput_m3: r2(throughput),
      customer_id: m.customer_id, customer_name: m.customer_name, customer_number: m.customer_number, area: m.area_name, currency: m.currency, annual_m3: annualM3 == null ? null : r2(annualM3),
      under_registration_pct: ur, lost_m3_year: r2(lostM3), lost_revenue_year: lostYear, replacement_cost: cost, payback_months: payback, priority, reasons, open_wo: m.open_wo };
  });
  const rank = { replace_now: 0, replace: 1, test: 2, ok: 3 };
  rows.sort((a, b) => rank[a.priority] - rank[b.priority] || (a.payback_months ?? 1e9) - (b.payback_months ?? 1e9) || (b.lost_revenue_year || 0) - (a.lost_revenue_year || 0));
  const byCur = {}; for (const r of rows) if (r.lost_revenue_year) byCur[r.currency] = r2((byCur[r.currency] || 0) + r.lost_revenue_year);
  const aged = rows.filter(r => r.age_years != null);
  return { settings: st, cost_note: st.meterUsd ? null : 'Set the meter cost (Settings › New connections › Meter and box) to calculate payback',
    summary: { meters: rows.length, replace_now: rows.filter(r => r.priority === 'replace_now').length, replace: rows.filter(r => r.priority === 'replace').length, test: rows.filter(r => r.priority === 'test').length,
      unknown_age: rows.length - aged.length, avg_age: aged.length ? r2(aged.reduce((s, r) => s + r.age_years, 0) / aged.length) : null, lost_revenue_year: byCur }, rows };
}

function plan(ctx, meterId, note) {
  const r = analyse().rows.find(x => x.meter_id === meterId); if (!r) throw new HttpError(404, 'Meter not found or not installed');
  if (r.open_wo) throw new HttpError(409, 'A meter work order is already open for this meter');
  const m = db.get('SELECT m.*, c.area_id, c.lat, c.lng FROM meters m JOIN customers c ON c.id=m.customer_id WHERE m.id=?', meterId);
  const num = require('./billing').nextNumber('wo', n => 'WO-' + n);
  const wo = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, customer_id, meter_id, area_id, lat, lng, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,'open',?)`, num, 'meter',
    r.priority === 'replace_now' ? 'high' : 'medium', `Replace meter ${r.serial_number} — ${r.customer_name}`,
    `Replacement planner: ${r.reasons.join('; ') || 'scheduled replacement'}. Estimated under-registration ${r.under_registration_pct}%${r.lost_revenue_year ? `, ≈${r.lost_revenue_year} ${r.currency}/year unbilled` : ''}${r.payback_months ? `, payback ≈${r.payback_months} months` : ''}. Record the old meter's final reading and the new meter's serial and initial reading.${note ? ' ' + note : ''}`,
    r.customer_id, meterId, m.area_id, m.lat, m.lng, ctx.user.id).id;
  db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', wo, ctx.user.id, 'open', 'Created by the meter replacement planner');
  audit.log(ctx, 'meter.replacement_planned', 'meter', meterId, { wo: num, priority: r.priority, ur: r.under_registration_pct });
  return { id: wo, wo_number: num };
}

module.exports = { analyse, plan };
