'use strict';
/*
 * Builds public/i18n/ui-<lang>.json from the translation sources in scripts/i18n/*.txt
 * (lines: English ||| Français ||| Português). Reports phrases that are not in the catalogue (typos / stale).
 * Usage: node scripts/i18n-build.js [--missing]   (--missing lists catalogue phrases with no translation)
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'); const LANGS = ['fr', 'pt'];
const cat = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n/catalog.json'), 'utf8')).phrases.map(p => p.en));
const out = Object.fromEntries(LANGS.map(l => [l, {}])); const stale = [];
for (const f of fs.readdirSync(path.join(__dirname, 'i18n')).filter(x => x.endsWith('.txt')).sort()) {
  for (const line of fs.readFileSync(path.join(__dirname, 'i18n', f), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('|||').map(x => x.trim()); if (cols.length < 3) { console.warn('bad line', f, line.slice(0, 60)); continue; }
    if (!cat.has(cols[0])) stale.push(cols[0]);
    LANGS.forEach((l, i) => { if (cols[i + 1]) out[l][cols[0]] = cols[i + 1]; });
  }
}
for (const l of LANGS) fs.writeFileSync(path.join(ROOT, `public/i18n/ui-${l}.json`), JSON.stringify(out[l]));
const n = Object.keys(out.fr).length;
console.log(`${n} phrases translated (catalogue ${cat.size}, ${Math.round(n / cat.size * 100)}%)`);
if (stale.length) console.log('Not in catalogue (check spelling):\n  ' + stale.join('\n  '));
if (process.argv.includes('--missing')) { const miss = [...cat].filter(k => !out.fr[k]); console.log(miss.join('\n')); }
