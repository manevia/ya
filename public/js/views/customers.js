import { api, html, raw, mount, $, state, qs, can, money, fmtM3, fmtDate, fmtDT, label, badge, table, modal, formFields, toast, bind, flagBadges, simBadge, estBadge, osmLink, pointMap, today, fmtNum, phoneHint, cfg } from '../core.js';
import { ensureLookups } from './dashboard.js';

const TYPES = ['household', 'business', 'institution', 'public_water_point', 'bulk'];
const custFields = (L, zones = []) => [
  { name: 'name', label: 'Customer / account name', required: true, full: true },
  { name: 'customer_type', label: 'Customer type', type: 'select', options: TYPES, required: true },
  { name: 'area_id', label: 'Service area', type: 'select', options: L.areas.filter(a => a.active).map(a => [a.id, `${a.name} (${a.currency})`]), required: true },
  { name: 'contact_person', label: 'Contact person' }, { name: 'phone', label: 'Phone', type: 'tel', placeholder: phoneHint() },
  { name: 'email', label: 'Email', type: 'email' }, { name: 'status', label: 'Service status', type: 'select', options: ['pending', 'active', 'suspended', 'disconnected', 'closed'], blank: false, default: 'active' },
  { name: 'address', label: 'Service address', required: true, full: true }, { name: 'landmark', label: 'Landmark / directions', full: true },
  { name: 'lat', label: 'GPS latitude', type: 'number', step: 'any', help: 'Optional. Use "Use my location" when on site.' }, { name: 'lng', label: 'GPS longitude', type: 'number', step: 'any' },
  { name: 'billing_mode', label: 'Billing mode', type: 'select', options: [['postpaid', 'Postpaid'], ['prepaid', 'Prepaid (future-ready)']], blank: false, default: 'postpaid' },
  { name: 'gps_source', label: 'GPS source', type: 'select', options: [['device_gps', 'Device GPS'], ['map', 'Picked on map'], ['survey', 'Survey'], ['unknown', 'Unknown']] },
  { name: 'household_size', label: 'People in household (for affordability)', type: 'number' },
  { name: 'essential_service', label: 'Essential service — never put forward for disconnection (clinics, schools and water points are always treated as essential)', type: 'checkbox', full: true },
  ...(zones.length ? [{ name: 'supply_zone', label: 'Supply zone (rationing timetable)', type: 'select', blank: 'Whole area / not zoned', options: zones.map(z => [z.zone, `${z.zone} — ${(L.areas.find(a => a.id === z.area_id) || {}).name || ''}`]) }] : []),
  ...((cfg().languages || []).length > 1 ? [{ name: 'language', label: 'Language for SMS and USSD', type: 'select', blank: 'Utility default', options: cfg().languages.map(l => [l.code, l.native_name]) }] : []),
  { name: 'supply_sms', label: 'SMS before water comes on', type: 'checkbox', default: true },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true }
];
function gpsButton(d) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = '📍 Use my location';
  b.onclick = () => { if (!navigator.geolocation) return toast('GPS not available on this device', 'err'); navigator.geolocation.getCurrentPosition(p => { d.querySelector('[name=lat]').value = p.coords.latitude.toFixed(6); d.querySelector('[name=lng]').value = p.coords.longitude.toFixed(6); const s = d.querySelector('[name=gps_source]'); if (s) s.value = 'device_gps'; }, e => toast('GPS: ' + e.message, 'err'), { enableHighAccuracy: true, timeout: 15000 }); };
  const lat = d.querySelector('[name=lat]'); lat.closest('label').appendChild(b);
}
export async function customerForm(existing, onDone) {
  const L = await ensureLookups();
  const zones = await api('/api/supply/zones').catch(() => []);
  const m = modal(existing ? 'Edit customer' : 'New customer account', html`<div class="form">${formFields(custFields(L, zones), existing || {})}</div>`, {
    onSubmit: async v => {
      if (existing) { await api('/api/customers/' + existing.id, { method: 'PUT', body: v }); toast('Customer updated', 'ok'); onDone && onDone(existing.id); }
      else { const r = await api('/api/customers', { body: v }); toast(`Customer ${r.customer_number} created`, 'ok'); onDone && onDone(r.id); }
    }
  });
  gpsButton(m.el);
}

