'use strict';
// Languages, translations and country settings.
const { route, HttpError, csvResponse } = require('../lib/http');
const { validate } = require('../lib/validate');
const audit = require('../lib/audit');
const db = require('../lib/db');
const csv = require('../lib/csv');
const i18n = require('../lib/i18n');
const { PRESETS } = require('../lib/countries');

// ---- Public: language list, UI dictionary, regional config (needed before sign-in) ----
route('GET', '/api/i18n/config', { public: true }, () => i18n.publicConfig());
route('GET', '/api/i18n/ui/:lang', { public: true }, ctx => {
  if (!i18n.isLang(ctx.params.lang)) throw new HttpError(404, 'Unknown language');
  const l = db.get('SELECT * FROM languages WHERE code=?', ctx.params.lang);
  return { lang: l.code, dir: l.dir, locale: i18n.locale(l.code), dict: i18n.uiDict(l.code) };
});
// ---- Per-user language ----
route('PUT', '/api/auth/me/language', { allowPwChange: true }, ctx => {
  const b = validate(ctx.body, { language: { type: 'string', required: true, max: 10 } });
  if (!i18n.isLang(b.language)) throw new HttpError(400, 'Unknown language');
  db.run('UPDATE users SET language=? WHERE id=?', b.language, ctx.user.id);
  if (ctx.user.role === 'customer' && ctx.user.customer_id) db.run('UPDATE customers SET language=? WHERE id=?', b.language, ctx.user.customer_id); // SMS follow the portal choice
  return { ok: true };
});

