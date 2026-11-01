// Pay-as-you-fetch water points: management/reconciliation for staff, and an offline-capable attendant kiosk.
import { api, html, raw, mount, $, $$, state, qs, can, money, fmtDT, fmtDate, fmtNum, label, badge, table, modal, formFields, toast, bind, confirmBox, simBadge, today, daysAgo, esc, currencies } from '../core.js';
import { ensureLookups } from './dashboard.js';
import { kvGet, kvSet, wpAll, wpSave, wpSync } from '../offline.js';

export async function view(root, _p, q) {
  const tab = q.tab || 'points';
  const tabs = [['points', 'Water points'], ['reconcile', 'Reconciliation'], ['cards', 'Water cards'], ['handovers', 'Cash handovers']];
  mount(root, html`<div class="page-head"><div><h1>Pay-as-you-fetch water points</h1><small>Kiosks and tap stands sell water by the container. Attendants record each sale (cash, water card or free), even offline; volumes are checked against the tap meter and cash against handovers.</small></div></div>
    <div class="tabs">${tabs.map(([k, l]) => html`<a href="#/water-points?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="wt"></div>`);
  const el = $('#wt', root);
  await ({ points, reconcile, cards, handovers })[tab](el, q);
}

async function points(el) {
  const [rows, L] = [await api('/api/wp/points'), await ensureLookups()];
  const users = can('users.manage') ? await api('/api/users') : L.staff;
  const meters = can('meters.view') ? await api('/api/meters?status=active') : [];
  mount(el, html`<div class="card flush">${table([{ label: 'Water point', render: p => html`<b>${p.name}</b><br><small class="mono">${p.code}</small> · <small>${p.area_name || ''}</small>` }, { label: 'Status', render: p => badge(p.asset_status) },
    { label: 'Sales mode', render: p => (p.mode ? html`${p.mode === 'free' ? 'Free (volume logged)' : money(p.price_per_container, p.currency) + ' per ' + p.container_liters + ' L'}${p.active ? '' : html` <span class="badge outline">paused</span>`}` : html`<span class="badge serious">not set up</span>`) },
    { label: 'Attendant', render: p => p.attendant_name || '—' }, { label: 'Tap meter', render: p => (p.meter_serial ? html`<span class="mono">${p.meter_serial}</span>` : html`<span class="muted">none</span>`) },
    { label: 'Today', cls: 'num', render: p => (p.today ? html`${p.today.containers} containers<br><small>cash ${money(p.today.cash, p.currency)} · card ${money(p.today.card, p.currency)}</small>` : '—') },
    { label: '', render: p => html`${can('wp.manage') ? html`<button class="btn sm" data-act="cfg" data-id="${p.asset_id}">${p.mode ? 'Settings' : 'Set up sales'}</button> ` : ''}${p.mode ? html`<a class="btn sm" href="#/water-points?tab=reconcile&point=${p.asset_id}">Reconcile</a>` : ''}` }], rows, { empty: 'No water-point assets. Add one under Network assets (type “Water point”).' })}</div>
    <div class="note">Attendants use the <b>Kiosk</b> screen on a phone. Create a user with the role “Water Point Attendant” in Administration › Users, then select them here.</div>`);
  bind(el, { cfg: b => { const p = rows.find(x => x.asset_id === Number(b.dataset.id));
    modal('Water point sales settings — ' + p.name, html`<div class="form">${formFields([{ name: 'mode', label: 'Mode', type: 'select', options: [['pay_per_container', 'Pay per container'], ['free', 'Free (log volume only)']], blank: false },
      { name: 'currency', label: 'Currency', type: 'select', options: currencies(), blank: false }, { name: 'price_per_container', label: 'Price per container', type: 'number', step: '0.01', help: 'Set by the utility / water committee' },
      { name: 'container_liters', label: 'Container size (litres)', type: 'number', step: 'any', default: 20 }, { name: 'attendant_user_id', label: 'Attendant', type: 'select', options: users.filter(u => ['attendant', 'technician', 'manager'].includes(u.role) && (u.active ?? 1)).map(u => [u.id, `${u.full_name} (${label(u.role)})`]) },
      { name: 'meter_id', label: 'Tap meter (for volume check)', type: 'select', options: meters.filter(m => !p.area_id || true).map(m => [m.id, `${m.serial_number} — ${m.customer_name || 'unassigned'}`]) },
      { name: 'committee', label: 'Water committee', full: true }, { name: 'opening_hours', label: 'Opening hours', placeholder: '06:00–18:00' }, { name: 'active', label: 'Sales active', type: 'checkbox', default: true }], { ...p, active: p.mode ? p.active : 1, currency: p.currency || (L.areas.find(a => a.id === p.area_id) || {}).currency })}</div>`,
      { onSubmit: async v => { await api(`/api/wp/points/${p.asset_id}/config`, { method: 'PUT', body: v }); toast('Saved', 'ok'); points(el); } }); } });
}

async function reconcile(el, q) {
  const from = q.from || daysAgo(30), to = q.to || today();
  const d = await api('/api/wp/summary' + qs({ from, to }));
  mount(el, html`<form class="filters" id="rf"><input type="hidden" name="tab" value="reconcile"><label>From<input type="date" name="from" value="${from}"></label><label>To<input type="date" name="to" value="${to}"></label><button class="btn primary">Apply</button>
      <a class="btn" href="/api/wp/summary${qs({ from, to, format: 'csv' })}">Download CSV</a></form>
    ${d.points.map(r => html`<div class="card" ${q.point && Number(q.point) === r.point.id ? raw('style="outline:2px solid var(--brand)"') : ''}><div class="card-head"><h2>${r.point.name} <small class="mono">${r.point.code}</small></h2>${r.simulated_transactions ? simBadge() : ''}</div>
      <div class="grid g4">
        <div class="kpi"><div class="label">Containers sold</div><div class="value">${fmtNum(r.containers, 0)}</div><div class="sub">${fmtNum(r.liters_sold / 1000, 2)} m³ · ${r.sales} sales${r.free_containers ? ` · ${r.free_containers} free` : ''}</div></div>
        <div class="kpi"><div class="label">Revenue</div><div class="value">${money(r.revenue, r.point.currency)}</div><div class="sub">cash ${money(r.cash_sales, r.point.currency)} · card ${money(r.card_sales, r.point.currency)}</div></div>
        <div class="kpi"><div class="label">Tap meter vs sold</div><div class="value">${r.unaccounted_pct == null ? '—' : html`<span class="badge ${r.unaccounted_pct > 15 ? 'crit' : r.unaccounted_pct > 5 ? 'warn' : 'good'}" style="font-size:1rem">${fmtNum(r.unaccounted_pct, 1)}% unaccounted</span>`}</div><div class="sub">${r.metered_liters != null ? `metered ${fmtNum(r.metered_liters / 1000, 2)} m³ · ` : ''}${r.meter_note}</div></div>
        <div class="kpi"><div class="label">Cash handed over − expected</div><div class="value" style="color:${raw(r.cash_variance < -0.009 ? 'var(--crit)' : 'inherit')}">${money(r.cash_variance, r.point.currency)}</div><div class="sub">expected ${money(r.expected_cash, r.point.currency)} (cash sales + card top-ups) · handed over ${money(r.cash_handed_over, r.point.currency)}. Negative = not yet handed over, or short.</div></div></div>
      <p>${can('wp.manage') || can('wp.wallets') ? html`<button class="btn sm primary" data-act="hand" data-id="${r.point.id}" data-exp="${r.expected_cash}">Record cash handover</button> ` : ''}<button class="btn sm" data-act="tx" data-id="${r.point.id}">Transactions</button></p></div>`)}`);
  $('#rf', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/water-points' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, {
    hand: b => modal('Record cash handover', html`<div class="note">Expected cash for ${fmtDate(from)} – ${fmtDate(to)}: <b>${b.dataset.exp}</b>. Enter what the attendant actually handed over; any difference is recorded.</div><div class="form">${formFields([{ name: 'amount', label: 'Cash received', type: 'number', step: '0.01', required: true }, { name: 'note', label: 'Note', full: true }])}</div>`,
      { onSubmit: async v => { const r = await api('/api/wp/handovers', { body: { ...v, asset_id: Number(b.dataset.id), period_from: from, period_to: to } }); toast(`Handover recorded. Variance ${r.variance}`, r.variance < 0 ? 'err' : 'ok'); reconcile(el, q); } }),
    tx: async b => { const rows = await api(`/api/wp/points/${b.dataset.id}/transactions` + qs({ from, to }));
      const m = modal('Transactions', table([{ label: 'When', render: t => fmtDT(t.captured_at) }, { label: 'Type', render: t => html`${label(t.type)}${t.offline ? html` <span class="badge info">offline</span>` : ''}${t.is_simulated ? html` ${simBadge()}` : ''}` }, { label: 'Containers', cls: 'num', key: 'containers' },
        { label: 'Amount', cls: 'num', render: t => money(t.amount, t.currency) }, { label: 'Method', render: t => label(t.method) }, { label: 'Card', render: t => t.card_number || '' }, { label: 'Flags', render: t => JSON.parse(t.flags || '[]').map(f => html`<span class="badge warn">${label(f)}</span> `) },
        { label: 'By', key: 'attendant_name' }, { label: '', render: t => (can('wp.manage') && t.type !== 'reversal' ? html`<button class="btn sm danger" data-rev="${t.id}">Reverse</button>` : '') }], rows), { wide: true });
      m.el.addEventListener('click', async e => { const id = e.target.dataset && e.target.dataset.rev; if (!id) return; const reason = prompt('Reason for reversal'); if (!reason) return; try { await api(`/api/wp/transactions/${id}/reverse`, { body: { reason } }); toast('Reversed', 'ok'); m.close(); reconcile(el, q); } catch (err) { toast(err.message, 'err'); } }); }
  });
}

