// Service delivery: supply timetables & reliability, stores, meter replacement planner, customer feedback.
import { api, html, raw, mount, $, $$, state, qs, can, canAny, money, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, confirmBox, today, download, currencies } from '../core.js';
import { ensureLookups } from './dashboard.js';
import { weekdays } from '../i18n.js';

const DAYS = new Proxy([], { get: (_, k) => (k === 'map' ? (...a) => weekdays().map(...a) : weekdays()[k]) });
const daysText = d => (d === '0123456' ? 'Every day' : d.split('').map(x => DAYS[x]).join(', '));
const dayName = d => DAYS[new Date(d + 'T00:00:00Z').getUTCDay()];
const OUT = { delivered: ['paid', 'Delivered'], partial: ['pending', 'Short'], missed: ['overdue', 'Missed'], extra: ['issued', 'Extra (unscheduled)'] };

// ======================= Supply timetables =======================
export async function supply(root, _p, q) {
  const tab = q.tab || 'timetable';
  mount(root, html`<div class="page-head"><div><h1>Supply timetable</h1><small>When water flows to each zone. Customers get an SMS before their water comes on (and can text SUPPLY any time); operators record the hours actually delivered.</small></div>
    <div class="actions">${can('supply.manage') ? html`<button class="btn primary" data-act="new">+ Schedule</button> <button class="btn" data-act="heads">Send due heads-up SMS now</button>` : ''}</div></div>
    <div class="tabs">${[['timetable', 'Timetable & next 7 days'], ['log', 'Delivery log & reliability']].map(([k, l]) => html`<a href="#/supply?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="st"></div>`);
  const L = await ensureLookups();
  bind(root, { new: () => schedForm(L, null, () => supply(root, _p, q)),
    heads: async () => { const r = await api('/api/supply/heads-up', { body: {} }); toast(r.disabled ? 'Supply SMS are switched off in Settings' : r.windows ? `${r.windows} window(s) announced to ${r.recipients} customer(s)` : 'No window starts within the notice period — nothing to send', r.windows ? 'ok' : ''); } });
  return tab === 'log' ? supplyLog($('#st', root), L, q) : timetable($('#st', root), L, q);
}

function schedForm(L, s, done) {
  modal(s ? 'Edit supply schedule' : 'New supply schedule', html`<div class="form">${formFields([{ name: 'area_id', label: 'Area', type: 'select', required: true, options: L.areas.filter(a => a.active).map(a => [a.id, a.name]) },
    { name: 'zone', label: 'Zone (leave blank for the whole area)', placeholder: 'e.g. Zone A — upper town' }, { name: 'start_time', label: 'Water on at', type: 'time', required: true, default: '06:00' }, { name: 'end_time', label: 'Water off at', type: 'time', required: true, default: '10:00' },
    { name: 'days', label: 'Days', type: 'checks', full: true, options: DAYS.map((d, i) => [String(i), d]), default: s ? s.days.split('') : ['0', '1', '2', '3', '4', '5', '6'] },
    { name: 'active', label: 'In use', type: 'checkbox', default: s ? !!s.active : true }, { name: 'notes', label: 'Notes (source, pump, generator)', full: true }], s || {})}
    <div class="full note">Times are local (Liberia: GMT). For supply that runs past midnight, make two schedules. Customers are matched to a zone on their account.</div></div>`,
  { onSubmit: async v => { const body = { ...v, days: (v.days || []).join('') }; await api('/api/supply/schedules' + (s ? '/' + s.id : ''), { method: s ? 'PUT' : 'POST', body }); toast('Timetable saved', 'ok'); done(); } });
}

async function timetable(el, L) {
  const [rows, up] = await Promise.all([api('/api/supply/schedules'), api('/api/supply/upcoming?days=7')]);
  const byDay = {}; for (const w of up) (byDay[w.date] = byDay[w.date] || []).push(w);
  mount(el, html`<div class="card flush">${table([{ label: 'Area', key: 'area_name' }, { label: 'Zone', render: s => s.zone || html`<span class="muted">whole area</span>` }, { label: 'Days', render: s => daysText(s.days) },
    { label: 'Water on', render: s => html`<b>${s.start_time}–${s.end_time}</b> <small class="muted">${fmtNum(s.hours, 1)} h</small>` }, { label: 'Customers', cls: 'num', render: s => html`${s.customers}<br><small class="muted">${s.sms_customers} get SMS</small>` },
    { label: 'Status', render: s => badge(s.active ? 'active' : 'disabled') }, { label: '', render: s => (can('supply.manage') ? html`<button class="btn sm" data-act="edit" data-id="${s.id}">Edit</button>` : '') }], rows,
    { empty: 'No timetable yet. If water does not flow all day, add a schedule for each area or zone so customers know when to fill their containers.' })}</div>
    <h2 style="margin-top:1.2rem">Next 7 days</h2>
    <div class="grid g4">${Object.entries(byDay).map(([d, ws]) => html`<div class="card"><h3 style="margin-top:0">${dayName(d)} ${fmtDate(d)}</h3>${ws.map(w => html`<div style="margin:.3rem 0">
      <b>${w.start_time}–${w.end_time}</b> ${w.flowing ? badge('active', 'flowing now') : ''}${w.cancelled ? html` ${badge('overdue', 'cancelled')}` : ''}<br><small>${w.area_name}${w.zone ? ' · ' + w.zone : ''}</small>${w.cancelled ? html`<br><small class="crit-t">${w.cancelled}</small>` : ''}</div>`)}</div>`)}</div>
    ${!up.length ? html`<div class="empty">No scheduled supply in the next 7 days.</div>` : ''}
    <p class="muted" style="font-size:.85rem">An outage or maintenance notice for the area cancels its windows: customers are told by SMS instead, and the status page shows it.</p>`);
  bind(el, { edit: b => schedForm(L, rows.find(s => s.id === Number(b.dataset.id)), () => timetable(el, L)) });
}

async function supplyLog(el, L, q) {
  const d = await api('/api/supply/log' + qs({ from: q.from, to: q.to, area_id: q.area_id }));
  const canLog = can('supply.log');
  mount(el, html`<div class="grid g3" style="margin-bottom:1rem">${d.reliability.filter(a => a.logged).map(a => html`<div class="kpi"><div class="label">${a.area}</div>
      <div class="value ${a.reliability_pct < 90 ? 'crit-t' : ''}">${fmtNum(a.reliability_pct, 1)}%</div><div class="sub">of planned hours delivered · ${fmtNum(a.hours_per_day, 1)} h/day per zone · ${a.missed} missed, ${a.partial} short</div>
      ${a.reasons.length ? html`<div class="sub">Main causes: ${a.reasons.map(r => `${r.reason} (${r.n})`).join(', ')}</div>` : ''}</div>`)}</div>
    ${canLog && d.unlogged.length ? html`<div class="card"><h2>To record (${d.unlogged.length})</h2><p class="muted">Scheduled windows in the last 7 days with no record yet. How many hours did water actually flow?</p>
      ${table([{ label: 'Day', render: w => `${dayName(w.date)} ${fmtDate(w.date)}` }, { label: 'Where', render: w => `${w.area_name}${w.zone ? ' · ' + w.zone : ''}` }, { label: 'Planned', render: w => `${w.start_time}–${w.end_time} (${w.hours} h)` },
        { label: 'Delivered (h)', render: w => html`<input type="number" step="0.5" min="0" max="24" value="${w.hours}" style="width:5.5rem" data-h="${w.schedule_id}|${w.date}">` },
        { label: 'Reason if short', render: w => html`<input style="width:14rem" placeholder="fuel, pump fault…" data-r="${w.schedule_id}|${w.date}">` }, { label: '', render: w => html`<button class="btn sm primary" data-act="save" data-k="${w.schedule_id}|${w.date}">Save</button>` }], d.unlogged.slice(0, 40))}</div>` : ''}
    <form class="filters" id="lf"><input type="hidden" name="tab" value="log"><label>From<input type="date" name="from" value="${d.from}"></label><label>To<input type="date" name="to" value="${d.to}"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Show</button>
      ${canLog ? html`<button type="button" class="btn" data-act="extra">+ Unscheduled supply</button>` : ''}</form>
    <div class="card flush">${table([{ label: 'Day', render: l => `${dayName(l.supply_date)} ${fmtDate(l.supply_date)}` }, { label: 'Where', render: l => `${l.area_name}${l.zone ? ' · ' + l.zone : ''}` },
      { label: 'Planned', cls: 'num', render: l => (l.schedule_id ? `${fmtNum(l.planned_hours, 1)} h` : '—') }, { label: 'Delivered', cls: 'num', render: l => `${fmtNum(l.delivered_hours, 1)} h` },
      { label: 'Outcome', render: l => badge(OUT[l.outcome][0], OUT[l.outcome][1]) }, { label: 'Reason', render: l => l.reason || '—' }, { label: 'By', render: l => l.entered_by_name || '—' }], d.rows, { empty: 'Nothing recorded in this period.' })}</div>`);
  $('#lf', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/supply' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, {
    save: async b => { const k = b.dataset.k; const [sid, date] = k.split('|'); const h = $(`[data-h="${k}"]`, el).value, reason = $(`[data-r="${k}"]`, el).value.trim();
      const r = await api('/api/supply/log', { body: { schedule_id: Number(sid), supply_date: date, delivered_hours: Number(h), reason: reason || null } }); toast(`Recorded: ${OUT[r.outcome][1]}`, 'ok'); supplyLog(el, L, q); },
    extra: () => modal('Unscheduled supply', html`<div class="form">${formFields([{ name: 'area_id', label: 'Area', type: 'select', required: true, options: L.areas.map(a => [a.id, a.name]) }, { name: 'zone', label: 'Zone' }, { name: 'supply_date', label: 'Date', type: 'date', required: true, default: today() },
      { name: 'delivered_hours', label: 'Hours', type: 'number', step: '0.5', min: 0, max: 24, required: true }, { name: 'reason', label: 'Note', full: true }])}</div>`, { onSubmit: async v => { await api('/api/supply/log', { body: v }); toast('Recorded', 'ok'); supplyLog(el, L, q); } })
  });
}

