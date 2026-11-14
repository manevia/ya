'use strict';
/*
 * Water Safety Plan (WSP): the preventive, risk-based way of keeping drinking water safe from catchment to cup.
 *  - Risk register: hazardous events scored likelihood x severity (1-5 each), before and after control measures.
 *  - Control measures with operational monitoring: what to check, the limits, how often, and what to do when a limit
 *    is broken. A check outside its limits raises an alert that carries the corrective action.
 *  - Water-quality tests recorded at an asset are logged automatically against matching controls (no double entry).
 *  - Sanitary inspections: short yes/no checklists per type of water point. Each risk found can become a hazard in the
 *    register with an improvement action. Combined with the latest E. coli result they rank water points for action.
 *  - Improvement plan: costed actions with owners and due dates, which can be turned into work orders.
 * The scoring bands and the sanitary-inspection approach follow WHO Water Safety Plan guidance; the starter content in
 * server/data/wsp-library.json must be adapted to each system and to the national standard.
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');
const LIB = require('../data/wsp-library.json');

const DAY = 86400e3;
const STEPS = ['catchment', 'source', 'treatment', 'storage', 'distribution', 'collection', 'household', 'management'];
const TYPES = ['microbial', 'chemical', 'physical', 'quantity'];
const BANDS = ['low', 'medium', 'high', 'very_high'];
const band = s => (s == null ? null : s >= 16 ? 'very_high' : s >= 10 ? 'high' : s >= 6 ? 'medium' : 'low');
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
const today = () => new Date().toISOString().slice(0, 10);
const nextRef = () => require('./billing').nextNumber('hz', n => 'HZ-' + n.slice(-4));

// ---------------- controls & monitoring ----------------
function controlStatus(c) {
  const last = db.get('SELECT * FROM wsp_monitoring WHERE control_id=? ORDER BY checked_at DESC, id DESC LIMIT 1', c.id) || null;
  const out = { last, due_at: null, days_left: null };
  if (c.frequency_days) {
    const base = last ? Date.parse(last.checked_at) : Date.parse(String(c.created_at).replace(' ', 'T') + (String(c.created_at).endsWith('Z') ? '' : 'Z'));
    const due = base + c.frequency_days * DAY; out.due_at = new Date(due).toISOString(); const dl = (due - Date.now()) / DAY; out.days_left = dl >= 0 ? Math.ceil(dl) : Math.floor(dl);
  }
  out.state = last && !last.ok ? 'breach' : c.frequency_days && Date.parse(out.due_at) < Date.now() ? 'overdue' : !last ? 'not_checked' : 'ok';
  return out;
}
const limitText = c => (c.limit_low != null && c.limit_high != null ? `${c.limit_low}–${c.limit_high}` : c.limit_low != null ? `≥ ${c.limit_low}` : c.limit_high != null ? `≤ ${c.limit_high}` : '') + (c.unit && (c.limit_low != null || c.limit_high != null) ? ' ' + c.unit : '');
function controlsOf(hazardId) {
  return db.all('SELECT c.*, u.full_name responsible_name, p.name parameter_name FROM wsp_controls c LEFT JOIN users u ON u.id=c.responsible_id LEFT JOIN wq_parameters p ON p.code=c.parameter WHERE c.hazard_id=? ORDER BY c.active DESC, c.id', hazardId)
    .map(c => ({ ...c, limit_text: limitText(c), status: c.active ? controlStatus(c) : { state: 'inactive', last: null } }));
}
function saveControl(ctx, hazardId, id, b) {
  if (b.limit_low != null && b.limit_high != null && b.limit_low > b.limit_high) throw new HttpError(400, 'The lower limit is above the upper limit');
  if (b.parameter) { require('./quality').ensureParams(); if (!db.get('SELECT 1 FROM wq_parameters WHERE code=?', b.parameter)) throw new HttpError(400, 'Unknown water-quality parameter'); }
  const f = [b.description, b.parameter || null, b.limit_low ?? null, b.limit_high ?? null, b.unit || null, b.frequency_days || null, b.corrective_action || null, b.responsible_id || null, b.active === false ? 0 : 1];
  if (id) {
    const c = db.get('SELECT * FROM wsp_controls WHERE id=?', id); if (!c) throw new HttpError(404, 'Not found');
    db.run('UPDATE wsp_controls SET description=?, parameter=?, limit_low=?, limit_high=?, unit=?, frequency_days=?, corrective_action=?, responsible_id=?, active=? WHERE id=?', ...f, id); hazardId = c.hazard_id;
  } else {
    if (!db.get('SELECT 1 FROM wsp_hazards WHERE id=?', hazardId)) throw new HttpError(404, 'Hazard not found');
    id = db.run('INSERT INTO wsp_controls(hazard_id, description, parameter, limit_low, limit_high, unit, frequency_days, corrective_action, responsible_id, active) VALUES (?,?,?,?,?,?,?,?,?,?)', hazardId, ...f).id;
  }
  audit.log(ctx, 'wsp.control', 'wsp_hazard', hazardId, { control_id: id, ...b });
  return { id };
}
/** Record one operational-monitoring check. Outside the limits (or marked "not OK") raises an alert carrying the corrective action. */
function check(ctx, controlId, b, { quietAlert = false } = {}) {
  return db.tx(() => {
    if (b.client_uuid) { const ex = db.get('SELECT * FROM wsp_monitoring WHERE client_uuid=?', b.client_uuid); if (ex) return { ...ex, duplicate: true }; }
    const c = db.get('SELECT * FROM wsp_controls WHERE id=? AND active=1', controlId); if (!c) throw new HttpError(404, 'Control measure not found');
    const h = db.get('SELECT h.*, s.name asset_name, s.lat, s.lng FROM wsp_hazards h LEFT JOIN assets s ON s.id=h.asset_id WHERE h.id=?', c.hazard_id);
    const hasLimits = c.limit_low != null || c.limit_high != null;
    let ok;
    if (hasLimits) { if (b.value == null) throw new HttpError(400, `Enter the measured value (limit ${limitText(c)})`); ok = !(c.limit_low != null && b.value < c.limit_low) && !(c.limit_high != null && b.value > c.limit_high); }
    else { if (b.ok == null) throw new HttpError(400, 'Say whether the control is working (OK or not OK)'); ok = !!b.ok; }
    if (!ok && !hasLimits && !(b.note && b.note.trim().length >= 5)) throw new HttpError(400, 'Describe what is wrong');
    const at = b.checked_at || new Date().toISOString(); if (at > new Date(Date.now() + 5 * 60e3).toISOString()) throw new HttpError(400, 'Time is in the future');
    let alertId = null; const key = `wsp-breach-${c.id}`;
    if (!ok && !quietAlert) {
      const open = db.get(`SELECT id FROM alerts WHERE dedupe_key LIKE ? AND status NOT IN ('resolved','dismissed')`, key + '-%');
      alertId = open ? open.id : require('./alerts').raise(ctx, { rule_type: 'wsp_limit', severity: { very_high: 'critical', high: 'high' }[band(h.likelihood * h.severity)] || 'medium',
        title: `Water safety limit breached: ${c.description}`,
        description: `${h.ref} — ${h.event}${h.asset_name ? ' (' + h.asset_name + ')' : ''}.\n${hasLimits ? `Measured ${b.value}${c.unit ? ' ' + c.unit : ''}; limit ${limitText(c)}.` : b.note}\nCorrective action: ${c.corrective_action || 'none written — add one to the control measure'}`,
        asset_id: h.asset_id, area_id: h.area_id, lat: h.lat, lng: h.lng, source: 'wsp', data_basis: b.wq_test_id ? 'measured' : 'manual', dedupe_key: `${key}-${at.slice(0, 10)}-${Date.now()}` });
    }
    if (ok) db.run(`UPDATE alerts SET status='resolved', resolved_at=?, resolution_note=? WHERE dedupe_key LIKE ? AND status NOT IN ('resolved','dismissed')`, new Date().toISOString(), 'Control back within limits at the next check', key + '-%');
    const ins = db.run('INSERT INTO wsp_monitoring(control_id, checked_at, value, ok, note, user_id, alert_id, wq_test_id, client_uuid) VALUES (?,?,?,?,?,?,?,?,?)', c.id, at, b.value ?? null, ok ? 1 : 0, b.note || null, ctx && ctx.user ? ctx.user.id : null, alertId, b.wq_test_id || null, b.client_uuid || null);
    audit.log(ctx, 'wsp.check', 'wsp_hazard', h.id, { control_id: c.id, value: b.value, ok, alert_id: alertId });
    return { id: ins.id, ok, alert_id: alertId, corrective_action: ok ? null : c.corrective_action, limit: limitText(c) };
  });
}
/** A water-quality test at an asset counts as a monitoring check for every control on that asset with the same parameter. */
function onWqTest(ctx, t) {
  const rows = db.all(`SELECT c.id FROM wsp_controls c JOIN wsp_hazards h ON h.id=c.hazard_id WHERE c.active=1 AND h.status='open' AND c.parameter=? AND h.asset_id=?`, t.parameter, t.asset_id);
  const out = [];
  for (const c of rows) { try { out.push(check(ctx, c.id, { value: t.value, checked_at: t.sampled_at, wq_test_id: t.id, note: 'From water-quality test' }, { quietAlert: t.result === 'fail' })); } catch (_) { /* never block the test itself */ } }
  return out;
}
function monitoring({ area_id } = {}) {
  const controls = db.all(`SELECT c.*, h.ref, h.event, h.step, h.likelihood, h.severity, h.asset_id, h.area_id, s.name asset_name, a.name area_name, u.full_name responsible_name, p.name parameter_name
    FROM wsp_controls c JOIN wsp_hazards h ON h.id=c.hazard_id LEFT JOIN assets s ON s.id=h.asset_id LEFT JOIN service_areas a ON a.id=h.area_id LEFT JOIN users u ON u.id=c.responsible_id LEFT JOIN wq_parameters p ON p.code=c.parameter
    WHERE c.active=1 AND h.status='open' ${area_id ? 'AND h.area_id=?' : ''}`, ...(area_id ? [area_id] : []))
    .map(c => ({ ...c, limit_text: limitText(c), risk: band(c.likelihood * c.severity), status: controlStatus(c) }));
  const order = { breach: 0, overdue: 1, not_checked: 2, ok: 3 };
  controls.sort((x, y) => order[x.status.state] - order[y.status.state] || (x.status.days_left ?? 1e9) - (y.status.days_left ?? 1e9));
  const log = db.all(`SELECT m.*, c.description, c.unit, h.ref, h.id hazard_id, s.name asset_name, u.full_name user_name FROM wsp_monitoring m JOIN wsp_controls c ON c.id=m.control_id JOIN wsp_hazards h ON h.id=c.hazard_id
    LEFT JOIN assets s ON s.id=h.asset_id LEFT JOIN users u ON u.id=m.user_id ${area_id ? 'WHERE h.area_id=?' : ''} ORDER BY m.checked_at DESC, m.id DESC LIMIT 100`, ...(area_id ? [area_id] : []));
  return { controls, log };
}

