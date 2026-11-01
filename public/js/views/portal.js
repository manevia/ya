// Customer self-service portal — the server scopes every request to the signed-in customer's own account.
import { api, html, raw, mount, state, money, fmtM3, fmtDate, fmtDT, fmtNum, label, badge, table, bind, estBadge, simBadge } from '../core.js';
import { billDoc, statementDoc } from './billing.js';
import { ocrPanel, resizePhoto } from '../ocr.js';
import { toast, uuid } from '../core.js';

export async function view(root, _p, q) {
  const d = await api('/api/portal/account'); const a = d.account; const tab = q.tab || 'home';
  const tabs = [['home', 'My account'], ['send', 'Send my meter reading'], ['readings', 'Readings'], ['bills', 'Bills'], ['payments', 'Payments'], ['statement', 'Statement'], ['notices', `Notices (${d.notices.length})`]];
  let body;
  if (tab === 'home') body = html`<div class="grid g2"><div class="card"><h2>Balance</h2><div style="font-size:2rem;font-weight:650;color:${raw(d.balance > 0 ? 'var(--crit)' : 'var(--good)')}">${money(Math.abs(d.balance), a.currency)}</div>
      <p>${d.balance > 0 ? 'Amount due. Please pay at the utility office or by mobile money quoting your account number.' : d.balance < 0 ? 'You are in credit.' : 'Your account is settled. Thank you!'}</p>
      ${d.bills[0] ? html`<p>Latest bill <a href="#/portal/bills/${d.bills[0].id}" class="mono">${d.bills[0].bill_number}</a>: ${money(d.bills[0].total, d.bills[0].currency)} due ${fmtDate(d.bills[0].due_date)} ${badge(d.bills[0].status)}</p>` : ''}</div>
    <div class="card"><h2>Account details</h2><dl class="kv"><dt>Account no.</dt><dd class="mono">${a.customer_number}</dd><dt>Name</dt><dd>${a.name}</dd><dt>Type</dt><dd>${label(a.customer_type)}</dd><dt>Address</dt><dd>${a.address}</dd><dt>Area</dt><dd>${a.area_name}</dd>
      <dt>Status</dt><dd>${badge(a.status)}</dd><dt>Billing</dt><dd>${label(a.billing_mode)}</dd><dt>Meter</dt><dd>${d.meter ? html`<span class="mono">${d.meter.serial_number}</span> (${d.meter.size_mm} mm)` : 'None'}</dd></dl></div></div>
    ${d.plan ? html`<div class="card"><h2>My payment plan</h2><p>Paid ${money(d.plan.paid, d.plan.currency)} of ${money(d.plan.arrears, d.plan.currency)} (${fmtNum(d.plan.progress_pct, 0)}%)</p><div class="bar"><span style="width:${raw(d.plan.progress_pct)}%"></span></div>
      ${table([{ label: '#', key: 'seq' }, { label: 'Due', render: i => fmtDate(i.due_date) }, { label: 'Amount', cls: 'num', render: i => money(i.amount, d.plan.currency) }, { label: 'Status', render: i => badge(i.status === 'paid' ? 'paid' : i.status === 'overdue' ? 'overdue' : 'issued', label(i.status)) }], d.plan.instalments)}</div>`
      : d.balance > 0 ? html`<div class="note">Finding it hard to pay in full? Text <b>PLAN</b> or visit the office to agree an affordable payment plan.</div>` : ''}
    ${d.notices.length ? html`<div class="card"><h2>Service notices</h2>${d.notices.slice(0, 3).map(n => html`<div data-noi18n class="note ${n.notice_type === 'outage' ? 'warn' : ''}"><b>${n.title}</b> ${n.starts_at ? html`<small>(${fmtDate(n.starts_at)}${n.ends_at && n.ends_at !== n.starts_at ? ' – ' + fmtDate(n.ends_at) : ''})</small>` : ''}<br>${n.body}</div>`)}</div>` : ''}`;
  if (tab === 'readings') body = html`<div class="card flush">${table([{ label: 'Date', render: r => fmtDate(r.reading_at) }, { label: 'Reading', cls: 'num', render: r => fmtNum(r.value, 1) + ' m³' }, { label: 'Usage', cls: 'num', render: r => (r.consumption != null ? fmtM3(r.consumption) : '—') },
    { label: 'How read', render: r => html`${label(r.source)} ${r.is_estimated ? estBadge() : ''}${r.is_simulated ? simBadge() : ''}` }, { label: 'Status', render: r => (r.status === 'approved' ? badge('approved', 'Confirmed') : badge('pending', 'Being checked')) }], d.readings)}</div>`;
  if (tab === 'bills') body = html`<div class="card flush">${table([{ label: 'Bill', render: b => html`<span class="mono">${b.bill_number}</span>` }, { label: 'Period', render: b => `${fmtDate(b.period_start)} – ${fmtDate(b.period_end)}` }, { label: 'Usage', cls: 'num', render: b => html`${fmtM3(b.consumption)} ${b.is_estimated ? estBadge() : ''}` },
    { label: 'Amount', cls: 'num', render: b => money(b.total, b.currency) }, { label: 'Due', render: b => fmtDate(b.due_date) }, { label: 'Status', render: b => badge(b.status) }], d.bills, { href: b => '#/portal/bills/' + b.id })}</div>`;
  if (tab === 'payments') body = html`<div class="card flush">${table([{ label: 'Receipt', render: p => html`<span class="mono">${p.receipt_number}</span>` }, { label: 'Date', render: p => fmtDT(p.received_at) }, { label: 'Method', render: p => label(p.method) }, { label: 'Amount', cls: 'num', render: p => money(p.amount, p.currency) }, { label: 'Status', render: p => badge(p.status) }], d.payments)}</div>`;
  if (tab === 'statement') { const s = await api('/api/portal/statement'); body = html`<div class="actions no-print" style="margin-bottom:.5rem"><button class="btn" data-act="print">Print statement</button></div>${statementDoc({ ...s, org_name: d.org_name }, a)}`; }
  if (tab === 'notices') body = html`<div class="card">${d.notices.length ? d.notices.map(n => html`<div data-noi18n class="note ${n.notice_type === 'outage' ? 'warn' : ''}"><b>${n.title}</b> <span class="badge outline">${label(n.notice_type)}</span><br>${n.body}<br><small>${fmtDate(n.created_at)}</small></div>`) : html`<div class="empty">No current notices.</div>`}</div>`;
  if (tab === 'send') {
    const m = await api('/api/portal/meter');
    body = m ? html`<div class="card" style="max-width:640px"><h2>Send my meter reading</h2><p>Take a clear photo of your meter. The app reads the numbers from the photo; check them and send. Staff confirm every reading before it is billed.</p>
      <dl class="kv"><dt>Meter</dt><dd class="mono">${m.serial_number}</dd><dt>Last reading</dt><dd>${m.last_reading_value != null ? fmtNum(m.last_reading_value, 1) + ' m³ on ' + fmtDate(m.last_reading_at) : '—'}</dd></dl>
      <form id="sr"><label class="btn" style="margin:.6rem 0">📷 Take photo of meter<input type="file" name="photo" accept="image/*" capture="environment" hidden></label><div id="ocrbox"></div>
      <label style="display:block;margin-top:.6rem;font-weight:600">Reading (m³)<input class="big-input" name="value" type="number" inputmode="decimal" step="0.001" min="0" required></label>
      <button class="btn primary lg block" style="margin-top:.8rem">Send reading</button></form></div>
      <div class="card" style="max-width:640px"><h3>No smartphone?</h3><p>Send an SMS: <b class="mono">READ 1234</b> (your meter numbers), or dial <b>${d.ussd_code || 'the USSD code'}</b> and choose “Send meter reading”.</p></div>`
      : html`<div class="card">No active meter on your account.</div>`;
  }
  mount(root, html`<div class="page-head"><div><h1>Welcome, ${a.name}</h1><small class="mono">${a.customer_number}</small></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/portal?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div>${body}`);
  bind(root, { print: () => window.print() });
  const f = root.querySelector('#sr');
  if (f) {
    let photo = null, ocr = null;
    f.photo.addEventListener('change', async () => { if (!f.photo.files[0]) return; photo = await resizePhoto(f.photo.files[0]); ocr = null;
      ocrPanel(root.querySelector('#ocrbox'), photo, r => { if (!r.digits) return; ocr = { value: Number(r.digits), confidence: r.confidence }; if (!f.value.value) f.value.value = String(Number(r.digits)); }); });
    f.addEventListener('submit', async e => { e.preventDefault(); if (!photo) return toast('Please take a photo of your meter first', 'err');
      try { const r = await api('/api/portal/reading', { body: { value: Number(f.value.value), photo, ocr_value: ocr ? ocr.value : null, ocr_confidence: ocr ? ocr.confidence : null, client_uuid: uuid() } });
        toast('Thank you! Your reading was received and will be checked.', 'ok'); location.hash = '#/portal?tab=readings'; } catch (err) { toast(err.message, 'err'); } });
  }
}
export async function bill(root, p) {
  const d = await api('/api/portal/bills/' + p.id);
  mount(root, html`<div class="crumbs no-print"><a href="#/portal?tab=bills">My bills</a> ›</div><div class="page-head"><h1>Bill ${d.bill.bill_number}</h1><div class="actions"><button class="btn" data-act="print">Print</button></div></div>${billDoc(d)}`);
  bind(root, { print: () => window.print() });
}
