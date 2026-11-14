// Water Safety Plan: risk register (before/after controls), operational monitoring, sanitary inspections, improvement plan.
import { api, html, raw, mount, $, $$, qs, can, canAny, money, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, uuid, download, currencies, today } from '../core.js';
import { ensureLookups } from './dashboard.js';

const BAND = { low: ['good', 'Low'], medium: ['warn', 'Medium'], high: ['serious', 'High'], very_high: ['crit', 'Very high'] };
const bd = (cls, text) => html`<span class="badge ${cls}">${text}</span>`;
const bandOf = s => (s >= 16 ? 'very_high' : s >= 10 ? 'high' : s >= 6 ? 'medium' : 'low');
const riskBadge = (score, band) => (score == null ? html`<span class="badge outline">Not scored</span>` : html`<span class="badge ${BAND[band][0]}"><b>${score}</b>&nbsp;${BAND[band][1]}</span>`);
const CSTATE = { breach: ['crit', 'Outside limits'], overdue: ['serious', 'Check overdue'], not_checked: ['warn', 'Not checked yet'], ok: ['good', 'Working'], no_controls: ['outline', 'No control yet'], inactive: ['outline', 'Not in use'] };
const cBadge = s => bd(CSTATE[s][0], CSTATE[s][1]);
const STEPS = [['catchment', 'Catchment'], ['source', 'Source'], ['treatment', 'Treatment'], ['storage', 'Storage'], ['distribution', 'Distribution'], ['collection', 'Collection point'], ['household', 'Household'], ['management', 'Management']];
const stepLabel = s => (STEPS.find(x => x[0] === s) || [s, label(s)])[1];
const TYPES = [['microbial', 'Germs (microbial)'], ['chemical', 'Chemical'], ['physical', 'Physical'], ['quantity', 'Not enough water']];
const L5 = [[1, '1 — Rare (less than once in 5 years)'], [2, '2 — Unlikely (once a year)'], [3, '3 — Possible (once a month)'], [4, '4 — Likely (once a week)'], [5, '5 — Almost certain (daily)']];
const S5 = [[1, '1 — No health effect'], [2, '2 — Taste, smell or colour only'], [3, '3 — Mild illness, or a short loss of supply'], [4, '4 — Illness in many people'], [5, '5 — Severe illness or death']];
const TABS = [['overview', 'Overview'], ['register', 'Risk register'], ['monitoring', 'Monitoring'], ['inspections', 'Sanitary inspections'], ['plan', 'Improvement plan']];
const dueText = st => (st.days_left == null ? '' : st.days_left < 0 ? `${-st.days_left} day(s) late` : st.days_left === 0 ? 'due today' : `due in ${st.days_left} day(s)`);
const freqText = d => (!d ? 'After each event' : d === 1 ? 'Every day' : d === 7 ? 'Every week' : d === 30 ? 'Every month' : `Every ${d} days`);

export async function view(root, _p, q) {
  const tab = TABS.some(t => t[0] === q.tab) ? q.tab : can('wsp.view') ? 'overview' : 'monitoring';
  const tabs = TABS.filter(t => can('wsp.view') || ['monitoring', 'inspections'].includes(t[0]));
  mount(root, html`<div class="page-head"><div><h1>Water safety plan</h1><small>Find what could make the water unsafe, put a control on each risk, check the controls are working, and fix what the checks find.</small></div>
    <div class="actions" id="wsp-actions"></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/water-safety?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="wsp"></div>`);
  const el = $('#wsp', root), act = $('#wsp-actions', root); const reload = () => view(root, _p, q);
  return ({ overview, register, monitoring, inspections, plan })[tab](el, act, reload, q);
}

