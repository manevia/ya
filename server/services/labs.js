'use strict';
// Tariff & affordability lab, and the manager's morning briefing.
const db = require('../lib/db');
const billing = require('./billing');
const { HttpError } = require('../lib/http');

const r2 = n => (n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Re-price real past consumption under a proposed tariff and compare with what was actually billed. */
function simulate({ area_id, customer_type, months = 6, proposal }) {
  const area = db.get('SELECT * FROM service_areas WHERE id=?', area_id); if (!area) throw new HttpError(400, 'Choose a service area');
  if (proposal.currency && proposal.currency !== area.currency) throw new HttpError(400, `This area bills in ${area.currency}`);
  const since = new Date(Date.now() - months * 30.4 * 86400e3).toISOString().slice(0, 10);
  const bills = db.all(`SELECT b.*, c.customer_type, c.household_size FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.status!='cancelled' AND b.period_end >= ? ${customer_type ? 'AND c.customer_type=?' : ''}`, area.id, since, ...(customer_type ? [customer_type] : []));
  if (!bills.length) throw new HttpError(400, 'No bills in this area/period to simulate on');
  const t = { ...proposal, bands_json: JSON.stringify(proposal.bands), fees_json: JSON.stringify(proposal.fees || []) };
  const rows = bills.map(b => ({ customer_id: b.customer_id, type: b.customer_type, m3: b.consumption, current: b.total, proposed: billing.computeCharges(t, b.consumption).total, household_size: b.household_size }));
  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  const cur = sum('current'), pro = sum('proposed');
  const buckets = [['Down more than 20%', -Infinity, -20], ['Down 5–20%', -20, -5], ['About the same (±5%)', -5, 5], ['Up 5–20%', 5, 20], ['Up more than 20%', 20, Infinity]].map(([label, lo, hi]) => ({ label, n: rows.filter(r => { const ch = r.current ? (r.proposed - r.current) / r.current * 100 : 0; return ch > lo && ch <= hi; }).length }));
  const byType = {}; for (const r of rows) { const x = byType[r.type] = byType[r.type] || { type: r.type, bills: 0, current: 0, proposed: 0, m3: 0 }; x.bills++; x.current += r.current; x.proposed += r.proposed; x.m3 += r.m3; }
  // Affordability (households): monthly bill as % of median household income (an assumption the administrator sets per currency)
  const income = Number(db.setting('median_household_income_' + area.currency, '')) || null;
  const thr = db.settingNum('affordability_threshold_pct', 5);
  const hh = rows.filter(r => r.type === 'household');
  const aff = income ? { income, threshold_pct: thr, median_bill_pct_current: r2(median(hh.map(r => r.current)) / income * 100), median_bill_pct_proposed: r2(median(hh.map(r => r.proposed)) / income * 100),
    over_threshold_current: hh.filter(r => r.current / income * 100 > thr).length, over_threshold_proposed: hh.filter(r => r.proposed / income * 100 > thr).length, households: hh.length } : null;
  // Lifeline: basic needs volume for an average household
  const hsize = db.settingNum('avg_household_size', 5), lpcd = db.settingNum('lifeline_lpcd', 20);
  const lifeM3 = r2(hsize * lpcd * 30 / 1000);
  const curT = billing.selectTariff({ customer_type: 'household', area_id: area.id, billing_mode: 'postpaid' }, null, new Date().toISOString().slice(0, 10));
  const lifeCur = curT ? billing.computeCharges(curT, lifeM3).total : null, lifePro = billing.computeCharges(t, lifeM3).total;
  // Equity: what kiosk users pay per m³ versus a piped household at lifeline volume
  const kiosks = db.all(`SELECT s.name, w.price_per_container, w.container_liters, w.currency FROM wp_config w JOIN assets s ON s.id=w.asset_id WHERE s.area_id=? AND w.mode='pay_per_container' AND w.active=1`, area.id)
    .map(k => ({ name: k.name, currency: k.currency, price_per_m3: r2(k.price_per_container / k.container_liters * 1000) }));
  const pipedPerM3Cur = lifeCur != null ? r2(lifeCur / lifeM3) : null, pipedPerM3Pro = r2(lifePro / lifeM3);
  return {
    area: area.name, currency: area.currency, months, bills: rows.length, customers: new Set(rows.map(r => r.customer_id)).size,
    revenue: { current_total: r2(cur), proposed_total: r2(pro), change_pct: cur ? r2((pro - cur) / cur * 100) : null, current_per_month: r2(cur / months), proposed_per_month: r2(pro / months) },
    paying_more_pct: r2(rows.filter(r => r.proposed > r.current + 0.004).length / rows.length * 100), distribution: buckets,
    by_type: Object.values(byType).map(x => ({ ...x, current: r2(x.current), proposed: r2(x.proposed), m3: r2(x.m3), change_pct: x.current ? r2((x.proposed - x.current) / x.current * 100) : null })),
    affordability: aff, affordability_note: income ? null : `Set "median household income (${area.currency}/month)" in Settings to see affordability.`,
    lifeline: { household_size: hsize, litres_per_person_day: lpcd, m3_per_month: lifeM3, current_bill: r2(lifeCur), proposed_bill: r2(lifePro), current_pct_income: income && lifeCur != null ? r2(lifeCur / income * 100) : null, proposed_pct_income: income ? r2(lifePro / income * 100) : null },
    equity: { piped_per_m3_current: pipedPerM3Cur, piped_per_m3_proposed: pipedPerM3Pro, kiosks: kiosks.map(k => ({ ...k, times_piped_current: pipedPerM3Cur ? r2(k.price_per_m3 / pipedPerM3Cur) : null, times_piped_proposed: pipedPerM3Pro ? r2(k.price_per_m3 / pipedPerM3Pro) : null })) },
    notes: ['Simulated on bills actually issued (estimated bills included); customers may change their use when prices change, so treat revenue as indicative.', 'Affordability uses the income assumption set by the administrator; the 3–5% of household income benchmark is commonly used by WHO/UNDP and regulators.']
  };
}

/** Today's priorities for a manager, built from live data. */
function briefing() {
  const t = new Date().toISOString().slice(0, 10); const items = [];
  const add = (sev, title, detail, link) => items.push({ severity: sev, title, detail, link });
  const crit = db.all(`SELECT title FROM alerts WHERE status IN ('open','acknowledged') AND severity IN ('critical','high') ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, detected_at DESC`);
  if (crit.length) add('critical', `${crit.length} high/critical alert(s) need action`, crit.slice(0, 3).map(a => a.title).join(' · '), '#/alerts?status=open_all');
  const wq = db.all(`SELECT t.*, s.name FROM wq_tests t JOIN assets s ON s.id=t.asset_id WHERE t.result='fail' AND t.sampled_at >= date('now','-7 day')
    AND NOT EXISTS (SELECT 1 FROM wq_tests x WHERE x.asset_id=t.asset_id AND x.parameter=t.parameter AND x.sampled_at > t.sampled_at AND x.result='pass')`);
  if (wq.length) add('critical', `Water quality failing at ${[...new Set(wq.map(w => w.name))].length} point(s) — advisory active`, wq.slice(0, 3).map(w => `${w.name}: ${w.parameter} ${w.value}`).join(' · '), '#/water-quality');
  const due = db.get(`SELECT COUNT(*) n FROM (SELECT s.id FROM assets s WHERE s.asset_type='water_point' AND s.status='operational' AND NOT EXISTS (SELECT 1 FROM wq_tests t WHERE t.asset_id=s.id AND t.sampled_at >= date('now','-' || ? || ' day')))`, db.settingNum('wq_sampling_days', 7)).n;
  if (due) add('high', `${due} operational water point(s) not tested for quality in the last ${db.settingNum('wq_sampling_days', 7)} days`, 'Schedule chlorine/E. coli tests', '#/water-quality');
  const pub = db.get(`SELECT COUNT(*) n FROM public_reports WHERE created_at >= datetime('now','-1 day')`).n;
  if (pub) add('high', `${pub} community report(s) in the last 24 h`, 'From the public status page, USSD or SMS', '#/alerts?status=open_all');
  const late = db.all(`SELECT wo_number, title FROM work_orders WHERE status NOT IN ('completed','cancelled') AND due_date < ?`, t);
  if (late.length) add('high', `${late.length} overdue work order(s)`, late.slice(0, 3).map(w => `${w.wo_number} ${w.title}`).join(' · '), '#/work-orders?status=active');
  const wp = require('./waterpoints'); const yest = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  for (const c of db.all('SELECT asset_id FROM wp_config WHERE active=1')) { const r = wp.reconcile(c.asset_id, yest, t); if (r.unaccounted_pct != null && r.unaccounted_pct > 15) add('high', `${r.point.name}: ${r.unaccounted_pct}% of metered water not recorded as sold`, 'Check for leaks at the tap stand or unrecorded sales', '#/water-points?tab=reconcile'); }
  const mm = db.get(`SELECT COUNT(*) n, SUM(amount) s FROM momo_transactions WHERE status='unmatched'`);
  if (mm.n) add('medium', `${mm.n} mobile-money payment(s) waiting to be matched`, 'Customers have paid — credit them quickly', '#/momo');
  const pend = db.get(`SELECT COUNT(*) n, SUM(flags_json != '[]') f FROM readings WHERE status='pending' AND source IN ('manual','csv_import','customer_self')`);
  if (pend.n) add('medium', `${pend.n} field/customer readings awaiting review (${pend.f || 0} flagged)`, 'Approve before the next billing run', '#/readings?status=pending');
  const coll = require('./collections');
  const lad = coll.ladder(); const rev = lad.filter(r => r.stage === 'review').length, esc = lad.filter(r => r.stage === 'escalate').length, risk = lad.filter(r => r.plan && ['at_risk', 'behind'].includes(r.plan.health)).length;
  if (rev || esc || risk) add('medium', `Collections: ${rev} for review, ${esc} essential-service escalations, ${risk} plans falling behind`, 'Humane ladder — offer plans before any review', '#/collections');
  const outage = db.all(`SELECT title FROM service_notices WHERE notice_type IN ('outage','maintenance') AND starts_at BETWEEN ? AND date(?, '+1 day')`, t, t);
  if (outage.length) add('info', `Planned interruption today/tomorrow`, outage.map(o => o.title).join(' · '), '#/admin/notices');
  const ins = require('./insights'); const wb = ins.waterBalance({ from: new Date(Date.now() - 182 * 86400e3).toISOString().slice(0, 10), to: t }).find(a => a.status === 'ok');
  if (wb && wb.nrw_pct > 25) add('info', `Highest water loss: ${wb.area} at ${wb.nrw_pct}% NRW`, `Real losses ≈ ${Math.round(wb.real_losses_l_per_conn_day)} L/connection/day`, '#/water-loss');
  const low = require('./stock').lowStock();
  if (low.length) add(low.some(i => i.out) ? 'high' : 'medium', `${low.length} store item(s) at or below reorder level`, low.slice(0, 4).map(i => `${i.name}: ${i.on_hand} ${i.unit}`).join(' · '), '#/stores');
  const sp = require('./supply'); const unl = sp.unlogged(3);
  if (unl.length) add('medium', `${unl.length} supply window(s) in the last 3 days not logged`, 'Record hours actually delivered — it drives supply reliability', '#/supply?tab=log');
  const missed = db.all(`SELECT l.*, a.name area FROM supply_log l JOIN service_areas a ON a.id=l.area_id WHERE l.supply_date >= date('now','-1 day') AND l.outcome IN ('missed','partial')`);
  if (missed.length) add('high', `Supply short or missed in ${missed.length} zone window(s) since yesterday`, missed.slice(0, 3).map(m => `${m.area}${m.zone ? ' ' + m.zone : ''}: ${m.delivered_hours}/${m.planned_hours} h — ${m.reason || 'no reason'}`).join(' · '), '#/supply?tab=log');
  const unhappy = db.get(`SELECT COUNT(*) n FROM feedback_requests WHERE score <= 2 AND responded_at >= datetime('now','-7 day')`).n;
  if (unhappy) add('medium', `${unhappy} customer(s) rated a job 1–2 out of 5 this week`, 'Call them back — see Customer feedback', '#/feedback');
  const mt = require('./maintenance'); const mp = mt.plans().filter(p => p.active && p.due.state === 'overdue');
  if (mp.length) add('high', `${mp.length} preventive maintenance task(s) overdue`, mp.slice(0, 3).map(p => `${p.asset_name}: ${p.title}`).join(' · '), '#/maintenance');
  const downWp = db.all(`SELECT s.name, l.changed_at FROM assets s JOIN asset_status_log l ON l.id=(SELECT id FROM asset_status_log x WHERE x.asset_id=s.id ORDER BY changed_at DESC, id DESC LIMIT 1) WHERE s.asset_type='water_point' AND s.status='down' AND l.changed_at <= ?`, new Date(Date.now() - 3 * 86400e3).toISOString());
  if (downWp.length) add('critical', `${downWp.length} water point(s) broken for more than 3 days`, downWp.slice(0, 3).map(w => w.name).join(' · '), '#/maintenance?tab=functionality');
  const cc = db.get(`SELECT COUNT(*) n, SUM(ABS(variance) > 0.004) v FROM cash_closes WHERE status='submitted'`);
  if (cc.n) add(cc.v ? 'high' : 'medium', `${cc.n} cashier close(s) awaiting review${cc.v ? ` — ${cc.v} with a difference` : ''}`, 'Approve or reject in Cash book', '#/cash?tab=book');
  const order = { critical: 0, high: 1, medium: 2, info: 3 };
  items.sort((a, b) => order[a.severity] - order[b.severity]);
  return { date: t, org_name: db.setting('org_name'), mode: db.MODE, items };
}
function briefingSms(b) {
  const lines = b.items.slice(0, 6).map((i, n) => `${n + 1}) ${i.title}`);
  return `${require('./channels').short()} briefing ${b.date}: ${lines.length ? lines.join(' ') : 'No urgent items.'}`.slice(0, 480);
}

module.exports = { simulate, briefing, briefingSms };
