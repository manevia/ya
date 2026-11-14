import { api, state, can, canAny, html, raw, mount, $, $$, toast, bind, setFlags, esc } from './core.js';
import { kvGet, kvSet, pendingCount, syncQueue } from './offline.js';
import { initI18n, switchLanguage, languagePicker, I } from './i18n.js';
import * as dash from './views/dashboard.js';
import * as cust from './views/customers.js';
import * as field from './views/field.js';
import * as rd from './views/readings.js';
import * as bill from './views/billing.js';
import * as ops from './views/ops.js';
import * as net from './views/network.js';
import * as adm from './views/admin.js';
import * as portal from './views/portal.js';
import * as ch from './views/channels.js';
import * as wpv from './views/waterpoints.js';
import * as wl from './views/waterloss.js';
import { wpSync } from './offline.js';
import * as wqv from './views/quality.js';
import * as colv from './views/collections.js';
import * as labv from './views/labs.js';
import * as wspv from './views/wsp.js';
import * as gr from './views/growth.js';
import * as sv from './views/service.js';
import * as opv from './views/operations.js';

const ROUTES = [
  ['/dashboard', dash.view, 'dashboard.view'],
  ['/field', field.view, 'field.read'],
  ['/customers', cust.list, 'customers.view'], ['/customers/:id', cust.detail, 'customers.view'],
  ['/meters', cust.meters, 'meters.view'], ['/meters/:id', cust.meterDetail, 'meters.view'],
  ['/readings', rd.review, ['readings.view']], ['/readings/import', rd.importView, 'readings.import'],
  ['/billing', bill.bills, 'billing.view'], ['/billing/generate', bill.generate, 'billing.generate'], ['/bills/:id', bill.billDetail, 'billing.view'],
  ['/payments', bill.payments, 'billing.view'], ['/payments/:id', bill.receipt, 'billing.view'], ['/adjustments', bill.adjustments, ['adjustments.create', 'adjustments.approve']],
  ['/statement/:id', bill.statement, 'billing.view'],
  ['/alerts', ops.alerts, 'alerts.view'], ['/work-orders', ops.workOrders, 'workorders.view'], ['/work-orders/:id', ops.workOrder, 'workorders.view'],
  ['/network', net.list, 'assets.view'], ['/network/:id', net.detail, 'assets.view'],
  ['/reports', dash.reports, 'reports.view'],
  ['/admin', adm.view, ['users.manage', 'integrations.view', 'settings.manage', 'notices.manage']], ['/admin/:tab', adm.view, ['users.manage', 'integrations.view', 'settings.manage', 'tariffs.view', 'areas.view', 'notices.manage']],
  ['/audit', adm.audit, 'audit.view'],
  ['/channels', ch.phone, 'channels.view'], ['/momo', ch.momo, 'momo.view'], ['/water-points', wpv.view, ['wp.view', 'wp.manage']], ['/kiosk', wpv.kiosk, 'wp.sell'], ['/water-loss', wl.view, 'nrw.view'], ['/water-quality', wqv.view, ['wq.view']], ['/water-safety', wspv.view, ['wsp.view', 'wsp.monitor', 'wsp.inspect']], ['/water-safety/h/:id', wspv.hazard, 'wsp.view'], ['/collections', colv.view, 'collections.view'], ['/tariff-lab', labv.tariffLab, 'tariff.lab'], ['/briefing', labv.briefing, 'briefing.view'],
  ['/connections', gr.connections, 'connections.view'], ['/connections/:id', gr.connection, 'connections.view'], ['/performance', gr.kpi, 'kpi.view'], ['/onboarding', gr.onboarding, 'onboarding.import'],
  ['/maintenance', opv.maintenance, 'maintenance.view'], ['/service-levels', opv.serviceLevels, 'servicelevels.view'], ['/cash', opv.cash, ['cash.close', 'cash.review']],
  ['/supply', sv.supply, 'supply.view'], ['/stores', sv.stores, ['stock.view', 'stock.issue']], ['/meter-planner', sv.meterPlanner, 'fleet.view'], ['/feedback', sv.feedbackView, 'feedback.view'],
  ['/translate/:lang', (r, p, q) => import('./views/locale.js').then(m => m.translate(r, p, q)), 'settings.manage'],
  ['/portal', portal.view, 'portal.self'], ['/portal/bills/:id', portal.bill, 'portal.self']
];

