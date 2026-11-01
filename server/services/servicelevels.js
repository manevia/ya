'use strict';
/*
 * Drinking-water service levels (SDG 6.1 / WHO-UNICEF JMP service ladder), ESTIMATED from the system's own data.
 *   Safely managed : improved source ON PREMISES, AVAILABLE WHEN NEEDED and FREE FROM CONTAMINATION
 *   Basic          : improved source, collection time ≤ 30 minutes round trip (including queuing) — or on premises
 *                    when availability or quality is not shown
 *   Limited        : improved source, collection time > 30 minutes
 * The utility's piped connections and public water points are improved sources. People the utility does not serve
 * (unimproved / surface water) are only visible as the remainder of the area population, when that is entered.
 * Every figure carries the assumptions used, because population and collection times are estimates.
 */
const db = require('../lib/db');

const r0 = n => Math.round(n);
const r1 = n => Math.round(n * 10) / 10;

function availability(area, from, to) {
  const min = db.settingNum('jmp_min_hours', 12);
  const sl = require('./supply').reliability({ from, to, area_id: area.id })[0];
  if (sl && sl.logged) return { ok: sl.hours_per_day >= min, hours: sl.hours_per_day, basis: `supply log: ${sl.hours_per_day} h/day per zone (threshold ${min} h)` };
  const sch = db.all('SELECT * FROM supply_schedules WHERE area_id=? AND active=1', area.id);
  if (sch.length) { const zones = new Set(sch.map(s => s.zone || '')).size; const hrs = sch.reduce((a, s) => a + s.days.length * (Number(s.end_time.slice(0, 2)) * 60 + Number(s.end_time.slice(3)) - Number(s.start_time.slice(0, 2)) * 60 - Number(s.start_time.slice(3))) / 60, 0) / 7 / zones;
    return { ok: hrs >= min, hours: r1(hrs), basis: `timetable: ${r1(hrs)} h/day per zone, not yet confirmed by delivery records (threshold ${min} h)` }; }
  const k = db.get('SELECT AVG(supply_hours_per_day) h FROM kpi_inputs WHERE area_id=? AND period BETWEEN ? AND ? AND supply_hours_per_day IS NOT NULL', area.id, from.slice(0, 7), to.slice(0, 7)).h;
  if (k != null) return { ok: k >= min, hours: r1(k), basis: `hours of supply entered under Cost recovery & KPIs: ${r1(k)} h/day (threshold ${min} h)` };
  return { ok: null, hours: null, basis: 'no timetable, delivery records or supply hours — availability not shown' };
}
function quality(area, to) {
  const days = db.settingNum('jmp_quality_days', 92); const since = new Date(Date.parse(to + 'T23:59:59Z') - days * 86400e3).toISOString();
  const tests = db.all(`SELECT t.asset_id, t.result, t.sampled_at FROM wq_tests t JOIN assets s ON s.id=t.asset_id WHERE s.area_id=? AND t.parameter='ecoli' AND t.sampled_at >= ? AND t.sampled_at <= ? ORDER BY t.sampled_at`, area.id, since, to + 'T23:59:59Z');
  if (!tests.length) return { ok: null, basis: `no E. coli tests in the last ${days} days — quality not shown` };
  const latest = {}; for (const t of tests) latest[t.asset_id] = t; const fails = Object.values(latest).filter(t => t.result === 'fail').length;
  return { ok: fails === 0, basis: `${tests.length} E. coli test(s) in ${days} days; latest result ${fails ? `FAILED at ${fails} point(s)` : 'clear at every tested point'}` };
}