export async function list(root, _p, q) {
  const L = await ensureLookups();
  const rows = await api('/api/customers' + qs(q));
  mount(root, html`<div class="page-head"><div><h1>Customers & service accounts</h1><small>${rows.length} shown</small></div>
    <div class="actions">${can('customers.manage') ? html`<button class="btn primary" data-act="new">+ New customer</button>` : ''}<a class="btn" href="/api/reports/customers">Export CSV</a></div></div>
    <form class="filters" id="cf"><label>Search<input name="q" value="${q.q || ''}" placeholder="Name, number, phone, meter…"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label>
      <label>Type<select name="customer_type"><option value="">All</option>${TYPES.map(t => html`<option value="${t}"${t === q.customer_type ? raw(' selected') : ''}>${label(t)}</option>`)}</select></label>
      <label>Status<select name="status"><option value="">All</option>${['pending', 'active', 'suspended', 'disconnected', 'closed'].map(t => html`<option${t === q.status ? raw(' selected') : ''}>${t}</option>`)}</select></label>
      <button class="btn primary">Search</button></form>
    <div class="card flush">${table([
      { label: 'Number', render: r => html`<span class="mono">${r.customer_number}</span>` }, { label: 'Name', key: 'name' }, { label: 'Type', render: r => label(r.customer_type) },
      { label: 'Area', key: 'area_name' }, { label: 'Meter', render: r => (r.serial_number ? html`<span class="mono">${r.serial_number}</span>${r.comm_method === 'simulator' ? html` ${simBadge()}` : ''}` : html`<span class="badge serious">No meter</span>`) },
      { label: 'Status', render: r => badge(r.status) }, { label: 'Balance', cls: 'num', render: r => html`<span style="${raw(r.balance > 0 ? 'color:var(--crit)' : '')}">${money(r.balance, r.currency)}</span>` }
    ], rows, { href: r => '#/customers/' + r.id })}</div>`);
  $('#cf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/customers' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(root, { new: () => customerForm(null, id => { location.hash = '#/customers/' + id; }) });
}

export async function detail(root, p, q) {
  const d = await api('/api/customers/' + p.id);
  const c = d.customer; const tab = q.tab || 'overview';
  const meter = d.meters.find(m => ['active', 'faulty'].includes(m.status));
  const tabs = [['overview', 'Overview'], ['readings', `Readings (${d.readings.length})`], ['bills', `Bills (${d.bills.length})`], ['payments', `Payments (${d.payments.length})`], ['shared', 'Shared compound'], ['history', 'Account history'], ['service', `Alerts & work orders (${d.alerts.length + d.work_orders.length})`]];
  const body = {
    overview: () => html`<div class="grid g2"><div class="card"><h2>Account</h2><dl class="kv">
        <dt>Customer no.</dt><dd class="mono">${c.customer_number}</dd><dt>Type</dt><dd>${label(c.customer_type)}</dd><dt>Status</dt><dd>${badge(c.status)}</dd>
        <dt>Billing</dt><dd>${label(c.billing_mode)}${c.billing_mode === 'prepaid' ? html` <span class="badge outline">future-ready</span>` : ''}</dd><dt>Area</dt><dd>${c.area_name} (${c.currency})</dd>
        <dt>Contact</dt><dd>${c.contact_person || '—'} · ${c.phone || 'no phone'}${c.email ? ' · ' + c.email : ''}</dd><dt>Address</dt><dd>${c.address}${c.landmark ? html`<br><small>${c.landmark}</small>` : ''}</dd>
        <dt>GPS</dt><dd>${osmLink(c.lat, c.lng)}${c.gps_source ? html` <small>(${label(c.gps_source)})</small>` : ''}</dd><dt>Opened</dt><dd>${fmtDate(c.created_at)}</dd></dl></div>
      <div class="card"><h2>Balance</h2><div style="font-size:1.8rem;font-weight:650;color:${raw(d.balance > 0 ? 'var(--crit)' : 'var(--good)')}">${money(Math.abs(d.balance), c.currency)} <small>${d.balance > 0 ? 'owed' : d.balance < 0 ? 'credit' : ''}</small></div>
        <div class="actions" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem">${can('payments.create') ? html`<a class="btn primary" href="#/payments?new=${c.id}">Record payment</a>` : ''}${d.balance > 0 && can('plans.manage') ? html`<button class="btn" data-act="plan">Offer payment plan</button>` : ''}<a class="btn" href="#/statement/${c.id}">Account statement</a>${can('adjustments.create') ? html`<a class="btn" href="#/adjustments?new=${c.id}">Adjustment</a>` : ''}</div>
        <h2 style="margin-top:1.2rem">Meter</h2>${meter ? html`<dl class="kv"><dt>Serial</dt><dd><a class="mono" href="#/meters/${meter.id}">${meter.serial_number}</a> ${badge(meter.status)}</dd><dt>Model</dt><dd>${meter.manufacturer} — ${meter.model}, ${meter.size_mm} mm</dd>
          <dt>Reading method</dt><dd>${label(meter.comm_method)}${meter.comm_method === 'simulator' ? html` ${simBadge()}` : ''}</dd><dt>Last reading</dt><dd>${meter.last_reading_value != null ? fmtM3(meter.last_reading_value) + ' on ' + fmtDT(meter.last_reading_at) : '—'}</dd></dl>`
          : html`<div class="note warn">No active meter assigned.${can('meters.manage') ? html` <a href="#/meters?assign=${c.id}">Assign or register a meter</a>` : ''}</div>`}</div></div>`,
    readings: () => html`<div class="card flush">${readingTable(d.readings)}</div>`,
    bills: () => html`<div class="card flush">${table([{ label: 'Bill', render: b => html`<span class="mono">${b.bill_number}</span>` }, { label: 'Period', render: b => `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` },
      { label: 'Consumption', cls: 'num', render: b => html`${fmtM3(b.consumption)} ${b.is_estimated ? estBadge() : ''}${b.is_simulated ? simBadge() : ''}` }, { label: 'Total', cls: 'num', render: b => money(b.total, b.currency) },
      { label: 'Paid', cls: 'num', render: b => money(b.paid, b.currency) }, { label: 'Due', render: b => fmtDate(b.due_date) }, { label: 'Status', render: b => badge(b.status) }], d.bills, { href: b => '#/bills/' + b.id })}</div>`,
    payments: () => html`<div class="card flush">${table([{ label: 'Receipt', render: x => html`<span class="mono">${x.receipt_number}</span>` }, { label: 'Date', render: x => fmtDT(x.received_at) }, { label: 'Method', render: x => label(x.method) },
      { label: 'Reference', render: x => x.reference || '—' }, { label: 'Amount', cls: 'num', render: x => money(x.amount, x.currency) }, { label: 'Status', render: x => badge(x.status) }, { label: 'By', key: 'received_by_name' }], d.payments, { href: x => '#/payments/' + x.id })}</div>`,
    history: () => html`<div class="card flush">${table([{ label: 'When', render: e => fmtDT(e.created_at) }, { label: 'Event', render: e => badge(e.event_type) }, { label: 'Details', key: 'description' }, { label: 'By', render: e => e.user_name || 'system' }], d.events)}
      ${d.assignments.length ? html`<div style="padding:1rem"><h3>Meter assignment history</h3>${table([{ label: 'Meter', key: 'serial_number' }, { label: 'Assigned', render: a => fmtDate(a.assigned_at) }, { label: 'Start', cls: 'num', render: a => fmtM3(a.start_reading) }, { label: 'Removed', render: a => fmtDate(a.removed_at) }, { label: 'End', cls: 'num', render: a => fmtM3(a.end_reading) }, { label: 'Reason', key: 'reason' }], d.assignments)}</div>` : ''}</div>`,
    shared: () => html`<div id="sharedp"><div class="empty">Loading…</div></div>`,
    service: () => html`<div class="card"><h2>Alerts</h2>${table([{ label: 'Detected', render: a => fmtDT(a.detected_at) }, { label: 'Alert', key: 'title' }, { label: 'Severity', render: a => badge(a.severity) }, { label: 'Status', render: a => badge(a.status) }], d.alerts, { href: () => '#/alerts' })}
      <h2 style="margin-top:1rem">Work orders</h2>${table([{ label: 'No.', key: 'wo_number' }, { label: 'Title', key: 'title' }, { label: 'Priority', render: w => badge(w.priority) }, { label: 'Status', render: w => badge(w.status) }], d.work_orders, { href: w => '#/work-orders/' + w.id })}</div>`
  };
  mount(root, html`<div class="crumbs"><a href="#/customers">Customers</a> ›</div>
    <div class="page-head"><div><h1>${c.name}</h1><small class="mono">${c.customer_number}</small> ${badge(c.status)}</div>
      <div class="actions">${can('customers.manage') ? html`<button class="btn" data-act="edit">Edit</button>` : ''}${can('alerts.manage') ? html`<button class="btn" data-act="alert">Report problem / leak</button>` : ''}</div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/customers/${c.id}?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div>${body[tab]()}`);
  if (tab === 'shared') import('./growth.js').then(g => g.sharedPanel($('#sharedp', root), c)).catch(e => { $('#sharedp', root).textContent = e.message; });
  bind(root, {
    edit: () => customerForm(c, () => detail(root, p, q)),
    plan: async () => { const { planForm } = await import('./collections.js'); planForm(c.id, () => detail(root, p, q)); },
    alert: async () => { const { newAlert } = await import('./ops.js'); newAlert({ customer_id: c.id, area_id: c.area_id, meter_id: meter && meter.id }); }
  });
}

export function readingTable(rows, { review = false } = {}) {
  return table([
    { label: 'Date', render: r => fmtDT(r.reading_at) }, ...(r0 => r0)(rows[0] && rows[0].serial_number !== undefined ? [{ label: 'Meter', render: r => html`<span class="mono">${r.serial_number}</span>` }] : []),
    { label: 'Reading', cls: 'num', render: r => html`${r.corrected_value != null ? html`<s class="muted">${fmtNum(r.value, 1)}</s> ${fmtNum(r.corrected_value, 1)}` : fmtNum(r.value, 1)}` },
    { label: 'Use', cls: 'num', render: r => (r.consumption == null ? '—' : fmtM3(r.consumption)) },
    { label: 'Source', render: r => html`${label(r.source)}${r.is_simulated ? html` ${simBadge()}` : ''}${r.sync_status === 'offline_synced' ? html` <span class="badge info">offline</span>` : ''}` },
    { label: 'Flags', render: r => flagBadges(r.flags_json) }, { label: 'Status', render: r => badge(r.status) }, { label: 'Reader / device', render: r => r.reader_name || (r.source === 'simulator' ? 'Simulator' : r.device_id || '—') }
  ], rows);
}

// ================= Meters =================
const METHODS = ['manual', 'csv', 'pulse', 'lorawan', 'nbiot', 'cellular', 'wmbus', 'serial', 'vendor_api', 'simulator'];
async function meterForm(existing, onDone, preset = {}) {
  const L = await ensureLookups();
  const fields = [
    { name: 'serial_number', label: 'Serial number (as printed on meter)', required: true },
    { name: 'model_id', label: 'Registered model (capabilities)', type: 'select', options: L.meter_models.map(m => [m.id, `${m.manufacturer} — ${m.model}`]), help: 'Determines which reading methods are allowed.' },
    { name: 'manufacturer', label: 'Manufacturer', required: true }, { name: 'model', label: 'Model', required: true },
    { name: 'meter_type', label: 'Meter type', type: 'select', options: ['mechanical', 'ultrasonic', 'electromagnetic', 'prepaid', 'bulk'], required: true },
    { name: 'size_mm', label: 'Size (mm)', type: 'number', required: true, default: 15 },
    { name: 'comm_method', label: 'Reading / communication method', type: 'select', options: METHODS.map(m => [m, label(m) + (m === 'simulator' ? ' (DEMO)' : '')]), blank: false, default: 'manual' },
    { name: 'integration_id', label: 'Integration profile', type: 'select', options: L.integrations.map(i => [i.id, `${i.name} — ${label(i.status)}`]), help: 'Required for any method other than manual/CSV.' },
    { name: 'device_id', label: 'Device ID / DevEUI / module ID' }, { name: 'pulse_liters', label: 'Litres per pulse (pulse modules)', type: 'number', step: 'any' },
    { name: 'install_date', label: 'Installation date', type: 'date' }, { name: 'initial_reading', label: 'Initial register reading (m³)', type: 'number', step: 'any', default: 0 },
    { name: 'area_id', label: 'Service area', type: 'select', options: L.areas.map(a => [a.id, a.name]) },
    { name: 'status', label: 'Status', type: 'select', options: ['in_stock', 'active', 'faulty', 'removed', 'replaced'], blank: false, default: 'in_stock' },
    { name: 'location_desc', label: 'Location on premises', full: true }, { name: 'lat', label: 'Latitude', type: 'number', step: 'any' }, { name: 'lng', label: 'Longitude', type: 'number', step: 'any' },
    { name: 'is_bulk', label: 'Bulk / district supply meter', type: 'checkbox' }
  ];
  if (!existing) fields.splice(1, 0, { name: 'customer_id', label: 'Assign to customer (optional)', type: 'select', options: (await api('/api/customers?limit=2000')).filter(c => !c.meter_id).map(c => [c.id, `${c.customer_number} — ${c.name}`]), help: 'Only accounts without an active meter are listed.' });
  const m = modal(existing ? 'Edit meter' : 'Register meter', html`<div class="form">${formFields(fields, existing || preset)}</div><div class="note">Choose a communication method only if this exact meter model supports it. Device connections are not live until the integration has been configured and verified in Administration › Meter integrations.</div>`, {
    onSubmit: async v => {
      if (existing) await api('/api/meters/' + existing.id, { method: 'PUT', body: v }); else { const r = await api('/api/meters', { body: v }); existing = { id: r.id }; }
      toast('Meter saved', 'ok'); onDone && onDone(existing.id);
    }
  });
  const sel = m.el.querySelector('[name=model_id]');
  sel.addEventListener('change', () => { const mm = L.meter_models.find(x => String(x.id) === sel.value); if (!mm) return; m.el.querySelector('[name=manufacturer]').value = mm.manufacturer; m.el.querySelector('[name=model]').value = mm.model; m.el.querySelector('[name=meter_type]').value = mm.meter_type; if (mm.pulse_liters) m.el.querySelector('[name=pulse_liters]').value = mm.pulse_liters; toast('Supported methods: ' + JSON.parse(mm.supported_methods).join(', ')); });
}
export async function meters(root, _p, q) {
  const L = await ensureLookups();
  const rows = await api('/api/meters' + qs({ q: q.q, status: q.status, comm_method: q.comm_method, area_id: q.area_id }));
  mount(root, html`<div class="page-head"><div><h1>Meter registry</h1><small>${rows.length} meters</small></div><div class="actions">${can('meters.manage') ? html`<button class="btn primary" data-act="new">+ Register meter</button><button class="btn" data-act="model">+ Meter model</button>` : ''}<a class="btn" href="/api/reports/meters">Export CSV</a></div></div>
    <form class="filters" id="mf"><label>Search<input name="q" value="${q.q || ''}" placeholder="Serial, device ID, customer"></label>
      <label>Status<select name="status"><option value="">All</option>${['in_stock', 'active', 'faulty', 'removed', 'replaced'].map(s => html`<option value="${s}"${s === q.status ? raw(' selected') : ''}>${label(s)}</option>`)}</select></label>
      <label>Method<select name="comm_method"><option value="">All</option>${METHODS.map(s => html`<option value="${s}"${s === q.comm_method ? raw(' selected') : ''}>${label(s)}</option>`)}</select></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Filter</button></form>
    ${q.assign ? html`<div class="note">Select a meter in stock to assign, or register a new one.</div>` : ''}
    <div class="card flush">${table([{ label: 'Serial', render: m => html`<span class="mono">${m.serial_number}</span>${m.is_bulk ? html` <span class="badge info">bulk</span>` : ''}` }, { label: 'Make / model', render: m => `${m.manufacturer} — ${m.model}` },
      { label: 'Size', cls: 'num', render: m => m.size_mm + ' mm' }, { label: 'Method', render: m => html`${label(m.comm_method)}${m.comm_method === 'simulator' ? html` ${simBadge()}` : m.integration_status && m.integration_status !== 'verified' ? html` <span class="badge serious">not verified</span>` : ''}` },
      { label: 'Customer', render: m => (m.customer_number ? html`${m.customer_name}<br><small class="mono">${m.customer_number}</small>` : '—') }, { label: 'Last reading', cls: 'num', render: m => (m.last_reading_value != null ? html`${fmtM3(m.last_reading_value)}<br><small>${fmtDate(m.last_reading_at)}</small>` : '—') },
      { label: 'Status', render: m => badge(m.status) }], rows, { href: m => '#/meters/' + m.id + (q.assign ? '?assign=' + q.assign : '') })}</div>`);
  $('#mf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/meters' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(root, {
    new: () => meterForm(null, id => { location.hash = '#/meters/' + id; }, q.assign ? { customer_id: q.assign } : {}),
    model: () => modal('Register meter model & capabilities', html`<div class="form">${formFields([{ name: 'manufacturer', label: 'Manufacturer', required: true }, { name: 'model', label: 'Exact model', required: true },
      { name: 'meter_type', label: 'Type', type: 'select', options: ['mechanical', 'ultrasonic', 'electromagnetic', 'prepaid', 'bulk'], required: true }, { name: 'sizes_mm', label: 'Sizes (mm, comma separated)' },
      { name: 'supported_methods', label: 'Supported reading methods (confirmed with vendor documentation)', type: 'checks', options: METHODS.filter(x => x !== 'simulator'), full: true, default: ['manual', 'csv'] },
      { name: 'pulse_liters', label: 'Litres per pulse (if pulse output)', type: 'number', step: 'any' }, { name: 'notes', label: 'Notes / datasheet reference', type: 'textarea', full: true }])}</div>`,
      { onSubmit: async v => { await api('/api/meter-models', { body: v }); state.lookups = null; toast('Model saved', 'ok'); } })
  });
}
export async function meterDetail(root, p, q) {
  const d = await api('/api/meters/' + p.id); const m = d.meter;
  mount(root, html`<div class="crumbs"><a href="#/meters">Meters</a> ›</div>
    <div class="page-head"><div><h1 class="mono">${m.serial_number}</h1>${badge(m.status)} ${m.comm_method === 'simulator' ? simBadge() : ''}</div>
      <div class="actions">${can('meters.manage') ? html`<button class="btn" data-act="edit">Edit</button>${m.customer_id ? html`<button class="btn danger" data-act="remove">Remove / replace</button>` : html`<button class="btn primary" data-act="assign">Assign to customer</button>`}` : ''}
      ${can('meters.status') && !can('meters.manage') && ['active', 'faulty'].includes(m.status) ? html`<button class="btn" data-act="status">Mark ${m.status === 'active' ? 'faulty' : 'active'}</button>` : ''}</div></div>
    <div class="grid g2"><div class="card"><dl class="kv"><dt>Make / model</dt><dd>${m.manufacturer} — ${m.model}</dd><dt>Type / size</dt><dd>${label(m.meter_type)}, ${m.size_mm} mm</dd><dt>Installed</dt><dd>${fmtDate(m.install_date)} · initial ${fmtM3(m.initial_reading)}</dd>
      <dt>Customer</dt><dd>${m.customer_id ? html`<a href="#/customers/${m.customer_id}">${m.customer_name}</a> <small class="mono">${m.customer_number}</small>` : 'Not assigned'}</dd><dt>Location</dt><dd>${m.location_desc || ''} ${osmLink(m.lat, m.lng)}</dd></dl></div>
    <div class="card"><h2>Communication</h2><dl class="kv"><dt>Method</dt><dd>${label(m.comm_method)}</dd><dt>Integration</dt><dd>${m.integration_name ? html`${m.integration_name} ${badge(m.integration_status)}` : 'None (manual / CSV)'}</dd>
      <dt>Device ID</dt><dd class="mono">${m.device_id || '—'}</dd>${m.pulse_liters ? html`<dt>Litres/pulse</dt><dd>${m.pulse_liters}</dd>` : ''}<dt>Battery</dt><dd>${m.battery_pct != null ? m.battery_pct + '%' : '—'}</dd><dt>Last data</dt><dd>${fmtDT(m.last_reading_at)}</dd></dl>
      ${m.comm_method === 'simulator' ? html`<div class="note sim">This meter is attached to the demo simulator. Its readings are fictional and labelled SIMULATED.</div>` : m.integration_status && m.integration_status !== 'verified' ? html`<div class="note warn">The integration for this meter is not verified. Device readings are flagged for review and must not be treated as confirmed.</div>` : ''}</div></div>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Readings</h2></div>${readingTable(d.readings)}</div>`);
  bind(root, {
    edit: () => meterForm(m, () => meterDetail(root, p, q)),
    status: () => modal('Change meter status', html`<div class="form"><input type="hidden" name="status" value="${m.status === 'active' ? 'faulty' : 'active'}">${formFields([{ name: 'note', label: 'Reason / findings', type: 'textarea', required: true, full: true }])}</div>`, { onSubmit: async v => { await api(`/api/meters/${m.id}/status`, { body: v }); toast('Status updated', 'ok'); meterDetail(root, p, q); } }),
    assign: async () => { const cs = (await api('/api/customers?limit=2000')).filter(c => !c.meter_id); modal('Assign meter to customer', html`<div class="form">${formFields([{ name: 'customer_id', label: 'Customer', type: 'select', options: cs.map(c => [c.id, `${c.customer_number} — ${c.name}`]), required: true, full: true, default: q.assign },
      { name: 'start_reading', label: 'Start reading (m³)', type: 'number', step: 'any', default: m.last_reading_value ?? m.initial_reading }, { name: 'date', label: 'Date', type: 'date', default: today() }, { name: 'reason', label: 'Reason', default: 'New connection', full: true }])}</div>`,
      { onSubmit: async v => { await api(`/api/meters/${m.id}/assign`, { body: v }); toast('Meter assigned', 'ok'); meterDetail(root, p, {}); } }); },
    remove: () => modal('Remove meter from account', html`<div class="note warn">A final reading is recorded (pending review) so the last period can be billed.</div><div class="form">${formFields([{ name: 'end_reading', label: 'Final register reading (m³)', type: 'number', step: 'any', required: true },
      { name: 'new_status', label: 'New meter status', type: 'select', options: ['removed', 'replaced', 'in_stock', 'faulty'], blank: false }, { name: 'reason', label: 'Reason', required: true, full: true }])}</div>`, { danger: true, submitLabel: 'Remove meter', onSubmit: async v => { await api(`/api/meters/${m.id}/remove`, { body: v }); toast('Meter removed', 'ok'); meterDetail(root, p, q); } })
  });
}
