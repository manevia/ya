// Water-quality monitoring: latest status per sampling point, compliance, test entry and thresholds.
import { api, html, raw, mount, $, state, qs, can, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, uuid } from '../core.js';

const RES = { pass: ['good', 'Pass'], warn: ['warn', 'Attention'], fail: ['crit', 'FAIL'] };
const resBadge = r => (r ? html`<span class="badge ${RES[r][0]}">${RES[r][1]}</span>` : html`<span class="badge outline">No test</span>`);

export async function testForm(assets, params, preset = {}, done) {
  modal('Record water-quality test', html`<div class="note">Record the field-kit or lab result. A failing result raises an alert and publishes a “treat your water” advisory for the area; a later passing test lifts it.</div><div class="form">${formFields([
    { name: 'asset_id', label: 'Sampling point', type: 'select', options: assets.map(a => [a.id, `${a.name} (${label(a.asset_type)})`]), required: true, full: true, default: preset.asset_id },
    { name: 'parameter', label: 'Parameter', type: 'select', options: params.map(p => [p.code, `${p.name}${p.unit ? ' (' + p.unit + ')' : ''}`]), required: true, blank: false, default: preset.parameter || 'free_chlorine' },
    { name: 'value', label: 'Result', type: 'number', step: 'any', required: true, inputmode: 'decimal' }, { name: 'method', label: 'Method', type: 'select', options: [['field_kit', 'Field test kit'], ['lab', 'Laboratory'], ['sensor', 'Sensor']], blank: false },
    { name: 'sampled_at', label: 'Sampled at', type: 'datetime-local' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }])}<div class="full" id="hint" style="font-size:.85rem"></div></div>`,
    { submitLabel: 'Save result', onSubmit: async v => { if (v.asset_id) v.asset_id = Number(v.asset_id); const r = await api('/api/wq/tests', { body: { ...v, client_uuid: uuid() } });
      toast(r.result === 'fail' ? `FAIL recorded — alert raised${r.advisory && r.advisory !== 'lifted' ? ' and public advisory published' : ''}` : r.advisory === 'lifted' ? 'Pass — advisory lifted' : `Recorded: ${RES[r.result][1]}`, r.result === 'fail' ? 'err' : 'ok'); done && done(r); } });
  const d = document.querySelector('dialog:last-of-type'); const sel = d.querySelector('[name=parameter]'); const hint = d.querySelector('#hint');
  const show = () => { const p = params.find(x => x.code === sel.value); hint.textContent = p ? p.guidance : ''; }; sel.addEventListener('change', show); show();
}

