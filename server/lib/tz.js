'use strict';
// Local-time helpers for the utility's time zone (Settings › Country). Uses the ICU data built into Node.
const db = require('./db');
const zone = () => db.setting('timezone', 'UTC') || 'UTC';
function parts(date, tz = zone()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value; return o;
}
/** Local calendar date (YYYY-MM-DD) of an instant in the utility's time zone. */
const localDate = (d = new Date(), tz) => { const p = parts(d, tz); return `${p.year}-${p.month}-${p.day}`; };
/** Offset in minutes of tz at a given instant (local − UTC). */
function offsetMin(d, tz = zone()) { const p = parts(d, tz); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - d.getTime()) / 60000); }
/** UTC ISO instant for a local date + HH:MM in tz. */
function toUtc(dateStr, hhmm, tz = zone()) {
  const guess = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), +hhmm.slice(0, 2), +hhmm.slice(3, 5));
  let t = guess - offsetMin(new Date(guess), tz) * 60000; t = guess - offsetMin(new Date(t), tz) * 60000; // second pass handles DST edges
  return new Date(t).toISOString();
}
const valid = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
module.exports = { zone, localDate, toUtc, offsetMin, valid };
