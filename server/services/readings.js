'use strict';
// Reading validation, creation, review (approve/reject) and audited corrections.
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const FLAG_LABELS = {
  estimated: 'Estimated reading', duplicate: 'Possible duplicate', decreasing: 'Lower than previous reading',
  unusually_high: 'Unusually high consumption', zero_consumption: 'No consumption since last reading',
  future_timestamp: 'Timestamp in the future', long_gap: 'Long gap since previous reading', meter_not_active: 'Meter not active',
  device_fault: 'Device reported fault', reverse_flow: 'Reverse flow reported', tamper: 'Tamper reported', low_battery: 'Low battery',
  leak: 'Device leak/continuous-flow flag', unverified_source: 'From an integration that is not yet verified', simulated: 'SIMULATED (demo) reading',
  no_photo: 'No photo attached', corrected: 'Corrected after entry', offline_capture: 'Captured offline, synced later',
  customer_submitted: 'Submitted by customer (self-reading)', ocr_mismatch: 'Entered value differs from photo OCR', ocr_low_confidence: 'Photo OCR low confidence', ocr_match: 'Photo OCR agrees'
};
const DEVICE_EVENTS = ['reverse_flow', 'tamper', 'device_fault', 'low_battery', 'leak'];

const eff = r => (r.corrected_value != null ? r.corrected_value : r.value);
const DAY = 86400000;

function previousApproved(meter, beforeIso, excludeId) {
  const r = db.get(`SELECT * FROM readings WHERE meter_id = ? AND status = 'approved' AND reading_at < ? AND id != ? ORDER BY reading_at DESC LIMIT 1`,
    meter.id, beforeIso, excludeId || 0);
  if (r) return { value: eff(r), at: r.reading_at, id: r.id };
  return { value: meter.initial_reading || 0, at: meter.install_date ? meter.install_date + 'T00:00:00.000Z' : null, id: null, initial: true };
}

function avgDaily(meterId, beforeIso, excludeId) {
  const rows = db.all(`SELECT value, corrected_value, reading_at FROM readings WHERE meter_id = ? AND status = 'approved' AND is_estimated = 0
    AND reading_at < ? AND reading_at >= ? AND id != ? ORDER BY reading_at`, meterId, beforeIso, new Date(Date.parse(beforeIso) - 180 * DAY).toISOString(), excludeId || 0);
  if (rows.length < 2) return null;
  const a = rows[0], b = rows[rows.length - 1];
  const days = (Date.parse(b.reading_at) - Date.parse(a.reading_at)) / DAY;
  if (days < 7) return null;
  return Math.max(0, (eff(b) - eff(a)) / days);
}

