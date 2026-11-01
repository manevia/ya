// Tariff & affordability lab, and the manager's morning briefing.
import { api, html, raw, mount, $, $$, state, qs, can, money, fmtNum, fmtDate, label, badge, table, modal, formFields, toast, bind, hbars, esc, today } from '../core.js';
import { ensureLookups } from './dashboard.js';

const SEV = { critical: ['crit', '⛔'], high: ['serious', '▲'], medium: ['warn', '●'], info: ['info', 'ℹ'] };
export async function briefing(root) {
  const b = await api('/api/briefing');
  mount(root, html`<div class="page-head"><div><h1>Morning briefing</h1><small>${fmtDate(b.date)} · today's priorities, built from live data</small></div>
    <div class="actions"><button class="btn" data-act="sms">📱 Send to my phone (SMS)</button><a class="btn" href="#/dashboard">Dashboard</a></div></div>
    ${b.items.length ? b.items.map((i, n) => html`<a class="card" href="${i.link}" style="display:flex;gap:.9rem;align-items:flex-start;text-decoration:none;color:inherit">
      <span class="badge ${SEV[i.severity][0]}" style="font-size:1rem;min-width:2.2rem;text-align:center">${n + 1}</span><div><b>${SEV[i.severity][1]} ${i.title}</b><div class="muted" style="font-size:.88rem">${i.detail}</div></div><span style="margin-left:auto" class="muted">›</span></a>`)
      : html`<div class="card empty">Nothing urgent today. 🎉</div>`}
    <p class="muted" style="font-size:.85rem">Set a phone in Administration › Settings (“briefing SMS phone”) to receive this every morning by SMS.</p>`);
  bind(root, { sms: async () => { const r = await api('/api/briefing/sms', { body: {} }); toast(`Briefing ${r.simulated ? '(simulated) ' : ''}sent to ${r.sent_to}`, 'ok'); } });
}

