import { api, html, raw, mount, $, state, qs, can, canAny, fmtDT, fmtDate, label, badge, sevBadge, basisBadge, table, modal, formFields, toast, bind, osmLink, confirmBox, groupedMaps } from '../core.js';
import { ensureLookups } from './dashboard.js';
import { planRoute, myPosition, osmDirections } from '../route.js';

const staffOpts = (L, roles = ['technician', 'manager', 'admin']) => L.staff.filter(s => roles.includes(s.role)).map(s => [s.id, `${s.full_name} (${label(s.role)})`]);

export async function newAlert(preset = {}, done) {
  const L = await ensureLookups();
  modal('Report a problem / raise an alert', html`<div class="form">${formFields([{ name: 'title', label: 'Title', required: true, full: true, placeholder: 'e.g. Customer reports water leaking at meter box' },
    { name: 'rule_type', label: 'Type', type: 'select', options: [['suspected_leak', 'Suspected leak'], ['sudden_high', 'Unusual consumption'], ['zero_consumption', 'No consumption'], ['device_event', 'Meter fault / tamper'], ['missing_reading', 'Missing reading'], ['customer_report', 'Customer report'], ['other', 'Other']], blank: false, default: 'suspected_leak' },
    { name: 'severity', label: 'Severity', type: 'select', options: ['low', 'medium', 'high', 'critical'], required: true, default: 'medium' }, { name: 'area_id', label: 'Area', type: 'select', options: L.areas.map(a => [a.id, a.name]) },
    { name: 'assigned_to', label: 'Assign to', type: 'select', options: staffOpts(L) }, { name: 'description', label: 'Details', type: 'textarea', full: true },
    { name: 'lat', label: 'Latitude', type: 'number', step: 'any' }, { name: 'lng', label: 'Longitude', type: 'number', step: 'any' }])}
    <input type="hidden" name="customer_id" value="${preset.customer_id || ''}"><input type="hidden" name="meter_id" value="${preset.meter_id || ''}"><input type="hidden" name="asset_id" value="${preset.asset_id || ''}"></div>`,
    { onSubmit: async v => { for (const k of ['customer_id', 'meter_id', 'asset_id']) v[k] = v[k] ? Number(v[k]) : null; await api('/api/alerts', { body: { ...v, area_id: v.area_id || preset.area_id || null } }); toast('Alert raised', 'ok'); done ? done() : (location.hash = '#/alerts'); } });
}
export async function newWorkOrder(preset = {}, done) {
  const L = await ensureLookups();
  modal('Create work order', html`<div class="form">${formFields([{ name: 'title', label: 'Title', required: true, full: true },
    { name: 'type', label: 'Work type', type: 'select', options: ['leak', 'meter', 'network', 'connection', 'inspection', 'other'], required: true }, { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'critical'], required: true, default: 'medium' },
    { name: 'assigned_to', label: 'Assign technician', type: 'select', options: staffOpts(L) }, { name: 'due_date', label: 'Due date', type: 'date' }, { name: 'area_id', label: 'Area', type: 'select', options: L.areas.map(a => [a.id, a.name]) },
    { name: 'description', label: 'Instructions', type: 'textarea', full: true }])}<input type="hidden" name="alert_id" value="${preset.alert_id || ''}"><input type="hidden" name="customer_id" value="${preset.customer_id || ''}"><input type="hidden" name="asset_id" value="${preset.asset_id || ''}"><input type="hidden" name="meter_id" value="${preset.meter_id || ''}"></div>`,
    { onSubmit: async v => { for (const k of ['alert_id', 'customer_id', 'asset_id', 'meter_id']) v[k] = v[k] ? Number(v[k]) : null; const r = await api('/api/work-orders', { body: v }); toast(`Work order ${r.wo_number} created`, 'ok'); done ? done(r) : (location.hash = '#/work-orders/' + r.id); } });
  const d = document.querySelector('dialog:last-of-type');
  if (preset.title) d.querySelector('[name=title]').value = preset.title;
  if (preset.type) d.querySelector('[name=type]').value = preset.type;
  if (preset.priority) d.querySelector('[name=priority]').value = preset.priority;
  if (preset.area_id) d.querySelector('[name=area_id]').value = preset.area_id;
  if (preset.description) d.querySelector('[name=description]').value = preset.description;
}

