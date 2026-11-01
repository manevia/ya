// Core UI helpers: safe HTML templating, API client, router, forms, tables, modals, toasts, charts.
import { I } from './i18n.js';
export { I, tr } from './i18n.js';
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(String(s));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = v => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
/** Tagged template that escapes every interpolated value unless wrapped in raw()/html`` */
export function html(strings, ...vals) { let out = ''; strings.forEach((s, i) => { out += s + (i < vals.length ? val(vals[i]) : ''); }); return new Raw(out); }

export const state = { user: null, mode: 'demo', lookups: null, online: navigator.onLine, settings: {} };
export const can = p => !!state.user && (p === 'portal.self' ? state.user.role === 'customer' : (state.user.perms.includes('*') || state.user.perms.includes(p)));
export const canAny = (...ps) => ps.some(can);

// ---------- API ----------
export class ApiError extends Error { constructor(status, msg, details) { super(msg); this.status = status; this.details = details; } }
export async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  let res;
  try { res = await fetch(path, init); } catch (e) { throw new ApiError(0, 'Network unavailable — check your connection'); }
  if (res.status === 401 && !opts.noRedirect) { state.user = null; location.hash = '#/login'; throw new ApiError(401, 'Please sign in'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : res.status === 204 ? null : await res.text();
  if (!res.ok) {
    if (data && data.details && data.details.code === 'PASSWORD_CHANGE_REQUIRED') location.hash = '#/password';
    if (data && data.details && data.details.code === 'TWO_FACTOR_SETUP_REQUIRED') { if (state.user) state.user.needs_2fa_setup = true; location.hash = '#/security'; }
    throw new ApiError(res.status, (data && data.error) || 'Request failed', data && data.details);
  }
  return data;
}
export const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== '' && v != null && v !== false) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
export function download(path) { const a = document.createElement('a'); a.href = path; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }

