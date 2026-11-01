'use strict';
// Configurable alert rules. Each rule records the data basis (measured / manual / estimated / simulated)
// so staff can tell sensor-detected issues from inferences on manual readings.
const db = require('../lib/db');
const audit = require('../lib/audit');

const DEFAULT_RULES = [
  { type: 'continuous_flow', name: 'Continuous flow / likely leak', severity: 'high', params: { window_hours: 24, min_points: 6, min_flow_m3_per_hour: 0.004 },
    description: 'Interval (device) readings never drop to zero across the window, or a device reports a leak flag. Needs meters that report at least several times a day.' },
  { type: 'sudden_high', name: 'Sudden unusual consumption', severity: 'medium', params: { lookback_days: 14 },
    description: 'A reading was flagged unusually high compared with the meter’s own history (factor set in Settings).' },
  { type: 'zero_consumption', name: 'No recorded consumption', severity: 'low', params: { days: 30 },
    description: 'Active, metered account with zero consumption over the period — possible stuck meter, bypass or vacant premises.' },
  { type: 'device_event', name: 'Reverse flow, tamper or meter fault (device-reported)', severity: 'high', params: { lookback_days: 14 },
    description: 'Raised only when a compatible device reports the event. Manual meters cannot report these.' },
  { type: 'missing_reading', name: 'Missing or delayed readings', severity: 'medium', params: { days: 35 },
    description: 'Active metered account with no reading of any kind within the number of days.' },
  { type: 'device_health', name: 'Low battery / communication failure', severity: 'medium', params: { battery_pct: 15, silent_hours: 72 },
    description: 'For communicating meters only: battery below threshold, or no message received within the window.' },
  { type: 'supply_imbalance', name: 'Bulk supply vs billed consumption difference', severity: 'high', params: { max_loss_pct: 30, lookback_days: 62 },
    description: 'Compares recorded bulk/district supply with billed consumption in the same area and period (non-revenue water indicator).' }
];

function ensureRules() {
  for (const r of DEFAULT_RULES) {
    db.run(`INSERT OR IGNORE INTO alert_rules(type, name, description, severity, params_json) VALUES (?,?,?,?,?)`, r.type, r.name, r.description, r.severity, JSON.stringify(r.params));
  }
}

function basisFor(reading) {
  if (!reading) return 'manual';
  if (reading.is_simulated) return 'simulated';
  if (reading.is_estimated) return 'estimated';
  return ['manual', 'csv_import', 'estimate'].includes(reading.source) ? 'manual' : 'measured';
}

