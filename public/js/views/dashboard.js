import { api, html, raw, mount, $, state, qs, money, fmtNum, fmtM3, fmtDate, label, stackedBars, hbars, table, daysAgo, today, can, download, toast, bind } from '../core.js';

export function filterBar(f, { showType = true } = {}) {
  const areas = (state.lookups && state.lookups.areas) || [];
  return html`<form class="filters no-print" id="flt">
    <label>From<input type="date" name="from" value="${f.from || ''}"></label>
    <label>To<input type="date" name="to" value="${f.to || ''}"></label>
    <label>Service area<select name="area_id"><option value="">All areas</option>${areas.map(a => html`<option value="${a.id}"${String(a.id) === String(f.area_id || '') ? raw(' selected') : ''}>${a.name}</option>`)}</select></label>
    ${showType ? html`<label>Customer type<select name="customer_type"><option value="">All types</option>${['household', 'business', 'institution', 'public_water_point', 'bulk'].map(t => html`<option value="${t}"${t === f.customer_type ? raw(' selected') : ''}>${label(t)}</option>`)}</select></label>` : ''}
    <button class="btn primary">Apply</button>
    <span class="muted" style="font-size:.78rem;align-self:center">Quick:</span>
    <button class="btn sm" type="button" data-range="30">30 d</button><button class="btn sm" type="button" data-range="90">90 d</button><button class="btn sm" type="button" data-range="182">6 mo</button><button class="btn sm" type="button" data-range="365">12 mo</button>
  </form>`;
}
export async function ensureLookups() { if (!state.lookups) state.lookups = await api('/api/lookups'); return state.lookups; }
function wireFilter(root, base) {
  const f = $('#flt', root);
  f.addEventListener('submit', e => { e.preventDefault(); const v = Object.fromEntries(new FormData(f)); location.hash = base + qs(v); });
  f.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { f.from.value = daysAgo(Number(b.dataset.range)); f.to.value = today(); f.requestSubmit(); }));
}

