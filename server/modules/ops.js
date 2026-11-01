'use strict';
const { route, HttpError } = require('../lib/http');
const { validate, id } = require('../lib/validate');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const db = require('../lib/db');
const alerts = require('../services/alerts');
const billing = require('../services/billing');

// ================= Alerts =================
route('GET', '/api/alerts', { perm: 'alerts.view' }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (q.status === 'open_all') where.push(`al.status IN ('open','acknowledged','work_order')`); else if (q.status) { where.push('al.status=?'); p.push(q.status); }
  if (q.severity) { where.push('al.severity=?'); p.push(q.severity); }
  if (q.rule_type) { where.push('al.rule_type=?'); p.push(q.rule_type); }
  if (q.area_id) { where.push('al.area_id=?'); p.push(Number(q.area_id)); }
  if (q.mine) { where.push('al.assigned_to=?'); p.push(ctx.user.id); }
  return db.all(`SELECT al.*, c.name customer_name, c.customer_number, c.address, m.serial_number, s.name asset_name, a.name area_name, u.full_name assigned_name,
    (SELECT wo_number FROM work_orders w WHERE w.alert_id=al.id ORDER BY id DESC LIMIT 1) wo_number
    FROM alerts al LEFT JOIN customers c ON c.id=al.customer_id LEFT JOIN meters m ON m.id=al.meter_id LEFT JOIN assets s ON s.id=al.asset_id
    LEFT JOIN service_areas a ON a.id=al.area_id LEFT JOIN users u ON u.id=al.assigned_to ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE al.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'work_order' THEN 2 ELSE 3 END, CASE al.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, al.detected_at DESC LIMIT 1000`, ...p);
});
route('POST', '/api/alerts/run', { perm: 'alerts.run' }, ctx => alerts.run(ctx));
route('POST', '/api/alerts', { perm: 'alerts.manage' }, ctx => {
  const b = validate(ctx.body, { title: { type: 'string', required: true, max: 160 }, description: { type: 'text', max: 2000 }, severity: { type: 'enum', values: ['low', 'medium', 'high', 'critical'], required: true },
    rule_type: { type: 'enum', values: ['suspected_leak', 'sudden_high', 'zero_consumption', 'device_event', 'missing_reading', 'device_health', 'supply_imbalance', 'customer_report', 'water_quality', 'other'], default: 'customer_report' },
    customer_id: { type: 'integer' }, meter_id: { type: 'integer' }, asset_id: { type: 'integer' }, area_id: { type: 'integer' }, lat: { type: 'lat' }, lng: { type: 'lng' }, assigned_to: { type: 'integer' } });
  if (b.customer_id && (b.lat == null || !b.area_id)) { const c = db.get('SELECT * FROM customers WHERE id=?', b.customer_id); if (c) { b.lat ??= c.lat; b.lng ??= c.lng; b.area_id ??= c.area_id; } }
  if (b.asset_id && b.lat == null) { const s = db.get('SELECT * FROM assets WHERE id=?', b.asset_id); if (s) { b.lat = s.lat; b.lng = s.lng; b.area_id ??= s.area_id; } }
  const aid = alerts.raise(ctx, { ...b, source: 'manual', data_basis: 'manual' });
  if (b.assigned_to) db.run('UPDATE alerts SET assigned_to=? WHERE id=?', b.assigned_to, aid);
  return { id: aid };
});
route('POST', '/api/alerts/:id/update', { perm: 'alerts.manage' }, ctx => {
  const aid = id(ctx.params.id);
  const b = validate(ctx.body, { status: { type: 'enum', values: ['open', 'acknowledged', 'resolved', 'dismissed'] }, assigned_to: { type: 'integer' }, note: { type: 'string', max: 500 } });
  const a = db.get('SELECT * FROM alerts WHERE id=?', aid); if (!a) throw new HttpError(404, 'Alert not found');
  if (['resolved', 'dismissed'].includes(b.status) && !b.note) throw new HttpError(400, 'A note is required to resolve or dismiss an alert');
  db.run(`UPDATE alerts SET status=COALESCE(?, status), assigned_to=COALESCE(?, assigned_to), resolution_note=COALESCE(?, resolution_note), resolved_at=CASE WHEN ? IN ('resolved','dismissed') THEN ? ELSE resolved_at END WHERE id=?`,
    b.status, b.assigned_to, b.note, b.status, new Date().toISOString(), aid);
  audit.log(ctx, 'alert.update', 'alert', aid, { from: { status: a.status, assigned_to: a.assigned_to }, to: b });
  const notified = ['resolved', 'dismissed'].includes(b.status) ? require('../services/community').closeLoop(aid) : 0;
  return { ok: true, reporters_notified: notified };
});

