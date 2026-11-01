'use strict';
// Database layer: Node's built-in SQLite (no native dependencies to compile).
// Demo and live data are kept in SEPARATE database files (data/demo/ and data/live/).
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const MODE = (process.env.APP_MODE || 'demo').toLowerCase() === 'live' ? 'live' : 'demo';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), MODE);
const DB_FILE = path.join(DATA_DIR, `aquatrack-${MODE}.db`);
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

let db;

function clean(p) {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (p !== null && typeof p === 'object') return JSON.stringify(p);
  return p;
}
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const all = (sql, ...p) => stmt(sql).all(...p.map(clean));
const get = (sql, ...p) => stmt(sql).get(...p.map(clean));
const run = (sql, ...p) => {
  const r = stmt(sql).run(...p.map(clean));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
};
let txDepth = 0;
function tx(fn) {
  if (txDepth > 0) { // nested: use a savepoint so a failed inner step rolls back cleanly
    const sp = 'sp' + txDepth; db.exec(`SAVEPOINT ${sp}`); txDepth++;
    try { const r = fn(); db.exec(`RELEASE ${sp}`); return r; }
    catch (e) { try { db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch (_) {} throw e; }
    finally { txDepth--; }
  }
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  finally { txDepth--; }
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS service_areas (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, county TEXT, district TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3), description TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, full_name TEXT NOT NULL, email TEXT, phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','meter_reader','technician','cashier','customer','attendant')),
  password_hash TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id), area_id INTEGER REFERENCES service_areas(id),
  active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL, ip TEXT, user_agent TEXT);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id INTEGER PRIMARY KEY, from_currency TEXT NOT NULL, to_currency TEXT NOT NULL, rate REAL NOT NULL CHECK (rate > 0),
  effective_date TEXT NOT NULL, source_note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  customer_type TEXT, area_id INTEGER REFERENCES service_areas(id), meter_size_mm INTEGER,
  billing_mode TEXT NOT NULL DEFAULT 'any' CHECK (billing_mode IN ('any','postpaid','prepaid')),
  currency TEXT NOT NULL CHECK (length(currency) = 3), fixed_charge REAL NOT NULL DEFAULT 0,
  bands_json TEXT NOT NULL DEFAULT '[]', tax_pct REAL NOT NULL DEFAULT 0, fees_json TEXT NOT NULL DEFAULT '[]',
  minimum_charge REAL NOT NULL DEFAULT 0, effective_from TEXT NOT NULL, effective_to TEXT, active INTEGER NOT NULL DEFAULT 1,
  notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, customer_number TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  customer_type TEXT NOT NULL CHECK (customer_type IN ('household','business','institution','public_water_point','bulk')),
  contact_person TEXT, phone TEXT, email TEXT, address TEXT NOT NULL, landmark TEXT,
  area_id INTEGER NOT NULL REFERENCES service_areas(id), lat REAL, lng REAL, gps_source TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','suspended','disconnected','closed')),
  billing_mode TEXT NOT NULL DEFAULT 'postpaid' CHECK (billing_mode IN ('postpaid','prepaid')),
  notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS customer_events (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), event_type TEXT NOT NULL,
  description TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS meter_models (
  id INTEGER PRIMARY KEY, manufacturer TEXT NOT NULL, model TEXT NOT NULL, meter_type TEXT NOT NULL,
  sizes_mm TEXT, supported_methods TEXT NOT NULL DEFAULT '["manual","csv"]', pulse_liters REAL,
  notes TEXT, is_placeholder INTEGER NOT NULL DEFAULT 0, UNIQUE(manufacturer, model));

CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, method TEXT NOT NULL, adapter TEXT NOT NULL,
  vendor TEXT, meter_model TEXT, comm_band TEXT, protocol TEXT, data_format TEXT, encryption TEXT, docs_url TEXT,
  vendor_access TEXT, network_server TEXT, field_mapping TEXT, api_key_hash TEXT, api_key_hint TEXT,
  status TEXT NOT NULL DEFAULT 'info_required'
    CHECK (status IN ('info_required','ready_for_implementation','configured_unverified','verified','disabled','simulator')),
  is_simulator INTEGER NOT NULL DEFAULT 0, last_message_at TEXT, last_error TEXT, messages_ok INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, verified_by INTEGER, verification_note TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS integration_messages (
  id INTEGER PRIMARY KEY, integration_id INTEGER NOT NULL REFERENCES integrations(id), received_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT, ok INTEGER NOT NULL, result TEXT);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('source','treatment','pump','reservoir','pipe','district_meter','water_point','other')),
  area_id INTEGER REFERENCES service_areas(id), lat REAL, lng REAL,
  status TEXT NOT NULL DEFAULT 'operational' CHECK (status IN ('operational','degraded','down','maintenance','planned','decommissioned')),
  capacity REAL, capacity_unit TEXT, current_level REAL, level_unit TEXT, level_source TEXT CHECK (level_source IN ('manual','sensor','simulator') OR level_source IS NULL),
  level_updated_at TEXT, install_year INTEGER, description TEXT, maintenance_needs TEXT, next_inspection_due TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS meters (
  id INTEGER PRIMARY KEY, serial_number TEXT UNIQUE NOT NULL, manufacturer TEXT NOT NULL, model TEXT NOT NULL,
  model_id INTEGER REFERENCES meter_models(id),
  meter_type TEXT NOT NULL CHECK (meter_type IN ('mechanical','ultrasonic','electromagnetic','prepaid','bulk')),
  size_mm INTEGER NOT NULL, install_date TEXT, initial_reading REAL NOT NULL DEFAULT 0,
  lat REAL, lng REAL, location_desc TEXT, customer_id INTEGER REFERENCES customers(id), area_id INTEGER REFERENCES service_areas(id),
  asset_id INTEGER REFERENCES assets(id), is_bulk INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','active','faulty','removed','replaced')),
  comm_method TEXT NOT NULL DEFAULT 'manual'
    CHECK (comm_method IN ('manual','csv','pulse','lorawan','nbiot','cellular','wmbus','serial','vendor_api','simulator')),
  integration_id INTEGER REFERENCES integrations(id), device_id TEXT, pulse_liters REAL, battery_pct REAL,
  last_reading_value REAL, last_reading_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_device ON meters(integration_id, device_id) WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meter_assignments (
  id INTEGER PRIMARY KEY, meter_id INTEGER NOT NULL REFERENCES meters(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
  assigned_at TEXT NOT NULL, removed_at TEXT, start_reading REAL, end_reading REAL, reason TEXT, user_id INTEGER);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY, filename TEXT, uploaded_by INTEGER, row_count INTEGER, accepted INTEGER, rejected INTEGER,
  errors_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY, meter_id INTEGER NOT NULL REFERENCES meters(id), customer_id INTEGER REFERENCES customers(id),
  value REAL NOT NULL, reading_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','csv_import','pulse','lorawan','nbiot','cellular','wmbus','serial','vendor_api','simulator','estimate','customer_self')),
  reader_user_id INTEGER REFERENCES users(id), device_id TEXT, integration_id INTEGER REFERENCES integrations(id),
  is_estimated INTEGER NOT NULL DEFAULT 0, is_simulated INTEGER NOT NULL DEFAULT 0,
  photo_path TEXT, lat REAL, lng REAL, gps_accuracy REAL, notes TEXT,
  client_uuid TEXT UNIQUE, sync_status TEXT NOT NULL DEFAULT 'online' CHECK (sync_status IN ('online','offline_synced','device','import')),
  captured_at TEXT, received_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  flags_json TEXT NOT NULL DEFAULT '[]', previous_value REAL, consumption REAL,
  corrected_value REAL, correction_reason TEXT, corrected_by INTEGER, corrected_at TEXT,
  approved_by INTEGER, approved_at TEXT, review_note TEXT, billed_bill_id INTEGER,
  events_json TEXT, battery_pct REAL, raw_payload TEXT, import_batch_id INTEGER REFERENCES import_batches(id));
CREATE INDEX IF NOT EXISTS ix_readings_meter ON readings(meter_id, reading_at);
CREATE INDEX IF NOT EXISTS ix_readings_status ON readings(status);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY, bill_number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  currency TEXT NOT NULL, tariff_id INTEGER REFERENCES tariffs(id), billing_mode TEXT NOT NULL DEFAULT 'postpaid',
  meter_id INTEGER, opening_reading_id INTEGER, closing_reading_id INTEGER, opening_value REAL, closing_value REAL,
  consumption REAL NOT NULL, is_estimated INTEGER NOT NULL DEFAULT 0, is_simulated INTEGER NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL, tax REAL NOT NULL, total REAL NOT NULL, previous_balance REAL NOT NULL DEFAULT 0,
  amount_due REAL NOT NULL, paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','partially_paid','paid','overdue','cancelled')),
  cancel_reason TEXT, notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_bills_customer ON bills(customer_id);

CREATE TABLE IF NOT EXISTS bill_lines (
  id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id), line_type TEXT NOT NULL,
  description TEXT NOT NULL, quantity REAL, unit_price REAL, amount REAL NOT NULL);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, receipt_number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  bill_id INTEGER REFERENCES bills(id), amount REAL NOT NULL, currency TEXT NOT NULL,
  tendered_amount REAL, tendered_currency TEXT, exchange_rate_used REAL,
  method TEXT NOT NULL CHECK (method IN ('cash','bank_transfer','cheque','other') OR method GLOB 'mobile_money_[a-z]*'),
  purpose TEXT NOT NULL DEFAULT 'bill_payment' CHECK (purpose IN ('bill_payment','prepaid_credit','deposit','reversal')),
  reference TEXT, received_at TEXT NOT NULL, received_by INTEGER REFERENCES users(id), notes TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed','reversal')),
  reversal_of INTEGER REFERENCES payments(id), reversal_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_payments_customer ON payments(customer_id);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id), bill_id INTEGER NOT NULL REFERENCES bills(id), amount REAL NOT NULL);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), bill_id INTEGER REFERENCES bills(id),
  amount REAL NOT NULL, currency TEXT NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_by INTEGER, approved_by INTEGER, decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY, type TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')), params_json TEXT NOT NULL DEFAULT '{}');

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, rule_type TEXT NOT NULL, severity TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  customer_id INTEGER REFERENCES customers(id), meter_id INTEGER REFERENCES meters(id), asset_id INTEGER REFERENCES assets(id),
  area_id INTEGER REFERENCES service_areas(id), lat REAL, lng REAL, detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','work_order','resolved','dismissed')),
  assigned_to INTEGER REFERENCES users(id), source TEXT NOT NULL DEFAULT 'rule', data_basis TEXT, dedupe_key TEXT,
  resolved_at TEXT, resolution_note TEXT, created_by INTEGER);