// ---- Administration ----
const scopeKeys = scope => (scope === 'ui' ? i18n.uiCatalog().map(p => p.en) : i18n.msgKeys());
const english = (scope, key) => (scope === 'ui' ? key : i18n.messages('en')[key]);
function coverage(lang) {
  const out = {};
  for (const scope of ['msg', 'ui']) {
    const keys = scopeKeys(scope); const have = scope === 'ui' ? i18n.uiDict(lang) : i18n.messages(lang);
    const own = scope === 'msg' ? (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'i18n', lang + '.json'), 'utf8')).messages || {}; } catch { return {}; } })() : have;
    const ov = i18n.overrides(lang, scope);
    const done = lang === 'en' ? keys.length : keys.filter(k => (scope === 'ui' ? have[k] : own[k] || ov[k])).length;
    out[scope] = { total: keys.length, translated: done, pct: keys.length ? Math.round(done / keys.length * 1000) / 10 : 100, edited: Object.keys(ov).length };
  }
  return out;
}
route('GET', '/api/i18n/languages', { perm: 'settings.manage' }, () => i18n.languages(true).map(l => ({ ...l, coverage: coverage(l.code), default: l.code === i18n.defaultLang() })));
route('POST', '/api/i18n/languages', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { code: { type: 'string', required: true, max: 10, pattern: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, patternMsg: 'an ISO 639 code such as sw, ha, ar' }, name: { type: 'string', required: true, max: 40 },
    native_name: { type: 'string', required: true, max: 40 }, dir: { type: 'enum', values: ['ltr', 'rtl'], default: 'ltr' } });
  if (db.get('SELECT 1 FROM languages WHERE code=?', b.code)) throw new HttpError(409, 'Language already exists');
  db.run('INSERT INTO languages(code, name, native_name, dir, enabled, builtin) VALUES (?,?,?,?,1,0)', b.code, b.name, b.native_name, b.dir);
  audit.log(ctx, 'i18n.language_add', 'language', b.code, b); i18n.bump(); return { ok: true };
});
route('PUT', '/api/i18n/languages/:code', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { enabled: { type: 'boolean', required: true }, name: { type: 'string', max: 40 }, native_name: { type: 'string', max: 40 }, dir: { type: 'enum', values: ['ltr', 'rtl'] } });
  const l = db.get('SELECT * FROM languages WHERE code=?', ctx.params.code); if (!l) throw new HttpError(404, 'Not found');
  if (!b.enabled && (l.code === 'en' || l.code === i18n.defaultLang())) throw new HttpError(409, 'English and the default language cannot be switched off');
  db.run('UPDATE languages SET enabled=?, name=COALESCE(?, name), native_name=COALESCE(?, native_name), dir=COALESCE(?, dir) WHERE code=?', b.enabled ? 1 : 0, b.name, b.native_name, b.dir, l.code);
  audit.log(ctx, 'i18n.language_update', 'language', l.code, b); i18n.bump(); return { ok: true };
});
/** Strings for the editor: English source, current text, whether it was edited here. */
route('GET', '/api/i18n/strings/:lang', { perm: 'settings.manage' }, ctx => {
  const lang = ctx.params.lang; const scope = ctx.query.scope === 'ui' ? 'ui' : 'msg';
  if (!db.get('SELECT 1 FROM languages WHERE code=?', lang)) throw new HttpError(404, 'Unknown language');
  const ov = i18n.overrides(lang, scope); const cur = scope === 'ui' ? i18n.uiDict(lang) : i18n.messages(lang);
  const fileMsgs = scope === 'msg' ? (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'i18n', lang + '.json'), 'utf8')).messages || {}; } catch { return {}; } })() : null;
  const cat = scope === 'ui' ? new Map(i18n.uiCatalog().map(p => [p.en, p.files])) : null;
  let rows = scopeKeys(scope).map(k => { const text = scope === 'ui' ? cur[k] || '' : (ov[k] ?? fileMsgs[k] ?? ''); return { key: k, en: english(scope, k), text: lang === 'en' && scope === 'msg' ? (ov[k] ?? '') : text, edited: k in ov, where: cat ? (cat.get(k) || []).map(f => f.replace(/^public\/js\/(views\/)?|\.js$/g, '')).join(', ') : k.split('.')[0] }; });
  if (ctx.query.missing === '1') rows = rows.filter(r => !r.text);
  if (ctx.query.q) { const q = String(ctx.query.q).toLowerCase(); rows = rows.filter(r => r.key.toLowerCase().includes(q) || String(r.en).toLowerCase().includes(q) || r.text.toLowerCase().includes(q)); }
  const area = ctx.query.where; if (area) rows = rows.filter(r => r.where.split(', ').includes(area));
  return { lang, scope, total: rows.length, rows: rows.slice(0, Number(ctx.query.limit) || 300), areas: scope === 'ui' ? [...new Set(i18n.uiCatalog().flatMap(p => p.files.map(f => f.replace(/^public\/js\/(views\/)?|\.js$/g, ''))))].sort() : [...new Set(i18n.msgKeys().map(k => k.split('.')[0]))].sort() };
});
function saveStrings(ctx, lang, scope, items) {
  const keys = new Set(scopeKeys(scope)); let n = 0;
  db.tx(() => { for (const it of items) {
    if (!keys.has(it.key)) continue;
    const text = String(it.text ?? '').slice(0, 2000);
    if (scope === 'msg') { const need = (english('msg', it.key).match(/\{\w+\}/g) || []).filter(v => !text.includes(v)); if (text && need.length) throw new HttpError(400, `"${it.key}" must keep the placeholders ${need.join(' ')}`); }
    if (!text) db.run('DELETE FROM translations WHERE lang=? AND scope=? AND key=?', lang, scope, it.key);
    else db.run(`INSERT INTO translations(lang, scope, key, text, updated_by) VALUES (?,?,?,?,?) ON CONFLICT(lang, scope, key) DO UPDATE SET text=excluded.text, updated_by=excluded.updated_by, updated_at=datetime('now')`, lang, scope, it.key, text, ctx.user.id);
    n++; } });
  i18n.bump(); audit.log(ctx, 'i18n.strings', 'language', lang, { scope, count: n }); return n;
}
route('PUT', '/api/i18n/strings/:lang', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { scope: { type: 'enum', values: ['ui', 'msg'], required: true }, items: { type: 'array', required: true, max: 2000 } });
  if (!db.get('SELECT 1 FROM languages WHERE code=?', ctx.params.lang)) throw new HttpError(404, 'Unknown language');
  return { saved: saveStrings(ctx, ctx.params.lang, b.scope, b.items) };
});
route('GET', '/api/i18n/export/:lang', { perm: 'settings.manage' }, ctx => {
  const lang = ctx.params.lang; const scope = ctx.query.scope === 'ui' ? 'ui' : 'msg';
  const cur = scope === 'ui' ? i18n.uiDict(lang) : i18n.messages(lang);
  const rows = scopeKeys(scope).map(k => ({ key: k, english: english(scope, k), translation: lang === 'en' ? '' : (scope === 'ui' ? cur[k] || '' : cur[k] !== english('msg', k) ? cur[k] : '') }));
  return csvResponse(`aquatrack-${scope === 'ui' ? 'screens' : 'messages'}-${lang}.csv`, csv.stringify(rows, ['key', 'english', 'translation'], [`# AquaTrack ${scope === 'ui' ? 'screen text' : 'SMS/USSD messages'} — fill the "translation" column for ${lang}. Keep {placeholders} and line breaks (\\n) as they are.`]));
});
route('POST', '/api/i18n/import/:lang', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { scope: { type: 'enum', values: ['ui', 'msg'], required: true }, content: { type: 'text', required: true, max: 5 * 1024 * 1024 } });
  if (!db.get('SELECT 1 FROM languages WHERE code=?', ctx.params.lang)) throw new HttpError(404, 'Unknown language');
  const rows = csv.parse(b.content).filter(r => r.key && r.translation);
  return { saved: saveStrings(ctx, ctx.params.lang, b.scope, rows.map(r => ({ key: r.key, text: r.translation }))) };
});
/** Preview a message in a language (for the editor). */
route('GET', '/api/i18n/preview/:lang/:key', { perm: 'settings.manage' }, ctx => ({ text: require('../services/channels').T(ctx.params.lang, ctx.params.key, { ref: 'R-ABC123', account: 'RVS-00001', amount: i18n.money(1250, i18n.currencies()[0], ctx.params.lang), bill: 'B202610-000123', due: '2026-11-15', m3: 12, n: 6, name: 'Demo', when: 'Tue 03/11 06:00-10:00', zone: '', point: 'Tap stand 1', id: 42, value: 1234.5 }) }));