// ---------- formatting ----------
export const fmtNum = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString(I.locale || 'en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtM3 = n => (n == null ? '—' : fmtNum(n, n % 1 ? 1 : 0) + ' m³');
const curDigits = {}; const digitsOf = c => { if (!(c in curDigits)) { try { curDigits[c] = new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; } catch { curDigits[c] = 2; } } return curDigits[c]; };
/** Amount with the currency symbol set in Settings › Country (e.g. US$12.50, L$1,250.00, 12 500 FCFA); ISO code when no symbol is set. */
export const money = (n, cur) => { if (n == null) return '—'; const sym = ((cfg().currency_symbols) || {})[cur]; const num = fmtNum(n, cur ? digitsOf(cur) : 2); return !cur ? num : sym ? (/^[A-Za-z]{2,}$/.test(sym) ? `${num} ${sym}` : `${sym}${num}`) : `${num} ${cur}`; };
/** Regional configuration (currencies, mobile-money providers, phone prefix…) from the server. */
export const cfg = () => state.config || I.config || {};
export const currencies = () => cfg().currencies || ['USD'];
export const momoMethods = () => (cfg().momo_providers || []).map(p => ['mobile_money_' + p.code, 'Mobile money — ' + p.name]);
export const payMethods = (extra = []) => [['cash', 'Cash'], ...momoMethods(), ['bank_transfer', 'Bank transfer / deposit'], ['cheque', 'Cheque'], ...extra, ['other', 'Other']];
export const phoneHint = () => (cfg().phone_prefix || '+') + ' …';
export const methodLabel = m => (payMethods().find(x => x[0] === m) || [m, String(m).replace(/^mobile_money_/, 'Mobile money — ').replace(/_/g, ' ')])[1];
export const fmtDate = d => (d ? new Date(d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString(I.locale || 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDT = d => (d ? new Date(d).toLocaleString(I.locale || 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
export const label = s => (/^mobile_money_/.test(String(s)) ? methodLabel(s) : String(s ?? '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()));

const BADGE = {
  active: 'good', approved: 'good', paid: 'good', completed: 'good', operational: 'good', resolved: 'good', verified: 'good', posted: 'good', good: 'good',
  pending: 'warn', issued: 'info', partially_paid: 'warn', open: 'warn', acknowledged: 'info', assigned: 'info', in_progress: 'info', degraded: 'warn', maintenance: 'warn', fair: 'warn',
  work_order: 'info', configured_unverified: 'warn', ready_for_implementation: 'info', info_required: 'serious', on_hold: 'warn', in_stock: 'outline', planned: 'outline',
  overdue: 'crit', rejected: 'crit', faulty: 'crit', down: 'crit', suspended: 'serious', disconnected: 'crit', reversed: 'crit', reversal: 'serious', cancelled: 'outline', dismissed: 'outline', closed: 'outline', poor: 'serious',
  critical: 'crit', high: 'serious', medium: 'warn', low: 'info', simulator: 'sim', disabled: 'outline', removed: 'outline', replaced: 'outline'
};
export const badge = (s, text) => html`<span class="badge ${BADGE[s] || ''}">${text || label(s)}</span>`;
export const sevBadge = s => html`<span class="badge ${BADGE[s]}">${{ critical: '⛔', high: '▲', medium: '●', low: '○' }[s] || ''} ${label(s)}</span>`;
export const simBadge = () => html`<span class="badge sim" title="Fictional data from the demo simulator">SIMULATED</span>`;
export const estBadge = () => html`<span class="badge warn" title="Not an actual meter reading">ESTIMATED</span>`;
export const basisBadge = b => (!b ? '' : b === 'simulated' ? simBadge() : b === 'estimated' ? estBadge() : b === 'measured' ? html`<span class="badge info" title="From a device/sensor">Measured</span>` : html`<span class="badge outline" title="Manually entered or inferred from manual readings">Manual</span>`);
export let FLAGS = {};
export const setFlags = f => { FLAGS = f; };
const FLAG_CLS = { simulated: 'sim', estimated: 'warn', decreasing: 'crit', duplicate: 'crit', unusually_high: 'serious', reverse_flow: 'crit', tamper: 'crit', device_fault: 'crit', unverified_source: 'serious', offline_capture: 'info', corrected: 'info', leak: 'serious' };
export const flagBadges = arr => { const a = typeof arr === 'string' ? JSON.parse(arr || '[]') : arr || []; return a.length ? html`<span class="flags">${a.map(f => html`<span class="badge ${FLAG_CLS[f] || 'warn'}" title="${FLAGS[f] || f}">${FLAGS[f] || label(f)}</span>`)}</span>` : html`<span class="muted">—</span>`; };

// ---------- DOM helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(root, content) { root.innerHTML = content instanceof Raw ? content.s : esc(content); return root; }
/** Bind click handlers: elements with data-act="name" call actions[name](el, event). */
export function bind(root, actions) {
  // One action map per element: re-rendering a view replaces (never stacks) its click handler.
  if (root._bound) root.removeEventListener('click', root._bound);
  root.addEventListener('click', root._bound = e => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el) || !actions[el.dataset.act]) return;
    e.preventDefault();
    Promise.resolve(actions[el.dataset.act](el, e)).catch(err => toast(err.message, 'err'));
  });
}
export function toast(msg, kind = '') {
  const box = $('#toasts'); const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}
export const loading = () => html`<div class="empty">Loading…</div>`;

// ---------- forms ----------
/** fields: [{name,label,type,options,required,help,full,step,min,max,placeholder,attrs}] */
export function formFields(fields, v = {}) {
  return html`${fields.map(f => {
    if (f.type === 'section') return html`<h3 class="full" style="margin-top:.5rem">${f.label}</h3>`;
    if (f.type === 'note') return html`<div class="full note ${f.kind || ''}">${f.label}</div>`;
    const value = v[f.name] ?? f.default ?? '';
    const req = f.required ? raw(' required') : '';
    let input;
    if (f.type === 'select') input = html`<select name="${f.name}"${req}>${f.blank !== false ? html`<option value="">${f.blank || '— select —'}</option>` : ''}${(f.options || []).map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, label(o)]; return html`<option value="${ov}"${String(ov) === String(value) ? raw(' selected') : ''}>${ol}</option>`; })}</select>`;
    else if (f.type === 'textarea') input = html`<textarea name="${f.name}"${req} placeholder="${f.placeholder || ''}">${value}</textarea>`;
    else if (f.type === 'checkbox') return html`<label class="f chk ${f.full ? 'full' : ''}"><input type="checkbox" name="${f.name}"${value === true || value === 1 || value === '1' ? raw(' checked') : ''}> ${f.label}${f.help ? html` <span class="help">${f.help}</span>` : ''}</label>`;
    else if (f.type === 'checks') input = html`<div class="flags">${f.options.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, label(o)]; return html`<label class="chk" style="display:flex;gap:.3rem;align-items:center;font-weight:400"><input type="checkbox" name="${f.name}" value="${ov}"${(value || []).includes(ov) ? raw(' checked') : ''}>${ol}</label>`; })}</div>`;
    else input = html`<input name="${f.name}" type="${f.type || 'text'}" value="${value}"${req}${f.step ? raw(` step="${esc(f.step)}"`) : ''}${f.min != null ? raw(` min="${esc(f.min)}"`) : ''}${f.max != null ? raw(` max="${esc(f.max)}"`) : ''} placeholder="${f.placeholder || ''}"${f.inputmode ? raw(` inputmode="${esc(f.inputmode)}"`) : ''}${f.readonly ? raw(' readonly') : ''}>`;
    return html`<label class="f ${f.full ? 'full' : ''}"><span class="${f.required ? 'req' : ''}">${f.label}</span>${input}${f.help ? html`<span class="help">${f.help}</span>` : ''}</label>`;
  })}`;
}
export function readForm(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox' && $$(`input[type=checkbox][name="${el.name}"]`, form).length > 1) { o[el.name] = o[el.name] || []; if (el.checked) o[el.name].push(el.value); continue; }
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
    else if (el.type === 'datetime-local') o[el.name] = el.value ? new Date(el.value).toISOString() : null;
    else if (el.tagName === 'SELECT' && /^\d+$/.test(el.value) && el.dataset.str !== '1' && /_id$|^assigned_to$/.test(el.name)) o[el.name] = Number(el.value);
    else o[el.name] = el.value === '' ? null : el.value;
  }
  return o;
}

