'use strict';
/*
 * Meter integration layer.
 * Each adapter turns an inbound payload (from a network server, gateway, collector or vendor API)
 * into normalised readings: { device_id?, serial?, value? (m³ register), pulses?, timestamp, events[], battery_pct? }.
 * Nothing here talks to a real meter until an administrator has entered the vendor/protocol details,
 * issued an API key, received real messages and confirmed them against the physical meter display ("verified").
 */
const crypto = require('crypto');
const db = require('../lib/db');
const audit = require('../lib/audit');
const readings = require('../services/readings');
const { HttpError } = require('../lib/http');

// Information required BEFORE any real integration is implemented/enabled.
const REQUIRED_INFO = [
  { key: 'meter_model', label: 'Exact meter make & model (and firmware/module version)', help: 'e.g. manufacturer, model, register module / radio module part number' },
  { key: 'comm_band', label: 'Communication band / network', help: 'e.g. LoRaWAN EU868 or US915 region plan, NB-IoT band + SIM operator, wM-Bus 868 MHz T1/C1 mode, RS-485' },
  { key: 'protocol', label: 'Protocol', help: 'e.g. LoRaWAN 1.0.3 class A, OMS 4.x / EN 13757-4, MQTT, HTTPS webhook, Modbus RTU, M-Bus' },
  { key: 'data_format', label: 'Data / payload format', help: 'Field list, units, scaling, byte layout or decoder (codec) reference, timestamp format' },
  { key: 'encryption', label: 'Encryption & key handling', help: 'e.g. LoRaWAN AppKey/AppSKey custody, OMS AES-128 mode 5/7 keys per meter, TLS version' },
  { key: 'docs_url', label: 'API / gateway documentation reference', help: 'URL or document title + version of the vendor or network-server documentation' },
  { key: 'vendor_access', label: 'Vendor access requirements', help: 'Accounts, licences, NDAs, keys, network-server tenancy, test meters, support contact' }
];

const get = (o, path) => String(path || '').split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const toArray = p => (Array.isArray(p) ? p : Array.isArray(p.readings) ? p.readings : [p]);

const ADAPTERS = {
  manual: { label: 'Manual entry by authorised meter reader', methods: ['manual'], builtIn: true, inbound: false },
  csv: { label: 'CSV / spreadsheet import', methods: ['csv'], builtIn: true, inbound: false },
  generic_json: {
    label: 'Generic JSON (HTTPS webhook) with field mapping — NB-IoT/cellular, vendor API push, serial collector',
    methods: ['nbiot', 'cellular', 'vendor_api', 'serial'],
    defaultMapping: { device_id: 'device_id', serial: 'serial', value: 'value_m3', pulses: 'pulses', timestamp: 'timestamp', battery_pct: 'battery', events: 'events' },
    normalize(payload, map) { return toArray(payload).map(p => pick(p, map)); }
  },
  pulse_generic: {
    label: 'Pulse-output retrofit module (pulse count → m³ using litres-per-pulse set on the meter)',
    methods: ['pulse'],
    defaultMapping: { device_id: 'device_id', pulses: 'pulse_count', timestamp: 'timestamp', battery_pct: 'battery', events: 'events' },
    normalize(payload, map) { return toArray(payload).map(p => pick(p, map)); }
  },
  lorawan_chirpstack: {
    label: 'LoRaWAN via ChirpStack v4 HTTP integration (uplink event, payload already decoded by device codec)',
    methods: ['lorawan'],
    defaultMapping: { device_id: 'deviceInfo.devEui', value: 'object.volume_m3', pulses: 'object.pulses', timestamp: 'time', battery_pct: 'object.battery', events: 'object.alarms' },
    normalize(payload, map) { return [pick(payload, map)]; }
  },
  lorawan_ttn: {
    label: 'LoRaWAN via The Things Stack v3 webhook (uplink_message.decoded_payload)',
    methods: ['lorawan'],
    defaultMapping: { device_id: 'end_device_ids.dev_eui', value: 'uplink_message.decoded_payload.volume_m3', pulses: 'uplink_message.decoded_payload.pulses', timestamp: 'received_at', battery_pct: 'uplink_message.decoded_payload.battery', events: 'uplink_message.decoded_payload.alarms' },
    normalize(payload, map) { return [pick(payload, map)]; }
  },
  wmbus_gateway: {
    label: 'Wireless M-Bus / OMS via gateway or drive-by collector that decrypts and decodes telegrams to JSON',
    methods: ['wmbus'],
    defaultMapping: { device_id: 'id', value: 'total_m3', timestamp: 'timestamp', battery_pct: 'battery', events: 'status_flags' },
    normalize(payload, map) { return toArray(payload).map(p => pick(p, map)); }
  },
  simulator: { label: 'DEMO SIMULATOR — generates clearly labelled fictional readings', methods: ['simulator'], builtIn: true, inbound: false }
};

