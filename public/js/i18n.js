// Screen translation. The app is written in English; for another language every visible text node, placeholder,
// title and tooltip is looked up in a phrase dictionary (English → translation) as it is added to the page.
// Untranslated text simply stays in English, so a partly translated language is always usable.
// Dictionaries: /public/i18n/ui-<lang>.json plus edits made on the Languages page (served by /api/i18n/ui/<lang>).
export const I = { lang: 'en', locale: 'en-GB', dir: 'ltr', dict: {}, multi: [], config: null };

const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'NOSCRIPT']);
const EDGE = /^[\s\d.,:;()\-–—+×%/·•|#*!?"'«»]+|[\s\d.,:;()\-–—+×%/·•|#*!?"'«»]+$/g;
const set = new WeakMap(); // node → value we wrote (avoid re-translating our own output)

function lookup(t) { return Object.prototype.hasOwnProperty.call(I.dict, t) ? I.dict[t] : null; }
/** Translate one string (exact phrase, then phrase without surrounding numbers/punctuation, then known multi-word phrases inside it). */
export function tr(text) {
  if (I.lang === 'en' || !text || !/[A-Za-z]/.test(text)) return text;
  const t = text.trim(); if (!t) return text;
  let x = lookup(t); if (x != null) return text.replace(t, x);
  const core = t.replace(EDGE, '');
  if (core && core !== t) { x = lookup(core); if (x != null) return text.replace(core, x); }
  const lead = t.replace(/^[\s\d.,:;()\-–—+×%/·•|#]+/, ''); if (lead !== t) { x = lookup(lead); if (x != null) return text.replace(lead, x); }
  const trail = t.replace(/[\s\d.,:;()\-–—+×%/·•|#]+$/, ''); if (trail !== t) { x = lookup(trail); if (x != null) return text.replace(trail, x); }
  let out = text, hit = false;
  for (const k of I.multi) { if (k.length > out.length) continue; let i = out.indexOf(k);
    while (i >= 0) { const b = out[i - 1], a = out[i + k.length]; if (!(b && /[A-Za-z]/.test(b)) && !(a && /[A-Za-z]/.test(a))) { out = out.slice(0, i) + '\u0001' + I.dict[k] + '\u0002' + out.slice(i + k.length); hit = true; break; } i = out.indexOf(k, i + 1); } }
  return hit ? out.replace(/[\u0001\u0002]/g, '') : text;
}
const skip = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { if (SKIP.has(e.tagName) || e.classList?.contains('mono') || e.hasAttribute?.('data-noi18n')) return true; } return false; };
function trNode(n) {
  if (n.nodeType === 3) { if (set.get(n) === n.nodeValue || !n.parentElement || skip(n.parentElement)) return; const v = tr(n.nodeValue); if (v !== n.nodeValue) { n.nodeValue = v; set.set(n, v); } return; }
  if (n.nodeType !== 1 || SKIP.has(n.tagName) || n.hasAttribute('data-noi18n') || n.classList.contains('mono')) return;
  for (const a of ['placeholder', 'title', 'aria-label', 'alt']) if (n.hasAttribute(a)) { const v = tr(n.getAttribute(a)); if (v !== n.getAttribute(a)) n.setAttribute(a, v); }
  if (n.tagName === 'INPUT' && (n.type === 'submit' || n.type === 'button') && n.value) n.value = tr(n.value);
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let c; while ((c = w.nextNode())) { if (c.nodeType === 3) trNode(c); else if (c !== n) { for (const a of ['placeholder', 'title', 'aria-label', 'alt']) if (c.hasAttribute(a)) { const v = tr(c.getAttribute(a)); if (v !== c.getAttribute(a)) c.setAttribute(a, v); } } }
}
let obs = null;
function observe() {
  if (obs || I.lang === 'en') return;
  obs = new MutationObserver(ms => { for (const m of ms) { if (m.type === 'characterData') trNode(m.target); else for (const n of m.addedNodes) trNode(n); } });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  trNode(document.body); document.title = tr(document.title);
}

const LS = k => { try { return localStorage.getItem(k); } catch { return null; } };
const LSset = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
/** Pick and load a language: explicit choice → saved choice on this device → utility default. Works offline from the cached dictionary. */
export async function initI18n(preferred) {
  let cfg = null;
  try { cfg = await fetch('/api/i18n/config').then(r => (r.ok ? r.json() : null)); if (cfg) LSset('aq_cfg', JSON.stringify(cfg)); } catch { /* offline */ }
  if (!cfg) { try { cfg = JSON.parse(LS('aq_cfg') || 'null'); } catch { cfg = null; } }
  I.config = cfg;
  const avail = cfg ? cfg.languages.map(l => l.code) : ['en'];
  const want = [preferred, LS('aq_lang'), cfg && cfg.default_language, 'en'].find(c => c && avail.includes(c)) || 'en';
  await load(want);
  return I;
}
async function load(code) {
  I.lang = code; I.dict = {}; I.locale = { en: 'en-GB', fr: 'fr-FR', pt: 'pt-PT' }[code] || code; I.dir = 'ltr';
  if (code !== 'en') {
    let d = null;
    try { d = await fetch('/api/i18n/ui/' + code).then(r => (r.ok ? r.json() : null)); if (d) LSset('aq_dict_' + code, JSON.stringify(d)); } catch { /* offline */ }
    if (!d) { try { d = JSON.parse(LS('aq_dict_' + code) || 'null'); } catch { d = null; } }
    if (d) { I.dict = d.dict || {}; I.locale = d.locale || I.locale; I.dir = d.dir || 'ltr'; }
  }
  I.multi = Object.keys(I.dict).filter(k => (k.length >= 6 && /\s/.test(k.trim())) || (k.length >= 3 && (/[,:(—]$/.test(k) || /^[),.·—]/.test(k)))).sort((a, b) => b.length - a.length);
  document.documentElement.lang = code; document.documentElement.dir = I.dir;
  observe();
}
/** Change language on this device (and for the signed-in user when saveToProfile is given). Reloads the page. */
export async function switchLanguage(code, saveToProfile) {
  LSset('aq_lang', code);
  if (saveToProfile) { try { await saveToProfile(code); } catch { /* keep device choice */ } }
  location.reload();
}
/** Short weekday names Sun…Sat in the current language. */
export const weekdays = () => [0, 1, 2, 3, 4, 5, 6].map(i => new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(I.locale || 'en-GB', { weekday: 'short', timeZone: 'UTC' }));
/** <select> listing the enabled languages. */
export function languagePicker(id = 'langpick', style = '') {
  const langs = (I.config && I.config.languages) || [{ code: 'en', native_name: 'English' }];
  if (langs.length < 2) return '';
  return `<select id="${id}" aria-label="Language" data-noi18n style="${style}">${langs.map(l => `<option value="${l.code}"${l.code === I.lang ? ' selected' : ''}>${l.native_name}</option>`).join('')}</select>`;
}