export async function view(root, _p, q) {
  await ensureLookups();
  const d = await api('/api/dashboard' + qs(q));
  const f = d.filters;
  const curs = [...new Set([...d.billing.billed.map(b => b.currency), ...d.billing.collected.map(c => c.currency), ...Object.keys(d.billing.outstanding)])].sort();
  const sev = Object.fromEntries(d.alerts.map(a => [a.severity, a.n]));
  const wo = Object.fromEntries(d.work_orders.map(w => [w.status, w.n]));
  const openWo = (wo.open || 0) + (wo.assigned || 0) + (wo.in_progress || 0) + (wo.on_hold || 0);
  const months = [...new Set(d.trend_area.map(t => t.month))].sort();
  const areaNames = state.lookups.areas.map(a => a.name).filter(n => d.trend_area.some(t => t.area === n));
  const areaColor = Object.fromEntries(state.lookups.areas.map((a, i) => [a.name, ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'][i % 8]]));
  const types = ['household', 'business', 'institution', 'public_water_point', 'bulk'];
  const typeColor = Object.fromEntries(types.map((t, i) => [t, ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s7)'][i]]));
  const estTotal = d.billing.billed.reduce((s, b) => s + (b.est_m3 || 0), 0);
  const simBills = d.billing.billed.reduce((s, b) => s + (b.sim_bills || 0), 0);
  mount(root, html`
    <div class="page-head"><div><h1>Operations dashboard</h1><small>${fmtDate(f.from)} – ${fmtDate(f.to)}${f.area_id ? ' · ' + (state.lookups.areas.find(a => a.id === f.area_id) || {}).name : ''}${f.customer_type ? ' · ' + label(f.customer_type) : ''}</small></div>
      <div class="actions">${can('alerts.run') ? html`<button class="btn" data-act="run">Run alert checks</button>` : ''}${can('reports.view') ? html`<a class="btn" href="#/reports${qs(q)}">Download reports</a>` : ''}</div></div>
    ${filterBar(f)}
    ${d.mode === 'demo' ? html`<div class="note sim">Figures are computed from fictional demo records. ${d.readings.simulated_in_period ? `${d.readings.simulated_in_period} readings in this period come from the demo simulator. ` : ''}${simBills ? `${simBills} bills are based on simulated readings.` : ''}</div>` : ''}
    <div class="grid g4">
      <div class="kpi"><div class="label">Customers (active / total)</div><div class="value">${d.customers.active} <small class="muted">/ ${d.customers.total}</small></div><div class="sub">Active connections with meter: ${d.customers.metered}</div></div>
      <div class="kpi"><div class="label">Meter coverage</div><div class="value">${d.customers.coverage_pct == null ? '—' : fmtNum(d.customers.coverage_pct, 1) + '%'}</div><div class="bar"><span style="width:${raw(d.customers.coverage_pct || 0)}%"></span></div><div class="sub">Active accounts with an active meter</div></div>
      <div class="kpi"><div class="label">Reading completion (last 30 days to ${fmtDate(d.readings.cycle_to)})</div><div class="value">${d.readings.completion_pct == null ? '—' : fmtNum(d.readings.completion_pct, 1) + '%'}</div><div class="bar"><span style="width:${raw(d.readings.completion_pct || 0)}%"></span></div><div class="sub">${d.readings.read} of ${d.readings.expected} metered accounts read</div></div>
      <div class="kpi"><div class="label">Readings awaiting review</div><div class="value"><a href="#/readings?status=pending">${d.readings.pending_review}</a></div><div class="sub">${d.readings.flagged_pending} flagged for attention</div></div>
    </div>
    <div class="grid g4" style="margin-top:1rem">
      ${curs.length ? curs.map(c => { const b = d.billing.billed.find(x => x.currency === c) || {}; const col = d.billing.collected.find(x => x.currency === c) || {}; return html`
      <div class="kpi"><div class="label">${c} — billed vs collected</div><div class="value">${money(b.amount || 0, c)}</div>
        <div class="sub">Collected ${money(col.amount || 0, c)}${col.efficiency_pct != null ? ` (${fmtNum(col.efficiency_pct, 1)}%)` : ''} · ${fmtM3(b.m3 || 0)} billed${b.est_m3 ? html` · <span class="badge warn">${fmtM3(b.est_m3)} estimated</span>` : ''}</div>
        <div class="sub">Outstanding balances: <b>${money(d.billing.outstanding[c] || 0, c)}</b></div></div>`; }) : html`<div class="kpi"><div class="label">Billing</div><div class="value">—</div><div class="sub">No bills in this period</div></div>`}
      <div class="kpi"><div class="label">Open alerts</div><div class="value"><a href="#/alerts?status=open_all">${d.alerts.reduce((s, a) => s + a.n, 0)}</a></div><div class="sub">${['critical', 'high', 'medium', 'low'].map(s => html`<span class="badge ${({ critical: 'crit', high: 'serious', medium: 'warn', low: 'info' })[s]}" style="margin-right:.2rem">${sev[s] || 0} ${s}</span>`)}</div></div>
      <div class="kpi"><div class="label">Open work orders</div><div class="value"><a href="#/work-orders?status=active">${openWo}</a></div><div class="sub">${wo.in_progress || 0} in progress · ${wo.completed || 0} completed</div></div>
    </div>
    ${d.billing.combined.note ? html`<div class="note">${d.billing.combined.note}${d.billing.combined.billed != null ? html` — combined billed ${money(d.billing.combined.billed, d.billing.combined.currency)}, collected ${money(d.billing.combined.collected, d.billing.combined.currency)}, outstanding ${money(d.billing.combined.outstanding, d.billing.combined.currency)}` : ''}</div>` : ''}
    <div class="grid g2" style="margin-top:1rem">
      <div class="card"><div class="card-head"><h2>Billed consumption by area (m³)</h2>${estTotal ? html`<span class="badge warn">includes ${fmtM3(estTotal)} estimated</span>` : ''}</div>
        ${stackedBars(months.map(m => ({ x: m, parts: Object.fromEntries(d.trend_area.filter(t => t.month === m).map(t => [t.area, t.m3])) })), areaNames, { unit: 'm³', colors: areaColor })}</div>
      <div class="card"><div class="card-head"><h2>Billed consumption by customer type (m³)</h2></div>
        ${stackedBars(months.map(m => ({ x: m, parts: Object.fromEntries(d.trend_type.filter(t => t.month === m).map(t => [t.type, t.m3])) })), types.filter(t => d.trend_type.some(x => x.type === t)), { unit: 'm³', colors: typeColor })}</div>
    </div>
    <div class="card"><div class="card-head"><h2>Bulk supply vs billed consumption (non-revenue water indicator)</h2><small>Only where bulk/district supply data exists</small></div>
      ${table([{ label: 'Area', key: 'area' }, { label: 'Supply period', render: r => r.supply_period || '—' }, { label: 'Bulk supply', cls: 'num', render: r => (r.supply_m3 == null ? '—' : fmtM3(r.supply_m3)) },
        { label: 'Billed', cls: 'num', render: r => html`${fmtM3(r.billed_m3)}${r.estimated_billed_m3 ? html`<br><small>${fmtM3(r.estimated_billed_m3)} est.</small>` : ''}` },
        { label: 'Difference', cls: 'num', render: r => (r.loss_m3 == null ? '—' : fmtM3(r.loss_m3)) },
        { label: 'Loss %', cls: 'num', render: r => (r.loss_pct == null ? '—' : html`<span class="badge ${r.loss_pct > 30 ? 'crit' : r.loss_pct > 20 ? 'warn' : 'good'}">${fmtNum(r.loss_pct, 1)}%</span>`) },
        { label: 'Supply data source', render: r => (r.supply_sources ? r.supply_sources.split(',').map(s => html`<span class="badge ${s.includes('estimate') ? 'warn' : s.includes('simulator') ? 'sim' : s === 'sensor' ? 'info' : 'outline'}">${label(s)}</span> `) : '—') },
        { label: 'Note', render: r => (r.note ? html`<small>${r.note}</small>` : '') }], d.nrw)}</div>
    <div class="grid g2">
      <div class="card"><h2>Outstanding by age (bill due date)</h2>${Object.keys(d.billing.aging).length ? Object.entries(d.billing.aging).map(([c, a]) => html`<h3>${c}</h3>${hbars(Object.entries(a).map(([k, v]) => ({ label: k === 'current' ? 'Not yet due' : k + ' days overdue', value: v, color: k === 'current' ? 'var(--s1)' : k === '1-30' ? 'var(--s4)' : 'var(--s8)' })), { fmt: v => money(v, c) })}`) : html`<div class="empty">No outstanding bills.</div>`}</div>
      <div class="card"><h2>Customers & reading methods</h2>
        ${hbars(d.customers.by_type.map(t => ({ label: label(t.type), value: t.n })), { unit: 'accounts' })}
        <h3 style="margin-top:1rem">Active meters by reading method</h3>
        ${hbars(d.meter_methods.map(m => ({ label: label(m.comm_method) + (m.comm_method === 'simulator' ? ' (demo only)' : ''), value: m.n, color: m.comm_method === 'simulator' ? 'var(--s7)' : 'var(--s1)' })), { unit: 'meters' })}</div>
    </div>`);
  wireFilter(root, '#/dashboard');
  bind(root, { run: async () => { const r = await api('/api/alerts/run', { body: {} }); toast(`Alert checks complete: ${r.total} new alert(s)`, 'ok'); view(root, _p, q); } });
}

export async function reports(root, _p, q) {
  await ensureLookups();
  const list = await api('/api/reports');
  const f = { from: q.from || daysAgo(182), to: q.to || today(), area_id: q.area_id || '', customer_type: q.customer_type || '' };
  mount(root, html`<div class="page-head"><h1>Reports</h1></div>${filterBar(f)}
    <div class="card"><p class="muted">Each report downloads as a CSV file (opens in Excel, LibreOffice or Google Sheets). Estimated and simulated values are labelled in their own columns${state.mode === 'demo' ? '; demo files are marked DEMO' : ''}. Amounts stay in their own currency.</p>
    ${table([{ label: 'Report', key: 'title' }, { label: '', cls: 'num', render: r => html`<a class="btn sm primary" href="/api/reports/${r.key}${qs(f)}">Download CSV</a>` }], list)}</div>`);
  wireFilter(root, '#/reports');
}
