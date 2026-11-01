import { api, html, raw, mount, $, state, qs, can, fmtDT, fmtDate, fmtNum, fmtM3, label, badge, table, modal, formFields, toast, bind, osmLink, groupedMaps, simBadge, today, canAny } from '../core.js';
import { ensureLookups } from './dashboard.js';
import { newWorkOrder } from './ops.js';

const TYPES = ['source', 'treatment', 'pump', 'reservoir', 'pipe', 'district_meter', 'water_point', 'other'];
const STATUSES = ['operational', 'degraded', 'down', 'maintenance', 'planned', 'decommissioned'];
const TYPE_COLOR = { source: 'var(--s1)', treatment: 'var(--s3)', pump: 'var(--s2)', reservoir: 'var(--s7)', pipe: '#6b7885', district_meter: 'var(--s4)', water_point: 'var(--s5)', other: '#999' };
const srcBadge = s => (s === 'sensor' ? html`<span class="badge info" title="Measured by a connected sensor">Sensor</span>` : s === 'simulator' ? simBadge() : html`<span class="badge outline" title="Entered manually by staff">Manual entry</span>`);

async function assetForm(existing, done) {
  const L = await ensureLookups();
  modal(existing ? 'Edit asset' : 'Add network asset', html`<div class="form">${formFields([{ name: 'code', label: 'Asset code', required: true }, { name: 'name', label: 'Name', required: true },
    { name: 'asset_type', label: 'Type', type: 'select', options: TYPES, required: true }, { name: 'area_id', label: 'Service area', type: 'select', options: L.areas.map(a => [a.id, a.name]) },
    { name: 'status', label: 'Operational status', type: 'select', options: STATUSES, blank: false }, { name: 'install_year', label: 'Install year', type: 'number' },
    { name: 'capacity', label: 'Capacity (where known)', type: 'number', step: 'any' }, { name: 'capacity_unit', label: 'Capacity unit', placeholder: 'm³, m³/day, m³/h, mm dia' },
    { name: 'lat', label: 'Latitude', type: 'number', step: 'any' }, { name: 'lng', label: 'Longitude', type: 'number', step: 'any' }, { name: 'next_inspection_due', label: 'Next inspection due', type: 'date' }, { name: 'level_unit', label: 'Level unit', placeholder: '% or m' },
    { name: 'description', label: 'Description', type: 'textarea', full: true }, { name: 'maintenance_needs', label: 'Maintenance needs', type: 'textarea', full: true },
    { type: 'section', label: 'Water points — for service-level (SDG 6.1) estimates' }, { name: 'served_population', label: 'People using it (estimate)', type: 'number', min: 0 }, { name: 'round_trip_min', label: 'Round-trip collection time incl. queuing (minutes)', type: 'number', min: 0 }])}</div>`,
    { onSubmit: async v => { if (existing) await api('/api/assets/' + existing.id, { method: 'PUT', body: v }); else existing = { id: (await api('/api/assets', { body: v })).id }; toast('Asset saved', 'ok'); done(existing.id); } });
}