CREATE INDEX IF NOT EXISTS ix_alerts_dedupe ON alerts(dedupe_key);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY, wo_number TEXT UNIQUE NOT NULL, alert_id INTEGER REFERENCES alerts(id),
  type TEXT NOT NULL CHECK (type IN ('leak','meter','network','connection','inspection','other')),
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','critical')), title TEXT NOT NULL, description TEXT,
  customer_id INTEGER REFERENCES customers(id), meter_id INTEGER REFERENCES meters(id), asset_id INTEGER REFERENCES assets(id),
  area_id INTEGER REFERENCES service_areas(id), lat REAL, lng REAL, assigned_to INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','on_hold','completed','cancelled')),
  due_date TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, resolution TEXT);

CREATE TABLE IF NOT EXISTS work_order_updates (
  id INTEGER PRIMARY KEY, work_order_id INTEGER NOT NULL REFERENCES work_orders(id), user_id INTEGER, status TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS asset_inspections (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), inspected_at TEXT NOT NULL, inspector_id INTEGER,
  condition TEXT NOT NULL CHECK (condition IN ('good','fair','poor','critical')), findings TEXT, actions TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), metric TEXT NOT NULL, value REAL NOT NULL, unit TEXT,
  recorded_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('manual','sensor','simulator')), device_id TEXT, entered_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_telemetry_asset ON telemetry(asset_id, recorded_at);

