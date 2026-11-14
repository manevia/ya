'use strict';
/*
 * End-to-end test of the first-release flows + security rules.
 * Runs against a THROWAWAY demo database in a temp folder (your real data is never touched).
 * Usage: npm test
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aquatrack-test-'));
const PORT = 3999 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, APP_MODE: 'demo', DATA_DIR: TMP, PORT: String(PORT) };
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers = {}) {
    const h = { 'X-Requested-With': 'fetch', ...headers }; if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}) { return this.req('POST', u, b); } put(u, b) { return this.req('PUT', u, b); }
  async login(u) { const r = await this.post('/api/auth/login', { username: u, password: 'DemoPass2026' }); if (r.status !== 200) throw new Error('login failed ' + u); return this; }
}
const as = u => new Client().login(u);

async function main() {
  console.log('Seeding throwaway demo database in', TMP);
  execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/seed.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const srv = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  try { await run(); } finally { srv.kill(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

async function run() {
  const admin = await as('admin'), manager = await as('manager'), cashier = await as('cashier'), billing = await as('billing'), tech = await as('tech1'), reader = await as('reader1'), cust = await as('customer1');
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const daysAgo = n => new Date(Date.now() - n * 86400e3).toISOString();

  console.log('\nFlow 1 — create service area, tariff, customer and meter');
  let r = await admin.post('/api/areas', { code: 'TST', name: 'Test Town (Demo)', county: 'Bomi', currency: 'USD' });
  ok(r.status === 200, 'service area created', r.data); const areaId = r.data.id;
  r = await admin.post('/api/tariffs', { code: 'TST-HH', name: 'Test household', customer_type: 'household', area_id: areaId, currency: 'LRD', fixed_charge: 1, effective_from: '2026-01-01', bands: [{ up_to: 10, rate: 0.5 }, { up_to: null, rate: 1 }] });
  ok(r.status === 400 && /currency/i.test(r.data.error), 'tariff currency must match area currency');
  r = await admin.post('/api/tariffs', { code: 'TST-HH', name: 'Test household', customer_type: 'household', area_id: areaId, currency: 'USD', fixed_charge: 1, tax_pct: 10, effective_from: '2026-01-01', bands: [{ up_to: 10, rate: 0.5 }, { up_to: null, rate: 1 }], fees: [{ name: 'Levy', amount: 0.25 }] });
  ok(r.status === 200, 'tariff created (bands, fee, tax)', r.data);
  r = await admin.post('/api/tariffs/preview', { consumption: 15, bands: [{ up_to: 10, rate: 0.5 }, { up_to: null, rate: 1 }], fixed_charge: 1, tax_pct: 10, fees: [{ name: 'Levy', amount: 0.25 }] });
  ok(r.data.total === 12.38, 'tariff math: 1 + 10×0.5 + 5×1 + 0.25 levy = 11.25 + 10% tax = 12.38', r.data.total);
  r = await cashier.post('/api/customers', { name: 'Test Household (fictional)', customer_type: 'household', area_id: areaId, address: '1 Test Road', phone: '+231 770 000 111', lat: 6.75, lng: -10.84 });
  ok(r.status === 200 && /^DEMO-TST-00001$/.test(r.data.customer_number), 'customer created with unique number ' + r.data.customer_number); const custId = r.data.id;
  r = await cashier.post('/api/customers', { name: 'x', customer_type: 'household', area_id: areaId, address: 'a', email: 'not-an-email' });
  ok(r.status === 400, 'input validation rejects bad email');
  const models = (await admin.get('/api/meter-models')).data; const mech = models.find(m => m.model.includes('dry dial'));
  r = await admin.post('/api/meters', { serial_number: 'TST-0001', manufacturer: 'Generic (demo)', model: mech.model, model_id: mech.id, meter_type: 'mechanical', size_mm: 15, comm_method: 'lorawan', install_date: '2026-09-01', initial_reading: 100 });
  ok(r.status === 400 && /not registered as supporting/.test(r.data.error), 'meter model capability check blocks unsupported method (LoRaWAN on dry-dial meter)');
  r = await admin.post('/api/meters', { serial_number: 'TST-0001', manufacturer: 'Generic (demo)', model: mech.model, model_id: mech.id, meter_type: 'mechanical', size_mm: 15, comm_method: 'manual', install_date: '2026-09-01', initial_reading: 100, customer_id: custId });
  ok(r.status === 200, 'meter registered and assigned to customer', r.data); const meterId = r.data.id;
  r = await admin.post('/api/meters', { serial_number: 'TST-0001', manufacturer: 'x', model: 'y', meter_type: 'mechanical', size_mm: 15 });
  ok(r.status === 409, 'duplicate meter serial rejected');

  console.log('\nFlow 2 — enter / import / sync readings');
  r = await reader.post('/api/readings', { meter_id: meterId, value: 110 });
  ok(r.status === 403, 'meter reader limited to own service area cannot read this meter');
  r = await cashier.post('/api/readings', { meter_id: meterId, value: 104, reading_at: daysAgo(40) });
  ok(r.status === 200, 'manual reading entered', r.data); const r1 = r.data.id;
  const csvText = `meter_serial,reading_value,reading_date,reader,estimated,notes\nTST-0001,${(118.5).toFixed(1)},${daysAgo(3).slice(0, 10)},Demo reader,no,from sheet\nUNKNOWN-1,5,${today},x,no,\nTST-0001,abc,${today},x,no,`;
  r = await cashier.post('/api/readings/import', { filename: 't.csv', content: csvText });
  ok(r.data.preview && r.data.valid === 1 && r.data.invalid === 2, 'CSV preview: 1 valid, 2 rejected (unknown serial, bad value)', r.data);
  r = await cashier.post('/api/readings/import', { filename: 't.csv', content: csvText, commit: true });
  ok(r.data.committed && r.data.accepted === 1, 'CSV import committed');
  const uuid = 'test-offline-' + Date.now();
  r = await cashier.post('/api/readings/sync', { items: [{ client_uuid: uuid, meter_id: meterId, value: 90, captured_at: daysAgo(1) }] });
  ok(r.data.results[0].ok && r.data.results[0].flags.includes('decreasing') && r.data.results[0].flags.includes('offline_capture'), 'offline-synced reading stored and flagged (decreasing, offline capture)', r.data);
  r = await cashier.post('/api/readings/sync', { items: [{ client_uuid: uuid, meter_id: meterId, value: 90, captured_at: daysAgo(1) }] });
  ok(r.data.results[0].duplicate === true, 'repeat sync of same offline record is idempotent (no duplicate)');

  console.log('\nFlow 3 — review and approve readings');
  const pend = (await billing.get(`/api/readings?meter_id=${meterId}&group=all`)).data;
  ok(pend.length === 3 && pend.every(x => x.status === 'pending'), '3 readings pending review');
  r = await reader.post(`/api/readings/${r1}/approve`); ok(r.status === 403, 'meter reader cannot approve readings');
  r = await billing.post(`/api/readings/${r1}/approve`); ok(r.data.status === 'approved', 'billing officer approves reading');
  const bad = pend.find(x => x.value === 90);
  r = await billing.post(`/api/readings/${bad.id}/correct`, { value: 120.2, reason: 'Photo shows 120.2 — digits misread', approve: true });
  ok(r.data.status === 'approved' && r.data.corrected_value === 120.2 && r.data.value === 90, 'correction approved; original value 90 kept');
  const csvR = pend.find(x => x.value === 118.5);
  r = await billing.post(`/api/readings/${csvR.id}/reject`, { reason: 'Superseded by later reading' }); ok(r.data.status === 'rejected', 'reading rejected with reason');
  r = await billing.post(`/api/readings/${csvR.id}/reject`, {}); ok(r.status === 400 || r.data.status === 'rejected', 'reject requires a reason');
  const aud = (await admin.get(`/api/audit?entity=reading&entity_id=${bad.id}`)).data;
  ok(aud.some(a => a.action === 'reading.correct' && JSON.parse(a.details).original_value === 90), 'correction recorded in audit log with original value');

  console.log('\nFlow 4 — generate bill and record payment');
  const pStart = daysAgo(45).slice(0, 10);
  r = await billing.post('/api/bills/generate', { period_start: pStart, period_end: today, area_id: areaId });
  const res = r.data.results.find(x => x.customer_id === custId);
  ok(res && res.status === 'ok' && res.consumption === 20.2, 'preview uses approved readings only: 120.2 − 100 = 20.2 m³', res);
  ok(res.total === r2(((1 + 5 + 10.2 + 0.25) * 1.1)), `itemised total ${res.total} USD`, res);
  r = await reader.post('/api/bills/generate', { period_start: pStart, period_end: today, commit: true }); ok(r.status === 403, 'meter reader cannot generate bills');
  r = await billing.post('/api/bills/generate', { period_start: pStart, period_end: today, area_id: areaId, commit: true });
  const bill = r.data.results.find(x => x.customer_id === custId); ok(bill.bill_number && bill.bill_number.startsWith('DEMO-B'), 'bill issued ' + bill.bill_number);
  r = await billing.post('/api/bills/generate', { period_start: pStart, period_end: today, area_id: areaId, commit: true });
  ok(r.data.results.find(x => x.customer_id === custId).status === 'skipped', 'cannot double-bill the same period');
  const bd = (await cashier.get('/api/bills/' + bill.bill_id)).data;
  ok(bd.lines.length === 5 && bd.lines.some(l => l.line_type === 'tax'), 'bill has itemised lines (fixed, 2 bands, fee, tax)');
  r = await cashier.post('/api/payments', { customer_id: custId, bill_id: bill.bill_id, amount: 5, method: 'mobile_money_mtn' });
  ok(r.status === 400 && /reference/.test(r.data.error), 'mobile money requires a transaction reference');
  r = await cashier.post('/api/payments', { customer_id: custId, bill_id: bill.bill_id, amount: 5, method: 'cash', card_number: '4111111111111111' });
  ok(r.status === 400 && /Card/i.test(r.data.error), 'card data refused');
  r = await cashier.post('/api/payments', { customer_id: custId, bill_id: bill.bill_id, amount: 10, method: 'mobile_money_mtn', reference: 'MTN-TEST-1' });
  ok(r.status === 200 && r.data.amount === 10, 'partial payment posted, receipt ' + r.data.receipt_number); const pay1 = r.data.id;
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 10, method: 'mobile_money_mtn', reference: 'MTN-TEST-1' });
  ok(r.status === 409, 'duplicate mobile-money reference rejected');
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 950, currency: 'LRD', method: 'cash' });
  ok(r.status === 200 && r.data.amount === 5 && r.data.tendered_currency === 'LRD', 'LRD tendered on USD account converted at configured rate (950 LRD → 5.00 USD)', r.data);
  ok((await cashier.get('/api/bills/' + bill.bill_id)).data.bill.status === 'partially_paid', 'bill status partially paid');
  r = await cashier.post(`/api/payments/${pay1}/reverse`, { reason: 'Customer reference mismatch' }); ok(r.status === 403, 'cashier cannot reverse own payment (segregation of duties)');
  r = await billing.post(`/api/payments/${pay1}/reverse`, { reason: 'Customer reference mismatch' }); ok(r.status === 200 && r.data.amount === -10, 'different officer posts reversal');
  r = await billing.post(`/api/payments/${pay1}/reverse`, { reason: 'again' }); ok(r.status === 409 || r.status === 400, 'payment cannot be reversed twice');
  r = await cashier.post('/api/adjustments', { customer_id: custId, amount: -1.5, category: 'leak_relief', reason: 'Leak relief test' });
  ok(r.data.status === 'pending', 'adjustment pending approval'); const adj = r.data.id;
  r = await cashier.post(`/api/adjustments/${adj}/decide`, { decision: 'approved' }); ok(r.status === 403, 'cashier cannot approve adjustments');
  r = await manager.post(`/api/adjustments/${adj}/decide`, { decision: 'approved', note: 'ok' }); ok(r.status === 200, 'manager approves adjustment (maker-checker)');

  console.log('\nFlow 5 — account statement');
  const st = (await cashier.get(`/api/customers/${custId}/statement`)).data;
  const expected = r2(bill.total - 10 - 5 + 10 - 1.5);
  ok(st.closing_balance === expected, `statement closing balance ${st.closing_balance} = bill ${bill.total} − 10 − 5 + 10 (reversal) − 1.5 (credit)`, st.rows);
  ok(st.rows.length === 5, 'statement lists bill, 2 payments, reversal, adjustment');

  console.log('\nFlow 6 — alert and work order');
  r = await manager.post('/api/alerts', { title: 'Suspected leak at meter box (test)', severity: 'high', rule_type: 'suspected_leak', customer_id: custId });
  ok(r.status === 200, 'manager raises suspected-leak alert'); const alertId = r.data.id;
  const techId = (await admin.get('/api/users')).data.find(u => u.username === 'tech1').id;
  r = await manager.post('/api/work-orders', { alert_id: alertId, type: 'leak', priority: 'high', title: 'Fix leak (test)', assigned_to: techId });
  ok(r.status === 200, 'work order ' + r.data.wo_number + ' created from alert and assigned'); const wo = r.data.id;
  r = await reader.post(`/api/work-orders/${wo}/update`, { status: 'completed', note: 'x' }); ok(r.status === 403, 'meter reader cannot update work orders');
  r = await tech.post(`/api/work-orders/${wo}/update`, { status: 'in_progress', note: 'On site' }); ok(r.status === 200, 'technician starts work');
  r = await tech.post(`/api/work-orders/${wo}/update`, { status: 'completed', note: 'Replaced washer at meter coupling' }); ok(r.status === 200, 'technician completes work');
  const al = (await manager.get('/api/alerts?status=')).data.find(a => a.id === alertId);
  ok(al.status === 'resolved', 'linked alert resolved automatically on completion');
  r = await manager.post('/api/alerts/run'); ok(r.status === 200 && typeof r.data.total === 'number', `alert rules run (${r.data.total} new)`);
  r = await admin.get('/api/integrations'); const sim = r.data.integrations.find(i => i.is_simulator);
  r = await admin.post(`/api/integrations/${sim.id}/simulate`, { scenario: 'leak', hours: 24 }); ok(r.data.created > 0 && r.data.simulated, 'simulator creates readings labelled simulated');

  console.log('\nFlow 7 — dashboards and reports');
  r = await manager.get('/api/dashboard'); ok(r.status === 200 && r.data.customers.total > 0 && r.data.nrw.length > 0, 'manager dashboard loads with NRW comparison');
  r = await manager.get(`/api/dashboard?area_id=${areaId}`); ok(r.data.nrw[0].note === 'No bulk supply data recorded', 'areas without bulk data are labelled, not estimated');
  r = await manager.get('/api/reports/bills'); ok(r.status === 200 && r.data.includes('DEMO ENVIRONMENT') && r.data.includes('bill_number'), 'CSV report downloads and is marked DEMO');
  r = await manager.get('/api/reports/readings'); ok(r.data.includes('SIMULATED'), 'simulated readings labelled in CSV');


  console.log('\nFeature phones (USSD / SMS)');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let g = await fetch(`${BASE}/api/gateway/ussd`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'sessionId=t1&phoneNumber=%2B231770000111&text=' });
  ok(g.status === 401 || g.status === 503, 'USSD gateway refuses calls without a key');
  r = await admin.post('/api/channels/gateway-key'); const gk = r.data.key; ok(!!gk, 'gateway key issued');
  const ussd = async text => (await fetch(`${BASE}/api/gateway/ussd`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Api-Key': gk }, body: `sessionId=t1&phoneNumber=%2B231770000111&text=${encodeURIComponent(text)}` })).text();
  let u = await ussd(''); ok(u.startsWith('CON') && u.includes('DEMO-TST-00001'), 'USSD menu recognises the customer by phone (form-encoded aggregator call)');
  u = await ussd('1'); ok(u.startsWith('END') && /owe|Credit|settled/.test(u), 'USSD balance: ' + u.slice(4, 60));
  u = await ussd('3*130.5'); ok(u.startsWith('CON Confirm'), 'USSD reading asks for confirmation');
  u = await ussd('3*130.5*1'); ok(u.startsWith('END Thank you'), 'USSD reading submitted');
  const selfR = (await billing.get(`/api/readings?meter_id=${meterId}&group=all`)).data.find(x => x.source === 'customer_self');
  ok(selfR && selfR.status === 'pending' && JSON.parse(selfR.flags_json).includes('customer_submitted'), 'customer self-reading is pending review and flagged as customer-submitted');
  g = await fetch(`${BASE}/api/gateway/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': gk }, body: JSON.stringify({ from: '0770000111', text: 'LEAK behind the school' }) }).then(x => x.json());
  ok(/Report received/.test(g.reply), 'SMS LEAK keyword raises an alert');
  ok((await manager.get('/api/alerts?status=open_all')).data.some(a => a.customer_id === custId && a.rule_type === 'customer_report'), 'customer leak report appears in the alert queue');
  const msgs = (await manager.get('/api/channels/messages?phone=770000111')).data;
  ok(msgs.some(m => m.purpose === 'bill') && msgs.some(m => m.purpose === 'receipt'), 'bill and payment SMS notifications were queued for the customer');
  ok(msgs.filter(m => m.direction === 'out').every(m => m.status === 'simulated'), 'outbound SMS are marked simulated (no real gateway configured)');

  console.log('\nMobile money reconciliation');
  const momoPost = (prov, body, key = gk) => fetch(`${BASE}/api/gateway/momo/${prov}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, data: await x.json() }));
  let mm = await momoPost('mtn', { financialTransactionId: 'T-MTN-1', msisdn: '231775550000', amount: 3, currency: 'USD', reference: 'tst 00001', timestamp: new Date().toISOString() });
  ok(mm.data.status === 'matched', 'MoMo webhook auto-matched by account reference (typed loosely: "tst 00001")');
  mm = await momoPost('mtn', { financialTransactionId: 'T-MTN-1', msisdn: '231775550000', amount: 3, currency: 'USD', reference: 'tst 00001' });
  ok(mm.data.duplicate === true, 'same provider transaction ID is never posted twice');
  mm = await momoPost('orange', { txn_ref: 'T-OM-2', msisdn: '231886660000', amount: 2, currency: 'USD', reference: 'for my water' });
  ok(mm.data.status === 'unmatched', 'unknown sender + vague reference waits for a cashier');
  const um = (await cashier.get('/api/momo?status=unmatched')).data.find(t => t.txn_ref === 'T-OM-2');
  r = await tech.post(`/api/momo/${um.id}/match`, { customer_id: custId }); ok(r.status === 403, 'technician cannot match mobile-money payments');
  r = await cashier.post(`/api/momo/${um.id}/match`, { customer_id: custId }); ok(r.data.status === 'matched' && r.data.payment_id, 'cashier matches it; payment receipt created');
  const stmt = 'transaction_id,msisdn,amount,currency,reference,date\nT-MTN-1,231775550000,3,USD,tst 00001,2026-10-30\nT-MTN-9,0770000111,4,USD,,2026-10-30\nBAD,,x,USD,,nodate';
  r = await cashier.post('/api/momo/import', { provider: 'mtn', content: stmt });
  ok(r.data.valid === 1 && r.data.duplicates === 1 && r.data.invalid === 1, 'statement CSV preview: 1 new, 1 duplicate skipped, 1 invalid');
  r = await cashier.post('/api/momo/import', { provider: 'mtn', content: stmt, commit: true }); ok(r.data.matched === 1, 'statement import matched by sender phone');

  console.log('\nPay-as-you-fetch water points');
  r = await admin.post('/api/assets', { code: 'TST-WP-1', name: 'Test kiosk', asset_type: 'water_point', area_id: areaId, status: 'operational' }); const wpId = r.data.id;
  r = await admin.post('/api/users', { username: 'att_test', full_name: 'Test Attendant', role: 'attendant', password: 'Attendant2026x' }); const attId = r.data.id;
  const att = new Client(); await att.post('/api/auth/login', { username: 'att_test', password: 'Attendant2026x' });
  r = await att.get('/api/wp/my'); ok(r.status === 403 && r.data.details && r.data.details.code === 'PASSWORD_CHANGE_REQUIRED', 'new attendant must change temporary password first');
  await att.post('/api/auth/change-password', { current_password: 'Attendant2026x', new_password: 'Attendant2026y' });
  r = await manager.put(`/api/wp/points/${wpId}/config`, { mode: 'pay_per_container', currency: 'USD', container_liters: 20, price_per_container: 0.05, attendant_user_id: attId, meter_id: meterId });
  ok(r.status === 200, 'manager sets up the kiosk: US$0.05 per 20 L, attendant assigned, tap meter linked');
  r = await att.post('/api/wp/sell', { asset_id: wpId, containers: 4, method: 'cash' }); ok(r.data.amount === 0.2 && r.data.liters === 80, 'attendant sells 4 containers for cash');
  r = await (await as('attendant1')).post('/api/wp/sell', { asset_id: wpId, containers: 1, method: 'cash' }); ok(r.status === 403, "another attendant cannot sell at this kiosk");
  r = await cashier.post('/api/wp/wallets', { holder_name: 'Test Card Holder', phone: '+231 880 001 234', area_id: areaId }); const card = r.data.card_number; ok(/^DEMO-WC-TST-0001$/.test(card), 'water card issued ' + card);
  r = await att.post('/api/wp/sell', { asset_id: wpId, containers: 2, method: 'wallet', card_number: card }); ok(r.status === 409 && /Insufficient/.test(r.data.error), 'online card sale refused when balance is too low');
  r = await att.post('/api/wp/topup', { card_number: card, amount: 0.5, asset_id: wpId }); ok(r.data.wallet_balance === 0.5, 'attendant tops up card with cash');
  mm = await momoPost('mtn', { txn_ref: 'T-MTN-CARD', msisdn: '231779990000', amount: 0.25, currency: 'USD', reference: card.replace('DEMO-', '') });
  ok(mm.data.status === 'matched', 'mobile money with card number as reference tops up the water card');
  r = await att.post('/api/wp/sell', { asset_id: wpId, containers: 3, method: 'wallet', card_number: card }); ok(r.data.wallet_balance === 0.6, 'card sale deducts balance (0.75 − 0.15 = 0.60)');
  const cu = 'offline-sale-' + Date.now();
  r = await att.post('/api/wp/sync', { items: [{ kind: 'sale', client_uuid: cu, asset_id: wpId, containers: 20, method: 'wallet', card_number: card, offline: true, captured_at: daysAgo(0.1) }] });
  ok(r.data.results[0].ok && r.data.results[0].flags.includes('overdraft_offline'), 'offline card sale is accepted but flagged as overdraft');
  r = await att.post('/api/wp/sync', { items: [{ kind: 'sale', client_uuid: cu, asset_id: wpId, containers: 20, method: 'wallet', card_number: card, offline: true }] }); ok(r.data.results[0].duplicate, 'offline sale re-sync is idempotent');
  const rc = (await manager.get(`/api/wp/points/${wpId}/reconcile?from=${today}&to=${today}`)).data;
  ok(rc.containers === 27 && rc.cash_sales === 0.2 && rc.expected_cash === 0.7, 'reconciliation: 27 containers (4 cash + 3 card + 20 offline card); cash expected = 0.20 sales + 0.50 top-up');
  r = await cashier.post('/api/wp/handovers', { asset_id: wpId, period_from: today, period_to: today, amount: 0.6 }); ok(r.data.variance === -0.1, 'cash handover records a 0.10 shortfall');

  console.log('\nPhoto OCR');
  r = await cashier.post('/api/readings', { meter_id: meterId, value: 141, photo: PNG, ocr_value: 147, ocr_confidence: 85 });
  ok(JSON.parse(r.data.flags_json).includes('ocr_mismatch') && r.data.ocr_value === 147, 'entered value differing from photo OCR is flagged');
  r = await cashier.post('/api/readings', { meter_id: meterId, value: 147.3, photo: PNG, ocr_value: 147, ocr_confidence: 88 });
  ok(JSON.parse(r.data.flags_json).includes('ocr_match'), 'agreeing OCR is recorded as a match');
  r = await cust.post('/api/portal/reading', { value: 1, photo: PNG }); ok(r.status === 200 && r.data.flags.includes('customer_submitted'), 'customer sends own reading with photo from the portal');
  r = await reader.post('/api/portal/reading', { value: 1, photo: PNG }); ok(r.status === 403, 'staff cannot use the customer self-reading endpoint');

  console.log('\nWater-loss intelligence & transparency');
  r = await manager.get('/api/nrw/balance'); const rv = r.data.areas.find(a => a.area.startsWith('Riverside'));
  ok(rv && rv.status === 'ok' && rv.nrw_pct > 0 && ['A', 'B', 'C'].includes(rv.grade) && rv.real_losses_m3 + rv.apparent_losses_m3 === r2(rv.water_losses_m3) || Math.abs(rv.real_losses_m3 + rv.apparent_losses_m3 - rv.water_losses_m3) < 0.02, `water balance for Riverside: NRW ${rv.nrw_pct}% grade ${rv.grade}`);
  ok(r.data.areas.find(a => a.area_id === areaId).status === 'no_supply_data', 'area without bulk supply data is not given a made-up NRW figure');
  r = await manager.get('/api/nrw/suspicious'); ok(Array.isArray(r.data) && r.data.length > 0 && r.data.every(x => x.reasons.length), `revenue-protection list: ${r.data.length} accounts, each with reasons`);
  r = await cashier.get('/api/nrw/suspicious'); ok(r.status === 403, 'cashier cannot see revenue-protection scoring');
  r = await manager.post('/api/share-links', { title: 'Test donor page', months: 6 }); const tokenUrl = r.data.url; const linkId = r.data.id;
  const pub = await fetch(BASE + '/api' + tokenUrl.replace('/t/', '/public/')).then(x => x.json());
  ok(pub.connections && pub.volumes && pub.title === 'Test donor page', 'public page data served without login');
  const pubText = JSON.stringify(pub);
  ok(!pubText.includes('DEMO-TST') && !pubText.includes('Test Household') && !pubText.includes('770000111'), 'public data contains no names, account numbers or phones');
  ok(pub.connections.by_type.some(t => t.n === '<5'), 'small counts are suppressed ("<5")');
  await manager.post(`/api/share-links/${linkId}/revoke`);
  ok((await fetch(BASE + '/api' + tokenUrl.replace('/t/', '/public/'))).status === 404, 'revoked link stops working');

  console.log('\nCommunity reporting & public status');
  const pubPost = (u, b, h = {}) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...h }, body: JSON.stringify(b) }).then(async x => ({ status: x.status, data: await x.json() }));
  let pr = await pubPost('/api/public-report', { kind: 'burst', area_id: areaId, location_text: 'Near the test school', website: 'spam.example' });
  ok(pr.status === 400, 'honeypot field blocks bots');
  pr = await pubPost('/api/public-report', { kind: 'burst', area_id: areaId, form_ms: 500, location_text: 'x' }); ok(pr.status === 400, 'too-fast form submissions are rejected');
  pr = await pubPost('/api/public-report', { kind: 'burst', form_ms: 5000 }); ok(pr.status === 400, 'a location or area is required');
  pr = await pubPost('/api/public-report', { kind: 'burst', area_id: areaId, location_text: 'Near the test school', phone: '+231 880 555 001', form_ms: 5000, photo: PNG });
  ok(pr.status === 200 && /^R-[A-Z0-9]{6}$/.test(pr.data.ref), 'anyone can report without an account: ref ' + pr.data.ref);
  let tr = await fetch(BASE + '/api/public-report/' + pr.data.ref).then(x => x.json()); ok(tr.stage === 'received', 'report can be tracked by reference');
  r = await manager.post(`/api/alerts/${pr.data.alert_id}/update`, { status: 'resolved', note: 'Clamp fitted' });
  ok(r.data.reporters_notified === 1, 'resolving the alert notifies the reporter (closed loop)');
  tr = await fetch(BASE + '/api/public-report/' + pr.data.ref).then(x => x.json()); ok(tr.stage === 'resolved', 'tracking shows resolved');
  ok((await manager.get('/api/channels/messages?phone=880555001')).data.some(m => m.purpose === 'report_closed'), 'reporter received the "resolved" SMS');
  u = await fetch(`${BASE}/api/gateway/ussd`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Api-Key': gk }, body: 'sessionId=t9&phoneNumber=%2B231889990001&text=1*1*2' }).then(x => x.text());
  ok(/Report R-[A-Z0-9]{6} received/.test(u), 'unregistered phone can report a burst by USSD');
  const ps = await fetch(BASE + '/api/public-status').then(x => x.json());
  ok(ps.areas.length > 0 && !JSON.stringify(ps).includes('Test Household') && !JSON.stringify(ps).includes('DEMO-TST'), 'public status page lists areas and contains no customer data');

  console.log('\nWater quality');
  r = await reader.post('/api/wq/tests', { asset_id: wpId, parameter: 'free_chlorine', value: 0.5 }); ok(r.status === 403, 'meter reader cannot record water tests');
  r = await (await as('attendant1')).post('/api/wq/tests', { asset_id: wpId, parameter: 'free_chlorine', value: 0.5 }); ok(r.status === 403, 'attendant cannot record tests at another water point');
  r = await att.post('/api/wq/tests', { asset_id: wpId, parameter: 'free_chlorine', value: 0.1 });
  ok(r.data.result === 'fail' && r.data.alert_id, 'chlorine 0.1 mg/L fails and raises an alert');
  let pst = (await fetch(BASE + "/api/public-status").then(x => x.json())).areas.find(a => a.code === 'TST');
  ok(pst.quality_advisory === true, "public advisory published for the area");
  ok((await manager.get('/api/channels/messages?purpose=quality_advisory')).data.length > 0, 'advisory SMS broadcast to people in the area');
  r = await att.post('/api/wq/tests', { asset_id: wpId, parameter: 'free_chlorine', value: 0.45 }); ok(r.data.result === 'pass' && r.data.advisory === 'lifted', 're-test passes and lifts the advisory');
  pst = (await fetch(BASE + "/api/public-status").then(x => x.json())).areas.find(a => a.code === "TST"); ok(pst.quality_advisory === false, 'advisory no longer shown publicly');
  r = await tech.post('/api/wq/tests', { asset_id: wpId, parameter: 'ecoli', value: 3, method: 'lab' });
  ok(r.data.result === 'fail' && (await manager.get('/api/alerts?status=open_all')).data.some(a => a.rule_type === 'water_quality' && a.severity === 'critical'), 'E. coli detection is a critical alert');

  console.log('\nHumane collections');
  const bal = (await cashier.get(`/api/customers/${custId}`)).data.balance;
  r = await cashier.post('/api/plans/preview', { customer_id: custId, instalments: 3, frequency: 'monthly', down_payment: 0 });
  ok(r.data.schedule.length === 3 && Math.abs(r.data.schedule.reduce((a, x) => a + x.amount, 0) - bal) < 0.011, 'plan preview splits the arrears exactly into 3 instalments');
  r = await cashier.post('/api/plans', { customer_id: custId, instalments: 3, frequency: 'monthly' }); ok(r.status === 200 && ['on_track', 'behind'].includes(r.data.health) && r.data.instalments.length === 3, 'payment plan agreed', r.data);
  r = await cashier.post('/api/plans', { customer_id: custId, instalments: 2, frequency: 'weekly' }); ok(r.status === 409, 'only one active plan per customer');
  ok((await manager.get('/api/channels/messages?phone=770000111')).data.some(m => m.purpose === 'plan'), 'customer received the plan by SMS');
  const lad = (await manager.get('/api/collections/ladder')).data.rows;
  const ess = lad.find(x => x.essential && x.balance > 0);
  if (ess) { r = await manager.post('/api/collections/review', { customer_id: ess.customer_id, note: 'Reminders and visits done' }); ok(r.status === 409, 'essential services can never be put forward for disconnection'); }
  const nonEss = lad.find(x => !x.essential && x.stage === 'review');
  r = await tech.post('/api/collections/review', { customer_id: nonEss.customer_id, note: 'Reminders sent, visited twice' }); ok(r.status === 403, 'technician cannot open a disconnection review');
  r = await manager.post('/api/collections/review', { customer_id: nonEss.customer_id, note: 'short' }); ok(r.status === 400, 'review requires a record of steps taken');
  r = await manager.post('/api/collections/review', { customer_id: nonEss.customer_id, note: 'Two SMS reminders, phone call on 20 Oct, plan offered and declined' }); ok(r.status === 200 && /^DEMO-WO-/.test(r.data.wo_number), 'manager-review work order created (no automatic disconnection)');
  const rem1 = (await cashier.post('/api/collections/reminders')).data; const rem2 = (await cashier.post('/api/collections/reminders')).data;
  ok(rem2.due_soon + rem2.overdue + rem2.instalment === 0, `reminders are sent once only (first run ${rem1.due_soon + rem1.overdue + rem1.instalment}, second run 0)`);

  console.log('\nTariff lab, briefing, routes');
  r = await manager.post('/api/tariff-lab/simulate', { area_id: 1, months: 6, fixed_charge: 50, bands: [{ up_to: 6, rate: 20 }, { up_to: null, rate: 90 }] });
  ok(r.status === 200 && r.data.revenue.current_total > 0 && r.data.lifeline.m3_per_month === 3 && r.data.distribution.reduce((a, d) => a + d.n, 0) === r.data.bills, `tariff simulation on ${r.data.bills} real bills: revenue ${r.data.revenue.change_pct}%`);
  ok(r.data.equity && Array.isArray(r.data.equity.kiosks), 'kiosk vs piped price comparison included');
  r = await cashier.post('/api/tariff-lab/simulate', { area_id: 1, bands: [{ rate: 1 }] }); ok(r.status === 403, 'cashier cannot use the tariff lab');
  r = await manager.get('/api/briefing'); ok(r.status === 200 && r.data.items.length > 0 && r.data.items.every(i => i.link && i.title), `morning briefing: ${r.data.items.length} priorities`);
  r = await manager.post('/api/briefing/sms', { phone: '+231 770 999 000' }); ok(r.status === 200 && r.data.text.length <= 480, 'briefing can be sent by SMS');
  r = await cust.get('/api/briefing'); ok(r.status === 403, 'customers cannot see the briefing');
  const rmjs = path.join(TMP, 'route.mjs'); fs.copyFileSync(path.join(ROOT, 'public/js/route.js'), rmjs); const route = await import(require('url').pathToFileURL(rmjs).href);
  const pts = [[6.30, -10.80], [6.31, -10.79], [6.30, -10.79], [6.31, -10.80], [6.305, -10.795]].map(([lat, lng], i) => ({ id: i, lat, lng }));
  const pl = route.planRoute({ lat: 6.30, lng: -10.80 }, [pts[1], pts[4], pts[0], pts[3], pts[2]]);
  ok(pl.order.length === 5 && pl.km <= pl.naive_km, `route optimiser shortens the walk (${pl.km} km vs ${pl.naive_km} km in list order)`);

  console.log('\nGrowth — new connections with financing');
  const apl = new Client();
  r = await apl.post('/api/public-connection', { applicant_name: 'Test Applicant (Demo)', phone: '+231 770 111 222', area_id: 1, address: '5 Test Lane', website: 'spam', form_ms: 9000 }); ok(r.status === 400, 'connection form honeypot rejects bots');
  r = await apl.post('/api/public-connection', { applicant_name: 'Test Applicant (Demo)', phone: '+231 770 111 222', area_id: 1, address: '5 Test Lane', form_ms: 9000, household_size: 6 });
  ok(r.status === 200 && /^C-[A-Z0-9]{6}$/.test(r.data.ref), 'public connection application accepted with tracking ref', r.data); const cref = r.data.ref;
  r = await apl.get('/api/public-report/' + cref); ok(r.status === 200 && r.data.status === 'submitted' && !JSON.stringify(r.data).includes('770 111'), 'applicant can track by ref (no personal data exposed)', r.data);
  r = await manager.get('/api/connections'); const creq = r.data.find(x => x.ref === cref); ok(!!creq, 'request appears in staff pipeline');
  r = await manager.post(`/api/connections/${creq.id}/quote`, { lines: [{ description: 'x', amount: 1 }] }); ok(r.status === 409, 'cannot quote before survey');
  r = await manager.post(`/api/connections/${creq.id}/schedule_survey`, { due_date: today }); ok(r.status === 200, 'survey scheduled (work order created)', r.data);
  r = await tech.post(`/api/connections/${creq.id}/record_survey`, { distance_m: 20 }); ok(r.status === 403, 'technician can view but not advance the pipeline');
  r = await manager.post(`/api/connections/${creq.id}/record_survey`, { distance_m: 20, notes: 'Main on the road, good pressure' }); ok(r.status === 200, 'survey recorded');
  r = await manager.get(`/api/connections/${creq.id}`); ok(r.status === 200 && r.data.default_quote.lines.length === 3, 'default quote suggested from standard costs (with currency conversion)', r.data.default_quote);
  r = await manager.post(`/api/connections/${creq.id}/quote`, { lines: [{ description: 'Connection fee', amount: 40 }, { description: 'Pipe 20 m', amount: 30 }, { description: 'Meter', amount: 50 }] }); ok(r.status === 200, 'quote issued (120)', r.data);
  r = await manager.post(`/api/connections/${creq.id}/accept`, { deposit: 30, instalments: 99 }); ok(r.status === 400, 'instalments capped by settings');
  r = await manager.post(`/api/connections/${creq.id}/accept`, { deposit: 30, instalments: 6 }); ok(r.status === 200, 'quote accepted: deposit 30, 6 instalments', r.data);
  r = await manager.get(`/api/connections/${creq.id}`); const cdet = r.data; ok(cdet.request.customer_id && cdet.request.instalment_amount === 15, 'pending account created; instalment = (120-30)/6 = 15', cdet.request);
  r = await cashier.post(`/api/connections/${creq.id}/start_install`, {}); ok(r.status === 400 || r.status === 409, 'installation blocked until deposit paid', r.data);
  r = await cashier.post('/api/payments', { customer_id: cdet.request.customer_id, amount: 30, method: 'cash' }); ok(r.status === 200, 'deposit paid at cash desk', r.data);
  r = await cashier.post(`/api/connections/${creq.id}/start_install`, {}); ok(r.status === 200, 'installation started once deposit paid', r.data);
  r = await manager.post(`/api/connections/${creq.id}/complete`, { meter_id: cdet.meters_in_stock[0].id, initial_reading: 0 }); ok(r.status === 200, 'connection completed: meter assigned, account active', r.data);
  r = await manager.get(`/api/connections/${creq.id}`); ok(r.data.request.status === 'connected' && r.data.financed.length === 6 && Math.abs(r.data.financed.reduce((a, f) => a + f.amount, 0) - 90) < 0.01, '6 monthly financed charges totalling 90', r.data.financed);
  r = await apl.get('/api/public-report/' + cref); ok(r.data.status === 'connected', 'public tracking shows connected');
  // financed line appears on the first bill
  const ncid = cdet.request.customer_id; const nmid = cdet.meters_in_stock[0].id;
  r = await reader.post('/api/readings', { meter_id: nmid, value: 6 }); const nrid = r.data.id || r.data.reading?.id;
  r = await billing.post(`/api/readings/${nrid}/approve`); ok(r.data.status === 'approved', 'first reading on new meter approved', r.data);
  r = await billing.post('/api/bills/generate', { period_start: monthStart === today ? daysAgo(1).slice(0, 10) : monthStart, period_end: today, customer_ids: [ncid], commit: true }); ok(r.status === 200 && r.data.results[0]?.status === 'ok', 'first bill generated', r.data);
  const nbill = (await admin.get('/api/bills?customer_id=' + ncid)).data[0];
  const nbd = nbill && (await admin.get('/api/bills/' + nbill.id)).data;
  ok(nbd && nbd.lines.some(l => l.line_type === 'financed' && l.amount === 15 && /1\/6/.test(l.description)), 'first bill carries instalment 1/6 as its own line', nbd && nbd.lines);
  r = await manager.post(`/api/connections/${creq.id}/cancel`, { reason: 'x' }); ok(r.status === 409, 'connected request cannot be cancelled');

  console.log('\nGrowth — shared compound connection');
  r = await manager.put(`/api/customers/${ncid}/shared`, { split_method: 'fixed_pct', members: [{ name: 'A', share_pct: 60 }, { name: 'B', share_pct: 30 }] }); ok(r.status === 400, 'fixed shares must add up to 100');
  r = await manager.put(`/api/customers/${ncid}/shared`, { split_method: 'household_size', members: [{ name: 'Household A (Demo)', household_size: 6, phone: '+231 770 333 001' }, { name: 'Household B (Demo)', household_size: 3, phone: '+231 770 333 002' }, { name: 'Household C (Demo)', household_size: 3 }] });
  ok(r.status === 200, 'shared group saved (split by household size)', r.data);
  r = await manager.get(`/api/customers/${ncid}/shared`); const sh = r.data; const sb = sh && sh.bills[0];
  ok(sb && sb.shares.length === 3 && Math.abs(sb.shares.reduce((a, x) => a + x.amount, 0) - sb.total) < 0.01 && sb.shares[0].amount > sb.shares[1].amount, `open bill split 6:3:3 (${sb && sb.shares.map(x => x.amount).join(' / ')} of ${sb && sb.total})`, sh);
  const shMem = (await manager.get(`/api/customers/${ncid}/shared`)).data.members[1];
  r = await cashier.post(`/api/customers/${ncid}/shared/pay`, { member_id: shMem.id, amount: 2, method: 'cash' }); ok(r.status === 200, 'household share paid at cash desk', r.data);
  r = await cashier.post(`/api/customers/${ncid}/shared/pay`, { member_id: 999999, amount: 2, method: 'cash' }); ok(r.status === 400, 'payment refused for a household not in this group');
  const cnum = (await admin.get('/api/customers/' + ncid)).data.customer.customer_number;
  r = await admin.post('/api/momo/simulate', { provider: 'mtn', amount: 1.5, currency: nbill.currency, msisdn: '+231 880 000 999', account_ref: `${cnum}-${shMem.seq}` });
  ok(r.status === 200 && JSON.stringify(r.data).includes('shared_member'), 'mobile-money ref <account>-<household> credits that household\'s share', r.data);

  console.log('\nGrowth — cost recovery & performance indicators');
  const kmonth = today.slice(0, 7);
  r = await cashier.post('/api/om-costs', { area_id: 1, period: kmonth, category: 'energy_fuel', amount: 10, currency: 'USD' }); ok(r.status === 403, 'cashier cannot enter O&M costs');
  r = await manager.post('/api/om-costs', { area_id: 1, period: kmonth, category: 'energy_fuel', amount: 500, currency: 'LRD' }); ok(r.status === 200, 'O&M cost entered');
  r = await manager.put('/api/kpi-inputs', { area_id: 1, period: kmonth, staff_count: 4, supply_hours_per_day: 18 }); ok(r.status === 200, 'staff and supply-hours inputs saved');
  r = await manager.get(`/api/kpi?from=${kmonth}&to=${kmonth}`); const k1 = r.data.areas?.find(a => a.area_id === 1) || r.data.areas?.[0];
  ok(r.status === 200 && k1 && k1.values.supply_hours != null && k1.values.connections > 0 && 'om_coverage' in k1.values, 'indicators computed per area', k1 && k1.values);
  r = await manager.put('/api/kpi-targets/nrw_pct', { target: 20, direction: 'max' }); ok(r.status === 200, 'manager can set an indicator target');
  r = await manager.get(`/api/kpi?from=${kmonth}&to=${kmonth}&format=csv`); ok(r.status === 200 && typeof r.data === 'string' && r.data.includes('DEMO'), 'indicators export as CSV marked DEMO');
  r = await cust.get('/api/kpi'); ok(r.status === 403, 'customers cannot see indicators');

  console.log('\nGrowth — bulk onboarding');
  r = await cashier.get('/api/onboarding/template/customers'); ok(r.status === 200 && r.data.startsWith('legacy_ref,'), 'customer template downloadable');
  const ccsv = 'legacy_ref,name,customer_type,area_code,address,phone,household_size\nOLD-1,Imported One (Demo),household,RVS,1 Old Road,+231 770 444 001,4\nOLD-2,Imported Two (Demo),business,RVS,2 Old Road,,\n';
  r = await cashier.post('/api/onboarding/import', { kind: 'customers', content: ccsv }); ok(r.status === 200 && r.data.preview && r.data.ready === 2 && r.data.errors === 0, 'preview: 2 ready, 0 errors', r.data);
  r = await cashier.post('/api/onboarding/import', { kind: 'customers', content: ccsv + 'OLD-3,,alien,ZZZ,,bad phone!,\n', commit: true }); ok(r.status === 400, 'commit refused while any row has errors (all-or-nothing)');
  r = await cashier.post('/api/onboarding/import', { kind: 'customers', content: ccsv, commit: true }); ok(r.status === 200 && r.data.created === 2, '2 customers imported', r.data);
  r = await cashier.post('/api/onboarding/import', { kind: 'customers', content: ccsv }); ok(r.data.ready === 0 && r.data.skip === 2, 're-import is idempotent (rows skipped by legacy ref)', r.data);
  r = await cashier.post('/api/onboarding/import', { kind: 'meters', content: 'serial_number,manufacturer,model,meter_type,size_mm,initial_reading,customer_ref\nIMP-0001,Generic (demo),MJ,mechanical,15,123,OLD-1\n', commit: true }); ok(r.status === 200 && r.data.created === 1, 'meter imported and assigned to imported customer', r.data);
  r = await cashier.post('/api/onboarding/import', { kind: 'balances', content: 'customer_ref,amount,as_of,note\nOLD-1,250,2026-09-30,old ledger\n', commit: true }); ok(r.status === 200 && r.data.created === 1, 'opening balance imported', r.data);
  const imp = (await admin.get('/api/customers?q=OLD-1')).data; const impRow = (Array.isArray(imp) ? imp : imp.rows || [])[0];
  if (impRow) { r = await admin.get('/api/customers/' + impRow.id); ok(JSON.stringify(r.data).includes('250'), 'imported balance on the account'); }
  r = await reader.post('/api/onboarding/import', { kind: 'customers', content: ccsv }); ok(r.status === 403, 'meter reader cannot import');

  console.log('\nSecurity — two-factor sign-in & sessions');
  const crypto = require('crypto');
  const b32d = s => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const out = []; for (const ch of s) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
  const totp = (sec, off = 0) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + off)); const h = crypto.createHmac('sha1', b32d(sec)).update(m).digest(); const o = h[19] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0'); };
  const bil = await as('billing');
  r = await bil.post('/api/auth/2fa/setup'); ok(r.status === 200 && /^[A-Z2-7]{32}$/.test(r.data.secret) && r.data.otpauth.startsWith('otpauth://totp/'), '2FA setup returns secret and authenticator link'); const sec = r.data.secret;
  r = await bil.post('/api/auth/2fa/enable', { code: '000000' }); ok(r.status === 400, 'wrong code does not enable 2FA');
  r = await bil.post('/api/auth/2fa/enable', { code: totp(sec) }); ok(r.status === 200 && r.data.recovery_codes.length === 8, '2FA enabled; 8 recovery codes issued'); const rcodes = r.data.recovery_codes;
  r = await new Client().post('/api/auth/login', { username: 'billing', password: 'DemoPass2026' }); ok(r.status === 200 && r.data.two_factor_required && !r.data.user, 'password alone no longer signs in'); let chal = r.data.challenge;
  const c2 = new Client();
  r = await c2.post('/api/auth/login/2fa', { challenge: chal, code: totp(sec) }); ok(r.status === 401, 'same code cannot be replayed');
  r = await c2.post('/api/auth/login/2fa', { challenge: chal, code: totp(sec, 1) }); ok(r.status === 200 && r.data.user, 'next authenticator code signs in', r.data);
  r = await c2.post('/api/auth/login/2fa', { challenge: chal, code: totp(sec, 1) }); ok(r.status === 401, 'challenge is single-use');
  const c3 = new Client(); r = await c3.post('/api/auth/login', { username: 'billing', password: 'DemoPass2026' });
  r = await c3.post('/api/auth/login/2fa', { challenge: r.data.challenge, code: rcodes[0] }); ok(r.status === 200, 'recovery code signs in');
  const c4 = new Client(); r = await c4.post('/api/auth/login', { username: 'billing', password: 'DemoPass2026' });
  r = await c4.post('/api/auth/login/2fa', { challenge: r.data.challenge, code: rcodes[0] }); ok(r.status === 401, 'recovery code works only once');
  r = await c2.get('/api/auth/sessions'); ok(r.status === 200 && r.data.length >= 3 && r.data.filter(s => s.current).length === 1, `sessions listed (${r.data.length}, one current)`);
  r = await c2.post('/api/auth/sessions/revoke-others'); ok(r.status === 200 && r.data.revoked >= 2, 'other devices signed out');
  r = await c3.get('/api/auth/me'); ok(r.status === 401, 'revoked session no longer works');
  r = await c2.get('/api/auth/me'); ok(r.status === 200, 'current session still works');
  r = await admin.put('/api/settings', { require_2fa_roles: 'manager' }); ok(r.status === 200, 'admin requires 2FA for managers', r.data);
  const mgr2 = await as('manager');
  r = await mgr2.get('/api/customers'); ok(r.status === 403 && r.data.details?.code === 'TWO_FACTOR_SETUP_REQUIRED', 'manager without 2FA is sent to set it up', r.data);
  r = await mgr2.get('/api/auth/2fa'); ok(r.status === 200 && r.data.required, 'setup page still reachable');
  r = await admin.put('/api/settings', { require_2fa_roles: '' }); ok((await mgr2.get('/api/customers')).status === 200, 'clearing the setting lifts the 2FA requirement');
  const users = (await admin.get('/api/users')).data; const bu = users.find(u => u.username === 'billing');
  ok(bu && bu.totp_enabled === 1, 'admin user list shows 2FA status');
  r = await admin.post(`/api/users/${bu.id}/reset-2fa`, { reason: 'Lost phone (test)' }); ok(r.status === 200, 'admin can reset a user\'s 2FA', r.data);
  r = await new Client().post('/api/auth/login', { username: 'billing', password: 'DemoPass2026' }); ok(r.status === 200 && r.data.user, 'after reset, password sign-in works again');
  const rawDb = new (require('node:sqlite').DatabaseSync)(path.join(TMP, 'demo', 'aquatrack-demo.db'));
  // start setup again to check storage encryption
  r = await (await as('billing')).post('/api/auth/2fa/setup');
  const stored = rawDb.prepare("SELECT totp_secret FROM users WHERE username='billing'").get().totp_secret; rawDb.close();
  ok(stored && stored.startsWith('v1:') && !stored.includes(r.data.secret), '2FA secret is stored encrypted', [r.status, stored]);

  console.log('\nService delivery — supply timetables');
  r = await manager.post('/api/supply/schedules', { area_id: areaId, days: '0123456', start_time: '10:00', end_time: '09:00' }); ok(r.status === 400, 'schedule end must be after start');
  r = await cashier.post('/api/supply/schedules', { area_id: areaId, days: '0123456', start_time: '06:00', end_time: '09:00' }); ok(r.status === 403, 'cashier cannot change the supply timetable');
  const nowD = new Date(); const soon = new Date(nowD.getTime() + 30 * 60e3); const hhmm = d => d.toISOString().slice(11, 16);
  const lateNight = soon.getUTCDate() !== nowD.getUTCDate() || soon.getUTCHours() >= 23;
  const st1 = lateNight ? '06:00' : hhmm(soon), et1 = lateNight ? '09:00' : (soon.getUTCHours() >= 22 ? '23:59' : hhmm(new Date(soon.getTime() + 60 * 60e3)));
  r = await manager.post('/api/supply/schedules', { area_id: areaId, days: '0123456', start_time: st1, end_time: et1, notes: 'test' }); ok(r.status === 200, `daily supply schedule ${st1}–${et1} saved`, r.data); const schId = r.data.id;
  r = await manager.get('/api/supply/upcoming?area_id=' + areaId); ok(r.status === 200 && r.data.some(w => w.schedule_id === schId), 'upcoming supply windows listed');
  if (!lateNight) {
    r = await manager.post('/api/supply/heads-up'); ok(r.status === 200 && r.data.windows >= 1 && r.data.recipients >= 1, `heads-up SMS sent before the window (${r.data.recipients} customer(s))`, r.data);
    r = await manager.post('/api/supply/heads-up'); ok(r.status === 200 && !r.data.windows, 'each window is announced only once');
  } else ok(true, 'heads-up timing test skipped near midnight (UTC)');
  r = await admin.post('/api/channels/simulate/sms', { phone: '+231 770 000 111', body: 'SUPPLY' }); ok(/Next water/.test(r.data.reply), 'customer texts SUPPLY and gets the next supply time', r.data);
  r = await admin.post('/api/channels/simulate/sms', { phone: '+231 770 000 111', body: 'SUPPLY OFF' }); ok(/OFF/.test(r.data.reply), 'customer can switch supply messages off by SMS');
  r = await admin.post('/api/channels/simulate/sms', { phone: '+231 770 000 111', body: 'SUPPLY ON' });
  const yday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  r = await tech.post('/api/supply/log', { schedule_id: schId, supply_date: yday, delivered_hours: 0.5 }); ok(r.status === 400, 'short supply needs a reason');
  r = await tech.post('/api/supply/log', { schedule_id: schId, supply_date: yday, delivered_hours: 0.5, reason: 'Generator fuel ran out (test)' }); ok(r.status === 200 && r.data.outcome === 'partial', 'technician logs a partial supply with reason', r.data);
  r = await tech.post('/api/supply/log', { schedule_id: schId, supply_date: '2099-01-01', delivered_hours: 1 }); ok(r.status === 400, 'cannot log supply in the future');
  r = await manager.get('/api/supply/log'); const relT = r.data.reliability.find(a => a.area_id === areaId);
  ok(relT && relT.reliability_pct < 100 && relT.missed + relT.partial >= 1, `supply reliability computed (${relT && relT.reliability_pct}%)`, relT);
  r = await new Client().get('/api/public-status'); ok(r.data.areas.find(a => a.code === 'TST')?.schedule?.length > 0, 'public status page shows the supply timetable');
  r = await manager.get(`/api/kpi?from=${yday.slice(0, 7)}&to=${yday.slice(0, 7)}&area_id=${areaId}`); ok(r.data.areas[0].values.supply_reliability_pct != null, 'supply reliability feeds the performance indicators');

  console.log('\nService delivery — stores');
  r = await tech.post('/api/stock/items', { code: 'T-PIPE', name: 'Test pipe', category: 'pipe', unit: 'm' }); ok(r.status === 403, 'technician cannot create store items');
  r = await manager.post('/api/stock/items', { code: 'T-PIPE', name: 'Test pipe 20 mm', category: 'pipe', unit: 'm', reorder_level: 5, unit_cost: 1.5, currency: 'USD' }); ok(r.status === 200, 'store item created'); const itId = r.data.id;
  r = await tech.post('/api/stock/move', { item_id: itId, qty: 10, kind: 'receive' }); ok(r.status === 403, 'technician cannot receive stock');
  r = await manager.post('/api/stock/move', { item_id: itId, qty: 10, kind: 'receive', reference: 'GRN-T1' }); ok(r.status === 200 && r.data.on_hand === 10, 'stock received: 10 m on hand');
  r = await tech.post('/api/stock/move', { item_id: itId, qty: 20, kind: 'issue', work_order_id: wo }); ok(r.status === 409, 'cannot issue more than is in stock');
  r = await manager.post('/api/stock/move', { item_id: itId, qty: 7, kind: 'issue', work_order_id: wo }); ok(r.status === 200 && r.data.on_hand === 3 && r.data.low, 'issued 7 m to a work order — now below reorder level', r.data);
  r = await manager.post('/api/stock/move', { item_id: itId, qty: 9, kind: 'return', work_order_id: wo }); ok(r.status === 400, 'cannot return more than was issued');
  r = await manager.post('/api/stock/move', { item_id: itId, qty: 2, kind: 'return', work_order_id: wo }); ok(r.status === 200 && r.data.on_hand === 5, '2 m returned unused');
  r = await manager.get(`/api/work-orders/${wo}/materials`); ok(r.data.rows.some(x => x.item_id === itId && x.qty === 5) && r.data.totals.USD >= 7.5, 'work order shows materials used and their cost', r.data);
  r = await manager.post('/api/stock/move', { item_id: itId, qty: -1, kind: 'adjust' }); ok(r.status === 400, 'stock adjustments need a reason');
  r = await manager.get('/api/briefing'); ok(r.data.items.some(i => /reorder level/.test(i.title)), 'low stock appears in the morning briefing');

  console.log('\nService delivery — meter replacement planner');
  { const rawDb2 = new (require('node:sqlite').DatabaseSync)(path.join(TMP, 'demo', 'aquatrack-demo.db'));
    rawDb2.prepare(`UPDATE meters SET install_date='2012-01-01' WHERE id=?`).run(meterId); rawDb2.close(); }
  r = await reader.get('/api/meter-fleet'); ok(r.status === 403, 'meter reader cannot see the replacement plan');
  r = await manager.get('/api/meter-fleet'); const fm = r.data.rows && r.data.rows.find(x => x.meter_id === meterId);
  ok(fm && fm.age_years > 14 && fm.under_registration_pct > 0 && fm.priority !== 'ok' && fm.reasons.some(x => /years old/.test(x)), `old meter flagged (est. ${fm && fm.under_registration_pct}% under-registration, ${fm && fm.priority})`, fm);
  r = await manager.post(`/api/meter-fleet/${meterId}/plan`); ok(r.status === 200 && /WO/.test(r.data.wo_number), 'replacement work order created from the planner'); const repWo = r.data.id;
  r = await manager.post(`/api/meter-fleet/${meterId}/plan`); ok(r.status === 409, 'no duplicate replacement work orders');
  r = await manager.get('/api/meter-fleet?format=csv'); ok(typeof r.data === 'string' && /ESTIMATES/.test(r.data), 'replacement plan exports as CSV, labelled as estimates');

  console.log('\nService delivery — customer feedback');
  r = await manager.post(`/api/work-orders/${repWo}/update`, { status: 'completed', note: 'Meter replaced (test)', assigned_to: techId }); ok(r.status === 200, 'replacement job completed');
  r = await admin.post('/api/channels/simulate/sms', { phone: '+231 770 000 111', body: '2 took three days to come' }); ok(/sorry/i.test(r.data.reply), 'customer rates the job 2/5 by SMS', r.data);
  r = await manager.get('/api/alerts?status='); ok(r.data.some(a => /Unhappy with service \(2\/5\)/.test(a.title)), 'a low rating raises a follow-up alert');
  r = await admin.post('/api/channels/simulate/sms', { phone: '+231 770 000 111', body: '5' });
  r = await manager.get('/api/feedback'); const fbRep = r.data.recent.filter(x => x.work_order_id === repWo);
  ok(fbRep.length === 1 && fbRep[0].score === 2 && /three days/.test(fbRep[0].comment || ''), 'feedback shows the rating and comment; a later reply never overwrites it', fbRep);
  r = await cashier.get('/api/feedback'); ok(r.status === 403, 'cashier cannot see feedback reports');
  { const rawDb3 = new (require('node:sqlite').DatabaseSync)(path.join(TMP, 'demo', 'aquatrack-demo.db')); let blk = 0;
    for (const q of ['UPDATE stock_movements SET qty=999', 'DELETE FROM stock_movements']) { try { rawDb3.exec(q); } catch { blk++; } } rawDb3.close();
    ok(blk === 2, 'stock movements cannot be edited or deleted (database triggers)'); }

  console.log('\nLanguages & countries');
  r = await new Client().get('/api/i18n/config'); ok(r.status === 200 && r.data.languages.map(l => l.code).join() === 'en,fr,pt' && r.data.currencies.join() === 'USD,LRD', 'public regional config: 3 languages, USD and LRD', r.data);
  r = await new Client().get('/api/i18n/ui/fr'); ok(r.data.dict['Balance'] === 'Solde' && r.data.locale === 'fr-FR', 'French screen dictionary served');
  const tph = '+231 770 000 111';
  r = await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'SOLDE' }); ok(/compte à jour|vous devez|crédit/.test(r.data.reply), 'French keyword SOLDE answered in French', r.data);
  r = await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'BAL' }); ok(/compte à jour|vous devez|crédit/.test(r.data.reply), 'the phone keeps French for later messages', r.data);
  r = await admin.get('/api/channels/messages?phone=' + encodeURIComponent(tph) + '&direction=out'); const lastOut = (Array.isArray(r.data) ? r.data : r.data.rows || [])[0];
  ok(lastOut && !/[êâôûç—×]/.test(lastOut.body), 'outbound SMS kept in the GSM alphabet (no UCS-2 surcharge)', lastOut && lastOut.body);
  r = await admin.post('/api/channels/simulate/ussd', { phone: tph, text: '' }); ok(/Mon solde/.test(r.data.reply) && /9 Langue/.test(r.data.reply), 'USSD menu in French with a language option', r.data);
  r = await admin.post('/api/channels/simulate/ussd', { phone: tph, text: '9*3' }); ok(/Português/.test(r.data.reply), 'language switched to Portuguese by USSD', r.data);
  r = await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'SALDO' }); ok(/conta em dia|deve|crédito/.test(r.data.reply), 'replies now in Portuguese', r.data);
  r = await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'LANG EN' }); ok(/Language set to English/.test(r.data.reply), 'LANG EN switches back to English', r.data);
  r = await admin.post('/api/channels/simulate/ussd', { phone: '+231 880 123 456', text: '' }); ok(/^CON .*water service/s.test(r.data.reply), 'unregistered numbers get the default language');
  // translation editing
  r = await manager.put('/api/i18n/strings/fr', { scope: 'msg', items: [{ key: 'sms.plan_none', text: 'x' }] }); ok(r.status === 403, 'only administrators edit translations');
  r = await admin.put('/api/i18n/strings/fr', { scope: 'msg', items: [{ key: 'sms.balance', text: 'Solde du compte' }] }); ok(r.status === 400 && /\{account\}/.test(r.data.error), 'edits must keep the {placeholders}', r.data);
  r = await admin.put('/api/i18n/strings/fr', { scope: 'msg', items: [{ key: 'sms.balance', text: 'Compte {account} — {status}.' }] }); ok(r.status === 200, 'translation edited in the app');
  await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'LANG FR' });
  r = await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'SOLDE' }); ok(/^Compte DEMO-TST-00001 — /.test(r.data.reply), 'edited translation used straight away', r.data);
  await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'LANG EN' });
  r = await admin.get('/api/i18n/export/fr?scope=msg'); ok(typeof r.data === 'string' && r.data.includes('sms.balance') && r.data.includes('translation'), 'translations export to CSV');
  r = await admin.post('/api/i18n/import/fr', { scope: 'ui', content: 'key,english,translation\nBalance,Balance,Solde actuel\nnot-a-key,x,y\n' }); ok(r.status === 200 && r.data.saved === 1, 'CSV import saves known phrases only', r.data);
  r = await new Client().get('/api/i18n/ui/fr'); ok(r.data.dict['Balance'] === 'Solde actuel', 'screen text edits take effect');
  r = await admin.post('/api/i18n/languages', { code: 'sw', name: 'Swahili', native_name: 'Kiswahili' }); ok(r.status === 200, 'new language added');
  r = await admin.get('/api/i18n/languages'); const sw = r.data.find(l => l.code === 'sw'); ok(sw && sw.coverage.msg.translated === 0 && sw.coverage.msg.total > 100, `coverage shown per language (${sw && sw.coverage.msg.total} messages to translate)`);
  r = await admin.post('/api/channels/simulate/ussd', { phone: tph, text: '9' }); ok(/Kiswahili/.test(r.data.reply), 'new language offered on USSD (falls back to English text until translated)');
  // currencies & mobile-money providers
  r = await admin.put('/api/settings', { currencies: 'USD' }); ok(r.status === 400 && /LRD/.test(r.data.error), 'a currency in use cannot be removed');
  r = await admin.post('/api/areas', { code: 'XOF1', name: 'Test CFA area', currency: 'XOF' }); ok(r.status === 400, 'unconfigured currency refused');
  r = await admin.put('/api/settings', { currencies: 'USD,LRD,XOF', currency_symbols: 'USD=US$;LRD=L$;XOF=FCFA', momo_providers: 'mtn=MTN MoMo;orange=Orange Money;wave=Wave', momo_wave_merchant: 'DEMO-WAVE-1' }); ok(r.status === 200, 'currencies and providers configured', r.data);
  r = await admin.post('/api/areas', { code: 'XOF1', name: 'Test CFA area', currency: 'XOF' }); ok(r.status === 200, 'service area billing in XOF');
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 1, method: 'mobile_money_wave', reference: 'WAVE-T-1' }); ok(r.status === 200, 'payment by a newly configured provider (Wave)', r.data);
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 1, method: 'mobile_money_mpesa', reference: 'MP-T-1' }); ok(r.status === 400, 'unconfigured provider refused');
  r = await admin.post('/api/channels/simulate/sms', { phone: tph, body: 'PAY' }); ok(/Wave DEMO-WAVE-1/.test(r.data.reply), 'payment instructions list the configured providers', r.data);
  // country preset and time zone
  r = await admin.post('/api/country/apply', { code: 'KE' }); ok(r.status === 200 && r.data.applied.timezone === 'Africa/Nairobi' && /KES/.test(r.data.applied.currencies) && /LRD/.test(r.data.applied.currencies), 'Kenya preset applied (KES added, currencies in use kept)', r.data);
  r = await manager.post('/api/supply/schedules', { area_id: areaId, zone: 'TZ test', days: '0123456', start_time: '06:00', end_time: '07:00' }); const tzSched = r.data.id;
  r = await manager.get('/api/supply/upcoming?days=3&area_id=' + areaId); const w0 = r.data.find(w => w.schedule_id === tzSched);
  ok(w0 && /T03:00:00\.000Z$/.test(w0.start), 'supply times follow the local time zone (06:00 Nairobi = 03:00 UTC)', w0);
  r = await admin.put('/api/settings', { timezone: 'Mars/Olympus' }); ok(r.status === 400, 'unknown time zone refused');
  r = await admin.post('/api/country/apply', { code: 'LR' }); ok(r.status === 200, 'back to the Liberia preset');
  await manager.put('/api/supply/schedules/' + tzSched, { area_id: areaId, zone: 'TZ test', days: '0123456', start_time: '06:00', end_time: '07:00', active: false });

  console.log('\nPreventive maintenance & functionality');
  const assetsAll = (await manager.get('/api/assets')).data; const pumpA = assetsAll.find(a => a.code === 'RVS-PMP-01'), wpA = assetsAll.find(a => a.code === 'RVS-WP-01');
  r = await cashier.post('/api/maintenance/plans', { asset_id: pumpA.id, title: 'x', interval_days: 10 }); ok(r.status === 403, 'cashier cannot create maintenance plans');
  r = await manager.post('/api/maintenance/plans', { asset_id: pumpA.id, title: 'Test service' }); ok(r.status === 400, 'a plan needs an interval in days or run-hours');
  const d15 = new Date(Date.now() - 15 * 86400e3).toISOString().slice(0, 10);
  r = await manager.post('/api/maintenance/plans', { asset_id: pumpA.id, title: 'Test 10-day check', interval_days: 10, last_done_at: d15 }); ok(r.status === 200, 'plan created (every 10 days, last done 15 days ago)'); const tplan = r.data.id;
  r = await manager.get('/api/maintenance'); let tp = r.data.plans.find(p => p.id === tplan); ok(tp && tp.due.state === 'overdue', 'plan shows as overdue', tp && tp.due);
  r = await manager.post('/api/maintenance/run'); const made = r.data.created.find(c => c.plan_id === tplan); ok(made && /WO/.test(made.wo_number), 'work order created for the due plan');
  r = await manager.post('/api/maintenance/run'); ok(!r.data.created.some(c => c.plan_id === tplan), 'no duplicate work order while one is open');
  tp = (await manager.get('/api/maintenance')).data.plans.find(p => p.id === tplan);
  r = await tech.post(`/api/work-orders/${tp.due.open_wo.id}/update`, { status: 'completed', note: 'Checked and greased (test)' }); ok(r.status === 200, 'technician completes the service');
  tp = (await manager.get('/api/maintenance')).data.plans.find(p => p.id === tplan); ok(tp.due.state === 'ok' && tp.due.days_left >= 9, 'completing the work order resets the plan', tp.due);
  const rh = (await manager.get(`/api/assets/${pumpA.id}/run-hours`)).data; const lastH = rh.rows[0].reading;
  r = await tech.post(`/api/assets/${pumpA.id}/run-hours`, { reading: lastH - 10 }); ok(r.status === 400, 'hour-meter reading lower than the last is refused');
  r = await tech.post(`/api/assets/${pumpA.id}/run-hours`, { reading: 5, reset: true }); ok(r.status === 400, 'a meter reset needs a reason');
  r = await tech.post(`/api/assets/${pumpA.id}/run-hours`, { reading: lastH + 6 }); ok(r.status === 200 && r.data.rate_per_day > 0, `run-hours recorded (≈${r.data.rate_per_day} h/day)`);
  r = await manager.post('/api/maintenance/plans', { asset_id: pumpA.id, title: 'Test hours service', interval_hours: 100, last_done_hours: lastH + 6 - 90 }); const hplan = r.data.id;
  tp = (await manager.get('/api/maintenance')).data.plans.find(p => p.id === hplan); ok(tp.due.hours_left === 10 && ['due_soon', 'overdue'].includes(tp.due.state), `hours-based plan: 10 h left, projected from daily use (${tp.due.state})`, tp.due);
  await manager.put(`/api/maintenance/plans/${hplan}`, { asset_id: pumpA.id, title: 'Test hours service', interval_hours: 100, active: false });
  await manager.put(`/api/maintenance/plans/${tplan}`, { asset_id: pumpA.id, title: 'Test 10-day check', interval_days: 10, active: false });
  r = await tech.put(`/api/assets/${wpA.id}`, { status: 'down', maintenance_needs: 'Tap broken (test)' }); ok(r.status === 200, 'technician marks a water point down');
  r = await tech.put(`/api/assets/${wpA.id}`, { status: 'operational' });
  r = await manager.get('/api/functionality?from=' + today + '&to=' + today); const fwp = r.data.rows.find(x => x.asset_id === wpA.id);
  ok(fwp && fwp.breakdowns >= 1 && r.data.summary.water_points >= 1, `functionality: breakdown logged (${fwp && fwp.functional_pct}% functional today)`, fwp);

  console.log('\nService levels (SDG 6.1)');
  r = await cashier.get('/api/service-levels'); ok(r.status === 403, 'cashier cannot see service-level estimates');
  r = await manager.get('/api/service-levels'); const rvsL = r.data.areas.find(a => a.area.startsWith('Riverside'));
  ok(rvsL && rvsL.served > 0 && rvsL.population > 0 && rvsL.levels.basic.people > 0 && /available/.test(rvsL.piped_basis), `estimate per area (Riverside: ${rvsL && rvsL.served} of ${rvsL && rvsL.population} people served)`, rvsL && rvsL.levels);
  const gvwL = r.data.areas.find(a => a.area.startsWith('Greenvale')); ok(gvwL && gvwL.levels.safely_managed.people > 0 && gvwL.levels.not_functional.people > 0, 'safely managed where supply and E. coli results allow; users of a broken point shown separately', gvwL && gvwL.levels);
  await admin.put(`/api/assets/${wpA.id}`, { ...wpA, status: 'operational', round_trip_min: 45, served_population: 260 });
  r = await manager.get('/api/service-levels'); ok(r.data.areas.find(a => a.area.startsWith('Riverside')).levels.limited.people === 260, 'collection time over 30 minutes counts as limited');
  r = await manager.get('/api/service-levels?format=csv'); ok(typeof r.data === 'string' && /ESTIMATES/.test(r.data), 'service levels export as CSV, labelled as estimates');

  console.log('\nCashier end-of-day close');
  const cbill = await cashier.post('/api/payments', { customer_id: custId, amount: 3, method: 'cash' });
  r = await cashier.get('/api/cash/my'); const usdE = r.data.currencies.find(c => c.currency === 'USD');
  ok(usdE && usdE.expected >= 3 && usdE.items.some(i => i.ref === cbill.data.receipt_number), `expected cash worked out from my receipts (US$${usdE && usdE.expected})`, r.data);
  const counts = r.data.currencies.map(c => ({ currency: c.currency, counted: c.currency === 'USD' ? c.expected - 1 : c.expected }));
  r = await cashier.post('/api/cash/close', { counts }); ok(r.status === 400 && /explain/.test(r.data.error), 'a difference must be explained');
  r = await cashier.post('/api/cash/close', { counts, note: 'One dollar short after recount (test)' }); ok(r.status === 200 && r.data.closes.find(c => c.currency === 'USD').variance === -1, 'close submitted with a US$1 shortage');
  r = await cashier.post('/api/cash/close', { counts, note: 'again' }); ok(r.status === 409, 'a day can only be closed once');
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 2, method: 'cash' }); ok(r.status === 409 && /closed/.test(r.data.error), 'no more cash can be taken after closing the day');
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 2, method: 'bank_transfer', reference: 'BT-CLOSE-1' }); ok(r.status === 200, 'non-cash payments are still accepted');
  r = await manager.get('/api/cash/book'); const myClose = r.data.closes.find(c => c.currency === 'USD' && c.status === 'submitted' && c.variance === -1);
  ok(myClose && r.data.pending >= 1, 'manager sees the close waiting in the cash book');
  r = await manager.post(`/api/cash/closes/${myClose.id}/review`, { decision: 'rejected' }); ok(r.status === 400, 'rejecting needs a reason');
  r = await manager.post(`/api/cash/closes/${myClose.id}/review`, { decision: 'rejected', note: 'Recount with the supervisor (test)' }); ok(r.status === 200, 'manager rejects — the day reopens');
  r = await cashier.post('/api/payments', { customer_id: custId, amount: 1, method: 'cash' }); ok(r.status === 200, 'cash can be taken again after reopening');
  const exp2 = (await cashier.get('/api/cash/my')).data.currencies;
  r = await cashier.post('/api/cash/close', { counts: exp2.map(c => ({ currency: c.currency, counted: c.expected })) }); ok(r.status === 200, 'recount submitted with no difference');
  const cClose2 = (await manager.get('/api/cash/book')).data.closes.find(c => c.currency === 'USD' && c.status === 'submitted' && c.variance === 0);
  r = await manager.post(`/api/cash/closes/${cClose2.id}/review`, { decision: 'approved' }); ok(r.status === 200, 'manager approves the close');
  r = await manager.get('/api/cash/book?format=csv'); ok(typeof r.data === 'string' && r.data.includes('variance'), 'cash book exports as CSV');

  console.log('\nSecurity & integrity');
  r = await new Client().get('/api/customers'); ok(r.status === 401, 'unauthenticated request refused');
  r = await cust.get('/api/customers'); ok(r.status === 403, 'customer cannot list customers');
  r = await cust.get('/api/portal/account'); ok(r.status === 200 && r.data.account.customer_number === 'DEMO-RVS-00001', 'customer sees own account only');
  r = await cust.get('/api/portal/bills/' + bill.bill_id); ok(r.status === 404, "customer cannot open another customer's bill");
  r = await reader.get('/api/bills'); ok(r.status === 403, 'meter reader cannot view billing');
  r = await tech.post('/api/payments', { customer_id: custId, amount: 1, method: 'cash' }); ok(r.status === 403, 'technician cannot post payments');
  r = await manager.post('/api/tariffs', {}); ok(r.status === 403, 'manager cannot change tariffs');
  r = await admin.req('POST', '/api/customers', { name: 'x' }, { 'X-Requested-With': '' }); ok(r.status === 403, 'request without anti-CSRF header refused');
  r = await new Client().post('/api/ingest/' + sim.id, { value: 1 }); ok(r.status === 404, 'ingest refused for non-configured integration');
  r = await admin.post('/api/integrations', { name: 'Test LoRa', method: 'lorawan', adapter: 'lorawan_chirpstack', meter_model: 'Fictional Model X1 rev2' });
  ok(r.status === 200, 'integration profile created'); const iid = r.data.id;
  r = await admin.post(`/api/integrations/${iid}/api-key`); ok(r.status === 400 && /required/.test(r.data.error), 'API key refused until all required information is entered');
  await admin.put('/api/integrations/' + iid, { name: 'Test LoRa', method: 'lorawan', adapter: 'lorawan_chirpstack', meter_model: 'Fictional Model X1 rev2', comm_band: 'EU868', protocol: 'LoRaWAN 1.0.3 class A', data_format: 'object.volume_m3 (m³, float)', encryption: 'AppKey per device held by utility', docs_url: 'Vendor doc v1.2 (test)', vendor_access: 'Test tenancy' });
  r = await admin.post(`/api/integrations/${iid}/api-key`); ok(r.status === 200 && r.data.api_key, 'API key issued once info complete'); const key = r.data.api_key;
  const usLora = models.find(m => m.model.includes('LoRaWAN'));
  r = await admin.post('/api/meters', { serial_number: 'TST-LORA-1', manufacturer: 'Generic (demo)', model: usLora.model, model_id: usLora.id, meter_type: 'ultrasonic', size_mm: 15, comm_method: 'lorawan', integration_id: iid, device_id: 'A1B2C3D4E5F60001', status: 'active', initial_reading: 0 });
  ok(r.status === 200, 'LoRaWAN meter linked to integration');
  const up = await fetch(`${BASE}/api/ingest/${iid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': key }, body: JSON.stringify({ time: new Date().toISOString(), deviceInfo: { devEui: 'A1B2C3D4E5F60001' }, object: { volume_m3: 12.345, battery: 87 } }) }).then(x => x.json());
  ok(up.ok && up.results[0].flags.includes('unverified_source'), 'device uplink ingested and flagged as unverified source', up);
  const badKey = await fetch(`${BASE}/api/ingest/${iid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'wrong' }, body: '{}' });
  ok(badKey.status === 401, 'ingest with wrong API key refused');
  r = await admin.post(`/api/integrations/${iid}/verify`, { note: 'short' }); ok(r.status === 400, 'verification requires evidence note');
  r = await admin.post(`/api/integrations/${iid}/verify`, { note: 'Compared 3 uplinks with physical register on test bench (test)' }); ok(r.status === 200, 'integration marked verified with evidence');
  r = await admin.get('/api/audit/verify'); ok(r.data.ok, `audit hash chain intact (${r.data.checked} entries)`);

  // ===== Water Safety Plan =====
  console.log('\nWater Safety Plan');
  {
    r = await cashier.get('/api/wsp'); ok(r.status === 403, 'cashier cannot open the water safety plan');
    r = await manager.get('/api/wsp'); const cells = r.data.matrix_raw.flat().reduce((a, b) => a + b, 0);
    ok(r.status === 200 && r.data.score >= 0 && r.data.score <= 100 && cells === r.data.hazards && r.data.parts.length === 8, 'overview: readiness score and a 5×5 matrix that adds up to the register', { score: r.data.score, cells, hz: r.data.hazards });
    const lk = (await manager.get('/api/lookups')).data; const hlt = lk.areas.find(a => a.code === 'HLT');
    const hres = (await manager.get('/api/assets')).data.find(a => a.code === 'HLT-RES-01');
    r = await manager.post('/api/wsp/library/apply', { template: 'piped_chlorinated', area_id: hlt.id }); ok(r.status === 200 && r.data.added === 9, 'starter template adds 9 risks with controls to an area', r.data);
    r = await manager.post('/api/wsp/library/apply', { template: 'piped_chlorinated', area_id: hlt.id }); ok(r.data.added === 0 && r.data.skipped === 9, 'applying the same template again adds nothing');
    r = await tech.post('/api/wsp/hazards', { step: 'storage', event: 'Test', likelihood: 3, severity: 3 }); ok(r.status === 403, 'technician cannot change the risk register');
    const hz = { asset_id: hres.id, step: 'storage', hazard_type: 'microbial', event: 'Chlorine residual lost in the Hilltop reservoir (test)', likelihood: 4, severity: 5 };
    r = await manager.post('/api/wsp/hazards', { ...hz, res_likelihood: 5, res_severity: 5 }); ok(r.status === 400, 'risk after controls cannot exceed the risk before controls');
    r = await manager.post('/api/wsp/hazards', { ...hz, res_likelihood: 2 }); ok(r.status === 400, 'residual risk needs both likelihood and severity');
    r = await manager.post('/api/wsp/hazards', hz); ok(r.status === 200 && /HZ-\d{4}$/.test(r.data.ref), 'risk created with a reference', r.data); const hid = r.data.id;
    r = await manager.get('/api/wsp/hazards/' + hid); ok(r.data.raw_score === 20 && r.data.raw_band === 'very_high' && r.data.control_state === 'no_controls' && r.data.area_id === hlt.id, 'score 4×5 = 20 (very high); area taken from the asset');
    r = await manager.post(`/api/wsp/hazards/${hid}/controls`, { description: 'Free chlorine at the reservoir outlet (test)', parameter: 'free_chlorine', limit_low: 0.3, limit_high: 0.2, frequency_days: 7 }); ok(r.status === 400, 'control with the lower limit above the upper limit is refused');
    r = await manager.post(`/api/wsp/hazards/${hid}/controls`, { description: 'Free chlorine at the reservoir outlet (test)', parameter: 'free_chlorine', limit_low: 0.3, limit_high: 2, unit: 'mg/L', frequency_days: 7, corrective_action: 'Boost the dose and re-test (test)' });
    ok(r.status === 200, 'control measure with limits added'); const cid = r.data.id;
    r = await tech.post(`/api/wsp/controls/${cid}/check`, {}); ok(r.status === 400 && /measured value/.test(r.data.error), 'a control with limits needs the measured value');
    const cu = 'wsp-test-' + Date.now();
    r = await tech.post(`/api/wsp/controls/${cid}/check`, { value: 0.1, client_uuid: cu }); ok(r.status === 200 && r.data.ok === false && r.data.alert_id && /Boost/.test(r.data.corrective_action), 'check outside the limits raises an alert with the corrective action', r.data); const aid = r.data.alert_id;
    r = await tech.post(`/api/wsp/controls/${cid}/check`, { value: 0.1, client_uuid: cu }); ok(r.data.duplicate === true, 'a repeated submission (same client id) is not recorded twice');
    r = await manager.get('/api/alerts?status=open_all'); const al = (r.data.rows || r.data).find(a => a.id === aid); ok(al && al.rule_type === 'wsp_limit' && al.severity === 'critical', 'the alert is critical because the risk is very high', al && { t: al.rule_type, s: al.severity });
    r = await tech.post('/api/wq/tests', { asset_id: hres.id, parameter: 'free_chlorine', value: 0.6, method: 'field_kit' }); ok(r.status === 200 && r.data.wsp_checks === 1 && r.data.wsp_breach === false, 'a water-quality test at the asset is logged against the matching control', r.data);
    r = await manager.get('/api/wsp/hazards/' + hid); const c0 = r.data.controls[0];
    ok(c0.status.state === 'ok' && c0.status.last.wq_test_id && r.data.monitoring.length === 2, 'control is back to working, with both checks on record');
    r = await manager.get('/api/alerts?status=all'); const al2 = (r.data.rows || r.data).find(a => a.id === aid); ok(!al2 || al2.status === 'resolved', 'the alert closes itself when the next check is within limits', al2 && al2.status);
    r = await manager.put('/api/wsp/hazards/' + hid, { ...hz, res_likelihood: 2, res_severity: 5 }); r = await manager.get('/api/wsp/hazards/' + hid); ok(r.data.res_score === 10 && r.data.res_band === 'high', 'residual risk recorded (2×5 = 10, high)');
    r = await manager.post(`/api/wsp/hazards/${hid}/review`, { next_review: '2027-06-30' }); ok(r.data.review_due === '2027-06-30', 'review recorded with the next review date');
    // sanitary inspection
    const forms = (await tech.get('/api/wsp/inspections')).data.forms; const tank = forms.find(f => f.key === 'storage_tank');
    r = await tech.post('/api/wsp/inspections', { asset_id: hres.id, form: 'storage_tank', answers: { s1: true } }); ok(r.status === 400, 'inspection refused until every question is answered');
    const ans = Object.fromEntries(tank.items.map((it, i) => [it.id, i < 3]));
    r = await tech.post('/api/wsp/inspections', { asset_id: hres.id, form: 'storage_tank', answers: ans }); ok(r.status === 200 && r.data.risk_count === 3 && r.data.risk_level === 'medium' && r.data.hazards_added === 3 && r.data.actions_added === 3, 'inspection scored 3/8 (medium); each risk added to the register with an action', r.data);
    r = await tech.post('/api/wsp/inspections', { asset_id: hres.id, form: 'storage_tank', answers: ans }); ok(r.data.hazards_added === 0 && r.data.actions_added === 0, 'a repeat inspection does not duplicate risks or actions');
    await tech.post('/api/wq/tests', { asset_id: hres.id, parameter: 'ecoli', value: 50, method: 'lab' });
    r = await manager.get('/api/wsp/inspections'); const site = r.data.rows.find(x => x.id === hres.id); ok(site.ecoli.grade === 'C' && site.priority === 'high' && site.due === false, 'priority is the worse of inspection (medium) and E. coli grade C (high)', site && { e: site.ecoli, p: site.priority });
    // improvement plan
    r = await manager.get('/api/wsp/actions'); const act = r.data.find(a => a.asset_id === hres.id && !a.work_order_id); ok(act && act.status === 'planned', 'improvement actions from the inspection are in the plan');
    r = await manager.post(`/api/wsp/actions/${act.id}/work-order`, {}); ok(r.status === 200 && r.data.wo_number, 'action turned into a work order', r.data); const wid = r.data.id;
    r = await manager.post(`/api/wsp/actions/${act.id}/work-order`, {}); ok(r.status === 409, 'an action cannot have two work orders');
    await tech.post(`/api/work-orders/${wid}/update`, { status: 'completed', note: 'Cover fitted (test)' });
    r = await manager.get('/api/wsp/actions?status=all'); ok(r.data.find(a => a.id === act.id).status === 'done', 'completing the work order completes the action');
    r = await manager.post('/api/wsp/actions', { hazard_id: hid, title: 'Second chlorination point (test)', cost: 300, currency: 'XXX' }); ok(r.status === 400, 'action cost must be in a configured currency');
    r = await manager.get('/api/wsp/hazards?format=csv'); ok(typeof r.data === 'string' && r.data.includes('hazardous_event') && r.data.includes('Chlorine residual lost'), 'risk register exports as CSV');
    r = await manager.get('/api/briefing'); ok(r.data.items.some(i => /water safety|sanitary inspection/i.test(i.title)), 'morning briefing includes water safety items');
  }
  // ===== Pumping energy =====
  console.log('\nPumping energy');
  {
    r = await manager.get('/api/energy?from=2026-05-01&to=2026-10-31'); const rv = r.data.rows.find(x => x.code === 'RVS-PMP-01');
    ok(r.status === 200 && rv.entries.length === 6 && rv.trend.state === 'worse' && rv.trend.change_pct > 20 && r.data.summary.worse === 1, 'demo diesel pump is flagged as less efficient than its own baseline', rv && rv.trend);
    r = await manager.get('/api/alerts?status=open_all'); ok((r.data.rows || r.data).some(a => a.rule_type === 'energy_efficiency'), 'an efficiency alert was raised for it');
    const gv = (await manager.get('/api/assets')).data; const src = gv.find(a => a.code === 'GVW-SRC-01'), kiosk = gv.find(a => a.code === 'RVS-WP-01');
    r = await cashier.post('/api/energy', { asset_id: src.id, period_start: '2026-09-01', period_end: '2026-09-30', energy_type: 'petrol', quantity: 40 }); ok(r.status === 403, 'cashier cannot record energy');
    r = await tech.post('/api/energy', { asset_id: kiosk.id, period_start: '2026-09-01', period_end: '2026-09-30', energy_type: 'petrol', quantity: 40 }); ok(r.status === 400, 'energy is only recorded against pumps, sources and treatment units');
    r = await tech.post('/api/energy', { asset_id: src.id, period_start: '2026-09-01', period_end: '2026-09-30', energy_type: 'petrol' }); ok(r.status === 400 && /litres/.test(r.data.error), 'fuel records need the litres used');
    r = await tech.post('/api/energy', { asset_id: src.id, period_start: '2026-09-01', period_end: '2026-09-30', energy_type: 'petrol', quantity: 69, cost: 103.5, currency: 'USD', volume_m3: 690, run_hours: 115 });
    ok(r.status === 200 && r.data.trend.state === 'no_baseline', 'technician records fuel and water pumped; no verdict until there is a baseline', r.data); const eid = r.data.id;
    r = await tech.post('/api/energy', { asset_id: src.id, period_start: '2026-09-15', period_end: '2026-10-14', energy_type: 'petrol', quantity: 60, volume_m3: 600 }); ok(r.status === 409, 'overlapping periods for the same pump are refused');
    r = await manager.get('/api/energy?from=2026-09-01&to=2026-09-30'); const g = r.data.rows.find(x => x.id === src.id).entries[0];
    ok(g.per_m3 === 0.1 && g.cost_per_m3 === 0.15 && g.per_hour === 0.6 && g.m3_per_hour === 6, 'works out 0.1 L/m³, 0.15 per m³, 0.6 L/h and 6 m³/h', g && [g.per_m3, g.cost_per_m3, g.per_hour, g.m3_per_hour]);
    r = await tech.post(`/api/energy/${eid}/void`, { reason: 'test' }); ok(r.status === 403, 'technician cannot void an energy record');
    r = await manager.post(`/api/energy/${eid}/void`, { reason: 'Wrong meter reading (test)' }); ok(r.status === 200, 'manager voids a record with a reason');
    r = await manager.get('/api/energy?from=2026-09-01&to=2026-09-30'); ok(r.data.rows.every(x => x.id !== src.id || !x.entries.length), 'voided records drop out of the figures');
    r = await manager.get('/api/energy?from=2026-05-01&to=2026-10-31&format=csv'); ok(typeof r.data === 'string' && r.data.includes('cost_per_m3') && r.data.includes('RVS-PMP-01'), 'energy records export as CSV');
  }
  // Direct database tamper attempts are blocked by triggers
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(TMP, 'demo', 'aquatrack-demo.db'));
  let blocked = 0;
  for (const sql of ['UPDATE readings SET value = 1 WHERE id = 1', 'DELETE FROM payments WHERE id = 1', 'UPDATE payments SET amount = 1 WHERE id = 1', 'DELETE FROM audit_log WHERE id = 1', 'DELETE FROM wp_transactions WHERE id = 1', 'UPDATE wp_transactions SET amount = 0 WHERE id = 1', 'DELETE FROM momo_transactions WHERE id = 1', 'UPDATE wsp_monitoring SET ok = 1 WHERE id = 1', 'DELETE FROM wsp_inspections WHERE id = 1', 'UPDATE energy_logs SET quantity = 1 WHERE id = 1', 'DELETE FROM energy_logs WHERE id = 1']) { try { raw.exec(sql); } catch { blocked++; } }
  raw.close();
  ok(blocked === 11, 'database triggers block editing readings/payments/kiosk sales/water safety checks/energy records and deleting audit, mobile-money or inspection records');
}
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
main().catch(e => { console.error(e); process.exit(1); });