/** How much chlorine product to add to a tank: amount = volume (m³) × dose (mg/L) × 100 ÷ strength (%), in grams for powder or mL for liquid. */
export function doseCalc() {
  modal('Chlorine dose calculator', html`<div class="form">${formFields([
    { name: 'volume', label: 'Water to treat (m³)', type: 'number', step: 'any', min: 0, inputmode: 'decimal', help: '1 m³ = 1,000 litres' },
    { name: 'product', label: 'Product', type: 'select', blank: false, options: [['70', 'Chlorine powder or granules (HTH), 70%'], ['65', 'Chlorine powder or granules (HTH), 65%'], ['35', 'Bleaching powder, 35%'], ['5', 'Liquid bleach, 5%'], ['3.5', 'Liquid bleach, 3.5%'], ['x', 'Other strength…']] },
    { name: 'strength', label: 'Strength (% available chlorine)', type: 'number', step: 'any', min: 0.1, max: 100 }, { name: 'form', label: 'Form', type: 'select', blank: false, options: [['g', 'Powder or granules (grams)'], ['ml', 'Liquid (millilitres)']] },
    { name: 'target', label: 'Dose to add (mg/L)', type: 'number', step: 'any', min: 0, inputmode: 'decimal', help: 'Often 1–2 mg/L for clear water; more if the water is cloudy.' },
    { name: 'current', label: 'Chlorine already in the water (mg/L)', type: 'number', step: 'any', min: 0, inputmode: 'decimal', help: 'Leave empty for a fresh tank.' }], { product: '70', strength: 70, form: 'g', target: 1 })}</div>
    <div class="kpi" style="margin-top:.8rem"><div class="label">Add</div><div class="value" id="dose-out">—</div><div class="sub" id="dose-sub"></div></div>
    <div class="note warn">Dissolve or dilute the product in a bucket of water first, pour it in and mix. Wait 30 minutes, then test: aim for at least 0.2 mg/L of free chlorine at the tap, and record the result. How much chlorine water uses up varies, so adjust the dose from your test results. Wear gloves and eye protection.</div>`, { noFooter: true });
  const d = document.querySelector('dialog:last-of-type'); const f = n => d.querySelector(`[name=${n}]`);
  const calc = () => { const v = Number(f('volume').value), p = Number(f('strength').value), dose = Math.max(0, Number(f('target').value) - (Number(f('current').value) || 0)); const unit = f('form').value;
    const amt = v > 0 && p > 0 && dose > 0 ? v * dose * 100 / p : null;
    d.querySelector('#dose-out').textContent = amt == null ? '—' : amt >= 1000 ? `${fmtNum(amt / 1000, 2)} ${unit === 'g' ? 'kg' : 'L'}` : `${fmtNum(amt, amt < 10 ? 1 : 0)} ${unit === 'g' ? 'g' : 'mL'}`;
    d.querySelector('#dose-sub').textContent = amt == null ? '' : `${fmtNum(v, 1)} m³ × ${fmtNum(dose, 2)} mg/L × 100 ÷ ${fmtNum(p, 1)}%`; };
  f('product').addEventListener('change', () => { const pv = f('product').value; if (pv !== 'x') { f('strength').value = pv; f('form').value = Number(pv) > 10 ? 'g' : 'ml'; } calc(); });
  d.addEventListener('input', calc); d.addEventListener('change', calc);
}

