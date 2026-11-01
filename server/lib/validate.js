'use strict';
// Schema-based input validation. Every write endpoint passes user input through validate().
const { HttpError } = require('./http');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+0-9 ()-]{6,20}$/;

function validate(input, schema, { partial = false } = {}) {
  const out = {}; const errors = {};
  for (const [key, rule] of Object.entries(schema)) {
    let v = input ? input[key] : undefined;
    if (typeof v === 'string') v = v.trim();
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (partial && v === undefined) continue;
      if (rule.required) { errors[key] = 'Required'; continue; }
      if (rule.default !== undefined) out[key] = rule.default;
      else if (!partial || v !== undefined) out[key] = null;
      continue;
    }
    try { out[key] = coerce(v, rule); }
    catch (e) { errors[key] = e.message; }
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Please correct the highlighted fields: ' + Object.entries(errors).map(([k, m]) => `${k} (${m})`).join(', '), { fields: errors });
  return out;
}

function coerce(v, rule) {
  switch (rule.type) {
    case 'string': case 'text': {
      const s = String(v);
      const max = rule.max || (rule.type === 'text' ? 4000 : 200);
      if (s.length > max) throw new Error(`max ${max} characters`);
      if (rule.min && s.length < rule.min) throw new Error(`min ${rule.min} characters`);
      if (rule.pattern && !rule.pattern.test(s)) throw new Error(rule.patternMsg || 'invalid format');
      return s;
    }
    case 'number': case 'integer': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error('must be a number');
      if (rule.type === 'integer' && !Number.isInteger(n)) throw new Error('must be a whole number');
      if (rule.minVal !== undefined && n < rule.minVal) throw new Error(`must be ≥ ${rule.minVal}`);
      if (rule.maxVal !== undefined && n > rule.maxVal) throw new Error(`must be ≤ ${rule.maxVal}`);
      return n;
    }
    case 'boolean': return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
    case 'currency': { const list = require('./i18n').currencies(); const c = String(v).toUpperCase(); if (!list.includes(c)) throw new Error('must be one of the configured currencies: ' + list.join(', ')); return c; }
    case 'paymethod': { const ok = ['cash', 'bank_transfer', 'cheque', 'other', ...require('./i18n').momoProviders().map(p => 'mobile_money_' + p.code)]; if (!ok.includes(v)) throw new Error('must be one of ' + ok.join(', ')); return v; }
    case 'momoprovider': { const ok = require('./i18n').momoProviders().map(p => p.code); if (!ok.includes(v)) throw new Error('must be one of the configured mobile-money providers: ' + ok.join(', ')); return v; }
    case 'enum': if (!rule.values.includes(v)) throw new Error('must be one of ' + rule.values.join(', ')); return v;
    case 'date': if (!DATE.test(v) || isNaN(Date.parse(v))) throw new Error('date YYYY-MM-DD expected'); return v;
    case 'datetime': { const d = new Date(v); if (isNaN(d)) throw new Error('date/time expected'); return d.toISOString(); }
    case 'email': if (!EMAIL.test(v)) throw new Error('invalid email'); return String(v).slice(0, 200);
    case 'phone': if (!PHONE.test(v)) throw new Error('invalid phone number'); return String(v);
    case 'lat': { const n = Number(v); if (!(n >= -90 && n <= 90)) throw new Error('latitude -90..90'); return n; }
    case 'lng': { const n = Number(v); if (!(n >= -180 && n <= 180)) throw new Error('longitude -180..180'); return n; }
    case 'array': if (!Array.isArray(v)) throw new Error('list expected'); if (v.length > (rule.max || 1000)) throw new Error('too many items'); return v;
    case 'json': if (typeof v === 'string') { try { return JSON.parse(v); } catch { throw new Error('invalid JSON'); } } return v;
    default: throw new Error('unknown rule');
  }
}

const id = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
};

module.exports = { validate, id };
