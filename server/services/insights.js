'use strict';
/*
 * Water-loss intelligence (IWA-style water balance), revenue-protection scoring, and aggregate public statistics.
 * Assumption-based components (unbilled authorised use, apparent losses) use percentages set by the administrator
 * and are always labelled as estimates.
 */
const crypto = require('crypto');
const db = require('../lib/db');
const billing = require('./billing');

const r2 = n => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const days = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400e3) + 1);

function waterBalance({ from, to, area_id }) {
  const areas = db.all(`SELECT * FROM service_areas ${area_id ? 'WHERE id=?' : ''} ORDER BY name`, ...(area_id ? [area_id] : []));
  const pUA = db.settingNum('unbilled_authorized_pct', 1) / 100, pMeter = db.settingNum('meter_under_registration_pct', 3) / 100, pUnauth = db.settingNum('unauthorized_consumption_pct', 1) / 100;
  return areas.map(a => {
    const sup = db.get(`SELECT SUM(volume_m3) v, GROUP_CONCAT(DISTINCT source) src, MIN(period_start) ps, MAX(period_end) pe FROM bulk_supply WHERE area_id=? AND period_start>=? AND period_end<=?`, a.id, from, to);
    const ps = sup.ps || from, pe = sup.pe || to;
    const bl = db.get(`SELECT SUM(CASE WHEN b.is_estimated=0 THEN b.consumption ELSE 0 END) metered, SUM(CASE WHEN b.is_estimated=1 THEN b.consumption ELSE 0 END) est, SUM(b.total) amount, COUNT(*) n, SUM(b.is_estimated) nest
      FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.status!='cancelled' AND b.period_start>=? AND b.period_end<=?`, a.id, ps, pe);
    const conns = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') WHERE c.area_id=? AND c.status='active'`, a.id).n;
    const metered = bl.metered || 0, est = bl.est || 0, billed = metered + est;
    const row = { area_id: a.id, area: a.name, currency: a.currency, from: ps, to: pe, connections: conns, billed_metered_m3: r2(metered), billed_estimated_m3: r2(est), bills: bl.n, supply_sources: sup.src };
    if (sup.v == null) return { ...row, status: 'no_supply_data', note: 'No bulk/district supply volume recorded — water balance cannot be computed. Record supply under Network › Bulk supply.' };
    const siv = sup.v;
    const unbilledAuth = siv * pUA;
    const authorized = billed + unbilledAuth;
    const losses = Math.max(0, siv - authorized);
    const apparent = Math.min(losses, metered * pMeter + siv * pUnauth);
    const real = losses - apparent;
    const nrw = siv - billed;
    const revPerM3 = billed ? (bl.amount || 0) / billed : null;
    const d = days(ps, pe);
    const estShare = billed ? est / billed : 0;
    const reasons = [];
    let grade = 'A';
    if ((sup.src || '').includes('estimate')) { grade = 'C'; reasons.push('supply volume is estimated'); }
    if ((sup.src || '').includes('simulator')) { grade = 'C'; reasons.push('supply data is simulated'); }
    if (estShare > 0.2) { grade = 'C'; reasons.push(`${Math.round(estShare * 100)}% of billed volume is estimated`); } else if (estShare > 0.05) { if (grade === 'A') grade = 'B'; reasons.push(`${Math.round(estShare * 100)}% of billed volume is estimated`); }
    if (siv < billed) { grade = 'C'; reasons.push('billed volume exceeds supply — check bulk meter or period alignment'); }
    return { ...row, status: 'ok', system_input_m3: r2(siv), unbilled_authorized_m3: r2(unbilledAuth), authorized_m3: r2(authorized), water_losses_m3: r2(losses),
      apparent_losses_m3: r2(apparent), real_losses_m3: r2(real), nrw_m3: r2(nrw), nrw_pct: r2(nrw / siv * 100),
      real_losses_l_per_conn_day: conns ? r2(real * 1000 / conns / d) : null, nrw_value: revPerM3 != null ? r2(nrw * revPerM3) : null, revenue_per_m3: r2(revPerM3),
      days: d, grade, grade_reasons: reasons.length ? reasons : ['supply measured by bulk/district meter; billed volume from actual readings'],
      assumptions: { unbilled_authorized_pct: pUA * 100, meter_under_registration_pct: pMeter * 100, unauthorized_consumption_pct: pUnauth * 100 } };
  }).sort((x, y) => (y.nrw_pct ?? -1) - (x.nrw_pct ?? -1));
}

