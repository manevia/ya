import { api, html, raw, mount, $, state, qs, can, money, fmtM3, fmtDate, fmtDT, fmtNum, label, badge, table, modal, formFields, toast, bind, simBadge, estBadge, confirmBox, today, daysAgo, currencies, payMethods } from '../core.js';
import { ensureLookups } from './dashboard.js';

const demoMark = () => (state.mode === 'demo' ? html`<span class="watermark">DEMO — NOT A REAL ${'DOCUMENT'}</span>` : '');

export async function bills(root, _p, q) {
  const L = await ensureLookups();
  const rows = await api('/api/bills' + qs(q));
  mount(root, html`<div class="page-head"><div><h1>Bills</h1><small>${rows.length} bills</small></div><div class="actions">${can('billing.generate') ? html`<a class="btn primary" href="#/billing/generate">Generate bills</a>` : ''}<a class="btn" href="/api/reports/bills${qs({ from: q.from, to: q.to, area_id: q.area_id })}">Export CSV</a></div></div>
    <form class="filters" id="bf"><label>Search<input name="q" value="${q.q || ''}" placeholder="Bill no., customer"></label>
      <label>Status<select name="status"><option value="">All</option>${['issued', 'partially_paid', 'paid', 'overdue', 'cancelled'].map(s => html`<option value="${s}"${s === q.status ? raw(' selected') : ''}>${label(s)}</option>`)}</select></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label>
      <label>Period end from<input type="date" name="from" value="${q.from || ''}"></label><label>to<input type="date" name="to" value="${q.to || ''}"></label><button class="btn primary">Filter</button></form>
    <div class="card flush">${table([{ label: 'Bill no.', render: b => html`<span class="mono">${b.bill_number}</span>` }, { label: 'Customer', render: b => html`${b.customer_name}<br><small class="mono">${b.customer_number}</small>` },
      { label: 'Period', render: b => `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` }, { label: 'Use', cls: 'num', render: b => html`${fmtM3(b.consumption)}${b.is_estimated ? html`<br>${estBadge()}` : ''}${b.is_simulated ? html`<br>${simBadge()}` : ''}` },
      { label: 'Total', cls: 'num', render: b => money(b.total, b.currency) }, { label: 'Paid', cls: 'num', render: b => money(b.paid, b.currency) }, { label: 'Due', render: b => fmtDate(b.due_date) }, { label: 'Status', render: b => badge(b.status) }], rows, { href: b => '#/bills/' + b.id })}</div>`);
  $('#bf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/billing' + qs(Object.fromEntries(new FormData(e.target))); });
}

