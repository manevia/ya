'use strict';
/*
 * Water-quality monitoring. Thresholds live in the wq_parameters table and are editable by the administrator.
 * Defaults follow WHO drinking-water guidance and must be confirmed against the national standard in use.
 * A failed test raises an alert and publishes a "treat your water" advisory for the area; a later passing test lifts it.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const DEFAULTS = [
  ['free_chlorine', 'Free residual chlorine', 'mg/L', 0.2, null, 2, 5, 'WHO: at least 0.2 mg/L at the point of delivery; not above 5 mg/L. Confirm the national standard.'],
  ['ecoli', 'E. coli', 'CFU/100 mL', null, null, null, 0, 'WHO: must not be detectable in any 100 mL sample.'],
  ['turbidity', 'Turbidity', 'NTU', null, null, 1, 5, 'WHO: ideally below 1 NTU for effective disinfection; above 5 NTU is visible and unacceptable.'],
  ['ph', 'pH', '', null, 6.5, 8.5, null, 'Operational range 6.5–8.5 (chlorine disinfects best below pH 8).']
];
function ensureParams() {
  if (db.get('SELECT COUNT(*) n FROM wq_parameters').n) return;
  for (const d of DEFAULTS) db.run('INSERT OR IGNORE INTO wq_parameters(code, name, unit, fail_below, warn_below, warn_above, fail_above, guidance) VALUES (?,?,?,?,?,?,?,?)', ...d);
}
function classify(p, v) {
  if ((p.fail_below != null && v < p.fail_below) || (p.fail_above != null && v > p.fail_above)) return 'fail';
  if ((p.warn_below != null && v < p.warn_below) || (p.warn_above != null && v > p.warn_above)) return 'warn';
  return 'pass';
}
const rank = { pass: 0, warn: 1, fail: 2 };

function canRecord(ctx, assetId) {
  const auth = require('../lib/auth');
  if (ctx.user.role !== 'attendant') return;
  if (!db.get('SELECT 1 FROM wp_config WHERE asset_id=? AND attendant_user_id=?', assetId, ctx.user.id)) throw new HttpError(403, 'Attendants can only record tests at their own water point');
}

function record(ctx, b) {
  ensureParams();
  return db.tx(() => {
    if (b.client_uuid) { const ex = db.get('SELECT * FROM wq_tests WHERE client_uuid=?', b.client_uuid); if (ex) return { ...ex, duplicate: true }; }
    const asset = db.get('SELECT * FROM assets WHERE id=?', b.asset_id); if (!asset) throw new HttpError(404, 'Asset not found');
    canRecord(ctx, asset.id);
    const p = db.get('SELECT * FROM wq_parameters WHERE code=? AND active=1', b.parameter); if (!p) throw new HttpError(400, 'Unknown parameter');
    const result = classify(p, b.value);
    const at = b.sampled_at || new Date().toISOString();
    const ins = db.run(`INSERT INTO wq_tests(asset_id, parameter, value, sampled_at, method, result, tested_by, notes, client_uuid) VALUES (?,?,?,?,?,?,?,?,?)`,
      asset.id, p.code, b.value, at, b.method || 'field_kit', result, ctx.user ? ctx.user.id : null, b.notes || null, b.client_uuid || null);
    let advisory = null;
    if (result === 'fail') {
      const alertId = require('./alerts').raise(ctx, { rule_type: 'water_quality', severity: p.code === 'ecoli' ? 'critical' : 'high', title: `Water quality FAIL: ${p.name} ${b.value} ${p.unit} at ${asset.name}`,
        description: `${p.guidance} Sample ${at.slice(0, 16).replace('T', ' ')} (${b.method || 'field kit'}). Re-test after corrective action (flushing, chlorination, repair).`, asset_id: asset.id, area_id: asset.area_id, lat: asset.lat, lng: asset.lng,
        source: b.method === 'sensor' ? 'device' : 'rule', data_basis: b.method === 'simulator' ? 'simulated' : b.method === 'sensor' ? 'measured' : 'manual', dedupe_key: `wq:${asset.id}:${p.code}:${at.slice(0, 10)}` });
      if (alertId) db.run('UPDATE wq_tests SET alert_id=? WHERE id=?', alertId, ins.id);
      const tag = `[${asset.code}]`;
      if (!db.get(`SELECT 1 FROM service_notices WHERE notice_type='quality' AND title LIKE ? AND (ends_at IS NULL OR ends_at >= date('now'))`, `%${tag}%`)) {
        const n = db.run(`INSERT INTO service_notices(title, body, area_id, notice_type, starts_at, created_by) VALUES (?,?,?,'quality',date('now'),?)`, `Water quality advisory — ${asset.name} ${tag}`,
          `A recent test at ${asset.name} did not meet the drinking-water standard (${p.name}). Until further notice, please treat drinking water (boil, or use chlorine tablets) or collect from another water point. We will announce when the water is safe again.`,
          asset.area_id, ctx.user ? ctx.user.id : null);
        advisory = n.id;
        if (db.setting('sms_notifications', '1') === '1' && asset.area_id) require('./community').broadcast(asset.area_id, { key: 'quality.advisory', vars: { point: asset.name } }, 'quality_advisory');
      }
    } else if (result === 'pass') {
      // lift the advisory once every parameter that failed at this asset has a newer passing test
      const tag = `[${asset.code}]`;
      const open = db.get(`SELECT * FROM service_notices WHERE notice_type='quality' AND title LIKE ? AND (ends_at IS NULL OR ends_at >= date('now'))`, `%${tag}%`);
      if (open && latestOverall(asset.id).result === 'pass') {
        db.run(`UPDATE service_notices SET ends_at=date('now','-1 day'), body = body || ' UPDATE: re-test passed on ' || date('now') || ' — advisory lifted.' WHERE id=?`, open.id);
        if (db.setting('sms_notifications', '1') === '1' && asset.area_id) require('./community').broadcast(asset.area_id, { key: 'quality.lifted', vars: { point: asset.name } }, 'quality_advisory');
        advisory = 'lifted';
      }
    }
    audit.log(ctx, 'wq.test', 'asset', asset.id, { parameter: p.code, value: b.value, result, method: b.method, advisory });
    return { ...db.get('SELECT * FROM wq_tests WHERE id=?', ins.id), advisory };
  });
}

/** Worst result among the latest test of each parameter at an asset. */
function latestOverall(assetId) {
  const rows = db.all(`SELECT t.* FROM wq_tests t WHERE t.asset_id=? AND t.id = (SELECT id FROM wq_tests x WHERE x.asset_id=t.asset_id AND x.parameter=t.parameter ORDER BY sampled_at DESC, id DESC LIMIT 1)`, assetId);
  if (!rows.length) return { result: null, last_tested: null, parameters: [] };
  const worst = rows.reduce((w, r) => (rank[r.result] > rank[w] ? r.result : w), 'pass');
  return { result: worst, last_tested: rows.map(r => r.sampled_at).sort().pop(), parameters: rows.map(r => ({ parameter: r.parameter, value: r.value, result: r.result, sampled_at: r.sampled_at })) };
}

function summary() {
  ensureParams();
  const days = db.settingNum('wq_sampling_days', 7);
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();
  const points = db.all(`SELECT s.id, s.code, s.name, s.asset_type, s.status, a.name area_name, s.area_id FROM assets s LEFT JOIN service_areas a ON a.id=s.area_id
    WHERE s.asset_type IN ('water_point','reservoir','treatment','source') AND s.status != 'decommissioned' ORDER BY a.name, s.name`).map(p => ({ ...p, latest: latestOverall(p.id),
      tested_recently: !!db.get('SELECT 1 FROM wq_tests WHERE asset_id=? AND sampled_at >= ?', p.id, since) }));
  const comp = db.all(`SELECT parameter, COUNT(*) n, SUM(result='pass') pass, SUM(result='warn') warn, SUM(result='fail') fail FROM wq_tests WHERE sampled_at >= ? GROUP BY parameter`, since30);
  return { sampling_days: days, points, compliance_30d: comp, coverage_pct: points.length ? Math.round(points.filter(p => p.tested_recently).length / points.length * 1000) / 10 : null,
    parameters: db.all('SELECT * FROM wq_parameters ORDER BY code') };
}

module.exports = { record, latestOverall, summary, ensureParams, classify };