function nav() {
  const items = [
    ['Operations'],
    ['/briefing', '☀️', 'Morning briefing', 'briefing.view'],
    ['/dashboard', '📊', 'Dashboard', 'dashboard.view'],
    ['/field', '📱', 'Field reading', 'field.read'],
    ['/customers', '👥', 'Customers', 'customers.view'],
    ['/meters', '🔢', 'Meters', () => can('meters.view') && state.user.role !== 'meter_reader'],
    ['/readings', '✅', 'Readings review', 'readings.view'],
    ['/connections', '🔌', 'New connections', 'connections.view'],
    ['Billing'],
    ['/billing', '🧾', 'Bills', 'billing.view'],
    ['/payments', '💵', 'Payments', 'billing.view'],
    ['/adjustments', '⚖️', 'Adjustments', () => canAny('adjustments.create', 'adjustments.approve')],
    ['/momo', '📲', 'Mobile money', 'momo.view'],
    ['/collections', '🤝', 'Collections & plans', 'collections.view'],
    ['/cash', '🧮', 'Cash close', () => canAny('cash.close', 'cash.review')],
    ['Community access'],
    ['/kiosk', '🚰', 'Kiosk sales', () => state.user.role === 'attendant'],
    ['/water-points', '🚰', 'Water points & cards', () => canAny('wp.view', 'wp.manage') && state.user.role !== 'attendant'],
    ['/channels', '☎️', 'SMS & USSD', 'channels.view'],
    ['/supply', '🕒', 'Supply timetable', 'supply.view'],
    ['/water-quality', '🧪', 'Water quality', 'wq.view'],
    ['/water-safety', '🛡️', 'Water safety plan', () => canAny('wsp.view', 'wsp.monitor', 'wsp.inspect')],
    ['/feedback', '⭐', 'Customer feedback', 'feedback.view'],
    ['Network & service'],
    ['/alerts', '🚨', 'Alerts', 'alerts.view'],
    ['/work-orders', '🛠️', 'Work orders', 'workorders.view'],
    ['/network', '🗺️', 'Network assets', 'assets.view'],
    ['/stores', '📦', 'Stores', () => canAny('stock.view', 'stock.issue')],
    ['/meter-planner', '🔁', 'Meter replacement planner', 'fleet.view'],
    ['/maintenance', '🔧', 'Maintenance', 'maintenance.view'],
    ['/service-levels', '🎯', 'Service levels (SDG 6.1)', 'servicelevels.view'],
    ['/water-loss', '💧', 'Water-loss intelligence', 'nrw.view'],
    ['/tariff-lab', '🧮', 'Tariff & affordability lab', 'tariff.lab'],
    ['/performance', '📈', 'Cost recovery & KPIs', 'kpi.view'],
    ['/reports', '⬇️', 'Reports (CSV)', 'reports.view'],
    ['Administration'],
    ['/admin', '⚙️', 'Administration', () => canAny('users.manage', 'settings.manage', 'notices.manage', 'integrations.view')],
    ['/onboarding', '📥', 'Bring in records', 'onboarding.import'],
    ['/audit', '📜', 'Audit log', 'audit.view'],
    ['/portal', '🏠', 'My account', 'portal.self']
  ];
  const ok = i => (typeof i[3] === 'function' ? i[3]() : can(i[3]));
  const out = []; let pendingSec = null;
  for (const i of items) {
    if (i.length === 1) { pendingSec = i[0]; continue; }
    if (!ok(i)) continue;
    if (pendingSec) { out.push(html`<div class="sec">${pendingSec}</div>`); pendingSec = null; }
    out.push(html`<a href="#${i[0]}" data-path="${i[0]}"><span class="ico">${i[1]}</span>${i[2]}</a>`);
  }
  return html`${out}`;
}