// ======================= Stores =======================
const CAT = { pipe: 'Pipe', fitting: 'Fittings', meter_part: 'Meter parts', chemical: 'Chemicals', tool: 'Tools', other: 'Other' };
export async function stores(root, _p, q) {
  const d = await api('/api/stock/items' + qs({ all: q.all }));
  const M = can('stock.manage');
  const low = d.items.filter(i => i.low);
  const val = {}; for (const i of d.items) if (i.value != null && i.currency) val[i.currency] = (val[i.currency] || 0) + i.value;
  mount(root, html`<div class="page-head"><div><h1>Stores</h1><small>Pipe, fittings, meter parts and chlorine. Every receipt, issue to a job, return and adjustment is recorded and cannot be edited — stock on hand is always the sum of movements.</small></div>
    <div class="actions">${M ? html`<button class="btn primary" data-act="new">+ Item</button>` : ''}<a class="btn" href="#/stores${q.all ? '' : '?all=1'}">${q.all ? 'Hide' : 'Show'} inactive</a></div></div>
    <div class="grid g3" style="margin-bottom:1rem"><div class="kpi"><div class="label">Items</div><div class="value">${d.items.length}</div></div>
      <div class="kpi"><div class="label">At or below reorder level</div><div class="value ${low.length ? 'crit-t' : ''}">${low.length}</div><div class="sub">${low.slice(0, 3).map(i => i.name).join(', ')}</div></div>
      <div class="kpi"><div class="label">Stock value</div><div class="value">${Object.entries(val).map(([c, v]) => money(v, c)).join(' + ') || '—'}</div></div></div>
    <div class="card flush">${table([{ label: 'Item', render: i => html`<b>${i.name}</b><br><small class="mono">${i.code}</small> <small class="muted">${CAT[i.category]}${i.location ? ' · ' + i.location : ''}</small>` },
      { label: 'On hand', cls: 'num', render: i => html`<b class="${i.low ? 'crit-t' : ''}">${fmtNum(i.on_hand, i.on_hand % 1 ? 1 : 0)}</b> ${i.unit}${i.low ? html`<br>${badge(i.out ? 'overdue' : 'pending', i.out ? 'out of stock' : 'reorder')}` : ''}` },
      { label: 'Reorder at', cls: 'num', render: i => (i.reorder_level ? `${fmtNum(i.reorder_level, 0)} ${i.unit}` : '—') }, { label: 'Used (90 d)', cls: 'num', render: i => (i.used_90d ? `${fmtNum(i.used_90d, i.used_90d % 1 ? 1 : 0)} ${i.unit}` : '—') },
      { label: 'Lasts', cls: 'num', render: i => (i.weeks_left == null ? '—' : i.weeks_left > 52 ? '> 1 year' : `${i.weeks_left} weeks`) }, { label: 'Unit cost', cls: 'num', render: i => (i.unit_cost != null ? money(i.unit_cost, i.currency) : '—') },
      { label: '', render: i => html`${M ? html`<button class="btn sm primary" data-act="receive" data-id="${i.id}">Receive</button> ` : ''}${can('stock.issue') ? html`<button class="btn sm" data-act="use" data-id="${i.id}">Use</button> ` : ''}${M ? html`<button class="btn sm" data-act="adjust" data-id="${i.id}">Adjust</button> <button class="btn sm" data-act="edit" data-id="${i.id}">Edit</button> ` : ''}<button class="btn sm" data-act="hist" data-id="${i.id}">History</button>` }],
      d.items, { empty: 'No store items yet.' })}</div>
    <div class="card"><h2>Water meters in stock</h2>${table([{ label: 'Make / model', render: m => `${m.manufacturer} ${m.model}` }, { label: 'Size', render: m => `${m.size_mm} mm` }, { label: 'In stock', cls: 'num', key: 'n' }], d.meters_in_stock, { empty: 'No meters in stock — new connections and replacements will be held up.' })}
      <p class="muted" style="font-size:.85rem">Meters are tracked one by one in the meter register. Issue pipe and fittings to a job from the work order page.</p></div>`);
  const item = b => d.items.find(i => i.id === Number(b.dataset.id));
  const reload = () => stores(root, _p, q);
  const itemForm = it => modal(it ? 'Edit item' : 'New store item', html`<div class="form">${formFields([{ name: 'code', label: 'Code', required: !it, readonly: !!it }, { name: 'name', label: 'Name', required: true },
    { name: 'category', label: 'Category', type: 'select', required: true, options: Object.entries(CAT) }, { name: 'unit', label: 'Unit (m, pcs, kg…)', required: true }, { name: 'reorder_level', label: 'Reorder when at or below', type: 'number', step: 'any', min: 0 },
    { name: 'unit_cost', label: 'Unit cost', type: 'number', step: 'any', min: 0 }, { name: 'currency', label: 'Currency', type: 'select', options: currencies() }, { name: 'location', label: 'Store location' }, ...(it ? [{ name: 'active', label: 'Active', type: 'checkbox' }] : [])], it || { currency: 'USD' })}</div>`,
  { onSubmit: async v => { await api('/api/stock/items' + (it ? '/' + it.id : ''), { method: it ? 'PUT' : 'POST', body: v }); toast('Saved', 'ok'); reload(); } });
  const mv = (it, kind, fields, title) => modal(`${title} — ${it.name}`, html`<p class="muted">On hand: ${it.on_hand} ${it.unit}</p><div class="form">${formFields(fields)}</div>`, { onSubmit: async v => { const r = await api('/api/stock/move', { body: { ...v, kind, item_id: it.id } }); toast(`Done — ${r.on_hand} ${it.unit} on hand${r.low ? ' (reorder!)' : ''}`, r.low ? '' : 'ok'); reload(); } });
  bind(root, {
    new: () => itemForm(null), edit: b => itemForm(item(b)),
    receive: b => mv(item(b), 'receive', [{ name: 'qty', label: `Quantity (${item(b).unit})`, type: 'number', step: 'any', min: 0, required: true }, { name: 'unit_cost', label: 'Unit cost (updates the item)', type: 'number', step: 'any', min: 0, default: item(b).unit_cost }, { name: 'reference', label: 'Delivery note / invoice no.' }, { name: 'notes', label: 'Supplier / notes', full: true }], 'Receive stock'),
    use: b => mv(item(b), 'use', [{ name: 'qty', label: `Quantity (${item(b).unit})`, type: 'number', step: 'any', min: 0, required: true }, { name: 'notes', label: 'Used for (e.g. chlorination of Hilltop tank)', required: true, full: true }], 'Routine use'),
    adjust: b => mv(item(b), 'adjust', [{ name: 'qty', label: 'Change (+ found / − missing or damaged)', type: 'number', step: 'any', required: true }, { name: 'notes', label: 'Reason (stock count, damage, loss…)', required: true, full: true }], 'Adjust stock'),
    hist: async b => { const it = item(b); const rows = await api('/api/stock/movements?item_id=' + it.id);
      modal(`Movements — ${it.name}`, table([{ label: 'When', render: m => fmtDT(m.created_at.replace(' ', 'T') + 'Z') }, { label: 'Type', render: m => label(m.kind) }, { label: 'Qty', cls: 'num', render: m => html`<b class="${m.qty < 0 ? 'crit-t' : ''}">${m.qty > 0 ? '+' : ''}${m.qty}</b>` },
        { label: 'Job / ref', render: m => (m.wo_number ? html`<a href="#/work-orders/${m.work_order_id}">${m.wo_number}</a>` : m.reference || '—') }, { label: 'Notes', render: m => m.notes || '—' }, { label: 'By', render: m => m.user_name || '—' }], rows), { wide: true }); }
  });
}

