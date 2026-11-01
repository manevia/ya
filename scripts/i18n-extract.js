'use strict';
/*
 * Builds the UI translation catalogue (public/i18n/catalog.json): every user-visible English phrase found in the
 * front-end source (text inside html`` templates, labels, titles, placeholders, toasts, dialogs) plus status labels.
 * The catalogue is what the Languages page measures coverage against and what translators fill in.
 * Usage: node scripts/i18n-extract.js
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const files = [...fs.readdirSync(path.join(ROOT, 'public/js')).filter(f => f.endsWith('.js')).map(f => 'public/js/' + f),
  ...fs.readdirSync(path.join(ROOT, 'public/js/views')).map(f => 'public/js/views/' + f)].filter(f => !/i18n\.js$|route\.js$/.test(f));
const out = new Map(); // phrase -> Set(files)
const add = (s, f) => { s = s.replace(/\s+/g, ' ').trim(); if (!/[A-Za-z]{2}/.test(s) || s.length > 400) return; if (/^[a-z0-9_.\/#:-]+$/.test(s)) return; if (/^(https?:|\/api\/|#\/|data:)/.test(s)) return;
  if (/^[a-z-]+( [a-z-]+)*$/.test(s) && !/\b(owed|credit|none|and|or|of|to|the|for|at|in|on|by|per|days?|hours?|months?|weeks?|years?|ago|since|until)\b/.test(s)) return; // css classes etc.
  if (/[{}]|=>|\$\{|\w=["']|\(\)/.test(s)) return;
  (out.get(s) || out.set(s, new Set()).get(s)).add(f); };

function templateSegments(src, f) {
  // walk the source, find backtick templates, collect literal text parts (outside ${}), then split on tags
  let i = 0;
  const readTemplate = start => { let j = start + 1, lit = '', parts = [];
    while (j < src.length) { const c = src[j];
      if (c === '\\') { lit += src[j + 1]; j += 2; continue; }
      if (c === '`') { parts.push(lit); return [parts, j + 1]; }
      if (c === '$' && src[j + 1] === '{') { parts.push(lit); lit = ''; j = skipExpr(j + 2); continue; }
      lit += c; j++; }
    return [parts, j]; };
  const skipExpr = j => { let depth = 1;
    while (j < src.length && depth) { const c = src[j];
      if (c === '`') { const [parts, k] = readTemplate(j); litTpl(parts); j = k; continue; }
      if (c === "'" || c === '"') { const k = skipStr(j); strLit(src.slice(j + 1, k - 1)); j = k; continue; }
      if (c === '/' && src[j + 1] !== '/' && src[j + 1] !== '*' && regexAllowed(j)) { j = skipRegex(j); continue; }
      if (c === '{') depth++; else if (c === '}') depth--; j++; }
    return j; };
  const skipStr = j => { const q = src[j]; j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } return j + 1; };
  const litTpl = parts => { const j = parts.join('\u0000'); for (const m of j.matchAll(/(?:placeholder|title|aria-label|alt)="([^"$\u0000]*)"/g)) add(m[1], f);
    for (const seg of j.replace(/<[^>]*>/g, '\u0001').split(/[\u0000\u0001]/)) add(seg.replace(/&nbsp;/g, ' '), f); };
  const litText = p => { for (const seg of p.split(/<[^>]*>/)) add(seg.replace(/&nbsp;/g, ' '), f);
    for (const m of p.matchAll(/(?:placeholder|title|aria-label|alt)="([^"$]*)"/g)) add(m[1], f); };
  const strLit = s => { if (/^[A-Z][^]*[a-z]/.test(s.replace(/^[^A-Za-z]{1,3}\s/, '')) || /…$/.test(s) || /^(owed|credit|none|Yes|No)$/i.test(s)) add(s, f); };
  const skipRegex = j => { let cls = false; j++; while (j < src.length) { const ch = src[j]; if (ch === '\\') { j += 2; continue; } if (ch === '[') cls = true; else if (ch === ']') cls = false; else if (ch === '/' && !cls) break; else if (ch === '\n') return j; j++; } j++; while (/[a-z]/.test(src[j] || '')) j++; return j; };
  const regexAllowed = k => { let j = k - 1; while (j >= 0 && /\s/.test(src[j])) j--; if (j < 0) return true; if ('(,=:[!&|?{};+-*%<>~^'.includes(src[j])) return true; return /\b(return|typeof|case|in|of)$/.test(src.slice(Math.max(0, j - 6), j + 1)); };
  while (i < src.length) { const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '/' && regexAllowed(i)) { i = skipRegex(i); continue; }
    if (c === '`') { const [parts, k] = readTemplate(i); litTpl(parts); i = k; continue; }
    if (c === "'" || c === '"') { const k = skipStr(i); strLit(src.slice(i + 1, k - 1)); i = k; continue; }
    i++; }
}
for (const f of files) templateSegments(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
for (const f of ['public/index.html', 'public/status.html', 'public/transparency.html']) { const s = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''); for (const seg of s.split(/<[^>]*>/)) add(seg, f); }
// status / enum labels produced by label(): snake_case → "Sentence case"
const ENUMS = 'active pending paid partially_paid issued overdue cancelled open acknowledged assigned in_progress on_hold completed resolved dismissed work_order approved rejected corrected reversed reversal posted unmatched matched ignored suspended disconnected closed in_stock faulty removed replaced operational degraded maintenance down decommissioned planned verified configured_unverified info_required ready_for_implementation disabled simulator good fair poor critical high medium low household business institution public_water_point bulk postpaid prepaid cash mobile_money bank_transfer cheque other wallet free leak burst no_water quality kiosk mechanical ultrasonic electromagnetic manual csv_import customer_self device sensor estimated measured simulated delivered partial missed extra receive issue return use adjust submitted survey_scheduled surveyed quoted accepted installing connected equal household_size fixed_pct energy_fuel electricity chemicals staff repairs transport admin pipe fitting meter_part chemical tool replace_now replace test ok on_track behind at_risk defaulted weekly monthly field_kit lab pass warn fail'.split(' ');
for (const r of ['System Administrator', 'Utility Manager', 'Meter Reader', 'Technician', 'Cashier / Billing Officer', 'Water Point Attendant', 'Customer']) add(r, 'roles');
for (const e of ENUMS) add(e.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()), 'enum');
const catalog = [...out.keys()].sort((a, b) => a.localeCompare(b));
fs.writeFileSync(path.join(ROOT, 'public/i18n/catalog.json'), JSON.stringify({ generated: new Date().toISOString(), count: catalog.length, phrases: catalog.map(p => ({ en: p, files: [...out.get(p)] })) }, null, 0));
console.log(`${catalog.length} phrases`);
if (process.argv.includes('--stats')) { const per = {}; for (const [p, fs2] of out) for (const f of fs2) per[f] = (per[f] || 0) + 1; console.log(per); }