function shell() {
  document.body.innerHTML = html`
    ${state.mode === 'demo' ? html`<div class="demo-banner">DEMO ENVIRONMENT — all customers, readings, payments and device data are fictional. Simulated device data is labelled SIMULATED.</div>` : ''}
    <div class="offline-banner" id="offline" hidden>You are offline. Field readings are saved on this device and will sync when the connection returns.</div>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><img src="/img/icon.svg" alt=""><div>AquaTrack<small>${state.orgName || 'Water utility'}</small></div></div>
        <nav class="nav">${nav()}</nav>
        <div class="userbox"><b>${state.user.full_name}</b>${state.user.role_label}<br>${raw(languagePicker('langpick', 'margin:.35rem 0;width:100%;font-size:.8rem'))}<a href="#/password" style="color:#9fd0ec">Password</a> · <a href="#/security" style="color:#9fd0ec">Security${state.user.two_factor ? ' 🔒' : ''}</a> · <a href="#" data-act="logout" style="color:#9fd0ec">Sign out</a></div>
      </aside>
      <div class="main">
        <div class="topbar"><button data-act="menu" aria-label="Menu">☰</button><b>AquaTrack</b><span style="margin-left:auto;font-size:.8rem">${state.user.role_label}</span></div>
        <main class="content" id="view"></main>
      </div>
    </div><div id="toasts"></div>`.s;
  bind(document.body, {
    menu: () => document.body.classList.toggle('nav-open'),
    logout: async () => { try { await api('/api/auth/logout', { body: {} }); } catch (_) {} state.user = null; await kvSet('me', null); location.hash = '#/login'; location.reload(); }
  });
  const lp = $('#langpick'); if (lp) lp.addEventListener('change', () => switchLanguage(lp.value, code => api('/api/auth/me/language', { method: 'PUT', body: { language: code } })));
  document.body.addEventListener('click', e => { if (e.target.closest('.nav a')) document.body.classList.remove('nav-open'); if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar,[data-act=menu]')) document.body.classList.remove('nav-open'); });
  updateOnline();
}
function updateOnline() { const b = $('#offline'); if (b) b.hidden = navigator.onLine; state.online = navigator.onLine; }
window.addEventListener('online', async () => { updateOnline(); if (state.user && state.user.role === 'attendant') { const r = await wpSync().catch(() => null); if (r && r.sent) toast(`${r.sent} kiosk sale(s) synchronised`, 'ok'); } if (state.user && can('field.read')) { const r = await syncQueue().catch(() => null); if (r && r.sent) toast(`${r.sent} offline reading(s) synchronised`, 'ok'); window.dispatchEvent(new Event('queue-changed')); } });
window.addEventListener('offline', updateOnline);

function home() { if (can('portal.self')) return '#/portal'; if (state.user.role === 'attendant') return '#/kiosk'; if (can('briefing.view')) return '#/briefing'; if (can('dashboard.view')) return '#/dashboard'; if (can('field.read')) return '#/field'; if (can('workorders.view')) return '#/work-orders'; return '#/customers'; }

async function router() {
  const hash = location.hash.slice(1) || '/';
  const [path, query] = hash.split('?');
  if (path === '/login') return loginView();
  if (!state.user) return loginView();
  if (path === '/password') { ensureShell(); return passwordView($('#view')); }
  if (path === '/security') { ensureShell(); const old = $('#view'); const root = old.cloneNode(false); old.replaceWith(root); return gr.security(root).catch(e => mount(root, html`<div class="card note crit">${e.message}</div>`)); }
  if (state.user.needs_2fa_setup && !state.user.must_change_password) { location.hash = '#/security'; return; }
  if (path === '/' || path === '') { location.hash = home(); return; }
  ensureShell();
  for (const [pat, fn, perm] of ROUTES) {
    const keys = []; const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = re.exec(path); if (!m) continue;
    const perms = Array.isArray(perm) ? perm : [perm];
    const old = $('#view'); const root = old.cloneNode(false); old.replaceWith(root); // fresh element: no listeners carried over from the previous page
    if (!perms.some(p => can(p))) { mount(root, html`<div class="card"><h2>Not available for your role</h2><p>Your role (${state.user.role_label}) cannot open this page.</p><a class="btn" href="${home()}">Go to my home page</a></div>`); return; }
    const params = {}; keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    $$('.nav a').forEach(a => a.classList.toggle('active', path === a.dataset.path || path.startsWith(a.dataset.path + '/')));
    root.innerHTML = '<div class="empty">Loading…</div>';
    window.scrollTo(0, 0);
    try { await fn(root, params, Object.fromEntries(new URLSearchParams(query || ''))); }
    catch (e) { if (e.status === 401) return; mount(root, html`<div class="card note crit"><b>Could not load this page.</b> ${e.message}</div>`); }
    return;
  }
  mount($('#view'), html`<div class="card"><h2>Page not found</h2><a href="${home()}">Go home</a></div>`);
}
let shellFor = null;
function ensureShell() { if (shellFor !== state.user.id) { shell(); shellFor = state.user.id; } }

function loginView() {
  shellFor = null;
  document.body.innerHTML = html`<div class="login-wrap"><div class="login">
    <div style="display:flex;gap:.6rem;align-items:center"><img src="/img/icon.svg" width="40" height="40" alt=""><div><h1>AquaTrack</h1><small>Smart Water Supply & Meter Management</small></div></div>
    ${state.mode === 'demo' ? html`<div class="note warn" style="margin-top:1rem"><b>Demo environment.</b> All data is fictional.</div>` : ''}
    <div style="text-align:right;margin-top:.5rem">${raw(languagePicker('langlogin', 'font-size:.85rem'))}</div>
    <form id="lf"><label>Username<input name="username" autocomplete="username" required autocapitalize="none"></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary lg block" type="submit">Sign in</button></form>
    <p style="text-align:center;margin:.8rem 0 0;font-size:.9rem"><a href="/status">💧 Water status & report a leak — no account needed</a></p>
    ${state.mode === 'demo' ? html`<div class="demo-users"><b>Demo accounts</b> (password <span class="mono">DemoPass2026</span>) — tap to fill:<br>
      ${['admin', 'manager', 'reader1', 'tech1', 'cashier', 'billing', 'attendant1', 'customer1'].map(u => html`<button class="btn sm" type="button" data-u="${u}">${u}</button>`)}</div>` : ''}
  </div></div><div id="toasts"></div>`.s;
  const ll = $('#langlogin'); if (ll) ll.addEventListener('change', () => switchLanguage(ll.value));
  $$('[data-u]').forEach(b => b.addEventListener('click', () => { $('#lf').username.value = b.dataset.u; $('#lf').password.value = 'DemoPass2026'; }));
  $('#lf').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      let r = await api('/api/auth/login', { body: { username: f.username.value, password: f.password.value }, noRedirect: true });
      if (r.two_factor_required) { r = await secondFactor(r.challenge); if (!r) return; }
      state.user = r.user; await afterLogin();
      if (r.user.language && r.user.language !== I.lang && (I.config?.languages || []).some(l => l.code === r.user.language)) { await kvSet('me', null).catch(() => {}); location.hash = home(); return switchLanguage(r.user.language); }
      location.hash = r.user.must_change_password ? '#/password' : state.user.needs_2fa_setup ? '#/security' : home();
      router();
    } catch (err) { toast(err.message, 'err'); }
  });
}
function secondFactor(challenge) {
  return new Promise(resolve => {
    const box = $('.login'); const prev = box.innerHTML;
    box.innerHTML = html`<h1>Two-factor sign-in</h1><p>Enter the 6-digit code from your authenticator app — or one of your recovery codes.</p>
      <form id="tf"><label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="11" autofocus style="font-size:1.4rem;letter-spacing:.2em"></label>
      <button class="btn primary lg block">Verify</button></form><p style="text-align:center"><a href="#/login" id="tback">Back</a></p>`.s;
    $('#tback').addEventListener('click', e => { e.preventDefault(); location.reload(); resolve(null); });
    $('#tf').addEventListener('submit', async e => { e.preventDefault();
      try { resolve(await api('/api/auth/login/2fa', { body: { challenge, code: e.target.code.value }, noRedirect: true })); }
      catch (err) { toast(err.message, 'err'); if (/expired|password again/i.test(err.message)) { box.innerHTML = prev; location.reload(); resolve(null); } e.target.code.value = ''; } });
    void prev;
  });
}
async function afterLogin() {
  const me = await api('/api/auth/me');
  Object.assign(state, { user: me.user, mode: me.mode, orgName: me.org_name, settings: me.settings, config: me.config });
  await kvSet('me', { user: me.user, mode: me.mode, orgName: me.org_name, settings: me.settings, config: me.config });
  if (can('readings.view') || can('readings.view_own')) api('/api/readings/flags').then(setFlags).catch(() => {});
}