export async function generate(root) {
  const L = await ensureLookups();
  const d = new Date(); const firstPrev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  mount(root, html`<div class="crumbs"><a href="#/billing">Bills</a> ›</div><div class="page-head"><h1>Generate bills</h1></div>
    <div class="card"><div class="note">Bills are calculated from <b>approved</b> readings only, using the tariff in force for each customer's type, area and meter size. Review pending readings first. Always preview before issuing.</div>
    <form id="gf" class="form">${formFields([{ name: 'period_start', label: 'Billing period start', type: 'date', required: true, default: firstPrev }, { name: 'period_end', label: 'Billing period end', type: 'date', required: true, default: lastDay > today() ? today() : lastDay },
      { name: 'area_id', label: 'Service area', type: 'select', options: L.areas.map(a => [a.id, `${a.name} (${a.currency})`]), blank: 'All areas' }, { name: 'due_days', label: 'Days until due', type: 'number', placeholder: 'Default from settings' },
      { name: 'estimate_missing', label: 'Estimate accounts with no approved reading (from average use; bill clearly marked ESTIMATED)', type: 'checkbox', full: true }])}
      <div class="full"><button class="btn primary" type="submit">Preview bills</button></div></form></div><div id="gout"></div>`);
  let last = null;
  const run = async commit => {
    const v = Object.fromEntries(new FormData($('#gf', root))); v.estimate_missing = $('#gf', root).estimate_missing.checked; v.commit = commit;
    v.area_id = v.area_id ? Number(v.area_id) : null; v.due_days = v.due_days ? Number(v.due_days) : null;
    const r = await api('/api/bills/generate', { body: v }); last = v;
    const ok = r.results.filter(x => x.status === 'ok'); const sk = r.results.filter(x => x.status !== 'ok');
    const totals = {}; ok.forEach(x => { totals[x.currency] = (totals[x.currency] || 0) + x.total; });
    $('#gout', root).innerHTML = html`<div class="card"><div class="card-head"><h2>${commit ? `Issued ${ok.length} bills` : `Preview: ${ok.length} bills ready, ${sk.length} skipped`}</h2>
      ${!commit && ok.length ? html`<button class="btn primary" data-act="commit">Issue ${ok.length} bills</button>` : ''}</div>
      <p>${Object.entries(totals).map(([c, t]) => html`<b>${money(t, c)}</b> `)}${ok.some(x => x.estimated) ? html` ${estBadge()} some bills are estimated` : ''}${ok.some(x => x.simulated) ? html` ${simBadge()} some bills use simulated readings` : ''}</p>
      ${table([{ label: 'Customer', render: x => html`${x.name}<br><small class="mono">${x.customer_number}</small>` }, { label: 'Tariff', render: x => x.tariff || '—' }, { label: 'Opening', cls: 'num', render: x => fmtNum(x.opening, 1) }, { label: 'Closing', cls: 'num', render: x => fmtNum(x.closing, 1) },
        { label: 'Use', cls: 'num', render: x => html`${x.consumption != null ? fmtM3(x.consumption) : '—'} ${x.estimated ? estBadge() : ''}${x.simulated ? simBadge() : ''}` }, { label: 'Amount', cls: 'num', render: x => (x.total != null ? money(x.total, x.currency) : '—') },
        { label: 'Result', render: x => (x.status === 'ok' ? (x.bill_number ? html`<a href="#/bills/${x.bill_id}" class="mono">${x.bill_number}</a>` : badge('approved', 'Ready')) : html`<span class="badge warn">Skipped</span> <small>${x.reason}</small>`) }], [...ok, ...sk])}</div>`.s;
  };
  $('#gf', root).addEventListener('submit', e => { e.preventDefault(); run(false).catch(err => toast(err.message, 'err')); });
  bind(root, { commit: async () => { if (await confirmBox('Issue bills', 'Issue these bills now? Issued bills can only be cancelled with a reason (recorded in the audit log).', { ok: 'Issue bills' })) { await run(true); toast('Bills issued', 'ok'); } } });
}