async function cards(el, q) {
  const [rows, L] = [await api('/api/wp/wallets' + qs({ q: q.q })), await ensureLookups()];
  mount(el, html`<div class="filters"><form id="cf" style="display:flex;gap:.5rem"><input type="hidden" name="tab" value="cards"><input name="q" value="${q.q || ''}" placeholder="Card, name, phone"><button class="btn primary">Search</button></form>
    ${can('wp.wallets') ? html`<button class="btn primary" data-act="new">+ Issue water card</button>` : ''}</div>
    <div class="note">Water cards are prepaid wallets for households that fetch from kiosks. Top up with cash at the office/kiosk, or by mobile money using the card number as the reference. Card holders get SMS balance alerts if a phone is recorded.</div>
    <div class="card flush">${table([{ label: 'Card', render: w => html`<b class="mono">${w.card_number}</b>` }, { label: 'Holder', render: w => html`${w.holder_name}${w.household_size ? html`<br><small>${w.household_size} people</small>` : ''}` }, { label: 'Phone', render: w => w.phone || '—' },
      { label: 'Area', key: 'area_name' }, { label: 'Balance', cls: 'num', render: w => html`<b style="color:${raw(w.balance < 0 ? 'var(--crit)' : 'inherit')}">${money(w.balance, w.currency)}</b>` }, { label: 'Last used', render: w => fmtDT(w.last_used) }, { label: 'Status', render: w => badge(w.status) },
      { label: '', render: w => (can('wp.wallets') ? html`<button class="btn sm primary" data-act="top" data-card="${w.card_number}">Top up</button> <button class="btn sm" data-act="hist" data-id="${w.id}">History</button> <button class="btn sm" data-act="st" data-id="${w.id}" data-s="${w.status === 'active' ? 'blocked' : 'active'}">${w.status === 'active' ? 'Block' : 'Unblock'}</button>` : '') }], rows)}</div>`);
  $('#cf', el).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/water-points' + qs(Object.fromEntries(new FormData(e.target))); });
  bind(el, {
    new: () => modal('Issue water card', html`<div class="form">${formFields([{ name: 'holder_name', label: 'Card holder', required: true }, { name: 'phone', label: 'Phone (for SMS balance)', type: 'tel' }, { name: 'area_id', label: 'Area', type: 'select', options: L.areas.map(a => [a.id, a.name]), required: true }, { name: 'household_size', label: 'Household size', type: 'number' }])}</div>`,
      { onSubmit: async v => { const r = await api('/api/wp/wallets', { body: v }); toast('Card issued: ' + r.card_number, 'ok'); cards(el, q); } }),
    top: b => modal('Cash top-up — ' + b.dataset.card, html`<div class="form">${formFields([{ name: 'amount', label: 'Cash received', type: 'number', step: '0.01', required: true }])}</div>`, { onSubmit: async v => { const r = await api('/api/wp/topup', { body: { card_number: b.dataset.card, amount: v.amount } }); toast('New balance ' + r.wallet_balance, 'ok'); cards(el, q); } }),
    hist: async b => { const t = await api(`/api/wp/wallets/${b.dataset.id}/transactions`); modal('Card history', table([{ label: 'When', render: x => fmtDT(x.captured_at) }, { label: 'Type', render: x => html`${label(x.type)}${x.is_simulated ? html` ${simBadge()}` : ''}` }, { label: 'Where', render: x => x.point_name || (x.method === 'mobile_money' ? 'Mobile money' : 'Office') }, { label: 'Containers', cls: 'num', key: 'containers' }, { label: 'Amount', cls: 'num', render: x => money(x.amount, x.currency) }], t), { wide: true }); },
    st: async b => { await api(`/api/wp/wallets/${b.dataset.id}`, { method: 'PUT', body: { status: b.dataset.s } }); cards(el, q); }
  });
}