function estimate({ from, to, area_id } = {}) {
  const avgHH = db.settingNum('avg_household_size', 5);
  const areas = db.all(`SELECT * FROM service_areas WHERE active=1 ${area_id ? 'AND id=?' : ''} ORDER BY name`, ...(area_id ? [area_id] : []));
  const out = areas.map(a => {
    const notes = []; const L = { safely_managed: 0, basic: 0, limited: 0, basic_or_limited: 0, not_functional: 0 };
    // piped household connections (people living on premises)
    const hh = db.all(`SELECT c.id, c.household_size FROM customers c WHERE c.area_id=? AND c.status='active' AND c.customer_type='household' AND EXISTS (SELECT 1 FROM meters m WHERE m.customer_id=c.id AND m.status IN ('active','faulty'))`, a.id);
    let piped = 0, assumedHH = 0;
    for (const c of hh) {
      const g = db.get('SELECT id FROM shared_groups WHERE customer_id=? AND active=1', c.id);
      const mem = g ? db.all('SELECT household_size FROM shared_members WHERE group_id=? AND active=1', g.id) : [];
      if (mem.length) { for (const m of mem) { if (m.household_size) piped += m.household_size; else { piped += avgHH; assumedHH++; } } }
      else if (c.household_size) piped += c.household_size; else { piped += avgHH; assumedHH++; }
    }
    if (assumedHH) notes.push(`${assumedHH} household(s) without a recorded size counted as ${avgHH} people`);
    const av = availability(a, from, to), q = quality(a, to);
    const safe = av.ok === true && q.ok === true;
    if (safe) L.safely_managed += piped; else L.basic += piped;
    const pipedWhy = safe ? 'on premises, available and E. coli-free' : `on premises but ${[av.ok === false ? 'not available enough' : av.ok == null ? 'availability not shown' : null, q.ok === false ? 'contamination found' : q.ok == null ? 'quality not shown' : null].filter(Boolean).join(' and ')} → counted as basic`;
    // public water points
    const wps = db.all(`SELECT s.id, s.name, s.status, s.served_population, s.round_trip_min FROM assets s WHERE s.area_id=? AND s.asset_type='water_point' AND s.status!='decommissioned'`, a.id);
    let wpPeople = 0, noPop = 0, noTime = 0;
    const points = wps.map(w => {
      if (!w.served_population) { noPop++; return { ...w, level: 'unknown_population' }; }
      wpPeople += w.served_population;
      let level;
      if (!require('./maintenance').FUNCTIONAL.has(w.status)) level = 'not_functional';
      else if (w.round_trip_min == null) { level = 'basic_or_limited'; noTime++; }
      else level = w.round_trip_min <= 30 ? 'basic' : 'limited';
      L[level] += w.served_population; return { ...w, level };
    });
    if (noPop) notes.push(`${noPop} water point(s) have no estimate of people served and are not counted`);
    if (noTime) notes.push(`${noTime} water point(s) have no collection time recorded — their users are "basic or limited"`);
    const served = Object.values(L).reduce((x, y) => x + y, 0);
    const pop = a.population || null;
    if (!pop) notes.push('Area population not entered — coverage % and people not served by the utility cannot be shown');
    const pct = v => (pop ? r1(v / pop * 100) : null);
    return { area_id: a.id, area: a.name, population: pop, served: r0(served), served_pct: pct(served), not_served_or_unknown: pop ? Math.max(0, r0(pop - served)) : null,
      levels: Object.fromEntries(Object.entries(L).map(([k, v]) => [k, { people: r0(v), pct_of_population: pct(v), pct_of_served: served ? r1(v / served * 100) : null }])),
      piped_people: r0(piped), piped_basis: pipedWhy, availability: av, quality: q, water_points: points, notes };
  });
  const tot = k => out.reduce((x, a) => x + a.levels[k].people, 0);
  const totalPop = out.every(a => a.population) ? out.reduce((x, a) => x + a.population, 0) : null;
  return { from, to, areas: out, totals: { population: totalPop, served: out.reduce((x, a) => x + a.served, 0), ...Object.fromEntries(['safely_managed', 'basic', 'limited', 'basic_or_limited', 'not_functional'].map(k => [k, tot(k)])) },
    method: 'WHO/UNICEF JMP drinking-water ladder applied to the utility\'s own customers and water points. Population, people per water point and collection times are estimates entered by the utility; household sizes come from customer records (or the average in Settings).' };
}

module.exports = { estimate };
