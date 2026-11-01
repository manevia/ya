'use strict';
/*
 * Stores & stock: pipe, fittings, meter parts, chlorine and tools.
 * Every change is an immutable movement (receive, issue to a work order, return from a work order, adjust with a reason);
 * stock on hand is always the sum of movements, so it can be audited and never silently edited.
 * Water meters themselves are tracked individually in the meter register (status "in stock").
 */
const db = require('../lib/db');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const r2 = n => Math.round((n + Number.EPSILON) * 1000) / 1000;
const onHand = itemId => r2(db.get('SELECT COALESCE(SUM(qty),0) q FROM stock_movements WHERE item_id=?', itemId).q);

function items({ all = false } = {}) {
  return db.all(`SELECT i.*, COALESCE((SELECT SUM(qty) FROM stock_movements m WHERE m.item_id=i.id),0) on_hand,
      (SELECT -SUM(qty) FROM stock_movements m WHERE m.item_id=i.id AND m.kind IN ('issue','return','use') AND m.created_at >= datetime('now','-90 day')) used_90d
    FROM stock_items i ${all ? '' : 'WHERE i.active=1'} ORDER BY i.category, i.name`)
    .map(i => ({ ...i, on_hand: r2(i.on_hand), used_90d: r2(i.used_90d || 0), value: i.unit_cost != null ? Math.round(i.on_hand * i.unit_cost * 100) / 100 : null,
      low: i.reorder_level > 0 && i.on_hand <= i.reorder_level, out: i.on_hand <= 0,
      weeks_left: i.used_90d > 0 ? Math.floor(i.on_hand / (i.used_90d / 13)) : null }));
}
const lowStock = () => items().filter(i => i.low);

function saveItem(ctx, id, b) {
  if (id) {
    if (!db.get('SELECT 1 FROM stock_items WHERE id=?', id)) throw new HttpError(404, 'Not found');
    db.run('UPDATE stock_items SET name=?, category=?, unit=?, reorder_level=?, unit_cost=?, currency=?, location=?, active=? WHERE id=?', b.name, b.category, b.unit, b.reorder_level || 0, b.unit_cost ?? null, b.currency || null, b.location || null, b.active === false ? 0 : 1, id);
  } else {
    if (db.get('SELECT 1 FROM stock_items WHERE code=?', b.code)) throw new HttpError(409, 'Item code already exists');
    id = db.run('INSERT INTO stock_items(code, name, category, unit, reorder_level, unit_cost, currency, location) VALUES (?,?,?,?,?,?,?,?)', b.code, b.name, b.category, b.unit, b.reorder_level || 0, b.unit_cost ?? null, b.currency || null, b.location || null).id;
  }
  audit.log(ctx, 'stock.item', 'stock_item', id, b);
  return { id };
}

/** kind: receive (qty>0), issue (qty>0, to a work order), return (qty>0, from a work order), use (qty>0, routine use such as chlorination — say what for), adjust (signed, reason required). */
function move(ctx, b) {
  return db.tx(() => {
    const it = db.get('SELECT * FROM stock_items WHERE id=?', b.item_id); if (!it) throw new HttpError(400, 'Unknown item');
    const q = Number(b.qty); if (!Number.isFinite(q) || q === 0) throw new HttpError(400, 'Enter a quantity');
    let signed = q;
    if (['receive', 'issue', 'return', 'use'].includes(b.kind) && q < 0) throw new HttpError(400, 'Quantity must be positive');
    if (b.kind === 'issue' || b.kind === 'return') {
      const wo = db.get('SELECT * FROM work_orders WHERE id=?', b.work_order_id); if (!wo) throw new HttpError(400, 'Issue and return need a work order');
      if (b.kind === 'issue' && ['completed', 'cancelled'].includes(wo.status) && !['manager', 'admin'].includes(ctx.user.role)) throw new HttpError(409, 'Work order is closed');
      if (b.kind === 'issue') { if (onHand(it.id) < q - 1e-9) throw new HttpError(409, `Only ${onHand(it.id)} ${it.unit} in stock`); signed = -q; }
      else { const net = -db.get(`SELECT COALESCE(SUM(qty),0) s FROM stock_movements WHERE item_id=? AND work_order_id=?`, it.id, wo.id).s; if (q > net + 1e-9) throw new HttpError(400, `Only ${r2(net)} ${it.unit} were issued to ${wo.wo_number}`); }
    }
    if (b.kind === 'use') { if (!b.notes || b.notes.length < 5) throw new HttpError(400, 'Say what it was used for (e.g. chlorination of Hilltop tank)'); if (onHand(it.id) < q - 1e-9) throw new HttpError(409, `Only ${onHand(it.id)} ${it.unit} in stock`); signed = -q; }
    if (b.kind === 'adjust') { if (!b.notes || b.notes.length < 5) throw new HttpError(400, 'Give a reason for the adjustment (stock count, damage, loss…)'); if (onHand(it.id) + q < -1e-9) throw new HttpError(409, 'Adjustment would make stock negative'); }
    if (b.kind === 'receive' && b.unit_cost != null) db.run('UPDATE stock_items SET unit_cost=? WHERE id=?', b.unit_cost, it.id);
    const id = db.run('INSERT INTO stock_movements(item_id, qty, kind, work_order_id, unit_cost, reference, notes, user_id) VALUES (?,?,?,?,?,?,?,?)', it.id, signed, b.kind, b.work_order_id || null,
      b.unit_cost ?? it.unit_cost ?? null, b.reference || null, b.notes || null, ctx.user.id).id;
    if (b.work_order_id) db.run('INSERT INTO work_order_updates(work_order_id, user_id, status, note) VALUES (?,?,(SELECT status FROM work_orders WHERE id=?),?)', b.work_order_id, ctx.user.id, b.work_order_id, `${b.kind === 'issue' ? 'Materials issued' : 'Materials returned'}: ${q} ${it.unit} ${it.name}`);
    audit.log(ctx, 'stock.' + b.kind, 'stock_item', it.id, { qty: signed, work_order_id: b.work_order_id, reference: b.reference, notes: b.notes });
    return { id, on_hand: onHand(it.id), low: it.reorder_level > 0 && onHand(it.id) <= it.reorder_level };
  });
}

/** Net materials used on a work order and their cost. */
function materials(woId) {
  const rows = db.all(`SELECT i.id item_id, i.code, i.name, i.unit, i.currency, -SUM(m.qty) qty, -SUM(m.qty * COALESCE(m.unit_cost,0)) cost FROM stock_movements m JOIN stock_items i ON i.id=m.item_id
    WHERE m.work_order_id=? GROUP BY i.id HAVING ABS(SUM(m.qty)) > 1e-9 ORDER BY i.name`, woId).map(r => ({ ...r, qty: r2(r.qty), cost: Math.round(r.cost * 100) / 100 }));
  const totals = {}; for (const r of rows) if (r.currency) totals[r.currency] = Math.round(((totals[r.currency] || 0) + r.cost) * 100) / 100;
  return { rows, totals };
}

module.exports = { items, lowStock, saveItem, move, materials, onHand };