async function handovers(el) {
  const rows = await api('/api/wp/handovers');
  mount(el, html`<div class="card flush">${table([{ label: 'Recorded', render: h => fmtDT(h.created_at.replace(' ', 'T') + 'Z') }, { label: 'Water point', key: 'point_name' }, { label: 'Period', render: h => `${fmtDate(h.period_from)} – ${fmtDate(h.period_to)}` },
    { label: 'Expected', cls: 'num', render: h => money(h.expected_cash, h.currency) }, { label: 'Received', cls: 'num', render: h => money(h.amount, h.currency) },
    { label: 'Variance', cls: 'num', render: h => { const v = h.amount - h.expected_cash; return html`<b style="color:${raw(v < -0.009 ? 'var(--crit)' : 'var(--good)')}">${money(v, h.currency)}</b>`; } }, { label: 'Attendant', key: 'attendant_name' }, { label: 'Received by', key: 'received_by_name' }, { label: 'Note', key: 'note' }], rows, { empty: 'No handovers recorded yet.' })}</div>`);
}

// ================= Attendant kiosk (mobile, offline) =================
export async function kiosk(root, _p, q) {
  let data;
  try { data = await api('/api/wp/my'); await kvSet('wp:' + state.user.id, data); }
  catch (e) { data = await kvGet('wp:' + state.user.id); if (!data) return mount(root, html`<div class="card note warn">You are offline and this device has no saved water-point list yet. Connect once to download it.</div>`); data.offline = true; }
  if (!data.points.length) return mount(root, html`<div class="card"><h2>No water point assigned</h2><p>Ask your manager to assign you to a water point.</p></div>`);
  const pt = data.points.find(p => String(p.asset_id) === q.point) || data.points[0];
  const queue = await wpAll();
  const unsynced = queue.filter(i => i.sync !== 'synced');
  const todayItems = queue.filter(i => i.captured_at.slice(0, 10) === today() && i.asset_id === pt.asset_id);
  const localCont = todayItems.filter(i => i.kind === 'sale').reduce((s, i) => s + i.containers, 0);
  const localCash = todayItems.reduce((s, i) => s + (i.kind === 'topup' ? i.amount : i.method === 'cash' ? i.containers * pt.price_per_container : 0), 0);
  const free = pt.mode === 'free';
  mount(root, html`<div class="page-head"><div><h1>${pt.name}</h1><small>${free ? 'Free water point — log each container' : `${money(pt.price_per_container, pt.currency)} per ${pt.container_liters} L container`}</small></div>
      <div class="actions">${data.points.length > 1 ? html`<select id="pp">${data.points.map(p => html`<option value="${p.asset_id}"${p.asset_id === pt.asset_id ? raw(' selected') : ''}>${p.name}</option>`)}</select>` : ''}<button class="btn ${unsynced.length ? 'primary' : ''}" data-act="sync">⟳ Sync${unsynced.length ? ` (${unsynced.length})` : ''}</button></div></div>
    ${data.offline ? html`<div class="note warn">Offline — sales are saved on this phone and sent when the connection returns. Card balances shown were saved at ${fmtDT(data.at)}.</div>` : ''}
    <div class="grid g2"><div class="kpi"><div class="label">Today on this phone</div><div class="value">${localCont} <small class="muted">containers</small></div><div class="sub">${fmtNum(localCont * pt.container_liters, 0)} L</div></div>
      <div class="kpi"><div class="label">Cash you should hold (today, this phone)</div><div class="value">${money(localCash, pt.currency)}</div><div class="sub">sales paid in cash + card top-ups</div></div></div>
    <div class="card" style="margin-top:1rem"><h2>Sell water</h2>
      <div style="display:flex;gap:.5rem;margin-bottom:.8rem">${(free ? [['free', 'Free']] : [['cash', '💵 Cash'], ['wallet', '💳 Water card']]).map(([k, l], i) => html`<label class="btn" style="flex:1;justify-content:center"><input type="radio" name="pm" value="${k}"${i === 0 ? raw(' checked') : ''}> ${l}</label>`)}</div>
      <div id="cardrow" hidden><input id="card" list="cards" placeholder="Card number e.g. WC-GVW-0001" style="width:100%;font-size:1.05rem" autocomplete="off"><datalist id="cards">${data.wallets.map(w => html`<option value="${w.card_number}">${w.holder_name} — ${money(w.balance, w.currency)}</option>`)}</datalist><div id="cardinfo" class="muted" style="margin:.3rem 0"></div></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem">${[1, 2, 3, 4, 5, 10].map(n => html`<button class="btn lg" style="justify-content:center;font-size:1.3rem;padding:1rem" data-act="sell" data-n="${n}">${n}<br><small style="font-size:.7rem">${free ? 'container' + (n > 1 ? 's' : '') : money(n * pt.price_per_container, pt.currency)}</small></button>`)}</div></div>
    ${!free ? html`<div class="card"><h2>Top up a water card (cash)</h2><div style="display:flex;gap:.5rem;flex-wrap:wrap"><input id="tcard" list="cards" placeholder="Card number" style="flex:2;min-width:160px"><input id="tamt" type="number" inputmode="decimal" placeholder="Amount" style="flex:1;min-width:90px"><button class="btn primary" data-act="topup">Top up</button></div></div>` : ''}
    <div class="card"><h2>Water quality check</h2><div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center"><span>Free chlorine (mg/L):</span><input id="cl" type="number" step="0.05" inputmode="decimal" style="width:110px"><button class="btn" data-act="cl">Record test</button></div>
      <small class="muted">Test daily with your chlorine kit. Below 0.2 mg/L the water is not protected — your manager is alerted and customers are advised to treat water.</small></div>
    <div class="card"><h2>Recent on this phone</h2>${queue.slice(-15).reverse().map(i => html`<div style="display:flex;justify-content:space-between;border-bottom:1px solid #eef0f3;padding:.35rem 0;font-size:.9rem"><span>${fmtDT(i.captured_at)} — ${i.kind === 'topup' ? `Top-up ${i.card_number} ${money(i.amount, pt.currency)}` : `${i.containers} × ${label(i.method)}${i.card_number ? ' ' + i.card_number : ''}`}</span>
      <span>${i.sync === 'synced' ? html`<span class="badge good">synced</span>` : i.sync === 'error' ? html`<span class="badge crit" title="${i.error}">error: ${i.error}</span>` : html`<span class="badge warn">on phone</span>`}</span></div>`)}${!queue.length ? html`<div class="muted">No sales yet.</div>` : ''}</div>`);
  const method = () => (root.querySelector('[name=pm]:checked') || {}).value;
  const findCard = c => data.wallets.find(w => w.card_number.toUpperCase().replace(/[^A-Z0-9]/g, '') === String(c).toUpperCase().replace(/[^A-Z0-9]/g, '') || w.card_number.toUpperCase().replace(/[^A-Z0-9]/g, '').endsWith(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')) && String(c).length >= 4);
  $$('[name=pm]', root).forEach(r => r.addEventListener('change', () => { $('#cardrow', root).hidden = method() !== 'wallet'; }));
  const card = $('#card', root); if (card) card.addEventListener('input', () => { const w = findCard(card.value); $('#cardinfo', root).textContent = w ? `${w.holder_name} — balance ${money(w.balance, w.currency)} (as of last sync)` : card.value ? 'Card not found on this phone' : ''; });
  const after = async () => { if (navigator.onLine) { const r = await wpSync().catch(e => ({ error: e.message })); if (r.failed) toast(`${r.failed} item(s) need attention`, 'err'); } kiosk(root, _p, { point: String(pt.asset_id) }); };
  const sel = $('#pp', root); if (sel) sel.addEventListener('change', () => kiosk(root, _p, { point: sel.value }));
  bind(root, {
    sell: async b => { const n = Number(b.dataset.n); const m = method(); let cardNo = null;
      if (m === 'wallet') { const w = findCard(card.value); if (!w) return toast('Enter a valid water card', 'err'); const cost = n * pt.price_per_container; if (w.balance < cost && !confirm(`Card balance ${money(w.balance, w.currency)} may be too low for ${money(cost, w.currency)}. Continue?`)) return; cardNo = w.card_number; w.balance -= cost; await kvSet('wp:' + state.user.id, data); }
      await wpSave({ kind: 'sale', asset_id: pt.asset_id, containers: n, method: m, card_number: cardNo }); toast(`Saved: ${n} container${n > 1 ? 's' : ''}`, 'ok'); after(); },
    topup: async () => { const w = findCard($('#tcard', root).value); const amt = Number($('#tamt', root).value); if (!w) return toast('Card not found', 'err'); if (!(amt > 0)) return toast('Enter an amount', 'err');
      w.balance += amt; await kvSet('wp:' + state.user.id, data); await wpSave({ kind: 'topup', asset_id: pt.asset_id, card_number: w.card_number, amount: amt }); toast('Top-up saved', 'ok'); after(); },
    cl: async () => { const v = Number($('#cl', root).value); if ($('#cl', root).value === '' || !(v >= 0)) return toast('Enter the chlorine reading', 'err');
      try { const r = await api('/api/wq/tests', { body: { asset_id: pt.asset_id, parameter: 'free_chlorine', value: v, method: 'field_kit', client_uuid: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) } });
        toast(r.result === 'pass' ? 'Recorded — chlorine OK' : r.result === 'warn' ? 'Recorded — check dosing' : 'FAIL recorded — manager alerted. Stop selling until re-chlorinated.', r.result === 'fail' ? 'err' : 'ok'); $('#cl', root).value = ''; }
      catch (e) { toast(navigator.onLine ? e.message : 'Offline — write the result down and record it when back online', 'err'); } },
    sync: async () => { if (!navigator.onLine) return toast('Offline — sales stay on this phone', 'err'); const r = await wpSync(); toast(`${r.sent || 0} sent${r.failed ? `, ${r.failed} need attention` : ''}`, r.failed ? 'err' : 'ok'); kiosk(root, _p, { point: String(pt.asset_id) }); }
  });
}