function evaluate(meter, r, excludeId) {
  const flags = new Set();
  const prev = previousApproved(meter, r.reading_at, excludeId);
  const value = r.corrected_value != null ? r.corrected_value : r.value;
  const consumption = Math.round((value - prev.value) * 1000) / 1000;
  if (r.is_estimated) flags.add('estimated');
  if (r.is_simulated) flags.add('simulated');
  if (Date.parse(r.reading_at) > Date.now() + 10 * 60e3) flags.add('future_timestamp');
  if (meter.status !== 'active') flags.add('meter_not_active');
  if (consumption < 0) flags.add('decreasing');
  else if (consumption === 0 && prev.at && (Date.parse(r.reading_at) - Date.parse(prev.at)) > 5 * DAY) flags.add('zero_consumption');
  if (prev.at) {
    const days = (Date.parse(r.reading_at) - Date.parse(prev.at)) / DAY;
    if (days > db.settingNum('long_gap_days', 45)) flags.add('long_gap');
    if (consumption > 1 && days > 0) {
      const daily = consumption / Math.max(days, 1 / 24);
      const base = avgDaily(meter.id, r.reading_at, excludeId);
      const factor = db.settingNum('high_consumption_factor', 2.5);
      if (base != null && base > 0 && daily > factor * base && days >= 1) flags.add('unusually_high');
      if (base == null && meter.customer_type === 'household' && days >= 1 && daily > db.settingNum('max_daily_m3_household', 3)) flags.add('unusually_high');
    }
  }
  // Device interval data legitimately repeats values (no flow overnight), so value-based duplicate checks apply to manual/CSV only.
  const manualLike = ['manual', 'csv_import', 'estimate'].includes(r.source);
  const dup = db.get(`SELECT id FROM readings WHERE meter_id = ? AND id != ? AND status != 'rejected' AND
    (reading_at = ? OR (? = 1 AND value = ? AND abs(julianday(reading_at) - julianday(?)) < 1)) LIMIT 1`, meter.id, excludeId || 0, r.reading_at, manualLike ? 1 : 0, r.value, r.reading_at);
  if (dup) flags.add('duplicate');
  for (const ev of (r.events || [])) if (DEVICE_EVENTS.includes(ev)) flags.add(ev);
  if (r.battery_pct != null && r.battery_pct < 15) flags.add('low_battery');
  if (r.integration && r.integration.status !== 'verified' && !r.is_simulated) flags.add('unverified_source');
  if (r.source === 'manual' && !r.photo_path && db.setting('photo_required') === '1') flags.add('no_photo');
  if (r.sync_status === 'offline_synced') flags.add('offline_capture');
  if (r.corrected_value != null) flags.add('corrected');
  if (r.source === 'customer_self') flags.add('customer_submitted');
  if (r.ocr_value != null) {
    const tol = db.settingNum('ocr_mismatch_tolerance', 0.5);
    if (Math.abs(r.value - r.ocr_value) > tol) flags.add('ocr_mismatch'); else if (r.ocr_confidence != null && r.ocr_confidence < 60) flags.add('ocr_low_confidence'); else flags.add('ocr_match');
  }
  return { flags: [...flags], previous_value: prev.value, consumption };
}

function meterWithCustomer(meterId) {
  return db.get(`SELECT m.*, c.customer_type, c.status AS customer_status FROM meters m LEFT JOIN customers c ON c.id = m.customer_id WHERE m.id = ?`, meterId);
}

