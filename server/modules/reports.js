'use strict';
const { route, HttpError, csvResponse } = require('../lib/http');
const db = require('../lib/db');
const csv = require('../lib/csv');
const billing = require('../services/billing');

const r2 = billing.r2;
function filters(q) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.parse(to) - 182 * 86400e3).toISOString().slice(0, 10);
  const area_id = q.area_id ? Number(q.area_id) : null;
  const customer_type = q.customer_type || null;
  const cw = []; const cp = [];
  if (area_id) { cw.push('c.area_id=?'); cp.push(area_id); }
  if (customer_type) { cw.push('c.customer_type=?'); cp.push(customer_type); }
  return { from, to, area_id, customer_type, cwhere: cw.length ? ' AND ' + cw.join(' AND ') : '', cp };
}
const END = d => d + 'T23:59:59.999Z';

function dashboard(q) {
  const f = filters(q);
  billing.refreshAllBills();
  const total = db.get(`SELECT COUNT(*) n FROM customers c WHERE 1=1 ${f.cwhere}`, ...f.cp).n;
  const active = db.get(`SELECT COUNT(*) n FROM customers c WHERE c.status='active' ${f.cwhere}`, ...f.cp).n;
  const metered = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') WHERE c.status='active' ${f.cwhere}`, ...f.cp).n;
  const cycleStart = new Date(Date.parse(f.to) - 30 * 86400e3).toISOString();
  const read = db.get(`SELECT COUNT(DISTINCT c.id) n FROM customers c JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty')
    JOIN readings r ON r.meter_id=m.id AND r.status!='rejected' AND r.reading_at >= ? AND r.reading_at <= ? WHERE c.status='active' ${f.cwhere}`, cycleStart, END(f.to), ...f.cp).n;
  const pending = db.get(`SELECT COUNT(*) n FROM readings r LEFT JOIN customers c ON c.id=r.customer_id WHERE r.status='pending' ${f.cwhere}`, ...f.cp).n;
  const flaggedPending = db.get(`SELECT COUNT(*) n FROM readings r LEFT JOIN customers c ON c.id=r.customer_id WHERE r.status='pending' AND r.flags_json != '[]' ${f.cwhere}`, ...f.cp).n;
  const billed = db.all(`SELECT b.currency, SUM(b.total) amount, SUM(b.consumption) m3, SUM(CASE WHEN b.is_estimated=1 THEN b.consumption ELSE 0 END) est_m3, COUNT(*) bills,
    SUM(b.is_estimated) est_bills, SUM(b.is_simulated) sim_bills FROM bills b JOIN customers c ON c.id=b.customer_id WHERE b.status!='cancelled' AND b.period_end BETWEEN ? AND ? ${f.cwhere} GROUP BY b.currency`, f.from, f.to, ...f.cp);
  const collected = db.all(`SELECT p.currency, SUM(p.amount) amount, COUNT(CASE WHEN p.amount>0 THEN 1 END) n FROM payments p JOIN customers c ON c.id=p.customer_id WHERE p.received_at BETWEEN ? AND ? ${f.cwhere} GROUP BY p.currency`, f.from, END(f.to), ...f.cp);
  // Outstanding & aging (by bill due date)
  const outstanding = {}; const aging = {};
  for (const c of db.all(`SELECT c.id, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE 1=1 ${f.cwhere}`, ...f.cp)) {
    const bal = billing.balance(c.id);
    if (bal > 0) outstanding[c.currency] = r2((outstanding[c.currency] || 0) + bal);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const b of db.all(`SELECT b.* FROM bills b JOIN customers c ON c.id=b.customer_id WHERE b.status IN ('issued','partially_paid','overdue') ${f.cwhere}`, ...f.cp)) {
    const out = billing.billOutstanding(b); if (out <= 0) continue;
    const days = Math.floor((Date.parse(today) - Date.parse(b.due_date)) / 86400e3);
    const bucket = days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
    aging[b.currency] = aging[b.currency] || { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    aging[b.currency][bucket] = r2(aging[b.currency][bucket] + out);
  }
  // Conversion (only if a rate is configured — never hard-coded)
  const conv = db.setting('report_conversion_currency', 'USD');
  const convert = (amt, cur) => { if (cur === conv) return { v: amt }; const r = billing.findRate(cur, conv, f.to); return r ? { v: r2(amt * r.rate), rate: r.rate, date: r.date } : null; };
  let convNote = null; const sumConv = list => { let t = 0; for (const [cur, amt] of list) { const c = convert(amt, cur); if (!c) { convNote = `No ${cur}→${conv} rate configured; combined totals unavailable`; return null; } if (c.rate) convNote = convNote || `Converted at the configured rate ${c.rate < 1 ? `1 ${conv} = ${+(1 / c.rate).toFixed(4)} ${cur}` : `1 ${cur} = ${+c.rate.toFixed(4)} ${conv}`} (effective ${c.date})`; t += c.v; } return r2(t); };
  const combined = { currency: conv, billed: sumConv(billed.map(b => [b.currency, b.amount])), collected: sumConv(collected.map(c => [c.currency, c.amount])), outstanding: sumConv(Object.entries(outstanding)), note: null };
  combined.note = convNote;
  // Bulk supply vs billed (NRW), per area
  const areas = db.all(`SELECT * FROM service_areas ${f.area_id ? 'WHERE id=?' : ''} ORDER BY name`, ...(f.area_id ? [f.area_id] : []));
  const nrw = areas.map(a => {
    const s = db.get(`SELECT SUM(volume_m3) vol, GROUP_CONCAT(DISTINCT source) sources, MIN(period_start) ps, MAX(period_end) pe FROM bulk_supply WHERE area_id=? AND period_start >= ? AND period_end <= ?`, a.id, f.from, f.to);
    const bl = db.get(`SELECT SUM(b.consumption) m3, SUM(CASE WHEN b.is_estimated=1 THEN b.consumption ELSE 0 END) est FROM bills b JOIN customers c ON c.id=b.customer_id WHERE c.area_id=? AND b.status!='cancelled'
      AND b.period_start >= ? AND b.period_end <= ? ${f.customer_type ? 'AND c.customer_type=?' : ''}`, a.id, s.ps || f.from, s.pe || f.to, ...(f.customer_type ? [f.customer_type] : []));
    const vol = s.vol || 0; const m3 = bl.m3 || 0;
    return { area_id: a.id, area: a.name, supply_m3: s.vol == null ? null : r2(vol), billed_m3: r2(m3), estimated_billed_m3: r2(bl.est || 0), supply_sources: s.sources,
      loss_m3: s.vol == null ? null : r2(vol - m3), loss_pct: s.vol ? r2((vol - m3) / vol * 100) : null, supply_period: s.ps ? `${s.ps} – ${s.pe}` : null,
      note: s.vol == null ? 'No bulk supply data recorded' : f.customer_type ? 'Customer-type filter applied to billed side only — not a valid NRW figure' : (s.sources || '').includes('estimate') ? 'Supply volume is an estimate' : (s.sources || '').includes('simulator') ? 'SIMULATED supply data' : null };
  });
  const alertsBy = db.all(`SELECT al.severity, COUNT(*) n FROM alerts al WHERE al.status IN ('open','acknowledged','work_order') ${f.area_id ? 'AND al.area_id=?' : ''} GROUP BY al.severity`, ...(f.area_id ? [f.area_id] : []));
  const woBy = db.all(`SELECT w.status, COUNT(*) n FROM work_orders w WHERE 1=1 ${f.area_id ? 'AND w.area_id=?' : ''} GROUP BY w.status`, ...(f.area_id ? [f.area_id] : []));
  const trendArea = db.all(`SELECT substr(b.period_end,1,7) month, a.name area, SUM(b.consumption) m3, SUM(CASE WHEN b.is_estimated=1 THEN b.consumption ELSE 0 END) est FROM bills b JOIN customers c ON c.id=b.customer_id JOIN service_areas a ON a.id=c.area_id
    WHERE b.status!='cancelled' AND b.period_end BETWEEN ? AND ? ${f.cwhere} GROUP BY month, a.name ORDER BY month`, f.from, f.to, ...f.cp);
  const trendType = db.all(`SELECT substr(b.period_end,1,7) month, c.customer_type type, SUM(b.consumption) m3 FROM bills b JOIN customers c ON c.id=b.customer_id
    WHERE b.status!='cancelled' AND b.period_end BETWEEN ? AND ? ${f.cwhere} GROUP BY month, c.customer_type ORDER BY month`, f.from, f.to, ...f.cp);
  const byType = db.all(`SELECT c.customer_type type, COUNT(*) n, SUM(CASE WHEN c.status='active' THEN 1 ELSE 0 END) active FROM customers c WHERE 1=1 ${f.cwhere} GROUP BY c.customer_type`, ...f.cp);
  const simReadings = db.get(`SELECT COUNT(*) n FROM readings r LEFT JOIN customers c ON c.id=r.customer_id WHERE r.is_simulated=1 AND r.reading_at BETWEEN ? AND ? ${f.cwhere}`, f.from, END(f.to), ...f.cp).n;
  const methods = db.all(`SELECT m.comm_method, COUNT(*) n FROM meters m LEFT JOIN customers c ON c.id=m.customer_id WHERE m.status IN ('active','faulty') ${f.cwhere} GROUP BY m.comm_method`, ...f.cp);
  return {
    filters: { from: f.from, to: f.to, area_id: f.area_id, customer_type: f.customer_type }, mode: db.MODE,
    customers: { total, active, metered, coverage_pct: active ? r2(metered / active * 100) : null, by_type: byType },
    readings: { cycle_from: cycleStart.slice(0, 10), cycle_to: f.to, read: read, expected: metered, completion_pct: metered ? r2(read / metered * 100) : null, pending_review: pending, flagged_pending: flaggedPending, simulated_in_period: simReadings },
    billing: { billed, collected: collected.map(c => { const b = billed.find(x => x.currency === c.currency); return { ...c, amount: r2(c.amount), efficiency_pct: b && b.amount ? r2(c.amount / b.amount * 100) : null }; }), outstanding, aging, combined },
    nrw, alerts: alertsBy, work_orders: woBy, trend_area: trendArea, trend_type: trendType, meter_methods: methods
  };
}
route('GET', '/api/dashboard', { perm: 'dashboard.view' }, ctx => dashboard(ctx.query));

// ---------------- CSV reports ----------------
const REPORTS = {
  customers: { title: 'Customer accounts', run: f => db.all(`SELECT c.customer_number, c.name, c.customer_type, c.status, c.billing_mode, a.name area, a.currency, c.address, c.phone, c.lat, c.lng, m.serial_number meter, c.id _id
    FROM customers c JOIN service_areas a ON a.id=c.area_id LEFT JOIN meters m ON m.customer_id=c.id AND m.status IN ('active','faulty') WHERE 1=1 ${f.cwhere} ORDER BY c.customer_number`, ...f.cp).map(r => { r.balance = billing.balance(r._id); delete r._id; return r; }) },
  meters: { title: 'Meter registry', run: f => db.all(`SELECT m.serial_number, m.manufacturer, m.model, m.meter_type, m.size_mm, m.status, m.comm_method, i.name integration, i.status integration_status, m.device_id, m.install_date, c.customer_number, m.last_reading_value, m.last_reading_at, m.battery_pct
    FROM meters m LEFT JOIN customers c ON c.id=m.customer_id LEFT JOIN integrations i ON i.id=m.integration_id WHERE 1=1 ${f.cwhere} ORDER BY m.serial_number`, ...f.cp) },
  readings: { title: 'Meter readings', run: f => db.all(`SELECT r.id, m.serial_number, c.customer_number, r.reading_at, r.value original_value, r.corrected_value, r.correction_reason, r.consumption, r.source, r.status, r.flags_json flags,
    CASE WHEN r.is_simulated=1 THEN 'SIMULATED' ELSE '' END simulated, CASE WHEN r.is_estimated=1 THEN 'ESTIMATED' ELSE '' END estimated, r.sync_status, u.full_name reader, r.received_at
    FROM readings r JOIN meters m ON m.id=r.meter_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.reader_user_id WHERE r.reading_at BETWEEN ? AND ? ${f.cwhere} ORDER BY r.reading_at`, f.from, END(f.to), ...f.cp) },
  bills: { title: 'Bills issued', run: f => db.all(`SELECT b.bill_number, c.customer_number, c.name, c.customer_type, a.name area, b.period_start, b.period_end, b.issue_date, b.due_date, b.consumption, CASE WHEN b.is_estimated=1 THEN 'ESTIMATED' ELSE '' END estimated,
    CASE WHEN b.is_simulated=1 THEN 'SIMULATED' ELSE '' END simulated, b.currency, b.subtotal, b.tax, b.total, b.paid, b.status FROM bills b JOIN customers c ON c.id=b.customer_id JOIN service_areas a ON a.id=c.area_id
    WHERE b.period_end BETWEEN ? AND ? ${f.cwhere} ORDER BY b.issue_date`, f.from, f.to, ...f.cp) },
  payments: { title: 'Payments & reversals', run: f => db.all(`SELECT p.receipt_number, c.customer_number, c.name, p.received_at, p.amount, p.currency, p.tendered_amount, p.tendered_currency, p.exchange_rate_used, p.method, p.reference, p.purpose, p.status, u.full_name received_by
    FROM payments p JOIN customers c ON c.id=p.customer_id LEFT JOIN users u ON u.id=p.received_by WHERE p.received_at BETWEEN ? AND ? ${f.cwhere} ORDER BY p.received_at`, f.from, END(f.to), ...f.cp) },
  outstanding: { title: 'Outstanding balances (aging by bill due date)', run: f => {
    const today = new Date().toISOString().slice(0, 10); const out = [];
    for (const c of db.all(`SELECT c.id, c.customer_number, c.name, c.customer_type, c.phone, a.name area, a.currency FROM customers c JOIN service_areas a ON a.id=c.area_id WHERE 1=1 ${f.cwhere} ORDER BY c.customer_number`, ...f.cp)) {
      const bal = billing.balance(c.id); if (bal <= 0) continue;
      const row = { customer_number: c.customer_number, name: c.name, customer_type: c.customer_type, area: c.area, phone: c.phone, currency: c.currency, balance: bal, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
      for (const b of db.all(`SELECT * FROM bills WHERE customer_id=? AND status IN ('issued','partially_paid','overdue')`, c.id)) {
        const o = billing.billOutstanding(b); const d = Math.floor((Date.parse(today) - Date.parse(b.due_date)) / 86400e3);
        row[d <= 0 ? 'current' : d <= 30 ? 'd1_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90_plus'] += o;
      }
      out.push(row);
    }
    return out;
  } },
  consumption_by_area: { title: 'Billed consumption by month, area and customer type', run: f => db.all(`SELECT substr(b.period_end,1,7) month, a.name area, c.customer_type, COUNT(*) bills, ROUND(SUM(b.consumption),3) billed_m3,
    ROUND(SUM(CASE WHEN b.is_estimated=1 THEN b.consumption ELSE 0 END),3) of_which_estimated_m3, b.currency, ROUND(SUM(b.total),2) billed_amount FROM bills b JOIN customers c ON c.id=b.customer_id JOIN service_areas a ON a.id=c.area_id
    WHERE b.status!='cancelled' AND b.period_end BETWEEN ? AND ? ${f.cwhere} GROUP BY month, a.name, c.customer_type, b.currency ORDER BY month, area`, f.from, f.to, ...f.cp) },
  nrw: { title: 'Bulk supply vs billed consumption (non-revenue water indicator)', run: f => dashboard({ from: f.from, to: f.to, area_id: f.area_id }).nrw },
  alerts: { title: 'Alerts', run: f => db.all(`SELECT al.id, al.detected_at, al.rule_type, al.severity, al.status, al.title, al.data_basis, c.customer_number, m.serial_number, s.code asset, a.name area, al.lat, al.lng, u.full_name assigned_to, al.resolved_at, al.resolution_note
    FROM alerts al LEFT JOIN customers c ON c.id=al.customer_id LEFT JOIN meters m ON m.id=al.meter_id LEFT JOIN assets s ON s.id=al.asset_id LEFT JOIN service_areas a ON a.id=al.area_id LEFT JOIN users u ON u.id=al.assigned_to
    WHERE al.detected_at BETWEEN ? AND ? ${f.area_id ? 'AND al.area_id=?' : ''} ORDER BY al.detected_at`, f.from, END(f.to), ...(f.area_id ? [f.area_id] : [])) },
  work_orders: { title: 'Work orders', run: f => db.all(`SELECT w.wo_number, w.created_at, w.type, w.priority, w.status, w.title, c.customer_number, s.code asset, a.name area, u.full_name assigned_to, w.due_date, w.completed_at, w.resolution
    FROM work_orders w LEFT JOIN customers c ON c.id=w.customer_id LEFT JOIN assets s ON s.id=w.asset_id LEFT JOIN service_areas a ON a.id=w.area_id LEFT JOIN users u ON u.id=w.assigned_to
    WHERE w.created_at BETWEEN ? AND ? ${f.area_id ? 'AND w.area_id=?' : ''} ORDER BY w.created_at`, f.from, END(f.to), ...(f.area_id ? [f.area_id] : [])) }
};
route('GET', '/api/reports', { perm: 'reports.view' }, () => Object.entries(REPORTS).map(([k, r]) => ({ key: k, title: r.title })));
route('GET', '/api/reports/:key', { perm: 'reports.view' }, ctx => {
  const rep = REPORTS[ctx.params.key]; if (!rep) throw new HttpError(404, 'Unknown report');
  const f = filters(ctx.query);
  const rows = rep.run(f);
  const pre = [`# ${rep.title}`, `# Generated ${new Date().toISOString()} — ${db.setting('org_name')}`, `# Period ${f.from} to ${f.to}${f.area_id ? ' | area ' + f.area_id : ''}${f.customer_type ? ' | type ' + f.customer_type : ''}`,
    db.MODE === 'demo' ? '# DEMO ENVIRONMENT — ALL RECORDS ARE FICTIONAL' : '# LIVE DATA', '# Estimated and simulated values are labelled in their own columns; amounts are in the stated currency (no conversion)'];
  return csvResponse(`${ctx.params.key}_${f.from}_${f.to}${db.MODE === 'demo' ? '_DEMO' : ''}.csv`, csv.stringify(rows, rows[0] ? Object.keys(rows[0]) : ['no_data'], pre));
});

module.exports = { dashboard };