export async function alerts(root, _p, q) {
  const L = await ensureLookups();
  if (!q.status) q = { ...q, status: 'open_all' };
  const rows = await api('/api/alerts' + qs(q));
  const manage = can('alerts.manage');
  mount(root, html`<div class="page-head"><div><h1>Alerts</h1><small>Data basis shows whether an alert comes from device measurements, manual readings, estimates or the demo simulator.</small></div>
    <div class="actions">${can('alerts.run') ? html`<button class="btn" data-act="run">Run alert checks now</button>` : ''}<button class="btn" data-act="community">Community reports</button>${manage ? html`<button class="btn primary" data-act="new">+ Raise alert</button>` : ''}${can('settings.manage') ? html`<a class="btn" href="#/admin/alerts">Configure rules</a>` : ''}</div></div>
    <form class="filters" id="af"><label>Status<select name="status">${[['open_all', 'Open (all active)'], ['open', 'New'], ['acknowledged', 'Acknowledged'], ['work_order', 'Work order raised'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed'], ['', 'Any']].map(([k, l]) => html`<option value="${k}"${k === (q.status || '') ? raw(' selected') : ''}>${l}</option>`)}</select></label>
      <label>Severity<select name="severity"><option value="">All</option>${['critical', 'high', 'medium', 'low'].map(s => html`<option${s === q.severity ? raw(' selected') : ''}>${s}</option>`)}</select></label>
      <label>Type<select name="rule_type"><option value="">All</option>${['continuous_flow', 'sudden_high', 'zero_consumption', 'device_event', 'missing_reading', 'device_health', 'supply_imbalance', 'suspected_leak', 'customer_report'].map(s => html`<option value="${s}"${s === q.rule_type ? raw(' selected') : ''}>${label(s)}</option>`)}</select></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Filter</button></form>
    <div class="card flush">${table([{ label: 'Severity', render: a => sevBadge(a.severity) }, { label: 'Alert', render: a => html`<b>${a.title}</b><br><small>${a.description || ''}</small>` },
      { label: 'Affected', render: a => html`${a.customer_id ? html`<a href="#/customers/${a.customer_id}">${a.customer_name}</a><br>` : ''}${a.serial_number ? html`<small class="mono">${a.serial_number}</small><br>` : ''}${a.asset_name ? html`<a href="#/network/${a.asset_id}">${a.asset_name}</a><br>` : ''}<small>${a.area_name || ''}</small>` },
      { label: 'Location', render: a => osmLink(a.lat, a.lng) }, { label: 'Detected', render: a => fmtDT(a.detected_at) }, { label: 'Basis', render: a => basisBadge(a.data_basis) },
      { label: 'Status / assigned', render: a => html`${badge(a.status)}${a.wo_number ? html`<br><small>${a.wo_number}</small>` : ''}<br><small>${a.assigned_name || 'Unassigned'}</small>` },
      { label: '', render: a => (manage && !['resolved', 'dismissed'].includes(a.status) ? html`<div style="display:flex;flex-direction:column;gap:.25rem">${a.status !== 'work_order' ? html`<button class="btn sm primary" data-act="wo" data-id="${a.id}">Work order</button>` : ''}${a.status === 'open' ? html`<button class="btn sm" data-act="ack" data-id="${a.id}">Acknowledge</button>` : ''}<button class="btn sm" data-act="assign" data-id="${a.id}">Assign</button><button class="btn sm" data-act="resolve" data-id="${a.id}">Resolve / dismiss</button></div>` : a.resolution_note ? html`<small>${a.resolution_note}</small>` : '') }], rows, { empty: 'No alerts match. Run alert checks to evaluate the latest data.' })}</div>
    <div class="card">${groupedMaps(rows.map(a => ({ group: a.area_name, lat: a.lat, lng: a.lng, label: `${a.severity.toUpperCase()}: ${a.title}`, color: { critical: '#b42323', high: '#ec835a', medium: '#eda100', low: '#2a78d6' }[a.severity], href: '#/alerts' })), { height: 180 })}
      <small class="muted">Positions plotted from recorded GPS (relative layout, no map tiles needed offline). Colour = severity, also shown in the table.</small></div>`);
  $('#af', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/alerts' + qs(Object.fromEntries(new FormData(e.target))); });
  const reload = () => alerts(root, _p, q); const find = id => rows.find(a => a.id === Number(id));
  bind(root, {
    run: async () => { const r = await api('/api/alerts/run', { body: {} }); toast(`Checks complete: ${r.total} new alert(s)`, 'ok'); reload(); },
    new: () => newAlert({}, reload),
    community: async () => { const rs = await api('/api/public-reports');
      modal('Community reports (no-login web, USSD, SMS)', html`<p class="muted" style="font-size:.88rem">Each report creates an alert. When the alert is resolved or its work order completed, the reporter gets an SMS automatically. Public page: <a href="/status" target="_blank" rel="noopener">/status</a></p>
        ${table([{ label: 'Ref', render: r => html`<b class="mono">${r.ref}</b>` }, { label: 'When', render: r => fmtDT(r.created_at.replace(' ', 'T') + 'Z') }, { label: 'Type', render: r => label(r.kind) }, { label: 'Channel', render: r => r.channel.toUpperCase() },
          { label: 'Where', render: r => html`${r.area_name || ''}<br><small>${r.location_text || ''}</small>` }, { label: 'Details', render: r => html`<small>${r.description || ''}</small>${r.has_photo ? html` <a href="/api/public-reports/${r.id}/photo" target="_blank">📷</a>` : ''}` },
          { label: 'Status', render: r => html`${badge(r.alert_status || 'open')}${r.has_phone ? html`<br><small>${r.resolved_notified ? 'reporter notified ✓' : 'will be notified'}</small>` : ''}` }], rs, { empty: 'No community reports yet.' })}`, { wide: true }); },
    ack: async el => { await api(`/api/alerts/${el.dataset.id}/update`, { body: { status: 'acknowledged' } }); reload(); },
    assign: el => modal('Assign alert', html`<div class="form">${formFields([{ name: 'assigned_to', label: 'Staff member', type: 'select', options: staffOpts(L, ['technician', 'manager', 'admin', 'cashier', 'meter_reader']), required: true, full: true }])}</div>`, { onSubmit: async v => { await api(`/api/alerts/${el.dataset.id}/update`, { body: v }); toast('Assigned', 'ok'); reload(); } }),
    resolve: el => modal('Resolve or dismiss alert', html`<div class="form">${formFields([{ name: 'status', label: 'Outcome', type: 'select', options: [['resolved', 'Resolved'], ['dismissed', 'Dismissed (false alarm)']], blank: false }, { name: 'note', label: 'Note', type: 'textarea', required: true, full: true }])}</div>`, { onSubmit: async v => { await api(`/api/alerts/${el.dataset.id}/update`, { body: v }); toast('Updated', 'ok'); reload(); } }),
    wo: el => { const a = find(el.dataset.id); newWorkOrder({ alert_id: a.id, title: a.title, type: ['continuous_flow', 'suspected_leak', 'supply_imbalance'].includes(a.rule_type) ? 'leak' : a.rule_type === 'device_event' || a.rule_type === 'device_health' || a.rule_type === 'zero_consumption' ? 'meter' : 'inspection', priority: a.severity, area_id: a.area_id, description: (a.description || '') + (a.data_basis === 'simulated' ? ' [Based on SIMULATED demo data]' : '') }, () => reload()); }
  });
}

export async function workOrders(root, _p, q) {
  const L = await ensureLookups();
  if (!q.status && q.status !== '') q = { ...q, status: 'active' };
  const rows = await api('/api/work-orders' + qs(q));
  mount(root, html`<div class="page-head"><div><h1>Work orders</h1><small>${state.user.role === 'technician' ? 'Jobs assigned to you and unassigned jobs' : rows.length + ' shown'}</small></div><div class="actions"><button class="btn" data-act="route">🧭 Plan today's route</button>${can('workorders.manage') ? html`<button class="btn primary" data-act="new">+ New work order</button>` : ''}</div></div>
    <div class="tabs">${[['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['', 'All']].map(([k, l]) => html`<a href="#/work-orders?status=${k}" class="${(q.status ?? '') === k ? 'active' : ''}">${l}</a>`)}</div>
    <div class="card flush">${table([{ label: 'No.', render: w => html`<span class="mono">${w.wo_number}</span>` }, { label: 'Priority', render: w => sevBadge(w.priority) }, { label: 'Type', render: w => label(w.type) }, { label: 'Title', render: w => html`<b>${w.title}</b>` },
      { label: 'Where', render: w => html`${w.customer_name || w.asset_name || ''}<br><small>${w.address || w.area_name || ''}</small>` }, { label: 'Assigned', render: w => w.assigned_name || html`<span class="badge warn">Unassigned</span>` },
      { label: 'Due', render: w => fmtDate(w.due_date) }, { label: 'Status', render: w => badge(w.status) }], rows, { href: w => '#/work-orders/' + w.id, empty: 'No work orders.' })}</div>`);
  bind(root, { new: () => newWorkOrder({}),
    route: async () => {
      const me = await myPosition(); const active = rows.filter(w => !['completed', 'cancelled', 'on_hold'].includes(w.status));
      const p = planRoute(me, active.map(w => ({ ...w })));
      let prev = me || p.start;
      modal(`Today's route — ${active.length} jobs, about ${p.km} km`, html`${me ? '' : html`<div class="note warn">Location unavailable: route starts at the first job.</div>`}<ol style="padding-left:1.2rem">${p.order.map(w => { const link = prev && w.lat != null ? osmDirections(prev, w) : null; if (w.lat != null) prev = w;
        return html`<li style="margin:.4rem 0"><b>${w.wo_number}</b> ${sevBadge(w.priority)} ${w.title}<br><small>${w.customer_name || w.asset_name || ''} ${w.address || w.area_name || ''}</small>${link ? html` · <a href="${link}" target="_blank" rel="noopener">Directions ↗</a>` : w.lat == null ? html` <span class="badge outline">no GPS</span>` : ''}</li>`; })}</ol>
        <p class="muted" style="font-size:.85rem">Ordered to minimise travel (nearest-neighbour + 2-opt). Critical jobs may still need to go first.</p>`, {});
    } });
}

export async function workOrder(root, p) {
  const L = await ensureLookups();
  const d = await api('/api/work-orders/' + p.id); const w = d.work_order;
  const closed = ['completed', 'cancelled'].includes(w.status);
  const isMgr = can('workorders.manage');
  mount(root, html`<div class="crumbs"><a href="#/work-orders">Work orders</a> ›</div><div class="page-head"><div><h1>${w.wo_number}: ${w.title}</h1>${sevBadge(w.priority)} ${badge(w.status)} ${w.data_basis ? basisBadge(w.data_basis) : ''}</div></div>
    <div class="grid g2"><div class="card"><dl class="kv"><dt>Type</dt><dd>${label(w.type)}</dd><dt>Assigned to</dt><dd>${w.assigned_name || 'Unassigned'}</dd><dt>Due</dt><dd>${fmtDate(w.due_date)}</dd>
      ${w.alert_id ? html`<dt>From alert</dt><dd>#${w.alert_id} ${w.alert_title}</dd>` : ''}${w.customer_name ? html`<dt>Customer</dt><dd>${can('customers.view') ? html`<a href="#/customers/${w.customer_id}">${w.customer_name}</a>` : w.customer_name} · ${w.customer_phone || ''}<br><small>${w.address}</small></dd>` : ''}
      ${w.serial_number ? html`<dt>Meter</dt><dd class="mono">${w.serial_number}</dd>` : ''}${w.asset_name ? html`<dt>Asset</dt><dd><a href="#/network/${w.asset_id}">${w.asset_name}</a></dd>` : ''}<dt>Area</dt><dd>${w.area_name || '—'}</dd>
      <dt>Location</dt><dd>${osmLink(w.lat, w.lng)}</dd><dt>Created</dt><dd>${fmtDT(w.created_at)}</dd>${w.completed_at ? html`<dt>Completed</dt><dd>${fmtDT(w.completed_at)}</dd>` : ''}</dl>
      ${w.description ? html`<h3 style="margin-top:1rem">Instructions</h3><p>${w.description}</p>` : ''}${w.resolution ? html`<div class="note">Resolution: ${w.resolution}</div>` : ''}</div>
    <div class="card"><h2>Update</h2>${closed && !isMgr ? html`<p class="muted">This work order is closed.</p>` : html`<form id="wu" class="form">${formFields([
      { name: 'status', label: 'New status', type: 'select', options: ['assigned', 'in_progress', 'on_hold', 'completed', ...(isMgr ? ['cancelled', 'open'] : [])], blank: 'No change' },
      ...(isMgr ? [{ name: 'assigned_to', label: 'Reassign', type: 'select', options: staffOpts(L), blank: 'No change' }, { name: 'priority', label: 'Priority', type: 'select', options: ['low', 'medium', 'high', 'critical'], blank: 'No change' }] : []),
      { name: 'note', label: 'Field notes / work done', type: 'textarea', required: true, full: true, placeholder: 'What did you find and do? Parts used?' }, ...(w.alert_id ? [{ name: 'resolve_alert', label: 'When completed, also resolve the linked alert', type: 'checkbox', default: true, full: true }] : [])])}
      <div class="full"><button class="btn primary">Save update</button></div></form>`}
      ${w.meter_id && can('meters.status') && !can('meters.manage') ? html`<p><a href="#/meters/${w.meter_id}">Open meter to mark faulty/active</a></p>` : ''}</div></div>
    ${canAny('stock.view', 'stock.issue') ? html`<div class="card" id="mat"><h2>Materials used</h2><div class="empty">Loading…</div></div>` : ''}
    <div class="card"><h2>History</h2>${table([{ label: 'When', render: u => fmtDT(u.created_at) }, { label: 'By', key: 'user_name' }, { label: 'Status', render: u => badge(u.status) }, { label: 'Note', key: 'note' }], d.updates)}</div>`);
  if ($('#mat', root)) import('./service.js').then(m => m.materialsPanel($('#mat', root), w, () => workOrder(root, p)));
  const f = $('#wu', root);
  if (f) f.addEventListener('submit', async e => { e.preventDefault(); const v = Object.fromEntries(new FormData(f)); const body = { note: v.note }; if (v.status) body.status = v.status; if (v.assigned_to) body.assigned_to = Number(v.assigned_to); if (v.priority) body.priority = v.priority; if (f.resolve_alert) body.resolve_alert = f.resolve_alert.checked;
    try { await api(`/api/work-orders/${w.id}/update`, { body }); toast('Work order updated', 'ok'); workOrder(root, p); } catch (err) { toast(err.message, 'err'); } });
}