/** Create a reading from any source. data: {meter_id, value, reading_at, source, ...} */
function create(ctx, data) {
  return db.tx(() => {
    if (data.client_uuid) {
      const existing = db.get('SELECT * FROM readings WHERE client_uuid = ?', data.client_uuid);
      if (existing) return { ...existing, duplicate_submission: true };
    }
    const meter = meterWithCustomer(data.meter_id);
    if (!meter) throw new HttpError(404, 'Meter not found');
    if (!(data.value >= 0)) throw new HttpError(400, 'Reading value must be zero or positive');
    const integration = data.integration_id ? db.get('SELECT * FROM integrations WHERE id = ?', data.integration_id) : null;
    const r = { ...data, integration };
    const ev = evaluate(meter, r);
    const ins = db.run(`INSERT INTO readings(meter_id, customer_id, value, reading_at, source, reader_user_id, device_id, integration_id,
      is_estimated, is_simulated, photo_path, lat, lng, gps_accuracy, notes, client_uuid, sync_status, captured_at, flags_json, previous_value, consumption,
      events_json, battery_pct, raw_payload, import_batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      meter.id, meter.customer_id, data.value, data.reading_at, data.source, data.reader_user_id || null, data.device_id || null, data.integration_id || null,
      data.is_estimated ? 1 : 0, data.is_simulated ? 1 : 0, data.photo_path || null, data.lat, data.lng, data.gps_accuracy, data.notes || null,
      data.client_uuid || null, data.sync_status || 'online', data.captured_at || null, JSON.stringify(ev.flags), ev.previous_value, ev.consumption,
      data.events ? JSON.stringify(data.events) : null, data.battery_pct, data.raw_payload || null, data.import_batch_id || null);
    if (!meter.last_reading_at || data.reading_at > meter.last_reading_at) {
      db.run('UPDATE meters SET last_reading_value = ?, last_reading_at = ?, battery_pct = COALESCE(?, battery_pct) WHERE id = ?', data.value, data.reading_at, data.battery_pct, meter.id);
    }
    if (data.ocr_value != null) db.run('UPDATE readings SET ocr_value=?, ocr_confidence=? WHERE id=?', data.ocr_value, data.ocr_confidence ?? null, ins.id);
    audit.log(ctx, 'reading.create', 'reading', ins.id, { meter: meter.serial_number, value: data.value, source: data.source, flags: ev.flags, simulated: !!data.is_simulated });
    return db.get('SELECT * FROM readings WHERE id = ?', ins.id);
  });
}

function approve(ctx, id, note) {
  return db.tx(() => {
    const r = db.get('SELECT * FROM readings WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'Reading not found');
    if (r.status === 'approved') return r;
    if (r.is_simulated && db.MODE === 'live') throw new HttpError(409, 'Simulated readings can never be approved in the live system');
    const meter = meterWithCustomer(r.meter_id);
    const ev = evaluate(meter, { ...r, events: JSON.parse(r.events_json || '[]'), integration: r.integration_id ? db.get('SELECT * FROM integrations WHERE id=?', r.integration_id) : null }, r.id);
    db.run(`UPDATE readings SET status='approved', approved_by=?, approved_at=?, review_note=?, flags_json=?, previous_value=?, consumption=? WHERE id=?`,
      ctx.user.id, new Date().toISOString(), note || null, JSON.stringify(ev.flags), ev.previous_value, ev.consumption, id);
    audit.log(ctx, 'reading.approve', 'reading', id, { value: eff(r), flags: ev.flags, note });
    return db.get('SELECT * FROM readings WHERE id = ?', id);
  });
}

function reject(ctx, id, reason) {
  if (!reason) throw new HttpError(400, 'A reason is required to reject a reading');
  const r = db.get('SELECT * FROM readings WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Reading not found');
  if (r.billed_bill_id) throw new HttpError(409, 'This reading has been billed. Cancel the bill or post an adjustment instead.');
  db.run(`UPDATE readings SET status='rejected', approved_by=?, approved_at=?, review_note=? WHERE id=?`, ctx.user.id, new Date().toISOString(), reason, id);
  audit.log(ctx, 'reading.reject', 'reading', id, { previous_status: r.status, reason });
  return db.get('SELECT * FROM readings WHERE id = ?', id);
}

function correct(ctx, id, value, reason) {
  if (!reason || reason.length < 5) throw new HttpError(400, 'A correction reason (at least 5 characters) is required');
  if (!(value >= 0)) throw new HttpError(400, 'Corrected value must be zero or positive');
  return db.tx(() => {
    const r = db.get('SELECT * FROM readings WHERE id = ?', id);
    if (!r) throw new HttpError(404, 'Reading not found');
    if (r.billed_bill_id) throw new HttpError(409, 'This reading has been billed. Cancel the bill first or post an adjustment.');
    const meter = meterWithCustomer(r.meter_id);
    const ev = evaluate(meter, { ...r, corrected_value: value, events: JSON.parse(r.events_json || '[]') }, r.id);
    db.run(`UPDATE readings SET corrected_value=?, correction_reason=?, corrected_by=?, corrected_at=?, flags_json=?, previous_value=?, consumption=? WHERE id=?`,
      value, reason, ctx.user.id, new Date().toISOString(), JSON.stringify(ev.flags), ev.previous_value, ev.consumption, id);
    audit.log(ctx, 'reading.correct', 'reading', id, { original_value: r.value, previous_correction: r.corrected_value, corrected_value: value, reason });
    return db.get('SELECT * FROM readings WHERE id = ?', id);
  });
}

module.exports = { create, approve, reject, correct, evaluate, previousApproved, avgDaily, eff, FLAG_LABELS };