// ======================= Overview =======================
function matrix(title, grid, sub) {
  return html`<div class="card"><h2>${title}</h2><p class="muted" style="font-size:.85rem;margin:.1rem 0 .6rem">${sub}</p>
    <div class="rm" role="table" aria-label="${title}"><div class="rm-y">Severity</div>
      ${[5, 4, 3, 2, 1].map(s => html`<div class="rm-h">${s}</div>${[1, 2, 3, 4, 5].map(l => { const n = grid[s - 1][l - 1]; return html`<div class="rm-c ${bandOf(l * s)}${n ? '' : ' zero'}" title="Likelihood ${l} × severity ${s} = ${l * s}">${n || ''}</div>`; })}`)}
      <div></div>${[1, 2, 3, 4, 5].map(l => html`<div class="rm-h">${l}</div>`)}</div><div class="rm-x">Likelihood</div></div>`;
}
async function overview(el, act) {
  const d = await api('/api/wsp');
  if (can('wsp.manage')) mount(act, html`<a class="btn" href="/api/wsp/hazards?format=csv" data-download>Export register (CSV)</a>`);
  if (!d.hazards) return mount(el, html`<div class="card"><h2>Start your water safety plan</h2><p>A water safety plan lists what could contaminate the water between the source and the home, and what you do to stop it. You can have a first version today.</p>
    <ol style="line-height:1.9"><li><b>Start from a template</b> for your type of system, then adjust it.</li><li><b>Inspect each water point</b> with the short checklist on your phone.</li><li><b>Record the checks</b> that show each control is working.</li></ol>
    ${can('wsp.manage') ? html`<a class="btn primary" href="#/water-safety?tab=register&start=1">Choose a template</a>` : ''}</div>`);
  const b = d.bands_residual;
  mount(el, html`<div class="grid g4">
      <div class="kpi"><div class="label">Plan readiness</div><div class="value">${d.score}%</div><div class="bar"><span style="width:${raw(d.score)}%"></span></div><div class="sub">${d.hazards} risks in the register</div></div>
      <div class="kpi"><div class="label">Risks still high with controls</div><div class="value ${b.very_high + b.high ? 'crit-t' : ''}">${b.very_high + b.high}</div><div class="sub">${b.very_high} very high · ${b.high} high · ${b.medium} medium · ${b.low} low</div></div>
      <div class="kpi"><div class="label">Controls outside limits / checks overdue</div><div class="value ${d.monitoring.breach ? 'crit-t' : ''}">${d.monitoring.breach} / ${d.monitoring.overdue}</div><div class="sub">${d.monitoring.ok} of ${d.monitoring.total} controls checked and working</div></div>
      <div class="kpi"><div class="label">Improvement actions open</div><div class="value">${d.actions.open}</div><div class="sub">${d.actions.overdue} <span>overdue</span>${d.actions.cost.length ? html` · ${d.actions.cost.map(c => money(c.amount, c.currency)).join(' + ')} to fund` : ''}</div></div></div>
    ${d.next.length ? html`<div class="card" style="margin-top:1rem"><h2>What to do next</h2>${d.next.map(n => html`<div class="wsp-next"><a href="${n.link}"><b>${n.tip}</b></a><span class="muted">${n.label}: ${n.value == null ? '—' : fmtNum(n.value, 0) + '%'}</span></div>`)}</div>` : html`<div class="note good" style="margin-top:1rem">Every part of the plan is up to date.</div>`}
    <div class="grid g2" style="margin-top:1rem">${matrix('Before controls', d.matrix_raw, 'How bad each risk would be if nothing were done.')}${matrix('With controls in place', d.matrix_residual, 'Risks not yet re-scored stay where they were.')}</div>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Highest risks</h2></div>${table([{ label: 'Risk', render: h => html`<a href="#/water-safety/h/${h.id}"><b>${h.event}</b></a><br><small class="muted"><span class="mono">${h.ref}</span> · <span>${stepLabel(h.step)}</span> · ${h.asset_name || h.area_name || '—'}</small>` },
      { label: 'Before', render: h => riskBadge(h.raw_score, h.raw_band) }, { label: 'With controls', render: h => riskBadge(h.res_score, h.res_band) }, { label: 'Controls', render: h => cBadge(h.control_state) }], d.top)}</div>
    <div class="card"><h2>Plan readiness, part by part</h2>${d.parts.map(p => html`<div class="wsp-part"><a href="${p.link}">${p.label}</a><div class="bar"><span style="width:${raw(p.value || 0)}%"></span></div><span class="num">${p.value == null ? '—' : fmtNum(p.value, 0) + '%'}</span></div>`)}
      <p class="muted" style="font-size:.83rem;margin-top:.6rem">Scores: likelihood × severity (1–5 each). 1–5 low, 6–9 medium, 10–15 high, 16–25 very high. Based on the WHO water safety plan approach; confirm limits against the national drinking-water standard.</p></div>`);
  $$('[data-download]', act).forEach(a => a.addEventListener('click', e => { e.preventDefault(); download(a.getAttribute('href')); }));
}