export async function view(root) {
  const [d, tests, assets] = await Promise.all([api('/api/wq'), api('/api/wq/tests'), api('/api/assets').catch(() => [])]);
  const pts = assets.length ? assets.filter(a => ['water_point', 'reservoir', 'treatment', 'source'].includes(a.asset_type)) : d.points.map(p => ({ id: p.id, name: p.name, asset_type: p.asset_type }));
  const failing = d.points.filter(p => p.latest.result === 'fail');
  mount(root, html`<div class="page-head"><div><h1>Water quality</h1><small>Chlorine, E. coli, turbidity and pH at water points, reservoirs and treatment. Results appear on the public status page.</small></div>
      <div class="actions">${can('wq.record') ? html`<button class="btn primary" data-act="new">+ Record test</button>` : ''}<button class="btn" data-act="dose">Chlorine dose calculator</button><a class="btn" href="/status" target="_blank" rel="noopener">Public status page ↗</a></div></div>
    ${failing.length ? html`<div class="note crit"><b>${failing.length} point(s) failing:</b> ${failing.map(p => p.name).join(', ')}. Advisories are published for the affected areas until a re-test passes.</div>` : ''}
    <div class="grid g4">
      <div class="kpi"><div class="label">Points tested in last ${d.sampling_days} days</div><div class="value">${d.coverage_pct == null ? '—' : fmtNum(d.coverage_pct, 0) + '%'}</div><div class="bar"><span style="width:${raw(d.coverage_pct || 0)}%"></span></div><div class="sub">${d.points.filter(p => p.tested_recently).length} of ${d.points.length} sampling points</div></div>
      ${d.parameters.filter(p => p.active).slice(0, 3).map(p => { const c = d.compliance_30d.find(x => x.parameter === p.code); return html`<div class="kpi"><div class="label">${p.name} — last 30 days</div><div class="value">${c ? fmtNum(c.pass / c.n * 100, 0) + '%' : '—'}</div><div class="sub">${c ? `${c.n} tests · ${c.fail} fail · ${c.warn} attention` : 'no tests'}</div></div>`; })}</div>
    <div class="card flush" style="margin-top:1rem"><div style="padding:1rem 1rem 0"><h2>Latest result per sampling point</h2></div>
      ${table([{ label: 'Point', render: p => html`<a href="#/network/${p.id}">${p.name}</a><br><small>${label(p.asset_type)} · ${p.area_name || ''}</small>` }, { label: 'Overall', render: p => resBadge(p.latest.result) },
        ...d.parameters.filter(x => x.active).map(par => ({ label: par.name, render: p => { const t = p.latest.parameters.find(x => x.parameter === par.code); return t ? html`${resBadge(t.result)} <span class="num">${fmtNum(t.value, 2)}</span><br><small>${fmtDate(t.sampled_at)}</small>` : html`<span class="muted">—</span>`; } })),
        { label: 'Sampling', render: p => (p.tested_recently ? html`<span class="badge good">up to date</span>` : html`<span class="badge warn">due</span>`) },
        { label: '', render: p => (can('wq.record') ? html`<button class="btn sm" data-act="test" data-id="${p.id}">Test</button>` : '') }], d.points)}</div>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Recent tests</h2></div>${table([{ label: 'Sampled', render: t => fmtDT(t.sampled_at) }, { label: 'Point', key: 'asset_name' }, { label: 'Parameter', render: t => t.parameter_name || t.parameter },
      { label: 'Value', cls: 'num', render: t => `${fmtNum(t.value, 2)} ${t.unit || ''}` }, { label: 'Result', render: t => resBadge(t.result) }, { label: 'Method', render: t => label(t.method) }, { label: 'By', render: t => t.tested_by_name || '—' }, { label: 'Notes', key: 'notes' }], tests.slice(0, 100), { empty: 'No tests recorded yet.' })}</div>
    <div class="card"><h2>Thresholds</h2><p class="muted" style="font-size:.88rem">Defaults follow WHO drinking-water guidance. Confirm them against the national standard before live use.${can('settings.manage') ? ' Administrators can edit them.' : ''}</p>
      ${table([{ label: 'Parameter', render: p => html`<b>${p.name}</b> <small>${p.unit}</small>` }, { label: 'Fail below', cls: 'num', render: p => p.fail_below ?? '—' }, { label: 'Attention below', cls: 'num', render: p => p.warn_below ?? '—' },
        { label: 'Attention above', cls: 'num', render: p => p.warn_above ?? '—' }, { label: 'Fail above', cls: 'num', render: p => p.fail_above ?? '—' }, { label: 'Guidance', render: p => html`<small>${p.guidance}</small>` },
        { label: '', render: p => (can('settings.manage') ? html`<button class="btn sm" data-act="thr" data-code="${p.code}">Edit</button>` : '') }], d.parameters)}</div>`);
  const reload = () => view(root);
  bind(root, {
    dose: () => doseCalc(),
    new: () => testForm(pts, d.parameters.filter(p => p.active), {}, reload),
    test: b => testForm(pts, d.parameters.filter(p => p.active), { asset_id: Number(b.dataset.id) }, reload),
    thr: b => { const p = d.parameters.find(x => x.code === b.dataset.code);
      modal('Thresholds — ' + p.name, html`<div class="form">${formFields([{ name: 'fail_below', label: 'Fail below', type: 'number', step: 'any' }, { name: 'warn_below', label: 'Attention below', type: 'number', step: 'any' },
        { name: 'warn_above', label: 'Attention above', type: 'number', step: 'any' }, { name: 'fail_above', label: 'Fail above', type: 'number', step: 'any' }, { name: 'guidance', label: 'Guidance text (shown to staff)', type: 'textarea', full: true }, { name: 'active', label: 'Active', type: 'checkbox' }], p)}</div>`,
        { onSubmit: async v => { await api('/api/wq/parameters/' + p.code, { method: 'PUT', body: v }); toast('Thresholds saved', 'ok'); reload(); } }); }
  });
}
