'use strict';
/*
 * DEMO DATA SEEDER — fictional records only, written ONLY to the separate demo database (data/demo/).
 * Refuses to run when APP_MODE=live.  Usage: npm run seed-demo
 */
if ((process.env.APP_MODE || 'demo').toLowerCase() === 'live') { console.error('Refusing to seed demo data into the LIVE database.'); process.exit(1); }
process.env.APP_MODE = 'demo';
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
if (process.argv.includes('--reset')) for (const f of fs.readdirSync(db.DATA_DIR)) if (/\.db(-wal|-shm)?$/.test(f)) fs.unlinkSync(path.join(db.DATA_DIR, f));
db.open();
if (db.get('SELECT COUNT(*) n FROM users').n) { console.log('Demo database already has data. Use --reset to rebuild it.'); process.exit(0); }

const auth = require('./lib/auth');
const audit = require('./lib/audit');
const readings = require('./services/readings');
const billing = require('./services/billing');
const alerts = require('./services/alerts');
const integ = require('./integrations');

// Deterministic pseudo-random so the demo looks the same every time
let seed = 20261031; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a, b) => a + rnd() * (b - a);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const PW = 'DemoPass2026';

db.tx(() => {
  db.run(`UPDATE settings SET value='Demo Community Water Utility (fictional)' WHERE key='org_name'`);
  // ---- Areas (fictional) ----
  const areas = [
    ['RVS', 'Riverside Township (Demo)', 'Montserrado', 'Demo District 1', 'LRD', 6.3105, -10.7560],
    ['HLT', 'Hilltop Town (Demo)', 'Margibi', 'Demo District 2', 'USD', 6.2380, -10.3570],
    ['GVW', 'Greenvale WASH Project (Demo)', 'Bong', 'Demo District 3', 'LRD', 6.9980, -9.4720]
  ].map(a => ({ id: db.run('INSERT INTO service_areas(code,name,county,district,currency,description) VALUES (?,?,?,?,?,?)', a[0], a[1], a[2], a[3], a[4], 'Fictional demo service area').id, code: a[0], currency: a[4], lat: a[5], lng: a[6] }));
  const [RVS, HLT, GVW] = areas;

  // ---- Users ----
  const mk = (u, n, role, extra = {}) => db.run('INSERT INTO users(username, full_name, role, password_hash, area_id, customer_id, email, phone) VALUES (?,?,?,?,?,?,?,?)',
    u, n, role, auth.hashPassword(PW), extra.area_id || null, extra.customer_id || null, `${u}@demo.invalid`, '+231 770 000 ' + String(100 + Math.floor(rnd() * 800))).id;
  const U = {
    admin: mk('admin', 'Demo Administrator', 'admin'), manager: mk('manager', 'Demo Utility Manager', 'manager'),
    reader1: mk('reader1', 'Demo Reader — Riverside', 'meter_reader', { area_id: RVS.id }), reader2: mk('reader2', 'Demo Reader — Hilltop', 'meter_reader', { area_id: HLT.id }),
    tech1: mk('tech1', 'Demo Technician One', 'technician'), tech2: mk('tech2', 'Demo Technician Two', 'technician'),
    cashier: mk('cashier', 'Demo Cashier', 'cashier'), cashier2: mk('billing', 'Demo Billing Officer', 'cashier')
  };
  const ctxOf = uid => ({ user: db.get('SELECT * FROM users WHERE id=?', uid), ip: 'demo-seed' });
  const A = ctxOf(U.admin);
  audit.log(A, 'demo.seed', 'system', null, { note: 'Fictional demo dataset created' });

  db.run(`INSERT INTO exchange_rates(from_currency,to_currency,rate,effective_date,source_note,created_by) VALUES ('USD','LRD',190,'2026-01-01','DEMO PLACEHOLDER — replace with the rate your utility adopts',?)`, U.admin);

  // ---- Tariffs (DEMO values — not official rates) ----
  const T = (code, name, type, area, cur, fixed, bands, tax = 0, fees = []) => db.run(`INSERT INTO tariffs(code,name,customer_type,area_id,currency,fixed_charge,bands_json,tax_pct,fees_json,effective_from,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, code, name, type, area, cur, fixed, JSON.stringify(bands), tax, JSON.stringify(fees), '2026-01-01', 'DEMO tariff — fictional rates for training only', U.admin);
  T('RVS-HH', 'Riverside Household (demo)', 'household', RVS.id, 'LRD', 150, [{ up_to: 10, rate: 45 }, { up_to: 30, rate: 70 }, { up_to: null, rate: 110 }], 0, [{ name: 'Meter service fee', amount: 50 }]);
  T('RVS-BUS', 'Riverside Business (demo)', 'business', RVS.id, 'LRD', 400, [{ up_to: 50, rate: 95 }, { up_to: null, rate: 130 }], 10);
  T('RVS-INST', 'Riverside Institution (demo)', 'institution', RVS.id, 'LRD', 300, [{ up_to: null, rate: 85 }]);
  T('RVS-PWP', 'Riverside Public Water Point — social (demo)', 'public_water_point', RVS.id, 'LRD', 0, [{ up_to: null, rate: 25 }]);
  T('RVS-BULK', 'Riverside Bulk (demo)', 'bulk', RVS.id, 'LRD', 1000, [{ up_to: 500, rate: 60 }, { up_to: null, rate: 55 }]);
  T('HLT-HH', 'Hilltop Household (demo)', 'household', HLT.id, 'USD', 1.0, [{ up_to: 10, rate: 0.30 }, { up_to: 30, rate: 0.45 }, { up_to: null, rate: 0.65 }], 0, [{ name: 'Sanitation levy', pct: 2 }]);
  T('HLT-BUS', 'Hilltop Business (demo)', 'business', HLT.id, 'USD', 3.0, [{ up_to: 50, rate: 0.60 }, { up_to: null, rate: 0.80 }], 10);
  T('HLT-INST', 'Hilltop Institution (demo)', 'institution', HLT.id, 'USD', 2.0, [{ up_to: null, rate: 0.50 }]);
  T('HLT-PWP', 'Hilltop Public Water Point (demo)', 'public_water_point', HLT.id, 'USD', 0, [{ up_to: null, rate: 0.15 }]);
  T('GVW-ALL', 'Greenvale standard (demo, all types)', null, GVW.id, 'LRD', 100, [{ up_to: null, rate: 40 }]);
  T('GVW-PWP', 'Greenvale public water point (demo)', 'public_water_point', GVW.id, 'LRD', 0, [{ up_to: null, rate: 20 }]);

  // ---- Meter model capability registry (generic placeholders — replace with exact vendor models) ----
  const MM = (mf, model, type, sizes, methods, pl, notes) => db.run('INSERT INTO meter_models(manufacturer, model, meter_type, sizes_mm, supported_methods, pulse_liters, notes, is_placeholder) VALUES (?,?,?,?,?,?,?,1)',
    mf, model, type, sizes, JSON.stringify(methods), pl, notes + ' PLACEHOLDER — confirm capabilities against the vendor datasheet before use.').id;
  const M = {
    mech: MM('Generic (demo)', 'Multi-jet mechanical, dry dial', 'mechanical', '15,20,25', ['manual', 'csv'], null, 'Visual register only.'),
    mechPulse: MM('Generic (demo)', 'Multi-jet mechanical, pulse-ready', 'mechanical', '15,20,25', ['manual', 'csv', 'pulse'], 10, 'Reed-switch pulse output when retrofit module fitted.'),
    usLora: MM('Generic (demo)', 'Ultrasonic smart meter, LoRaWAN', 'ultrasonic', '15,20', ['manual', 'csv', 'lorawan', 'simulator'], null, 'Integrated LoRaWAN radio.'),
    usNb: MM('Generic (demo)', 'Ultrasonic smart meter, NB-IoT', 'ultrasonic', '15,20,25', ['manual', 'csv', 'nbiot', 'simulator'], null, 'Integrated NB-IoT modem; vendor cloud API.'),
    wmbus: MM('Generic (demo)', 'Mechanical + wM-Bus/OMS module', 'mechanical', '15,20', ['manual', 'csv', 'wmbus'], null, 'Walk-by/drive-by OMS radio module.'),
    bulk: MM('Generic (demo)', 'Woltman bulk meter', 'bulk', '50,80,100,150', ['manual', 'csv', 'pulse'], 100, 'District / bulk supply metering.'),
    prepaid: MM('Generic (demo)', 'Prepaid token meter', 'prepaid', '15,20', ['manual', 'csv'], null, 'Token vending NOT integrated (future-ready).')
  };

  // ---- Integrations: simulator + two profiles still awaiting vendor information (none connected) ----
  const SIM = db.run(`INSERT INTO integrations(name, method, adapter, status, is_simulator, notes) VALUES ('Demo Meter Simulator','simulator','simulator','simulator',1,'Generates clearly labelled fictional readings for training. Not a real device connection.')`).id;
  db.run(`INSERT INTO integrations(name, method, adapter, vendor, comm_band, protocol, network_server, notes, status) VALUES ('LoRaWAN pilot (Hilltop) — awaiting vendor details','lorawan','lorawan_chirpstack','To be confirmed','EU868 or US915 — to be confirmed with vendor & regulator','LoRaWAN 1.0.x (to be confirmed)','ChirpStack v4 (proposed)','Example profile: cannot receive data until all required information is entered and a key is issued.','info_required')`);
  db.run(`INSERT INTO integrations(name, method, adapter, vendor, notes, status) VALUES ('NB-IoT vendor cloud — awaiting API documentation','vendor_api','generic_json','To be confirmed','Example profile for a vendor cloud push/pull API.','info_required')`);

  // ---- Network assets ----
  const AS = (code, name, type, area, dlat, dlng, extra = {}) => db.run(`INSERT INTO assets(code,name,asset_type,area_id,lat,lng,status,capacity,capacity_unit,current_level,level_unit,level_source,level_updated_at,install_year,description,maintenance_needs,next_inspection_due)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, name, type, area.id, area.lat + dlat, area.lng + dlng, extra.status || 'operational', extra.capacity ?? null, extra.unit || null,
    extra.level ?? null, extra.level != null ? '%' : null, extra.level != null ? (extra.levelSource || 'manual') : null, extra.level != null ? '2026-10-30T08:00:00.000Z' : null, extra.year || 2019,
    'Fictional demo asset', extra.needs || null, extra.due || '2026-12-15').id;
  const assets = {
    rvsSrc: AS('RVS-SRC-01', 'Riverside river intake (demo)', 'source', RVS, 0.010, -0.012, { capacity: 1200, unit: 'm³/day' }),
    rvsTrt: AS('RVS-TRT-01', 'Riverside treatment unit (demo)', 'treatment', RVS, 0.008, -0.009, { capacity: 1000, unit: 'm³/day', needs: 'Replace dosing pump diaphragm' }),
    rvsPump: AS('RVS-PMP-01', 'Riverside high-lift pump (demo)', 'pump', RVS, 0.007, -0.007, { capacity: 60, unit: 'm³/h', status: 'degraded', needs: 'Bearing noise reported — schedule inspection' }),
    rvsRes: AS('RVS-RES-01', 'Riverside elevated tank 250 m³ (demo)', 'reservoir', RVS, 0.004, -0.002, { capacity: 250, unit: 'm³', level: 64 }),
    rvsPipe: AS('RVS-PIPE-01', 'Riverside 150 mm trunk main (demo)', 'pipe', RVS, 0.002, 0.000, { capacity: 150, unit: 'mm dia' }),
    rvsDma: AS('RVS-DMA-01', 'Riverside district meter DMA-1 (demo)', 'district_meter', RVS, 0.001, 0.001, {}),
    rvsKiosk: AS('RVS-WP-01', 'Riverside market water kiosk (demo)', 'water_point', RVS, -0.003, 0.004, {}),
    hltSrc: AS('HLT-SRC-01', 'Hilltop borehole BH-1 (demo)', 'source', HLT, 0.006, 0.005, { capacity: 240, unit: 'm³/day' }),
    hltPump: AS('HLT-PMP-01', 'Hilltop solar submersible pump (demo)', 'pump', HLT, 0.006, 0.005, { capacity: 12, unit: 'm³/h' }),
    hltRes: AS('HLT-RES-01', 'Hilltop ground reservoir 100 m³ (demo)', 'reservoir', HLT, 0.004, 0.003, { capacity: 100, unit: 'm³', level: 41, levelSource: 'simulator' }),
    hltDma: AS('HLT-DMA-01', 'Hilltop district meter (demo)', 'district_meter', HLT, 0.002, 0.002, {}),
    gvwSrc: AS('GVW-SRC-01', 'Greenvale hand-dug well + solar pump (demo)', 'source', GVW, 0.003, 0.002, { capacity: 60, unit: 'm³/day' }),
    gvwRes: AS('GVW-RES-01', 'Greenvale 20 m³ tank (demo)', 'reservoir', GVW, 0.002, 0.001, { capacity: 20, unit: 'm³', level: 18 }),
    gvwTap1: AS('GVW-WP-01', 'Greenvale tap stand 1 (demo)', 'water_point', GVW, -0.002, 0.003, {}),
    gvwTap2: AS('GVW-WP-02', 'Greenvale tap stand 2 (demo)', 'water_point', GVW, 0.001, -0.004, { status: 'down', needs: 'Broken tap — awaiting spare' })
  };
  for (const [aid, cond, find] of [[assets.rvsPump, 'fair', 'Bearing noise at high load; vibration noticeable.'], [assets.rvsRes, 'good', 'Tank sound; ladder cage needs paint.'], [assets.gvwTap2, 'poor', 'Tap broken, apron cracked.'], [assets.hltSrc, 'good', 'Yield test OK.']])
    db.run('INSERT INTO asset_inspections(asset_id, inspected_at, inspector_id, condition, findings, actions) VALUES (?,?,?,?,?,?)', aid, '2026-09-1' + Math.floor(rnd() * 9), U.tech1, cond, find, 'Logged for follow-up');
  for (let d = 6; d >= 0; d--) {
    const t = new Date(Date.parse('2026-10-31T08:00:00Z') - d * 86400e3).toISOString();
    db.run(`INSERT INTO telemetry(asset_id, metric, value, unit, recorded_at, source, entered_by) VALUES (?,?,?,?,?,'manual',?)`, assets.rvsRes, 'level_pct', Math.round(between(55, 80)), '%', t, U.tech1);
    db.run(`INSERT INTO telemetry(asset_id, metric, value, unit, recorded_at, source, device_id) VALUES (?,?,?,?,?,'simulator','SIM-LEVEL-01')`, assets.hltRes, 'level_pct', Math.round(between(35, 70)), '%', t);
    db.run(`INSERT INTO telemetry(asset_id, metric, value, unit, recorded_at, source, entered_by) VALUES (?,?,?,?,?,'manual',?)`, assets.rvsPump, 'pressure_bar', Math.round(between(2.1, 3.4) * 10) / 10, 'bar', t, U.tech1);
  }

  // ---- Customers + meters ----
  const first = ['Musu', 'Jallah', 'Comfort', 'Kollie', 'Esther', 'Moses', 'Hawa', 'Joseph', 'Patience', 'Emmanuel', 'Fatu', 'Samuel', 'Grace', 'Varney', 'Mary', 'Sekou', 'Ruth', 'Momo', 'Christiana', 'Prince', 'Bendu', 'Alfred', 'Korto', 'Daniel'];
  const last = ['Kpoto', 'Flomo', 'Sirleaf', 'Togba', 'Kamara', 'Doe', 'Gbeh', 'Wesseh', 'Karnley', 'Tarpeh', 'Johnson', 'Nyumah', 'Kollie', 'Mulbah', 'Sackor', 'Freeman'];
  const biz = ['Sunrise Cold Store', 'Mama Bendu Cookshop', 'Green Leaf Guesthouse', 'Riverside Car Wash', 'Hilltop Block Factory', 'Peace Pharmacy', 'Unity Barbershop', 'Bright Star Laundry'];
  const inst = ['Riverside Demo Public School', 'Hilltop Demo Health Post', 'Greenvale Demo Clinic', 'Demo Community Church', 'Hilltop Demo Secondary School'];
  const streets = ['Water Side Road', 'Old Market Street', 'Church Road', 'School Junction', 'Mission Hill', 'Cassava Farm Lane', 'Palm Grove', 'Bridge Street'];
  let seqs = { RVS: 0, HLT: 0, GVW: 0 };
  const customers = [];
  const addCustomer = (area, type, name, method = 'manual', model = M.mech, mode = 'postpaid') => {
    seqs[area.code]++;
    const num = `DEMO-${area.code}-${String(seqs[area.code]).padStart(5, '0')}`;
    const lat = area.lat + between(-0.012, 0.012), lng = area.lng + between(-0.012, 0.012);
    const cid = db.run(`INSERT INTO customers(customer_number,name,customer_type,contact_person,phone,address,landmark,area_id,lat,lng,gps_source,status,billing_mode,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'2026-03-10 09:00:00')`,
      num, name, type, type === 'household' ? null : pick(first) + ' ' + pick(last), '+231 77' + Math.floor(between(1000000, 9999999)), `${Math.floor(between(1, 200))} ${pick(streets)}, ${area.code} (demo)`,
      pick(['Near the blue church', 'Opposite the football field', 'Behind the market', 'Next to the clinic', null]), area.id, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, 'survey', 'active', mode, 'Fictional demo customer').id;
    db.run('INSERT INTO customer_events(customer_id, event_type, description, user_id, created_at) VALUES (?,?,?,?,?)', cid, 'created', `Account ${num} opened (${type})`, U.admin, '2026-03-10 09:00:00');
    const size = type === 'bulk' ? 50 : type === 'institution' || type === 'public_water_point' ? 25 : type === 'business' ? 20 : 15;
    const mm = db.get('SELECT * FROM meter_models WHERE id=?', type === 'bulk' ? M.bulk : model);
    const serial = `DM${area.code}${String(customers.length + 1).padStart(5, '0')}`;
    const initial = Math.round(between(0, 400) * 10) / 10;
    const mid = db.run(`INSERT INTO meters(serial_number, manufacturer, model, model_id, meter_type, size_mm, install_date, initial_reading, lat, lng, area_id, status, comm_method, integration_id, device_id, customer_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`, serial, mm.manufacturer, mm.model, mm.id, mm.meter_type, size, '2026-03-15', initial, lat, lng, area.id, method, method === 'simulator' ? SIM : null, method === 'simulator' ? 'SIM-' + serial : null, cid).id;
    db.run('INSERT INTO meter_assignments(meter_id, customer_id, assigned_at, start_reading, reason, user_id) VALUES (?,?,?,?,?,?)', mid, cid, '2026-03-15T00:00:00.000Z', initial, 'New installation (demo)', U.admin);
    const base = { household: [6, 18], business: [20, 60], institution: [40, 110], public_water_point: [80, 180], bulk: [400, 850] }[type];
    customers.push({ id: cid, mid, area, type, method, base, number: num, name });
    return customers[customers.length - 1];
  };
  for (let i = 0; i < 22; i++) addCustomer(RVS, 'household', pick(first) + ' ' + pick(last) + ' household', 'manual', i % 3 ? M.mech : M.mechPulse);
  for (let i = 0; i < 4; i++) addCustomer(RVS, 'business', biz[i]);
  addCustomer(RVS, 'institution', inst[0]); addCustomer(RVS, 'institution', inst[3]);
  addCustomer(RVS, 'public_water_point', 'Riverside Market Kiosk (demo water point)');
  addCustomer(RVS, 'bulk', 'Demo Bottling Co. (bulk customer)');
  for (let i = 0; i < 12; i++) addCustomer(HLT, 'household', pick(first) + ' ' + pick(last) + ' household', i < 4 ? 'simulator' : 'manual', i < 4 ? M.usLora : M.mech);
  for (let i = 4; i < 8; i++) addCustomer(HLT, 'business', biz[i]);
  addCustomer(HLT, 'institution', inst[1]); addCustomer(HLT, 'institution', inst[4]);
  addCustomer(HLT, 'public_water_point', 'Hilltop Junction Tap (demo water point)');
  for (let i = 0; i < 7; i++) addCustomer(GVW, 'household', pick(first) + ' ' + pick(last) + ' household', 'manual', M.mech, i === 6 ? 'prepaid' : 'postpaid');
  addCustomer(GVW, 'institution', inst[2]);
  addCustomer(GVW, 'public_water_point', 'Greenvale Tap Stand 1 (demo)');
  addCustomer(GVW, 'public_water_point', 'Greenvale Tap Stand 2 (demo)');

  for (const [k, v] of Object.entries(seqs)) db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'seq_customer_' + k, String(v));
  // A meter in stock (unassigned) and district meters linked to assets
  db.run(`INSERT INTO meters(serial_number, manufacturer, model, model_id, meter_type, size_mm, status, comm_method, area_id) VALUES ('DMSTOCK00001','Generic (demo)','Multi-jet mechanical, dry dial',?,'mechanical',15,'in_stock','manual',?)`, M.mech, RVS.id);
  db.run(`INSERT INTO meters(serial_number, manufacturer, model, model_id, meter_type, size_mm, status, comm_method, area_id) VALUES ('DMSTOCK00002','Generic (demo)','Ultrasonic smart meter, NB-IoT',?,'ultrasonic',20,'in_stock','manual',?)`, M.usNb, HLT.id);
  db.run(`INSERT INTO meters(serial_number, manufacturer, model, model_id, meter_type, size_mm, install_date, status, comm_method, area_id, asset_id, is_bulk) VALUES ('DMDMA-RVS-01','Generic (demo)','Woltman bulk meter',?,'bulk',100,'2026-03-01','active','manual',?,?,1)`, M.bulk, RVS.id, assets.rvsDma);
  db.run(`INSERT INTO meters(serial_number, manufacturer, model, model_id, meter_type, size_mm, install_date, status, comm_method, area_id, asset_id, is_bulk) VALUES ('DMDMA-HLT-01','Generic (demo)','Woltman bulk meter',?,'bulk',80,'2026-03-01','active','manual',?,?,1)`, M.bulk, HLT.id, assets.hltDma);

  // ---- Monthly reading history May–Oct 2026 ----
  // Photo + on-device OCR examples (demo photos are generated images of a meter register, stored in server/demo-assets/)
  const OCR_DEMO = new Set([0, 1, 8]);
  const demoPhoto = n => { const f = path.join(__dirname, 'demo-assets', `meter-${n}.png`); if (!fs.existsSync(f)) return null; const name = `demo-meter-${n}.png`; fs.copyFileSync(f, path.join(db.DATA_DIR, 'uploads', name)); return name; };
  db.run(`UPDATE settings SET value='0' WHERE key='sms_notifications'`); // no SMS for old history; switched on before September billing
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const special = { zero: customers[5], high: customers[2], decreasing: customers[8], missing: customers[12], offline: customers[3] };
  const readerFor = c => (c.area === RVS ? U.reader1 : c.area === HLT ? U.reader2 : U.admin);
  for (const c of customers) {
    let v = db.get('SELECT initial_reading v FROM meters WHERE id=?', c.mid).v;
    for (const mo of months) {
      const isOct = mo === '2026-10';
      if ((isOct || mo === '2026-09') && c === special.missing) continue;
      let cons = between(c.base[0], c.base[1]);
      if (c === special.zero && (mo === '2026-09' || isOct)) cons = 0;
      if (c === special.high && isOct) cons = c.base[1] * 4.2;
      v = Math.round((v + cons) * 10) / 10;
      let value = v;
      if (c === special.decreasing && isOct) value = Math.round((v - cons - 35) * 10) / 10; // digit misread
      const day = String(Math.floor(between(23, 28))).padStart(2, '0');
      const at = `${mo}-${day}T${String(Math.floor(between(8, 16))).padStart(2, '0')}:${String(Math.floor(between(0, 59))).padStart(2, '0')}:00.000Z`;
      const sim = c.method === 'simulator';
      const r = readings.create(ctxOf(readerFor(c)), { meter_id: c.mid, value, reading_at: at, source: sim ? 'simulator' : c.area === GVW && mo === '2026-07' ? 'csv_import' : 'manual',
        reader_user_id: sim ? null : readerFor(c), is_simulated: sim, integration_id: sim ? SIM : null, sync_status: sim ? 'device' : (c === special.offline && isOct ? 'offline_synced' : 'online'),
        captured_at: c === special.offline && isOct ? at : null, lat: sim ? null : db.get('SELECT lat FROM customers WHERE id=?', c.id).lat, lng: sim ? null : db.get('SELECT lng FROM customers WHERE id=?', c.id).lng,
        notes: c === special.offline && isOct ? 'Captured offline — no network at site' : null,
        ...(isOct && OCR_DEMO.has(customers.indexOf(c)) ? { ocr_value: Math.floor(v), ocr_confidence: 84, photo_path: demoPhoto(Math.floor(v)) } : {}) });
      if (!isOct) readings.approve(ctxOf(U.cashier2), r.id, 'Monthly review (demo)');
    }
  }
  // one pending manual reading with an "estimated" flag (meter obstructed)
  // ---- Bills May–Sep, then payments ----
  const lastDay = mo => new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).toISOString().slice(0, 10);
  const CASH = ctxOf(U.cashier);
  for (const mo of months.slice(0, 5)) {
    if (mo === '2026-09') db.run(`UPDATE settings SET value='1' WHERE key='sms_notifications'`);
    const res = billing.generate(ctxOf(U.cashier2), { period_start: mo + '-01', period_end: lastDay(mo), commit: true });
    const issue = new Date(Date.parse(lastDay(mo)) + 2 * 86400e3).toISOString().slice(0, 10);
    const due = new Date(Date.parse(issue) + 21 * 86400e3).toISOString().slice(0, 10);
    for (const r of res.results.filter(x => x.bill_id)) db.run('UPDATE bills SET issue_date=?, due_date=?, created_at=? WHERE id=?', issue, due, issue + ' 09:00:00', r.bill_id);
    for (const r of res.results.filter(x => x.bill_id)) {
      const b = db.get('SELECT * FROM bills WHERE id=?', r.bill_id);
      const behaviour = rnd();
      const late = mo === '2026-09' && rnd() < 0.35; // some September bills still unpaid (arrears demo)
      if (behaviour < 0.12 || late) continue;
      const amt = behaviour < 0.22 ? billing.r2(b.total * 0.5) : b.total;
      const when = new Date(Date.parse(issue) + between(2, 20) * 86400e3).toISOString();
      const method = pick(['cash', 'cash', 'mobile_money_mtn', 'mobile_money_orange', 'bank_transfer']);
      billing.recordPayment(CASH, { customer_id: b.customer_id, bill_id: b.id, amount: amt, method, reference: method === 'cash' ? null : 'DEMO-TX-' + Math.floor(between(100000, 999999)) + '-' + b.id, received_at: when });
    }
  }
  billing.refreshAllBills();

  // Payment tendered in USD on an LRD account (shows configured-rate conversion), and a reversed payment
  const lrdCust = customers[1];
  billing.recordPayment(CASH, { customer_id: lrdCust.id, amount: 10, currency: 'USD', method: 'cash', received_at: '2026-10-20T10:15:00.000Z', notes: 'Customer paid in USD (demo)' });
  const wrong = billing.recordPayment(CASH, { customer_id: customers[6].id, amount: 500, method: 'mobile_money_orange', reference: 'DEMO-TX-WRONGACCT', received_at: '2026-10-18T11:00:00.000Z' });
  billing.reversePayment(ctxOf(U.cashier2), wrong.id, 'Posted to wrong account — customer reference mismatch (demo)');
  // Pending adjustment awaiting manager approval (maker-checker)
  db.run(`INSERT INTO adjustments(customer_id, amount, currency, category, reason, status, created_by) VALUES (?,?,?,?,?,'pending',?)`, customers[0].id, -200, 'LRD', 'leak_relief', 'Leak on customer side repaired within 7 days — 50% relief on excess (demo)', U.cashier);
  // Prepaid demo account credit
  const prepaid = customers.find(c => c.area === GVW && db.get('SELECT billing_mode FROM customers WHERE id=?', c.id).billing_mode === 'prepaid');
  billing.recordPayment(CASH, { customer_id: prepaid.id, amount: 2000, method: 'cash', purpose: 'prepaid_credit', received_at: '2026-10-02T09:00:00.000Z', notes: 'Prepaid credit top-up (future-ready mode, demo)' });

  // ---- Bulk supply (district meter manual readings) for NRW comparison ----
  for (const mo of months.slice(0, 5)) {
    const billedR = db.get(`SELECT SUM(b.consumption) s FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.period_end=?`, RVS.id, lastDay(mo)).s || 0;
    const billedH = db.get(`SELECT SUM(b.consumption) s FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.period_end=?`, HLT.id, lastDay(mo)).s || 0;
    db.run(`INSERT INTO bulk_supply(area_id, asset_id, period_start, period_end, volume_m3, source, notes, entered_by) VALUES (?,?,?,?,?,'district_meter_manual',?,?)`, RVS.id, assets.rvsDma, mo + '-01', lastDay(mo), Math.round(billedR * between(1.42, 1.7)), 'DMA-1 manual reading (demo)', U.manager);
    db.run(`INSERT INTO bulk_supply(area_id, asset_id, period_start, period_end, volume_m3, source, notes, entered_by) VALUES (?,?,?,?,?,'district_meter_manual',?,?)`, HLT.id, assets.hltDma, mo + '-01', lastDay(mo), Math.round(billedH * between(1.12, 1.25)), 'District meter manual reading (demo)', U.manager);
  }
  db.run(`INSERT INTO bulk_supply(area_id, asset_id, period_start, period_end, volume_m3, source, notes, entered_by) VALUES (?,?,?,?,?,'manual_estimate',?,?)`, GVW.id, assets.gvwSrc, '2026-09-01', '2026-09-30', 690, 'Estimated from pump hours × rated flow (demo) — no bulk meter', U.manager);

  // ---- Simulator activity (fictional device data) ----
  const simMeters = customers.filter(c => c.method === 'simulator');
  integ.simulate(A, SIM, { scenario: 'normal', meter_id: simMeters[0].mid, hours: 48 });
  integ.simulate(A, SIM, { scenario: 'normal', meter_id: simMeters[1].mid, hours: 48 });
  integ.simulate(A, SIM, { scenario: 'leak', meter_id: simMeters[2].mid, hours: 36 });
  integ.simulate(A, SIM, { scenario: 'reverse_flow', meter_id: simMeters[3].mid, hours: 24 });

  // ---- Alerts & work orders ----
  const run = alerts.run(ctxOf(U.manager));
  const leak = db.get(`SELECT * FROM alerts WHERE rule_type='continuous_flow' LIMIT 1`);
  if (leak) {
    const n = billing.nextNumber('wo', x => 'WO-' + x);
    const w = db.run(`INSERT INTO work_orders(wo_number, alert_id, type, priority, title, description, customer_id, meter_id, area_id, lat, lng, assigned_to, status, due_date, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'in_progress',?,?)`,
      n, leak.id, 'leak', 'high', 'Investigate continuous flow (simulated data)', 'Simulator shows flow never stops. Check customer-side plumbing and service line.', leak.customer_id, leak.meter_id, leak.area_id, leak.lat, leak.lng, U.tech1, '2026-11-03', U.manager).id;
    db.run(`UPDATE alerts SET status='work_order', assigned_to=? WHERE id=?`, U.tech1, leak.id);
    db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', w, U.manager, 'assigned', 'Created from alert #' + leak.id);
    db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,?,?)', w, U.tech1, 'in_progress', 'On site. Toilet cistern overflow suspected (demo).');
  }
  const n2 = billing.nextNumber('wo', x => 'WO-' + x);
  const w2 = db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, asset_id, area_id, lat, lng, assigned_to, status, created_by, completed_at, resolution) VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?,?,?)`,
    n2, 'network', 'medium', 'Repair burst on 150 mm trunk main (demo)', 'Reported by community leader.', assets.rvsPipe, RVS.id, RVS.lat + 0.002, RVS.lng, U.tech2, U.manager, '2026-10-12T15:30:00.000Z', 'Clamp fitted; 2 h supply interruption.').id;
  db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note, created_at) VALUES (?,?,?,?,?)', w2, U.tech2, 'completed', 'Clamp fitted; 2 h supply interruption.', '2026-10-12 15:30:00');
  const n3 = billing.nextNumber('wo', x => 'WO-' + x);
  db.run(`INSERT INTO work_orders(wo_number, type, priority, title, description, asset_id, area_id, lat, lng, status, created_by, due_date) VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)`,
    n3, 'network', 'medium', 'Inspect high-lift pump bearings (demo)', 'Bearing noise logged during inspection.', assets.rvsPump, RVS.id, RVS.lat + 0.007, RVS.lng - 0.007, U.manager, '2026-11-07');

  db.run(`INSERT INTO service_notices(title, body, area_id, notice_type, starts_at, ends_at, created_by) VALUES (?,?,?,?,?,?,?)`, 'Planned maintenance — Riverside (demo)',
    'Water supply will be interrupted on 5 November 2026 from 08:00 to 14:00 for pump maintenance. Please store water in advance. (Fictional demo notice)', RVS.id, 'maintenance', '2026-11-05', '2026-11-05', U.manager);
  db.run(`INSERT INTO service_notices(title, body, notice_type, created_by) VALUES (?,?,?,?)`, 'Pay by mobile money (demo)', 'You can pay your water bill with mobile money. Always quote your customer number as the reference. (Fictional demo notice)', 'billing', U.manager);

  // ---- Customer portal users ----
  const cu1 = customers[0], cu2 = customers.find(c => c.area === HLT && c.type === 'business');
  mk('customer1', cu1.name, 'customer', { customer_id: cu1.id });
  mk('customer2', cu2.name, 'customer', { customer_id: cu2.id });


  // ================= Community access: water points, water cards, mobile money, SMS/USSD =================
  db.run(`UPDATE settings SET value='*384*77#' WHERE key='ussd_code'`);
  for (const [k, v] of [['connection_base_fee', '35'], ['connection_pipe_cost_per_m', '1.5'], ['connection_meter_cost', '45']]) db.run('UPDATE settings SET value=? WHERE key=?', v, k); // demo standard costs (USD)
  db.run(`UPDATE settings SET value='DEMO-MTN-55501' WHERE key='momo_mtn_merchant'`);
  db.run(`UPDATE settings SET value='DEMO-OM-77802' WHERE key='momo_orange_merchant'`);
  U.attendant1 = mk('attendant1', 'Demo Attendant — Greenvale tap stands', 'attendant', { area_id: GVW.id });
  U.attendant2 = mk('attendant2', 'Demo Attendant — Riverside kiosk', 'attendant', { area_id: RVS.id });
  const pwpMeter = name => db.get(`SELECT m.id FROM meters m JOIN customers c ON c.id=m.customer_id WHERE c.name=?`, name).id;
  db.run(`INSERT INTO wp_config(asset_id, mode, currency, container_liters, price_per_container, attendant_user_id, committee, meter_id, opening_hours) VALUES (?,?,?,?,?,?,?,?,?)`,
    assets.rvsKiosk, 'pay_per_container', 'LRD', 20, 5, U.attendant2, 'Riverside Market Water Committee (demo)', pwpMeter('Riverside Market Kiosk (demo water point)'), '06:00–19:00');
  db.run(`INSERT INTO wp_config(asset_id, mode, currency, container_liters, price_per_container, attendant_user_id, committee, meter_id, opening_hours) VALUES (?,?,?,?,?,?,?,?,?)`,
    assets.gvwTap1, 'pay_per_container', 'LRD', 20, 5, U.attendant1, 'Greenvale WASH Committee (demo)', pwpMeter('Greenvale Tap Stand 1 (demo)'), '06:00–18:00');
  db.run(`INSERT INTO wp_config(asset_id, mode, currency, container_liters, price_per_container, attendant_user_id, committee, opening_hours, active) VALUES (?,?,?,?,?,?,?,?,0)`,
    assets.gvwTap2, 'pay_per_container', 'LRD', 20, 5, U.attendant1, 'Greenvale WASH Committee (demo)', '06:00–18:00');
  // Water cards
  const wallets = [];
  const cardHolders = [['Esther Gbeh', GVW], ['Moses Tarpeh', GVW], ['Hawa Kollie', GVW], ['Prince Mulbah', GVW], ['Ruth Sackor', GVW], ['Korto Doe', GVW], ['Fatu Wesseh', RVS], ['Samuel Nyumah', RVS], ['Grace Flomo', RVS]];
  cardHolders.forEach(([n, a], i) => {
    const card = `DEMO-WC-${a.code}-${String(wallets.filter(w => w.area === a).length + 1).padStart(4, '0')}`;
    const id = db.run('INSERT INTO wp_wallets(card_number, holder_name, phone, area_id, currency, household_size, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', card, n + ' (demo)', i % 2 ? null : '+231 88' + (5000000 + i * 1111), a.id, 'LRD', 3 + (i % 5), U.cashier, '2026-09-01 10:00:00').id;
    wallets.push({ id, card, area: a });
    db.run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, 'seq_card_' + a.code, String(wallets.filter(w => w.area === a).length));
  });
  // Kiosk sales between the September and October tap-meter readings (≈ 88% / 70% of metered volume recorded as sold)
  const salesFor = (assetId, meterId, ratio, attendant) => {
    const rs = db.all(`SELECT * FROM readings WHERE meter_id=? ORDER BY reading_at DESC LIMIT 2`, meterId); const [b, a] = rs;
    let litres = ((b.value - a.value) * 1000) * ratio; const t0 = Date.parse(a.reading_at), t1 = Date.parse(b.reading_at);
    const myWallets = wallets.filter(w => db.get('SELECT area_id FROM assets WHERE id=?', assetId).area_id === w.area.id);
    let k = 0;
    while (litres > 0) {
      const n = Math.min(Math.ceil(litres / 20), 1 + Math.floor(rnd() * 6)); litres -= n * 20; k++;
      const at = new Date(t0 + rnd() * (t1 - t0)); at.setUTCHours(6 + Math.floor(rnd() * 12));
      if (at.getTime() <= t0 || at.getTime() > t1) continue;
      const useCard = myWallets.length && rnd() < 0.18; const w = useCard ? pick(myWallets) : null;
      db.run(`INSERT INTO wp_transactions(asset_id, wallet_id, type, containers, liters, amount, currency, method, attendant_user_id, client_uuid, captured_at, offline, flags) VALUES (?,?,'sale',?,?,?,'LRD',?,?,?,?,?,?)`,
        assetId, w && w.id, n, n * 20, n * 5, useCard ? 'wallet' : 'cash', attendant, `seed-${assetId}-${k}`, at.toISOString(), rnd() < 0.15 ? 1 : 0, '[]');
      if (w) db.run('UPDATE wp_wallets SET balance = balance - ? WHERE id=?', n * 5, w.id);
    }
  };
  salesFor(assets.gvwTap1, pwpMeter('Greenvale Tap Stand 1 (demo)'), 0.88, U.attendant1);
  salesFor(assets.rvsKiosk, pwpMeter('Riverside Market Kiosk (demo water point)'), 0.70, U.attendant2);
  // Card top-ups (cash at kiosk) so balances are positive, plus a handover with a small shortfall
  for (const w of wallets) {
    const spent = -db.get('SELECT balance b FROM wp_wallets WHERE id=?', w.id).b;
    const amt = Math.ceil((spent + 50 + rnd() * 150) / 50) * 50;
    db.run(`INSERT INTO wp_transactions(asset_id, wallet_id, type, amount, currency, method, attendant_user_id, client_uuid, captured_at) VALUES (?,?,'topup',?,'LRD','cash',?,?,?)`,
      w.area === GVW ? assets.gvwTap1 : assets.rvsKiosk, w.id, amt, w.area === GVW ? U.attendant1 : U.attendant2, 'seed-top-' + w.id, '2026-09-26T09:00:00.000Z');
    db.run('UPDATE wp_wallets SET balance = round(balance + ?, 2) WHERE id=?', amt, w.id);
  }
  const wpSvc = require('./services/waterpoints');
  const rec = wpSvc.reconcile(assets.gvwTap1, '2026-10-01', '2026-10-15');
  wpSvc.handover(ctxOf(U.cashier), { asset_id: assets.gvwTap1, period_from: '2026-10-01', period_to: '2026-10-15', amount: Math.round(rec.expected_cash - 35), note: 'Attendant reports 35 L$ given as change to a regular customer (demo)' });

  // Mobile money: auto-matched by account number, by sender phone, a water-card top-up, and some that need a cashier
  const momo = require('./services/momo');
  const mctx = ctxOf(U.cashier);
  const owing = db.all(`SELECT c.id, c.customer_number, c.phone, b.total, b.currency FROM bills b JOIN customers c ON c.id=b.customer_id WHERE b.status IN ('issued','overdue','partially_paid') AND b.period_end='2026-09-30' ORDER BY c.id LIMIT 6`);
  owing.forEach((o, i) => momo.ingest(mctx, { provider: i % 2 ? 'orange' : 'mtn', txn_ref: `DEMO-${i % 2 ? 'OM' : 'MP'}2610${String(3000 + i)}`, msisdn: i === 2 ? o.phone : '+231 77' + (6000000 + i * 37), amount: o.total, currency: o.currency,
    account_ref: i === 2 ? null : o.customer_number.replace('DEMO-', '').toLowerCase(), received_at: `2026-10-${String(24 + i).padStart(2, '0')}T1${i}:05:00.000Z`, source: 'webhook' }));
  momo.ingest(mctx, { provider: 'mtn', txn_ref: 'DEMO-MP26103101', msisdn: '+231 88 5000000', amount: 200, currency: 'LRD', account_ref: wallets[0].card.replace('DEMO-', ''), received_at: '2026-10-29T08:12:00.000Z', source: 'webhook' });
  momo.ingest(mctx, { provider: 'mtn', txn_ref: 'DEMO-MP26103102', msisdn: '+231 77 1234567', amount: 750, currency: 'LRD', account_ref: 'water bill', received_at: '2026-10-30T10:40:00.000Z', source: 'webhook' });
  momo.ingest(mctx, { provider: 'orange', txn_ref: 'DEMO-OM26103103', msisdn: '+231 88 7654321', amount: 12, currency: 'USD', account_ref: 'HLT 0099', received_at: '2026-10-30T15:02:00.000Z', source: 'webhook' });

  // Feature-phone interactions (via the same handlers a live aggregator would call)
  const channels = require('./services/channels');
  const ph = db.get('SELECT phone FROM customers WHERE id=?', customers[4].id).phone;
  const sctx = { ip: 'demo-seed', simulated: true };
  channels.smsInbound(sctx, { phone: ph, body: 'BAL' });
  channels.ussd(sctx, { sessionId: 'demo-1', phone: db.get('SELECT phone FROM customers WHERE id=?', customers[10].id).phone, text: '4*2' });
  channels.smsInbound(sctx, { phone: db.get('SELECT phone FROM customers WHERE id=?', customers[12].id).phone, body: 'READ ' + Math.round(db.get('SELECT last_reading_value v FROM meters WHERE id=?', customers[12].mid).v + 31) });


  // ================= Community, water quality, humane collections =================
  for (const c of customers) if (c.type === 'household') db.run('UPDATE customers SET household_size=? WHERE id=?', 3 + Math.floor(rnd() * 6), c.id);
  db.run(`UPDATE settings SET value='12000' WHERE key='median_household_income_LRD'`); // DEMO assumption, editable in Settings
  db.run(`UPDATE settings SET value='65' WHERE key='median_household_income_USD'`);
  const quality = require('./services/quality'); quality.ensureParams();
  const T1 = ctxOf(U.tech1);
  const dayIso = (d, h = 8) => new Date(Date.parse('2026-10-31T00:00:00Z') - d * 86400e3 + h * 3600e3).toISOString();
  for (let d = 27; d >= 0; d -= 1) {
    const cl1 = Math.round((0.35 + rnd() * 0.4) * 100) / 100;
    quality.record(ctxOf(U.attendant1), { asset_id: assets.gvwTap1, parameter: 'free_chlorine', value: cl1, sampled_at: dayIso(d, 7), method: 'field_kit' });
    const cl2 = d === 3 ? 0.1 : Math.round((0.3 + rnd() * 0.35) * 100) / 100; // dosing pump fault 3 days ago, fixed next day
    if (d % 2 === 1 || d <= 3) quality.record(ctxOf(U.attendant2), { asset_id: assets.rvsKiosk, parameter: 'free_chlorine', value: cl2, sampled_at: dayIso(d, 7), method: 'field_kit', notes: d === 3 ? 'Dosing pump stopped (demo)' : null });
    if (d % 7 === 0) { quality.record(T1, { asset_id: assets.rvsRes, parameter: 'turbidity', value: Math.round((0.4 + rnd() * 0.5) * 100) / 100, sampled_at: dayIso(d, 9), method: 'field_kit' });
      quality.record(T1, { asset_id: assets.rvsRes, parameter: 'ecoli', value: 0, sampled_at: dayIso(d, 9), method: 'lab' }); }
  }
  quality.record(T1, { asset_id: assets.hltRes, parameter: 'free_chlorine', value: 0.4, sampled_at: dayIso(6, 10), method: 'field_kit' });
  quality.record(T1, { asset_id: assets.hltRes, parameter: 'turbidity', value: 7.8, sampled_at: dayIso(1, 10), method: 'field_kit', notes: 'Heavy rain; reservoir inlet silty (demo)' });

  // Payment plans: one on track, one falling behind; then the daily reminder run
  const col = require('./services/collections');
  const ladder0 = col.ladder().filter(r => !r.essential && r.balance > 0);
  if (ladder0[0]) { const pl = col.createPlan(ctxOf(U.cashier), { customer_id: ladder0[0].customer_id, down_payment: Math.round(ladder0[0].balance * 0.2), instalments: 4, frequency: 'monthly', start_date: '2026-10-31', notes: 'Agreed at office visit (demo)' });
    billing.recordPayment(CASH, { customer_id: ladder0[0].customer_id, amount: Math.round(ladder0[0].balance * 0.2), method: 'cash', received_at: new Date().toISOString(), notes: 'Plan down payment (demo)' }); }
  if (ladder0[1]) col.createPlan(ctxOf(U.cashier), { customer_id: ladder0[1].customer_id, instalments: 6, frequency: 'weekly', start_date: new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10), notes: 'Agreed by phone (demo)' });
  col.runReminders(ctxOf(U.cashier));

  // Community reports (no login): one resolved (reporter notified by SMS), one being worked on, one new
  const community = require('./services/community');
  const pctx = { ip: 'demo-public' };
  const r1 = community.report(pctx, { kind: 'burst', area_id: RVS.id, location_text: 'Behind the football field, Church Road (demo)', phone: '+231 886 100 200', channel: 'web', description: 'Water shooting up from the ground' });
  const r2 = community.report(pctx, { kind: 'no_water', area_id: HLT.id, location_text: 'Mission Hill top houses (demo)', phone: '+231 776 300 400', channel: 'ussd' });
  community.report(pctx, { kind: 'quality', asset_id: assets.gvwTap1, location_text: 'Tap stand 1 (demo)', channel: 'web', description: 'Water looks a bit brown this morning' });
  const wo1 = billing.nextNumber('wo', x => 'WO-' + x);
  const w1 = db.run(`INSERT INTO work_orders(wo_number, alert_id, type, priority, title, area_id, assigned_to, status, created_by, completed_at, resolution) VALUES (?,?,?,?,?,?,?,'completed',?,?,?)`, wo1, r1.alert_id, 'leak', 'high', 'Repair burst reported by community (demo)', RVS.id, U.tech2, U.manager, new Date().toISOString(), 'Pipe clamp fitted (demo)').id;
  db.run(`UPDATE alerts SET status='resolved', resolved_at=?, resolution_note=? WHERE id=?`, new Date().toISOString(), 'Repaired by ' + wo1, r1.alert_id);
  db.run(`UPDATE alerts SET detected_at=? WHERE id=?`, new Date(Date.now() - 19 * 3600e3).toISOString(), r1.alert_id); // reported 19 h before the repair
  community.closeLoop(r1.alert_id);
  const wo2 = billing.nextNumber('wo', x => 'WO-' + x);
  db.run(`INSERT INTO work_orders(wo_number, alert_id, type, priority, title, area_id, assigned_to, status, created_by, due_date) VALUES (?,?,?,?,?,?,?,'in_progress',?,?)`, wo2, r2.alert_id, 'network', 'medium', 'Investigate low pressure on Mission Hill (demo)', HLT.id, U.tech1, U.manager, '2026-11-02');
  db.run(`UPDATE alerts SET status='work_order', assigned_to=? WHERE id=?`, U.tech1, r2.alert_id);
  db.run(`INSERT INTO service_notices(title, body, area_id, notice_type, starts_at, ends_at, created_by) VALUES (?,?,?,?,?,?,?)`, 'Pipe replacement on Bridge Street (demo)', 'Supply in the lower Riverside zone will be interrupted from 09:00 to 15:00 for main replacement. Store water the day before. (Fictional demo notice)', RVS.id, 'maintenance', '2026-11-01', '2026-11-01', U.manager);

  // ================= Growth: new connections, shared compound, running costs =================
  const conn = require('./services/connections');
  const mctx2 = ctxOf(U.manager);
  const ap = (name, area, extra) => conn.submit({ ip: 'demo-public-' + name }, { applicant_name: name, phone: extra.phone, area_id: area.id, address: extra.address, landmark: extra.landmark, customer_type: extra.type || 'household', household_size: extra.hh || null, channel: extra.channel || 'web' });
  const back = (id, days) => { const t = new Date(Date.now() - days * 86400e3).toISOString().replace('T', ' ').slice(0, 19); db.run('UPDATE connection_requests SET created_at=? WHERE id=?', t, id); db.run('UPDATE connection_request_events SET created_at=? WHERE request_id=? AND status=?', t, id, 'submitted'); };
  const c1 = ap('Musu Tarpeh (demo applicant)', RVS, { phone: '+231 776 410 001', address: '14 Ashmun Lane, Riverside (demo)', landmark: 'Opposite the tailor shop', hh: 7 }); back(c1.id, 2);
  const c2 = ap('Prince Gbollie (demo applicant)', HLT, { phone: '+231 886 410 002', address: 'Mission Hill Road (demo)', hh: 5, channel: 'ussd' }); back(c2.id, 9);
  conn.advance(mctx2, c2.id, 'schedule_survey', { assigned_to: U.tech1, due_date: new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10) });
  const c3 = ap('New Hope Clinic (demo applicant)', RVS, { phone: '+231 776 410 003', address: 'Clinic Road, Riverside (demo)', type: 'institution' }); back(c3.id, 16);
  conn.advance(mctx2, c3.id, 'schedule_survey', { assigned_to: U.tech1 }); conn.advance(mctx2, c3.id, 'record_survey', { distance_m: 35, notes: 'Main on Clinic Road; good pressure (demo)' });
  conn.advance(mctx2, c3.id, 'quote', { lines: conn.defaultQuote(db.get('SELECT * FROM connection_requests WHERE id=?', c3.id)).lines });
  const c4 = ap('Esther Flomo (demo applicant)', RVS, { phone: '+231 776 410 004', address: '3 Bridge Street, Riverside (demo)', hh: 6 }); back(c4.id, 25);
  conn.advance(mctx2, c4.id, 'schedule_survey', { assigned_to: U.tech1 }); conn.advance(mctx2, c4.id, 'record_survey', { distance_m: 12 });
  conn.advance(mctx2, c4.id, 'quote', { lines: conn.defaultQuote(db.get('SELECT * FROM connection_requests WHERE id=?', c4.id)).lines });
  conn.advance(mctx2, c4.id, 'accept', { deposit: 3000, instalments: 6 });
  const c5 = ap('Joseph Kollie (demo applicant)', RVS, { phone: '+231 776 410 005', address: '22 Market Street, Riverside (demo)', hh: 4 }); back(c5.id, 40);
  conn.advance(mctx2, c5.id, 'schedule_survey', { assigned_to: U.tech1 }); conn.advance(mctx2, c5.id, 'record_survey', { distance_m: 18 });
  conn.advance(mctx2, c5.id, 'quote', { lines: conn.defaultQuote(db.get('SELECT * FROM connection_requests WHERE id=?', c5.id)).lines });
  const a5 = conn.advance(mctx2, c5.id, 'accept', { deposit: 4000, instalments: 8 });
  billing.recordPayment(ctxOf(U.cashier), { customer_id: a5.customer_id, amount: 4000, method: 'mobile_money_mtn', reference: 'DEMO-MP26100777', notes: 'Connection deposit (demo)' });
  conn.advance(mctx2, c5.id, 'start_install', { assigned_to: U.tech1 });
  conn.advance(mctx2, c5.id, 'complete', { meter_id: db.get(`SELECT id FROM meters WHERE serial_number='DMSTOCK00001'`).id, initial_reading: 0 });
  const c6 = ap('Hilltop Bar (demo applicant)', HLT, { phone: '+231 886 410 006', address: 'Far side of the river (demo)', type: 'business' }); back(c6.id, 30);
  conn.advance(mctx2, c6.id, 'record_survey', { feasible: false, notes: 'Nearest main 900 m away across the river — not feasible until the network extension (demo)' });

  // Spread each demo request's history between its application date and today (the services stamp "now")
  for (const r of db.all('SELECT id, created_at FROM connection_requests')) {
    const ev = db.all('SELECT id FROM connection_request_events WHERE request_id=? ORDER BY id', r.id); const t0 = Date.parse(r.created_at.replace(' ', 'T') + 'Z'), t1 = Date.now() - 86400e3 * 0.6;
    ev.forEach((e, i) => { if (i) db.run('UPDATE connection_request_events SET created_at=? WHERE id=?', new Date(t0 + (t1 - t0) * i / Math.max(1, ev.length - 1)).toISOString().replace('T', ' ').slice(0, 19), e.id); });
  }

  // A shared compound: one meter, three households
  const shared = require('./services/shared');
  const compound = db.get(`SELECT c.* FROM customers c JOIN bills b ON b.customer_id=c.id WHERE c.customer_type='household' AND c.area_id=? AND b.status NOT IN ('paid','cancelled') ORDER BY b.period_end DESC, c.id LIMIT 1`, RVS.id);
  if (compound) shared.saveGroup(mctx2, compound.id, { split_method: 'household_size', members: [{ name: compound.name.replace(/ household$/, '') + ' (account holder)', phone: compound.phone, household_size: 6 }, { name: 'Tenant room A (demo)', phone: '+231 776 520 001', household_size: 3 }, { name: 'Tenant room B (demo)', phone: '+231 776 520 002', household_size: 2 }], notes: 'Yard compound, one meter (demo)' });

  // Running (O&M) costs and staff/supply inputs, May–October, so cost recovery can be shown
  const CAT = [['energy_fuel', .38], ['chemicals', .08], ['staff', .34], ['repairs', .12], ['transport', .05], ['admin', .03]];
  for (const a of areas) {
    for (const [mo, k] of [['2026-05', .95], ['2026-06', 1.02], ['2026-07', 1.1], ['2026-08', .98], ['2026-09', 1.05], ['2026-10', 1.0]]) {
      const billed = db.get(`SELECT COALESCE(SUM(b.total),0) s FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND substr(b.period_end,1,7)=? AND b.status!='cancelled'`, a.id, mo).s;
      const avg = db.get(`SELECT COALESCE(AVG(t),0) s FROM (SELECT SUM(b.total) t FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.status!='cancelled' GROUP BY substr(b.period_end,1,7))`, a.id).s;
      const base = (billed || avg) * ({ RVS: 0.92, HLT: 1.18, GVW: 0.75 }[a.code] || 1) * k; if (!base) continue;
      for (const [cat, sh] of CAT) db.run('INSERT INTO om_costs(area_id, period, category, amount, currency, notes, entered_by) VALUES (?,?,?,?,?,?,?)', a.id, mo, cat, Math.round(base * sh * 100) / 100, a.currency, 'Demo figure', U.manager);
      db.run('INSERT INTO kpi_inputs(area_id, period, staff_count, supply_hours_per_day) VALUES (?,?,?,?) ON CONFLICT(area_id, period) DO NOTHING', a.id, mo, { RVS: 6, HLT: 3, GVW: 2 }[a.code] || 3, { RVS: 18, HLT: 12, GVW: 22 }[a.code] || 16);
    }
  }

  // ================= Service delivery: supply timetables, stores, meter ages, feedback =================
  const supplySvc = require('./services/supply'); const sup = ctxOf(U.manager);
  const sA = supplySvc.save(sup, null, { area_id: RVS.id, zone: 'Zone A — upper town', days: '1357', start_time: '06:00', end_time: '10:00', notes: 'Generator-pumped; rationed (demo)' }).id;
  const sB = supplySvc.save(sup, null, { area_id: RVS.id, zone: 'Zone B — riverside', days: '0246', start_time: '06:00', end_time: '10:00', notes: 'Generator-pumped; rationed (demo)' }).id;
  const sH1 = supplySvc.save(sup, null, { area_id: HLT.id, days: '0123456', start_time: '06:00', end_time: '09:00', notes: 'Morning pumping (demo)' }).id;
  const sH2 = supplySvc.save(sup, null, { area_id: HLT.id, days: '0123456', start_time: '17:00', end_time: '20:00', notes: 'Evening pumping (demo)' }).id;
  db.all(`SELECT id FROM customers WHERE area_id=? ORDER BY id`, RVS.id).forEach((c, i) => db.run('UPDATE customers SET supply_zone=? WHERE id=?', i % 2 ? 'Zone B — riverside' : 'Zone A — upper town', c.id));
  // 30 days of delivery records: mostly delivered, some short (fuel, pump) — so reliability is realistic
  const oper = ctxOf(U.tech1); const REASONS = ['Generator fuel ran out', 'Pump tripped — restarted', 'Low water at intake', 'Power cut at pump house'];
  let sSeed = 7;
  const srnd = () => { sSeed = (sSeed * 9301 + 49297) % 233280; return sSeed / 233280; };
  for (let d = 30; d >= 1; d--) {
    const date = new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);
    for (const sid of [sA, sB, sH1, sH2]) {
      const s = db.get('SELECT * FROM supply_schedules WHERE id=?', sid); const w = supplySvc.windows(s, date, date)[0]; if (!w) continue;
      const x = srnd(); const hrs = x < 0.07 ? 0 : x < 0.2 ? Math.round(w.hours * (0.3 + srnd() * 0.5) * 2) / 2 : w.hours;
      supplySvc.log(oper, { schedule_id: sid, supply_date: date, delivered_hours: hrs, reason: hrs < w.hours * 0.9 ? REASONS[Math.floor(srnd() * REASONS.length)] : null });
    }
  }
  // the most recent window of each schedule is left un-logged so the "to record" list has something in it
  db.run(`DELETE FROM supply_log WHERE supply_date=(SELECT MAX(supply_date) FROM supply_log WHERE schedule_id=?) AND schedule_id=?`, sH2, sH2);

  // Stores
  const stockSvc = require('./services/stock'); const stc = ctxOf(U.manager);
  const ITEMS = [['PIPE-HDPE-20', 'HDPE pipe 20 mm (per metre)', 'pipe', 'm', 100, 0.85, 400], ['PIPE-HDPE-63', 'HDPE pipe 63 mm (per metre)', 'pipe', 'm', 30, 4.2, 60],
    ['FIT-CPL-20', 'Compression coupling 20 mm', 'fitting', 'pcs', 20, 2.1, 45], ['FIT-SAD-63', 'Tapping saddle 63×20 mm', 'fitting', 'pcs', 10, 6.5, 14], ['FIT-BV-20', 'Ball valve 20 mm', 'fitting', 'pcs', 10, 4.8, 8],
    ['MTR-BOX', 'Meter box with lid', 'meter_part', 'pcs', 5, 9, 12], ['MTR-SEAL', 'Meter tamper seals', 'meter_part', 'pcs', 50, 0.15, 300], ['CHEM-HTH', 'HTH chlorine granules 65%', 'chemical', 'kg', 25, 4.5, 40],
    ['CHEM-DPD', 'DPD chlorine test tablets', 'chemical', 'tablets', 100, 0.12, 80], ['TOOL-TAPE', 'PTFE tape roll', 'other', 'rolls', 20, 0.4, 60]];
  const itemId = {};
  for (const [code, name, cat, unit, re, cost, qty] of ITEMS) { itemId[code] = stockSvc.saveItem(stc, null, { code, name: name + ' (demo)', category: cat, unit, reorder_level: re, unit_cost: cost, currency: 'USD', location: 'Main store, Riverside' }).id;
    stockSvc.move(stc, { item_id: itemId[code], qty, kind: 'receive', reference: 'DEMO-GRN-0' + (Object.keys(itemId).length), unit_cost: cost, notes: 'Opening stock (demo)' }); }
  const anyWo = db.all(`SELECT id FROM work_orders ORDER BY id LIMIT 4`);
  if (anyWo[0]) { stockSvc.move(stc, { item_id: itemId['PIPE-HDPE-20'], qty: 6, kind: 'issue', work_order_id: anyWo[0].id }); stockSvc.move(stc, { item_id: itemId['FIT-CPL-20'], qty: 2, kind: 'issue', work_order_id: anyWo[0].id }); }
  if (anyWo[1]) { stockSvc.move(stc, { item_id: itemId['FIT-SAD-63'], qty: 1, kind: 'issue', work_order_id: anyWo[1].id }); stockSvc.move(stc, { item_id: itemId['FIT-BV-20'], qty: 1, kind: 'issue', work_order_id: anyWo[1].id }); }
  for (const [d, q] of [[80, 6], [55, 6], [28, 6], [6, 5]]) db.run(`INSERT INTO stock_movements(item_id, qty, kind, unit_cost, notes, user_id, created_at) VALUES (?,?,'use',4.5,'Chlorination of tanks and kiosks (demo)',?,datetime('now', ?))`, itemId['CHEM-HTH'], -q, U.tech1, `-${d} day`); // history
  stockSvc.move(stc, { item_id: itemId['CHEM-DPD'], qty: 25, kind: 'use', notes: 'Free-chlorine tests at water points (demo)' });
  stockSvc.move(stc, { item_id: itemId['FIT-BV-20'], qty: -2, kind: 'adjust', notes: 'Stock count: 2 found damaged (demo)' });

  // Older, carried-over meters so the replacement planner has something to rank
  const oldMeters = db.all(`SELECT m.id FROM meters m JOIN customers c ON c.id=m.customer_id WHERE m.meter_type='mechanical' AND m.is_bulk=0 AND c.area_id IN (?,?) ORDER BY m.id`, RVS.id, HLT.id);
  oldMeters.forEach((m, i) => { if (i % 3 === 0) db.run('UPDATE meters SET install_date=? WHERE id=?', `${2012 + (i % 10)}-0${1 + (i % 9)}-15`, m.id); });

  // Feedback replies by SMS on completed jobs
  const fb = require('./services/feedback');
  const doneWo = db.all(`SELECT w.*, c.phone cphone FROM work_orders w LEFT JOIN customers c ON c.id=w.customer_id WHERE w.status='completed' AND NOT EXISTS (SELECT 1 FROM feedback_requests f WHERE f.work_order_id=w.id) ORDER BY w.id LIMIT 6`).map((w, i) => ({ ...w, phone: w.cphone || `+231 770 600 10${i}` }));
  const SCORES = [[4, null], [2, 'Came late and the road is still dug up'], [5, 'Very fast, thank you'], [4, 'Good work'], [5, null], [3, null]];
  doneWo.forEach((w, i) => { const r = fb.request({}, { work_order_id: w.id, customer_id: w.customer_id, phone: w.phone, area_id: w.area_id, technician_id: w.assigned_to || U.tech1, wo_number: w.wo_number });
    if (r && SCORES[i]) require('./services/channels').smsInbound({ ip: 'demo', simulated: true }, { phone: w.phone, body: `${SCORES[i][0]}${SCORES[i][1] ? ' ' + SCORES[i][1] : ''}` }); });

  // ================= Maintenance, functionality, service levels, cash closes =================
  const mtSvc = require('./services/maintenance'); const mgrC = ctxOf(U.manager);
  const AID = code => db.get('SELECT id FROM assets WHERE code=?', code).id;
  const ago = d => new Date(Date.now() - d * 86400e3).toISOString();
  // status history (assets were commissioned in March; a few breakdowns since)
  db.run('DELETE FROM asset_status_log');
  for (const a of db.all('SELECT id FROM assets')) db.run('INSERT INTO asset_status_log(asset_id, status, changed_at, note) VALUES (?,?,?,?)', a.id, 'operational', '2026-03-01T08:00:00.000Z', 'Commissioned (demo)');
  const hist = [['RVS-WP-01', [[44, 'down', 'Tap broken (demo)'], [42, 'operational', 'Tap replaced']]], ['RVS-PMP-01', [[63, 'down', 'Motor overheated (demo)'], [60, 'operational', 'Rewound motor'], [9, 'degraded', 'Low output, bearing noise (demo)']]],
    ['HLT-PMP-01', [[21, 'maintenance', 'Panel cleaning (demo)'], [20.7, 'operational', 'Done']]], ['GVW-WP-02', [[75, 'down', 'Riser pipe leak (demo)'], [71, 'operational', 'Repaired'], [11, 'down', 'Tap and valve stolen (demo)']]], ['GVW-WP-01', [[30, 'down', 'Blocked strainer (demo)'], [29.5, 'operational', 'Cleaned']]]];
  for (const [code, evs] of hist) for (const [d, st, note] of evs) db.run('INSERT INTO asset_status_log(asset_id, status, changed_at, user_id, note) VALUES (?,?,?,?,?)', AID(code), st, ago(d), U.tech1, note);
  // run-hours on the Riverside generator-driven pump (about 4.5 h/day)
  let hrs = 6120; for (let d = 60; d >= 1; d -= 3) { hrs += 13.5 + (d % 2); db.run('INSERT INTO run_hours(asset_id, reading, recorded_at, user_id) VALUES (?,?,?,?)', AID('RVS-PMP-01'), Math.round(hrs * 10) / 10, ago(d), U.tech1); }
  mtSvc.savePlan(mgrC, null, { asset_id: AID('RVS-PMP-01'), title: 'Engine & pump service (oil, filters, belts)', tasks: 'Change engine oil and filters; check belts and couplings; grease pump bearings; check gland packing', interval_hours: 250, interval_days: 90, lead_days: 7, priority: 'high', last_done_at: ago(55), last_done_hours: 6170 });
  mtSvc.savePlan(mgrC, null, { asset_id: AID('HLT-PMP-01'), title: 'Solar array & pump inspection', tasks: 'Clean panels; check cables and controller; measure flow and pressure', interval_days: 90, lead_days: 10, last_done_at: ago(21) });
  mtSvc.savePlan(mgrC, null, { asset_id: AID('RVS-TRT-01'), title: 'Chlorinator calibration', tasks: 'Check dosing pump stroke; calibrate against residual at the tank', interval_days: 30, lead_days: 5, priority: 'high', last_done_at: ago(33) });
  mtSvc.savePlan(mgrC, null, { asset_id: AID('RVS-RES-01'), title: 'Tank cleaning and disinfection', interval_days: 365, lead_days: 30, last_done_at: '2026-03-10T09:00:00.000Z' });
  mtSvc.runDue(mgrC);
  // service-level inputs (estimates, demo)
  for (const [code, pop] of [['RVS', 1400], ['HLT', 750], ['GVW', 520]]) db.run('UPDATE service_areas SET population=? WHERE code=?', pop, code);
  for (const [code, people, min] of [['RVS-WP-01', 260, 20], ['GVW-WP-01', 180, 15], ['GVW-WP-02', 140, 45]]) db.run('UPDATE assets SET served_population=?, round_trip_min=? WHERE code=?', people, min, code);
  require('./services/quality').record(ctxOf(U.tech1), { asset_id: AID('GVW-WP-01'), parameter: 'ecoli', value: 0, method: 'field_kit', sampled_at: ago(12), notes: 'H2S presence/absence kit (demo)' });
  // cashier end-of-day closes: two approved, one waiting with a small shortage
  const ccSvc = require('./services/cashclose'); const cashC = ctxOf(U.cashier);
  const cashDays = db.all(`SELECT DISTINCT date(received_at) d FROM payments WHERE method='cash' AND received_by=? AND received_at < date('now') ORDER BY 1 DESC LIMIT 3`, U.cashier).map(r => r.d).reverse();
  cashDays.forEach((d, i) => { const e = ccSvc.expected(U.cashier, d); const short = i === cashDays.length - 1 ? 50 : 0;
    ccSvc.submit(cashC, { date: d, counts: e.currencies.map((c, j) => ({ currency: c.currency, counted: Math.max(0, c.expected - (short && j === 0 ? (c.currency === 'USD' ? 2 : short) : 0)) })), note: short ? 'Counted twice and came up short — may have given wrong change (demo)' : null });
    if (i < cashDays.length - 1) for (const k of db.all('SELECT id FROM cash_closes WHERE user_id=? AND close_date=?', U.cashier, d)) ccSvc.review(mgrC, k.id, { decision: 'approved' }); });

  // ================= Water Safety Plan (fictional) =================
  const wsp = require('./services/wsp'); const techC = ctxOf(U.tech1);
  wsp.applyTemplate(mgrC, { template: 'piped_chlorinated', area_id: RVS.id });
  wsp.applyTemplate(mgrC, { template: 'kiosk', asset_id: AID('RVS-WP-01') });
  wsp.applyTemplate(mgrC, { template: 'borehole', asset_id: AID('GVW-SRC-01') });
  const HZ = ev => db.get('SELECT * FROM wsp_hazards WHERE event LIKE ? ORDER BY id LIMIT 1', ev + '%');
  const CT = hid => db.get('SELECT * FROM wsp_controls WHERE hazard_id=? ORDER BY id LIMIT 1', hid);
  db.run(`UPDATE wsp_controls SET created_at=?`, ago(60).slice(0, 19).replace('T', ' ')); // the plan was written two months ago
  // tie the Riverside treatment and storage risks to their assets, so chlorine and turbidity tests there are logged automatically
  const hDose = HZ('Chlorine dosing fails'), hTurb = HZ('High turbidity'), hRes = HZ('An open or damaged reservoir'), hPress = HZ('Low or intermittent pressure'), hSrc = HZ('Runoff after heavy rain');
  db.run('UPDATE wsp_hazards SET asset_id=?, owner_id=? WHERE id IN (?,?)', AID('RVS-TRT-01'), U.tech1, hDose.id, hTurb.id);
  db.run('UPDATE wsp_hazards SET asset_id=?, owner_id=? WHERE id=?', AID('RVS-RES-01'), U.tech2, hRes.id);
  db.run('UPDATE wsp_hazards SET asset_id=?, owner_id=? WHERE id=?', AID('RVS-SRC-01'), U.manager, hSrc.id);
  db.run(`UPDATE wsp_controls SET parameter='free_chlorine' WHERE id=?`, CT(hDose.id).id); db.run(`UPDATE wsp_controls SET parameter='turbidity' WHERE id=?`, CT(hTurb.id).id);
  // residual risk after controls, for the risks the team has already re-scored
  for (const [ev, l, s] of [['Chlorine dosing fails', 2, 5], ['High turbidity', 2, 4], ['An open or damaged reservoir', 2, 4], ['Low or intermittent pressure', 3, 4], ['Pipe repairs introduce', 2, 4], ['Hoses, containers or hands', 2, 3], ['No chlorine residual reaches', 2, 4], ['Latrines or waste near', 2, 5], ['A damaged apron', 2, 5]])
    db.run('UPDATE wsp_hazards SET res_likelihood=?, res_severity=? WHERE event LIKE ?', l, s, ev + '%');
  // operational monitoring: daily chlorine at the treatment outlet, weekly checks elsewhere; turbidity is over its limit after rain
  for (let d = 12; d >= 1; d--) wsp.check(techC, CT(hDose.id).id, { value: Math.round((0.6 + rnd() * 0.5) * 100) / 100, checked_at: ago(d + 0.3) });
  for (const d of [22, 15, 8]) wsp.check(techC, CT(hTurb.id).id, { value: Math.round((1.2 + rnd() * 1.5) * 10) / 10, checked_at: ago(d) });
  wsp.check(techC, CT(hTurb.id).id, { value: 7.8, checked_at: ago(1.2), note: 'Heavy rain; raw water silty (demo)' });
  for (const d of [50, 20]) wsp.check(techC, CT(hRes.id).id, { ok: true, checked_at: ago(d), note: 'Hatch locked, screens intact (demo)' });
  for (const d of [20, 13, 6]) wsp.check(techC, CT(HZ('No chlorine residual reaches').id).id, { value: Math.round((0.3 + rnd() * 0.3) * 100) / 100, checked_at: ago(d) });
  wsp.check(techC, CT(HZ('Hoses, containers or hands').id).id, { ok: true, checked_at: ago(4) });
  wsp.check(techC, CT(HZ('The pump breaks down').id).id, { ok: true, checked_at: ago(10) });
  // sanitary inspections from the field
  const yesTo = (form, ids) => Object.fromEntries(wsp.library().forms.find(f => f.key === form).items.map(it => [it.id, ids.includes(it.id)]));
  wsp.recordInspection(techC, { asset_id: AID('GVW-WP-01'), form: 'tapstand', answers: yesTo('tapstand', ['t7']), inspected_at: ago(20), notes: 'Site clean, drainage working (demo)' });
  wsp.recordInspection(techC, { asset_id: AID('GVW-WP-02'), form: 'tapstand', answers: yesTo('tapstand', ['t1', 't2', 't3', 't4', 't6']), inspected_at: ago(5), notes: 'Tap and valve stolen; pipe exposed and site dirty (demo)' });
  wsp.recordInspection(techC, { asset_id: AID('RVS-WP-01'), form: 'tapstand', answers: yesTo('tapstand', ['t2', 't7']), inspected_at: ago(34) });
  wsp.recordInspection(techC, { asset_id: AID('RVS-RES-01'), form: 'storage_tank', answers: yesTo('storage_tank', ['s3']), inspected_at: ago(48) });
  // improvement plan: costed actions, one already with the technicians, one finished
  const a1 = wsp.saveAction(mgrC, null, { hazard_id: hDose.id, title: 'Install a standby dosing pump at the Riverside treatment unit', owner_id: U.manager, due_date: ago(-45).slice(0, 10), cost: 850, currency: 'USD' }).id;
  wsp.saveAction(mgrC, null, { hazard_id: hSrc.id, title: 'Build a cut-off drain above the river intake', owner_id: U.tech2, due_date: ago(9).slice(0, 10), cost: 1200, currency: 'USD' });
  wsp.saveAction(mgrC, null, { hazard_id: hRes.id, title: 'Fit insect screens to the tank vents and overflow', owner_id: U.tech2, due_date: ago(30).slice(0, 10), cost: 60, currency: 'USD', status: 'done' });
  const fenceAct = db.get(`SELECT id FROM wsp_actions WHERE title='Repair the drainage' LIMIT 1`); if (fenceAct) wsp.actionToWorkOrder(mgrC, fenceAct.id, { assigned_to: U.tech1 });
  void a1;
  // today's tests at the treatment outlet and the kiosk are logged against the matching controls automatically
  require('./services/quality').record(techC, { asset_id: AID('RVS-TRT-01'), parameter: 'free_chlorine', value: 0.8, method: 'field_kit', sampled_at: ago(0.1) });
  require('./services/quality').record(techC, { asset_id: AID('RVS-WP-01'), parameter: 'free_chlorine', value: 0.4, method: 'field_kit', sampled_at: ago(0.1) });

  // ================= Pumping energy (fictional): the Riverside diesel pump is getting thirstier as its bearings wear =================
  const enSvc = require('./services/energy');
  ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].forEach((mo, i) => {
    const vol = m => (db.get('SELECT SUM(volume_m3) v FROM bulk_supply WHERE area_id=? AND period_start=?', m, mo + '-01') || {}).v;
    const vr = vol(RVS.id) || 2300, vh = vol(HLT.id) || 700; const perM3 = i === 5 ? 0.41 : 0.3 + (rnd() - 0.5) * 0.03;
    if (vr) enSvc.add(mgrC, { asset_id: AID('RVS-PMP-01'), period_start: mo + '-01', period_end: lastDay(mo), energy_type: 'diesel', quantity: Math.round(vr * perM3), cost: Math.round(vr * perM3 * 1.25), currency: 'USD', volume_m3: vr, run_hours: Math.round(vr / (i === 5 ? 48 : 58)), notes: i === 5 ? 'Fuel use up; bearing noise (demo)' : null });
    if (vh) enSvc.add(mgrC, { asset_id: AID('HLT-PMP-01'), period_start: mo + '-01', period_end: lastDay(mo), energy_type: 'solar', cost: 0, currency: 'USD', volume_m3: vh, notes: 'Solar array, not metered (demo)' });
  });

  // A public / donor transparency link
  const ins = require('./services/insights');
  const tok = ins.newToken();
  db.run('INSERT INTO share_links(token_hash, title, months, created_by) VALUES (?,?,?,?)', tok.hash, 'Water service performance — demo for donors', 6, U.manager);
  db.run(`INSERT INTO settings(key,value) VALUES('demo_share_token',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, tok.token);
  console.log(`Demo data created: ${customers.length} customers, alerts raised:`, run.created);
});
db.backup('after-seed');
console.log('\nDemo users (password for all: ' + PW + '):');
for (const u of db.all('SELECT username, role FROM users ORDER BY id')) console.log('  ' + u.username.padEnd(10) + ' ' + auth.ROLE_LABELS[u.role]);
console.log('\nDemo public/donor page: http://localhost:3000/t/' + db.setting('demo_share_token'));
console.log('Public community status & reporting page: http://localhost:3000/status');
db.close();
