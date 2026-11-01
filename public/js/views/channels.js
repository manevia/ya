// Feature-phone channels (USSD / SMS) and mobile-money reconciliation screens.
import { api, html, raw, mount, $, state, qs, can, money, fmtDT, fmtDate, label, badge, table, modal, formFields, toast, bind, confirmBox, simBadge, esc, currencies, cfg, phoneHint } from '../core.js';
import { ensureLookups } from './dashboard.js';

// ================= Phone channels =================
export async function phone(root, _p, q) {
  const tab = q.tab || 'simulator';
  const st = await api('/api/channels/status');
  const tabs = [['simulator', '📱 Phone simulator'], ['messages', 'Message log'], ['setup', 'Gateway setup']];
  mount(root, html`<div class="page-head"><div><h1>Feature-phone channels</h1><small>USSD menu and SMS commands let any customer with a basic phone check bills, send readings and report leaks — no smartphone or data needed.</small></div></div>
    ${st.provider === 'simulator' ? html`<div class="note sim"><b>SMS/USSD gateway: SIMULATOR.</b> No real messages are sent or received yet. Outbound SMS are stored with status “simulated”. Connect an aggregator under Gateway setup to go live.</div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/channels?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="ct"></div>`);
  const el = $('#ct', root);
  if (tab === 'simulator') return simulator(el, st);
  if (tab === 'messages') return messages(el, q);
  return setup(el, st);
}

async function simulator(el, st) {
  const cs = (await api('/api/customers?limit=300')).filter(c => c.phone).slice(0, 40);
  mount(el, html`<div class="grid g2">
    <div class="card"><h2>USSD — dial ${st.ussd_code || '*000#'}</h2>
      <label style="display:block;font-size:.85rem">Phone number<select id="ph">${cs.map(c => html`<option value="${c.phone}">${c.phone} — ${c.name}</option>`)}<option value="+231 880 000 000">+231 880 000 000 — unregistered number</option></select></label>
      <div style="max-width:300px;margin:1rem auto;background:#1b1f23;border-radius:28px;padding:18px 14px 22px;box-shadow:0 8px 24px rgba(0,0,0,.3)">
        <div id="scr" style="background:#c8d6b9;color:#18240f;font-family:ui-monospace,monospace;font-size:.85rem;min-height:190px;border-radius:6px;padding:.6rem;white-space:pre-wrap">Press DIAL to start</div>
        <input id="inp" inputmode="numeric" placeholder="Reply" style="width:100%;margin-top:.6rem;font-family:monospace">
        <div style="display:flex;gap:.4rem;margin-top:.5rem"><button class="btn good" style="flex:1" data-act="dial">DIAL</button><button class="btn primary" style="flex:1" data-act="send">SEND</button><button class="btn danger" style="flex:1" data-act="end">END</button></div>
      </div><small class="muted">Each step calls the same handler a real USSD aggregator would call. Actions you take here (readings, leak reports) are real records in this ${state.mode} database.</small></div>
    <div class="card"><h2>SMS commands</h2><p class="muted" style="font-size:.88rem">Customers text these to the utility's SMS number:</p>
      ${table([{ label: 'Send', render: r => html`<b class="mono">${r[0]}</b>` }, { label: 'Reply', key: 1 }], [['BAL', 'Current balance'], ['BILL', 'Latest bill'], ['READ 1234.5', 'Submits a meter reading (staff review it)'], ['LEAK near the market', 'Raises a leak alert for the technicians'], ['NOWATER', 'Reports no supply'], ['PAY', 'Mobile money instructions'], ['CARD', 'Water card balance'], ['HELP', 'List of commands']])}
      <div style="display:flex;gap:.4rem;margin-top:.8rem"><input id="smsbody" placeholder="e.g. READ 1250" style="flex:1"><button class="btn primary" data-act="sms">Send SMS</button></div>
      <div id="smsout" style="margin-top:.6rem"></div></div></div>`);
  let session = null, text = '';
  const scr = $('#scr', el), inp = $('#inp', el);
  const call = async () => { const r = await api('/api/channels/simulate/ussd', { body: { phone: $('#ph', el).value, text, sessionId: session } }); scr.textContent = r.reply.replace(/^(CON|END) /, ''); if (r.reply.startsWith('END')) { session = null; scr.textContent += '\n\n[session ended]'; } inp.value = ''; inp.focus(); };
  bind(el, {
    dial: async () => { session = 'sim-' + Date.now(); text = ''; await call(); },
    send: async () => { if (!session) return toast('Press DIAL first', 'err'); text = text === '' ? inp.value.trim() : text + '*' + inp.value.trim(); await call(); },
    end: () => { session = null; text = ''; scr.textContent = 'Press DIAL to start'; },
    sms: async () => { const b = $('#smsbody', el).value.trim(); if (!b) return; const r = await api('/api/channels/simulate/sms', { body: { phone: $('#ph', el).value, body: b } });
      $('#smsout', el).innerHTML = html`<div class="note"><b>You → </b>${b}</div><div class="note sim"><b>Utility → </b>${r.reply}<br><small>(simulated — not actually sent)</small></div>`.s; }
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-act=send]').click(); } });
}

async function messages(el, q) {
  const rows = await api('/api/channels/messages' + qs({ phone: q.phone, direction: q.direction, channel: q.channel }));
  mount(el, html`<form class="filters" id="mf"><input type="hidden" name="tab" value="messages"><label>Phone<input name="phone" value="${q.phone || ''}"></label>
    <label>Direction<select name="direction"><option value="">Both</option><option value="in"${q.direction === 'in' ? raw(' selected') : ''}>Inbound</option><option value="out"${q.direction === 'out' ? raw(' selected') : ''}>Outbound</option></select></label>
    <label>Channel<select name="channel"><option value="">All</option><option value="sms"${q.channel === 'sms' ? raw(' selected') : ''}>SMS</option><option value="ussd"${q.channel === 'ussd' ? raw(' selected') : ''}>USSD</option></select></label><button class="btn primary">Filter</button></form>
    <div class="card flush">${table([{ label: 'When', render: m => fmtDT(m.created_at.replace(' ', 'T') + 'Z') }, { label: 'Dir', render: m => (m.direction === 'in' ? '⬅ in' : '➡ out') }, { label: 'Channel', render: m => m.channel.toUpperCase() },
      { label: 'Phone', key: 'phone' }, { label: 'Account', render: m => (m.customer_id ? html`<a href="#/customers/${m.customer_id}">${m.customer_number}</a>` : '—') }, { label: 'Message', render: m => html`<span style="white-space:pre-wrap">${m.body}</span>` },
      { label: 'Purpose', render: m => label(m.purpose || '') }, { label: 'Status', render: m => (m.status === 'simulated' ? simBadge() : badge(m.status)) }], rows, { empty: 'No messages yet.' })}</div>`);
  $('#mf', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/channels' + qs(Object.fromEntries(new FormData(e.target))); });
}

function setup(el, st) {
  const base = location.origin;
  mount(el, html`<div class="grid g2"><div class="card"><h2>Status</h2><dl class="kv"><dt>SMS/USSD provider</dt><dd>${st.provider === 'simulator' ? simBadge() : st.provider}</dd><dt>Gateway key</dt><dd>${st.gateway_key ? `issued (…${st.gateway_key_hint})` : html`<span class="badge serious">not issued</span>`}</dd>
      <dt>USSD code</dt><dd>${st.ussd_code}</dd><dt>SMS notifications</dt><dd>${st.notifications ? 'On (bills, receipts, card top-ups)' : 'Off'}</dd><dt>MTN MoMo merchant</dt><dd>${st.momo_mtn_merchant || html`<span class="muted">not set</span>`}</dd>
      <dt>Orange Money merchant</dt><dd>${st.momo_orange_merchant || html`<span class="muted">not set</span>`}</dd><dt>Messages</dt><dd>${st.counts.inbound || 0} in · ${st.counts.outbound || 0} out (${st.counts.simulated || 0} simulated)</dd></dl>
      ${can('settings.manage') ? html`<p style="margin-top:1rem"><button class="btn primary" data-act="key">${st.gateway_key ? 'Rotate' : 'Issue'} gateway key</button> <a class="btn" href="#/admin/settings">Edit codes & notifications</a></p>` : ''}</div>
    <div class="card"><h2>Endpoints for your aggregator / provider</h2><p class="muted" style="font-size:.88rem">All require header <span class="mono">X-Api-Key</span> (or <span class="mono">?key=</span>). JSON or form-encoded bodies accepted.</p>
      ${table([{ label: 'Purpose', key: 'p' }, { label: 'URL', render: r => html`<span class="mono" style="word-break:break-all">${r.u}</span>` }, { label: 'Fields', render: r => html`<small class="mono">${r.f}</small>` }], [
        { p: 'USSD session callback', u: `POST ${base}/api/gateway/ussd`, f: 'sessionId, phoneNumber, text → replies "CON …" / "END …" (text/plain)' },
        { p: 'Inbound SMS', u: `POST ${base}/api/gateway/sms`, f: 'from, text → reply returned and queued as outbound SMS' },
        { p: 'MTN MoMo payment', u: `POST ${base}/api/gateway/momo/mtn`, f: 'txn_ref|financialTransactionId, msisdn, amount, currency, reference, timestamp' },
        { p: 'Orange Money payment', u: `POST ${base}/api/gateway/momo/orange`, f: 'same as above' }])}
      <div class="note warn" style="margin-top:.8rem"><b>Needed to go live:</b> a USSD short code and SMS sender ID/long number from an aggregator or the mobile operators (MTN/Lonestar Cell, Orange Liberia), the aggregator's callback format and credentials, and merchant collection accounts (or API access) for MTN MoMo and Orange Money. Until then use the simulator and the statement CSV import in Mobile money.</div></div></div>`);
  bind(el, { key: async () => { if (!await confirmBox('Issue gateway key', 'Any previous key stops working immediately.', { ok: 'Issue key' })) return; const r = await api('/api/channels/gateway-key', { body: {} });
    modal('Gateway key (shown once)', html`<p>${r.note}</p><p class="mono" style="word-break:break-all;background:#f3f5f7;padding:.6rem;border-radius:6px">${r.key}</p>`, {}); } });
}

// ================= Mobile money =================
export async function momo(root, _p, q) {
  const status = q.status ?? 'unmatched';
  const rows = await api('/api/momo' + qs({ status }));
  const counts = { unmatched: status === 'unmatched' ? rows.length : null };
  mount(root, html`<div class="page-head"><div><h1>Mobile money</h1><small>Payments arriving by MTN MoMo or Orange Money are matched automatically by account or water-card number, then by sender phone. The rest wait here for a cashier.</small></div>
    <div class="actions">${can('momo.import') ? html`<button class="btn" data-act="import">Import provider statement (CSV)</button>` : ''}${can('channels.simulate') && state.mode === 'demo' ? html`<button class="btn" data-act="sim">Simulate incoming payment</button>` : ''}</div></div>
    <div class="tabs">${[['unmatched', 'Needs matching'], ['matched', 'Matched'], ['ignored', 'Set aside'], ['', 'All']].map(([k, l]) => html`<a href="#/momo?status=${k}" class="${status === k ? 'active' : ''}">${l}${k === 'unmatched' && counts.unmatched ? ` (${counts.unmatched})` : ''}</a>`)}</div>
    <div class="card flush">${table([{ label: 'Received', render: t => fmtDT(t.received_at) }, { label: 'Provider', render: t => html`${t.provider.toUpperCase()}${t.is_simulated ? html` ${simBadge()}` : ''}<br><small>${label(t.source)}</small>` },
      { label: 'Transaction ID', render: t => html`<span class="mono">${t.txn_ref}</span>` }, { label: 'Sender', render: t => t.msisdn || '—' }, { label: 'Reference typed', render: t => t.account_ref || html`<span class="muted">none</span>` },
      { label: 'Amount', cls: 'num', render: t => money(t.amount, t.currency) },
      { label: 'Result', render: t => (t.status === 'matched' ? html`${badge('approved', 'Matched')}<br><small>${t.customer_number ? html`<a href="#/customers/${t.customer_id}">${t.customer_number}</a>` : t.card_number} · ${label(t.match_method)}${t.receipt_number ? html` · <a href="#/payments/${t.payment_id}">${t.receipt_number}</a>` : ''}</small>`
        : t.status === 'ignored' ? html`${badge('dismissed', 'Set aside')}<br><small>${t.note}</small>` : html`${badge('pending', 'Unmatched')}${t.note ? html`<br><small>${t.note}</small>` : ''}`) },
      { label: '', render: t => (t.status === 'unmatched' && can('momo.match') ? html`<button class="btn sm primary" data-act="match" data-id="${t.id}">Match</button> <button class="btn sm" data-act="ignore" data-id="${t.id}">Set aside</button>` : '') }], rows, { empty: status === 'unmatched' ? 'Nothing waiting — every mobile-money payment has been matched.' : 'No transactions.' })}</div>`);
  const reload = () => momo(root, _p, q);
  bind(root, {
    match: async el => { const t = rows.find(x => x.id === Number(el.dataset.id)); const cs = await api('/api/customers?limit=2000'); const ws = can('wp.wallets') || can('wp.view') ? await api('/api/wp/wallets') : [];
      modal(`Match ${money(t.amount, t.currency)} from ${t.msisdn || 'unknown sender'}`, html`<div class="note">Reference typed by payer: <b>${t.account_ref || 'none'}</b>. Choose the account to credit. A receipt is created and the customer is notified by SMS.</div><div class="form">${formFields([
        { name: 'customer_id', label: 'Customer account', type: 'select', options: cs.map(c => [c.id, `${c.customer_number} — ${c.name} (${c.phone || 'no phone'})`]), full: true },
        { name: 'wallet_id', label: '…or water card', type: 'select', options: ws.map(w => [w.id, `${w.card_number} — ${w.holder_name}`]), full: true }])}</div>`,
        { submitLabel: 'Post payment', onSubmit: async v => { const body = v.customer_id ? { customer_id: v.customer_id } : { wallet_id: Number(v.wallet_id) }; await api(`/api/momo/${t.id}/match`, { body }); toast('Matched and posted', 'ok'); reload(); } }); },
    ignore: async el => { const note = await confirmBox('Set aside', 'For refunds, test transfers or payments that do not belong to the water service. Give a reason.', { reason: true, ok: 'Set aside' }); if (!note) return; await api(`/api/momo/${el.dataset.id}/ignore`, { body: { note } }); reload(); },
    sim: () => modal('Simulate an incoming mobile-money payment (DEMO)', html`<div class="note sim">Creates a SIMULATED provider transaction. It goes through the same matching as a real one; the resulting payment is labelled SIMULATED.</div><div class="form">${formFields([
      { name: 'provider', label: 'Provider', type: 'select', options: (cfg().momo_providers || []).map(p => [p.code, p.name]), blank: false }, { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true },
      { name: 'currency', label: 'Currency', type: 'select', options: currencies(), blank: false }, { name: 'account_ref', label: 'Reference the payer typed', placeholder: 'e.g. RVS-00003 or WC-GVW-0002' },
      { name: 'msisdn', label: 'Sender phone', placeholder: phoneHint() }])}</div>`, { submitLabel: 'Send', onSubmit: async v => { const r = await api('/api/momo/simulate', { body: v }); toast(r.status === 'matched' ? 'Received and matched automatically (' + label(r.match_method) + ')' : 'Received — needs manual matching', r.status === 'matched' ? 'ok' : ''); reload(); } }),
    import: () => {
      const m = modal('Import mobile-money statement', html`<div class="note">Export the transaction history from your MTN MoMo or Orange Money merchant portal as CSV. Columns are recognised flexibly: <span class="mono">transaction_id, msisdn/phone, amount, currency, reference, date</span>. Transactions already recorded are skipped automatically.</div>
        <div class="form">${formFields([{ name: 'provider', label: 'Provider', type: 'select', options: (cfg().momo_providers || []).map(p => [p.code, p.name]), blank: false }, { name: 'currency', label: 'Default currency (if no column)', type: 'select', options: currencies(), blank: false }])}
        <label class="f full"><span class="req">CSV file</span><input type="file" name="file" accept=".csv,text/csv"></label><div class="full" id="mprev"></div></div>`, { submitLabel: 'Check file', onSubmit: async (v, d) => {
          const f = d.querySelector('[name=file]').files[0]; if (!f) { toast('Choose a file', 'err'); return false; }
          const content = await f.text(); const commit = d.dataset.ready === '1';
          const r = await api('/api/momo/import', { body: { provider: v.provider, currency: v.currency, content, commit } });
          if (commit) { toast(`Imported ${r.imported}: ${r.matched} matched, ${r.unmatched} need matching, ${r.duplicates} already recorded`, 'ok'); reload(); return true; }
          d.querySelector('#mprev').innerHTML = html`<p><b>${r.valid}</b> new, <b>${r.duplicates}</b> already recorded, <b>${r.invalid}</b> with errors.</p>${table([{ label: 'Row', key: 'row' }, { label: 'Txn', key: 'txn_ref' }, { label: 'Amount', render: x => `${x.amount} ${x.currency}` }, { label: 'Reference', key: 'account_ref' },
            { label: 'Result', render: x => (x.errors.length ? html`<span class="badge crit">${x.errors.join('; ')}</span>` : x.duplicate ? badge('cancelled', 'Already recorded') : x.will_match ? html`<span class="badge good">→ ${x.will_match}</span>` : badge('pending', 'Will need matching')) }], r.rows.slice(0, 100))}`.s;
          if (r.valid) { d.dataset.ready = '1'; d.querySelector('[type=submit]').textContent = `Import ${r.valid} transactions`; }
          return false;
        } });
    }
  });
}
