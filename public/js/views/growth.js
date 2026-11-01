// Growth & governance: new connections pipeline, shared compound connections, performance indicators, bulk onboarding, and personal security (2FA, sessions).
import { api, html, raw, mount, $, $$, state, qs, can, money, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, confirmBox, today, download, esc, currencies, payMethods, phoneHint } from '../core.js';
import { ensureLookups } from './dashboard.js';

// ======================= New connections =======================
const STAGES = [['submitted', 'Applied'], ['survey_scheduled', 'Survey booked'], ['surveyed', 'Surveyed'], ['quoted', 'Quoted'], ['accepted', 'Accepted — deposit due'], ['installing', 'Installing'], ['connected', 'Connected']];
const STAGE_CLS = { submitted: 'warn', survey_scheduled: 'info', surveyed: 'info', quoted: 'serious', accepted: 'serious', installing: 'info', connected: 'good', rejected: 'crit', cancelled: 'outline' };
const stageBadge = s => html`<span class="badge ${STAGE_CLS[s] || ''}">${(STAGES.find(x => x[0] === s) || [s, label(s)])[1]}</span>`;
const CH = { web: '🌐 web', ussd: '☎️ USSD', sms: '💬 SMS', office: '🏢 office' };

export async function connections(root, _p, q) {
  const L = await ensureLookups();
  const rows = await api('/api/connections');
  const open = rows.filter(r => !['connected', 'rejected', 'cancelled'].includes(r.status));
  const closed = rows.filter(r => ['connected', 'rejected', 'cancelled'].includes(r.status));
  const age = r => Math.max(0, Math.round((Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z')) / 86400e3));
  mount(root, html`<div class="page-head"><div><h1>New connections</h1><small>From application to first bill. Applicants can apply online, by USSD or at the office, pay a deposit, and spread the rest over monthly instalments on their water bill.</small></div>
    <div class="actions">${can('connections.manage') ? html`<button class="btn primary" data-act="new">New application</button>` : ''}</div></div>
    <div class="board">${STAGES.slice(0, 6).map(([k, l]) => { const items = open.filter(r => r.status === k); return html`<div class="col"><div class="col-h">${l} <span class="badge outline">${items.length}</span></div>
      ${items.map(r => html`<a class="tile" href="#/connections/${r.id}"><b>${r.applicant_name}</b><small>${r.area_name || 'area not set'} · ${CH[r.channel] || r.channel}</small>
        <small class="mono">${r.ref}</small>${r.quote_total ? html`<small>${money(r.quote_total, r.currency)}${r.deposit ? html` · paid ${money(r.paid, r.currency)} of ${money(r.deposit, r.currency)} deposit` : ''}</small>` : ''}<small class="${age(r) > 14 ? 'crit-t' : 'muted'}">${age(r)} days since applying</small></a>`)}
      ${items.length ? '' : html`<div class="muted" style="font-size:.85rem;padding:.4rem">None</div>`}</div>`; })}</div>
    <h2 style="margin-top:1.4rem">Completed and closed</h2>
    <div class="card flush">${table([{ label: 'Ref', render: r => html`<span class="mono">${r.ref}</span>` }, { label: 'Applicant', key: 'applicant_name' }, { label: 'Area', render: r => r.area_name || '—' }, { label: 'Status', render: r => stageBadge(r.status) },
      { label: 'Account', render: r => (r.customer_id ? html`<a href="#/customers/${r.customer_id}" class="mono">${r.customer_number}</a>` : '—') }, { label: 'Financed', cls: 'num', render: r => (r.instalments ? `${r.instalments} × ${money(r.instalment_amount, r.currency)}` : '—') },
      { label: 'Applied', render: r => fmtDate(r.created_at) }], closed, { href: r => '#/connections/' + r.id, empty: 'No completed connections yet.' })}</div>`);
  bind(root, { new: () => applicationForm(L, id => { location.hash = '#/connections/' + id; }) });
}

function applicationForm(L, done) {
  modal('New connection application', html`<div class="form">${formFields([{ name: 'applicant_name', label: 'Applicant name', required: true, full: true }, { name: 'phone', label: 'Phone', type: 'tel', placeholder: phoneHint() },
    { name: 'area_id', label: 'Service area', type: 'select', required: true, options: L.areas.filter(a => a.active).map(a => [a.id, a.name]) }, { name: 'address', label: 'Address / location', required: true, full: true }, { name: 'landmark', label: 'Landmark', full: true },
    { name: 'customer_type', label: 'Type', type: 'select', blank: false, options: [['household', 'Household'], ['business', 'Business'], ['institution', 'Institution (school, clinic…)']] }, { name: 'household_size', label: 'People in household', type: 'number', min: 1 }])}</div>`,
  { submitLabel: 'Register application', onSubmit: async v => { const r = await api('/api/connections', { body: v }); toast(`Application ${r.ref} registered — SMS sent`, 'ok'); done(r.id); } });
}

export async function connection(root, p) {
  const [d, L] = await Promise.all([api('/api/connections/' + p.id), ensureLookups()]);
  const r = d.request; const cur = r.currency || r.area_currency; const M = can('connections.manage');
  const quote = r.quote_json ? JSON.parse(r.quote_json) : null;
  const techs = L.staff.filter(s => ['technician', 'manager'].includes(s.role));
  const step = STAGES.findIndex(s => s[0] === r.status);
  const act = (a, l, cls = '') => (M ? html`<button class="btn ${cls}" data-act="${a}">${l}</button>` : '');
  const next = {
    submitted: html`${act('schedule_survey', 'Book site survey', 'primary')} ${act('record_survey', 'Record survey result')}`,
    survey_scheduled: act('record_survey', 'Record survey result', 'primary'), surveyed: act('quote', 'Prepare quote', 'primary'),
    quoted: act('accept', 'Customer accepts quote', 'primary'), accepted: act('start_install', 'Book installation', 'primary'), installing: act('complete', 'Installation done — connect', 'primary')
  }[r.status] || '';
  const closable = ['submitted', 'survey_scheduled', 'surveyed', 'quoted', 'accepted'].includes(r.status);
  mount(root, html`<div class="crumbs"><a href="#/connections">New connections</a> ›</div>
    <div class="page-head"><div><h1>${r.applicant_name}</h1><small class="mono">${r.ref}</small> ${stageBadge(r.status)} <small>${CH[r.channel] || r.channel}</small></div>
      <div class="actions">${next} ${closable && M ? html`<button class="btn danger" data-act="reject">Decline</button> <button class="btn" data-act="cancel">Cancel</button>` : ''}</div></div>
    ${!['rejected', 'cancelled'].includes(r.status) ? html`<div class="steps">${STAGES.map(([k, l], i) => html`<span class="${i < step ? 'done' : i === step ? 'now' : ''}">${l}</span>`)}</div>` : html`<div class="note crit"><b>${label(r.status)}:</b> ${r.reject_reason}</div>`}
    <div class="grid g2"><div class="card"><h2>Application</h2><dl class="kv"><dt>Phone</dt><dd>${r.phone || '—'}</dd><dt>Area</dt><dd>${r.area_name || '—'}</dd><dt>Address</dt><dd>${r.address}${r.landmark ? html`<br><small>${r.landmark}</small>` : ''}</dd>
        <dt>Type</dt><dd>${label(r.customer_type)}${r.household_size ? ` · ${r.household_size} people` : ''}</dd><dt>Applied</dt><dd>${fmtDT(r.created_at.replace(' ', 'T') + 'Z')}</dd>
        ${r.distance_m != null ? html`<dt>Survey</dt><dd>${fmtNum(r.distance_m, 0)} m to main${r.survey_notes ? html`<br><small>${r.survey_notes}</small>` : ''}</dd>` : ''}
        ${r.customer_id ? html`<dt>Account</dt><dd><a href="#/customers/${r.customer_id}" class="mono">${r.customer_number}</a></dd>` : ''}
        ${r.survey_wo_id ? html`<dt>Work orders</dt><dd><a href="#/work-orders/${r.survey_wo_id}">Survey</a>${r.install_wo_id ? html` · <a href="#/work-orders/${r.install_wo_id}">Installation</a>` : ''}</dd>` : ''}</dl></div>
      <div class="card"><h2>Quote & financing</h2>${quote ? html`${table([{ label: 'Item', key: 'description' }, { label: 'Amount', cls: 'num', render: l => money(l.amount, cur) }], quote, { foot: html`<tr><th>Total</th><th class="num">${money(r.quote_total, cur)}</th></tr>` })}
        ${r.deposit != null ? html`<dl class="kv" style="margin-top:.6rem"><dt>Deposit</dt><dd>${money(r.deposit, cur)} — paid ${money(d.paid, cur)} ${d.paid + 0.004 >= r.deposit ? badge('paid') : badge('pending', 'due')}</dd>
          <dt>Financed</dt><dd>${r.instalments ? `${r.instalments} monthly instalments of ${money(r.instalment_amount, cur)} on the water bill` : 'None — paid in full'}</dd></dl>` : ''}
        ${d.financed.length ? html`<h3>Instalments</h3>${table([{ label: '#', render: f => `${f.seq}/${f.of_total}` }, { label: 'Month', key: 'due_month' }, { label: 'Amount', cls: 'num', render: f => money(f.amount, f.currency) }, { label: 'Bill', render: f => (f.bill_number ? html`<a href="#/bills/${f.bill_id}" class="mono">${f.bill_number}</a>` : html`<span class="muted">${f.due_month <= new Date().toISOString().slice(0, 7) ? 'next bill' : 'scheduled'}</span>`) }], d.financed)}` : ''}`
        : html`<div class="empty">No quote yet.</div>`}</div></div>
    <div class="card"><h2>Timeline</h2>${table([{ label: 'When', render: e => fmtDT(e.created_at.replace(' ', 'T') + 'Z') }, { label: 'Stage', render: e => stageBadge(e.status) }, { label: 'Note', render: e => e.note || '—' }, { label: 'By', render: e => e.user_name || 'applicant' }], d.events)}</div>`);
  const go = (action, body) => api(`/api/connections/${r.id}/${action}`, { body }).then(x => { toast('Updated — the applicant has been sent an SMS', 'ok'); connection(root, p); return x; });
  bind(root, {
    schedule_survey: () => modal('Book site survey', html`<div class="form">${formFields([{ name: 'assigned_to', label: 'Technician', type: 'select', options: techs.map(s => [s.id, s.full_name]) }, { name: 'due_date', label: 'Survey by', type: 'date' }])}</div>`, { submitLabel: 'Create survey work order', onSubmit: v => go('schedule_survey', v) }),
    record_survey: () => modal('Survey result', html`<div class="form">${formFields([{ name: 'feasible', label: 'Connection is feasible', type: 'checkbox', default: true, full: true }, { name: 'distance_m', label: 'Service pipe length (m)', type: 'number', step: '0.5', min: 0 },
      { name: 'notes', label: 'Notes (pressure, crossing, route; or why not feasible)', type: 'textarea', full: true }])}</div>`, { submitLabel: 'Save survey', onSubmit: v => { if (v.feasible && v.distance_m == null) { toast('Enter the pipe length', 'err'); return false; } return go('record_survey', v); } }),
    quote: () => {
      const lines = d.default_quote.lines.length ? d.default_quote.lines : [{ description: 'Connection fee', amount: '' }];
      const m = modal('Prepare quote', html`<p class="muted">${d.default_quote.note || ''} Amounts in ${cur}.</p><div id="ql"></div><button type="button" class="btn sm" id="qadd">+ Line</button><p style="margin-top:.6rem">Total: <b id="qt"></b></p>`, {
        submitLabel: 'Send quote', onSubmit: () => { const ls = $$('.qrow', m.el).map(x => ({ description: x.querySelector('[data-d]').value.trim(), amount: Number(x.querySelector('[data-a]').value) })).filter(l => l.description && l.amount > 0); if (!ls.length) { toast('Add at least one line', 'err'); return false; } return go('quote', { lines: ls }); } });
      const ql = $('#ql', m.el); const row = l => { const div = document.createElement('div'); div.className = 'qrow'; div.style.cssText = 'display:flex;gap:.4rem;margin-bottom:.4rem'; div.innerHTML = html`<input data-d value="${l.description}" style="flex:1" placeholder="Item"><input data-a type="number" step="0.01" min="0" value="${l.amount}" style="width:8rem" placeholder="Amount"><button type="button" class="btn sm" data-rm>×</button>`.s; ql.appendChild(div); };
      const tot = () => { $('#qt', m.el).textContent = money($$('[data-a]', m.el).reduce((s, x) => s + Number(x.value || 0), 0), cur); };
      lines.forEach(row); tot(); ql.addEventListener('input', tot); ql.addEventListener('click', e => { if (e.target.dataset.rm !== undefined) { e.target.parentElement.remove(); tot(); } }); $('#qadd', m.el).addEventListener('click', () => { row({ description: '', amount: '' }); });
    },
    accept: () => {
      const m = modal('Customer accepts quote', html`<div class="note">Opens the customer account (pending). The deposit is charged to it now; the rest is added to the monthly water bills, starting with the first bill after connection.</div>
        <div class="form">${formFields([{ name: 'deposit', label: `Deposit now (${cur})`, type: 'number', step: '0.01', min: 0, default: Math.round(r.quote_total * 0.25) }, { name: 'instalments', label: `Monthly instalments (max ${d.max_instalments})`, type: 'number', min: 0, max: d.max_instalments, default: Math.min(6, d.max_instalments) }])}<div class="full" id="fin"></div></div>`,
      { submitLabel: 'Open account', onSubmit: v => go('accept', v) });
      const f = m.el.querySelector('form'); const upd = () => { const dep = Number(f.deposit.value || 0), n = Number(f.instalments.value || 0); $('#fin', m.el).innerHTML = n > 0 ? html`<b>${n} × ${money((r.quote_total - dep) / n, cur)}</b> per month on the bill (total financed ${money(r.quote_total - dep, cur)}).`.s : (dep < r.quote_total ? '<span class="crit-t">Without instalments the deposit must cover the full quote.</span>' : 'Paid in full.'); };
      f.addEventListener('input', upd); upd();
    },
    start_install: () => { const unpaid = r.deposit > 0 && d.paid + 0.004 < r.deposit; const mgr = ['manager', 'admin'].includes(state.user.role);
      modal('Book installation', html`${unpaid ? html`<div class="note warn">Deposit not yet paid (${money(d.paid, cur)} of ${money(r.deposit, cur)}).${mgr ? ' You can override with a reason (recorded in the audit log).' : ' A manager must approve an override.'}</div>` : ''}<div class="form">${formFields([{ name: 'assigned_to', label: 'Technician', type: 'select', options: techs.map(s => [s.id, s.full_name]) }, { name: 'due_date', label: 'Install by', type: 'date' },
        ...(unpaid && mgr ? [{ name: 'override_reason', label: 'Override reason', type: 'textarea', full: true, required: true }] : [])])}</div>`, { submitLabel: 'Create installation work order', onSubmit: v => go('start_install', v) }); },
    complete: () => { if (!d.meters_in_stock.length) return toast('No meters in stock — register the meter first (Meters › Add)', 'err');
      modal('Connect', html`<div class="form">${formFields([{ name: 'meter_id', label: 'Meter installed', type: 'select', required: true, options: d.meters_in_stock.map(m => [m.id, `${m.serial_number} — ${m.manufacturer} ${m.model} ${m.size_mm} mm`]) }, { name: 'initial_reading', label: 'Initial reading (m³)', type: 'number', step: '0.001', min: 0, default: 0, required: true }])}</div>
        <div class="note">The account becomes active, the meter is assigned, and ${r.instalments || 0} instalment(s) are scheduled.</div>`, { submitLabel: 'Connect customer', onSubmit: v => go('complete', v) }); },
    reject: async () => { const reason = await confirmBox('Decline application', 'The applicant will be told by SMS.', { reason: true, danger: true, ok: 'Decline' }); if (reason) await go('reject', { reason }); },
    cancel: async () => { const reason = await confirmBox('Cancel application', 'For example: applicant withdrew.', { reason: true, ok: 'Cancel application' }); if (reason) await go('cancel', { reason }); }
  });
}

// ======================= Shared compound connection (customer tab) =======================
export async function sharedPanel(el, c) {
  const s = await api(`/api/customers/${c.id}/shared`);
  const editable = can('customers.manage') || can('shared.manage');
  if (!s) { mount(el, html`<div class="card"><h2>Shared compound connection</h2><p>Several households on one meter? Split each bill fairly — equally, by household size or by fixed percentages — and give every household its own SMS and mobile-money reference so each can pay its part.</p>
    ${editable ? html`<button class="btn primary" data-act="sh_edit">Set up sharing</button>` : html`<p class="muted">Not shared.</p>`}</div>`); bind(el, { sh_edit: () => editShared(c, null, () => sharedPanel(el, c)) }); return; }
  const cur = c.currency;
  mount(el, html`<div class="grid g2"><div class="card"><h2>Households ${s.active ? badge('active') : badge('disabled')}</h2><p class="muted">Split: <b>${label(s.split_method)}</b>. Each household pays by mobile money with its own reference.</p>
      ${table([{ label: '#', key: 'seq' }, { label: 'Household', render: m => html`${m.name}${m.active ? '' : html` ${badge('removed')}`}` }, { label: 'People / %', render: m => (s.split_method === 'fixed_pct' ? `${m.share_pct}%` : s.split_method === 'household_size' ? m.household_size : 'equal') },
        { label: 'MoMo ref', render: m => html`<span class="mono" style="white-space:nowrap">${c.customer_number}-${m.seq}</span>` }, { label: 'Owes', cls: 'num', render: m => money(m.owed, cur) },
        { label: '', render: m => (m.active && m.owed > 0 && can('payments.create') ? html`<button class="btn sm" data-act="sh_pay" data-id="${m.id}">Cash payment</button>` : '') }], s.members)}
      ${editable ? html`<p><button class="btn" data-act="sh_edit">Edit households</button></p>` : ''}
      <div class="note">The account holder stays responsible for the account; shares help each household pay its part. Payments always reduce the account balance.</div></div>
    <div class="card"><h2>Recent bills split</h2>${s.bills.some(b => b.shares.length) ? s.bills.filter(b => b.shares.length).map(b => html`<h3 style="margin:.6rem 0 .2rem"><a href="#/bills/${b.id}" class="mono">${b.bill_number}</a> · ${money(b.total, b.currency)} ${badge(b.status)}</h3>
      ${b.shares.length ? table([{ label: 'Household', render: x => `${x.seq}. ${x.name}` }, { label: 'Share', cls: 'num', render: x => money(x.amount, b.currency) }, { label: 'Paid', cls: 'num', render: x => html`${money(x.paid, b.currency)} ${x.paid + 0.004 >= x.amount ? badge('paid') : ''}` }], b.shares) : html`<p class="muted">Issued before sharing was set up.</p>`}`) : html`<div class="empty">No bills split yet — the next bill will be.</div>`}
      ${s.bills.some(b => !b.shares.length) ? html`<p class="muted" style="font-size:.85rem">${s.bills.filter(b => !b.shares.length).length} earlier bill(s) were issued before sharing was set up.</p>` : ''}</div></div>`);
  bind(el, { sh_edit: () => editShared(c, s, () => sharedPanel(el, c)),
    sh_pay: b => { const m = s.members.find(x => x.id === Number(b.dataset.id));
      modal(`Payment — ${m.name}`, html`<div class="form">${formFields([{ name: 'amount', label: `Amount (${cur})`, type: 'number', step: '0.01', min: 0.01, required: true, default: m.owed }, { name: 'method', label: 'Method', type: 'select', blank: false, options: payMethods().filter(m => m[0] !== 'cheque' && m[0] !== 'other') }, { name: 'reference', label: 'Reference (non-cash)' }])}</div>`,
        { submitLabel: 'Record payment', onSubmit: async v => { const r = await api(`/api/customers/${c.id}/shared/pay`, { body: { ...v, member_id: m.id } }); toast(`Receipt ${r.receipt_number} — ${money(r.credited_to_share, cur)} credited to ${m.name}`, 'ok'); sharedPanel(el, c); } }); } });
}

function editShared(c, s, done) {
  const members = s ? s.members.filter(m => m.active) : [{ name: '', household_size: '' }, { name: '', household_size: '' }];
  const m = modal('Shared compound connection', html`<div class="form">${formFields([{ name: 'split_method', label: 'How to split each bill', type: 'select', blank: false, default: s ? s.split_method : 'household_size', options: [['household_size', 'By number of people'], ['equal', 'Equally'], ['fixed_pct', 'Fixed percentages']] },
    { name: 'active', label: 'Sharing switched on', type: 'checkbox', default: s ? !!s.active : true }])}</div>
    <table class="t" style="margin-top:.5rem"><thead><tr><th>Household name</th><th>Phone (for SMS)</th><th>People</th><th>%</th><th></th></tr></thead><tbody id="mb"></tbody></table><button type="button" class="btn sm" id="madd">+ Household</button>
    <p class="muted" style="margin-top:.5rem">The current unpaid bill is split as soon as you save. New bills are split automatically.</p>`, { wide: true, submitLabel: 'Save', onSubmit: async v => {
      const ms = $$('#mb tr', m.el).map(tr => ({ seq: tr.dataset.seq ? Number(tr.dataset.seq) : undefined, name: tr.querySelector('[data-n]').value.trim(), phone: tr.querySelector('[data-p]').value.trim() || null, household_size: Number(tr.querySelector('[data-h]').value) || null, share_pct: tr.querySelector('[data-s]').value === '' ? null : Number(tr.querySelector('[data-s]').value) })).filter(x => x.name);
      await api(`/api/customers/${c.id}/shared`, { method: 'PUT', body: { split_method: v.split_method, active: v.active, members: ms } }); toast('Shared connection saved — households notified of their shares by SMS', 'ok'); done(); } });
  const mb = $('#mb', m.el);
  const row = x => { const tr = document.createElement('tr'); if (x.seq) tr.dataset.seq = x.seq; tr.innerHTML = html`<td><input data-n value="${x.name || ''}"></td><td><input data-p value="${x.phone || ''}" placeholder="${phoneHint()}"></td><td><input data-h type="number" min="1" style="width:5rem" value="${x.household_size || ''}"></td><td><input data-s type="number" min="0" max="100" step="0.1" style="width:5rem" value="${x.share_pct ?? ''}"></td><td><button type="button" class="btn sm" data-rm>×</button></td>`.s; mb.appendChild(tr); };
  members.forEach(row); $('#madd', m.el).addEventListener('click', () => row({})); mb.addEventListener('click', e => { if (e.target.dataset.rm !== undefined) e.target.closest('tr').remove(); });
}

// ======================= Performance indicators =======================
const CATS = [['energy_fuel', 'Fuel for pumps/generator'], ['electricity', 'Electricity'], ['chemicals', 'Chemicals (chlorine…)'], ['staff', 'Staff'], ['repairs', 'Repairs & parts'], ['transport', 'Transport'], ['admin', 'Office & admin'], ['other', 'Other']];
const fmtK = (v, unit, cur) => (v == null ? html`<span class="muted">n/a</span>` : unit === '%' ? `${fmtNum(v, 1)}%` : unit === '×' ? `${fmtNum(v, 2)}×` : unit === 'cur/m³' ? `${money(v, cur)}/m³` : unit === 'h' ? `${fmtNum(v, 1)} h` : unit === '/5' ? `${fmtNum(v, 2)} / 5` : fmtNum(v, Number.isInteger(v) ? 0 : 1));

export async function kpi(root, _p, q) {
  const L = await ensureLookups();
  const d = await api('/api/kpi' + qs({ from: q.from, to: q.to, area_id: q.area_id }));
  const order = ['om_coverage', 'cash_coverage', 'collection_pct', 'nrw_pct', 'metering_pct', 'unit_cost_produced', 'unit_cost_billed', 'avg_tariff', 'staff_per_1000', 'supply_hours', 'supply_reliability_pct', 'wq_compliance_pct', 'satisfaction_avg', 'reading_completion_pct', 'complaint_hours', 'connections', 'new_connections'];
  const M = can('kpi.manage');
  mount(root, html`<div class="page-head"><div><h1>Cost recovery & performance</h1><small>Standard utility indicators (IBNET-style) from the system's own bills, payments, readings and the running costs you enter. Use them for board reports, regulators and funders.</small></div>
    <div class="actions"><button class="btn" data-act="csv">Export CSV</button>${M ? html`<button class="btn primary" data-act="cost">Add running cost</button> <button class="btn" data-act="inputs">Staff & supply hours</button>` : ''}</div></div>
    <form class="filters" id="kf"><label>From<input type="month" name="from" value="${d.from}"></label><label>To<input type="month" name="to" value="${d.to}"></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Show</button></form>
    ${d.areas.map(a => html`<div class="card"><h2>${a.area} <small class="muted">${a.currency} · ${d.from} to ${d.to}</small></h2>
      <div class="grid g4" style="margin-bottom:.8rem"><div class="kpi"><div class="label">Billed</div><div class="value">${money(a.billed, a.currency)}</div></div><div class="kpi"><div class="label">Collected</div><div class="value">${money(a.collected, a.currency)}</div></div>
        <div class="kpi"><div class="label">Running (O&M) costs</div><div class="value">${a.om_cost ? money(a.om_cost, a.currency) : '—'}</div></div><div class="kpi"><div class="label">Cost coverage</div><div class="value ${a.status.om_coverage === 'bad' ? 'crit-t' : ''}">${a.values.om_coverage == null ? '—' : fmtNum(a.values.om_coverage, 2) + '×'}</div></div></div>
      ${table([{ label: 'Indicator', render: k => html`<b>${d.labels[k][0]}</b><br><small class="muted">${d.labels[k][2]}</small>` }, { label: 'Value', cls: 'num', render: k => fmtK(a.values[k], d.labels[k][1], a.currency) },
        { label: 'Target', cls: 'num', render: k => (d.targets[k] ? html`${d.targets[k].direction === 'min' ? '≥' : '≤'} ${fmtNum(d.targets[k].target, d.targets[k].target % 1 ? 1 : 0)}${M ? html` <button class="btn sm" data-act="target" data-k="${k}">✎</button>` : ''}` : '') },
        { label: '', render: k => (a.status[k] === 'good' ? badge('good', 'on target') : a.status[k] === 'bad' ? badge('overdue', 'off target') : '') }], order.filter(k => k in a.values))}
      ${a.notes.length ? html`<div class="note warn" style="margin-top:.6rem">${a.notes.map(n => html`<div>• ${n}</div>`)}</div>` : ''}
      ${a.costs_by_category.length ? html`<h3>Running costs by category</h3>${table([{ label: 'Category', render: x => (CATS.find(c => c[0] === x.category) || [0, x.category])[1] }, { label: 'Amount', cls: 'num', render: x => money(x.amount, x.currency) }], a.costs_by_category)}` : ''}</div>`)}
    <div class="card"><h2>Running-cost entries</h2><div id="costs"></div></div>
    <p class="muted" style="font-size:.85rem">Default targets are indicative for small piped systems — set your own (✎). ${state.mode === 'demo' ? 'Demo figures are fictional.' : ''}</p>`);
  api('/api/om-costs').then(rows => mount($('#costs', root), table([{ label: 'Month', key: 'period' }, { label: 'Area', key: 'area_name' }, { label: 'Category', render: x => (CATS.find(c => c[0] === x.category) || [0, x.category])[1] }, { label: 'Amount', cls: 'num', render: x => money(x.amount, x.currency) }, { label: 'Note', render: x => x.notes || '—' }, { label: 'By', render: x => x.entered_by_name || '—' }], rows, { empty: 'No running costs entered yet. Add fuel, chlorine, wages and repairs each month to see whether tariffs cover costs.' })));
  $('#kf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/performance' + qs(Object.fromEntries(new FormData(e.target))); });
  const month = d.to;
  bind(root, {
    csv: () => download('/api/kpi' + qs({ from: d.from, to: d.to, area_id: q.area_id, format: 'csv' })),
    cost: () => modal('Add running cost', html`<div class="form">${formFields([{ name: 'area_id', label: 'Area', type: 'select', required: true, options: L.areas.map(a => [a.id, a.name]) }, { name: 'period', label: 'Month', type: 'month', required: true, default: month },
      { name: 'category', label: 'Category', type: 'select', required: true, options: CATS }, { name: 'amount', label: 'Amount', type: 'number', step: '0.01', min: 0, required: true }, { name: 'currency', label: 'Currency', type: 'select', blank: false, options: currencies() }, { name: 'notes', label: 'Note (e.g. 200 L diesel)', full: true }])}</div>`,
      { onSubmit: async v => { await api('/api/om-costs', { body: v }); toast('Cost recorded', 'ok'); kpi(root, _p, q); } }),
    inputs: () => modal('Staff & hours of supply', html`<div class="form">${formFields([{ name: 'area_id', label: 'Area', type: 'select', required: true, options: L.areas.map(a => [a.id, a.name]) }, { name: 'period', label: 'Month', type: 'month', required: true, default: month },
      { name: 'staff_count', label: 'Staff (full-time equivalent)', type: 'number', step: '0.5', min: 0 }, { name: 'supply_hours_per_day', label: 'Average hours of supply per day', type: 'number', step: '0.5', min: 0, max: 24 }])}</div>`,
      { onSubmit: async v => { await api('/api/kpi-inputs', { method: 'PUT', body: v }); toast('Saved', 'ok'); kpi(root, _p, q); } }),
    target: b => { const k = b.dataset.k; const t = d.targets[k]; modal('Target — ' + d.labels[k][0], html`<div class="form">${formFields([{ name: 'direction', label: 'Good when the value is', type: 'select', blank: false, default: t.direction, options: [['min', 'at least'], ['max', 'at most']] }, { name: 'target', label: 'Target', type: 'number', step: 'any', required: true, default: t.target }])}</div>`,
      { onSubmit: async v => { await api('/api/kpi-targets/' + k, { method: 'PUT', body: v }); toast('Target saved', 'ok'); kpi(root, _p, q); } }); }
  });
}

// ======================= Bulk onboarding =======================
export async function onboarding(root) {
  const KINDS = [['customers', 'Customers', 'Your existing customer list. Keep your old account numbers in legacy_ref so re-importing never creates duplicates and payments can still quote the old number.'],
    ['meters', 'Meters', 'Serial numbers and make/model. Give customer_ref (old number or new account number) to assign the meter and set its starting reading.'],
    ['balances', 'Opening balances', 'What each customer owed (positive) or had in credit (negative) on the day you switch over. Recorded as an approved opening-balance adjustment.']];
  mount(root, html`<div class="page-head"><div><h1>Bring in existing records</h1><small>Move a utility's paper or spreadsheet ledger into AquaTrack: customers → meters → opening balances. Every file is checked first; nothing is saved until you confirm, and a file is imported all-or-nothing.</small></div></div>
    <div class="grid g3">${KINDS.map(([k, l, t], i) => html`<div class="card"><h2>${i + 1}. ${l}</h2><p>${t}</p><button class="btn" data-act="tpl" data-k="${k}">Download template</button></div>`)}</div>
    <div class="card"><h2>Check a file</h2><form class="form" id="of"><label class="f"><span class="req">What is in the file</span><select name="kind">${KINDS.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
      <label class="f"><span class="req">CSV file</span><input type="file" name="file" accept=".csv,text/csv" required></label><div class="full"><button class="btn primary">Check file</button></div></form><div id="res"></div></div>
    ${state.mode === 'demo' ? html`<div class="note warn">Demo system: imported records are stored in the demo database only. Use fictional records.</div>` : ''}`);
  let last = null;
  const show = r => {
    mount($('#res', root), html`<div class="grid g4" style="margin:.8rem 0"><div class="kpi"><div class="label">Rows</div><div class="value">${r.total}</div></div><div class="kpi"><div class="label">Ready to import</div><div class="value">${r.ready}</div></div>
      <div class="kpi"><div class="label">Already imported (skipped)</div><div class="value">${r.skip}</div></div><div class="kpi"><div class="label">With errors</div><div class="value ${r.errors ? 'crit-t' : ''}">${r.errors}</div></div></div>
      ${r.committed ? html`<div class="note good"><b>Imported ${r.created} record(s).</b> Logged in the audit trail.</div>` : r.errors ? html`<div class="note crit">Fix the rows with errors in your spreadsheet and check the file again. Nothing has been imported.</div>` : r.ready ? html`<p><button class="btn primary" data-act="commit">Import ${r.ready} record(s)</button></p>` : html`<div class="note">Nothing new to import.</div>`}
      ${r.rows ? table([{ label: 'Row', key: 'row' }, { label: 'Record', render: x => html`<span class="mono">${x.key || '—'}</span>` }, { label: 'Result', render: x => (x.errors.length ? html`<span class="crit-t">${x.errors.join('; ')}</span>` : x.skip ? html`<span class="muted">${x.warnings.join('; ')}</span>` : html`${badge('good', 'ok')} <small class="muted">${x.warnings.join('; ')}</small>`) }],
        r.rows.filter(x => x.errors.length || x.warnings.length || r.total <= 50)) : ''}`);
  };
  $('#of', root).addEventListener('submit', async e => { e.preventDefault(); const f = e.target; const file = f.file.files[0]; if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast('File too large (max 8 MB) — split it', 'err');
    last = { kind: f.kind.value, content: await file.text(), filename: file.name };
    try { show(await api('/api/onboarding/import', { body: last })); } catch (err) { toast(err.message, 'err'); mount($('#res', root), html`<div class="note crit">${err.message}</div>`); } });
  bind(root, { tpl: b => download('/api/onboarding/template/' + b.dataset.k),
    commit: async () => { if (!(await confirmBox('Import records', 'This writes the records to the database. It can be checked in the audit log.', { ok: 'Import' }))) return; show(await api('/api/onboarding/import', { body: { ...last, commit: true } })); state.lookups = null; } });
}

// ======================= My security =======================
export async function security(root) {
  const [t, sessions] = await Promise.all([api('/api/auth/2fa'), api('/api/auth/sessions')]);
  const enforced = state.user.needs_2fa_setup;
  mount(root, html`<div class="page-head"><div><h1>My sign-in security</h1><small>Protect your account with an authenticator app, and sign out devices you no longer use.</small></div></div>
    ${enforced ? html`<div class="note warn"><b>Your role requires two-factor sign-in.</b> Set it up below to continue using AquaTrack.</div>` : ''}
    <div class="grid g2"><div class="card"><h2>Two-factor sign-in ${t.enabled ? badge('active', 'on') : badge('disabled', 'off')}</h2>
      ${t.enabled ? html`<p>After your password, AquaTrack asks for the 6-digit code from your authenticator app. ${t.recovery_codes_left} recovery code(s) left.</p>${t.recovery_codes_left < 3 ? html`<div class="note warn">Few recovery codes left — turn 2FA off and on again to get new ones.</div>` : ''}
        ${t.required ? html`<p class="muted">Required for your role — it cannot be turned off.</p>` : html`<button class="btn danger" data-act="off">Turn off</button>`}`
      : html`<p>Use any authenticator app (Google Authenticator, Microsoft Authenticator, FreeOTP, Aegis…). It works offline on the phone — no SMS needed.</p><button class="btn primary" data-act="setup">Set up two-factor sign-in</button><div id="su"></div>`}</div>
    <div class="card"><h2>Signed-in devices</h2>${table([{ label: 'Device', render: s => html`${(s.device || 'unknown').slice(0, 70)}${s.current ? html` ${badge('active', 'this device')}` : ''}` }, { label: 'IP', render: s => s.ip || '—' }, { label: 'Signed in', render: s => fmtDT(s.created_at) },
      { label: '', render: s => (s.current ? '' : html`<button class="btn sm" data-act="revoke" data-id="${s.id}">Sign out</button>`) }], sessions)}
      ${sessions.length > 1 ? html`<p><button class="btn" data-act="others">Sign out all other devices</button></p>` : ''}</div></div>`);
  bind(root, {
    setup: async () => { const s = await api('/api/auth/2fa/setup', { body: {} });
      mount($('#su', root), html`<ol><li>In your authenticator app, add an account and choose <b>enter a setup key</b>.</li><li>Account: <b>${state.user.username}</b>, key: <code class="mono" style="font-size:1.05rem;user-select:all">${s.secret.replace(/(.{4})/g, '$1 ').trim()}</code>, type: time-based.<br><small>On a phone, you can also <a href="${s.otpauth}">open it in the authenticator app</a>.</small></li><li>Enter the 6-digit code it shows:</li></ol>
        <form id="en" style="display:flex;gap:.5rem"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required placeholder="123456" style="width:8rem;font-size:1.2rem"><button class="btn primary">Turn on</button></form>`);
      $('#en', root).addEventListener('submit', async e => { e.preventDefault(); try { const r = await api('/api/auth/2fa/enable', { body: { code: e.target.code.value } }); state.user.needs_2fa_setup = false; state.user.two_factor = true;
        modal('Save your recovery codes', html`<div class="note warn">${r.note}</div><pre class="mono" style="font-size:1.1rem;line-height:1.7;user-select:all">${r.recovery_codes.join('\n')}</pre>`, { submitLabel: 'I have saved them', onSubmit: () => security(root) }); } catch (err) { toast(err.message, 'err'); } }); },
    off: () => modal('Turn off two-factor sign-in', html`<div class="form">${formFields([{ name: 'password', label: 'Password', type: 'password', required: true, full: true }, { name: 'code', label: 'Authenticator or recovery code', required: true, full: true }])}</div>`, { danger: true, submitLabel: 'Turn off', onSubmit: async v => { await api('/api/auth/2fa/disable', { body: v }); state.user.two_factor = false; toast('Two-factor sign-in turned off', 'ok'); security(root); } }),
    revoke: async b => { await api(`/api/auth/sessions/${b.dataset.id}/revoke`, { body: {} }); toast('Device signed out', 'ok'); security(root); },
    others: async () => { const r = await api('/api/auth/sessions/revoke-others', { body: {} }); toast(`${r.revoked} other device(s) signed out`, 'ok'); security(root); }
  });
}