function pick(p, map) {
  const ev = get(p, map.events);
  return {
    device_id: get(p, map.device_id) != null ? String(get(p, map.device_id)) : undefined,
    serial: get(p, map.serial) != null ? String(get(p, map.serial)) : undefined,
    value: get(p, map.value) != null ? Number(get(p, map.value)) : undefined,
    pulses: get(p, map.pulses) != null ? Number(get(p, map.pulses)) : undefined,
    timestamp: get(p, map.timestamp),
    battery_pct: get(p, map.battery_pct) != null ? Number(get(p, map.battery_pct)) : undefined,
    events: Array.isArray(ev) ? ev.map(String) : ev ? String(ev).split(/[ ,|]+/).filter(Boolean) : []
  };
}

function missingInfo(integ) { return REQUIRED_INFO.filter(f => !integ[f.key] || String(integ[f.key]).trim().length < 3).map(f => f.key); }

function statusLabel(i) {
  return {
    info_required: 'Information required — not connected', ready_for_implementation: 'Info complete — awaiting configuration/testing (not connected)',
    configured_unverified: 'Configured — receiving test data, NOT yet verified', verified: 'Verified live integration', disabled: 'Disabled', simulator: 'Demo simulator (fictional data)'
  }[i.status];
}

function issueKey(ctx, id) {
  const integ = db.get('SELECT * FROM integrations WHERE id=?', id);
  if (!integ) throw new HttpError(404, 'Integration not found');
  if (integ.is_simulator) throw new HttpError(400, 'Simulator does not accept inbound data');
  const miss = missingInfo(integ);
  if (miss.length) throw new HttpError(400, 'Complete the required integration information first: ' + miss.join(', '));
  const key = 'atk_' + crypto.randomBytes(24).toString('base64url');
  db.run(`UPDATE integrations SET api_key_hash=?, api_key_hint=?, status='configured_unverified', verified_at=NULL, verified_by=NULL WHERE id=?`, crypto.createHash('sha256').update(key).digest('hex'), key.slice(-4), id);
  audit.log(ctx, 'integration.issue_key', 'integration', id, { hint: key.slice(-4) });
  return key;
}

function ingest(ctx, integrationId, apiKey, payload) {
  const integ = db.get('SELECT * FROM integrations WHERE id=?', integrationId);
  if (!integ || !integ.api_key_hash || !['configured_unverified', 'verified'].includes(integ.status)) throw new HttpError(404, 'Integration not active');
  const h = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(integ.api_key_hash))) throw new HttpError(401, 'Invalid API key');
  const adapter = ADAPTERS[integ.adapter];
  if (!adapter || !adapter.normalize) throw new HttpError(400, 'Adapter does not accept inbound data');
  const map = { ...adapter.defaultMapping, ...(integ.field_mapping ? JSON.parse(integ.field_mapping) : {}) };
  const out = []; let ok = true;
  const ictx = { ...ctx, actor: 'integration:' + integ.id };
  for (const item of adapter.normalize(payload, map)) {
    try {
      const meter = item.device_id ? db.get('SELECT * FROM meters WHERE integration_id=? AND device_id=?', integ.id, item.device_id)
        : item.serial ? db.get('SELECT * FROM meters WHERE integration_id=? AND serial_number=?', integ.id, item.serial) : null;
      if (!meter) throw new Error(`No meter linked to this integration for device ${item.device_id || item.serial}`);
      let value = item.value;
      if ((value == null || isNaN(value)) && item.pulses != null) {
        if (!meter.pulse_liters) throw new Error(`Meter ${meter.serial_number} has no litres-per-pulse configured`);
        value = Math.round(((meter.initial_reading || 0) + item.pulses * meter.pulse_liters / 1000) * 1000) / 1000;
      }
      if (value == null || isNaN(value)) throw new Error('No register value or pulse count in payload');
      const ts = item.timestamp ? new Date(item.timestamp) : new Date();
      if (isNaN(ts)) throw new Error('Invalid timestamp');
      const r = readings.create(ictx, { meter_id: meter.id, value, reading_at: ts.toISOString(), source: meter.comm_method, device_id: item.device_id, integration_id: integ.id,
        events: item.events, battery_pct: item.battery_pct, sync_status: 'device', raw_payload: JSON.stringify(payload).slice(0, 4000) });
      out.push({ ok: true, reading_id: r.id, meter: meter.serial_number, value, flags: JSON.parse(r.flags_json) });
    } catch (e) { ok = false; out.push({ ok: false, error: e.message }); }
  }
  db.run('INSERT INTO integration_messages(integration_id, payload, ok, result) VALUES (?,?,?,?)', integ.id, JSON.stringify(payload).slice(0, 8000), ok ? 1 : 0, JSON.stringify(out));
  db.run(`UPDATE integrations SET last_message_at=?, last_error=?, messages_ok = messages_ok + ? WHERE id=?`, new Date().toISOString(), ok ? null : out.filter(o => !o.ok).map(o => o.error).join('; ').slice(0, 500), out.filter(o => o.ok).length, integ.id);
  return { ok, results: out };
}