CREATE TABLE IF NOT EXISTS bulk_supply (
  id INTEGER PRIMARY KEY, area_id INTEGER NOT NULL REFERENCES service_areas(id), asset_id INTEGER REFERENCES assets(id),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, volume_m3 REAL NOT NULL CHECK (volume_m3 >= 0),
  source TEXT NOT NULL CHECK (source IN ('district_meter_manual','sensor','manual_estimate','simulator')), notes TEXT, entered_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS service_notices (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, area_id INTEGER REFERENCES service_areas(id),
  notice_type TEXT NOT NULL DEFAULT 'general' CHECK (notice_type IN ('outage','maintenance','tariff','billing','general','quality')),
  starts_at TEXT, ends_at TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, username TEXT, role TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, details TEXT, ip TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);


-- ---- Feature-phone channels & mobile money ----
CREATE TABLE IF NOT EXISTS sms_messages (
  id INTEGER PRIMARY KEY, direction TEXT NOT NULL CHECK (direction IN ('in','out')), channel TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','ussd')),
  phone TEXT NOT NULL, body TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id), wallet_id INTEGER, purpose TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','received','simulated')),
  provider TEXT NOT NULL DEFAULT 'simulator', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_sms_phone ON sms_messages(phone);
CREATE TABLE IF NOT EXISTS ussd_sessions (session_id TEXT PRIMARY KEY, phone TEXT NOT NULL, last_text TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS momo_transactions (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL CHECK (provider GLOB '[a-z]*'), txn_ref TEXT NOT NULL, msisdn TEXT, amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3), account_ref TEXT, received_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('webhook','statement_csv','simulator')),
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('matched','unmatched','ignored')), match_method TEXT, payment_id INTEGER REFERENCES payments(id),
  wp_transaction_id INTEGER, customer_id INTEGER REFERENCES customers(id), wallet_id INTEGER, is_simulated INTEGER NOT NULL DEFAULT 0, note TEXT, raw TEXT,
  matched_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(provider, txn_ref));

-- ---- Pay-as-you-fetch water points ----
CREATE TABLE IF NOT EXISTS wp_config (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id), mode TEXT NOT NULL DEFAULT 'pay_per_container' CHECK (mode IN ('pay_per_container','free')),
  currency TEXT NOT NULL CHECK (length(currency) = 3), container_liters REAL NOT NULL DEFAULT 20 CHECK (container_liters > 0), price_per_container REAL NOT NULL DEFAULT 0 CHECK (price_per_container >= 0),
  attendant_user_id INTEGER REFERENCES users(id), committee TEXT, meter_id INTEGER REFERENCES meters(id), opening_hours TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS wp_wallets (
  id INTEGER PRIMARY KEY, card_number TEXT UNIQUE NOT NULL, holder_name TEXT NOT NULL, phone TEXT, area_id INTEGER REFERENCES service_areas(id),
  currency TEXT NOT NULL CHECK (length(currency) = 3), balance REAL NOT NULL DEFAULT 0, household_size INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','closed')),
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS wp_transactions (
  id INTEGER PRIMARY KEY, asset_id INTEGER REFERENCES assets(id), wallet_id INTEGER REFERENCES wp_wallets(id),
  type TEXT NOT NULL CHECK (type IN ('sale','topup','refund','reversal')), containers INTEGER NOT NULL DEFAULT 0, liters REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('cash','wallet','mobile_money','free')), momo_id INTEGER,
  attendant_user_id INTEGER REFERENCES users(id), client_uuid TEXT UNIQUE, captured_at TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')),
  offline INTEGER NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '[]', is_simulated INTEGER NOT NULL DEFAULT 0, reversal_of INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS ix_wpt_asset ON wp_transactions(asset_id, captured_at);
CREATE TABLE IF NOT EXISTS wp_handovers (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), period_from TEXT NOT NULL, period_to TEXT NOT NULL, expected_cash REAL NOT NULL, amount REAL NOT NULL,
  currency TEXT NOT NULL, attendant_user_id INTEGER, received_by INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- ---- Public / donor transparency links ----
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, title TEXT NOT NULL, area_ids TEXT, months INTEGER NOT NULL DEFAULT 6, active INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT);