/** Revenue-protection list: accounts whose patterns suggest meter failure, bypass, tampering or under-billing. */
function suspiciousAccounts({ area_id, limit = 50 }) {
  const since = new Date(Date.now() - 200 * 86400e3).toISOString().slice(0, 10);
  const custs = db.all(`SELECT c.id, c.customer_number, c.name, c.customer_type, c.area_id, a.name area_name, c.lat, c.lng, m.id meter_id, m.serial_number, m.status meter_status, m.install_date
    FROM customers c JOIN service_areas a ON a.id=c.area_id JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') WHERE c.status='active' ${area_id ? 'AND c.area_id=?' : ''}`, ...(area_id ? [area_id] : []));
  const billsBy = {}; for (const b of db.all(`SELECT customer_id, consumption, is_estimated, period_end FROM bills WHERE status!='cancelled' AND period_end >= ? ORDER BY period_end`, since)) (billsBy[b.customer_id] = billsBy[b.customer_id] || []).push(b);
  const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const peers = {};
  for (const c of custs) { const bs = billsBy[c.id] || []; if (bs.length >= 3) (peers[c.customer_type + ':' + c.area_id] = peers[c.customer_type + ':' + c.area_id] || []).push(avg(bs.map(b => b.consumption))); }
  const out = [];
  for (const c of custs) {
    const bs = billsBy[c.id] || []; const reasons = []; let score = 0;
    const cons = bs.map(b => b.consumption);
    if (cons.length >= 2 && cons.slice(-2).every(x => x === 0)) { score += 30; reasons.push('Zero consumption on the last 2 bills'); }
    if (cons.length >= 4) { const last = cons[cons.length - 1], prev = avg(cons.slice(-4, -1)); if (prev > 3 && last < prev * 0.4) { score += 25; reasons.push(`Last bill ${last} m³ vs ${prev.toFixed(1)} m³ average (−${Math.round((1 - last / prev) * 100)}%)`); } }
    const med = median(peers[c.customer_type + ':' + c.area_id] || []);
    if (med && cons.length >= 3 && (peers[c.customer_type + ':' + c.area_id] || []).length >= 5 && avg(cons) < med * 0.25) { score += 20; reasons.push(`Uses ${avg(cons).toFixed(1)} m³/bill vs ${med.toFixed(1)} m³ median for similar ${c.customer_type.replace(/_/g, ' ')} accounts`); }
    const est = bs.filter(b => b.is_estimated).length; if (est >= 2) { score += 15; reasons.push(`${est} estimated bills recently`); }
    const evs = db.get(`SELECT COUNT(*) n FROM readings WHERE meter_id=? AND reading_at>=? AND (events_json LIKE '%tamper%' OR events_json LIKE '%reverse_flow%')`, c.meter_id, since).n;
    if (evs) { score += 40; reasons.push(`Meter reported tamper/reverse flow (${evs}×)`); }
    const dec = db.get(`SELECT COUNT(*) n FROM readings WHERE meter_id=? AND reading_at>=? AND flags_json LIKE '%decreasing%' AND status!='rejected'`, c.meter_id, since).n;
    if (dec) { score += Math.min(30, dec * 15); reasons.push(`${dec} reading(s) lower than the previous one`); }
    if (c.meter_status === 'faulty') { score += 20; reasons.push('Meter marked faulty'); }
    const open = db.get(`SELECT wo_number FROM work_orders WHERE customer_id=? AND status NOT IN ('completed','cancelled') AND type IN ('meter','inspection','leak') LIMIT 1`, c.id);
    if (score >= 20) out.push({ customer_id: c.id, customer_number: c.customer_number, name: c.name, customer_type: c.customer_type, area_id: c.area_id, area_name: c.area_name, meter_id: c.meter_id,
      serial_number: c.serial_number, score, reasons, recent_avg_m3: r2(avg(cons)), open_work_order: open ? open.wo_number : null, lat: c.lat, lng: c.lng });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------- Public / donor transparency ----------------
const sup = n => (n == null ? null : n > 0 && n < 5 ? '<5' : n); // small-number suppression for counts
function newToken() { const t = crypto.randomBytes(18).toString('base64url'); return { token: t, hash: crypto.createHash('sha256').update(t).digest('hex') }; }
function linkByToken(t) { return db.get(`SELECT * FROM share_links WHERE token_hash=? AND active=1`, crypto.createHash('sha256').update(String(t || '')).digest('hex')); }

function publicStats(link) {
  const ids = link.area_ids ? JSON.parse(link.area_ids) : null;
  const areaFilter = col => (ids && ids.length ? ` AND ${col} IN (${ids.map(Number).join(',')})` : '');
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - link.months * 30.4 * 86400e3).toISOString().slice(0, 10);
  const areas = db.all(`SELECT id, name, currency FROM service_areas WHERE active=1 ${areaFilter('id')} ORDER BY name`);
  const byType = db.all(`SELECT customer_type t, COUNT(*) n FROM customers WHERE status='active' ${areaFilter('area_id')} GROUP BY customer_type`).map(r => ({ type: r.t, n: sup(r.n) }));
  const active = db.get(`SELECT COUNT(*) n FROM customers WHERE status='active' ${areaFilter('area_id')}`).n;
  const metered = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') WHERE c.status='active' ${areaFilter('c.area_id')}`).n;
  const wpAll = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status='operational' THEN 1 ELSE 0 END) ok FROM assets WHERE asset_type='water_point' AND status!='decommissioned' ${areaFilter('area_id')}`);
  const billed = db.all(`SELECT b.currency, SUM(b.total) amt, SUM(b.consumption) m3, SUM(CASE WHEN b.is_estimated=1 THEN b.consumption ELSE 0 END) est FROM bills b JOIN customers c ON c.id=b.customer_id
    WHERE b.status!='cancelled' AND b.period_end BETWEEN ? AND ? ${areaFilter('c.area_id')} GROUP BY b.currency`, from, to);
  const paid = db.all(`SELECT p.currency, SUM(p.amount) amt FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.received_at BETWEEN ? AND ? ${areaFilter('c.area_id')} GROUP BY p.currency`, from, to + 'T23:59:59Z');
  const collection = billed.map(b => { const p = paid.find(x => x.currency === b.currency); return { currency: b.currency, efficiency_pct: b.amt ? r2((p ? p.amt : 0) / b.amt * 100) : null }; });
  const wb = waterBalance({ from, to }).filter(r => !ids || ids.includes(r.area_id));
  const withSupply = wb.filter(r => r.status === 'ok');
  const siv = withSupply.reduce((s, r) => s + r.system_input_m3, 0), nrw = withSupply.reduce((s, r) => s + r.nrw_m3, 0);
  const wos = db.all(`SELECT created_at, completed_at FROM work_orders WHERE status='completed' AND completed_at >= ? ${areaFilter('area_id')}`, from);
  const hrs = wos.map(w => (Date.parse(w.completed_at) - Date.parse(w.created_at.replace(' ', 'T') + (w.created_at.includes('T') ? '' : 'Z'))) / 3600e3).filter(h => h >= 0).sort((a, b) => a - b);
  const leaks = db.get(`SELECT COUNT(*) n, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) r FROM alerts WHERE rule_type IN ('continuous_flow','suspected_leak','customer_report') AND detected_at >= ? ${areaFilter('area_id')}`, from);
  const wpSales = db.get(`SELECT COALESCE(SUM(t.liters),0) l, COUNT(CASE WHEN t.type='sale' THEN 1 END) n FROM wp_transactions t JOIN assets s ON s.id=t.asset_id WHERE t.type IN ('sale','reversal') AND t.captured_at >= ? ${areaFilter('s.area_id')}`, from);
  const cycleFrom = new Date(Date.now() - 31 * 86400e3).toISOString();
  const read = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') JOIN readings r ON r.meter_id=m.id AND r.status!='rejected' AND r.reading_at>=? WHERE c.status='active' ${areaFilter('c.area_id')}`, cycleFrom).n;
  const trend = db.all(`SELECT substr(b.period_end,1,7) month, SUM(b.consumption) m3 FROM bills b JOIN customers c ON c.id=b.customer_id WHERE b.status!='cancelled' AND b.period_end BETWEEN ? AND ? ${areaFilter('c.area_id')} GROUP BY month ORDER BY month`, from, to);
  const supplyTrend = db.all(`SELECT substr(period_end,1,7) month, SUM(volume_m3) m3 FROM bulk_supply WHERE period_end BETWEEN ? AND ? ${areaFilter('area_id')} GROUP BY month ORDER BY month`, from, to);
  return {
    title: link.title, org_name: db.setting('org_name'), mode: db.MODE, generated_at: new Date().toISOString(), period: { from, to, months: link.months }, areas: areas.map(a => a.name),
    connections: { active: sup(active), metered_pct: active ? r2(metered / active * 100) : null, by_type: byType },
    water_points: { total: sup(wpAll.n || 0), functional_pct: wpAll.n ? r2((wpAll.ok || 0) / wpAll.n * 100) : null, liters_sold_pay_as_you_fetch: r2(wpSales.l), sales: sup(wpSales.n) },
    volumes: { billed_m3: r2(billed.reduce((s, b) => s + (b.m3 || 0), 0)), estimated_share_pct: (() => { const t = billed.reduce((s, b) => s + (b.m3 || 0), 0); return t ? r2(billed.reduce((s, b) => s + (b.est || 0), 0) / t * 100) : null; })(),
      supply_m3: withSupply.length ? r2(siv) : null, nrw_pct: siv ? r2(nrw / siv * 100) : null, areas_with_supply_data: withSupply.length, areas_total: wb.length,
      nrw_by_area: wb.map(r => ({ area: r.area, nrw_pct: r.nrw_pct ?? null, grade: r.grade || null, status: r.status })) },
    collection, reading_completion_pct: metered ? r2(read / metered * 100) : null,
    service: { work_orders_completed: sup(wos.length), median_hours_to_complete: hrs.length ? r2(hrs[Math.floor(hrs.length / 2)]) : null, leak_reports: sup(leaks.n || 0), leak_reports_resolved: sup(leaks.r || 0) },
    trend: trend.map(t => ({ month: t.month, billed_m3: r2(t.m3), supply_m3: r2((supplyTrend.find(s => s.month === t.month) || {}).m3 ?? null) })),
    notes: ['Aggregated figures only. No names, account numbers, addresses or individual readings are published.', 'Counts below 5 are shown as "<5".',
      'Non-revenue water is shown only where bulk/district supply volumes are recorded; the data grade (A best – C weakest) explains reliability.', ...(db.MODE === 'demo' ? ['DEMO: all figures come from fictional demo data.'] : [])]
  };
}

module.exports = { waterBalance, suspiciousAccounts, publicStats, newToken, linkByToken };