export async function list(root, _p, q) {
  const L = await ensureLookups();
  const rows = await api('/api/assets' + qs(q));
  mount(root, html`<div class="page-head"><div><h1>Water network & supply assets</h1><small>Map-ready register (GeoJSON export for GIS)</small></div>
    <div class="actions">${can('assets.manage') ? html`<button class="btn primary" data-act="new">+ Add asset</button>` : ''}${can('supply.enter') ? html`<button class="btn" data-act="supply">+ Bulk supply volume</button>` : ''}<a class="btn" href="/api/assets/geojson" download="assets.geojson">GeoJSON</a></div></div>
    <form class="filters" id="nf"><label>Type<select name="asset_type"><option value="">All</option>${TYPES.map(t => html`<option value="${t}"${t === q.asset_type ? raw(' selected') : ''}>${label(t)}</option>`)}</select></label>
      <label>Status<select name="status"><option value="">All</option>${STATUSES.map(t => html`<option value="${t}"${t === q.status ? raw(' selected') : ''}>${label(t)}</option>`)}</select></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Filter</button></form>
    <div class="card">${groupedMaps(rows.map(a => ({ group: a.area_name, lat: a.lat, lng: a.lng, label: `${a.name} — ${label(a.status)}`, color: TYPE_COLOR[a.asset_type], href: '#/network/' + a.id, r: a.asset_type === 'reservoir' || a.asset_type === 'source' ? 8 : 6 })))}
      <div class="legend">${TYPES.filter(t => rows.some(r => r.asset_type === t)).map(t => html`<span><i style="background:${raw(TYPE_COLOR[t])}"></i>${label(t)}</span>`)}</div></div>
    <div class="card flush">${table([{ label: 'Code', render: a => html`<span class="mono">${a.code}</span>` }, { label: 'Name', key: 'name' }, { label: 'Type', render: a => label(a.asset_type) }, { label: 'Area', key: 'area_name' },
      { label: 'Status', render: a => badge(a.status) }, { label: 'Capacity', cls: 'num', render: a => (a.capacity != null ? `${fmtNum(a.capacity, 0)} ${a.capacity_unit || ''}` : '—') },
      { label: 'Level', render: a => (a.current_level != null ? html`${fmtNum(a.current_level, 0)}${a.level_unit || ''} ${srcBadge(a.level_source)}<br><small>${fmtDT(a.level_updated_at)}</small>` : '—') },
      { label: 'Last inspection', render: a => fmtDate(a.last_inspection) }, { label: 'Open jobs', cls: 'num', key: 'open_work_orders' }], rows, { href: a => '#/network/' + a.id })}</div>
    <div id="supply"></div>`);
  $('#nf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/network' + qs(Object.fromEntries(new FormData(e.target))); });
  if (can('dashboard.view')) {
    const s = await api('/api/bulk-supply');
    $('#supply', root).innerHTML = html`<div class="card flush"><div style="padding:1rem 1rem 0"><h2>Bulk / district supply records</h2><small class="muted">Used to compare supply with billed consumption (non-revenue water).</small></div>
      ${table([{ label: 'Area', key: 'area_name' }, { label: 'Period', render: b => `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` }, { label: 'Volume', cls: 'num', render: b => fmtM3(b.volume_m3) },
        { label: 'Source', render: b => html`<span class="badge ${b.source === 'manual_estimate' ? 'warn' : b.source === 'simulator' ? 'sim' : b.source === 'sensor' ? 'info' : 'outline'}">${label(b.source)}</span>` }, { label: 'Asset', render: b => b.asset_name || '—' }, { label: 'Notes', key: 'notes' }, { label: 'By', key: 'entered_by_name' }], s)}</div>`.s;
  }
  bind(root, {
    new: () => assetForm(null, id => { location.hash = '#/network/' + id; }),
    supply: () => modal('Record bulk supply volume', html`<div class="note">Enter the volume supplied into an area over a period, e.g. from district/bulk meter readings. Mark estimates (pump hours × rated flow) as estimates. Sensor data arrives via integrations.</div><div class="form">${formFields([
      { name: 'area_id', label: 'Service area', type: 'select', options: L.areas.map(a => [a.id, a.name]), required: true }, { name: 'asset_id', label: 'District meter / source asset', type: 'select', options: rows.filter(a => ['district_meter', 'source', 'reservoir'].includes(a.asset_type)).map(a => [a.id, a.name]) },
      { name: 'period_start', label: 'Period start', type: 'date', required: true }, { name: 'period_end', label: 'Period end', type: 'date', required: true }, { name: 'volume_m3', label: 'Volume (m³)', type: 'number', step: 'any', required: true },
      { name: 'source', label: 'Data source', type: 'select', options: [['district_meter_manual', 'District/bulk meter — manual reading'], ['manual_estimate', 'Estimate']], required: true }, { name: 'notes', label: 'Notes', full: true }])}</div>`,
      { onSubmit: async v => { await api('/api/bulk-supply', { body: v }); toast('Supply volume recorded', 'ok'); list(root, _p, q); } })
  });
}

