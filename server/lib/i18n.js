'use strict';
/*
 * Languages, translations and country-specific formatting.
 *  - Customer-facing messages (SMS, USSD) use keys in server/i18n/<lang>.json, scope "msg".
 *  - The web app uses phrase dictionaries in public/i18n/ui-<lang>.json, scope "ui" (English phrase → translation).
 *  - Administrators can correct or add translations (and whole new languages) in the app; those are stored in the
 *    `translations` table and take precedence over the files. Missing text always falls back to English.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const BUILTIN = [['en', 'English', 'English', 'ltr'], ['fr', 'French', 'Français', 'ltr'], ['pt', 'Portuguese', 'Português', 'ltr']];
const MSG_DIR = path.join(__dirname, '..', 'i18n');
const UI_DIR = path.join(__dirname, '..', '..', 'public', 'i18n');
const fileCache = {};
const readJson = f => { if (!(f in fileCache)) { try { fileCache[f] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { fileCache[f] = null; } } return fileCache[f]; };
let version = 0; const memo = new Map();
const bump = () => { version++; memo.clear(); };

function ensureBuiltins() { for (const [c, n, nn, d] of BUILTIN) db.run('INSERT OR IGNORE INTO languages(code, name, native_name, dir, enabled, builtin) VALUES (?,?,?,?,1,1)', c, n, nn, d); }
function languages(all = false) { ensureBuiltins(); return db.all(`SELECT * FROM languages ${all ? '' : 'WHERE enabled=1'} ORDER BY builtin DESC, name`); }
const isLang = c => !!c && !!db.get('SELECT 1 FROM languages WHERE code=? AND enabled=1', c);
const defaultLang = () => { const d = db.setting('default_language', 'en'); return isLang(d) ? d : 'en'; };

function overrides(lang, scope) { return Object.fromEntries(db.all('SELECT key, text FROM translations WHERE lang=? AND scope=?', lang, scope).map(r => [r.key, r.text])); }
function messages(lang) {
  const k = 'msg:' + lang; if (memo.has(k)) return memo.get(k);
  const base = (readJson(path.join(MSG_DIR, 'en.json')) || {}).messages || {};
  const own = (readJson(path.join(MSG_DIR, lang + '.json')) || {}).messages || {};
  const m = { ...base, ...(lang === 'en' ? {} : own), ...overrides(lang, 'msg') }; memo.set(k, m); return m;
}
/** Translate a customer-facing message key. Unknown languages fall back to English; {var} placeholders are filled from vars. */
function t(lang, key, vars = {}) {
  const m = messages(lang || 'en'); let s = m[key] ?? messages('en')[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, v) => (vars[v] ?? ''));
}
function uiDict(lang) {
  const k = 'ui:' + lang; if (memo.has(k)) return memo.get(k);
  const d = lang === 'en' ? {} : { ...(readJson(path.join(UI_DIR, `ui-${lang}.json`)) || {}), ...overrides(lang, 'ui') }; memo.set(k, d); return d;
}
const uiCatalog = () => (readJson(path.join(UI_DIR, 'catalog.json')) || { phrases: [] }).phrases;
const msgKeys = () => Object.keys((readJson(path.join(MSG_DIR, 'en.json')) || {}).messages || {});

// ---- language of a person ----
const phoneKey = p => { const n = db.settingNum('phone_digits', 9) || 9; return String(p || '').replace(/\D/g, '').slice(-n); };
function langForPhone(phone) {
  const key = phoneKey(phone); if (key.length < 6) return defaultLang();
  const c = db.all(`SELECT phone, language FROM customers WHERE phone IS NOT NULL AND language IS NOT NULL AND status != 'closed'`).find(x => phoneKey(x.phone) === key);
  if (c && isLang(c.language)) return c.language;
  const p = db.get('SELECT lang FROM phone_languages WHERE phone_key=?', key); if (p && isLang(p.lang)) return p.lang;
  return defaultLang();
}
const langForCustomer = c => (c && isLang(c.language) ? c.language : c && c.phone ? langForPhone(c.phone) : defaultLang());
function setPhoneLang(phone, lang) {
  const key = phoneKey(phone);
  db.run(`INSERT INTO phone_languages(phone_key, lang) VALUES (?,?) ON CONFLICT(phone_key) DO UPDATE SET lang=excluded.lang, updated_at=datetime('now')`, key, lang);
  for (const c of db.all('SELECT id, phone FROM customers WHERE phone IS NOT NULL')) if (phoneKey(c.phone) === key) db.run('UPDATE customers SET language=? WHERE id=?', lang, c.id);
}

// ---- country formatting ----
const currencies = () => String(db.setting('currencies', 'USD') || 'USD').split(',').map(x => x.trim().toUpperCase()).filter(x => /^[A-Z]{3}$/.test(x));
function symbols() { const o = {}; for (const kv of String(db.setting('currency_symbols', '') || '').split(';')) { const [k, v] = kv.split('='); if (k && v) o[k.trim().toUpperCase()] = v.trim(); } return o; }
function digits(cur) { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits; } catch { return 2; } }
const LOCALE = { en: 'en-GB', fr: 'fr-FR', pt: 'pt-PT' };
const locale = lang => LOCALE[lang] || lang || 'en-GB';
/** "US$12.50", "12 500 FCFA"… — symbol from Settings (or the ISO code), number in the language's format. */
function money(n, cur, lang = defaultLang()) {
  const d = digits(cur); let num;
  try { num = new Intl.NumberFormat(locale(lang), { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(n)); } catch { num = Number(n).toFixed(d); }
  const sym = symbols()[cur];
  return sym ? (/^[A-Za-z]{2,}$/.test(sym) ? `${num} ${sym}` : `${sym}${num}`) : `${num} ${cur}`;
}
function momoProviders() {
  return String(db.setting('momo_providers', '') || '').split(';').map(kv => { const [code, name] = kv.split('='); return code && /^[a-z][a-z0-9]*$/.test(code.trim()) ? { code: code.trim(), name: (name || code).trim(), merchant: db.setting(`momo_${code.trim()}_merchant`, '') || '' } : null; }).filter(Boolean);
}
const providerName = code => (momoProviders().find(p => p.code === code) || { name: code }).name;

function publicConfig() {
  return { country_code: db.setting('country_code'), country_name: db.setting('country_name'), phone_prefix: db.setting('phone_prefix'), timezone: db.setting('timezone'), default_language: defaultLang(),
    currencies: currencies(), currency_symbols: symbols(), momo_providers: momoProviders().map(({ code, name }) => ({ code, name })), region_label: db.setting('region_label', 'Region') || 'Region',
    languages: languages().map(l => ({ code: l.code, name: l.name, native_name: l.native_name, dir: l.dir })) };
}

module.exports = { t, messages, uiDict, uiCatalog, msgKeys, languages, ensureBuiltins, isLang, defaultLang, langForPhone, langForCustomer, setPhoneLang, phoneKey,
  currencies, symbols, money, momoProviders, providerName, publicConfig, locale, bump, overrides };