/** Work-order card: materials issued/returned and their cost. */
export async function materialsPanel(el, w, reload) {
  const [m, st] = await Promise.all([api(`/api/work-orders/${w.id}/materials`), can('stock.issue') ? api('/api/stock/items') : Promise.resolve({ items: [] })]);
  const open = !['completed', 'cancelled'].includes(w.status) || can('stock.manage');
  mount(el, html`<h2>Materials used</h2>${table([{ label: 'Item', render: r => html`${r.name} <small class="mono muted">${r.code}</small>` }, { label: 'Qty', cls: 'num', render: r => `${r.qty} ${r.unit}` }, { label: 'Cost', cls: 'num', render: r => (r.currency ? money(r.cost, r.currency) : '—') },
    { label: '', render: r => (open && can('stock.issue') ? html`<button class="btn sm" data-act="ret" data-id="${r.item_id}">Return unused</button>` : '') }], m.rows, { empty: 'No materials recorded for this job.' })}
    ${Object.keys(m.totals).length ? html`<p>Total materials cost: <b>${Object.entries(m.totals).map(([c, v]) => money(v, c)).join(' + ')}</b></p>` : ''}
    ${open && can('stock.issue') ? html`<button class="btn primary" data-act="issue">Take from stores</button>` : ''}`);
  bind(el, {
    issue: () => modal('Take materials from stores', html`<div class="form">${formFields([{ name: 'item_id', label: 'Item', type: 'select', required: true, options: st.items.filter(i => i.on_hand > 0).map(i => [i.id, `${i.name} — ${i.on_hand} ${i.unit} in stock`]) }, { name: 'qty', label: 'Quantity', type: 'number', step: 'any', min: 0, required: true }])}</div>`,
      { onSubmit: async v => { const r = await api('/api/stock/move', { body: { ...v, kind: 'issue', work_order_id: w.id } }); toast(`Issued${r.low ? ' — this item is now at reorder level' : ''}`, 'ok'); reload(); } }),
    ret: b => { const r0 = m.rows.find(x => x.item_id === Number(b.dataset.id));
      modal(`Return unused — ${r0.name}`, html`<div class="form">${formFields([{ name: 'qty', label: `Quantity (up to ${r0.qty} ${r0.unit})`, type: 'number', step: 'any', min: 0, max: r0.qty, required: true }])}</div>`, { onSubmit: async v => { await api('/api/stock/move', { body: { ...v, kind: 'return', item_id: r0.item_id, work_order_id: w.id } }); toast('Returned to stores', 'ok'); reload(); } }); }
  });
}