export async function detail(root, p) {
  const d = await api('/api/assets/' + p.id); const a = d.asset;
  mount(root, html`<div class="crumbs"><a href="#/network">Network</a> ›</div><div class="page-head"><div><h1>${a.name}</h1><span class="mono">${a.code}</span> ${badge(a.status)}</div>
    <div class="actions">${can('assets.manage') ? html`<button class="btn" data-act="edit">Edit</button>` : can('assets.inspect') ? html`<button class="btn" data-act="status">Update status</button>` : ''}
      ${can('assets.inspect') ? html`<button class="btn" data-act="inspect">+ Inspection</button>` : ''}${can('telemetry.enter') ? html`<button class="btn" data-act="tele">+ Manual reading</button>` : ''}${can('workorders.manage') ? html`<button class="btn primary" data-act="wo">Create work order</button>` : ''}</div></div>
    <div class="grid g2"><div class="card"><dl class="kv"><dt>Type</dt><dd>${label(a.asset_type)}</dd><dt>Area</dt><dd>${a.area_name || '—'}</dd><dt>Capacity</dt><dd>${a.capacity != null ? `${fmtNum(a.capacity, 0)} ${a.capacity_unit || ''}` : 'Unknown'}</dd>
      <dt>Current level</dt><dd>${a.current_level != null ? html`${fmtNum(a.current_level, 1)} ${a.level_unit || ''} ${srcBadge(a.level_source)} <small>${fmtDT(a.level_updated_at)}</small>` : 'Not recorded'}</dd>
      <dt>Location</dt><dd>${osmLink(a.lat, a.lng)}</dd><dt>Installed</dt><dd>${a.install_year || '—'}</dd><dt>Next inspection</dt><dd>${fmtDate(a.next_inspection_due)}</dd></dl>
      ${a.maintenance_needs ? html`<div class="note warn"><b>Maintenance needs:</b> ${a.maintenance_needs}</div>` : ''}${a.description ? html`<p class="muted">${a.description}</p>` : ''}
      ${a.asset_type === 'water_point' ? html`<dl class="kv"><dt>People using it</dt><dd>${a.served_population ?? html`<span class="muted">not recorded</span>`}</dd><dt>Round trip incl. queue</dt><dd>${a.round_trip_min != null ? a.round_trip_min + ' min' : html`<span class="muted">not recorded</span>`}</dd></dl>` : ''}
      <div class="note">Sensor telemetry (pressure, flow, level, pump status) can be connected later through the integration layer; it will be stored with source "Sensor" and kept separate from manual entries.</div></div>
    <div class="card"><h2>Operational readings</h2>${table([{ label: 'When', render: t => fmtDT(t.recorded_at) }, { label: 'Metric', render: t => label(t.metric) }, { label: 'Value', cls: 'num', render: t => `${fmtNum(t.value, 2)} ${t.unit || ''}` }, { label: 'Source', render: t => srcBadge(t.source) }, { label: 'By / device', render: t => t.entered_by_name || t.device_id || '—' }], d.telemetry.slice(0, 30))}</div></div>
    <div class="grid g2"><div class="card"><h2>Inspection history</h2>${table([{ label: 'Date', render: i => fmtDate(i.inspected_at) }, { label: 'Condition', render: i => badge(i.condition) }, { label: 'Findings', key: 'findings' }, { label: 'Actions', key: 'actions' }, { label: 'Inspector', key: 'inspector_name' }], d.inspections)}</div>
      <div class="card"><h2>Work orders</h2>${table([{ label: 'No.', key: 'wo_number' }, { label: 'Title', key: 'title' }, { label: 'Status', render: w => badge(w.status) }], d.work_orders, { href: w => '#/work-orders/' + w.id })}
      ${d.supply.length ? html`<h2 style="margin-top:1rem">Supply volumes</h2>${table([{ label: 'Period', render: b => `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` }, { label: 'Volume', cls: 'num', render: b => fmtM3(b.volume_m3) }, { label: 'Source', render: b => label(b.source) }], d.supply)}` : ''}</div></div>`);
  if (canAny('maintenance.view', 'telemetry.enter') && ['pump', 'treatment', 'source', 'reservoir', 'water_point', 'other'].includes(a.asset_type)) { const c = document.createElement('div'); c.className = 'card'; root.appendChild(c); import('./operations.js').then(m => m.assetMaintenance(c, a)); }
  const reload = () => detail(root, p);
  bind(root, {
    edit: () => assetForm(a, reload),
    status: () => modal('Update asset status', html`<div class="form">${formFields([{ name: 'status', label: 'Status', type: 'select', options: STATUSES, blank: false, default: a.status }, { name: 'maintenance_needs', label: 'Maintenance needs', type: 'textarea', full: true, default: a.maintenance_needs }])}</div>`, { onSubmit: async v => { await api('/api/assets/' + a.id, { method: 'PUT', body: v }); reload(); } }),
    inspect: () => modal('Record inspection', html`<div class="form">${formFields([{ name: 'inspected_at', label: 'Date', type: 'date', required: true, default: today() }, { name: 'condition', label: 'Condition', type: 'select', options: ['good', 'fair', 'poor', 'critical'], required: true },
      { name: 'findings', label: 'Findings', type: 'textarea', full: true }, { name: 'actions', label: 'Actions taken / recommended', type: 'textarea', full: true }, { name: 'next_inspection_due', label: 'Next inspection due', type: 'date' }])}</div>`, { onSubmit: async v => { await api(`/api/assets/${a.id}/inspections`, { body: v }); toast('Inspection saved', 'ok'); reload(); } }),
    tele: () => modal('Manual operational reading', html`<div class="note">Recorded as a MANUAL entry (not sensor data).</div><div class="form">${formFields([{ name: 'metric', label: 'Measurement', type: 'select', options: [['level_pct', 'Reservoir level (%)'], ['level_m', 'Reservoir level (m)'], ['pressure_bar', 'Pressure (bar)'], ['flow_m3h', 'Flow (m³/h)'], ['volume_m3', 'Totaliser volume (m³)'], ['pump_hours', 'Pump run hours'], ['chlorine_mgl', 'Residual chlorine (mg/L)']], required: true },
      { name: 'value', label: 'Value', type: 'number', step: 'any', required: true }, { name: 'unit', label: 'Unit' }, { name: 'recorded_at', label: 'Time observed', type: 'datetime-local' }])}</div>`, { onSubmit: async v => { await api(`/api/assets/${a.id}/telemetry`, { body: v }); toast('Saved', 'ok'); reload(); } }),
    wo: () => newWorkOrder({ asset_id: a.id, area_id: a.area_id, type: 'network', title: 'Maintenance: ' + a.name, description: a.maintenance_needs || '' })
  });
}
