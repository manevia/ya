'use strict';
/*
 * "How did we do?" — after a repair or a resolved report, ask the person by SMS to reply 1–5 (optionally with a comment).
 * One request per job per phone; replies are accepted for 7 days. Low scores (1–2) raise a follow-up alert for a manager.
 */
const db = require('../lib/db');
const channels = require('./channels');

const ASK = 'How did we do? Reply 1 (poor) to 5 (excellent), you can add a comment.';
const enabled = () => db.setting('feedback_sms_enabled', '1') === '1';

/** Create a request. With send=false the caller includes ASK in its own SMS (saves a message). Returns the request or null. */
function request(ctx, { work_order_id, alert_id, public_report_id, customer_id, phone, area_id, technician_id, send = true, wo_number }) {
  if (!enabled() || !phone) return null;
  const np = channels.normPhone(phone);
  const dup = db.all(`SELECT phone FROM feedback_requests WHERE (work_order_id IS ? AND ? IS NOT NULL) OR (alert_id IS ? AND ? IS NOT NULL)`, work_order_id ?? null, work_order_id ?? null, alert_id ?? null, alert_id ?? null)
    .some(r => channels.normPhone(r.phone) === np);
  if (dup) return null;
  const id = db.run('INSERT INTO feedback_requests(work_order_id, public_report_id, alert_id, customer_id, phone, area_id, technician_id) VALUES (?,?,?,?,?,?,?)',
    work_order_id || null, public_report_id || null, alert_id || null, customer_id || null, phone, area_id || null, technician_id || null).id;
  if (send) { const L = require('../lib/i18n').langForPhone(phone); channels.send(phone, `${channels.short()}: ${channels.T(L, 'feedback.job_done', { what: channels.T(L, 'feedback.job', { wo: wo_number || '' }) })} ${channels.T(L, 'feedback.ask')}`, { customer_id, purpose: 'feedback' }); }
  return { id };
}

/** Called by the SMS handler. Returns a reply text if the message was a rating, otherwise null. */
function handleReply(ctx, phone, body) {
  const m = /^\s*([1-5])(?:\s*(?:\/\s*5)?)(?:[\s,.:;-]+(.*))?$/s.exec(String(body || ''));
  if (!m) return null;
  const np = channels.normPhone(phone);
  const req = db.all(`SELECT * FROM feedback_requests WHERE score IS NULL AND sent_at >= datetime('now','-7 day') ORDER BY id DESC`).find(r => channels.normPhone(r.phone) === np);
  if (!req) return null;
  const score = Number(m[1]); const comment = (m[2] || '').trim().slice(0, 300) || null;
  db.run(`UPDATE feedback_requests SET score=?, comment=?, responded_at=datetime('now') WHERE id=?`, score, comment, req.id);
  if (score <= 2) {
    const wo = req.work_order_id ? db.get('SELECT wo_number FROM work_orders WHERE id=?', req.work_order_id) : null;
    require('./alerts').raise({ ...ctx, actor: 'sms' }, { rule_type: 'customer_report', severity: 'medium', title: `Unhappy with service (${score}/5)${wo ? ' — ' + wo.wo_number : ''}`,
      description: `Feedback by SMS from ${phone}: ${comment || '(no comment)'} — please call back.`, customer_id: req.customer_id, area_id: req.area_id, source: 'customer', data_basis: 'manual', dedupe_key: 'feedback:' + req.id });
  }
  const L = require('../lib/i18n').langForPhone(phone);
  return channels.T(L, score <= 2 ? 'feedback.sorry' : 'feedback.thanks', { score });
}

function summary({ from, to, area_id } = {}) {
  const w = ['sent_at >= ?', 'sent_at < date(?, \'+1 day\')']; const p = [from, to]; if (area_id) { w.push('f.area_id=?'); p.push(area_id); }
  const where = 'WHERE ' + w.join(' AND ');
  const tot = db.get(`SELECT COUNT(*) sent, COUNT(score) answered, AVG(score) avg FROM feedback_requests f ${where}`, ...p);
  return {
    sent: tot.sent, answered: tot.answered, response_pct: tot.sent ? Math.round(tot.answered / tot.sent * 1000) / 10 : null, avg: tot.avg == null ? null : Math.round(tot.avg * 100) / 100,
    distribution: [1, 2, 3, 4, 5].map(s => ({ score: s, n: db.get(`SELECT COUNT(*) n FROM feedback_requests f ${where} AND score=?`, ...p, s).n })),
    by_area: db.all(`SELECT a.name area, COUNT(score) n, ROUND(AVG(score),2) avg FROM feedback_requests f JOIN service_areas a ON a.id=f.area_id ${where} GROUP BY a.id HAVING COUNT(score) > 0 ORDER BY avg`, ...p),
    by_technician: db.all(`SELECT u.full_name technician, COUNT(score) n, ROUND(AVG(score),2) avg FROM feedback_requests f JOIN users u ON u.id=f.technician_id ${where} GROUP BY u.id HAVING COUNT(score) > 0 ORDER BY avg`, ...p),
    recent: db.all(`SELECT f.id, f.score, f.comment, f.responded_at, f.sent_at, a.name area, w.wo_number, w.id work_order_id, u.full_name technician, c.name customer_name, c.id customer_id
      FROM feedback_requests f LEFT JOIN service_areas a ON a.id=f.area_id LEFT JOIN work_orders w ON w.id=f.work_order_id LEFT JOIN users u ON u.id=f.technician_id LEFT JOIN customers c ON c.id=f.customer_id
      ${where} ORDER BY (f.score IS NULL), f.score, f.responded_at DESC LIMIT 100`, ...p)
  };
}

module.exports = { request, handleReply, summary, ASK };