// ======================= Meter replacement planner =======================
const PRI = { replace_now: ['overdue', 'Replace now'], replace: ['high', 'Replace'], test: ['pending', 'Test / watch'], ok: ['good', 'OK'] };
export async function meterPlanner(root, _p, q) {
  const L = await ensureLookups();
  const d = await api('/api/meter-fleet' + qs({ area_id: q.area_id }));
  const show = q.show === 'all' ? d.rows : d.rows.filter(r => r.priority !== 'ok');
  const s = d.summary;
  mount(root, html`<div class="page-head"><div><h1>Meter replacement planner</h1><small>Old and worn mechanical meters read low, so water is delivered but never billed. This ranks meters by how quickly a replacement pays for itself in recovered revenue.</small></div>
    <div class="actions"><button class="btn" data-act="csv">Export CSV</button></div></div>
    <div class="note warn"><b>Estimates.</b> Under-registration is modelled from age (${d.settings.wear}% per year after ${d.settings.start} years, less for ultrasonic/electromagnetic meters) and lifetime volume (>${d.settings.lifeVol} m³), capped at ${d.settings.maxUR}%. Test a sample of meters on a bench and adjust these rates in Settings. ${d.cost_note || ''}</div>
    <div class="grid g4" style="margin-bottom:1rem"><div class="kpi"><div class="label">Meters installed</div><div class="value">${s.meters}</div><div class="sub">average age ${s.avg_age == null ? '—' : fmtNum(s.avg_age, 1) + ' years'}${s.unknown_age ? ` · ${s.unknown_age} with unknown install date` : ''}</div></div>
      <div class="kpi"><div class="label">Replace now / replace</div><div class="value">${s.replace_now} / ${s.replace}</div></div><div class="kpi"><div class="label">Test or watch</div><div class="value">${s.test}</div></div>
      <div class="kpi"><div class="label">Est. revenue lost per year</div><div class="value" style="font-size:1.2rem">${Object.entries(s.lost_revenue_year).map(([c, v]) => money(v, c)).join(' + ') || '—'}</div></div></div>
    <form class="filters" id="pf"><label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label>
      <label>Show<select name="show"><option value="">Needs action</option><option value="all"${q.show === 'all' ? raw(' selected') : ''}>All meters</option></select></label><button class="btn primary">Show</button></form>
    <div class="card flush">${table([{ label: 'Priority', render: r => badge(PRI[r.priority][0], PRI[r.priority][1]) }, { label: 'Meter', render: r => html`<a href="#/meters/${r.meter_id}" class="mono">${r.serial_number}</a><br><small>${label(r.meter_type)} ${r.size_mm} mm</small>` },
      { label: 'Customer', render: r => html`<a href="#/customers/${r.customer_id}">${r.customer_name}</a><br><small class="muted">${r.area}</small>` }, { label: 'Age', cls: 'num', render: r => (r.age_years == null ? '?' : `${fmtNum(r.age_years, 1)} y`) },
      { label: 'Register', cls: 'num', render: r => `${fmtNum(r.throughput_m3, 0)} m³` }, { label: 'Est. under-reading', cls: 'num', render: r => `${fmtNum(r.under_registration_pct, 1)}%` },
      { label: 'Est. lost / year', cls: 'num', render: r => (r.lost_revenue_year ? html`${money(r.lost_revenue_year, r.currency)}<br><small class="muted">${fmtNum(r.lost_m3_year, 0)} m³</small>` : '—') },
      { label: 'Payback', cls: 'num', render: r => (r.payback_months == null ? '—' : r.payback_months > 120 ? '> 10 years' : `${fmtNum(r.payback_months, 0)} months`) },
      { label: 'Why', render: r => html`<small>${r.reasons.join(' · ') || '—'}</small>` },
      { label: '', render: r => (r.open_wo ? html`<a href="#/work-orders/${r.open_wo}" class="badge info">job open</a>` : r.priority !== 'ok' && can('workorders.manage') ? html`<button class="btn sm primary" data-act="plan" data-id="${r.meter_id}">Plan replacement</button>` : '') }],
      show, { empty: 'No meters need action.' })}</div>`);
  $('#pf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/meter-planner' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(root, { csv: () => download('/api/meter-fleet' + qs({ area_id: q.area_id, format: 'csv' })),
    plan: async b => { const r = await api(`/api/meter-fleet/${b.dataset.id}/plan`, { body: {} }); toast(`Work order ${r.wo_number} created`, 'ok'); meterPlanner(root, _p, q); } });
}

// ======================= Customer feedback =======================
export async function feedbackView(root, _p, q) {
  const L = await ensureLookups();
  const d = await api('/api/feedback' + qs({ from: q.from, to: q.to, area_id: q.area_id }));
  const max = Math.max(1, ...d.distribution.map(x => x.n));
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  mount(root, html`<div class="page-head"><div><h1>Customer feedback</h1><small>After a repair or a resolved report, people are asked by SMS to rate the job 1–5. Ratings of 1–2 create a follow-up alert so a manager calls back.</small></div></div>
    <form class="filters" id="ff"><label>From<input type="date" name="from" value="${d.from}"></label><label>To<input type="date" name="to" value="${d.to}"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Show</button></form>
    <div class="grid g4" style="margin-bottom:1rem"><div class="kpi"><div class="label">Average rating</div><div class="value">${d.avg == null ? '—' : fmtNum(d.avg, 2) + ' / 5'}</div></div><div class="kpi"><div class="label">Asked</div><div class="value">${d.sent}</div></div>
      <div class="kpi"><div class="label">Answered</div><div class="value">${d.answered}</div><div class="sub">${d.response_pct == null ? '' : d.response_pct + '% response'}</div></div>
      <div class="kpi"><div class="label">Ratings</div>${d.distribution.slice().reverse().map(x => html`<div style="display:flex;gap:.4rem;align-items:center;font-size:.8rem"><span style="width:3.2rem">${x.score} ★</span><div class="bar" style="flex:1"><span style="width:${raw(Math.round(x.n / max * 100))}%"></span></div><span>${x.n}</span></div>`)}</div></div>
    <div class="grid g2"><div class="card"><h2>By area</h2>${table([{ label: 'Area', key: 'area' }, { label: 'Ratings', cls: 'num', key: 'n' }, { label: 'Average', cls: 'num', render: x => fmtNum(x.avg, 2) }], d.by_area, { empty: 'No ratings yet.' })}</div>
      <div class="card"><h2>By technician</h2>${table([{ label: 'Technician', key: 'technician' }, { label: 'Ratings', cls: 'num', key: 'n' }, { label: 'Average', cls: 'num', render: x => fmtNum(x.avg, 2) }], d.by_technician, { empty: 'No ratings yet.' })}
        <p class="muted" style="font-size:.8rem">Use for coaching and recognition, not as the only measure: a few ratings say little.</p></div></div>
    <div class="card"><h2>Responses (lowest first)</h2>${table([{ label: 'Rating', render: x => (x.score ? html`<span style="color:${raw(x.score <= 2 ? 'var(--crit)' : 'var(--warn)')};letter-spacing:.05em">${stars(x.score)}</span>` : html`<span class="muted">no reply yet</span>`) },
      { label: 'Comment', render: x => x.comment || '—' }, { label: 'Job', render: x => (x.wo_number ? html`<a href="#/work-orders/${x.work_order_id}">${x.wo_number}</a>` : 'community report') },
      { label: 'Customer', render: x => (x.customer_id ? html`<a href="#/customers/${x.customer_id}">${x.customer_name}</a>` : html`<span class="muted">public</span>`) }, { label: 'Technician', render: x => x.technician || '—' }, { label: 'Area', render: x => x.area || '—' },
      { label: 'Asked', render: x => fmtDate(x.sent_at.slice(0, 10)) }], d.recent, { empty: 'No feedback requests in this period.' })}</div>`);
  $('#ff', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/feedback' + qs(Object.fromEntries(new FormData(e.target))); });
}