export async function billDetail(root, p) {
  const d = await api('/api/bills/' + p.id); const b = d.bill;
  mount(root, html`<div class="crumbs no-print"><a href="#/billing">Bills</a> › <a href="#/customers/${b.customer_id}">${b.customer_name}</a></div>
    <div class="page-head"><h1>Bill ${b.bill_number}</h1><div class="actions"><button class="btn" data-act="print">Print</button>${can('payments.create') && b.status !== 'cancelled' && d.outstanding > 0 ? html`<a class="btn primary" href="#/payments?new=${b.customer_id}&bill=${b.id}">Record payment</a>` : ''}
      ${can('billing.generate') && b.status !== 'cancelled' && !b.paid ? html`<button class="btn danger" data-act="cancel">Cancel bill</button>` : ''}</div></div>
    ${billDoc(d)}`);
  bind(root, { print: () => window.print(), cancel: async () => { const reason = await confirmBox('Cancel bill', 'Cancelled bills stay on record. The closing reading becomes available for re-billing.', { reason: true, danger: true, ok: 'Cancel bill' }); if (!reason) return; await api(`/api/bills/${b.id}/cancel`, { body: { reason } }); toast('Bill cancelled', 'ok'); billDetail(root, p); } });
}
export function billDoc(d) {
  const b = d.bill;
  return html`<div class="card doc"><div class="doc-head"><div><h2 style="margin:0">${d.org_name}</h2><small>Water bill / invoice</small><br>${demoMark()}</div><div style="text-align:right"><b class="mono">${b.bill_number}</b><br>Issued ${fmtDate(b.issue_date)}<br><b>Due ${fmtDate(b.due_date)}</b><br>${badge(b.status)}</div></div>
    <div class="grid g2"><dl class="kv"><dt>Customer</dt><dd>${b.customer_name}</dd><dt>Account</dt><dd class="mono">${b.customer_number}</dd><dt>Address</dt><dd>${b.address}</dd><dt>Area</dt><dd>${b.area_name}</dd></dl>
      <dl class="kv"><dt>Period</dt><dd>${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}</dd><dt>Meter</dt><dd class="mono">${b.serial_number || '—'}</dd><dt>Readings</dt><dd>${fmtNum(b.opening_value, 1)} → ${fmtNum(b.closing_value, 1)} m³</dd>
      <dt>Consumption</dt><dd><b>${fmtM3(b.consumption)}</b> ${b.is_estimated ? estBadge() : ''} ${b.is_simulated ? simBadge() : ''}</dd><dt>Tariff</dt><dd>${b.tariff_name || b.tariff_code || '—'}</dd></dl></div>
    ${b.is_estimated ? html`<div class="note warn">This bill is ESTIMATED because no actual approved reading was available. It will be corrected automatically when the next actual reading is billed.</div>` : ''}
    ${b.is_simulated ? html`<div class="note sim">This bill is based on SIMULATED (fictional demo) meter data.</div>` : ''}
    <table class="t" style="margin-top:.8rem"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount (${b.currency})</th></tr></thead><tbody>
      ${d.lines.map(l => html`<tr><td>${l.description}</td><td class="num">${l.line_type === 'consumption' ? fmtNum(l.quantity, 3) + ' m³' : ''}</td><td class="num">${l.line_type === 'consumption' ? fmtNum(l.unit_price, 2) : ''}</td><td class="num">${fmtNum(l.amount, 2)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="3">Current charges</td><td class="num">${money(b.total, b.currency)}</td></tr>
      <tr><td colspan="3">Balance brought forward (before this bill)</td><td class="num">${money(b.previous_balance, b.currency)}</td></tr>
      <tr><td colspan="3">Total amount due at issue</td><td class="num">${money(b.amount_due, b.currency)}</td></tr>
      <tr><td colspan="3">Paid against this bill / outstanding on this bill</td><td class="num">${money(b.paid, b.currency)} / ${money(d.outstanding ?? (b.total - b.paid), b.currency)}</td></tr></tfoot></table>
    ${d.payments && d.payments.length ? html`<h3 style="margin-top:1rem">Payments applied</h3>${table([{ label: 'Receipt', key: 'receipt_number' }, { label: 'Date', render: x => fmtDate(x.received_at) }, { label: 'Method', render: x => label(x.method) }, { label: 'Amount', cls: 'num', render: x => money(x.amount, b.currency) }], d.payments)}` : ''}
    ${b.notes ? html`<p class="muted">${b.notes}</p>` : ''}${b.cancel_reason ? html`<div class="note crit">Cancelled: ${b.cancel_reason}</div>` : ''}
    <p class="muted" style="font-size:.8rem;margin-top:1rem">Pay at the utility office or by mobile money quoting your account number. Keep your receipt.</p></div>`;
}

export async function payments(root, _p, q) {
  const rows = await api('/api/payments' + qs({ q: q.q, method: q.method, from: q.from, to: q.to }));
  mount(root, html`<div class="page-head"><div><h1>Payments</h1><small>No payment-card data is entered or stored in this system.</small></div>
    <div class="actions">${can('payments.create') ? html`<button class="btn primary" data-act="new">+ Record payment</button>` : ''}<a class="btn" href="/api/reports/payments${qs({ from: q.from, to: q.to })}">Export CSV</a></div></div>
    <form class="filters" id="pf"><label>Search<input name="q" value="${q.q || ''}" placeholder="Receipt, customer, reference"></label>
      <label>Method<select name="method"><option value="">All</option>${payMethods().map(([k, v]) => html`<option value="${k}"${k === q.method ? raw(' selected') : ''}>${v}</option>`)}</select></label>
      <label>From<input type="date" name="from" value="${q.from || ''}"></label><label>To<input type="date" name="to" value="${q.to || ''}"></label><button class="btn primary">Filter</button></form>
    <div class="card flush">${table([{ label: 'Receipt', render: x => html`<span class="mono">${x.receipt_number}</span>` }, { label: 'Date', render: x => fmtDT(x.received_at) }, { label: 'Customer', render: x => html`${x.customer_name}<br><small class="mono">${x.customer_number}</small>` },
      { label: 'Method', render: x => label(x.method) }, { label: 'Reference', render: x => x.reference || '—' }, { label: 'Amount', cls: 'num', render: x => html`${money(x.amount, x.currency)}${x.tendered_currency && x.tendered_currency !== x.currency ? html`<br><small>tendered ${money(x.tendered_amount, x.tendered_currency)}</small>` : ''}` },
      { label: 'Status', render: x => badge(x.status) }, { label: 'Cashier', key: 'received_by_name' }], rows, { href: x => '#/payments/' + x.id })}</div>`);
  $('#pf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/payments' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(root, { new: () => paymentForm() });
  if (q.new && can('payments.create')) paymentForm(Number(q.new), q.bill ? Number(q.bill) : null);
}
async function paymentForm(customerId, billId) {
  const cs = await api('/api/customers?limit=2000');
  let detail = customerId ? await api('/api/customers/' + customerId) : null;
  const m = modal('Record payment', html`<div class="note warn">Never enter card numbers. For mobile money and bank payments, record the transaction reference. Each reference can be recorded only once.</div><div class="form" id="pform">
    ${formFields([{ name: 'customer_id', label: 'Customer', type: 'select', options: cs.map(c => [c.id, `${c.customer_number} — ${c.name} (bal. ${money(c.balance, c.currency)})`]), required: true, full: true, default: customerId }])}
    <div class="full" id="pinfo"></div>
    ${formFields([{ name: 'bill_id', label: 'Apply first to bill (optional)', type: 'select', options: [], blank: 'Oldest unpaid first' }, { name: 'method', label: 'Payment method', type: 'select', options: payMethods(), required: true, default: 'cash' },
      { name: 'amount', label: 'Amount received', type: 'number', step: '0.01', min: 0.01, required: true, inputmode: 'decimal' }, { name: 'currency', label: 'Currency tendered', type: 'select', options: currencies(), blank: 'Account currency' },
      { name: 'reference', label: 'Transaction reference (required unless cash)', placeholder: 'e.g. MoMo transaction ID' }, { name: 'received_at', label: 'Date & time received', type: 'datetime-local' },
      { name: 'notes', label: 'Notes', full: true }])}</div>`, {
    submitLabel: 'Post payment',
    onSubmit: async v => { const r = await api('/api/payments', { body: v }); toast(`Payment posted — receipt ${r.receipt_number}`, 'ok'); location.hash = '#/payments/' + r.id; }
  });
  const sel = m.el.querySelector('[name=customer_id]'); const bsel = m.el.querySelector('[name=bill_id]');
  const fill = async () => {
    if (!sel.value) return; if (!detail || String(detail.customer.id) !== sel.value) detail = await api('/api/customers/' + sel.value);
    const c = detail.customer; const open = detail.bills.filter(b => ['issued', 'partially_paid', 'overdue'].includes(b.status));
    m.el.querySelector('#pinfo').innerHTML = html`<div class="note">Account currency <b>${c.currency}</b> · balance <b>${money(detail.balance, c.currency)}</b>${c.billing_mode === 'prepaid' ? ' · prepaid account (payment is recorded as credit)' : ''}. Payments in another currency are converted at the configured exchange rate.</div>`.s;
    bsel.innerHTML = '<option value="">Oldest unpaid first</option>' + open.map(b => html`<option value="${b.id}"${b.id === billId ? raw(' selected') : ''}>${b.bill_number} — ${money(b.total - b.paid, b.currency)} outstanding (${b.status})</option>`.s).join('');
    const amt = m.el.querySelector('[name=amount]'); if (!amt.value && billId) { const b = open.find(x => x.id === billId); if (b) amt.value = (b.total - b.paid).toFixed(2); }
  };
  sel.addEventListener('change', () => { billId = null; fill(); }); fill();
}

export async function receipt(root, p) {
  const d = await api('/api/payments/' + p.id); const x = d.payment;
  mount(root, html`<div class="crumbs no-print"><a href="#/payments">Payments</a> ›</div><div class="page-head"><h1>Receipt ${x.receipt_number}</h1><div class="actions"><button class="btn" data-act="print">Print receipt</button>
    ${can('payments.reverse') && x.status === 'posted' && x.amount > 0 ? html`<button class="btn danger" data-act="reverse">Reverse payment</button>` : ''}</div></div>
    <div class="card doc"><div class="doc-head"><div><h2 style="margin:0">${d.org_name}</h2><small>Official payment receipt</small><br>${demoMark()}</div><div style="text-align:right"><b class="mono">${x.receipt_number}</b><br>${fmtDT(x.received_at)}<br>${badge(x.status)}</div></div>
      <dl class="kv"><dt>Received from</dt><dd>${x.customer_name} (<span class="mono">${x.customer_number}</span>)</dd><dt>Amount</dt><dd><b style="font-size:1.3rem">${money(x.amount, x.currency)}</b></dd>
      ${x.tendered_currency && x.tendered_currency !== x.currency ? html`<dt>Tendered</dt><dd>${money(x.tendered_amount, x.tendered_currency)} at configured rate ${x.exchange_rate_used}</dd>` : ''}
      <dt>Method</dt><dd>${label(x.method)}${x.reference ? ' · ref ' + x.reference : ''}</dd><dt>Purpose</dt><dd>${label(x.purpose)}</dd><dt>Applied to</dt><dd>${d.allocations.length ? d.allocations.map(a => html`${a.bill_number}: ${money(a.amount, x.currency)}<br>`) : 'Account credit'}</dd>
      <dt>Account balance now</dt><dd>${money(d.balance_after, x.currency)}</dd><dt>Received by</dt><dd>${x.received_by_name}</dd>${x.reversal_reason ? html`<dt>Reversal</dt><dd class="badge crit">${x.reversal_reason}</dd>` : ''}${x.notes ? html`<dt>Notes</dt><dd>${x.notes}</dd>` : ''}</dl></div>`);
  bind(root, { print: () => window.print(), reverse: async () => { const reason = await confirmBox('Reverse payment', 'A reversal entry is posted; the original stays on record. A different user from the one who recorded the payment must do this.', { reason: true, danger: true, ok: 'Post reversal' }); if (!reason) return; await api(`/api/payments/${x.id}/reverse`, { body: { reason } }); toast('Reversal posted', 'ok'); receipt(root, p); } });
}

export async function adjustments(root, _p, q) {
  const rows = await api('/api/adjustments' + qs({ status: q.status }));
  mount(root, html`<div class="page-head"><div><h1>Adjustments</h1><small>Maker–checker: adjustments are approved by a different authorised user</small></div><div class="actions">${can('adjustments.create') ? html`<button class="btn primary" data-act="new">+ New adjustment</button>` : ''}</div></div>
    <div class="tabs">${[['', 'All'], ['pending', 'Pending approval'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([k, l]) => html`<a href="#/adjustments${k ? '?status=' + k : ''}" class="${(q.status || '') === k ? 'active' : ''}">${l}</a>`)}</div>
    <div class="card flush">${table([{ label: 'Created', render: a => fmtDT(a.created_at) }, { label: 'Customer', render: a => html`<a href="#/customers/${a.customer_id}">${a.customer_name}</a><br><small class="mono">${a.customer_number}</small>` },
      { label: 'Amount', cls: 'num', render: a => html`<span style="color:${raw(a.amount < 0 ? 'var(--good)' : 'var(--crit)')}">${a.amount < 0 ? 'Credit ' : 'Debit '}${money(Math.abs(a.amount), a.currency)}</span>` }, { label: 'Category', render: a => label(a.category) }, { label: 'Reason', key: 'reason' },
      { label: 'Bill', render: a => a.bill_number || '—' }, { label: 'By', key: 'created_by_name' }, { label: 'Status', render: a => html`${badge(a.status)}${a.approved_by_name ? html`<br><small>${a.approved_by_name}</small>` : ''}` },
      { label: '', render: a => (a.status === 'pending' && can('adjustments.approve') ? html`<button class="btn sm good" data-act="decide" data-id="${a.id}" data-d="approved">Approve</button> <button class="btn sm danger" data-act="decide" data-id="${a.id}" data-d="rejected">Reject</button>` : '') }], rows)}</div>`);
  const form = async cid => { const cs = await api('/api/customers?limit=2000'); modal('New adjustment', html`<div class="note">Negative amount = credit to customer (e.g. leak relief). Positive = additional charge. ${'Requires approval by a manager before it affects the balance.'}</div><div class="form">${formFields([
    { name: 'customer_id', label: 'Customer', type: 'select', options: cs.map(c => [c.id, `${c.customer_number} — ${c.name}`]), required: true, full: true, default: cid }, { name: 'amount', label: 'Amount (account currency; negative = credit)', type: 'number', step: '0.01', required: true },
    { name: 'category', label: 'Category', type: 'select', options: ['meter_error', 'leak_relief', 'billing_error', 'reconnection_fee', 'penalty', 'waiver', 'other'], required: true }, { name: 'reason', label: 'Reason / justification', type: 'textarea', required: true, full: true }])}</div>`,
    { onSubmit: async v => { const r = await api('/api/adjustments', { body: v }); toast(`Adjustment ${r.status === 'pending' ? 'submitted for approval' : 'approved'}`, 'ok'); adjustments(root, _p, {}); } }); };
  bind(root, { new: () => form(), decide: async el => { const note = el.dataset.d === 'rejected' ? await confirmBox('Reject adjustment', 'Give a reason.', { reason: true, danger: true, ok: 'Reject' }) : 'Approved'; if (!note) return; await api(`/api/adjustments/${el.dataset.id}/decide`, { body: { decision: el.dataset.d, note } }); toast('Decision recorded', 'ok'); adjustments(root, _p, q); } });
  if (q.new) form(Number(q.new));
}

export async function statement(root, p, q) {
  const d = await api(`/api/customers/${p.id}/statement` + qs({ from: q.from, to: q.to }));
  const c = d.customer;
  mount(root, html`<div class="crumbs no-print"><a href="#/customers/${c.id}">${c.name}</a> ›</div><div class="page-head"><h1>Account statement</h1><div class="actions"><button class="btn" data-act="print">Print</button></div></div>
    <form class="filters no-print" id="sf"><label>From<input type="date" name="from" value="${q.from || ''}"></label><label>To<input type="date" name="to" value="${q.to || ''}"></label><button class="btn primary">Apply</button></form>
    ${statementDoc(d, c)}`);
  $('#sf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = `#/statement/${c.id}` + qs(Object.fromEntries(new FormData(e.target))); });
  bind(root, { print: () => window.print() });
}
export function statementDoc(d, c) {
  return html`<div class="card doc"><div class="doc-head"><div><h2 style="margin:0">${d.org_name || state.orgName}</h2><small>Statement of account</small><br>${demoMark()}</div><div style="text-align:right"><b>${c.name}</b><br><span class="mono">${c.customer_number}</span><br>${c.address}<br>${d.from ? fmtDate(d.from) : 'Opening'} – ${d.to ? fmtDate(d.to) : 'today'}</div></div>
    <table class="t"><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="num">Charges</th><th class="num">Payments / credits</th><th class="num">Balance</th></tr></thead><tbody>
      <tr><td></td><td></td><td><i>Opening balance</i></td><td></td><td></td><td class="num">${money(d.opening_balance, c.currency)}</td></tr>
      ${d.rows.map(r => html`<tr><td>${fmtDate(r.date)}</td><td class="mono">${r.ref}</td><td>${r.description}${r.note ? html`<br><small>${r.note}</small>` : ''}</td><td class="num">${r.debit ? fmtNum(r.debit) : ''}</td><td class="num">${r.credit ? fmtNum(r.credit) : ''}</td><td class="num">${fmtNum(r.balance)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="5">Closing balance (${c.currency}) — ${d.closing_balance > 0 ? 'amount owed' : d.closing_balance < 0 ? 'in credit' : 'settled'}</td><td class="num">${money(d.closing_balance, c.currency)}</td></tr></tfoot></table></div>`;
}