function passwordView(root) {
  mount(root, html`<div class="card" style="max-width:520px"><h2>Change password</h2>${state.user.must_change_password ? html`<div class="note warn">You must set a new password before continuing.</div>` : ''}
    <form id="pf" class="form"><label class="f full"><span class="req">Current password</span><input type="password" name="current_password" required autocomplete="current-password"></label>
    <label class="f full"><span class="req">New password</span><input type="password" name="new_password" required minlength="10" autocomplete="new-password"><span class="help">At least 10 characters with letters and numbers.</span></label>
    <div class="full"><button class="btn primary">Update password</button></div></form></div>`);
  $('#pf').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/auth/change-password', { body: { current_password: e.target.current_password.value, new_password: e.target.new_password.value } }); toast('Password updated', 'ok'); state.user.must_change_password = false; location.hash = home(); }
    catch (err) { toast(err.message, 'err'); }
  });
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // The cached application page identifies which database to open even without a network.
  const pageMode = $('meta[name="aquatrack-mode"]')?.content;
  const knownMode = pageMode === 'live' || pageMode === 'demo';
  if (knownMode) state.mode = pageMode;
  await initI18n();
  try {
    // Older cached application pages may lack the mode marker.
    if (!knownMode) {
      const health = await api('/api/health');
      state.mode = health.mode;
    }
    const me = await api('/api/auth/me', { noRedirect: true });
    Object.assign(state, { user: me.user, mode: me.mode, orgName: me.org_name, settings: me.settings, config: me.config });
    await kvSet('me', { user: me.user, mode: me.mode, orgName: me.org_name, settings: me.settings, config: me.config });
    if (me.user.language && me.user.language !== I.lang && (I.config?.languages || []).some(l => l.code === me.user.language)) return switchLanguage(me.user.language);
    api('/api/readings/flags').then(setFlags).catch(() => {});
  } catch (e) {
    if (e.status === 401) {
      await kvSet('me', null).catch(() => {});
    } else if (e.status === 0 && knownMode) {
      const cached = await kvGet('me').catch(() => null);
      const user = cached?.user;
      if (cached?.mode === state.mode && user && !user.must_change_password && !user.needs_2fa_setup) {
        if (user.role === 'attendant' && user.perms.includes('wp.sell')) {
          Object.assign(state, cached);
          if (!/^#\/kiosk(?:\?|$)/.test(location.hash)) location.hash = '#/kiosk';
        } else if (user.perms.includes('field.read')) {
          Object.assign(state, cached);
          if (!/^#\/field(?:\?|$)/.test(location.hash)) location.hash = '#/field';
        }
      }
    }
  }
  window.addEventListener('hashchange', router);
  router();
  setInterval(() => { if (state.user && state.user.role === 'attendant' && navigator.onLine) wpSync().catch(() => {}); }, 60000);
  setInterval(async () => { if (state.user && can('field.read') && navigator.onLine && await pendingCount()) { const r = await syncQueue().catch(() => null); if (r && r.sent) { toast(`${r.sent} reading(s) synchronised`, 'ok'); window.dispatchEvent(new Event('queue-changed')); } } }, 60000);
}
boot();
export { router };