function verify(ctx, id, note) {
  const integ = db.get('SELECT * FROM integrations WHERE id=?', id);
  if (!integ) throw new HttpError(404, 'Integration not found');
  if (integ.status !== 'configured_unverified') throw new HttpError(409, 'Only a configured integration that is receiving data can be verified');
  if (!integ.messages_ok) throw new HttpError(409, 'No valid messages have been received yet — cannot verify');
  if (!note || note.length < 15) throw new HttpError(400, 'Describe how you verified it (e.g. compared 3 transmitted readings with the physical meter display on <date>)');
  db.run(`UPDATE integrations SET status='verified', verified_at=?, verified_by=?, verification_note=? WHERE id=?`, new Date().toISOString(), ctx.user.id, note, id);
  audit.log(ctx, 'integration.verify', 'integration', id, { note });
}

// ---- Demo simulator: fictional data only, always flagged is_simulated -------------------------
function simulate(ctx, id, { scenario = 'normal', meter_id, hours = 24 }) {
  const integ = db.get('SELECT * FROM integrations WHERE id=?', id);
  if (!integ || !integ.is_simulator) throw new HttpError(400, 'Not a simulator integration');
  const meters = meter_id ? db.all('SELECT * FROM meters WHERE id=? AND integration_id=?', meter_id, id) : db.all(`SELECT * FROM meters WHERE integration_id=? AND status='active'`, id);
  if (!meters.length) throw new HttpError(400, 'No meters are linked to the simulator');
  const sctx = { ...ctx, actor: 'simulator' };
  let count = 0;
  for (const m of meters) {
    let v = m.last_reading_value != null ? m.last_reading_value : m.initial_reading;
    const start = Date.now() - hours * 3600e3;
    const step = 4; // hours between simulated uplinks
    for (let t = start + step * 3600e3; t <= Date.now(); t += step * 3600e3) {
      const hourOfDay = new Date(t).getUTCHours();
      let inc = scenario === 'leak' ? 0.03 + Math.random() * 0.02 : (hourOfDay >= 6 && hourOfDay <= 21 ? Math.random() * 0.12 : 0);
      if (scenario === 'reverse_flow') inc = -0.01;
      v = Math.round((v + inc) * 1000) / 1000;
      const events = scenario === 'reverse_flow' && t + step * 3600e3 > Date.now() ? ['reverse_flow'] : scenario === 'tamper' && t + step * 3600e3 > Date.now() ? ['tamper'] : [];
      readings.create(sctx, { meter_id: m.id, value: Math.max(0, v), reading_at: new Date(t).toISOString(), source: 'simulator', integration_id: id, is_simulated: true,
        sync_status: 'device', device_id: m.device_id, events, battery_pct: scenario === 'low_battery' ? 9 : 78 });
      count++;
    }
  }
  db.run(`UPDATE integrations SET last_message_at=?, messages_ok = messages_ok + ? WHERE id=?`, new Date().toISOString(), count, id);
  audit.log(ctx, 'integration.simulate', 'integration', id, { scenario, readings: count, simulated: true });
  return { created: count, scenario, simulated: true };
}

module.exports = { ADAPTERS, REQUIRED_INFO, missingInfo, statusLabel, issueKey, ingest, verify, simulate };
