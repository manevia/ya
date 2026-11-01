import { api, html, raw, mount, $, $$, state, qs, can, fmtDT, fmtDate, fmtNum, money, label, badge, table, modal, formFields, toast, bind, confirmBox, esc, simBadge, today, currencies, cfg } from '../core.js';
import { ensureLookups } from './dashboard.js';

const TABS = [['users', 'Users & roles', 'users.manage'], ['areas', 'Service areas', 'areas.view'], ['tariffs', 'Tariffs', 'tariffs.view'], ['settings', 'Settings & exchange rates', 'settings.manage'], ['country', 'Country & languages', 'settings.manage'],
  ['integrations', 'Meter integrations', 'integrations.view'], ['alerts', 'Alert rules', 'settings.manage'], ['notices', 'Service notices', 'notices.manage'], ['backups', 'Backups', 'backups.manage']];
const ROLES = [['admin', 'System Administrator'], ['manager', 'Utility Manager'], ['meter_reader', 'Meter Reader'], ['technician', 'Technician'], ['cashier', 'Cashier / Billing Officer'], ['attendant', 'Water Point Attendant'], ['customer', 'Customer']];

export async function view(root, p) {
  const tabs = TABS.filter(t => can(t[2]) || (t[0] === 'notices' && can('notices.manage')));
  const tab = p.tab || (tabs[0] && tabs[0][0]);
  if (!tabs.find(t => t[0] === tab)) return mount(root, html`<div class="card">Not available for your role.</div>`);
  mount(root, html`<div class="page-head"><h1>Administration</h1></div><div class="tabs">${tabs.map(([k, l]) => html`<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}</div><div id="tab"></div>`);
  await ({ users, areas, tariffs, settings, integrations, alerts: alertRules, notices, backups, country: el => import('./locale.js').then(m => m.countryTab(el)) })[tab]($('#tab', root));
}

// ---------- Users ----------
async function users(el) {
  const [rows, L] = [await api('/api/users'), await ensureLookups()];
  const cs = await api('/api/customers?limit=2000');
  mount(el, html`<div class="card"><div class="card-head"><h2>Users</h2><button class="btn primary" data-act="new">+ New user</button></div>
    <div class="note">Each role only sees and changes what it needs. Customer logins are tied to a single account and can never see other customers. Meter readers can be limited to one service area.</div>
    ${table([{ label: 'Username', render: u => html`<span class="mono">${u.username}</span>` }, { label: 'Name', key: 'full_name' }, { label: 'Role', render: u => label(u.role) }, { label: 'Scope', render: u => u.customer_number || u.area_name || 'All' },
      { label: 'Status', render: u => html`${badge(u.active ? 'active' : 'disabled')}${u.locked_until && u.locked_until > new Date().toISOString() ? html` <span class="badge crit">locked</span>` : ''}${u.must_change_password ? html` <span class="badge warn">must change pw</span>` : ''}${u.totp_enabled ? html` <span class="badge good" title="Two-factor sign-in on">2FA</span>` : ''}` },
      { label: 'Last sign-in', render: u => fmtDT(u.last_login_at) }, { label: '', render: u => html`<button class="btn sm" data-act="edit" data-id="${u.id}">Edit</button> <button class="btn sm" data-act="pw" data-id="${u.id}">Reset password</button>${u.totp_enabled ? html` <button class="btn sm" data-act="r2fa" data-id="${u.id}">Reset 2FA</button>` : ''}` }], rows)}</div>
    <div class="card"><h2>What each role can do</h2>${table([{ label: 'Role', key: 'r' }, { label: 'Access', key: 'a' }], [
      { r: 'System Administrator', a: 'Everything: users, roles, settings, service areas, tariffs, integrations, backups, audit log.' },
      { r: 'Utility Manager', a: 'Dashboards, reports, alerts & work orders, reading review, adjustment approval, notices, bulk supply, audit log (read). Cannot change tariffs, users or post payments.' },
      { r: 'Meter Reader', a: 'Field reading app for assigned area, offline drafts and sync; sees own readings only. No billing access.' },
      { r: 'Technician', a: 'Assigned work orders, alerts (view), network assets, inspections, manual telemetry, mark meters faulty.' },
      { r: 'Cashier / Billing Officer', a: 'Customer accounts, reading review & import, bill generation, payments, reversals (not of own payments), adjustment requests, statements.' },
      { r: 'Water Point Attendant', a: 'Kiosk sales screen for their assigned water point(s) only: sell containers (cash / water card / free), top up cards, works offline.' },
      { r: 'Customer', a: 'Own account, readings, bills, payments, balance and service notices only; can send own meter reading with photo.' }])}</div>`);
  const form = u => modal(u ? 'Edit user' : 'New user', html`<div class="form">${formFields([{ name: 'username', label: 'Username', required: true, readonly: !!u }, { name: 'full_name', label: 'Full name', required: true },
    { name: 'role', label: 'Role', type: 'select', options: ROLES, required: true }, { name: 'area_id', label: 'Limit to service area (readers)', type: 'select', options: L.areas.map(a => [a.id, a.name]), blank: 'All areas' },
    { name: 'customer_id', label: 'Linked customer account (customer role only)', type: 'select', options: cs.map(c => [c.id, `${c.customer_number} — ${c.name}`]), full: true },
    { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' }, ...(u ? [] : [{ name: 'password', label: 'Temporary password', type: 'password', required: true, help: 'Min 10 chars, letters + numbers. User must change it at first sign-in.' }]),
    { name: 'active', label: 'Active', type: 'checkbox', default: u ? !!u.active : true }])}</div>`,
    { onSubmit: async v => { if (u) await api('/api/users/' + u.id, { method: 'PUT', body: v }); else await api('/api/users', { body: v }); toast('User saved', 'ok'); users(el); } });
  bind(el, { new: () => form(), edit: b => form(rows.find(u => u.id === Number(b.dataset.id))),
    r2fa: async b => { const ok = await confirmBox('Reset two-factor sign-in', 'Use when the user has lost their phone and recovery codes. Their 2FA is removed and all their devices are signed out; they must set it up again (if required for their role). Verify their identity first.', { ok: 'Reset 2FA', danger: true }); if (!ok) return; await api(`/api/users/${b.dataset.id}/reset-2fa`, { body: {} }); toast('2FA reset — user signed out everywhere', 'ok'); users(el); },
    pw: b => modal('Reset password', html`<div class="form">${formFields([{ name: 'password', label: 'New temporary password', type: 'password', required: true, full: true }])}</div>`, { onSubmit: async v => { await api(`/api/users/${b.dataset.id}/reset-password`, { body: v }); toast('Password reset; user must change it at next sign-in', 'ok'); } }) });
}

// ---------- Areas ----------
async function areas(el) {
  const rows = await api('/api/areas');
  const edit = can('areas.manage');
  mount(el, html`<div class="card"><div class="card-head"><h2>Service areas</h2>${edit ? html`<button class="btn primary" data-act="new">+ New area</button>` : ''}</div>
    <div class="note">Each service area bills in one currency (USD or LRD). Tariffs and bills for customers in the area use that currency.</div>
    ${table([{ label: 'Code', render: a => html`<span class="mono">${a.code}</span>` }, { label: 'Name', key: 'name' }, { label: 'County', key: 'county' }, { label: 'District', key: 'district' }, { label: 'Currency', key: 'currency' },
      { label: 'Customers', cls: 'num', key: 'customers' }, { label: 'Assets', cls: 'num', key: 'assets' }, { label: 'Status', render: a => badge(a.active ? 'active' : 'disabled') }, { label: '', render: a => (edit ? html`<button class="btn sm" data-act="edit" data-id="${a.id}">Edit</button>` : '') }], rows)}</div>`);
  const form = a => modal(a ? 'Edit service area' : 'New service area', html`<div class="form">${formFields([{ name: 'code', label: 'Code (used in customer numbers)', required: true, placeholder: 'e.g. PNV' }, { name: 'name', label: 'Name', required: true },
    { name: 'county', label: (cfg().region_label || 'Region') }, { name: 'population', label: 'Population living in the area (estimate, for SDG 6.1 coverage)', type: 'number', min: 0 }, { name: 'district', label: 'District' }, { name: 'currency', label: 'Billing currency', type: 'select', options: currencies(), required: true },
    { name: 'active', label: 'Active', type: 'checkbox', default: a ? !!a.active : true }, { name: 'description', label: 'Description', type: 'textarea', full: true }])}</div>`,
    { onSubmit: async v => { if (v.code) v.code = v.code.toUpperCase(); if (a) await api('/api/areas/' + a.id, { method: 'PUT', body: v }); else await api('/api/areas', { body: v }); state.lookups = null; toast('Area saved', 'ok'); areas(el); } });
  bind(el, { new: () => form(), edit: b => form(rows.find(a => a.id === Number(b.dataset.id))) });
}

// ---------- Tariffs ----------
const fmtBands = (t) => JSON.parse(t.bands_json).map((b, i, arr) => `${i ? arr[i - 1].up_to : 0}${b.up_to == null ? '+' : '–' + b.up_to} m³ @ ${b.rate}`).join('; ');
async function tariffs(el) {
  const rows = await api('/api/tariffs'); const L = await ensureLookups();
  const edit = can('tariffs.manage');
  mount(el, html`<div class="card"><div class="card-head"><h2>Tariffs</h2>${edit ? html`<button class="btn primary" data-act="new">+ New tariff</button>` : ''}</div>
    <div class="note">No rates are built into the software. The most specific active tariff (customer type → area → meter size) on the bill's period-end date is applied. Once a tariff is used on a bill its rates are locked: end-date it and create a new version.</div>
    ${table([{ label: 'Code', render: t => html`<span class="mono">${t.code}</span>` }, { label: 'Name', key: 'name' }, { label: 'Applies to', render: t => `${t.customer_type ? label(t.customer_type) : 'All types'} · ${t.area_name || 'All areas'}${t.meter_size_mm ? ' · ' + t.meter_size_mm + ' mm' : ''}${t.billing_mode !== 'any' ? ' · ' + t.billing_mode : ''}` },
      { label: 'Fixed', cls: 'num', render: t => money(t.fixed_charge, t.currency) }, { label: 'Bands', render: t => html`<small>${fmtBands(t)}</small>` }, { label: 'Fees / tax', render: t => html`<small>${JSON.parse(t.fees_json).map(f => f.name + ' ' + (f.pct ? f.pct + '%' : f.amount)).join(', ') || '—'}${t.tax_pct ? ` · tax ${t.tax_pct}%` : ''}</small>` },
      { label: 'Effective', render: t => `${fmtDate(t.effective_from)} → ${t.effective_to ? fmtDate(t.effective_to) : 'open'}` }, { label: 'Status', render: t => badge(t.active ? 'active' : 'disabled') },
      { label: '', render: t => (edit ? html`<button class="btn sm" data-act="edit" data-id="${t.id}">Edit</button> <button class="btn sm" data-act="copy" data-id="${t.id}">New version</button>` : '') }], rows)}</div>`);
  const form = (t, copy) => {
    const bands = t ? JSON.parse(t.bands_json) : [{ up_to: 10, rate: '' }, { up_to: null, rate: '' }];
    const fees = t ? JSON.parse(t.fees_json) : [];
    const v = t ? { ...t } : { effective_from: today(), billing_mode: 'any' };
    if (copy) { v.code = t.code + '-V2'; v.effective_from = today(); v.effective_to = null; }
    const m = modal(t && !copy ? 'Edit tariff' : 'New tariff', html`<div class="form">${formFields([{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
      { name: 'customer_type', label: 'Customer type', type: 'select', options: ['household', 'business', 'institution', 'public_water_point', 'bulk'], blank: 'All types' },
      { name: 'area_id', label: 'Service area', type: 'select', options: L.areas.map(a => [a.id, `${a.name} (${a.currency})`]), blank: 'All areas' }, { name: 'meter_size_mm', label: 'Meter size (mm)', type: 'number', placeholder: 'Any size' },
      { name: 'billing_mode', label: 'Billing mode', type: 'select', options: ['any', 'postpaid', 'prepaid'], blank: false }, { name: 'currency', label: 'Currency', type: 'select', options: currencies(), required: true },
      { name: 'fixed_charge', label: 'Fixed charge per bill', type: 'number', step: '0.01', default: 0 }, { name: 'minimum_charge', label: 'Minimum charge', type: 'number', step: '0.01', default: 0 }, { name: 'tax_pct', label: 'Tax %', type: 'number', step: '0.01', default: 0 },
      { name: 'effective_from', label: 'Effective from', type: 'date', required: true }, { name: 'effective_to', label: 'Effective to', type: 'date' }, { name: 'active', label: 'Active', type: 'checkbox', default: t ? !!t.active : true }])}
      <div class="full"><h3>Consumption bands (progressive)</h3><div id="bands"></div><button type="button" class="btn sm" id="addband">+ Band</button><span class="muted" style="font-size:.8rem"> Leave the last "up to" empty for open-ended.</span></div>
      <div class="full"><h3>Fees</h3><div id="fees"></div><button type="button" class="btn sm" id="addfee">+ Fee</button><span class="muted" style="font-size:.8rem"> Fixed amount, or % of charges.</span></div>
      <div class="full note">Test: <input type="number" id="tq" value="15" style="width:90px"> m³ → <b id="tr">—</b> <button type="button" class="btn sm" id="tbtn">Calculate</button></div>
      <label class="f full"><span>Notes</span><textarea name="notes">${v.notes || ''}</textarea></label></div>`,
      { wide: true, onSubmit: async val => {
        const body = { ...val, bands: readBands(m.el), fees: readFees(m.el) }; delete body.up_to; delete body.rate; delete body.fname; delete body.famount; delete body.fpct;
        if (t && !copy) await api('/api/tariffs/' + t.id, { method: 'PUT', body }); else await api('/api/tariffs', { body }); toast('Tariff saved', 'ok'); tariffs(el);
      } });
    const fv = m.el.querySelector('form'); for (const [k, val] of Object.entries(v)) { const i = fv.querySelector(`[name="${k}"]`); if (i && i.type !== 'checkbox' && val != null) i.value = val; }
    const bandRow = b => `<div style="display:flex;gap:.5rem;margin:.25rem 0;align-items:center" class="band">up to <input name="up_to" type="number" step="any" value="${esc(b.up_to ?? '')}" style="width:110px" placeholder="open"> m³ — rate <input name="rate" type="number" step="any" value="${esc(b.rate)}" style="width:110px" required> per m³ <button type="button" class="btn sm danger rm">×</button></div>`;
    const feeRow = f => `<div style="display:flex;gap:.5rem;margin:.25rem 0;align-items:center" class="fee"><input name="fname" value="${esc(f.name || '')}" placeholder="Fee name" style="width:200px"> amount <input name="famount" type="number" step="any" value="${esc(f.amount ?? '')}" style="width:100px"> or % <input name="fpct" type="number" step="any" value="${esc(f.pct ?? '')}" style="width:80px"> <button type="button" class="btn sm danger rm">×</button></div>`;
    const bx = m.el.querySelector('#bands'), fx = m.el.querySelector('#fees');
    bx.innerHTML = bands.map(bandRow).join(''); fx.innerHTML = fees.map(feeRow).join('');
    m.el.querySelector('#addband').onclick = () => bx.insertAdjacentHTML('beforeend', bandRow({ up_to: null, rate: '' }));
    m.el.querySelector('#addfee').onclick = () => fx.insertAdjacentHTML('beforeend', feeRow({}));
    m.el.addEventListener('click', e => { if (e.target.classList.contains('rm')) e.target.parentElement.remove(); });
    m.el.querySelector('#tbtn').onclick = async () => { try { const g = n => Number(fv.querySelector(`[name=${n}]`).value || 0); const r = await api('/api/tariffs/preview', { body: { consumption: Number(m.el.querySelector('#tq').value), bands: readBands(m.el), fees: readFees(m.el), fixed_charge: g('fixed_charge'), tax_pct: g('tax_pct'), minimum_charge: g('minimum_charge') } });
      m.el.querySelector('#tr').textContent = `${fmtNum(r.total)} ${fv.currency.value} (${r.lines.map(l => l.description + ' ' + fmtNum(l.amount)).join('; ')})`; } catch (err) { toast(err.message, 'err'); } };
  };
  const readBands = d => $$('.band', d).map(r => ({ up_to: r.querySelector('[name=up_to]').value === '' ? null : Number(r.querySelector('[name=up_to]').value), rate: Number(r.querySelector('[name=rate]').value) }));
  const readFees = d => $$('.fee', d).map(r => ({ name: r.querySelector('[name=fname]').value, amount: r.querySelector('[name=famount]').value === '' ? undefined : Number(r.querySelector('[name=famount]').value), pct: r.querySelector('[name=fpct]').value === '' ? undefined : Number(r.querySelector('[name=fpct]').value) })).filter(f => f.name);
  bind(el, { new: () => form(), edit: b => form(rows.find(t => t.id === Number(b.dataset.id))), copy: b => form(rows.find(t => t.id === Number(b.dataset.id)), true) });
}

// ---------- Settings & exchange rates ----------
async function settings(el) {
  const [s, rates] = [await api('/api/settings'), await api('/api/exchange-rates')];
  mount(el, html`<div class="grid g2"><div class="card"><h2>General settings</h2><form id="sf" class="form">${formFields([{ name: 'org_name', label: 'Organisation name', full: true },
    { name: 'default_due_days', label: 'Days until bill is due', type: 'number' }, { name: 'session_hours', label: 'Sign-in session length (hours)', type: 'number' },
    { name: 'high_consumption_factor', label: 'Flag reading if daily use exceeds X × meter average', type: 'number', step: '0.1' }, { name: 'max_daily_m3_household', label: 'New household meters: flag above m³/day', type: 'number', step: '0.1' },
    { name: 'long_gap_days', label: 'Flag readings after a gap of (days)', type: 'number' }, { name: 'backup_retention', label: 'Keep last N backups', type: 'number' },
    { name: 'report_conversion_currency', label: 'Combined dashboard totals in', type: 'select', options: currencies(), blank: false },
    { name: 'gps_capture_enabled', label: 'Allow GPS capture in field app', type: 'checkbox' }, { name: 'photo_required', label: 'Flag field readings without a photo', type: 'checkbox' },
    { name: 'ocr_mismatch_tolerance', label: 'Flag if entered reading differs from photo OCR by more than (m³)', type: 'number', step: '0.1' },
    { type: 'section', label: 'SMS, USSD & mobile money' }, { name: 'sms_notifications', label: 'Send SMS for bills, receipts and card top-ups', type: 'checkbox' }, { name: 'ussd_code', label: 'USSD code shown to customers' },
    { name: 'momo_mtn_merchant', label: 'MTN MoMo merchant / pay code' }, { name: 'momo_orange_merchant', label: 'Orange Money merchant / pay code' },
    { type: 'section', label: 'Water balance assumptions (labelled as estimates)' }, { name: 'unbilled_authorized_pct', label: 'Unbilled authorised use (% of input)', type: 'number', step: '0.1' },
    { name: 'meter_under_registration_pct', label: 'Customer meter under-registration (% of metered use)', type: 'number', step: '0.1' }, { name: 'unauthorized_consumption_pct', label: 'Unauthorised use (% of input)', type: 'number', step: '0.1' },
    { type: 'section', label: 'Collections (humane)' }, { name: 'auto_reminders', label: 'Send SMS reminders automatically every day', type: 'checkbox' }, { name: 'reminder_days_before_due', label: 'Remind this many days before due', type: 'number' },
    { name: 'reminder_days_overdue', label: 'Overdue reminder after (days)', type: 'number' }, { name: 'plan_default_after_days', label: 'Plan defaults after an instalment is late by (days)', type: 'number' },
    { type: 'section', label: 'Affordability (tariff lab)' }, { name: 'median_household_income_LRD', label: 'Median household income, LRD per month (assumption)', type: 'number' }, { name: 'median_household_income_USD', label: 'Median household income, USD per month (assumption)', type: 'number' },
    { name: 'affordability_threshold_pct', label: 'Affordability line (% of income)', type: 'number', step: '0.1' }, { name: 'avg_household_size', label: 'Average household size', type: 'number', step: '0.1' }, { name: 'lifeline_lpcd', label: 'Lifeline litres per person per day', type: 'number' },
    { type: 'section', label: 'Community & operations' }, { name: 'public_status_enabled', label: 'Public status page and no-login reporting at /status', type: 'checkbox' }, { name: 'wq_sampling_days', label: 'Water-quality sampling interval (days)', type: 'number' },
    { name: 'briefing_sms_phone', label: 'Send the morning briefing by SMS to (phone)' },
    { type: 'section', label: 'New connections (standard costs, in USD — converted for LRD areas at the latest exchange rate)' }, { name: 'connection_base_fee', label: 'Connection fee (tapping, labour)', type: 'number', step: '0.01' },
    { name: 'connection_pipe_cost_per_m', label: 'Service pipe cost per metre', type: 'number', step: '0.01' }, { name: 'connection_meter_cost', label: 'Meter and box', type: 'number', step: '0.01' }, { name: 'connection_max_instalments', label: 'Maximum monthly instalments', type: 'number' },
    { type: 'section', label: 'Supply timetable & feedback' }, { name: 'supply_sms_enabled', label: 'SMS customers before their water comes on', type: 'checkbox' }, { name: 'supply_notice_hours', label: 'Send the heads-up this many hours before', type: 'number', step: '0.5' },
    { name: 'feedback_sms_enabled', label: 'Ask customers to rate completed repairs by SMS (reply 1–5)', type: 'checkbox' },
    { type: 'section', label: 'Meter replacement planner (assumptions — calibrate with bench tests)' }, { name: 'meter_wear_pct_per_year', label: 'Mechanical meter under-reading added per year (%)', type: 'number', step: '0.05' },
    { name: 'meter_wear_start_years', label: 'Wear starts after (years)', type: 'number', step: '0.5' }, { name: 'meter_life_years', label: 'Design life (years)', type: 'number' }, { name: 'meter_life_volume_m3', label: 'Design lifetime volume (m³)', type: 'number' },
    { name: 'meter_max_under_registration_pct', label: 'Cap on estimated under-reading (%)', type: 'number' }, { name: 'meter_replacement_labour_usd', label: 'Labour per replacement (USD)', type: 'number', step: '0.01' },
    { type: 'section', label: 'Sign-in security' }, { name: 'require_2fa_roles', label: 'Require two-factor sign-in for roles', full: true, placeholder: 'admin,manager,cashier', help: 'Comma-separated role codes: admin, manager, cashier (cashier / billing officer), technician, meter_reader, attendant. Users in these roles must set up an authenticator app at next sign-in.' }], { auto_reminders: '1', ...s })}
    <div class="full"><button class="btn primary">Save settings</button></div></form></div>
    <div class="card"><div class="card-head"><h2>Exchange rates (USD ⇄ LRD)</h2><button class="btn primary" data-act="rate">+ Add rate</button></div>
      <div class="note">Not hard-coded. Used only to convert payments tendered in another currency and for optional combined dashboard totals. The rate effective on the payment date is used and stored with the receipt.</div>
      ${table([{ label: 'Effective', render: r => fmtDate(r.effective_date) }, { label: 'Rate', render: r => `1 ${r.from_currency} = ${r.rate} ${r.to_currency}` }, { label: 'Source', key: 'source_note' }, { label: 'By', key: 'created_by_name' }], rates)}</div></div>`);
  $('#sf', el).addEventListener('submit', async e => { e.preventDefault(); const f = e.target; const v = {}; for (const i of f.elements) if (i.name) v[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value;
    try { await api('/api/settings', { method: 'PUT', body: v }); toast('Settings saved', 'ok'); } catch (err) { toast(err.message, 'err'); } });
  bind(el, { rate: () => modal('Add exchange rate', html`<div class="form">${formFields([{ name: 'from_currency', label: 'From', type: 'select', options: currencies(), required: true, default: 'USD' }, { name: 'to_currency', label: 'To', type: 'select', options: currencies(), required: true, default: 'LRD' },
    { name: 'rate', label: 'Rate (1 From = ? To)', type: 'number', step: 'any', required: true }, { name: 'effective_date', label: 'Effective date', type: 'date', required: true, default: today() }, { name: 'source_note', label: 'Source (e.g. board resolution, CBL reference rate of date)', required: true, full: true }])}</div>`,
    { onSubmit: async v => { await api('/api/exchange-rates', { body: v }); toast('Rate added', 'ok'); settings(el); } }) });
}

// ---------- Integrations ----------
async function integrations(el) {
  const d = await api('/api/integrations'); const manage = can('integrations.manage');
  const statusCls = { info_required: 'serious', ready_for_implementation: 'info', configured_unverified: 'warn', verified: 'good', disabled: 'outline', simulator: 'sim' };
  mount(el, html`<div class="note"><b>No real meter is connected unless its integration shows “Verified live integration”.</b> Each integration must first have the exact meter model, communication band, protocol, data format, encryption, documentation and vendor access recorded. It can then be issued an API key, receive test data (flagged as unverified) and finally be verified against the physical meter display.</div>
    <div class="grid g2">
      <div class="card"><h2>Built-in methods</h2>${table([{ label: 'Method', render: b => label(b.method) }, { label: 'Status', render: b => html`<span class="badge good">${b.status}</span>` }], d.built_in)}</div>
      <div class="card"><h2>Required before connecting a real meter model / network</h2><ol style="margin:0;padding-left:1.2rem;font-size:.9rem">${d.required_info.map(r => html`<li><b>${r.label}</b><br><small class="muted">${r.help}</small></li>`)}</ol></div></div>
    <div class="card"><div class="card-head"><h2>Integration profiles</h2>${manage ? html`<button class="btn primary" data-act="new">+ New integration profile</button>` : ''}</div>
      ${d.integrations.map(i => html`<div class="card" style="box-shadow:none">
        <div class="card-head"><div><b>${i.name}</b> <span class="badge ${statusCls[i.status]}">${i.status_label}</span><br><small>${label(i.method)} · ${i.adapter_label || i.adapter} · ${i.meters} meter(s) linked</small></div>
        ${manage ? html`<div style="display:flex;gap:.4rem;flex-wrap:wrap">${i.is_simulator ? html`${['normal', 'leak', 'reverse_flow', 'tamper', 'low_battery'].map(s => html`<button class="btn sm" data-act="sim" data-id="${i.id}" data-s="${s}">Simulate ${label(s)}</button>`)}` : html`
          <button class="btn sm" data-act="edit" data-id="${i.id}">Edit details</button>${!i.missing_info.length && i.status !== 'disabled' ? html`<button class="btn sm" data-act="key" data-id="${i.id}">${i.has_api_key ? 'Rotate API key' : 'Issue API key'}</button>` : ''}
          ${i.status === 'configured_unverified' ? html`<button class="btn sm good" data-act="verify" data-id="${i.id}">Mark verified</button>` : ''}<button class="btn sm" data-act="msgs" data-id="${i.id}">Messages</button>${i.status !== 'disabled' ? html`<button class="btn sm danger" data-act="disable" data-id="${i.id}">Disable</button>` : ''}`}</div>` : ''}</div>
        ${i.is_simulator ? html`<div class="note sim">Demo simulator. Generates fictional readings labelled SIMULATED for meters linked to it. It is not a device connection and its readings can never be approved in the live system.</div>` : html`
        ${i.missing_info.length ? html`<div class="note warn"><b>Missing information:</b> ${i.missing_info.map(k => (d.required_info.find(r => r.key === k) || {}).label).join(' · ')}</div>` : ''}
        <dl class="kv" style="font-size:.85rem"><dt>Vendor / model</dt><dd>${i.vendor || '—'} / ${i.meter_model || '—'}</dd><dt>Band / protocol</dt><dd>${i.comm_band || '—'} / ${i.protocol || '—'}</dd><dt>Data format</dt><dd>${i.data_format || '—'}</dd><dt>Encryption</dt><dd>${i.encryption || '—'}</dd>
          <dt>Documentation</dt><dd>${i.docs_url || '—'}</dd><dt>Vendor access</dt><dd>${i.vendor_access || '—'}</dd><dt>Inbound endpoint</dt><dd class="mono">POST ${location.origin}${i.ingest_url} (header X-Api-Key${i.api_key_hint ? ' …' + i.api_key_hint : ' — not issued'})</dd>
          <dt>Last message</dt><dd>${fmtDT(i.last_message_at)} · ${i.messages_ok} valid reading(s)${i.last_error ? html` · <span class="badge crit">${i.last_error}</span>` : ''}</dd>${i.verified_at ? html`<dt>Verified</dt><dd>${fmtDT(i.verified_at)} — ${i.verification_note}</dd>` : ''}</dl>`}
      </div>`)}</div>`);
  const form = i => modal(i ? 'Edit integration profile' : 'New integration profile', html`<div class="note">Fill in every required item from the vendor's documentation. Until all are complete the integration cannot receive data. Changing technical details of a verified integration returns it to “not verified”.</div><div class="form">${formFields([
    { name: 'name', label: 'Profile name', required: true, full: true }, { name: 'method', label: 'Method', type: 'select', options: ['pulse', 'lorawan', 'nbiot', 'cellular', 'wmbus', 'serial', 'vendor_api'], required: true },
    { name: 'adapter', label: 'Adapter', type: 'select', options: d.adapters.filter(a => a.inbound).map(a => [a.key, a.label]), required: true }, { name: 'vendor', label: 'Vendor / supplier' },
    ...d.required_info.map(r => ({ name: r.key, label: r.label, help: r.help, full: true, type: ['data_format', 'encryption', 'vendor_access'].includes(r.key) ? 'textarea' : 'text', required: false })),
    { name: 'network_server', label: 'Network server / gateway / collector', full: true }, { name: 'field_mapping', label: 'Field mapping JSON (optional — overrides adapter defaults)', type: 'textarea', full: true, placeholder: '{"device_id":"deviceInfo.devEui","value":"object.volume_m3","timestamp":"time"}' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true }], i ? { ...i, field_mapping: i.field_mapping || '' } : {})}</div>`,
    { wide: true, onSubmit: async v => { if (!v.field_mapping) v.field_mapping = null; if (i) { const r = await api('/api/integrations/' + i.id, { method: 'PUT', body: v }); toast('Saved — status: ' + label(r.status), 'ok'); } else await api('/api/integrations', { body: v }); state.lookups = null; integrations(el); } });
  const find = id => d.integrations.find(x => x.id === Number(id));
  bind(el, {
    new: () => form(), edit: b => form(find(b.dataset.id)),
    key: async b => { if (!await confirmBox('Issue API key', 'A new key replaces any previous key. Readings received will be flagged “unverified” until you mark the integration verified.', { ok: 'Issue key' })) return; const r = await api(`/api/integrations/${b.dataset.id}/api-key`, { body: {} });
      modal('API key (shown once)', html`<p>${r.note}</p><p class="mono" style="word-break:break-all;background:#f3f5f7;padding:.6rem;border-radius:6px">${r.api_key}</p>`, {}); integrations(el); },
    verify: async b => { const note = await confirmBox('Verify integration', 'Only verify after comparing transmitted readings with the physical meter display for several meters/days. Describe what you checked.', { reason: true, reasonLabel: 'Verification evidence', ok: 'Mark verified' }); if (!note) return; await api(`/api/integrations/${b.dataset.id}/verify`, { body: { note } }); toast('Integration verified', 'ok'); integrations(el); },
    disable: async b => { if (await confirmBox('Disable integration', 'The API key is revoked and no further data is accepted.', { danger: true, ok: 'Disable' })) { await api(`/api/integrations/${b.dataset.id}/disable`, { body: {} }); integrations(el); } },
    msgs: async b => { const m = await api(`/api/integrations/${b.dataset.id}/messages`); modal('Recent inbound messages', table([{ label: 'Received', render: x => fmtDT(x.received_at) }, { label: 'OK', render: x => badge(x.ok ? 'approved' : 'rejected', x.ok ? 'ok' : 'error') }, { label: 'Result', render: x => html`<small class="mono">${x.result}</small>` }, { label: 'Payload', render: x => html`<small class="mono">${(x.payload || '').slice(0, 300)}</small>` }], m, { empty: 'No messages received yet.' }), { wide: true }); },
    sim: async b => { const r = await api(`/api/integrations/${b.dataset.id}/simulate`, { body: { scenario: b.dataset.s, hours: 24 } }); toast(`${r.created} SIMULATED readings created (${label(r.scenario)}). Run alert checks to evaluate.`, 'ok'); }
  });
}

// ---------- Alert rules ----------
async function alertRules(el) {
  const rows = await api('/api/alert-rules');
  mount(el, html`<div class="card"><h2>Alert rules</h2><div class="note">Rules run when you press “Run alert checks” (Alerts page or dashboard). Device-only rules (reverse flow, tamper, battery, communication) only trigger for meters whose integration reports those events.</div>
    ${table([{ label: 'Rule', render: r => html`<b>${r.name}</b><br><small>${r.description}</small>` }, { label: 'Severity', render: r => badge(r.severity) }, { label: 'Parameters', render: r => html`<small class="mono">${Object.entries(JSON.parse(r.params_json)).map(([k, v]) => `${k}=${v}`).join(', ')}</small>` },
      { label: 'Enabled', render: r => badge(r.enabled ? 'active' : 'disabled', r.enabled ? 'On' : 'Off') }, { label: '', render: r => html`<button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button>` }], rows)}</div>`);
  bind(el, { edit: b => { const r = rows.find(x => x.id === Number(b.dataset.id)); const P = JSON.parse(r.params_json);
    modal('Edit rule: ' + r.name, html`<div class="form">${formFields([{ name: 'enabled', label: 'Enabled', type: 'checkbox', default: !!r.enabled }, { name: 'severity', label: 'Severity', type: 'select', options: ['low', 'medium', 'high', 'critical'], blank: false, default: r.severity },
      ...Object.keys(P).map(k => ({ name: 'p_' + k, label: label(k), type: 'number', step: 'any', default: P[k] }))])}</div>`,
      { onSubmit: async v => { const params = {}; for (const k of Object.keys(P)) params[k] = v['p_' + k]; await api('/api/alert-rules/' + r.id, { method: 'PUT', body: { enabled: v.enabled, severity: v.severity, params } }); toast('Rule saved', 'ok'); alertRules(el); } }); } });
}

// ---------- Notices ----------
async function notices(el) {
  const rows = await api('/api/notices'); const L = await ensureLookups();
  mount(el, html`<div class="card"><div class="card-head"><h2>Service notices</h2><button class="btn primary" data-act="new">+ New notice</button></div><div class="note">Shown in the customer portal for the selected area (or all areas).</div>
    ${table([{ label: 'Created', render: n => fmtDate(n.created_at) }, { label: 'Title', key: 'title' }, { label: 'Type', render: n => label(n.notice_type) }, { label: 'Area', render: n => n.area_name || 'All' }, { label: 'Dates', render: n => `${fmtDate(n.starts_at)} – ${fmtDate(n.ends_at)}` }, { label: 'Message', key: 'body' }], rows)}</div>`);
  bind(el, { new: () => modal('New service notice', html`<div class="form">${formFields([{ name: 'title', label: 'Title', required: true, full: true }, { name: 'notice_type', label: 'Type', type: 'select', options: ['outage', 'maintenance', 'quality', 'tariff', 'billing', 'general'], blank: false },
    { name: 'area_id', label: 'Area', type: 'select', options: L.areas.map(a => [a.id, a.name]), blank: 'All areas' }, { name: 'starts_at', label: 'From', type: 'date' }, { name: 'ends_at', label: 'Until', type: 'date' }, { name: 'body', label: 'Message', type: 'textarea', required: true, full: true },
    { name: 'sms_broadcast', label: 'Also SMS every customer and water-card holder in this area', type: 'checkbox', full: true }])}</div>`,
    { onSubmit: async v => { const r = await api('/api/notices', { body: v }); toast('Notice published' + (r.sms_sent ? ` and SMS sent to ${r.sms_sent} phones` : ''), 'ok'); notices(el); } }) });
}

// ---------- Backups ----------
async function backups(el) {
  const rows = await api('/api/backups');
  mount(el, html`<div class="card"><div class="card-head"><h2>Database backups</h2><button class="btn primary" data-act="now">Back up now</button></div>
    <div class="note">An automatic backup runs daily while the server is on. Download backups regularly and keep a copy off-site (e.g. encrypted USB drive or cloud storage). To restore, stop the server and replace the database file with a backup copy (see README).</div>
    ${table([{ label: 'File', render: b => html`<span class="mono">${b.file}</span>` }, { label: 'Created', render: b => fmtDT(b.created) }, { label: 'Size', cls: 'num', render: b => (b.size / 1024).toFixed(0) + ' KB' }, { label: '', render: b => html`<a class="btn sm" href="/api/backups/${b.file}">Download</a>` }], rows)}</div>`);
  bind(el, { now: async () => { const r = await api('/api/backups', { body: {} }); toast('Backup created: ' + r.file, 'ok'); backups(el); } });
}

// ---------- Audit log ----------
export async function audit(root, _p, q) {
  const [rows, chain] = [await api('/api/audit' + qs({ ...q, limit: 500 })), await api('/api/audit/verify')];
  mount(root, html`<div class="page-head"><div><h1>Audit log</h1><small>Append-only, hash-chained record of important changes</small></div><div class="actions"><a class="btn" href="/api/audit${qs({ ...q, format: 'csv', limit: 5000 })}">Export CSV</a></div></div>
    <div class="note ${chain.ok ? '' : 'crit'}">${chain.ok ? `Integrity check passed: ${chain.checked} entries, hash chain intact.` : `INTEGRITY CHECK FAILED at entry #${chain.broken_at_id}. The audit log may have been altered outside the application.`}</div>
    <form class="filters" id="af"><label>Action starts with<input name="action" value="${q.action || ''}" placeholder="reading., payment., auth."></label><label>Entity<input name="entity" value="${q.entity || ''}" placeholder="reading, bill, payment"></label>
      <label>Entity ID<input name="entity_id" value="${q.entity_id || ''}" style="width:90px"></label><label>User<input name="user" value="${q.user || ''}"></label><label>From<input type="date" name="from" value="${q.from || ''}"></label><label>To<input type="date" name="to" value="${q.to || ''}"></label><button class="btn primary">Filter</button></form>
    <div class="card flush">${table([{ label: '#', key: 'id' }, { label: 'When', render: a => fmtDT(a.at) }, { label: 'User', render: a => html`${a.username}<br><small>${label(a.role)}</small>` }, { label: 'Action', render: a => html`<span class="mono">${a.action}</span>` },
      { label: 'Record', render: a => (a.entity ? `${a.entity} ${a.entity_id || ''}` : '—') }, { label: 'Details', render: a => html`<small class="mono" style="word-break:break-word">${(a.details || '').slice(0, 400)}</small>` }, { label: 'IP', render: a => html`<small>${a.ip || ''}</small>` }], rows)}</div>`);
  $('#af', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/audit' + qs(Object.fromEntries(new FormData(e.target))); });
}