function raise(ctx, a) {
  if (a.dedupe_key) {
    const ex = db.get(`SELECT id FROM alerts WHERE dedupe_key=? AND status NOT IN ('resolved','dismissed')`, a.dedupe_key);
    if (ex) return null;
    const recent = db.get(`SELECT id FROM alerts WHERE dedupe_key=?`, a.dedupe_key);
    if (recent) return null; // already raised (and closed) for this key/period
  }
  const ins = db.run(`INSERT INTO alerts(rule_type, severity, title, description, customer_id, meter_id, asset_id, area_id, lat, lng, source, data_basis, dedupe_key, created_by, detected_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.rule_type, a.severity, a.title, a.description || null, a.customer_id || null, a.meter_id || null, a.asset_id || null,
    a.area_id || null, a.lat ?? null, a.lng ?? null, a.source || 'rule', a.data_basis || null, a.dedupe_key || null, ctx && ctx.user ? ctx.user.id : null, a.detected_at || new Date().toISOString());
  audit.log(ctx, 'alert.create', 'alert', ins.id, { rule: a.rule_type, title: a.title, basis: a.data_basis });
  return ins.id;
}

const meterJoin = `SELECT m.*, c.name AS customer_name, c.customer_number, c.id AS cid, c.area_id AS c_area, COALESCE(c.lat, m.lat) AS plat, COALESCE(c.lng, m.lng) AS plng
  FROM meters m JOIN customers c ON c.id = m.customer_id WHERE m.status = 'active' AND c.status = 'active'`;

function run(ctx) {
  ensureRules();
  const created = {};
  const now = Date.now();
  const iso = t => new Date(t).toISOString();
  const month = new Date().toISOString().slice(0, 7);
  for (const rule of db.all('SELECT * FROM alert_rules WHERE enabled = 1')) {
    const P = JSON.parse(rule.params_json || '{}');
    let n = 0;
    const add = a => { if (raise(ctx, { rule_type: rule.type, severity: rule.severity, ...a })) n++; };
    if (rule.type === 'continuous_flow') {
      for (const m of db.all(meterJoin + ` AND m.comm_method NOT IN ('manual','csv')`)) {
        const rs = db.all(`SELECT * FROM readings WHERE meter_id=? AND status!='rejected' AND reading_at >= ? ORDER BY reading_at`, m.id, iso(now - P.window_hours * 3600e3));
        const leakFlag = rs.find(r => (r.events_json || '').includes('leak'));
        let continuous = rs.length >= P.min_points;
        for (let i = 1; continuous && i < rs.length; i++) {
          const hrs = (Date.parse(rs[i].reading_at) - Date.parse(rs[i - 1].reading_at)) / 3600e3;
          const d = (rs[i].corrected_value ?? rs[i].value) - (rs[i - 1].corrected_value ?? rs[i - 1].value);
          if (hrs <= 0 || d / hrs < P.min_flow_m3_per_hour) continuous = false;
        }
        if (continuous || leakFlag) {
          const last = rs[rs.length - 1];
          add({ title: `Possible leak: continuous flow on meter ${m.serial_number}`, description: continuous ? `Flow never dropped below ${P.min_flow_m3_per_hour} m³/h across ${rs.length} readings in ${P.window_hours} h.` : 'Device reported a leak / continuous-flow flag.',
            customer_id: m.cid, meter_id: m.id, area_id: m.c_area, lat: m.plat, lng: m.plng, data_basis: basisFor(last), dedupe_key: `cf:${m.id}:${new Date().toISOString().slice(0, 10)}` });
        }
      }
    }
    if (rule.type === 'sudden_high') {
      for (const r of db.all(`SELECT r.*, m.serial_number, c.name cname, c.area_id c_area, COALESCE(c.lat,m.lat) plat, COALESCE(c.lng,m.lng) plng FROM readings r JOIN meters m ON m.id=r.meter_id
          LEFT JOIN customers c ON c.id=r.customer_id WHERE r.flags_json LIKE '%unusually_high%' AND r.status!='rejected' AND r.reading_at >= ?`, iso(now - P.lookback_days * 86400e3))) {
        add({ title: `Unusual consumption: ${r.consumption} m³ on ${r.serial_number}`, description: `Reading ${r.value} on ${r.reading_at.slice(0, 10)} is well above this meter's usual daily average.`,
          customer_id: r.customer_id, meter_id: r.meter_id, area_id: r.c_area, lat: r.plat, lng: r.plng, data_basis: basisFor(r), dedupe_key: `hi:${r.id}` });
      }
    }
    if (rule.type === 'zero_consumption') {
      for (const m of db.all(meterJoin)) {
        const rs = db.all(`SELECT * FROM readings WHERE meter_id=? AND status='approved' ORDER BY reading_at DESC LIMIT 2`, m.id);
        if (rs.length < 2) continue;
        const days = (Date.parse(rs[0].reading_at) - Date.parse(rs[1].reading_at)) / 86400e3;
        if ((rs[0].corrected_value ?? rs[0].value) === (rs[1].corrected_value ?? rs[1].value) && days >= P.days * 0.8) {
          add({ title: `No consumption recorded: ${m.customer_name}`, description: `Meter ${m.serial_number} unchanged at ${rs[0].value} m³ for ${Math.round(days)} days.`,
            customer_id: m.cid, meter_id: m.id, area_id: m.c_area, lat: m.plat, lng: m.plng, data_basis: basisFor(rs[0]), dedupe_key: `zero:${m.id}:${rs[0].id}` });
        }
      }
    }
    if (rule.type === 'device_event') {
      for (const r of db.all(`SELECT r.*, m.serial_number, c.area_id c_area, COALESCE(c.lat,m.lat) plat, COALESCE(c.lng,m.lng) plng FROM readings r JOIN meters m ON m.id=r.meter_id
          LEFT JOIN customers c ON c.id=r.customer_id WHERE r.events_json IS NOT NULL AND r.reading_at >= ?`, iso(now - P.lookback_days * 86400e3))) {
        const evs = JSON.parse(r.events_json || '[]').filter(e => ['reverse_flow', 'tamper', 'device_fault'].includes(e));
        for (const e of evs) {
          add({ title: `${e === 'reverse_flow' ? 'Reverse flow' : e === 'tamper' ? 'Tamper' : 'Meter fault'} reported by meter ${r.serial_number}`, description: `Device event at ${r.reading_at}.`,
            severity: e === 'tamper' ? 'critical' : rule.severity, customer_id: r.customer_id, meter_id: r.meter_id, area_id: r.c_area, lat: r.plat, lng: r.plng, source: 'device', data_basis: basisFor(r), dedupe_key: `ev:${e}:${r.meter_id}:${r.reading_at.slice(0, 10)}` });
        }
      }
    }
    if (rule.type === 'missing_reading') {
      for (const m of db.all(meterJoin)) {
        const last = db.get(`SELECT reading_at FROM readings WHERE meter_id=? AND status!='rejected' ORDER BY reading_at DESC LIMIT 1`, m.id);
        const since = last ? last.reading_at : (m.install_date ? m.install_date + 'T00:00:00Z' : m.created_at);
        if (now - Date.parse(since) > P.days * 86400e3) {
          add({ title: `Missing reading: ${m.customer_name}`, description: `No reading since ${String(since).slice(0, 10)} on meter ${m.serial_number}.`,
            customer_id: m.cid, meter_id: m.id, area_id: m.c_area, lat: m.plat, lng: m.plng, data_basis: 'manual', dedupe_key: `miss:${m.id}:${month}` });
        }
      }
    }
    if (rule.type === 'device_health') {
      for (const m of db.all(meterJoin + ` AND m.comm_method NOT IN ('manual','csv')`)) {
        if (m.battery_pct != null && m.battery_pct < P.battery_pct) add({ title: `Low battery (${m.battery_pct}%) on meter ${m.serial_number}`, customer_id: m.cid, meter_id: m.id, area_id: m.c_area, lat: m.plat, lng: m.plng,
          data_basis: m.comm_method === 'simulator' ? 'simulated' : 'measured', source: 'device', dedupe_key: `bat:${m.id}:${month}` });
        if (!m.last_reading_at || now - Date.parse(m.last_reading_at) > P.silent_hours * 3600e3) add({ title: `Communication failure: no data from ${m.serial_number}`, description: `Last message ${m.last_reading_at || 'never'}.`,
          customer_id: m.cid, meter_id: m.id, area_id: m.c_area, lat: m.plat, lng: m.plng, data_basis: m.comm_method === 'simulator' ? 'simulated' : 'measured', dedupe_key: `comm:${m.id}:${new Date().toISOString().slice(0, 10)}` });
      }
    }
    if (rule.type === 'supply_imbalance') {
      for (const s of db.all(`SELECT b.area_id, b.period_start, b.period_end, SUM(b.volume_m3) vol, GROUP_CONCAT(DISTINCT b.source) sources, MIN(b.asset_id) asset_id, a.name area_name
          FROM bulk_supply b JOIN service_areas a ON a.id=b.area_id WHERE b.period_end >= ? GROUP BY b.area_id, b.period_start, b.period_end`, iso(now - P.lookback_days * 86400e3).slice(0, 10))) {
        const billed = db.get(`SELECT COALESCE(SUM(bl.consumption),0) s FROM bills bl JOIN customers c ON c.id=bl.customer_id WHERE c.area_id=? AND bl.status!='cancelled' AND bl.period_start>=? AND bl.period_end<=?`, s.area_id, s.period_start, s.period_end).s;
        if (!s.vol || billed === 0) continue;
        const loss = (s.vol - billed) / s.vol * 100;
        if (loss > P.max_loss_pct) {
          const asset = s.asset_id ? db.get('SELECT * FROM assets WHERE id=?', s.asset_id) : null;
          add({ title: `Supply/billing gap ${loss.toFixed(0)}% in ${s.area_name}`, description: `Bulk supply ${s.vol} m³ vs billed ${billed.toFixed(1)} m³ for ${s.period_start}–${s.period_end}. Supply data source: ${s.sources}.`,
            area_id: s.area_id, asset_id: s.asset_id, lat: asset && asset.lat, lng: asset && asset.lng,
            data_basis: s.sources.includes('simulator') ? 'simulated' : s.sources.includes('estimate') ? 'estimated' : s.sources.includes('sensor') ? 'measured' : 'manual', dedupe_key: `nrw:${s.area_id}:${s.period_start}:${s.period_end}` });
        }
      }
    }
    created[rule.type] = n;
  }
  const total = Object.values(created).reduce((a, b) => a + b, 0);
  audit.log(ctx, 'alerts.run', 'alert_rules', null, { created, total });
  return { created, total };
}

module.exports = { run, raise, ensureRules, DEFAULT_RULES };