// ---- Country presets ----
route('GET', '/api/country/presets', { perm: 'settings.manage' }, () => PRESETS);
route('POST', '/api/country/apply', { perm: 'settings.manage' }, ctx => {
  const b = validate(ctx.body, { code: { type: 'string', required: true, max: 2 } });
  const p = PRESETS.find(x => x.code === b.code); if (!p) throw new HttpError(404, 'Unknown country preset');
  const used = db.all('SELECT DISTINCT currency FROM service_areas').map(r => r.currency);
  const curr = [...new Set([...p.currencies.split(','), ...used])].join(',');
  const set = { country_code: p.code, country_name: p.name, phone_prefix: p.phone_prefix, phone_digits: String(p.phone_digits), timezone: p.timezone, currencies: curr, currency_symbols: p.currency_symbols, momo_providers: p.momo_providers, region_label: p.region_label };
  if (i18n.isLang(p.default_language)) set.default_language = p.default_language;
  for (const [k, v] of Object.entries(set)) db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
  audit.log(ctx, 'country.apply', 'settings', p.code, set);
  return { applied: set, kept_currencies: used.filter(c => !p.currencies.split(',').includes(c)), note: 'Presets are starting points: confirm mobile-money providers, phone length and symbols locally, then set merchant numbers and exchange rates.' };
});