CREATE TRIGGER IF NOT EXISTS trg_wpt_no_delete BEFORE DELETE ON wp_transactions BEGIN SELECT RAISE(ABORT, 'Water point transactions cannot be deleted; post a reversal'); END;
CREATE TRIGGER IF NOT EXISTS trg_wpt_locked BEFORE UPDATE OF amount, containers, wallet_id, asset_id, captured_at, type ON wp_transactions BEGIN SELECT RAISE(ABORT, 'Water point transactions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_momo_no_delete BEFORE DELETE ON momo_transactions BEGIN SELECT RAISE(ABORT, 'Mobile money records cannot be deleted'); END;


-- ---- Community reporting (no account needed) ----
CREATE TABLE IF NOT EXISTS public_reports (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('leak','burst','no_water','quality','kiosk','other')),
  area_id INTEGER REFERENCES service_areas(id), asset_id INTEGER REFERENCES assets(id), location_text TEXT, lat REAL, lng REAL, phone TEXT, photo_path TEXT, description TEXT,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','ussd','sms')), alert_id INTEGER REFERENCES alerts(id), ip_hash TEXT,
  resolved_notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- ---- Water quality ----
CREATE TABLE IF NOT EXISTS wq_parameters (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT, fail_below REAL, warn_below REAL, warn_above REAL, fail_above REAL, guidance TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS wq_tests (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), parameter TEXT NOT NULL REFERENCES wq_parameters(code), value REAL NOT NULL, sampled_at TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'field_kit' CHECK (method IN ('field_kit','lab','sensor','simulator')), result TEXT NOT NULL CHECK (result IN ('pass','warn','fail')),
  tested_by INTEGER REFERENCES users(id), notes TEXT, alert_id INTEGER, client_uuid TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_wq_asset ON wq_tests(asset_id, sampled_at);

-- ---- Humane collections ----
CREATE TABLE IF NOT EXISTS payment_plans (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), arrears REAL NOT NULL, currency TEXT NOT NULL, down_payment REAL NOT NULL DEFAULT 0,
  instalments INTEGER NOT NULL CHECK (instalments BETWEEN 1 AND 36), frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly')), start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','defaulted','cancelled')), notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT);
CREATE TABLE IF NOT EXISTS plan_instalments (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES payment_plans(id), seq INTEGER NOT NULL, due_date TEXT NOT NULL, amount REAL NOT NULL);
CREATE TABLE IF NOT EXISTS reminders_sent (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, customer_id INTEGER, sms_id INTEGER, sent_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(kind, ref));


