// Humane collections: escalation ladder, payment plans and reminders. Nothing is disconnected automatically.
import { api, html, raw, mount, $, state, qs, can, money, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, confirmBox, today } from '../core.js';
import { ensureLookups } from './dashboard.js';

const STAGE_CLS = { reminder: 'info', contact: 'warn', offer_plan: 'serious', review: 'crit', escalate: 'sim', on_plan: 'good' };
const HEALTH = { on_track: ['good', 'On track'], behind: ['warn', 'Behind'], at_risk: ['crit', 'At risk'], completed: ['good', 'Completed'], defaulted: ['crit', 'Defaulted'], cancelled: ['outline', 'Cancelled'] };

export async function planForm(customerId, done) {
  const m = modal('Offer a payment plan', html`<div class="note">Spread the arrears into affordable instalments. The customer gets an SMS with the schedule and a reminder before each instalment. Escalation pauses while the plan is on track.</div>
    <div class="form">${formFields([{ name: 'down_payment', label: 'Down payment now (optional)', type: 'number', step: '0.01', default: 0 }, { name: 'instalments', label: 'Number of instalments', type: 'number', required: true, default: 4, min: 1, max: 36 },
      { name: 'frequency', label: 'Frequency', type: 'select', options: [['monthly', 'Monthly'], ['weekly', 'Weekly']], blank: false }, { name: 'start_date', label: 'First instalment', type: 'date', default: today() },
      { name: 'notes', label: 'Agreed with / notes', type: 'textarea', full: true }])}<div class="full" id="sched"></div></div>`, {
    submitLabel: 'Agree plan', onSubmit: async v => { await api('/api/plans', { body: { ...v, customer_id: customerId } }); toast('Payment plan agreed — SMS sent to customer', 'ok'); done && done(); } });
  const f = m.el.querySelector('form');
  const preview = async () => { try { const v = { customer_id: customerId, down_payment: Number(f.down_payment.value || 0), instalments: Number(f.instalments.value || 1), frequency: f.frequency.value, start_date: f.start_date.value || undefined };
    const r = await api('/api/plans/preview', { body: v }); m.el.querySelector('#sched').innerHTML = html`<p>Arrears: <b>${fmtNum(r.arrears)}</b></p>${table([{ label: '#', key: 'seq' }, { label: 'Due', render: s => fmtDate(s.due_date) }, { label: 'Amount', cls: 'num', render: s => fmtNum(s.amount) }], r.schedule)}`.s; } catch (e) { m.el.querySelector('#sched').textContent = e.message; } };
  ['down_payment', 'instalments', 'frequency', 'start_date'].forEach(n => f[n].addEventListener('change', preview)); preview();
}