// ---------- modal ----------
export function modal(title, body, { submitLabel = 'Save', onSubmit, wide = false, danger = false, noFooter = false } = {}) {
  const d = document.createElement('dialog');
  if (wide) d.style.width = 'min(1000px, 96vw)';
  d.innerHTML = html`<form method="dialog" novalidate><div class="dh"><h2 style="margin:0">${title}</h2><button class="x" value="cancel" type="button" data-close aria-label="Close">×</button></div>
    <div class="db">${body}</div>${noFooter ? '' : html`<div class="df"><button type="button" class="btn" data-close>Cancel</button>${onSubmit ? html`<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${submitLabel}</button>` : ''}</div>`}</form>`.s;
  document.body.appendChild(d);
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  d.addEventListener('cancel', () => d.remove());
  const form = d.querySelector('form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!onSubmit) return close();
    const inner = d.querySelector('.db form, .db') ;
    const bad = [...form.elements].find(el => el.required && !el.value);
    if (bad) { bad.focus(); toast('Please fill the required fields', 'err'); return; }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try { const r = await onSubmit(readForm(form), d); if (r !== false) close(); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  });
  d.showModal();
  return { el: d, close };
}
export function confirmBox(title, message, { ok = 'Confirm', danger = false, reason = false, reasonLabel = 'Reason' } = {}) {
  return new Promise(resolve => {
    let done = false;
    const m = modal(title, html`<p>${message}</p>${reason ? html`<div class="form"><label class="f full"><span class="req">${reasonLabel}</span><textarea name="reason" required></textarea></label></div>` : ''}`,
      { submitLabel: ok, danger, onSubmit: v => { done = true; resolve(reason ? v.reason : true); } });
    m.el.addEventListener('close', () => { if (!done) resolve(null); });
  });
}

// ---------- tables ----------
/** columns: [{key,label,render(r),cls}], opts: {href(r), empty, foot} */
export function table(columns, rows, opts = {}) {
  if (!rows || !rows.length) return html`<div class="empty">${opts.empty || 'No records found.'}</div>`;
  return html`<div class="table-wrap"><table class="t"><thead><tr>${columns.map(c => html`<th class="${c.cls || ''}">${c.label}</th>`)}</tr></thead><tbody>
    ${rows.map(r => html`<tr${opts.href ? raw(` class="click" data-href="${esc(opts.href(r))}"`) : ''}>${columns.map(c => html`<td class="${c.cls || ''}">${c.render ? c.render(r) : r[c.key] ?? '—'}</td>`)}</tr>`)}
    </tbody>${opts.foot ? html`<tfoot>${opts.foot}</tfoot>` : ''}</table></div>`;
}
document.addEventListener('click', e => {
  const tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a,button,input,select')) location.hash = tr.dataset.href;
});