-- ---- New connections & connection financing ----
CREATE TABLE IF NOT EXISTS connection_requests (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, applicant_name TEXT NOT NULL, phone TEXT, area_id INTEGER REFERENCES service_areas(id), address TEXT NOT NULL, landmark TEXT,
  lat REAL, lng REAL, customer_type TEXT NOT NULL DEFAULT 'household', household_size INTEGER, photo_path TEXT, channel TEXT NOT NULL DEFAULT 'web',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','survey_scheduled','surveyed','quoted','accepted','installing','connected','rejected','cancelled')),
  survey_wo_id INTEGER, install_wo_id INTEGER, distance_m REAL, survey_notes TEXT, quote_json TEXT, quote_total REAL, currency TEXT, deposit REAL, instalments INTEGER, instalment_amount REAL,
  customer_id INTEGER REFERENCES customers(id), meter_id INTEGER REFERENCES meters(id), reject_reason TEXT, ip_hash TEXT, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
CREATE TABLE IF NOT EXISTS connection_request_events (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES connection_requests(id), status TEXT, note TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS financed_charges (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), request_id INTEGER REFERENCES connection_requests(id), description TEXT NOT NULL, seq INTEGER NOT NULL, of_total INTEGER NOT NULL,
  amount REAL NOT NULL, currency TEXT NOT NULL, due_month TEXT NOT NULL, bill_id INTEGER REFERENCES bills(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- ---- Shared compound connections ----
CREATE TABLE IF NOT EXISTS shared_groups (id INTEGER PRIMARY KEY, customer_id INTEGER UNIQUE NOT NULL REFERENCES customers(id), split_method TEXT NOT NULL CHECK (split_method IN ('equal','household_size','fixed_pct')),
  active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS shared_members (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES shared_groups(id), seq INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, household_size INTEGER, share_pct REAL,
  active INTEGER NOT NULL DEFAULT 1, UNIQUE(group_id, seq));
CREATE TABLE IF NOT EXISTS bill_shares (id INTEGER PRIMARY KEY, bill_id INTEGER NOT NULL REFERENCES bills(id), member_id INTEGER NOT NULL REFERENCES shared_members(id), amount REAL NOT NULL, paid REAL NOT NULL DEFAULT 0, UNIQUE(bill_id, member_id));

-- ---- Cost recovery & performance indicators ----
CREATE TABLE IF NOT EXISTS om_costs (id INTEGER PRIMARY KEY, area_id INTEGER REFERENCES service_areas(id), period TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('energy_fuel','electricity','chemicals','staff','repairs','transport','admin','other')),
  amount REAL NOT NULL CHECK (amount >= 0), currency TEXT NOT NULL CHECK (length(currency) = 3), notes TEXT, entered_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS kpi_inputs (area_id INTEGER NOT NULL REFERENCES service_areas(id), period TEXT NOT NULL, staff_count REAL, supply_hours_per_day REAL, PRIMARY KEY (area_id, period));
CREATE TABLE IF NOT EXISTS kpi_targets (code TEXT PRIMARY KEY, target REAL NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('min','max')));

-- ---- Two-factor recovery codes ----
-- ---- Supply timetables (intermittent / rationed supply) ----
CREATE TABLE IF NOT EXISTS supply_schedules (
  id INTEGER PRIMARY KEY, area_id INTEGER NOT NULL REFERENCES service_areas(id), zone TEXT, days TEXT NOT NULL DEFAULT '0123456', start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS supply_log (
  id INTEGER PRIMARY KEY, schedule_id INTEGER REFERENCES supply_schedules(id), area_id INTEGER NOT NULL REFERENCES service_areas(id), zone TEXT, supply_date TEXT NOT NULL,
  planned_hours REAL NOT NULL DEFAULT 0, delivered_hours REAL NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('delivered','partial','missed','extra')), reason TEXT,
  entered_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(schedule_id, supply_date));
CREATE TABLE IF NOT EXISTS supply_notices_sent (schedule_id INTEGER NOT NULL, supply_date TEXT NOT NULL, recipients INTEGER, sent_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (schedule_id, supply_date));

-- ---- Stores & stock ----
CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('pipe','fitting','meter_part','chemical','tool','other')),
  unit TEXT NOT NULL, reorder_level REAL NOT NULL DEFAULT 0, unit_cost REAL, currency TEXT, location TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES stock_items(id), qty REAL NOT NULL CHECK (qty != 0), kind TEXT NOT NULL CHECK (kind IN ('receive','issue','return','use','adjust')),
  work_order_id INTEGER REFERENCES work_orders(id), unit_cost REAL, reference TEXT, notes TEXT, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS ix_stock_mv_item ON stock_movements(item_id);
CREATE TRIGGER IF NOT EXISTS trg_stock_mv_no_delete BEFORE DELETE ON stock_movements BEGIN SELECT RAISE(ABORT, 'Stock movements cannot be deleted; post a correcting movement'); END;
CREATE TRIGGER IF NOT EXISTS trg_stock_mv_locked BEFORE UPDATE ON stock_movements BEGIN SELECT RAISE(ABORT, 'Stock movements are immutable'); END;

-- ---- Customer feedback after repairs / resolved reports ----
CREATE TABLE IF NOT EXISTS feedback_requests (
  id INTEGER PRIMARY KEY, work_order_id INTEGER REFERENCES work_orders(id), public_report_id INTEGER, alert_id INTEGER, customer_id INTEGER REFERENCES customers(id), phone TEXT NOT NULL,
  area_id INTEGER, technician_id INTEGER, sent_at TEXT NOT NULL DEFAULT (datetime('now')), score INTEGER CHECK (score BETWEEN 1 AND 5), comment TEXT, responded_at TEXT);
CREATE INDEX IF NOT EXISTS ix_feedback_phone ON feedback_requests(phone);

-- ---- Languages & translations ----
CREATE TABLE IF NOT EXISTS languages (code TEXT PRIMARY KEY, name TEXT NOT NULL, native_name TEXT NOT NULL, dir TEXT NOT NULL DEFAULT 'ltr' CHECK (dir IN ('ltr','rtl')), enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS translations (lang TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('ui','msg')), key TEXT NOT NULL, text TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (lang, scope, key));
CREATE TABLE IF NOT EXISTS phone_languages (phone_key TEXT PRIMARY KEY, lang TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));

-- ---- Preventive maintenance, run-hours and asset functionality ----
CREATE TABLE IF NOT EXISTS maint_plans (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), title TEXT NOT NULL, tasks TEXT, interval_days INTEGER CHECK (interval_days IS NULL OR interval_days > 0),
  interval_hours REAL CHECK (interval_hours IS NULL OR interval_hours > 0), lead_days INTEGER NOT NULL DEFAULT 7, priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  last_done_at TEXT, last_done_hours REAL, active INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (interval_days IS NOT NULL OR interval_hours IS NOT NULL));