// ---------------- hazards ----------------
function enrich(h) {
  const controls = controlsOf(h.id); const active = controls.filter(c => c.active);
  const raw = h.likelihood * h.severity; const res = h.res_likelihood && h.res_severity ? h.res_likelihood * h.res_severity : null;
  const states = active.map(c => c.status.state);
  return { ...h, raw_score: raw, raw_band: band(raw), res_score: res, res_band: band(res), controls,
    control_state: !active.length ? 'no_controls' : states.includes('breach') ? 'breach' : states.includes('overdue') ? 'overdue' : states.includes('not_checked') ? 'not_checked' : 'ok',
    review_overdue: !!(h.review_due && h.review_due < today()),
    actions: db.all(`SELECT a.*, u.full_name owner_name, w.wo_number, w.status wo_status FROM wsp_actions a LEFT JOIN users u ON u.id=a.owner_id LEFT JOIN work_orders w ON w.id=a.work_order_id WHERE a.hazard_id=? ORDER BY a.id`, h.id) };
}
const H_SQL = `SELECT h.*, s.name asset_name, s.code asset_code, s.asset_type, a.name area_name, u.full_name owner_name FROM wsp_hazards h LEFT JOIN assets s ON s.id=h.asset_id LEFT JOIN service_areas a ON a.id=h.area_id LEFT JOIN users u ON u.id=h.owner_id`;
function hazards({ area_id, asset_id, status = 'open' } = {}) {
  const w = [], p = [];
  if (area_id) { w.push('h.area_id=?'); p.push(area_id); } if (asset_id) { w.push('h.asset_id=?'); p.push(asset_id); } if (status && status !== 'all') { w.push('h.status=?'); p.push(status); }
  return db.all(`${H_SQL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`, ...p).map(enrich)
    .sort((x, y) => (y.res_score ?? y.raw_score) - (x.res_score ?? x.raw_score) || y.raw_score - x.raw_score || x.id - y.id);
}
function hazard(id) {
  const h = db.get(`${H_SQL} WHERE h.id=?`, id); if (!h) throw new HttpError(404, 'Hazard not found');
  const out = enrich(h);
  out.monitoring = db.all(`SELECT m.*, c.description, c.unit, u.full_name user_name FROM wsp_monitoring m JOIN wsp_controls c ON c.id=m.control_id LEFT JOIN users u ON u.id=m.user_id WHERE c.hazard_id=? ORDER BY m.checked_at DESC, m.id DESC LIMIT 60`, id);
  return out;
}
function saveHazard(ctx, id, b) {
  if ((b.res_likelihood == null) !== (b.res_severity == null)) throw new HttpError(400, 'Give both the likelihood and the severity after controls, or leave both empty');
  if (b.res_likelihood != null && b.res_likelihood * b.res_severity > b.likelihood * b.severity) throw new HttpError(400, 'The risk after controls cannot be higher than the risk before controls');
  if (b.asset_id) { const s = db.get('SELECT area_id FROM assets WHERE id=?', b.asset_id); if (!s) throw new HttpError(400, 'Unknown asset'); b.area_id = b.area_id || s.area_id; }
  if (b.area_id && !db.get('SELECT 1 FROM service_areas WHERE id=?', b.area_id)) throw new HttpError(400, 'Unknown service area');
  const f = [b.area_id || null, b.asset_id || null, b.step, b.hazard_type || 'microbial', b.event, b.cause || null, b.likelihood, b.severity, b.res_likelihood ?? null, b.res_severity ?? null, b.owner_id || null, b.review_due || null, b.status || 'open'];
  if (id) {
    if (!db.get('SELECT 1 FROM wsp_hazards WHERE id=?', id)) throw new HttpError(404, 'Hazard not found');
    db.run('UPDATE wsp_hazards SET area_id=?, asset_id=?, step=?, hazard_type=?, event=?, cause=?, likelihood=?, severity=?, res_likelihood=?, res_severity=?, owner_id=?, review_due=?, status=? WHERE id=?', ...f, id);
  } else {
    const ref = nextRef();
    id = db.run(`INSERT INTO wsp_hazards(ref, area_id, asset_id, step, hazard_type, event, cause, likelihood, severity, res_likelihood, res_severity, owner_id, review_due, status, origin, inspection_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ref, ...f.slice(0, 11), b.review_due || new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10), f[12], b.origin || 'manual', b.inspection_id || null, ctx && ctx.user ? ctx.user.id : null).id;
  }
  audit.log(ctx, 'wsp.hazard', 'wsp_hazard', id, { event: b.event, likelihood: b.likelihood, severity: b.severity, res_likelihood: b.res_likelihood, res_severity: b.res_severity, status: b.status });
  return { id, ref: db.get('SELECT ref FROM wsp_hazards WHERE id=?', id).ref };
}
/** Annual (or after-incident) review: confirm the scores still hold and set the next review date. */
function review(ctx, id, b) {
  const h = db.get('SELECT * FROM wsp_hazards WHERE id=?', id); if (!h) throw new HttpError(404, 'Hazard not found');
  const next = b.next_review || new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10);
  db.run('UPDATE wsp_hazards SET last_reviewed_at=?, review_due=? WHERE id=?', new Date().toISOString(), next, id);
  audit.log(ctx, 'wsp.review', 'wsp_hazard', id, { note: b.note, next_review: next });
  return { ok: true, review_due: next };
}

// ---------------- starter library ----------------
const library = () => ({ note: LIB.note, templates: LIB.templates.map(t => ({ key: t.key, title: t.title, hazards: t.hazards })), forms: LIB.forms });
/** Copy a starter template into the register for one area (and optionally one asset). Hazards already present are skipped. */
function applyTemplate(ctx, { template, area_id, asset_id }) {
  const t = LIB.templates.find(x => x.key === template); if (!t) throw new HttpError(400, 'Unknown template');
  if (asset_id) { const s = db.get('SELECT area_id FROM assets WHERE id=?', asset_id); if (!s) throw new HttpError(400, 'Unknown asset'); area_id = area_id || s.area_id; }
  if (!area_id) throw new HttpError(400, 'Choose a service area or an asset');
  return db.tx(() => {
    let added = 0, skipped = 0;
    for (const hz of t.hazards) {
      if (db.get(`SELECT 1 FROM wsp_hazards WHERE event=? AND status='open' AND area_id=? AND COALESCE(asset_id,0)=?`, hz.event, area_id, asset_id || 0)) { skipped++; continue; }
      const { id } = saveHazard(ctx, null, { area_id, asset_id: asset_id || null, step: hz.step, hazard_type: hz.type, event: hz.event, likelihood: hz.l, severity: hz.s, origin: 'library' });
      for (const c of hz.controls || []) saveControl(ctx, id, null, { description: c.description, parameter: asset_id ? c.parameter : null, limit_low: c.low, limit_high: c.high, unit: c.unit, frequency_days: c.freq, corrective_action: c.corrective });
      added++;
    }
    return { added, skipped, template: t.title };
  });
}

// ---------------- sanitary inspections ----------------
const siLevel = p => (p > 80 ? 'very_high' : p > 50 ? 'high' : p > 20 ? 'medium' : 'low');
/** E. coli grade from the latest test in the last 90 days (CFU/100 mL): A <1, B 1-10, C 11-100, D >100. */
function ecoliGrade(assetId) {
  const t = db.get(`SELECT value, sampled_at FROM wq_tests WHERE asset_id=? AND parameter='ecoli' AND sampled_at >= ? ORDER BY sampled_at DESC, id DESC LIMIT 1`, assetId, new Date(Date.now() - 90 * DAY).toISOString());
  if (!t) return null;
  return { grade: t.value < 1 ? 'A' : t.value <= 10 ? 'B' : t.value <= 100 ? 'C' : 'D', value: t.value, sampled_at: t.sampled_at };
}
/** Priority for action = the worse of the sanitary risk and the E. coli grade. */
function priorityOf(level, eg) { const i = Math.max(level ? BANDS.indexOf(level) : -1, eg ? 'ABCD'.indexOf(eg.grade) : -1); return i < 0 ? null : ['low', 'medium', 'high', 'very_high'][i]; }
function formFor(asset) { return LIB.forms.filter(f => f.asset_types.includes(asset.asset_type)); }
function recordInspection(ctx, b) {
  return db.tx(() => {
    if (b.client_uuid) { const ex = db.get('SELECT * FROM wsp_inspections WHERE client_uuid=?', b.client_uuid); if (ex) return { ...ex, duplicate: true }; }
    const asset = db.get('SELECT * FROM assets WHERE id=?', b.asset_id); if (!asset) throw new HttpError(404, 'Asset not found');
    const form = LIB.forms.find(f => f.key === b.form); if (!form) throw new HttpError(400, 'Unknown inspection form');
    const ans = {}; for (const it of form.items) { const v = (b.answers || {})[it.id]; if (v !== true && v !== false) throw new HttpError(400, 'Answer every question (yes or no)'); ans[it.id] = v; }
    const yes = form.items.filter(it => ans[it.id]); const level = siLevel(yes.length / form.items.length * 100);
    const at = b.inspected_at || new Date().toISOString(); if (at > new Date(Date.now() + 5 * 60e3).toISOString()) throw new HttpError(400, 'Time is in the future');
    const ins = db.run('INSERT INTO wsp_inspections(asset_id, form, answers_json, risk_count, total, risk_level, inspected_at, user_id, notes, lat, lng, client_uuid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      asset.id, form.key, JSON.stringify(ans), yes.length, form.items.length, level, at, ctx && ctx.user ? ctx.user.id : null, b.notes || null, b.lat ?? null, b.lng ?? null, b.client_uuid || null);
    db.run('UPDATE assets SET next_inspection_due=? WHERE id=?', new Date(Date.parse(at) + db.settingNum('wsp_inspection_days', 180) * DAY).toISOString().slice(0, 10), asset.id);
    let hazardsAdded = 0, actionsAdded = 0;
    if (b.create_hazards !== false) for (const it of yes) {
      let h = db.get(`SELECT id FROM wsp_hazards WHERE asset_id=? AND event=? AND status='open'`, asset.id, it.q);
      if (!h) { h = saveHazard(ctx, null, { asset_id: asset.id, area_id: asset.area_id, step: it.step, hazard_type: it.type || 'microbial', event: it.q, likelihood: 4, severity: it.s, origin: 'inspection', inspection_id: ins.id, cause: 'Found during sanitary inspection' }); hazardsAdded++; }
      if (!db.get(`SELECT 1 FROM wsp_actions WHERE hazard_id=? AND status IN ('planned','in_progress')`, h.id)) {
        db.run('INSERT INTO wsp_actions(hazard_id, title, description, due_date, status, created_by) VALUES (?,?,?,?,?,?)', h.id, it.fix, `From the sanitary inspection of ${asset.name} on ${at.slice(0, 10)}.`, new Date(Date.parse(at) + (it.s >= 5 ? 14 : 30) * DAY).toISOString().slice(0, 10), 'planned', ctx && ctx.user ? ctx.user.id : null); actionsAdded++; }
    }
    const eg = ecoliGrade(asset.id);
    audit.log(ctx, 'wsp.inspection', 'asset', asset.id, { form: form.key, risks: yes.length, of: form.items.length, level, hazards_added: hazardsAdded });
    return { id: ins.id, risk_count: yes.length, total: form.items.length, risk_level: level, priority: priorityOf(level, eg), ecoli: eg, hazards_added: hazardsAdded, actions_added: actionsAdded };
  });
}
/** Latest inspection per inspectable asset, with the E. coli grade and the combined priority. */
function inspections({ area_id } = {}) {
  const days = db.settingNum('wsp_inspection_days', 180); const since = new Date(Date.now() - days * DAY).toISOString();
  const types = [...new Set(LIB.forms.flatMap(f => f.asset_types))];
  const assets = db.all(`SELECT s.id, s.code, s.name, s.asset_type, s.status, s.area_id, a.name area_name FROM assets s LEFT JOIN service_areas a ON a.id=s.area_id WHERE s.status != 'decommissioned' AND s.asset_type IN (${types.map(() => '?').join(',')}) ${area_id ? 'AND s.area_id=?' : ''} ORDER BY a.name, s.name`, ...types, ...(area_id ? [area_id] : []));
  const rows = assets.map(s => {
    const last = db.get('SELECT i.*, u.full_name user_name FROM wsp_inspections i LEFT JOIN users u ON u.id=i.user_id WHERE i.asset_id=? ORDER BY inspected_at DESC, id DESC LIMIT 1', s.id) || null;
    const eg = ecoliGrade(s.id);
    return { ...s, forms: formFor(s).map(f => f.key), last, due: !last || last.inspected_at < since, ecoli: eg, priority: priorityOf(last ? last.risk_level : null, eg) };
  });
  rows.sort((x, y) => BANDS.indexOf(y.priority) - BANDS.indexOf(x.priority) || Number(y.due) - Number(x.due));
  return { days, rows, forms: LIB.forms };
}
function inspection(id) {
  const i = db.get('SELECT i.*, s.name asset_name, u.full_name user_name FROM wsp_inspections i JOIN assets s ON s.id=i.asset_id LEFT JOIN users u ON u.id=i.user_id WHERE i.id=?', id); if (!i) throw new HttpError(404, 'Not found');
  const form = LIB.forms.find(f => f.key === i.form); const ans = JSON.parse(i.answers_json);
  return { ...i, form_title: form ? form.title : i.form, items: (form ? form.items : []).map(it => ({ id: it.id, q: it.q, fix: it.fix, yes: !!ans[it.id] })) };
}

// ---------------- improvement plan ----------------
function actions({ status, area_id } = {}) {
  const w = [], p = []; if (status === 'open') w.push(`a.status IN ('planned','in_progress')`); else if (status && status !== 'all') { w.push('a.status=?'); p.push(status); }
  if (area_id) { w.push('h.area_id=?'); p.push(area_id); }
  return db.all(`SELECT a.*, h.ref, h.event, h.likelihood, h.severity, h.asset_id, s.name asset_name, ar.name area_name, u.full_name owner_name, w.wo_number, w.status wo_status
    FROM wsp_actions a LEFT JOIN wsp_hazards h ON h.id=a.hazard_id LEFT JOIN assets s ON s.id=h.asset_id LEFT JOIN service_areas ar ON ar.id=h.area_id LEFT JOIN users u ON u.id=a.owner_id LEFT JOIN work_orders w ON w.id=a.work_order_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, a.due_date IS NULL, a.due_date, a.id`, ...p)
    .map(a => ({ ...a, risk: a.likelihood ? band(a.likelihood * a.severity) : null, overdue: ['planned', 'in_progress'].includes(a.status) && !!a.due_date && a.due_date < today() }));
}
function saveAction(ctx, id, b) {
  if (b.hazard_id && !db.get('SELECT 1 FROM wsp_hazards WHERE id=?', b.hazard_id)) throw new HttpError(400, 'Unknown hazard');
  if (b.cost != null && !b.currency) b.currency = require('../lib/i18n').currencies()[0];
  const done = b.status === 'done' ? new Date().toISOString() : null;
  const f = [b.hazard_id || null, b.title, b.description || null, b.owner_id || null, b.due_date || null, b.cost ?? null, b.cost != null ? b.currency : null, b.status || 'planned'];
  if (id) {
    const a = db.get('SELECT * FROM wsp_actions WHERE id=?', id); if (!a) throw new HttpError(404, 'Not found');
    db.run('UPDATE wsp_actions SET hazard_id=?, title=?, description=?, owner_id=?, due_date=?, cost=?, currency=?, status=?, completed_at=? WHERE id=?', ...f, b.status === 'done' ? (a.completed_at || done) : null, id);
  } else id = db.run('INSERT INTO wsp_actions(hazard_id, title, description, owner_id, due_date, cost, currency, status, completed_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)', ...f, done, ctx.user.id).id;
  audit.log(ctx, 'wsp.action', 'wsp_action', id, b);
  return { id };
}
/** Turn an improvement action into a work order for the technicians; completing the work order completes the action. */
function actionToWorkOrder(ctx, id, b = {}) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM wsp_actions WHERE id=?', id); if (!a) throw new HttpError(404, 'Not found');
    if (a.work_order_id) throw new HttpError(409, 'This action already has a work order');
    if (!['planned', 'in_progress'].includes(a.status)) throw new HttpError(400, 'This action is already closed');
    const h = a.hazard_id ? db.get('SELECT h.*, s.lat, s.lng FROM wsp_hazards h LEFT JOIN assets s ON s.id=h.asset_id WHERE h.id=?', a.hazard_id) : null;
    if (b.assigned_to) { const t = db.get('SELECT role FROM users WHERE id=? AND active=1', b.assigned_to); if (!t || !['technician', 'manager', 'admin'].includes(t.role)) throw new HttpError(400, 'Work orders can only be assigned to active technicians or managers'); }
    const num = require('./billing').nextNumber('wo', n => 'WO-' + n);
    const pr = h ? { very_high: 'critical', high: 'high', medium: 'medium', low: 'low' }[band(h.likelihood * h.severity)] : 'medium';
    const wo = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, asset_id, area_id, lat, lng, assigned_to, status, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, num, 'other', pr, a.title,
      `Water Safety Plan improvement${h ? ` for ${h.ref}: ${h.event}` : ''}.${a.description ? '\n' + a.description : ''}`, h ? h.asset_id : null, h ? h.area_id : null, h ? h.lat : null, h ? h.lng : null, b.assigned_to || null, b.assigned_to ? 'assigned' : 'open', a.due_date, ctx.user.id).id;
    db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', wo, ctx.user.id, b.assigned_to ? 'assigned' : 'open', 'Created from the Water Safety Plan improvement plan');
    db.run(`UPDATE wsp_actions SET work_order_id=?, status='in_progress' WHERE id=?`, wo, id);
    audit.log(ctx, 'wsp.action_wo', 'wsp_action', id, { wo_number: num });
    return { id: wo, wo_number: num };
  });
}
function onWorkOrderCompleted(wo) { db.run(`UPDATE wsp_actions SET status='done', completed_at=? WHERE work_order_id=? AND status IN ('planned','in_progress')`, new Date().toISOString(), wo.id); }

// ---------------- overview ----------------
function summary({ area_id } = {}) {
  const hz = hazards({ area_id });
  const grid = () => Array.from({ length: 5 }, () => Array(5).fill(0)); // [severity-1][likelihood-1]
  const raw = grid(), res = grid();
  for (const h of hz) { raw[h.severity - 1][h.likelihood - 1]++; res[(h.res_severity || h.severity) - 1][(h.res_likelihood || h.likelihood) - 1]++; }
  const count = k => Object.fromEntries(BANDS.map(b => [b, hz.filter(h => (k === 'raw' ? h.raw_band : h.res_band || h.raw_band) === b).length]));
  const mon = monitoring({ area_id }).controls; const act = actions({ status: 'open', area_id }); const ins = inspections({ area_id });
  const significant = hz.filter(h => h.raw_score >= 10);
  const areas = db.all(`SELECT id FROM service_areas WHERE active=1 ${area_id ? 'AND id=?' : ''}`, ...(area_id ? [area_id] : []));
  const scheduled = mon.filter(c => c.frequency_days);
  const wq = require('./quality').summary();
  const parts = [
    { key: 'hazards', label: 'Areas with hazards identified', value: pct(areas.filter(a => hz.some(h => h.area_id === a.id)).length, areas.length), link: '#/water-safety?tab=register', tip: 'Start the register for every service area — use a starter template.' },
    { key: 'controls', label: 'High risks with a control measure', value: significant.length ? pct(significant.filter(h => h.controls.some(c => c.active)).length, significant.length) : null, link: '#/water-safety?tab=register', tip: 'Add a control measure to every high or very high risk.' },
    { key: 'residual', label: 'Risks re-scored after controls', value: hz.length ? pct(hz.filter(h => h.res_score != null).length, hz.length) : null, link: '#/water-safety?tab=register', tip: 'Score each risk again with its controls in place.' },
    { key: 'monitoring', label: 'Monitoring checks done on time', value: scheduled.length ? pct(scheduled.filter(c => c.status.state === 'ok').length, scheduled.length) : null, link: '#/water-safety?tab=monitoring', tip: 'Do the overdue checks and fix the controls outside their limits.' },
    { key: 'verification', label: 'Sampling points tested on schedule', value: wq.coverage_pct, link: '#/water-quality', tip: 'Test chlorine and E. coli at the points that are due.' },
    { key: 'inspections', label: 'Sites inspected on schedule', value: ins.rows.length ? pct(ins.rows.filter(r => !r.due).length, ins.rows.length) : null, link: '#/water-safety?tab=inspections', tip: 'Carry out the sanitary inspections that are due.' },
    { key: 'actions', label: 'Improvement actions on time', value: act.length ? pct(act.filter(a => !a.overdue).length, act.length) : null, link: '#/water-safety?tab=plan', tip: 'Finish or re-plan the overdue improvement actions.' },
    { key: 'reviews', label: 'Risks reviewed within the last year', value: hz.length ? pct(hz.filter(h => !h.review_overdue).length, hz.length) : null, link: '#/water-safety?tab=register', tip: 'Review the risks whose review date has passed.' }
  ];
  const scored = parts.filter(p => p.value != null);
  const score = hz.length && scored.length ? Math.round(scored.reduce((s, p) => s + p.value, 0) / scored.length) : hz.length ? 0 : null;
  const next = !hz.length ? [parts[0]] : [...scored].filter(p => p.value < 100).sort((a, b) => a.value - b.value).slice(0, 3);
  return { score, parts, next, hazards: hz.length, bands_raw: count('raw'), bands_residual: count('res'), matrix_raw: raw, matrix_residual: res,
    top: hz.slice(0, 6).map(h => ({ id: h.id, ref: h.ref, event: h.event, step: h.step, asset_name: h.asset_name, area_name: h.area_name, raw_score: h.raw_score, raw_band: h.raw_band, res_score: h.res_score, res_band: h.res_band, control_state: h.control_state })),
    monitoring: { total: mon.length, breach: mon.filter(c => c.status.state === 'breach').length, overdue: mon.filter(c => ['overdue'].includes(c.status.state)).length, ok: mon.filter(c => c.status.state === 'ok').length },
    actions: { open: act.length, overdue: act.filter(a => a.overdue).length, cost: Object.entries(act.reduce((m, a) => { if (a.cost != null) m[a.currency] = (m[a.currency] || 0) + a.cost; return m; }, {})).map(([currency, amount]) => ({ currency, amount })) },
    inspections: { total: ins.rows.length, due: ins.rows.filter(r => r.due).length, high: ins.rows.filter(r => ['high', 'very_high'].includes(r.priority)).length } };
}
/** Once a day: one alert for each overdue monitoring check on a high or very high risk. */
function runDaily(ctx = {}) {
  let raised = 0;
  for (const c of monitoring().controls.filter(x => x.status.state === 'overdue' && x.frequency_days && ['high', 'very_high'].includes(x.risk))) {
    const id = require('./alerts').raise({ ...ctx, actor: ctx.user ? undefined : 'scheduler' }, { rule_type: 'wsp_monitoring_overdue', severity: 'medium', title: `Water safety check overdue: ${c.description}`,
      description: `${c.ref} — ${c.event}${c.asset_name ? ' (' + c.asset_name + ')' : ''}. Due every ${c.frequency_days} day(s); last checked ${c.status.last ? c.status.last.checked_at.slice(0, 10) : 'never'}.`,
      asset_id: c.asset_id, area_id: c.area_id, source: 'wsp', data_basis: 'manual', dedupe_key: `wsp-due-${c.id}-${(c.status.due_at || '').slice(0, 10)}` });
    if (id) raised++;
  }
  db.run(`INSERT INTO settings(key,value) VALUES('last_wsp_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, new Date().toISOString());
  return { raised };
}
/** Lines for the manager's morning briefing. */
function briefingItems() {
  if (!db.get('SELECT 1 FROM wsp_hazards LIMIT 1')) return [];
  const s = summary(); const out = [];
  if (s.monitoring.breach) out.push({ severity: 'critical', title: `${s.monitoring.breach} water safety control(s) outside their limits`, detail: 'Carry out the corrective action written on the control, then check again', link: '#/water-safety?tab=monitoring' });
  if (s.monitoring.overdue) out.push({ severity: 'high', title: `${s.monitoring.overdue} water safety check(s) overdue`, detail: 'Operational monitoring keeps the controls working', link: '#/water-safety?tab=monitoring' });
  if (s.actions.overdue) out.push({ severity: 'medium', title: `${s.actions.overdue} water safety improvement action(s) overdue`, detail: 'Finish them or agree a new date', link: '#/water-safety?tab=plan' });
  if (s.inspections.high) out.push({ severity: 'high', title: `${s.inspections.high} water point(s) rated high priority by sanitary inspection or E. coli`, detail: 'Fix the risks found and re-test', link: '#/water-safety?tab=inspections' });
  return out;
}

module.exports = { STEPS, TYPES, BANDS, band, hazards, hazard, saveHazard, review, saveControl, check, onWqTest, monitoring, library, applyTemplate, recordInspection, inspections, inspection,
  actions, saveAction, actionToWorkOrder, onWorkOrderCompleted, summary, runDaily, briefingItems, ecoliGrade, priorityOf };
