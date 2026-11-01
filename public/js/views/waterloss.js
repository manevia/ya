// Water-loss intelligence: IWA-style water balance per area, revenue-protection list, and public/donor share links.
import { api, html, raw, mount, $, state, qs, can, money, fmtM3, fmtNum, fmtDT, fmtDate, label, badge, table, modal, formFields, toast, bind, confirmBox, daysAgo, today } from '../core.js';
import { ensureLookups, filterBar } from './dashboard.js';
import { newWorkOrder } from './ops.js';

const SEG = [['billed_metered_m3', 'Billed metered', 'var(--s1)'], ['billed_estimated_m3', 'Billed estimated', 'var(--s4)'], ['unbilled_authorized_m3', 'Unbilled authorised (assumed)', 'var(--s3)'],
  ['apparent_losses_m3', 'Apparent losses (estimated)', 'var(--s7)'], ['real_losses_m3', 'Real losses — leaks & bursts', 'var(--s8)']];

function balanceBar(r) {
  const tot = r.system_input_m3 || 1;
  return html`<div style="display:flex;height:22px;border-radius:4px;overflow:hidden;gap:2px;background:#fff">${SEG.map(([k, l, c]) => (r[k] > 0 ? html`<div style="flex:${raw(String(r[k] / tot))};background:${raw(c)}" title="${l}: ${fmtM3(r[k])} (${fmtNum(r[k] / tot * 100, 1)}%)"></div>` : ''))}</div>`;
}