CREATE TABLE IF NOT EXISTS run_hours (id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), reading REAL NOT NULL CHECK (reading >= 0), recorded_at TEXT NOT NULL, user_id INTEGER, note TEXT, reset INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_run_hours ON run_hours(asset_id, recorded_at);
CREATE TABLE IF NOT EXISTS asset_status_log (id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), status TEXT NOT NULL, changed_at TEXT NOT NULL, user_id INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS ix_asset_status_log ON asset_status_log(asset_id, changed_at);

-- ---- Cashier end-of-day close ----
CREATE TABLE IF NOT EXISTS cash_closes (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), close_date TEXT NOT NULL, currency TEXT NOT NULL, expected REAL NOT NULL, counted REAL NOT NULL, variance REAL NOT NULL,
  receipts INTEGER NOT NULL DEFAULT 0, note TEXT, status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')), reviewed_by INTEGER, reviewed_at TEXT, review_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, close_date, currency));

CREATE TABLE IF NOT EXISTS recovery_codes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL, used_at TEXT);

-- ---- Tamper protection (defence in depth beyond the API layer) ----
CREATE TRIGGER IF NOT EXISTS trg_readings_no_delete BEFORE DELETE ON readings
  BEGIN SELECT RAISE(ABORT, 'Readings cannot be deleted; reject or correct them instead'); END;
