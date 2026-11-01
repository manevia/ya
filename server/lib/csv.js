'use strict';
// RFC-4180 style CSV parse/serialise (handles quotes, commas and newlines inside quoted fields).
function parse(text) {
  text = String(text).replace(/^﻿/, '');
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(x => String(x).trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return nonEmpty.slice(1).map((r, idx) => { const o = { __row: idx + 2 }; header.forEach((h, i) => { o[h] = (r[i] || '').trim(); }); return o; });
}
function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function stringify(rows, columns, preamble = []) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = preamble.map(p => cell(p));
  lines.push(cols.map(cell).join(','));
  for (const r of rows) lines.push(cols.map(c => cell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
module.exports = { parse, stringify };