// ======================= Risk register =======================
async function hazardForm(h, done, preset = {}) {
  const [L, assets] = await Promise.all([ensureLookups(), api('/api/assets').catch(() => [])]);
  modal(h ? `Edit risk ${h.ref}` : 'New risk', html`<div class="form">${formFields([
    { name: 'event', label: 'What could go wrong? (hazardous event)', required: true, full: true, placeholder: 'e.g. Flood water enters the well' },
    { name: 'step', label: 'Where in the system', type: 'select', options: STEPS, required: true }, { name: 'hazard_type', label: 'Type of hazard', type: 'select', options: TYPES, blank: false },
    { name: 'asset_id', label: 'Asset (optional)', type: 'select', options: assets.filter(a => a.status !== 'decommissioned').map(a => [a.id, a.name]) }, { name: 'area_id', label: 'Service area', type: 'select', options: (L.areas || []).map(a => [a.id, a.name]) },
    { name: 'cause', label: 'Cause or notes', type: 'textarea', full: true },
    { type: 'section', label: 'Risk before controls' }, { name: 'likelihood', label: 'How likely', type: 'select', options: L5, required: true }, { name: 'severity', label: 'How serious', type: 'select', options: S5, required: true },
    { type: 'section', label: 'Risk with controls in place (leave empty until controls exist)' }, { name: 'res_likelihood', label: 'How likely', type: 'select', options: L5 }, { name: 'res_severity', label: 'How serious', type: 'select', options: S5 },
    { name: 'owner_id', label: 'Person responsible', type: 'select', options: (L.staff || []).map(u => [u.id, u.full_name]) }, { name: 'review_due', label: 'Next review', type: 'date' },
    ...(h ? [{ name: 'status', label: 'Status', type: 'select', blank: false, options: [['open', 'In the register'], ['closed', 'Closed (no longer applies)']] }] : [])], h || preset)}</div>`,
  { wide: true, onSubmit: async v => { for (const k of ['likelihood', 'severity', 'res_likelihood', 'res_severity']) v[k] = v[k] ? Number(v[k]) : null;
    const r = await api('/api/wsp/hazards' + (h ? '/' + h.id : ''), { method: h ? 'PUT' : 'POST', body: v }); toast('Risk saved', 'ok'); done(r); } });
}
async function templateForm(done) {
  const [lib, L, assets] = await Promise.all([api('/api/wsp/library'), ensureLookups(), api('/api/assets').catch(() => [])]);
  modal('Start from a template', html`<div class="note">${lib.note}</div><div class="form">${formFields([
    { name: 'template', label: 'Type of system', type: 'select', required: true, full: true, options: lib.templates.map(t => [t.key, `${t.title} (${t.hazards.length})`]) },
    { name: 'area_id', label: 'Service area', type: 'select', options: (L.areas || []).map(a => [a.id, a.name]) },
    { name: 'asset_id', label: 'Or one asset', type: 'select', options: assets.filter(a => a.status !== 'decommissioned').map(a => [a.id, a.name]), help: 'Choose an asset to log its chlorine and turbidity tests against the controls automatically.' }])}</div><div id="tpl-prev" style="margin-top:.6rem"></div>`,
  { submitLabel: 'Add to the register', wide: true, onSubmit: async v => { const r = await api('/api/wsp/library/apply', { body: v }); toast(`${r.added} risk(s) added${r.skipped ? `, ${r.skipped} already there` : ''}`, 'ok'); done(); } });
  const d = document.querySelector('dialog:last-of-type'), sel = d.querySelector('[name=template]'), prev = d.querySelector('#tpl-prev');
  const show = () => { const t = lib.templates.find(x => x.key === sel.value); mount(prev, t ? html`<div class="table-wrap" style="max-height:16rem;overflow:auto"><table class="t"><thead><tr><th>Risk</th><th>Before</th><th>Control</th></tr></thead><tbody>
    ${t.hazards.map(h => html`<tr><td><span>${h.event}</span><br><small class="muted">${stepLabel(h.step)}</small></td><td>${riskBadge(h.l * h.s, bandOf(h.l * h.s))}</td><td>${h.controls.map(c => html`<div>${c.description}</div>`)}</td></tr>`)}</tbody></table></div>` : html``); };
  sel.addEventListener('change', show);
}
async function register(el, act, reload, q) {
  const rows = await api('/api/wsp/hazards' + qs({ status: q.status || 'open' }));
  if (can('wsp.manage')) mount(act, html`<button class="btn primary" data-act="new">+ Risk</button> <button class="btn" data-act="tpl">Start from a template</button> <button class="btn" data-act="csv">Export (CSV)</button>`);
  mount(el, html`<div class="filters"><a class="btn sm ${q.status === 'all' ? '' : 'primary'}" href="#/water-safety?tab=register">In the register</a> <a class="btn sm ${q.status === 'all' ? 'primary' : ''}" href="#/water-safety?tab=register&status=all">Include closed</a></div>
    <div class="card flush" style="margin-top:.6rem">${table([
      { label: 'Risk', render: h => html`<a href="#/water-safety/h/${h.id}"><b>${h.event}</b></a>${h.status === 'closed' ? html` ${badge('closed')}` : ''}<br><small class="muted"><span class="mono">${h.ref}</span> · <span>${stepLabel(h.step)}</span> · ${h.asset_name || h.area_name || '—'}</small>` },
      { label: 'Before controls', render: h => riskBadge(h.raw_score, h.raw_band) },
      { label: 'Controls', render: h => html`${cBadge(h.control_state)}${h.controls.filter(c => c.active).length ? html`<br><small class="muted">${h.controls.filter(c => c.active).length} control(s)</small>` : ''}` },
      { label: 'With controls', render: h => riskBadge(h.res_score, h.res_band) },
      { label: 'Actions', cls: 'num', render: h => h.actions.filter(a => ['planned', 'in_progress'].includes(a.status)).length || '—' },
      { label: 'Review', render: h => html`${fmtDate(h.review_due)}${h.review_overdue ? html` ${badge('overdue')}` : ''}` }], rows, { href: h => `#/water-safety/h/${h.id}`, empty: 'No risks yet. Start from a template, or add the first risk.' })}</div>`);
  bind(act, { new: () => hazardForm(null, r => { location.hash = `#/water-safety/h/${r.id}`; }), tpl: () => templateForm(reload), csv: () => download('/api/wsp/hazards?format=csv') });
  if (q.start && can('wsp.manage') && !rows.length) templateForm(reload);
}

// ---- one risk: controls, checks, actions ----
function controlForm(hazardId, c, params, staff, done) {
  modal(c ? 'Edit control measure' : 'New control measure', html`<div class="form">${formFields([
    { name: 'description', label: 'What keeps this risk under control', required: true, full: true, placeholder: 'e.g. Daily chlorine check at the tank outlet' },
    { name: 'parameter', label: 'Fed by water-quality tests of', type: 'select', options: params.map(p => [p.code, p.name]), blank: '— none (checked by hand) —', help: 'Tests of this parameter at the same asset are logged here automatically.' },
    { name: 'unit', label: 'Unit', placeholder: 'mg/L' }, { name: 'limit_low', label: 'Lowest acceptable value', type: 'number', step: 'any' }, { name: 'limit_high', label: 'Highest acceptable value', type: 'number', step: 'any' },
    { name: 'frequency_days', label: 'Check every … days', type: 'number', min: 1, help: 'Leave empty for checks done after an event, such as a repair.' }, { name: 'responsible_id', label: 'Who checks', type: 'select', options: staff.map(u => [u.id, u.full_name]) },
    { name: 'corrective_action', label: 'What to do if the check fails', type: 'textarea', full: true },
    ...(c ? [{ name: 'active', label: 'Control in use', type: 'checkbox' }] : [])], c || {})}</div>`,
  { wide: true, onSubmit: async v => { await api(c ? '/api/wsp/controls/' + c.id : `/api/wsp/hazards/${hazardId}/controls`, { method: c ? 'PUT' : 'POST', body: v }); toast('Control measure saved', 'ok'); done(); } });
}
export function checkForm(c, done) {
  const limits = c.limit_low != null || c.limit_high != null;
  modal('Record a check', html`<p><b>${c.description}</b>${c.asset_name ? html`<br><small class="muted">${c.asset_name}</small>` : ''}</p><div class="form">${formFields(limits
    ? [{ name: 'value', label: `Measured value${c.unit ? ' (' + c.unit + ')' : ''}`, type: 'number', step: 'any', required: true, inputmode: 'decimal', help: `Acceptable: ${c.limit_text}` }, { name: 'note', label: 'Note', full: true }]
    : [{ name: 'ok', label: 'Is the control working?', type: 'select', required: true, options: [['1', 'Yes — working'], ['0', 'No — not working']] }, { name: 'note', label: 'What did you see?', type: 'textarea', full: true }])}</div>
    ${c.corrective_action ? html`<div class="note warn"><b>If it fails:</b> <span>${c.corrective_action}</span></div>` : ''}`,
  { submitLabel: 'Save check', onSubmit: async v => { if (!limits) v.ok = v.ok === '1';
    const r = await api(`/api/wsp/controls/${c.id}/check`, { body: { ...v, client_uuid: uuid() } });
    toast(r.ok ? 'Check recorded — control working' : `Outside limits — alert raised. ${r.corrective_action || ''}`, r.ok ? 'ok' : 'err'); done(r); } });
}
async function actionForm(a, hazardId, done) {
  const L = await ensureLookups();
  modal(a ? 'Edit improvement action' : 'New improvement action', html`<div class="form">${formFields([
    { name: 'title', label: 'What will be done', required: true, full: true }, { name: 'description', label: 'Details', type: 'textarea', full: true },
    { name: 'owner_id', label: 'Person responsible', type: 'select', options: (L.staff || []).map(u => [u.id, u.full_name]) }, { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'cost', label: 'Estimated cost', type: 'number', step: 'any', min: 0 }, { name: 'currency', label: 'Currency', type: 'select', blank: false, options: currencies() },
    ...(a ? [{ name: 'status', label: 'Status', type: 'select', blank: false, options: [['planned', 'Planned'], ['in_progress', 'In progress'], ['done', 'Done'], ['cancelled', 'Cancelled']] }] : [])], a || {})}</div>`,
  { onSubmit: async v => { await api('/api/wsp/actions' + (a ? '/' + a.id : ''), { method: a ? 'PUT' : 'POST', body: { ...v, hazard_id: a ? a.hazard_id : hazardId } }); toast('Action saved', 'ok'); done(); } });
}
async function woForm(a, done) {
  const L = await ensureLookups();
  modal('Create a work order', html`<p><b>${a.title}</b></p><div class="form">${formFields([{ name: 'assigned_to', label: 'Assign to', type: 'select', full: true, options: (L.staff || []).filter(u => ['technician', 'manager', 'admin'].includes(u.role)).map(u => [u.id, u.full_name]), blank: '— unassigned —' }])}</div>
    <p class="muted" style="font-size:.85rem">Completing the work order marks this action as done.</p>`,
  { submitLabel: 'Create work order', onSubmit: async v => { const r = await api(`/api/wsp/actions/${a.id}/work-order`, { body: v }); toast(`Work order ${r.wo_number} created`, 'ok'); done(); } });
}
const ASTATE = { planned: 'outline', in_progress: 'info', done: 'good', cancelled: 'outline' };
const actionCols = (withRisk) => [
  { label: 'Action', render: a => html`<b>${a.title}</b>${withRisk && a.ref ? html`<br><small class="muted"><a href="#/water-safety/h/${a.hazard_id}" class="mono">${a.ref}</a> · ${a.asset_name || a.area_name || ''}</small>` : ''}` },
  { label: 'Status', render: a => html`${bd(ASTATE[a.status], label(a.status))}${a.overdue ? html` ${badge('overdue')}` : ''}` }, { label: 'Due', render: a => fmtDate(a.due_date) }, { label: 'Owner', render: a => a.owner_name || '—' },
  { label: 'Cost', cls: 'num', render: a => (a.cost == null ? '—' : money(a.cost, a.currency)) },
  { label: 'Work order', render: a => (a.wo_number ? html`<a href="#/work-orders/${a.work_order_id}" class="mono">${a.wo_number}</a> ${badge(a.wo_status)}` : can('wsp.manage') && ['planned', 'in_progress'].includes(a.status) ? html`<button class="btn sm" data-act="wo" data-id="${a.id}">Create</button>` : '—') },
  { label: '', render: a => (can('wsp.manage') ? html`<button class="btn sm" data-act="aedit" data-id="${a.id}">Edit</button>` : '') }];

export async function hazard(root, p) {
  const [h, L, wq] = await Promise.all([api('/api/wsp/hazards/' + p.id), ensureLookups(), api('/api/wq').catch(() => ({ parameters: [] }))]);
  const reload = () => hazard(root, p); const M = can('wsp.manage');
  mount(root, html`<div class="page-head"><div><a href="#/water-safety?tab=register">← Risk register</a><h1>${h.event}</h1><small><span class="mono">${h.ref}</span> · <span>${stepLabel(h.step)}</span> · ${(TYPES.find(t => t[0] === h.hazard_type) || [])[1]}${h.asset_name ? html` · <a href="#/network/${h.asset_id}">${h.asset_name}</a>` : h.area_name ? ` · ${h.area_name}` : ''}${h.status === 'closed' ? html` ${badge('closed')}` : ''}</small></div>
      <div class="actions">${M ? html`<button class="btn" data-act="edit">Edit</button> <button class="btn" data-act="review">Mark reviewed</button>` : ''}</div></div>
    <div class="grid g4">
      <div class="kpi"><div class="label">Before controls</div><div class="value">${riskBadge(h.raw_score, h.raw_band)}</div><div class="sub">Likelihood ${h.likelihood} × severity ${h.severity}</div></div>
      <div class="kpi"><div class="label">With controls in place</div><div class="value">${riskBadge(h.res_score, h.res_band)}</div><div class="sub">${h.res_score == null ? 'Score it again once the controls are working' : `Likelihood ${h.res_likelihood} × severity ${h.res_severity}`}</div></div>
      <div class="kpi"><div class="label">Controls</div><div class="value">${cBadge(h.control_state)}</div><div class="sub">${h.controls.filter(c => c.active).length} in use</div></div>
      <div class="kpi"><div class="label">Next review</div><div class="value" style="font-size:1.15rem">${fmtDate(h.review_due)}</div><div class="sub">${h.review_overdue ? 'Overdue' : h.last_reviewed_at ? `Last reviewed ${fmtDate(h.last_reviewed_at)}` : 'Not reviewed yet'}${h.owner_name ? ` · ${h.owner_name}` : ''}</div></div></div>
    ${h.cause ? html`<div class="note" style="margin-top:1rem"><span>${h.cause}</span></div>` : ''}
    <div class="card flush" style="margin-top:1rem"><div style="padding:1rem 1rem 0;display:flex;justify-content:space-between;gap:.5rem;align-items:center"><h2>Control measures</h2>${M ? html`<button class="btn sm primary" data-act="cnew">+ Control</button>` : ''}</div>
      ${table([{ label: 'Control', render: c => html`<b>${c.description}</b>${c.corrective_action ? html`<br><small class="muted">If it fails: <span>${c.corrective_action}</span></small>` : ''}` },
        { label: 'Limit', render: c => html`${c.limit_text || '—'}${c.parameter_name ? html`<br><small class="muted">from <span>${c.parameter_name}</span> tests</small>` : ''}` }, { label: 'How often', render: c => freqText(c.frequency_days) },
        { label: 'Last check', render: c => (c.status.last ? html`${fmtDate(c.status.last.checked_at)}${c.status.last.value != null ? html`<br><small class="num">${fmtNum(c.status.last.value, 2)} ${c.unit || ''}</small>` : ''}` : '—') },
        { label: 'Status', render: c => html`${cBadge(c.status.state)}${c.active && c.status.days_left != null && c.status.state !== 'breach' ? html`<br><small class="muted">${dueText(c.status)}</small>` : ''}` },
        { label: '', render: c => html`${c.active && canAny('wsp.monitor', 'wsp.manage') ? html`<button class="btn sm" data-act="check" data-id="${c.id}">Record check</button> ` : ''}${M ? html`<button class="btn sm" data-act="cedit" data-id="${c.id}">Edit</button>` : ''}` }], h.controls, { empty: 'No control measure yet. Add what keeps this risk under control and how you check it.' })}</div>
    <div class="card flush"><div style="padding:1rem 1rem 0;display:flex;justify-content:space-between;gap:.5rem;align-items:center"><h2>Improvement actions</h2>${M ? html`<button class="btn sm primary" data-act="anew">+ Action</button>` : ''}</div>
      ${table(actionCols(false), h.actions.map(a => ({ ...a, overdue: ['planned', 'in_progress'].includes(a.status) && a.due_date && a.due_date < today() })), { empty: 'No improvement action. Add one if the controls are not enough.' })}</div>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Checks recorded</h2></div>${table([{ label: 'When', render: m => fmtDT(m.checked_at) }, { label: 'Control', key: 'description' }, { label: 'Value', cls: 'num', render: m => (m.value == null ? '—' : `${fmtNum(m.value, 2)} ${m.unit || ''}`) },
      { label: 'Result', render: m => (m.ok ? bd('good', 'Working') : bd('crit', 'Outside limits')) }, { label: 'By', render: m => m.user_name || '—' }, { label: 'Note', render: m => m.note || '' }], h.monitoring, { empty: 'No checks recorded yet.' })}</div>`);
  const ctl = b => h.controls.find(c => c.id === Number(b.dataset.id)); const actn = b => h.actions.find(a => a.id === Number(b.dataset.id));
  bind(root, { edit: () => hazardForm(h, reload), cnew: () => controlForm(h.id, null, wq.parameters || [], L.staff || [], reload), cedit: b => controlForm(h.id, ctl(b), wq.parameters || [], L.staff || [], reload),
    check: b => checkForm({ ...ctl(b), asset_name: h.asset_name }, reload), anew: () => actionForm(null, h.id, reload), aedit: b => actionForm(actn(b), h.id, reload), wo: b => woForm(actn(b), reload),
    review: () => modal('Mark this risk as reviewed', html`<p>Confirm that the scores and controls still describe the situation. Review every risk once a year, and after any incident or change to the system.</p><div class="form">${formFields([{ name: 'note', label: 'Note', full: true }, { name: 'next_review', label: 'Next review', type: 'date' }])}</div>`,
      { submitLabel: 'Mark reviewed', onSubmit: async v => { await api(`/api/wsp/hazards/${h.id}/review`, { body: v }); toast('Review recorded', 'ok'); reload(); } }) });
}

// ======================= Monitoring =======================
async function monitoring(el, _act, reload) {
  const d = await api('/api/wsp/monitoring'); const n = s => d.controls.filter(c => c.status.state === s).length;
  mount(el, html`<div class="grid g4" style="margin-bottom:1rem">${['breach', 'overdue', 'not_checked', 'ok'].map(s => html`<div class="kpi"><div class="label">${CSTATE[s][1]}</div><div class="value ${s === 'breach' && n(s) ? 'crit-t' : ''}">${n(s)}</div></div>`)}</div>
    <div class="card flush">${table([{ label: 'Control', render: c => html`<b>${c.description}</b><br><small class="muted">${can('wsp.view') ? html`<a href="#/water-safety/h/${c.hazard_id}" class="mono">${c.ref}</a>` : html`<span class="mono">${c.ref}</span>`} · ${c.asset_name || c.area_name || '—'}</small>` },
      { label: 'Risk', render: c => bd(BAND[c.risk][0], BAND[c.risk][1]) }, { label: 'Limit', render: c => c.limit_text || '—' }, { label: 'How often', render: c => freqText(c.frequency_days) },
      { label: 'Last check', render: c => (c.status.last ? html`${fmtDate(c.status.last.checked_at)}${c.status.last.value != null ? html`<br><small class="num">${fmtNum(c.status.last.value, 2)} ${c.unit || ''}</small>` : ''}` : '—') },
      { label: 'Status', render: c => html`${cBadge(c.status.state)}${c.status.days_left != null && c.status.state !== 'breach' ? html`<br><small class="muted">${dueText(c.status)}</small>` : ''}${c.status.state === 'breach' && c.corrective_action ? html`<br><small><span>${c.corrective_action}</span></small>` : ''}` },
      { label: '', cls: 'act', render: c => (canAny('wsp.monitor', 'wsp.manage') ? html`<button class="btn sm ${['breach', 'overdue'].includes(c.status.state) ? 'primary' : ''}" data-act="check" data-id="${c.id}">Record check</button>` : '') }], d.controls, { empty: 'No control measures to check yet. Add them in the risk register.' })}</div>
    <p class="muted" style="font-size:.85rem">Chlorine, turbidity and other tests recorded under Water quality are logged here automatically when a control on the same asset uses that parameter. Checks cannot be edited or deleted once saved.</p>
    <div class="card flush"><div style="padding:1rem 1rem 0"><h2>Recent checks</h2></div>${table([{ label: 'When', render: m => fmtDT(m.checked_at) }, { label: 'Control', render: m => html`${m.description}<br><small class="muted"><span class="mono">${m.ref}</span> · ${m.asset_name || ''}</small>` },
      { label: 'Value', cls: 'num', render: m => (m.value == null ? '—' : `${fmtNum(m.value, 2)} ${m.unit || ''}`) }, { label: 'Result', render: m => (m.ok ? bd('good', 'Working') : bd('crit', 'Outside limits')) }, { label: 'By', render: m => m.user_name || '—' }, { label: 'Note', render: m => m.note || '' }], d.log.slice(0, 40), { empty: 'No checks recorded yet.' })}</div>`);
  bind(el, { check: b => checkForm(d.controls.find(c => c.id === Number(b.dataset.id)), reload) });
}

// ======================= Sanitary inspections =======================
function inspectForm(site, forms, done) {
  const mine = forms.filter(f => site.forms.includes(f.key)); let form = mine.find(f => site.last && f.key === site.last.form) || mine[0];
  const body = f => html`<p class="muted" style="font-size:.88rem">Walk round the site and answer every line. “Yes” means the risk is there.</p>
    <div class="si-list">${f.items.map((it, i) => html`<div class="si-item"><div><b>${i + 1}.</b> <span>${it.q}</span></div><div class="si-yn"><label><input type="radio" name="q_${it.id}" value="1" required> Yes</label><label><input type="radio" name="q_${it.id}" value="0"> No</label></div></div>`)}</div>
    <div class="form" style="margin-top:.6rem">${formFields([{ name: 'notes', label: 'Notes', type: 'textarea', full: true }, { name: 'create_hazards', label: 'Add each risk found to the register, with an action to fix it', type: 'checkbox', full: true }], { create_hazards: true })}</div>`;
  modal(`Inspect — ${site.name}`, html`${mine.length > 1 ? html`<div class="form"><label class="f full"><span>Checklist</span><select id="si-form" data-str="1">${mine.map(f => html`<option value="${f.key}"${f.key === form.key ? raw(' selected') : ''}>${f.title}</option>`)}</select></label></div>` : html`<p><b>${form.title}</b></p>`}<div id="si-body">${body(form)}</div>`,
  { wide: true, submitLabel: 'Save inspection', onSubmit: async v => {
    const dlg = document.querySelector('dialog:last-of-type'); const answers = Object.fromEntries(form.items.map(it => [it.id, (dlg.querySelector(`input[name="q_${it.id}"]:checked`) || {}).value === '1']));
    const r = await api('/api/wsp/inspections', { body: { asset_id: site.id, form: form.key, answers, notes: v.notes, create_hazards: v.create_hazards, client_uuid: uuid() } });
    toast(`${r.risk_count} of ${r.total} risks found — ${BAND[r.risk_level][1].toLowerCase()} risk${r.hazards_added ? `; ${r.hazards_added} added to the register` : ''}`, ['high', 'very_high'].includes(r.risk_level) ? 'err' : 'ok'); done(); } });
  const d = document.querySelector('dialog:last-of-type'); const sel = d.querySelector('#si-form');
  if (sel) sel.addEventListener('change', () => { form = mine.find(f => f.key === sel.value); mount(d.querySelector('#si-body'), body(form)); });
}
async function showInspection(id) {
  const i = await api('/api/wsp/inspections/' + id);
  modal(`${i.asset_name} — ${fmtDate(i.inspected_at)}`, html`<p><span>${i.form_title}</span> · ${bd(BAND[i.risk_level][0], `${i.risk_count} / ${i.total} — ${BAND[i.risk_level][1]}`)} · ${i.user_name || ''}</p>
    <div class="si-list">${i.items.map((it, n) => html`<div class="si-item"><div><b>${n + 1}.</b> <span>${it.q}</span>${it.yes ? html`<br><small class="muted">Fix: <span>${it.fix}</span></small>` : ''}</div><div>${it.yes ? bd('crit', 'Yes') : bd('good', 'No')}</div></div>`)}</div>${i.notes ? html`<div class="note">${i.notes}</div>` : ''}`, { noFooter: true, wide: true });
}
const GRADE = { A: 'good', B: 'warn', C: 'serious', D: 'crit' };
async function inspections(el, _act, reload) {
  const d = await api('/api/wsp/inspections');
  mount(el, html`<div class="grid g4" style="margin-bottom:1rem">
      <div class="kpi"><div class="label">Sites to inspect</div><div class="value">${d.rows.length}</div><div class="sub">every ${d.days} days</div></div>
      <div class="kpi"><div class="label">Inspection due</div><div class="value">${d.rows.filter(r => r.due).length}</div></div>
      <div class="kpi"><div class="label">High or very high priority</div><div class="value ${d.rows.some(r => ['high', 'very_high'].includes(r.priority)) ? 'crit-t' : ''}">${d.rows.filter(r => ['high', 'very_high'].includes(r.priority)).length}</div></div>
      <div class="kpi"><div class="label">Low priority</div><div class="value">${d.rows.filter(r => r.priority === 'low').length}</div></div></div>
    <div class="card flush">${table([{ label: 'Site', render: r => html`<a href="#/network/${r.id}"><b>${r.name}</b></a><br><small class="muted">${label(r.asset_type)} · ${r.area_name || '—'}</small>` },
      { label: 'Last inspection', render: r => (r.last ? html`<a href="#" data-act="show" data-id="${r.last.id}">${fmtDate(r.last.inspected_at)}</a>${r.due ? html` ${bd('warn', 'Due')}` : ''}` : bd('warn', 'Never inspected')) },
      { label: 'Risks found', render: r => (r.last ? bd(BAND[r.last.risk_level][0], `${r.last.risk_count} / ${r.last.total} — ${BAND[r.last.risk_level][1]}`) : '—') },
      { label: 'E. coli (last 90 days)', render: r => (r.ecoli ? html`<span class="badge ${GRADE[r.ecoli.grade]}">${r.ecoli.grade}</span> <small class="num">${fmtNum(r.ecoli.value, 0)}</small>` : html`<span class="muted">No test</span>`) },
      { label: 'Priority for action', render: r => (r.priority ? bd(BAND[r.priority][0], BAND[r.priority][1]) : '—') },
      { label: '', cls: 'act', render: r => (canAny('wsp.inspect', 'wsp.manage') ? html`<button class="btn sm ${r.due ? 'primary' : ''}" data-act="inspect" data-id="${r.id}">Inspect</button>` : '') }], d.rows, { empty: 'No water points, tanks or treatment units to inspect yet.' })}</div>
    <p class="muted" style="font-size:.85rem">Priority is the worse of the inspection result and the E. coli grade (A: none detected, B: 1–10, C: 11–100, D: over 100 per 100 mL). A clean test at a site with many risks is not a reason to wait: the risks show what can go wrong next. Inspection results cannot be edited once saved.</p>`);
  bind(el, { inspect: b => inspectForm(d.rows.find(r => r.id === Number(b.dataset.id)), d.forms, reload), show: b => showInspection(b.dataset.id) });
}

// ======================= Improvement plan =======================
async function plan(el, act, reload, q) {
  const rows = await api('/api/wsp/actions' + qs({ status: q.status || 'open' }));
  if (can('wsp.manage')) mount(act, html`<button class="btn primary" data-act="anew">+ Action</button>`);
  const open = rows.filter(a => ['planned', 'in_progress'].includes(a.status)); const cost = {}; for (const a of open) if (a.cost != null) cost[a.currency] = (cost[a.currency] || 0) + a.cost;
  mount(el, html`<div class="grid g4" style="margin-bottom:1rem">
      <div class="kpi"><div class="label">Open actions</div><div class="value">${open.length}</div></div><div class="kpi"><div class="label">Overdue</div><div class="value ${open.some(a => a.overdue) ? 'crit-t' : ''}">${open.filter(a => a.overdue).length}</div></div>
      <div class="kpi"><div class="label">With the technicians</div><div class="value">${open.filter(a => a.wo_number).length}</div><div class="sub">as work orders</div></div>
      <div class="kpi"><div class="label">Still to fund</div><div class="value" style="font-size:1.2rem">${Object.keys(cost).length ? Object.entries(cost).map(([c, v]) => money(v, c)).join(' + ') : '—'}</div><div class="sub">estimated cost of open actions</div></div></div>
    <div class="filters"><a class="btn sm ${q.status === 'all' ? '' : 'primary'}" href="#/water-safety?tab=plan">Open</a> <a class="btn sm ${q.status === 'all' ? 'primary' : ''}" href="#/water-safety?tab=plan&status=all">All</a></div>
    <div class="card flush" style="margin-top:.6rem">${table([{ label: 'Risk', render: a => (a.risk ? bd(BAND[a.risk][0], BAND[a.risk][1]) : '—') }, ...actionCols(true)], rows, { empty: 'No improvement actions. They are added from a risk, or when an inspection finds a problem.' })}</div>`);
  const actn = b => rows.find(a => a.id === Number(b.dataset.id));
  bind(act, { anew: () => actionForm(null, null, reload) }); bind(el, { aedit: b => actionForm(actn(b), null, reload), wo: b => woForm(actn(b), reload) });
}