CREATE TRIGGER IF NOT EXISTS trg_readings_original_locked BEFORE UPDATE OF value, reading_at, meter_id, source, reader_user_id, integration_id, is_simulated ON readings
  BEGIN SELECT RAISE(ABORT, 'Original reading values are immutable; record a correction instead'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_no_delete BEFORE DELETE ON payments
  BEGIN SELECT RAISE(ABORT, 'Payments cannot be deleted; post a reversal instead'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_locked BEFORE UPDATE OF amount, currency, customer_id, received_at, method, receipt_number ON payments
  BEGIN SELECT RAISE(ABORT, 'Posted payments are immutable; post a reversal instead'); END;
CREATE TRIGGER IF NOT EXISTS trg_alloc_no_change BEFORE UPDATE ON payment_allocations
  BEGIN SELECT RAISE(ABORT, 'Payment allocations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'Audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'Audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_bill_lines_locked BEFORE UPDATE ON bill_lines
  BEGIN SELECT RAISE(ABORT, 'Bill lines are immutable; cancel and re-issue or adjust'); END;
`;

const DEFAULT_SETTINGS = {
  org_name: 'Community Water Utility',
  default_due_days: '21',
  high_consumption_factor: '2.5',
  long_gap_days: '45',
  max_daily_m3_household: '3',
  gps_capture_enabled: '1',
  photo_required: '0',
  adjustment_approval_required: '1',
  session_hours: '12',
  backup_retention: '14',
  report_conversion_currency: 'USD',
  sms_notifications: '1', momo_mtn_merchant: '', momo_orange_merchant: '', ussd_code: '*000#',
  unbilled_authorized_pct: '1', meter_under_registration_pct: '3', unauthorized_consumption_pct: '1', ocr_mismatch_tolerance: '0.5',
  reminder_days_before_due: '3', reminder_days_overdue: '7', plan_default_after_days: '30', auto_reminders: '1', wq_sampling_days: '7',
  affordability_threshold_pct: '5', median_household_income_LRD: '', median_household_income_USD: '', avg_household_size: '5', lifeline_lpcd: '20',
  briefing_sms_phone: '', public_status_enabled: '1',
  connection_base_fee: '', connection_pipe_cost_per_m: '', connection_meter_cost: '', connection_max_instalments: '12', require_2fa_roles: '',
  supply_sms_enabled: '1', supply_notice_hours: '2', feedback_sms_enabled: '1', meter_replacement_labour_usd: '15',
  country_code: 'LR', country_name: 'Liberia', phone_prefix: '+231', phone_digits: '9', timezone: 'Africa/Monrovia', default_language: 'en',
  currencies: 'USD,LRD', currency_symbols: 'USD=US$;LRD=L$', momo_providers: 'mtn=MTN MoMo;orange=Orange Money', region_label: 'County',
  jmp_min_hours: '12', jmp_quality_days: '92', maint_auto_wo: '1',
  meter_wear_pct_per_year: '0.75', meter_wear_start_years: '3', meter_life_years: '10', meter_life_volume_m3: '3000', meter_max_under_registration_pct: '20'
};

// ---- Migrations for databases created by an earlier version ----
function tableSql(name) { const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name); return r ? r.sql : null; }
function rebuildIfMissing(table, marker) {
  const cur = tableSql(table);
  if (!cur || cur.includes(marker)) return;
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`).exec(SCHEMA);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  db.exec('PRAGMA foreign_keys = OFF; BEGIN');
  try {
    db.exec(`CREATE TABLE ${table}__new (${m[1]})`);
    const newCols = db.prepare(`PRAGMA table_info(${table}__new)`).all().map(c => c.name).filter(c => cols.includes(c)).join(', ');
    db.exec(`INSERT INTO ${table}__new (${newCols}) SELECT ${newCols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}__new RENAME TO ${table}; COMMIT`);
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  console.log(`  Migrated table ${table}`);
}
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

function open() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  if (tableSql('users')) { for (const t of ['service_areas', 'tariffs', 'momo_transactions', 'wp_config', 'wp_wallets', 'om_costs']) rebuildIfMissing(t, 'length(currency) = 3'); rebuildIfMissing('payments', "GLOB 'mobile_money_"); rebuildIfMissing('momo_transactions', "provider GLOB");
    rebuildIfMissing('users', "'attendant'"); rebuildIfMissing('readings', "'customer_self'"); rebuildIfMissing('service_notices', "'quality'"); }
  db.exec(SCHEMA); // (re)creates new tables, indexes and triggers
  addColumn('readings', 'ocr_value', 'REAL'); addColumn('readings', 'ocr_confidence', 'REAL');
  addColumn('payments', 'is_simulated', 'INTEGER NOT NULL DEFAULT 0'); addColumn('payments', 'momo_id', 'INTEGER');
  addColumn('customers', 'essential_service', 'INTEGER NOT NULL DEFAULT 0'); addColumn('customers', 'household_size', 'INTEGER');
  addColumn('customers', 'legacy_ref', 'TEXT'); db.exec('CREATE INDEX IF NOT EXISTS ix_customers_legacy ON customers(legacy_ref)');
  addColumn('customers', 'supply_zone', 'TEXT'); addColumn('customers', 'supply_sms', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('work_orders', 'maint_plan_id', 'INTEGER'); addColumn('assets', 'served_population', 'INTEGER'); addColumn('assets', 'round_trip_min', 'INTEGER'); addColumn('service_areas', 'population', 'INTEGER');
  addColumn('customers', 'language', 'TEXT'); addColumn('users', 'language', 'TEXT');
  addColumn('users', 'totp_secret', 'TEXT'); addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  ins.run('app_mode', MODE);
  return db;
}
function close() { if (db) { db.close(); db = null; cache.clear(); } }

function setting(key, fallback) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
function settingNum(key, fallback) { const v = Number(setting(key, fallback)); return Number.isFinite(v) ? v : fallback; }

function backup(label = 'manual') {
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(DATA_DIR, 'backups', `aquatrack-${MODE}-${ts}-${label}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const keep = settingNum('backup_retention', 14);
  const files = fs.readdirSync(path.join(DATA_DIR, 'backups')).filter(f => f.endsWith('.db')).sort();
  while (files.length > keep) fs.unlinkSync(path.join(DATA_DIR, 'backups', files.shift()));
  return path.basename(file);
}

module.exports = { open, close, all, get, run, tx, setting, settingNum, backup, MODE, DATA_DIR, DB_FILE, raw: () => db };