export async function tariffLab(root, _p, q) {
  const L = await ensureLookups();
  const tariffs = await api('/api/tariffs').catch(() => []);
  mount(root, html`<div class="page-head"><div><h1>Tariff & affordability lab</h1><small>Test a tariff on what customers actually used before anyone pays it: revenue, who pays more, affordability, and fairness for kiosk users.</small></div></div>
    <div class="card"><form id="tl" class="form">${formFields([{ name: 'area_id', label: 'Service area', type: 'select', options: L.areas.map(a => [a.id, `${a.name} (${a.currency})`]), required: true },
      { name: 'customer_type', label: 'Customer type', type: 'select', options: ['household', 'business', 'institution', 'public_water_point', 'bulk'], blank: 'All types' },
      { name: 'months', label: 'Months of real bills to use', type: 'number', default: 6, min: 1, max: 24 }, { name: 'fixed_charge', label: 'Fixed charge per bill', type: 'number', step: '0.01', default: 0 },
      { name: 'tax_pct', label: 'Tax %', type: 'number', step: '0.01', default: 0 }, { name: 'minimum_charge', label: 'Minimum charge', type: 'number', step: '0.01', default: 0 }])}
      <div class="full"><h3>Consumption bands (progressive). Tip: a cheap first “lifeline” band protects poor households.</h3><div id="bands"></div><button type="button" class="btn sm" id="addb">+ Band</button>
        <select id="loadt" style="margin-left:.5rem"><option value="">Start from an existing tariff…</option>${tariffs.map(t => html`<option value="${t.id}">${t.code} — ${t.name}</option>`)}</select></div>
      <div class="full"><button class="btn primary lg">Run simulation</button></div></form></div><div id="res"></div>`);
  const f = $('#tl', root), bx = $('#bands', root);
  const row = b => `<div class="band" style="display:flex;gap:.5rem;margin:.25rem 0;align-items:center">up to <input name="up_to" type="number" step="any" value="${esc(b.up_to ?? '')}" style="width:110px" placeholder="open"> m³ @ <input name="rate" type="number" step="any" value="${esc(b.rate ?? '')}" style="width:110px" required> per m³ <button type="button" class="btn sm danger rm">×</button></div>`;
  const setBands = bs => { bx.innerHTML = bs.map(row).join(''); }; setBands([{ up_to: 6, rate: '' }, { up_to: 30, rate: '' }, { up_to: null, rate: '' }]);
  $('#addb', root).onclick = () => bx.insertAdjacentHTML('beforeend', row({}));
  bx.addEventListener('click', e => { if (e.target.classList.contains('rm')) e.target.parentElement.remove(); });
  $('#loadt', root).onchange = e => { const t = tariffs.find(x => String(x.id) === e.target.value); if (!t) return; setBands(JSON.parse(t.bands_json)); f.fixed_charge.value = t.fixed_charge; f.tax_pct.value = t.tax_pct; f.minimum_charge.value = t.minimum_charge;
    if (t.area_id) f.area_id.value = t.area_id; if (t.customer_type) f.customer_type.value = t.customer_type; };
  let last = null;
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const body = { area_id: Number(f.area_id.value), customer_type: f.customer_type.value || null, months: Number(f.months.value || 6), fixed_charge: Number(f.fixed_charge.value || 0), tax_pct: Number(f.tax_pct.value || 0), minimum_charge: Number(f.minimum_charge.value || 0),
      bands: $$('.band', bx).map(r => ({ up_to: r.querySelector('[name=up_to]').value === '' ? null : Number(r.querySelector('[name=up_to]').value), rate: Number(r.querySelector('[name=rate]').value) })) };
    try { const r = await api('/api/tariff-lab/simulate', { body }); last = { body, r }; render(r); } catch (err) { toast(err.message, 'err'); }
  });
  const render = r => {
    const c = r.currency; const up = r.revenue.change_pct;
    $('#res', root).innerHTML = html`<div class="grid g4">
      <div class="kpi"><div class="label">Revenue per month</div><div class="value">${money(r.revenue.proposed_per_month, c)}</div><div class="sub">now ${money(r.revenue.current_per_month, c)} · <b style="color:${raw(up >= 0 ? 'var(--good)' : 'var(--crit)')}">${up >= 0 ? '+' : ''}${fmtNum(up, 1)}%</b></div></div>
      <div class="kpi"><div class="label">Bills that would go up</div><div class="value">${fmtNum(r.paying_more_pct, 0)}%</div><div class="sub">${r.bills} real bills · ${r.customers} customers · ${r.months} months</div></div>
      <div class="kpi"><div class="label">Lifeline (${r.lifeline.household_size} people × ${r.lifeline.litres_per_person_day} L/day = ${r.lifeline.m3_per_month} m³)</div><div class="value">${money(r.lifeline.proposed_bill, c)}</div><div class="sub">now ${r.lifeline.current_bill != null ? money(r.lifeline.current_bill, c) : '—'}${r.lifeline.proposed_pct_income != null ? ` · ${fmtNum(r.lifeline.proposed_pct_income, 1)}% of median income` : ''}</div></div>
      <div class="kpi"><div class="label">Household bills above affordability line</div><div class="value">${r.affordability ? `${r.affordability.over_threshold_proposed}` : '—'}</div><div class="sub">${r.affordability ? `of ${r.affordability.households} bills above ${r.affordability.threshold_pct}% of income (now ${r.affordability.over_threshold_current})` : r.affordability_note}</div></div></div>
    <div class="grid g2" style="margin-top:1rem"><div class="card"><h2>How bills change</h2>${hbars(r.distribution.map((d, i) => ({ label: d.label, value: d.n, color: ['var(--s3)', 'var(--s3)', 'var(--s1)', 'var(--s4)', 'var(--s8)'][i] })), { unit: 'bills' })}</div>
      <div class="card"><h2>Fairness for kiosk users</h2>${r.equity.kiosks.length ? html`<p>Piped households pay about <b>${money(r.equity.piped_per_m3_proposed, c)}/m³</b> at lifeline volume under this proposal (now ${r.equity.piped_per_m3_current != null ? money(r.equity.piped_per_m3_current, c) : '—'}).</p>
        ${table([{ label: 'Kiosk', key: 'name' }, { label: 'Price per m³', cls: 'num', render: k => money(k.price_per_m3, c) }, { label: '× piped (now)', cls: 'num', render: k => (k.times_piped_current != null ? fmtNum(k.times_piped_current, 1) + '×' : '—') },
          { label: '× piped (proposed)', cls: 'num', render: k => html`<b>${fmtNum(k.times_piped_proposed, 1)}×</b>` }], r.equity.kiosks)}<p class="muted" style="font-size:.85rem">The poorest households often buy by the container. A large gap means they subsidise piped customers — consider lowering kiosk prices or adding a social tariff for water points.</p>`
        : html`<p class="muted">No pay-per-container water points in this area.</p>`}</div></div>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>By customer type</h2></div>${table([{ label: 'Type', render: x => label(x.type) }, { label: 'Bills', cls: 'num', key: 'bills' }, { label: 'Volume', cls: 'num', render: x => fmtNum(x.m3, 0) + ' m³' },
      { label: 'Billed now', cls: 'num', render: x => money(x.current, c) }, { label: 'Proposed', cls: 'num', render: x => money(x.proposed, c) }, { label: 'Change', cls: 'num', render: x => html`<b>${x.change_pct >= 0 ? '+' : ''}${fmtNum(x.change_pct, 1)}%</b>` }], r.by_type)}</div>
    <div class="note">${r.notes.join(' ')}</div>
    ${can('tariffs.manage') ? html`<p><button class="btn primary" id="draft">Save as draft tariff (inactive) for approval</button></p>` : ''}`.s;
    const d = $('#draft', root); if (d) d.onclick = () => modal('Save draft tariff', html`<div class="note">Saved as <b>inactive</b>. Activate it in Administration › Tariffs after approval (board / regulator).</div><div class="form">${formFields([{ name: 'code', label: 'Code', required: true, default: 'DRAFT-' + today().replace(/-/g, '') },
      { name: 'name', label: 'Name', required: true, default: 'Proposed tariff (lab)' }, { name: 'effective_from', label: 'Proposed effective date', type: 'date', required: true, default: today() }])}</div>`,
      { onSubmit: async v => { const a = L.areas.find(x => x.id === last.body.area_id); await api('/api/tariffs', { body: { ...v, customer_type: last.body.customer_type, area_id: last.body.area_id, currency: a.currency, fixed_charge: last.body.fixed_charge, tax_pct: last.body.tax_pct, minimum_charge: last.body.minimum_charge, bands: last.body.bands, fees: [], active: false, notes: `Created in tariff lab: revenue ${fmtNum(last.r.revenue.change_pct, 1)}%, ${fmtNum(last.r.paying_more_pct, 0)}% of bills up.` } }); toast('Draft tariff saved (inactive)', 'ok'); } });
  };
}