// ---------- charts (SVG, hand-built, with hover tooltips & legend) ----------
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
/** Stacked bar chart. data: [{x, parts:{seriesName:value}}], series: ordered names (stable colour per name) */
export function stackedBars(data, series, { height = 220, unit = '', colors } = {}) {
  if (!data.length) return html`<div class="empty">No data for this period.</div>`;
  const W = 640, H = height, L = 52, B = 26, T = 8;
  const max = Math.max(1, ...data.map(d => series.reduce((s, k) => s + (d.parts[k] || 0), 0)));
  const nice = niceMax(max); const bw = Math.min(46, (W - L - 10) / data.length * 0.6); const step = (W - L - 10) / data.length;
  const y = v => T + (H - T - B) * (1 - v / nice);
  const lead = nice / Math.pow(10, Math.floor(Math.log10(nice))); const nt = lead === 2 ? 4 : 5; const ticks = Array.from({ length: nt + 1 }, (_, i) => i / nt * nice);
  const col = s => (colors && colors[s]) || SERIES[series.indexOf(s) % 8];
  let marks = '';
  data.forEach((d, i) => {
    let acc = 0; const x = L + i * step + (step - bw) / 2;
    series.forEach((s) => {
      const v = d.parts[s] || 0; if (!v) return;
      const y1 = y(acc + v), y0 = y(acc); acc += v;
      marks += `<rect class="mark" x="${x}" y="${y1}" width="${bw}" height="${Math.max(0, y0 - y1 - 2)}" rx="2" fill="${col(s)}" data-tip="${esc(d.x)} · ${esc(s)}: ${esc(fmtNum(v, 1))} ${esc(unit)}"></rect>`;
    });
    marks += `<text class="lbl" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.x)}</text>`;
  });
  const grid = ticks.map(t => `<g class="grid"><line x1="${L}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}"></line></g><text class="lbl" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(compact(t))}</text>`).join('');
  return html`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked bar chart">${raw(grid + marks)}</svg><div class="tip"></div>
    ${series.length > 1 ? html`<div class="legend">${series.map(s => html`<span><i style="background:${raw(col(s))}"></i>${label(s)}</span>`)}</div>` : ''}</div>`;
}
export function hbars(items, { unit = '', color = 'var(--s1)', fmt } = {}) {
  if (!items.length) return html`<div class="empty">No data.</div>`;
  const max = Math.max(1, ...items.map(i => i.value));
  return html`<div>${items.map(i => html`<div style="margin:.35rem 0"><div style="display:flex;justify-content:space-between;font-size:.85rem"><span>${i.label}</span><span class="num">${fmt ? fmt(i.value) : fmtNum(i.value, 0) + ' ' + unit}</span></div>
    <div class="bar"><span style="width:${raw((i.value / max * 100).toFixed(1))}%;background:${raw(i.color || color)}"></span></div></div>`)}</div>`;
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
const compact = n => (n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(+n.toFixed(1)));
document.addEventListener('mousemove', e => {
  const m = e.target.closest && e.target.closest('.chart [data-tip]');
  document.querySelectorAll('.chart .tip').forEach(t => { if (!m || !t.parentElement.contains(m)) t.style.display = 'none'; });
  if (!m) return;
  const box = m.closest('.chart'); const tip = box.querySelector('.tip'); const r = box.getBoundingClientRect();
  tip.textContent = m.dataset.tip; tip.style.display = 'block'; tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px';
});

/** Simple map-ready scatter of lat/lng points (no external tiles needed). points: [{lat,lng,label,color,href}] */
export function pointMap(points, { height = 320 } = {}) {
  const pts = points.filter(p => p.lat != null && p.lng != null);
  if (!pts.length) return html`<div class="empty">No GPS coordinates recorded.</div>`;
  const W = 640, H = height, pad = 24;
  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  let [minLa, maxLa, minLo, maxLo] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  if (maxLa - minLa < 0.002) { minLa -= 0.002; maxLa += 0.002; } if (maxLo - minLo < 0.002) { minLo -= 0.002; maxLo += 0.002; }
  const sx = Math.min((W - 2 * pad) / (maxLo - minLo), (H - 2 * pad) / (maxLa - minLa));
  const X = lo => pad + (lo - minLo) * sx + ((W - 2 * pad) - (maxLo - minLo) * sx) / 2, Y = la => H - pad - (la - minLa) * sx - ((H - 2 * pad) - (maxLa - minLa) * sx) / 2;
  const marks = pts.map(p => `<a href="${esc(p.href || '#')}"><circle cx="${X(p.lng).toFixed(1)}" cy="${Y(p.lat).toFixed(1)}" r="${p.r || 6}" fill="${p.color || 'var(--s1)'}" data-tip="${esc(p.label)}"></circle></a>`).join('');
  return html`<div class="chart map"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Location map">${raw(marks)}</svg><div class="tip"></div></div>`;
}
/** One small map per group (e.g. per service area) so distant areas don't squash each other. */
export function groupedMaps(points, { height = 220 } = {}) {
  const groups = {}; for (const p of points) if (p.lat != null) (groups[p.group || 'Other'] = groups[p.group || 'Other'] || []).push(p);
  const keys = Object.keys(groups).sort();
  if (!keys.length) return html`<div class="empty">No GPS coordinates recorded.</div>`;
  return html`<div class="grid ${keys.length > 2 ? 'g3' : keys.length === 2 ? 'g2' : ''}">${keys.map(k => html`<div><h3>${k}</h3>${pointMap(groups[k].map(p => ({ ...p, r: (p.r || 6) * (keys.length > 1 ? 1.7 : 1) })), { height })}</div>`)}</div>`;
}
export const osmLink = (lat, lng) => (lat != null && lng != null ? html`<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}" target="_blank" rel="noopener">${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)} ↗</a>` : html`<span class="muted">No GPS</span>`);
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }));
