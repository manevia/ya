'use strict';
/*
 * Cost recovery and utility performance indicators (in the spirit of the IBNET indicator set).
 * Inputs: operating & maintenance (O&M) cost ledger, staff numbers and hours of supply per area/month,
 * plus everything the system already records. Targets are editable; the defaults are indicative only.
 */
const db = require('../lib/db');
const billing = require('./billing');

const r2 = n => (n == null || !Number.isFinite(n) ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const DEFAULT_TARGETS = [['nrw_pct', 25, 'max'], ['metering_pct', 95, 'min'], ['collection_pct', 90, 'min'], ['om_coverage', 1.0, 'min'], ['cash_coverage', 1.0, 'min'],
  ['staff_per_1000', 5, 'max'], ['supply_hours', 20, 'min'], ['wq_compliance_pct', 95, 'min'], ['reading_completion_pct', 95, 'min'], ['complaint_hours', 48, 'max'], ['supply_reliability_pct', 90, 'min'], ['satisfaction_avg', 4, 'min']];
function ensureTargets() { for (const [c, t, d] of DEFAULT_TARGETS) db.run('INSERT OR IGNORE INTO kpi_targets(code, target, direction) VALUES (?,?,?)', c, t, d); }

const LABELS = {
  nrw_pct: ['Non-revenue water', '%', 'Supplied but not billed'], metering_pct: ['Metering level', '%', 'Active accounts with a working meter'],
  collection_pct: ['Collection efficiency', '%', 'Cash collected ÷ amount billed'], om_coverage: ['Operating cost coverage', '×', 'Billed revenue ÷ O&M cost (≥1 means running costs are covered)'],
  cash_coverage: ['Cash cost coverage', '×', 'Cash collected ÷ O&M cost'], unit_cost_produced: ['O&M cost per m³ supplied', 'cur/m³', 'Running cost per cubic metre put into the network'],
  unit_cost_billed: ['O&M cost per m³ billed', 'cur/m³', 'Running cost per cubic metre that earns revenue'], avg_tariff: ['Average revenue per m³ billed', 'cur/m³', 'Billed revenue ÷ billed volume'],
  staff_per_1000: ['Staff per 1,000 connections', '', 'Average staff ÷ active connections × 1,000'], supply_hours: ['Hours of supply per day', 'h', 'Average continuity reported'],
  wq_compliance_pct: ['Water-quality compliance', '%', 'Tests passing the thresholds'], reading_completion_pct: ['Reading completion (last 31 days)', '%', 'Metered accounts read'],
  complaint_hours: ['Median time to resolve complaints', 'h', 'Customer & community reports, from report to resolution'], supply_reliability_pct: ['Supply reliability', '%', 'Scheduled supply hours actually delivered (from the supply log)'], satisfaction_avg: ['Customer satisfaction', '/5', 'Average SMS rating after repairs and resolved reports'],
  connections: ['Active connections', '', ''], new_connections: ['New connections in period', '', 'From the connection pipeline']
};

function monthsBetween(from, to) { const out = []; const d = new Date(from + '-01T00:00:00Z'); const e = new Date(to + '-01T00:00:00Z'); while (d <= e && out.length < 60) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); } return out; }
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function forArea(a, from, to) {
  const months = monthsBetween(from, to); const dFrom = from + '-01'; const dTo = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7), 0)).toISOString().slice(0, 10);
  const cur = a.currency; const notes = [];
  const bl = db.get(`SELECT COALESCE(SUM(b.total),0) amt, COALESCE(SUM(b.consumption),0) m3 FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.status!='cancelled' AND substr(b.period_end,1,7) BETWEEN ? AND ?`, a.id, from, to);
  const col = db.get(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p JOIN customers c ON c.id=p.customer_id WHERE c.area_id=? AND p.currency=? AND substr(p.received_at,1,7) BETWEEN ? AND ?`, a.id, cur, from, to).s;
  let cost = 0, costRows = 0;
  for (const r of db.all(`SELECT currency, SUM(amount) s, COUNT(*) n FROM om_costs WHERE area_id=? AND period BETWEEN ? AND ? GROUP BY currency`, a.id, from, to)) {
    costRows += r.n;
    if (r.currency === cur) cost += r.s;
    else { const rate = billing.findRate(r.currency, cur, dTo); if (rate) { cost += r.s * rate.rate; notes.push(`${r.currency} costs converted at configured rate`); } else notes.push(`${r.currency} costs excluded: no ${r.currency}→${cur} rate`); }
  }
  const sup = db.get(`SELECT SUM(volume_m3) v FROM bulk_supply WHERE area_id=? AND substr(period_end,1,7) BETWEEN ? AND ?`, a.id, from, to).v;
  // Cost per m³ supplied must compare like with like: only the costs of months that also have bulk-supply data.
  const supMonths = db.all(`SELECT DISTINCT substr(period_end,1,7) m FROM bulk_supply WHERE area_id=? AND substr(period_end,1,7) BETWEEN ? AND ?`, a.id, from, to).map(x => x.m);
  const allCost = db.get(`SELECT COALESCE(SUM(amount),0) s FROM om_costs WHERE area_id=? AND period BETWEEN ? AND ?`, a.id, from, to).s;
  const supCost = supMonths.length ? db.get(`SELECT COALESCE(SUM(amount),0) s FROM om_costs WHERE area_id=? AND period IN (${supMonths.map(() => '?').join(',')})`, a.id, ...supMonths).s : 0;
  const costShareSup = allCost ? supCost / allCost : 0;
  if (sup && costShareSup < 0.999 && costShareSup > 0) notes.push(`Cost per m³ supplied uses only the ${supMonths.length} month(s) with bulk-supply data`);
  const active = db.get(`SELECT COUNT(*) n FROM customers WHERE area_id=? AND status='active'`, a.id).n;
  const metered = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') WHERE c.area_id=? AND c.status='active'`, a.id).n;
  const inp = db.get(`SELECT AVG(staff_count) staff, AVG(supply_hours_per_day) hours, COUNT(*) n FROM kpi_inputs WHERE area_id=? AND period BETWEEN ? AND ?`, a.id, from, to);
  const wq = db.get(`SELECT COUNT(*) n, SUM(t.result='pass') p FROM wq_tests t JOIN assets s ON s.id=t.asset_id WHERE s.area_id=? AND substr(t.sampled_at,1,7) BETWEEN ? AND ?`, a.id, from, to);
  const since = new Date(Date.now() - 31 * 86400e3).toISOString();
  const read = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') JOIN readings r ON r.meter_id=m.id AND r.status!='rejected' AND r.reading_at>=? WHERE c.area_id=? AND c.status='active'`, since, a.id).n;
  const res = db.all(`SELECT detected_at, resolved_at FROM alerts WHERE area_id=? AND source IN ('public','customer') AND status='resolved' AND resolved_at IS NOT NULL AND substr(detected_at,1,7) BETWEEN ? AND ?`, a.id, from, to)
    .map(x => (Date.parse(x.resolved_at) - Date.parse(x.detected_at.includes('T') ? x.detected_at : x.detected_at.replace(' ', 'T') + 'Z')) / 3600e3).filter(h => h >= 0);
  const wb = require('./insights').waterBalance({ from: dFrom, to: dTo, area_id: a.id })[0];
  const newConn = db.get(`SELECT COUNT(*) n FROM connection_requests WHERE area_id=? AND status='connected' AND substr(COALESCE(updated_at, created_at),1,7) BETWEEN ? AND ?`, a.id, from, to).n;
  if (!costRows) notes.push('No O&M costs recorded for this period — cost indicators unavailable');
  const sl = require('./supply').reliability({ from: dFrom, to: dTo, area_id: a.id })[0];
  const fbk = db.get(`SELECT COUNT(score) n, AVG(score) s FROM feedback_requests WHERE area_id=? AND substr(sent_at,1,7) BETWEEN ? AND ?`, a.id, from, to);
  if (!inp.n && !(sl && sl.logged)) notes.push('Staff numbers / hours of supply not entered');
  if (sl && sl.logged) notes.push(`Hours of supply from the supply log (${sl.logged} entries)`);
  const v = {
    connections: active, new_connections: newConn, metering_pct: active ? r2(metered / active * 100) : null, nrw_pct: wb && wb.status === 'ok' ? wb.nrw_pct : null,
    collection_pct: bl.amt ? r2(col / bl.amt * 100) : null, om_coverage: cost ? r2(bl.amt / cost) : null, cash_coverage: cost ? r2(col / cost) : null,
    unit_cost_produced: cost && sup && costShareSup > 0 ? r2(cost * costShareSup / sup) : null, unit_cost_billed: cost && bl.m3 ? r2(cost / bl.m3) : null, avg_tariff: bl.m3 ? r2(bl.amt / bl.m3) : null,
    staff_per_1000: inp.staff && active ? r2(inp.staff / active * 1000) : null, supply_hours: sl && sl.logged ? sl.hours_per_day : inp.hours == null ? null : r2(inp.hours), supply_reliability_pct: sl && sl.logged ? sl.reliability_pct : null, satisfaction_avg: fbk.n ? r2(fbk.s) : null, wq_compliance_pct: wq.n ? r2(wq.p / wq.n * 100) : null,
    reading_completion_pct: metered ? r2(read / metered * 100) : null, complaint_hours: res.length ? r2(median(res)) : null
  };
  if (wb && wb.status !== 'ok') notes.push('No bulk supply data — NRW unavailable'); else if (wb && wb.grade !== 'A') notes.push(`NRW data grade ${wb.grade}`);
  return { area_id: a.id, area: a.name, currency: cur, months: months.length, billed: r2(bl.amt), billed_m3: r2(bl.m3), collected: r2(col), om_cost: r2(cost), supply_m3: r2(sup), values: v, notes: [...new Set(notes)],
    costs_by_category: db.all(`SELECT category, currency, SUM(amount) amount FROM om_costs WHERE area_id=? AND period BETWEEN ? AND ? GROUP BY category, currency ORDER BY amount DESC`, a.id, from, to) };
}

function compute({ from, to, area_id }) {
  ensureTargets();
  const targets = Object.fromEntries(db.all('SELECT * FROM kpi_targets').map(t => [t.code, t]));
  const areas = db.all(`SELECT * FROM service_areas WHERE active=1 ${area_id ? 'AND id=?' : ''} ORDER BY name`, ...(area_id ? [area_id] : []));
  const rows = areas.map(a => forArea(a, from, to));
  const judge = (code, val) => { const t = targets[code]; if (!t || val == null) return null; return (t.direction === 'min' ? val >= t.target : val <= t.target) ? 'good' : 'bad'; };
  for (const r of rows) r.status = Object.fromEntries(Object.entries(r.values).map(([k, val]) => [k, judge(k, val)]));
  return { from, to, labels: LABELS, targets, areas: rows };
}

module.exports = { compute, ensureTargets, LABELS };