// ================= Work orders =================
const woSchema = { type: { type: 'enum', values: ['leak', 'meter', 'network', 'connection', 'inspection', 'other'], required: true }, priority: { type: 'enum', values: ['low', 'medium', 'high', 'critical'], required: true },
  title: { type: 'string', required: true, max: 160 }, description: { type: 'text', max: 2000 }, alert_id: { type: 'integer' }, customer_id: { type: 'integer' }, meter_id: { type: 'integer' },
  asset_id: { type: 'integer' }, area_id: { type: 'integer' }, lat: { type: 'lat' }, lng: { type: 'lng' }, assigned_to: { type: 'integer' }, due_date: { type: 'date' } };
route('GET', '/api/work-orders', { perm: 'workorders.view' }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (ctx.user.role === 'technician' && !q.all) { where.push('(w.assigned_to=? OR w.assigned_to IS NULL)'); p.push(ctx.user.id); }
  if (q.status === 'active') where.push(`w.status NOT IN ('completed','cancelled')`); else if (q.status) { where.push('w.status=?'); p.push(q.status); }
  if (q.type) { where.push('w.type=?'); p.push(q.type); }
  if (q.area_id) { where.push('w.area_id=?'); p.push(Number(q.area_id)); }
  if (q.assigned_to) { where.push('w.assigned_to=?'); p.push(Number(q.assigned_to)); }
  return db.all(`SELECT w.*, c.name customer_name, c.customer_number, c.address, m.serial_number, s.name asset_name, a.name area_name, u.full_name assigned_name FROM work_orders w
    LEFT JOIN customers c ON c.id=w.customer_id LEFT JOIN meters m ON m.id=w.meter_id LEFT JOIN assets s ON s.id=w.asset_id LEFT JOIN service_areas a ON a.id=w.area_id LEFT JOIN users u ON u.id=w.assigned_to
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE WHEN w.status IN ('completed','cancelled') THEN 1 ELSE 0 END, CASE w.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, w.created_at DESC LIMIT 1000`, ...p);
});
route('GET', '/api/work-orders/:id', { perm: 'workorders.view' }, ctx => {
  const w = db.get(`SELECT w.*, c.name customer_name, c.customer_number, c.address, c.phone customer_phone, m.serial_number, s.name asset_name, a.name area_name, u.full_name assigned_name, al.title alert_title, al.data_basis
    FROM work_orders w LEFT JOIN customers c ON c.id=w.customer_id LEFT JOIN meters m ON m.id=w.meter_id LEFT JOIN assets s ON s.id=w.asset_id LEFT JOIN service_areas a ON a.id=w.area_id
    LEFT JOIN users u ON u.id=w.assigned_to LEFT JOIN alerts al ON al.id=w.alert_id WHERE w.id=?`, id(ctx.params.id));
  if (!w) throw new HttpError(404, 'Work order not found');
  if (ctx.user.role === 'technician' && w.assigned_to && w.assigned_to !== ctx.user.id) throw new HttpError(403, 'This work order is assigned to another technician');
  return { work_order: w, updates: db.all('SELECT wu.*, u.full_name user_name FROM work_order_updates wu LEFT JOIN users u ON u.id=wu.user_id WHERE work_order_id=? ORDER BY wu.id', w.id) };
});
route('POST', '/api/work-orders', { perm: 'workorders.manage' }, ctx => {
  const b = validate(ctx.body, woSchema);
  return db.tx(() => {
    if (b.alert_id) {
      const a = db.get('SELECT * FROM alerts WHERE id=?', b.alert_id); if (!a) throw new HttpError(400, 'Unknown alert');
      for (const k of ['customer_id', 'meter_id', 'asset_id', 'area_id', 'lat', 'lng']) b[k] ??= a[k];
      db.run(`UPDATE alerts SET status='work_order', assigned_to=COALESCE(?, assigned_to) WHERE id=?`, b.assigned_to, a.id);
    }
    if (b.customer_id && b.lat == null) { const c = db.get('SELECT * FROM customers WHERE id=?', b.customer_id); if (c) { b.lat = c.lat; b.lng = c.lng; b.area_id ??= c.area_id; } }
    if (b.assigned_to) { const t = db.get('SELECT role FROM users WHERE id=? AND active=1', b.assigned_to); if (!t || !['technician', 'manager', 'admin'].includes(t.role)) throw new HttpError(400, 'Work orders can only be assigned to active technicians or managers'); }
    const num = billing.nextNumber('wo', n => 'WO-' + n);
    const r = db.run(`INSERT INTO work_orders(wo_number, alert_id, type, priority, title, description, customer_id, meter_id, asset_id, area_id, lat, lng, assigned_to, status, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      num, b.alert_id, b.type, b.priority, b.title, b.description, b.customer_id, b.meter_id, b.asset_id, b.area_id, b.lat, b.lng, b.assigned_to, b.assigned_to ? 'assigned' : 'open', b.due_date, ctx.user.id);
    db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', r.id, ctx.user.id, b.assigned_to ? 'assigned' : 'open', 'Created' + (b.alert_id ? ' from alert #' + b.alert_id : ''));
    audit.log(ctx, 'work_order.create', 'work_order', r.id, { number: num, ...b });
    return { id: r.id, wo_number: num };
  });
});
route('POST', '/api/work-orders/:id/update', { anyPerm: ['workorders.update', 'workorders.manage'] }, ctx => {
  const wid = id(ctx.params.id);
  const b = validate(ctx.body, { status: { type: 'enum', values: ['open', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled'] }, note: { type: 'text', required: true, max: 2000 },
    assigned_to: { type: 'integer' }, priority: { type: 'enum', values: ['low', 'medium', 'high', 'critical'] }, resolve_alert: { type: 'boolean', default: true } });
  const w = db.get('SELECT * FROM work_orders WHERE id=?', wid); if (!w) throw new HttpError(404, 'Not found');
  const manager = auth.can(ctx.user, 'workorders.manage');
  if (!manager) {
    if (w.assigned_to && w.assigned_to !== ctx.user.id) throw new HttpError(403, 'Assigned to another technician');
    if (b.assigned_to && b.assigned_to !== ctx.user.id) throw new HttpError(403, 'Only managers can reassign work orders');
    if (b.status === 'cancelled' || b.priority) throw new HttpError(403, 'Only managers can cancel or re-prioritise');
    if (!w.assigned_to) b.assigned_to = ctx.user.id; // technician picks up an unassigned job
  }
  if (['completed', 'cancelled'].includes(w.status) && !manager) throw new HttpError(409, 'Work order is closed');
  db.tx(() => {
    db.run(`UPDATE work_orders SET status=COALESCE(?, status), assigned_to=COALESCE(?, assigned_to), priority=COALESCE(?, priority), completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,
      resolution=CASE WHEN ?='completed' THEN ? ELSE resolution END WHERE id=?`, b.status, b.assigned_to, b.priority, b.status, new Date().toISOString(), b.status, b.note, wid);
    db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', wid, ctx.user.id, b.status || w.status, b.note);
    if (b.status === 'completed' && w.alert_id && b.resolve_alert) db.run(`UPDATE alerts SET status='resolved', resolved_at=?, resolution_note=? WHERE id=?`, new Date().toISOString(), `Resolved by ${w.wo_number}: ${b.note}`, w.alert_id);
    audit.log(ctx, 'work_order.update', 'work_order', wid, { from: w.status, ...b });
    if (b.status === 'completed' && w.alert_id && b.resolve_alert) require('../services/community').closeLoop(w.alert_id);
    if (b.status === 'completed') require('../services/maintenance').onWorkOrderCompleted(w);
    if (b.status === 'completed' && w.customer_id && ['leak', 'network', 'meter', 'connection'].includes(w.type)) { // ask the customer how it went (once per job)
      const c = db.get('SELECT id, phone, area_id FROM customers WHERE id=?', w.customer_id);
      if (c && c.phone) require('../services/feedback').request(ctx, { work_order_id: wid, alert_id: w.alert_id, customer_id: c.id, phone: c.phone, area_id: c.area_id, technician_id: b.assigned_to || w.assigned_to, wo_number: w.wo_number });
    }
  });
  return { ok: true };
});

// ================= Network assets =================
const assetSchema = { code: { type: 'string', required: true, max: 30 }, name: { type: 'string', required: true, max: 120 },
  asset_type: { type: 'enum', values: ['source', 'treatment', 'pump', 'reservoir', 'pipe', 'district_meter', 'water_point', 'other'], required: true }, area_id: { type: 'integer' },
  lat: { type: 'lat' }, lng: { type: 'lng' }, status: { type: 'enum', values: ['operational', 'degraded', 'down', 'maintenance', 'planned', 'decommissioned'], default: 'operational' },
  served_population: { type: 'integer', minVal: 0, maxVal: 1000000 }, round_trip_min: { type: 'integer', minVal: 0, maxVal: 600 },
  capacity: { type: 'number', minVal: 0 }, capacity_unit: { type: 'string', max: 20 }, level_unit: { type: 'string', max: 20 }, install_year: { type: 'integer', minVal: 1900, maxVal: 2100 },
  description: { type: 'text', max: 2000 }, maintenance_needs: { type: 'text', max: 2000 }, next_inspection_due: { type: 'date' } };
route('GET', '/api/assets', { perm: 'assets.view' }, ctx => {
  const q = ctx.query; const where = []; const p = [];
  if (q.asset_type) { where.push('s.asset_type=?'); p.push(q.asset_type); }
  if (q.area_id) { where.push('s.area_id=?'); p.push(Number(q.area_id)); }
  if (q.status) { where.push('s.status=?'); p.push(q.status); }
  return db.all(`SELECT s.*, a.name area_name, (SELECT MAX(inspected_at) FROM asset_inspections i WHERE i.asset_id=s.id) last_inspection,
    (SELECT COUNT(*) FROM work_orders w WHERE w.asset_id=s.id AND w.status NOT IN ('completed','cancelled')) open_work_orders
    FROM assets s LEFT JOIN service_areas a ON a.id=s.area_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.asset_type, s.name`, ...p);
});
route('GET', '/api/assets/geojson', { perm: 'assets.view' }, () => ({ type: 'FeatureCollection', features: db.all('SELECT * FROM assets WHERE lat IS NOT NULL AND lng IS NOT NULL').map(s => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { id: s.id, code: s.code, name: s.name, asset_type: s.asset_type, status: s.status, level: s.current_level, level_source: s.level_source } })) }));
route('GET', '/api/assets/:id', { perm: 'assets.view' }, ctx => {
  const s = db.get('SELECT s.*, a.name area_name FROM assets s LEFT JOIN service_areas a ON a.id=s.area_id WHERE s.id=?', id(ctx.params.id)); if (!s) throw new HttpError(404, 'Asset not found');
  return { asset: s, inspections: db.all('SELECT i.*, u.full_name inspector_name FROM asset_inspections i LEFT JOIN users u ON u.id=i.inspector_id WHERE asset_id=? ORDER BY inspected_at DESC', s.id),
    telemetry: db.all('SELECT t.*, u.full_name entered_by_name FROM telemetry t LEFT JOIN users u ON u.id=t.entered_by WHERE asset_id=? ORDER BY recorded_at DESC LIMIT 200', s.id),
    work_orders: db.all('SELECT * FROM work_orders WHERE asset_id=? ORDER BY created_at DESC LIMIT 20', s.id),
    supply: db.all('SELECT * FROM bulk_supply WHERE asset_id=? ORDER BY period_end DESC LIMIT 24', s.id),
    meters: db.all('SELECT id, serial_number, comm_method, status, last_reading_value, last_reading_at FROM meters WHERE asset_id=?', s.id) };
});
route('POST', '/api/assets', { perm: 'assets.manage' }, ctx => {
  const b = validate(ctx.body, assetSchema);
  const r = db.run(`INSERT INTO assets(code, name, asset_type, area_id, lat, lng, status, capacity, capacity_unit, level_unit, install_year, description, maintenance_needs, next_inspection_due) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.code, b.name, b.asset_type, b.area_id, b.lat, b.lng, b.status, b.capacity, b.capacity_unit, b.level_unit, b.install_year, b.description, b.maintenance_needs, b.next_inspection_due);
  if (b.served_population != null || b.round_trip_min != null) db.run('UPDATE assets SET served_population=?, round_trip_min=? WHERE id=?', b.served_population ?? null, b.round_trip_min ?? null, r.id);
  require('../services/maintenance').logStatus(r.id, b.status || 'operational', ctx.user.id, 'Created');
  audit.log(ctx, 'asset.create', 'asset', r.id, b); return { id: r.id };
});
route('PUT', '/api/assets/:id', { anyPerm: ['assets.manage', 'assets.inspect'] }, ctx => {
  const sid = id(ctx.params.id);
  const before = db.get('SELECT * FROM assets WHERE id=?', sid); if (!before) throw new HttpError(404, 'Not found');
  if (!auth.can(ctx.user, 'assets.manage')) { // technicians may update status & maintenance needs only
    const b = validate(ctx.body, { status: assetSchema.status, maintenance_needs: assetSchema.maintenance_needs }, { partial: true });
    db.run('UPDATE assets SET status=COALESCE(?, status), maintenance_needs=COALESCE(?, maintenance_needs) WHERE id=?', b.status, b.maintenance_needs, sid);
    if (b.status && b.status !== before.status) { require('../services/maintenance').ensureLog(); require('../services/maintenance').logStatus(sid, b.status, ctx.user.id, b.maintenance_needs); }
    audit.log(ctx, 'asset.update', 'asset', sid, { before: { status: before.status }, after: b }); return { ok: true };
  }
  const b = validate(ctx.body, assetSchema);
  db.run(`UPDATE assets SET code=?, name=?, asset_type=?, area_id=?, lat=?, lng=?, status=?, capacity=?, capacity_unit=?, level_unit=?, install_year=?, description=?, maintenance_needs=?, next_inspection_due=? WHERE id=?`,
    b.code, b.name, b.asset_type, b.area_id, b.lat, b.lng, b.status, b.capacity, b.capacity_unit, b.level_unit, b.install_year, b.description, b.maintenance_needs, b.next_inspection_due, sid);
  if (b.served_population !== undefined || b.round_trip_min !== undefined) db.run('UPDATE assets SET served_population=?, round_trip_min=? WHERE id=?', b.served_population ?? null, b.round_trip_min ?? null, sid);
  if (b.status !== before.status) { require('../services/maintenance').ensureLog(); require('../services/maintenance').logStatus(sid, b.status, ctx.user.id); }
  audit.log(ctx, 'asset.update', 'asset', sid, { before, after: b }); return { ok: true };
});
route('POST', '/api/assets/:id/inspections', { anyPerm: ['assets.inspect', 'assets.manage'] }, ctx => {
  const sid = id(ctx.params.id);
  const b = validate(ctx.body, { inspected_at: { type: 'date', required: true }, condition: { type: 'enum', values: ['good', 'fair', 'poor', 'critical'], required: true }, findings: { type: 'text', max: 2000 }, actions: { type: 'text', max: 2000 }, next_inspection_due: { type: 'date' } });
  if (!db.get('SELECT 1 FROM assets WHERE id=?', sid)) throw new HttpError(404, 'Not found');
  const r = db.run('INSERT INTO asset_inspections(asset_id, inspected_at, inspector_id, condition, findings, actions) VALUES (?,?,?,?,?,?)', sid, b.inspected_at, ctx.user.id, b.condition, b.findings, b.actions);
  if (b.next_inspection_due) db.run('UPDATE assets SET next_inspection_due=? WHERE id=?', b.next_inspection_due, sid);
  audit.log(ctx, 'asset.inspect', 'asset', sid, b); return { id: r.id };
});
// Manual telemetry entry. Sensor telemetry would arrive through an integration and be stored with source='sensor'.
route('POST', '/api/assets/:id/telemetry', { perm: 'telemetry.enter' }, ctx => {
  const sid = id(ctx.params.id);
  const b = validate(ctx.body, { metric: { type: 'enum', values: ['level_pct', 'level_m', 'pressure_bar', 'flow_m3h', 'volume_m3', 'pump_hours', 'chlorine_mgl'], required: true },
    value: { type: 'number', required: true, minVal: -1e6, maxVal: 1e9 }, unit: { type: 'string', max: 20 }, recorded_at: { type: 'datetime' } });
  const s = db.get('SELECT * FROM assets WHERE id=?', sid); if (!s) throw new HttpError(404, 'Not found');
  const at = b.recorded_at || new Date().toISOString();
  const r = db.run(`INSERT INTO telemetry(asset_id, metric, value, unit, recorded_at, source, entered_by) VALUES (?,?,?,?,?,'manual',?)`, sid, b.metric, b.value, b.unit, at, ctx.user.id);
  if (['level_pct', 'level_m'].includes(b.metric)) db.run(`UPDATE assets SET current_level=?, level_unit=?, level_source='manual', level_updated_at=? WHERE id=?`, b.value, b.metric === 'level_pct' ? '%' : 'm', at, sid);
  audit.log(ctx, 'telemetry.manual', 'asset', sid, b); return { id: r.id };
});

// ================= Bulk / district supply (for NRW comparison) =================
route('GET', '/api/bulk-supply', { anyPerm: ['dashboard.view', 'assets.view'] }, () => db.all(`SELECT b.*, a.name area_name, s.name asset_name, u.full_name entered_by_name FROM bulk_supply b JOIN service_areas a ON a.id=b.area_id
  LEFT JOIN assets s ON s.id=b.asset_id LEFT JOIN users u ON u.id=b.entered_by ORDER BY b.period_end DESC, a.name LIMIT 500`));
route('POST', '/api/bulk-supply', { perm: 'supply.enter' }, ctx => {
  const b = validate(ctx.body, { area_id: { type: 'integer', required: true }, asset_id: { type: 'integer' }, period_start: { type: 'date', required: true }, period_end: { type: 'date', required: true },
    volume_m3: { type: 'number', required: true, minVal: 0 }, source: { type: 'enum', values: ['district_meter_manual', 'manual_estimate'], required: true }, notes: { type: 'text', max: 1000 } });
  if (b.period_end < b.period_start) throw new HttpError(400, 'Period end must be after start');
  const r = db.run('INSERT INTO bulk_supply(area_id, asset_id, period_start, period_end, volume_m3, source, notes, entered_by) VALUES (?,?,?,?,?,?,?,?)', b.area_id, b.asset_id, b.period_start, b.period_end, b.volume_m3, b.source, b.notes, ctx.user.id);
  audit.log(ctx, 'bulk_supply.create', 'bulk_supply', r.id, b); return { id: r.id };
});