export async function view(root, _p, q) {
  const tab = q.tab || 'ladder';
  mount(root, html`<div class="page-head"><div><h1>Collections</h1><small>Remind early, talk, offer a plan — and only then, a manager-reviewed decision. Essential services are never put forward for disconnection.</small></div>
    <div class="actions">${can('reminders.run') ? html`<button class="btn" data-act="remind">Send due reminders now</button>` : ''}</div></div>
    <div class="tabs">${[['ladder', 'Escalation ladder'], ['plans', 'Payment plans']].map(([k, l]) => html`<a href="#/collections?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="ct"></div>`);
  bind(root, { remind: async () => { const r = await api('/api/collections/reminders', { body: {} }); toast(`Reminders sent: ${r.due_soon} before due, ${r.overdue} overdue, ${r.instalment} plan instalments (each sent once)`, 'ok'); } });
  const el = $('#ct', root);
  return tab === 'plans' ? plans(el, q) : ladder(el, q);
}

async function ladder(el, q) {
  const L = await ensureLookups();
  const d = await api('/api/collections/ladder' + qs({ area_id: q.area_id }));
  const count = s => d.rows.filter(r => r.stage === s).length;
  mount(el, html`<div class="grid g3" style="margin-bottom:1rem">${Object.entries(d.stages).map(([k, l]) => html`<div class="kpi"><div class="label">${l}</div><div class="value"><span class="badge ${STAGE_CLS[k]}" style="font-size:1.1rem">${count(k)}</span></div></div>`)}</div>
    <form class="filters" id="lf"><input type="hidden" name="tab" value="ladder"><label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label><button class="btn primary">Filter</button>
      <span class="muted" style="font-size:.8rem;align-self:center">Reminders last sent: ${d.last_reminders_run || 'never'}</span></form>
    <div class="card flush">${table([{ label: 'Stage', render: r => html`<span class="badge ${STAGE_CLS[r.stage]}">${r.stage_label}</span>${r.essential ? html`<br><span class="badge sim">essential service</span>` : ''}` },
      { label: 'Customer', render: r => html`<a href="#/customers/${r.customer_id}">${r.name}</a><br><small class="mono">${r.customer_number}</small> · <small>${label(r.customer_type)}</small>` },
      { label: 'Owes', cls: 'num', render: r => html`<b>${money(r.balance, r.currency)}</b><br><small>avg bill ${money(r.avg_bill, r.currency)}</small>` }, { label: 'Oldest overdue', cls: 'num', render: r => `${r.oldest_days_overdue} days` },
      { label: 'Last payment', render: r => html`${fmtDate(r.last_payment)}${r.paying_recently ? html`<br><span class="badge good">paying</span>` : ''}` }, { label: 'Contact', render: r => html`${r.phone ? '📱' : html`<span class="badge warn">no phone</span>`} <small>${r.reminders} SMS</small>` },
      { label: 'Plan', render: r => (r.plan ? html`<span class="badge ${HEALTH[r.plan.health][0]}">${HEALTH[r.plan.health][1]}</span><div class="bar"><span style="width:${raw(r.plan.progress_pct)}%"></span></div>` : '—') },
      { label: '', render: r => html`${!r.plan && can('plans.manage') ? html`<button class="btn sm primary" data-act="plan" data-id="${r.customer_id}">Offer plan</button> ` : ''}${r.stage === 'review' && can('collections.manage') ? (r.review_wo ? html`<span class="badge info">${r.review_wo}</span>` : html`<button class="btn sm danger" data-act="review" data-id="${r.customer_id}">Manager review</button>`) : ''}` }], d.rows, { empty: 'No customers in arrears.' })}</div>`);
  $('#lf', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/collections' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, {
    plan: b => planForm(Number(b.dataset.id), () => ladder(el, q)),
    review: async b => { const note = await confirmBox('Request disconnection review', 'A manager must review before any action. Record what has been tried (reminders sent, calls/visits, plan offered) and any vulnerability concerns.', { reason: true, reasonLabel: 'Steps taken so far', danger: true, ok: 'Create review' });
      if (!note) return; const r = await api('/api/collections/review', { body: { customer_id: Number(b.dataset.id), note } }); toast('Review work order ' + r.wo_number + ' created for a manager', 'ok'); ladder(el, q); }
  });
}

async function plans(el, q) {
  const rows = await api('/api/plans' + qs({ status: q.status }));
  mount(el, html`<div class="card flush">${table([{ label: 'Customer', render: p => html`<a href="#/customers/${p.customer_id}">${p.customer_name}</a><br><small class="mono">${p.customer_number}</small>` },
    { label: 'Arrears', cls: 'num', render: p => money(p.arrears, p.currency) }, { label: 'Plan', render: p => `${p.down_payment ? money(p.down_payment, p.currency) + ' down + ' : ''}${p.instalments} × ${p.frequency}` },
    { label: 'Paid', cls: 'num', render: p => html`${money(p.paid, p.currency)}<div class="bar"><span style="width:${raw(p.progress_pct)}%"></span></div>` }, { label: 'Behind', cls: 'num', render: p => (p.behind ? money(p.behind, p.currency) : '—') },
    { label: 'Status', render: p => html`<span class="badge ${HEALTH[p.health][0]}">${HEALTH[p.health][1]}</span>` }, { label: '', render: p => html`<button class="btn sm" data-act="show" data-id="${p.id}">Schedule</button>` }], rows, { empty: 'No payment plans yet. Offer one from the escalation ladder.' })}</div>`);
  bind(el, { show: b => { const p = rows.find(x => x.id === Number(b.dataset.id));
    const m = modal(`Payment plan — ${p.customer_name}`, html`<p>Started ${fmtDate(p.start_date)} · ${HEALTH[p.health][1]} · paid ${money(p.paid, p.currency)} of ${money(p.arrears, p.currency)}</p>${table([{ label: '#', key: 'seq' }, { label: 'Due', render: i => fmtDate(i.due_date) },
      { label: 'Amount', cls: 'num', render: i => money(i.amount, p.currency) }, { label: 'Covered', cls: 'num', render: i => money(i.paid, p.currency) }, { label: 'Status', render: i => badge(i.status === 'paid' ? 'paid' : i.status === 'overdue' ? 'overdue' : i.status === 'part_paid' ? 'partially_paid' : 'issued', label(i.status)) }], p.instalments)}
      ${p.status === 'active' && can('plans.manage') ? html`<p><button class="btn danger" id="cxl">Cancel plan</button></p>` : ''}`, { wide: true });
    const c = m.el.querySelector('#cxl'); if (c) c.addEventListener('click', async () => { const reason = prompt('Reason for cancelling'); if (!reason) return; await api(`/api/plans/${p.id}/cancel`, { body: { reason } }); m.close(); plans(el, q); }); } });
}