export async function view(root, _p, q) {
  await ensureLookups();
  const f = { from: q.from || daysAgo(182), to: q.to || today(), area_id: q.area_id || '' };
  const [wb, sus, links] = await Promise.all([api('/api/nrw/balance' + qs(f)), api('/api/nrw/suspicious' + qs({ area_id: f.area_id })), can('share.manage') ? api('/api/share-links') : Promise.resolve(null)]);
  const ok = wb.areas.filter(a => a.status === 'ok');
  const tot = k => ok.reduce((s, a) => s + (a[k] || 0), 0);
  const siv = tot('system_input_m3'), nrw = tot('nrw_m3'), real = tot('real_losses_m3');
  const a0 = ok[0] && ok[0].assumptions;
  mount(root, html`<div class="page-head"><div><h1>Water-loss intelligence</h1><small>Where water is lost, how much it costs, and which accounts to inspect first.</small></div>
    <div class="actions">${can('share.manage') ? html`<button class="btn primary" data-act="share">Create public / donor link</button>` : ''}</div></div>
    ${filterBar(f, { showType: false })}
    <div class="grid g4">
      <div class="kpi"><div class="label">System input (bulk supply)</div><div class="value">${ok.length ? fmtM3(siv) : '—'}</div><div class="sub">${ok.length} of ${wb.areas.length} areas have supply data</div></div>
      <div class="kpi"><div class="label">Non-revenue water</div><div class="value">${siv ? fmtNum(nrw / siv * 100, 1) + '%' : '—'}</div><div class="sub">${fmtM3(nrw)} not billed</div></div>
      <div class="kpi"><div class="label">Real losses (leaks, bursts, overflows)</div><div class="value">${fmtM3(real)}</div><div class="sub">after subtracting estimated apparent losses</div></div>
      <div class="kpi"><div class="label">Value of non-revenue water</div><div class="value" style="font-size:1.25rem">${Object.entries(ok.filter(a => a.nrw_value != null).reduce((m, a) => { m[a.currency] = (m[a.currency] || 0) + a.nrw_value; return m; }, {})).map(([c, v]) => html`${money(v, c)}<br>`)}</div><div class="sub">revenue not collected for this period, at each area's average billed price per m³ (${ok.filter(a => a.nrw_value != null).map(a => `${a.area.replace(/ \(Demo\)/, '')} ${money(a.nrw_value, a.currency)}`).join(' · ')})</div></div></div>
    <div class="card" style="margin-top:1rem"><div class="card-head"><h2>Water balance by area (worst first)</h2><small>IWA standard structure</small></div>
      <div class="legend" style="margin-bottom:.6rem">${SEG.map(([, l, c]) => html`<span><i style="background:${raw(c)}"></i>${l}</span>`)}</div>
      ${wb.areas.map(a => html`<div style="border-top:1px solid #eef0f3;padding:.7rem 0">
        <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:baseline"><b>${a.area}</b>${a.status === 'ok' ? html`<span>NRW <b>${fmtNum(a.nrw_pct, 1)}%</b> · real losses <b>${a.real_losses_l_per_conn_day == null ? '—' : fmtNum(a.real_losses_l_per_conn_day, 0)}</b> L/connection/day · data grade <span class="badge ${a.grade === 'A' ? 'good' : a.grade === 'B' ? 'warn' : 'crit'}">${a.grade}</span></span>` : html`<span class="badge outline">no supply data</span>`}</div>
        ${a.status === 'ok' ? html`<div style="margin:.4rem 0">${balanceBar(a)}</div>
          <small class="muted">${fmtDate(a.from)} – ${fmtDate(a.to)} · input ${fmtM3(a.system_input_m3)} · billed ${fmtM3(a.billed_metered_m3 + a.billed_estimated_m3)} · ${a.connections} connections · grade: ${a.grade_reasons.join('; ')}</small>`
          : html`<small class="muted">${a.note}</small>`}</div>`)}
      ${a0 ? html`<div class="note" style="margin-top:.6rem">Assumptions (change in Administration › Settings): unbilled authorised use ${a0.unbilled_authorized_pct}% of input · meter under-registration ${a0.meter_under_registration_pct}% of metered use · unauthorised use ${a0.unauthorized_consumption_pct}% of input. Apparent and real losses are therefore <b>estimates</b>; billed volumes and bulk supply are recorded data.</div>` : ''}</div>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Revenue protection — accounts to inspect</h2><small class="muted">Scored from billing and meter patterns. A high score is a reason to visit, not proof of wrongdoing.</small></div>
      ${table([{ label: 'Score', cls: 'num', render: s => html`<span class="badge ${s.score >= 40 ? 'crit' : s.score >= 25 ? 'serious' : 'warn'}">${s.score}</span>` }, { label: 'Account', render: s => html`<a href="#/customers/${s.customer_id}">${s.name}</a><br><small class="mono">${s.customer_number}</small> · <small>${label(s.customer_type)}, ${s.area_name}</small>` },
        { label: 'Meter', render: s => html`<span class="mono">${s.serial_number}</span>` }, { label: 'Why', render: s => html`<ul style="margin:0;padding-left:1rem;font-size:.85rem">${s.reasons.map(r => html`<li>${r}</li>`)}</ul>` }, { label: 'Avg use', cls: 'num', render: s => fmtM3(s.recent_avg_m3) },
        { label: '', render: s => (s.open_work_order ? html`<span class="badge info">${s.open_work_order}</span>` : can('workorders.manage') ? html`<button class="btn sm primary" data-act="inspect" data-id="${s.customer_id}">Inspect</button>` : '') }], sus, { empty: 'No accounts currently stand out.' })}</div>
    ${links ? html`<div class="card"><h2>Public / donor transparency links</h2><p class="muted" style="font-size:.88rem">Share aggregated performance (coverage, water-point functionality, NRW, collection efficiency, response times) with donors, regulators or the community. No names, account numbers or individual readings are ever shown; small counts are suppressed.</p>
      ${table([{ label: 'Title', key: 'title' }, { label: 'Scope', render: l => (l.area_ids ? JSON.parse(l.area_ids).map(id => (state.lookups.areas.find(a => a.id === id) || {}).name).join(', ') : 'All areas') + ` · last ${l.months} months` },
        { label: 'Views', cls: 'num', key: 'views' }, { label: 'Created', render: l => html`${fmtDT(l.created_at.replace(' ', 'T') + 'Z')}<br><small>${l.created_by_name}</small>` }, { label: 'Status', render: l => badge(l.active ? 'active' : 'disabled', l.active ? 'Active' : 'Revoked') },
        { label: '', render: l => (l.active ? html`<button class="btn sm danger" data-act="revoke" data-id="${l.id}">Revoke</button>` : '') }], links, { empty: 'No links yet.' })}</div>` : ''}`);
  const fl = $('#flt', root);
  fl.addEventListener('submit', e => { e.preventDefault(); location.hash = '#/water-loss' + qs(Object.fromEntries(new FormData(fl))); });
  fl.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { fl.from.value = daysAgo(Number(b.dataset.range)); fl.to.value = today(); fl.requestSubmit(); }));
  bind(root, {
    inspect: b => { const s = sus.find(x => x.customer_id === Number(b.dataset.id)); newWorkOrder({ customer_id: s.customer_id, meter_id: s.meter_id, area_id: s.area_id, type: 'inspection', priority: s.score >= 40 ? 'high' : 'medium', title: `Revenue-protection inspection: ${s.name}`, description: 'Check meter, seals and connection for: ' + s.reasons.join('; ') }, () => view(root, _p, q)); },
    revoke: async b => { if (await confirmBox('Revoke link', 'Anyone using this link will no longer see the page.', { danger: true, ok: 'Revoke' })) { await api(`/api/share-links/${b.dataset.id}/revoke`, { body: {} }); view(root, _p, q); } },
    share: () => modal('Create public / donor link', html`<div class="form">${formFields([{ name: 'title', label: 'Page title', required: true, full: true, default: 'Water service performance' }, { name: 'months', label: 'Period (months back)', type: 'number', default: 6 },
      { name: 'area_ids', label: 'Areas included (none ticked = all)', type: 'checks', options: state.lookups.areas.map(a => [String(a.id), a.name]), full: true }])}</div>`,
      { onSubmit: async v => { const r = await api('/api/share-links', { body: { title: v.title, months: v.months, area_ids: (v.area_ids || []).map(Number) } }); const url = location.origin + r.url;
        modal('Link created', html`<p>${r.note}</p><p class="mono" style="word-break:break-all;background:#f3f5f7;padding:.6rem;border-radius:6px">${url}</p><p><a class="btn primary" href="${url}" target="_blank" rel="noopener">Open page</a></p>`, {}); view(root, _p, q); } })
  });
}
