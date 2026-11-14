// Preventive maintenance & functionality, service levels (SDG 6.1 / JMP ladder), cashier end-of-day close.
import { api, html, raw, mount, $, $$, state, qs, can, money, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, confirmBox, today, download, currencies } from '../core.js';
import { ensureLookups } from './dashboard.js';

const STATE = { overdue: ['overdue', 'Overdue'], due_soon: ['pending', 'Due soon'], ok: ['good', 'OK'], unknown: ['outline', 'Needs data'] };

// ======================= Maintenance =======================
export async function maintenance(root, _p, q) {
  const tab = q.tab || 'plans';
  mount(root, html`<div class="page-head"><div><h1>Maintenance</h1><small>Preventive service for pumps, generators, chlorinators and tanks — by days or run-hours, whichever comes first — and how much of the time each asset actually works.</small></div>
    <div class="actions">${can('maintenance.manage') && tab === 'plans' ? html`<button class="btn primary" data-act="new">+ Service plan</button> <button class="btn" data-act="run">Create due work orders now</button>` : ''}${tab === 'energy' && (can('telemetry.enter') || can('maintenance.manage')) ? html`<button class="btn primary" data-act="enew">+ Energy record</button>` : ''}</div></div>
    <div class="tabs">${[['plans', 'Service plans'], ['functionality', 'Functionality'], ['energy', 'Energy & fuel']].map(([k, l]) => html`<a href="#/maintenance?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="mt"></div>`);
  bind(root, { new: () => planForm(null, () => maintenance(root, _p, q)), enew: () => energyForm(null, () => maintenance(root, _p, q)),
    run: async () => { const r = await api('/api/maintenance/run', { body: {} }); toast(r.created.length ? `${r.created.length} work order(s) created: ${r.created.map(c => c.wo_number).join(', ')}` : 'Nothing new is due', r.created.length ? 'ok' : ''); maintenance(root, _p, q); } });
  return tab === 'energy' ? energy($('#mt', root), q, () => maintenance(root, _p, q)) : tab === 'functionality' ? functionality($('#mt', root), q) : plansTab($('#mt', root), root, _p, q);
}
async function planForm(p, done, assetId) {
  const assets = await api('/api/assets');
  modal(p ? 'Edit service plan' : 'New service plan', html`<div class="form">${formFields([
    { name: 'asset_id', label: 'Asset', type: 'select', required: true, options: assets.filter(a => a.status !== 'decommissioned').map(a => [a.id, `${a.name} (${label(a.asset_type)})`]) },
    { name: 'title', label: 'Service', required: true, placeholder: 'e.g. Oil and filter change' }, { name: 'interval_days', label: 'Every … days', type: 'number', min: 1 }, { name: 'interval_hours', label: 'and/or every … run-hours', type: 'number', min: 1, step: 'any' },
    { name: 'last_done_at', label: 'Last done on', type: 'date' }, { name: 'last_done_hours', label: 'Hour meter at last service', type: 'number', step: 'any' }, { name: 'lead_days', label: 'Create the work order … days ahead', type: 'number', min: 0, default: 7 },
    { name: 'priority', label: 'Priority', type: 'select', blank: false, options: ['low', 'medium', 'high', 'critical'], default: 'medium' }, { name: 'tasks', label: 'Checklist for the technician', type: 'textarea', full: true },
    ...(p ? [{ name: 'active', label: 'Plan in use', type: 'checkbox' }] : [])], p ? { ...p, last_done_at: p.last_done_at ? p.last_done_at.slice(0, 10) : '' } : { asset_id: assetId })}</div>`,
  { onSubmit: async v => { await api('/api/maintenance/plans' + (p ? '/' + p.id : ''), { method: p ? 'PUT' : 'POST', body: v }); toast('Service plan saved', 'ok'); done(); } });
}
const dueText = d => (d.due_at == null ? d.reasons.join('; ') : d.days_left < 0 ? `${-d.days_left} day(s) late` : d.days_left === 0 ? 'today' : `in ${d.days_left} day(s)`);
async function plansTab(el, root, p, q) {
  const d = await api('/api/maintenance');
  const rows = d.plans.filter(x => x.active || q.all);
  mount(el, html`<div class="grid g4" style="margin-bottom:1rem">${['overdue', 'due_soon', 'ok', 'unknown'].map(s => html`<div class="kpi"><div class="label">${STATE[s][1]}</div><div class="value">${rows.filter(x => x.due.state === s).length}</div></div>`)}</div>
    <div class="card flush">${table([{ label: 'Asset', render: x => html`<a href="#/network/${x.asset_id}">${x.asset_name}</a><br><small class="muted">${label(x.asset_type)} · ${x.area_name || '—'}</small>${x.asset_status !== 'operational' ? html` ${badge(x.asset_status)}` : ''}` },
      { label: 'Service', render: x => html`<b>${x.title}</b>${x.tasks ? html`<br><small class="muted">${x.tasks.slice(0, 90)}${x.tasks.length > 90 ? '…' : ''}</small>` : ''}` },
      { label: 'Interval', render: x => [x.interval_days && `${x.interval_days} days`, x.interval_hours && `${fmtNum(x.interval_hours, 0)} h`].filter(Boolean).join(' / ') },
      { label: 'Last done', render: x => html`${fmtDate(x.last_done_at)}${x.last_done_hours != null ? html`<br><small>${fmtNum(x.last_done_hours, 0)} h</small>` : ''}` },
      { label: 'Run-hours', cls: 'num', render: x => (x.interval_hours ? html`${x.due.current_hours != null ? fmtNum(x.due.current_hours, 0) + ' h' : '—'}${x.due.hours_left != null ? html`<br><small>${fmtNum(x.due.hours_left, 0)} h left</small>` : ''}${x.due.rate_per_day ? html`<br><small class="muted">≈${x.due.rate_per_day} h/day</small>` : ''}` : '—') },
      { label: 'Due', render: x => html`${badge(STATE[x.due.state][0], STATE[x.due.state][1])}<br><small>${dueText(x.due)}</small>` },
      { label: 'Job', render: x => (x.due.open_wo ? html`<a href="#/work-orders/${x.due.open_wo.id}" class="mono">${x.due.open_wo.wo_number}</a> ${badge(x.due.open_wo.status)}` : '—') },
      { label: '', render: x => (can('maintenance.manage') ? html`<button class="btn sm" data-act="edit" data-id="${x.id}">Edit</button>` : '') }], rows, { empty: 'No service plans yet. Add one for each pump, generator, chlorinator and tank.' })}</div>
    <p class="muted" style="font-size:.85rem">Work orders are created automatically once a day for plans that are due (${d.auto ? 'on' : 'off'}${d.last_run ? `; last run ${fmtDT(d.last_run)}` : ''}). Completing the work order resets the plan; record the hour meter on the asset page when you service it.</p>`);
  bind(el, { edit: b => planForm(d.plans.find(x => x.id === Number(b.dataset.id)), () => maintenance(root, p, q)) });
}
async function functionality(el, q) {
  const L = await ensureLookups();
  const d = await api('/api/functionality' + qs({ from: q.from, to: q.to, area_id: q.area_id }));
  const s = d.summary;
  mount(el, html`<form class="filters" id="ff"><input type="hidden" name="tab" value="functionality"><label>From<input type="date" name="from" value="${d.from}"></label><label>To<input type="date" name="to" value="${d.to}"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Show</button>
      <button type="button" class="btn" data-act="csv">Export CSV</button></form>
    <div class="grid g4" style="margin-bottom:1rem"><div class="kpi"><div class="label">Water points working now</div><div class="value">${s.functional_now} / ${s.water_points}</div><div class="sub">${s.functional_now_pct == null ? '' : s.functional_now_pct + '%'}</div></div>
      <div class="kpi"><div class="label">Average water-point functionality</div><div class="value">${s.avg_functional_pct == null ? '—' : fmtNum(s.avg_functional_pct, 1) + '%'}</div><div class="sub">share of the period providing water</div></div>
      <div class="kpi"><div class="label">Breakdowns in period</div><div class="value">${s.breakdowns}</div></div></div>
    <div class="card flush">${table([{ label: 'Asset', render: r => html`<a href="#/network/${r.asset_id}">${r.name}</a><br><small class="muted">${label(r.asset_type)} · ${r.area || '—'}</small>` },
      { label: 'Now', render: r => html`${badge(r.status)}${r.down_since ? html`<br><small class="crit-t">since ${fmtDate(r.down_since.slice(0, 10))}</small>` : ''}` },
      { label: 'Functional', cls: 'num', render: r => (r.functional_pct == null ? '—' : html`<b class="${r.functional_pct < 90 ? 'crit-t' : ''}">${fmtNum(r.functional_pct, 1)}%</b><div class="bar"><span style="width:${raw(r.functional_pct)}%"></span></div>`) },
      { label: 'Downtime', cls: 'num', render: r => (r.downtime_hours ? `${fmtNum(r.downtime_hours, 0)} h` : '—') }, { label: 'Breakdowns', cls: 'num', key: 'breakdowns' },
      { label: 'Typical repair time', cls: 'num', render: r => (r.median_repair_hours == null ? '—' : r.median_repair_hours >= 48 ? `${fmtNum(r.median_repair_hours / 24, 1)} days` : `${fmtNum(r.median_repair_hours, 0)} h`) }], d.rows)}</div>
    <p class="muted" style="font-size:.85rem">Functional = operational or degraded. Planned maintenance counts as not functional but not as a breakdown. Worked out from every status change recorded on the asset.</p>`);
  $('#ff', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/maintenance' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, { csv: () => download('/api/functionality' + qs({ from: d.from, to: d.to, area_id: q.area_id, format: 'csv' })) });
}

/** Asset page card: service plans and hour-meter readings. */
export async function assetMaintenance(el, a, reload) {
  const d = await api(`/api/assets/${a.id}/run-hours`);
  mount(el, html`<div class="card-head"><h2>Maintenance & run-hours</h2>${can('maintenance.manage') ? html`<button class="btn sm" data-act="mplan">+ Service plan</button>` : ''}</div>
    ${d.plans.length ? table([{ label: 'Service', key: 'title' }, { label: 'Due', render: x => html`${badge(STATE[x.due.state][0], STATE[x.due.state][1])} <small>${dueText(x.due)}</small>` }, { label: 'Job', render: x => (x.due.open_wo ? html`<a href="#/work-orders/${x.due.open_wo.id}">${x.due.open_wo.wo_number}</a>` : '—') }], d.plans) : html`<p class="muted">No service plan for this asset.</p>`}
    <h3>Hour meter ${d.rate_per_day ? html`<small class="muted">≈${d.rate_per_day} h/day</small>` : ''}</h3>
    ${can('telemetry.enter') || can('maintenance.manage') ? html`<form id="rhf" style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center"><input name="reading" type="number" step="0.1" min="0" placeholder="Hours on the meter" required style="width:10rem">
      <label style="display:flex;gap:.3rem;align-items:center;font-size:.85rem"><input type="checkbox" name="reset"> meter reset/replaced</label><input name="note" placeholder="Note" style="flex:1;min-width:8rem"><button class="btn primary sm">Record</button></form>` : ''}
    ${table([{ label: 'When', render: r => fmtDT(r.recorded_at) }, { label: 'Hours', cls: 'num', render: r => html`${fmtNum(r.reading, 1)}${r.reset ? html` ${badge('pending', 'reset')}` : ''}` }, { label: 'By', render: r => r.user_name || '—' }, { label: 'Note', render: r => r.note || '' }], d.rows.slice(0, 8), { empty: 'No hour-meter readings yet.' })}`);
  const f = $('#rhf', el);
  if (f) f.addEventListener('submit', async e => { e.preventDefault(); try { const r = await api(`/api/assets/${a.id}/run-hours`, { body: { reading: Number(f.reading.value), reset: f.reset.checked, note: f.note.value || null } }); toast(`Recorded${r.rate_per_day ? ` — about ${r.rate_per_day} h/day` : ''}`, 'ok'); assetMaintenance(el, a, reload); } catch (err) { toast(err.message, 'err'); } });
  bind(el, { mplan: () => planForm(null, () => assetMaintenance(el, a, reload), a.id) });
}

// ---- Energy & fuel ----
const ETYPE = [['diesel', 'Diesel (litres)'], ['petrol', 'Petrol (litres)'], ['grid', 'Grid electricity (kWh)'], ['solar', 'Solar (kWh, if metered)']];
const TREND = { worse: ['crit', 'Less efficient'], better: ['good', 'More efficient'], steady: ['good', 'Steady'], no_baseline: ['outline', 'Building a baseline'], no_data: ['outline', 'Nothing to compare yet'] };
async function energyForm(row, done) {
  const assets = (await api('/api/assets')).filter(a => ['pump', 'source', 'treatment'].includes(a.asset_type) && a.status !== 'decommissioned');
  const last = row && row.entries.length ? row.entries[row.entries.length - 1] : null;
  const start = last ? new Date(Date.parse(last.period_end) + 86400e3).toISOString().slice(0, 10) : new Date(Date.now() - 29 * 86400e3).toISOString().slice(0, 10);
  modal('Record energy used', html`<div class="note">Enter what the pump used and the water it pumped over the same days. One record a month is enough.</div><div class="form">${formFields([
    { name: 'asset_id', label: 'Pump', type: 'select', required: true, options: assets.map(a => [a.id, a.name]) }, { name: 'energy_type', label: 'Energy', type: 'select', required: true, blank: false, options: ETYPE },
    { name: 'period_start', label: 'From', type: 'date', required: true }, { name: 'period_end', label: 'To', type: 'date', required: true },
    { name: 'quantity', label: 'Fuel or electricity used', type: 'number', step: 'any', min: 0, inputmode: 'decimal', help: 'Litres or kWh. Solar can be left empty.' }, { name: 'volume_m3', label: 'Water pumped (m³)', type: 'number', step: 'any', min: 0, inputmode: 'decimal', help: 'From the pump or district meter.' },
    { name: 'cost', label: 'Cost', type: 'number', step: 'any', min: 0 }, { name: 'currency', label: 'Currency', type: 'select', blank: false, options: currencies() },
    { name: 'run_hours', label: 'Hours run', type: 'number', step: 'any', min: 0, help: 'Leave empty to take it from the hour-meter readings.' }, { name: 'notes', label: 'Notes' }],
  { asset_id: row ? row.id : '', energy_type: last ? last.energy_type : 'diesel', period_start: start <= today() ? start : today(), period_end: today(), currency: last && last.currency })}</div>`,
  { wide: true, onSubmit: async v => { const r = await api('/api/energy', { body: v });
    toast(r.trend.state === 'worse' ? `Saved — ${r.trend.change_pct}% more per m³ than usual. An alert was raised.` : 'Energy record saved', r.trend.state === 'worse' ? 'err' : 'ok'); done(); } });
}
async function energy(el, q, reload) {
  const L = await ensureLookups(); const d = await api('/api/energy' + qs({ from: q.from, to: q.to, area_id: q.area_id })); const s = d.summary; const canAdd = can('telemetry.enter') || can('maintenance.manage');
  const all = d.rows.flatMap(r => r.entries.map(e => ({ ...e, pump: r.name }))).sort((a, b) => (a.period_end < b.period_end ? 1 : -1));
  mount(el, html`<form class="filters" id="ef"><input type="hidden" name="tab" value="energy"><label>From<input type="date" name="from" value="${d.from}"></label><label>To<input type="date" name="to" value="${d.to}"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Show</button>
      <button type="button" class="btn" data-act="csv">Export CSV</button></form>
    <div class="grid g4" style="margin-bottom:1rem"><div class="kpi"><div class="label">Energy cost in period</div><div class="value" style="font-size:1.25rem">${s.cost.length ? s.cost.map(c => money(c.amount, c.currency)).join(' + ') : '—'}</div></div>
      <div class="kpi"><div class="label">Water pumped</div><div class="value">${fmtNum(s.volume_m3, 0)} m³</div></div>
      <div class="kpi"><div class="label">Pumps using more than usual</div><div class="value ${s.worse ? 'crit-t' : ''}">${s.worse}</div><div class="sub">alert at +${d.alert_pct}% per m³</div></div>
      <div class="kpi"><div class="label">Pumps with no record</div><div class="value">${s.no_data}</div><div class="sub">in this period</div></div></div>
    <div class="card flush">${table([{ label: 'Pump', render: r => html`<a href="#/network/${r.id}"><b>${r.name}</b></a>${r.status !== 'operational' ? html` ${badge(r.status)}` : ''}<br><small class="muted">${r.area_name || '—'}</small>` },
      { label: 'Used', cls: 'num', render: r => (r.quantity ? `${fmtNum(r.quantity, 0)} ${r.unit}` : r.types.includes('solar') ? 'Solar' : '—') }, { label: 'Water pumped', cls: 'num', render: r => (r.volume_m3 ? `${fmtNum(r.volume_m3, 0)} m³` : '—') },
      { label: 'Per m³', cls: 'num', render: r => (r.per_m3 == null ? '—' : `${fmtNum(r.per_m3, 2)} ${r.unit}`) }, { label: 'Cost per m³', cls: 'num', render: r => (r.cost_per_m3 == null ? '—' : money(r.cost_per_m3, r.cost_currency)) },
      { label: 'Latest against usual', render: r => html`<span class="badge ${TREND[r.trend.state][0]}">${TREND[r.trend.state][1]}</span>${r.trend.change_pct != null ? html`<br><small>${fmtNum(r.trend.latest, 2)} ${r.trend.unit}/m³ · usual ${fmtNum(r.trend.baseline, 2)} (${r.trend.change_pct > 0 ? '+' : ''}${fmtNum(r.trend.change_pct, 0)}%)</small>` : ''}${r.trend.output_change_pct != null && r.trend.output_change_pct <= -10 ? html`<br><small class="crit-t">Output per hour ${fmtNum(r.trend.output_change_pct, 0)}%</small>` : ''}` },
      { label: '', cls: 'act', render: r => (canAdd ? html`<button class="btn sm" data-act="rec" data-id="${r.id}">+ Record</button>` : '') }], d.rows, { empty: 'No pumps in the asset register yet.' })}</div>
    <p class="muted" style="font-size:.85rem">Each pump is compared with its own earlier records on the same energy (at least three). More fuel or electricity for the same water usually means wear, a blockage, a leak on the rising main or a falling water level.</p>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Records</h2></div>${table([{ label: 'Period', render: e => html`${fmtDate(e.period_start)} – ${fmtDate(e.period_end)}` }, { label: 'Pump', key: 'pump' }, { label: 'Used', cls: 'num', render: e => (e.quantity ? `${fmtNum(e.quantity, 0)} ${e.unit}` : label(e.energy_type)) },
      { label: 'Water', cls: 'num', render: e => (e.volume_m3 ? `${fmtNum(e.volume_m3, 0)} m³` : '—') }, { label: 'Per m³', cls: 'num', render: e => (e.per_m3 == null ? '—' : `${fmtNum(e.per_m3, 2)} ${e.unit}`) }, { label: 'Cost', cls: 'num', render: e => (e.cost == null ? '—' : money(e.cost, e.currency)) },
      { label: 'Cost per m³', cls: 'num', render: e => (e.cost_per_m3 == null ? '—' : money(e.cost_per_m3, e.currency)) }, { label: 'Hours', cls: 'num', render: e => (e.run_hours ? fmtNum(e.run_hours, 0) : '—') }, { label: 'Per hour', cls: 'num', render: e => (e.per_hour == null ? '—' : `${fmtNum(e.per_hour, 1)} ${e.unit}`) },
      { label: 'm³ per hour', cls: 'num', render: e => (e.m3_per_hour == null ? '—' : fmtNum(e.m3_per_hour, 1)) }, { label: '', render: e => (can('maintenance.manage') ? html`<button class="btn sm" data-act="void" data-id="${e.id}">Void</button>` : '') }], all, { empty: 'No energy records in this period.' })}</div>`);
  $('#ef', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/maintenance' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, { csv: () => download('/api/energy' + qs({ from: d.from, to: d.to, area_id: q.area_id, format: 'csv' })), rec: b => energyForm(d.rows.find(r => r.id === Number(b.dataset.id)), reload),
    void: async b => { const r = await confirmBox('Void this energy record?', 'The record stays in the audit trail but is left out of every calculation.', { ok: 'Void', danger: true, reason: true }); if (!r) return; await api(`/api/energy/${b.dataset.id}/void`, { body: { reason: r.reason || r } }); toast('Record voided', 'ok'); reload(); } });
}

// ======================= Service levels =======================
const LEVELS = [['safely_managed', 'Safely managed', '#1f6fb2'], ['basic', 'Basic', '#3fa34d'], ['limited', 'Limited', '#e2b007'], ['basic_or_limited', 'Basic or limited (collection time unknown)', '#b9c2cc'], ['not_functional', 'Water point not working', '#c0392b']];
export async function serviceLevels(root, _p, q) {
  const L = await ensureLookups();
  const d = await api('/api/service-levels' + qs({ from: q.from, to: q.to, area_id: q.area_id }));
  const bar = (levels, base) => html`<div style="display:flex;height:22px;border-radius:6px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border)">${LEVELS.map(([k, l, c]) => { const v = levels[k] ? levels[k].people : 0; const w = base ? v / base * 100 : 0; return w > 0 ? html`<span title="${l}: ${v}" style="width:${raw(w.toFixed(2))}%;background:${raw(c)}"></span>` : ''; })}</div>`;
  mount(root, html`<div class="page-head"><div><h1>Service levels (SDG 6.1)</h1><small>How many people the utility serves at each rung of the WHO/UNICEF JMP drinking-water ladder — estimated from customers, water points, hours of supply and water-quality results.</small></div>
    <div class="actions"><button class="btn" data-act="csv">Export CSV</button></div></div>
    <div class="note warn"><b>Estimates.</b> ${d.method} Enter each area's population (Administration › Service areas) and, for each water point, the people using it and the round-trip collection time including queuing (asset page › Edit).</div>
    <form class="filters" id="sf"><label>From<input type="date" name="from" value="${d.from}"></label><label>To<input type="date" name="to" value="${d.to}"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Show</button></form>
    <div class="card"><h2>All areas</h2><div class="grid g4" style="margin-bottom:.8rem"><div class="kpi"><div class="label">People served (estimate)</div><div class="value">${fmtNum(d.totals.served, 0)}</div><div class="sub">${d.totals.population ? `of ${fmtNum(d.totals.population, 0)} living in the areas` : 'area populations incomplete'}</div></div>
      ${LEVELS.slice(0, 3).map(([k, l]) => html`<div class="kpi"><div class="label">${l}</div><div class="value">${fmtNum(d.totals[k], 0)}</div><div class="sub">${d.totals.population ? fmtNum(d.totals[k] / d.totals.population * 100, 1) + '% of population' : ''}</div></div>`)}</div>
      ${bar(Object.fromEntries(LEVELS.map(([k]) => [k, { people: d.totals[k] }])), d.totals.population || d.totals.served)}
      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:.5rem;font-size:.8rem">${LEVELS.map(([k, l, c]) => html`<span><span style="display:inline-block;width:.8rem;height:.8rem;border-radius:2px;background:${raw(c)};vertical-align:middle"></span> ${l}</span>`)}${d.totals.population ? html`<span><span style="display:inline-block;width:.8rem;height:.8rem;border-radius:2px;background:var(--surface-2);border:1px solid var(--border);vertical-align:middle"></span> Not served by the utility / unknown</span>` : ''}</div></div>
    ${d.areas.map(a => html`<div class="card"><div class="card-head"><h2 style="margin:0">${a.area}</h2><span class="muted">${a.population ? `${fmtNum(a.served, 0)} of ${fmtNum(a.population, 0)} people (${fmtNum(a.served_pct, 1)}%)` : `${fmtNum(a.served, 0)} people served`}</span></div>
      ${bar(a.levels, a.population || a.served)}
      <div class="grid g2" style="margin-top:.8rem"><div>${table([{ label: 'Service level', render: x => x.l }, { label: 'People', cls: 'num', render: x => fmtNum(x.v.people, 0) }, { label: '% of served', cls: 'num', render: x => (x.v.pct_of_served == null ? '—' : fmtNum(x.v.pct_of_served, 1) + '%') }, { label: '% of population', cls: 'num', render: x => (x.v.pct_of_population == null ? '—' : fmtNum(x.v.pct_of_population, 1) + '%') }],
          LEVELS.map(([k, l]) => ({ l, v: a.levels[k] })).filter(x => x.v.people))}</div>
        <div><dl class="kv"><dt>Piped homes</dt><dd>${fmtNum(a.piped_people, 0)} people — ${a.piped_basis}</dd><dt>Available when needed</dt><dd>${a.availability.ok === true ? '✔ ' : a.availability.ok === false ? '✘ ' : '? '}${a.availability.basis}</dd>
          <dt>Free from contamination</dt><dd>${a.quality.ok === true ? '✔ ' : a.quality.ok === false ? '✘ ' : '? '}${a.quality.basis}</dd>
          <dt>Water points</dt><dd>${a.water_points.length ? a.water_points.map(w => html`<div><a href="#/network/${w.id}">${w.name}</a>: ${w.served_population ? `${w.served_population} people` : html`<span class="crit-t">people not recorded</span>`}${w.round_trip_min != null ? `, ${w.round_trip_min} min round trip` : ''} → ${label(w.level)}</div>`) : 'none'}</dd></dl>
          ${a.notes.length ? html`<div class="note">${a.notes.map(n => html`<div>• ${n}</div>`)}</div>` : ''}</div></div></div>`)}`);
  $('#sf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/service-levels' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(root, { csv: () => download('/api/service-levels' + qs({ from: d.from, to: d.to, area_id: q.area_id, format: 'csv' })) });
}

// ======================= Cash close =======================
const CS = { submitted: ['pending', 'Waiting for review'], approved: ['good', 'Approved'], rejected: ['overdue', 'Rejected — recount'] };
export async function cash(root, _p, q) {
  const tabs = [can('cash.close') && ['my', 'My cash close'], can('cash.review') && ['book', 'Cash book']].filter(Boolean);
  const tab = q.tab && tabs.some(t => t[0] === q.tab) ? q.tab : tabs[0][0];
  mount(root, html`<div class="page-head"><div><h1>Cash close</h1><small>At the end of each day every cashier counts the drawer. The system compares the count with the cash receipts they recorded; a manager reviews any difference.</small></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/cash?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="ct"></div>`);
  return tab === 'book' ? book($('#ct', root), q) : myClose($('#ct', root), q);
}
async function myClose(el, q) {
  const d = await api('/api/cash/my' + qs({ date: q.date }));
  const closedCur = c => d.closes.find(k => k.close_date === d.date && k.currency === c && k.status !== 'rejected');
  const open = d.currencies.filter(c => !closedCur(c.currency));
  mount(el, html`<form class="filters" id="df"><input type="hidden" name="tab" value="my"><label>Day<input type="date" name="date" value="${d.date}" max="${d.today}"></label><button class="btn primary">Show</button></form>
    <div class="grid g2"><div class="card"><h2>Cash you should hold — ${fmtDate(d.date)}</h2>
      ${d.currencies.length ? d.currencies.map(c => html`<div style="margin-bottom:1rem"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:1.4rem">${money(c.expected, c.currency)}</b><span class="muted">${c.receipts} receipt(s)${closedCur(c.currency) ? html` · ${badge(CS[closedCur(c.currency).status][0], CS[closedCur(c.currency).status][1])}` : ''}</span></div>
        <details><summary>Receipts</summary>${table([{ label: 'Time', render: i => fmtDT(i.at) }, { label: 'Receipt / card', render: i => html`<span class="mono">${i.ref}</span>` }, { label: 'From', render: i => i.who }, { label: 'Amount', cls: 'num', render: i => money(i.amount, c.currency) }], c.items)}</details></div>`)
        : html`<div class="empty">No cash recorded by you on this day.</div>`}
      ${d.reversed_excluded ? html`<p class="muted" style="font-size:.85rem">${d.reversed_excluded} reversed receipt(s) are not counted.</p>` : ''}</div>
    <div class="card"><h2>Count your drawer</h2>${open.length ? html`<form id="cf" class="form">${open.map(c => html`<label class="f"><span class="req">Counted ${c.currency}</span><input type="number" step="0.01" min="0" name="cnt_${c.currency}" data-exp="${c.expected}" data-cur="${c.currency}" required></label>`)}
        <div class="full" id="var"></div><label class="f full"><span>Note (required if there is a difference)</span><textarea name="note"></textarea></label>
        <div class="full"><button class="btn primary">Submit close</button></div></form><p class="muted" style="font-size:.85rem">After you submit, you cannot take more cash for this day in these currencies unless a manager reopens it.</p>`
      : html`<div class="empty">${d.currencies.length ? 'This day is closed.' : 'Nothing to close.'}</div>`}</div></div>
    <div class="card"><h2>My recent closes</h2>${table([{ label: 'Day', render: k => fmtDate(k.close_date) }, { label: 'Currency', key: 'currency' }, { label: 'Expected', cls: 'num', render: k => money(k.expected, k.currency) }, { label: 'Counted', cls: 'num', render: k => money(k.counted, k.currency) },
      { label: 'Difference', cls: 'num', render: k => html`<b class="${Math.abs(k.variance) > 0.004 ? 'crit-t' : ''}">${money(k.variance, k.currency)}</b>` }, { label: 'Status', render: k => html`${badge(CS[k.status][0], CS[k.status][1])}${k.review_note ? html`<br><small>${k.review_note}</small>` : ''}` }], d.closes, { empty: 'No closes yet.' })}</div>`);
  $('#df', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/cash' + qs(Object.fromEntries(new FormData(e.target))); });
  const f = $('#cf', el);
  if (f) {
    const upd = () => { $('#var', el).innerHTML = html`${$$('[data-cur]', f).filter(i => i.value !== '').map(i => { const v = Number(i.value) - Number(i.dataset.exp); return html`<div>${i.dataset.cur}: difference <b class="${Math.abs(v) > 0.004 ? 'crit-t' : ''}">${money(v, i.dataset.cur)}</b></div>`; })}`.s; };
    f.addEventListener('input', upd);
    f.addEventListener('submit', async e => { e.preventDefault(); const counts = $$('[data-cur]', f).map(i => ({ currency: i.dataset.cur, counted: Number(i.value) }));
      try { await api('/api/cash/close', { body: { date: d.date, counts, note: f.note.value || null } }); toast('Cash close submitted for review', 'ok'); myClose(el, q); } catch (err) { toast(err.message, 'err'); } });
  }
}
async function book(el, q) {
  const d = await api('/api/cash/book' + qs({ from: q.from, to: q.to }));
  mount(el, html`<form class="filters" id="bf"><input type="hidden" name="tab" value="book"><label>From<input type="date" name="from" value="${d.from}"></label><label>To<input type="date" name="to" value="${d.to}"></label><button class="btn primary">Show</button><button type="button" class="btn" data-act="csv">Export CSV</button></form>
    <div class="card flush">${table([{ label: 'Day', render: k => fmtDate(k.close_date) }, { label: 'Cashier', key: 'cashier' }, { label: 'Receipts', cls: 'num', key: 'receipts' }, { label: 'Expected', cls: 'num', render: k => money(k.expected, k.currency) },
      { label: 'Counted', cls: 'num', render: k => money(k.counted, k.currency) }, { label: 'Difference', cls: 'num', render: k => html`<b class="${Math.abs(k.variance) > 0.004 ? 'crit-t' : ''}">${money(k.variance, k.currency)}</b>` },
      { label: 'Note', render: k => k.note || '—' }, { label: 'Status', render: k => html`${badge(CS[k.status][0], CS[k.status][1])}${k.reviewer ? html`<br><small>${k.reviewer}${k.review_note ? ': ' + k.review_note : ''}</small>` : ''}` },
      { label: '', render: k => (k.status === 'submitted' && k.user_id !== state.user.id ? html`<button class="btn sm primary" data-act="ok" data-id="${k.id}">Approve</button> <button class="btn sm danger" data-act="no" data-id="${k.id}">Reject</button>` : '') }], d.closes, { empty: 'No closes in this period.' })}</div>
    ${d.missing.length ? html`<div class="card"><h2>Days not closed (${d.missing.length})</h2><p class="muted">Cash was taken but the cashier has not closed the day.</p>${table([{ label: 'Day', render: m => fmtDate(m.date) }, { label: 'Cashier', key: 'cashier' }, { label: 'Receipts', cls: 'num', key: 'receipts' }, { label: 'Should hold', cls: 'num', render: m => money(m.expected, m.currency) }], d.missing)}</div>` : ''}`);
  $('#bf', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/cash' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, { csv: () => download('/api/cash/book' + qs({ from: d.from, to: d.to, format: 'csv' })),
    ok: async b => { await api(`/api/cash/closes/${b.dataset.id}/review`, { body: { decision: 'approved' } }); toast('Approved', 'ok'); book(el, q); },
    no: async b => { const note = await confirmBox('Reject cash close', 'The cashier will recount and submit again. Their day reopens.', { reason: true, danger: true, ok: 'Reject' }); if (!note) return; await api(`/api/cash/closes/${b.dataset.id}/review`, { body: { decision: 'rejected', note } }); toast('Rejected — the cashier can recount', 'ok'); book(el, q); } });
}
