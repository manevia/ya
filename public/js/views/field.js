// Mobile-first meter-reading workflow with offline drafts (IndexedDB) and later synchronisation.
import { api, html, raw, mount, $, $$, state, fmtM3, fmtDT, fmtNum, label, badge, toast, bind, flagBadges, esc } from '../core.js';
import { kvGet, kvSet, queueAll, queueDel, saveDraft, syncQueue } from '../offline.js';
import { ocrPanel, prepareOffline } from '../ocr.js';
import { planRoute, myPosition, osmDirections } from '../route.js';

let routeList = [];
async function loadRoute() {
  try { routeList = await api('/api/field/route'); await kvSet('route:' + state.user.id, { at: new Date().toISOString(), rows: routeList }); return { live: true }; }
  catch (e) { const c = await kvGet('route:' + state.user.id); routeList = c ? c.rows : []; return { live: false, at: c && c.at }; }
}

export async function view(root, _p, q) {
  const src = await loadRoute();
  if (q.meter) return entry(root, Number(q.meter));
  const queue = await queueAll(state.user.id);
  const unsynced = queue.filter(i => i.sync !== 'synced');
  const readIds = new Set(queue.map(i => i.meter_id));
  const todo = routeList.filter(r => !r.read_this_cycle && !readIds.has(r.meter_id)).length;
  mount(root, html`<div class="page-head"><div><h1>Field meter reading</h1><small>${state.user.area_id ? 'Your assigned area' : 'All areas'} · ${routeList.length} meters · ${todo} still to read this cycle</small></div>
      <div class="actions"><button class="btn" data-act="ocrprep" title="Downloads the photo-reading engine (~10 MB) so it works without internet">📷 Prepare photo reading offline</button><button class="btn ${unsynced.length ? 'primary' : ''}" data-act="sync">⟳ Sync ${unsynced.length ? `(${unsynced.length})` : ''}</button></div></div>
    ${!src.live ? html`<div class="note warn">Offline — showing the route saved on this device${src.at ? ' at ' + fmtDT(src.at) : ''}. Readings you save are kept here until you sync.</div>` : ''}
    ${unsynced.length ? html`<div class="card"><h2>Waiting to sync (${unsynced.length})</h2>${unsynced.map(i => html`<div class="field-list"><div class="item" style="cursor:default"><div><div class="t1">${i.customer_name || 'Meter ' + i.serial_number} — ${fmtNum(i.value, 1)} m³</div>
      <div class="t2">${fmtDT(i.captured_at)} · ${i.photo ? '📷 ' : ''}${i.lat ? '📍 ' : ''}${i.sync === 'error' ? html`<span class="badge crit">Error: ${i.error}</span>` : html`<span class="badge warn">Saved on device</span>`}</div></div>
      <button class="btn sm danger" data-act="del" data-id="${i.client_uuid}">Discard</button></div></div>`)}</div>` : ''}
    <div class="card flush"><div style="padding:.8rem"><input id="fs" placeholder="Search name, customer no., meter serial, address…" style="width:100%;font-size:1rem" autocomplete="off">
      <label style="font-size:.85rem;display:flex;gap:.4rem;margin-top:.5rem;align-items:center"><input type="checkbox" id="todo" checked> Show only meters not yet read this cycle</label>
      <div style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem;flex-wrap:wrap"><button class="btn sm primary" data-act="plan">🧭 Plan my route</button><span id="routeinfo" class="muted" style="font-size:.85rem"></span></div></div>
      <div class="field-list" id="fl"></div></div>
    <div class="card"><h2>Synced from this device (last 7 days)</h2>${queue.filter(i => i.sync === 'synced').reverse().slice(0, 30).map(i => html`<div style="display:flex;justify-content:space-between;border-bottom:1px solid #eef0f3;padding:.4rem 0;font-size:.88rem"><span>${i.customer_name || i.serial_number} — ${fmtNum(i.value, 1)} m³ <small class="muted">${fmtDT(i.captured_at)}</small></span><span>${flagBadges(i.flags || [])}</span></div>`)}
      ${!queue.some(i => i.sync === 'synced') ? html`<div class="muted">Nothing yet.</div>` : ''}</div>`);
  const saved = await kvGet('routeplan:' + state.user.id);
  let order = saved && saved.date === new Date().toISOString().slice(0, 10) ? saved : null;
  const render = () => {
    const s = $('#fs', root).value.toLowerCase(); const onlyTodo = $('#todo', root).checked;
    const pos = order ? Object.fromEntries(order.ids.map((id, i) => [id, i + 1])) : {};
    if (order) $('#routeinfo', root).textContent = `Route planned: ${order.ids.length} stops, about ${order.km} km${order.naive_km > order.km ? ` (saves ${(order.naive_km - order.km).toFixed(1)} km vs list order)` : ''}${order.unlocated ? ` · ${order.unlocated} without GPS at the end` : ''}`;
    const rows = routeList.filter(r => (!onlyTodo || (!r.read_this_cycle && !readIds.has(r.meter_id))) && (!s || [r.name, r.customer_number, r.serial_number, r.address, r.landmark].join(' ').toLowerCase().includes(s))).sort((a, b) => (pos[a.meter_id] || 1e9) - (pos[b.meter_id] || 1e9)).slice(0, 150);
    $('#fl', root).innerHTML = rows.length ? rows.map(r => html`<div class="item" data-meter="${r.meter_id}"><div><div class="t1">${pos[r.meter_id] ? html`<span class="badge info" style="margin-right:.3rem">${pos[r.meter_id]}</span>` : ''}${r.name}</div><div class="t2">${r.address}${r.landmark ? ' · ' + r.landmark : ''}</div>
      <div class="t2"><span class="mono">${r.serial_number}</span> · ${r.customer_number}${r.comm_method !== 'manual' && r.comm_method !== 'csv' ? html` · <span class="badge info">${label(r.comm_method)}</span>` : ''}</div></div>
      <div style="text-align:right">${r.read_this_cycle || readIds.has(r.meter_id) ? html`<span class="badge good">✓ read</span>` : html`<span class="badge warn">to read</span>`}<div class="t2">Last ${r.last_value != null ? fmtNum(r.last_value, 1) : '—'}</div></div></div>`.s).join('') : '<div class="empty">No matching meters.</div>';
  };
  $('#fs', root).addEventListener('input', render); $('#todo', root).addEventListener('change', render); render();
  $('#fl', root).addEventListener('click', e => { const it = e.target.closest('[data-meter]'); if (it) location.hash = '#/field?meter=' + it.dataset.meter; });
  bind(root, {
    plan: async el => {
      el.disabled = true; $('#routeinfo', root).textContent = 'Getting your location…';
      const me = await myPosition(); let todoRows = routeList.filter(r => !r.read_this_cycle && !readIds.has(r.meter_id));
      if (!todoRows.length) { todoRows = routeList; $('#todo', root).checked = false; toast('Everything is read this cycle — planning the full route for the next cycle'); }
      const p = planRoute(me, todoRows);
      order = { date: new Date().toISOString().slice(0, 10), ids: p.order.map(r => r.meter_id), km: p.km, naive_km: p.naive_km, unlocated: p.unlocated, from_gps: !!me };
      await kvSet('routeplan:' + state.user.id, order); el.disabled = false; render();
      toast(me ? 'Route planned from your location' : 'Location unavailable — route planned from the first meter', me ? 'ok' : '');
      if (me && p.order[0] && p.order[0].lat != null) $('#routeinfo', root).insertAdjacentHTML('beforeend', html` · <a href="${osmDirections(me, p.order[0])}" target="_blank" rel="noopener">Directions to stop 1 ↗</a>`.s);
    },
    sync: async () => { if (!navigator.onLine) return toast('You are offline. Readings stay saved on this device.', 'err'); const r = await syncQueue(); toast(r.sent || r.failed ? `${r.sent || 0} synced${r.failed ? `, ${r.failed} need attention` : ''}` : 'Nothing to sync', r.failed ? 'err' : 'ok'); view(root, _p, q); },
    ocrprep: async el => { el.disabled = true; el.textContent = 'Preparing…'; try { await prepareOffline(m => { if (m.status) el.textContent = m.status; }); toast('Photo reading is ready and will work offline', 'ok'); el.textContent = '📷 Photo reading ready'; } catch (e) { toast(e.message, 'err'); el.disabled = false; } },
    del: async el => { if (confirm('Discard this unsynced reading from the device? It has NOT reached the server.')) { await queueDel(el.dataset.id); view(root, _p, q); } }
  });
  window.onqueuechanged && window.removeEventListener('queue-changed', window.onqueuechanged);
  window.onqueuechanged = () => { if (location.hash.startsWith('#/field') && !location.hash.includes('meter=')) view(root, _p, q); };
  window.addEventListener('queue-changed', window.onqueuechanged);
}

async function resizePhoto(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1024; const s = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
  return c.toDataURL('image/jpeg', 0.72);
}

function entry(root, meterId) {
  const r = routeList.find(x => x.meter_id === meterId);
  if (!r) { mount(root, html`<div class="card">Meter not in your route. <a href="#/field">Back</a></div>`); return; }
  const prev = r.last_value != null ? r.last_value : r.initial_reading;
  let photo = null, gps = null, ocr = null;
  mount(root, html`<div class="crumbs"><a href="#/field">← Route</a></div>
    <div class="card" style="max-width:680px"><h2 style="margin-bottom:.2rem">${r.name}</h2><div class="muted">${r.address}${r.landmark ? ' · ' + r.landmark : ''}</div>
      <dl class="kv" style="margin-top:.6rem"><dt>Customer no.</dt><dd class="mono">${r.customer_number}</dd><dt>Meter serial</dt><dd><b class="mono" style="font-size:1.1rem">${r.serial_number}</b></dd><dt>Meter</dt><dd>${r.manufacturer} ${r.model}, ${r.size_mm} mm ${badge(r.meter_status)}</dd></dl>
      <div class="prev-box"><div><small>Previous reading</small><b>${fmtNum(prev, 1)} m³</b><small>${r.last_at ? fmtDT(r.last_at) : 'initial reading'}</small></div><div><small>This reading uses</small><b id="use">—</b><small id="usehint"></small></div></div>
      <form id="rf">
        <label style="display:flex;gap:.5rem;align-items:center;margin:.5rem 0;font-weight:600"><input type="checkbox" name="serial_ok" required> I confirm the serial on the meter matches <span class="mono">${r.serial_number}</span></label>
        <label style="font-weight:600">Current register reading (m³)<input class="big-input" name="value" type="number" inputmode="decimal" step="0.001" min="0" required autocomplete="off"></label>
        <label style="display:flex;gap:.5rem;align-items:center;margin:.6rem 0"><input type="checkbox" name="is_estimated"> Meter not accessible — this is an <b>estimate</b> (will be flagged)</label>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0">
          <label class="btn">📷 Photo of register<input type="file" accept="image/*" capture="environment" name="photo" hidden></label>
          ${state.settings.gps_capture_enabled !== false ? html`<button class="btn" type="button" data-act="gps">📍 Capture GPS</button>` : html`<span class="muted">GPS capture disabled by administrator</span>`}
        </div>
        <div id="gpsinfo" class="muted" style="font-size:.85rem"></div><div id="ocrbox"></div><div id="ocrcheck" style="margin-top:.3rem"></div>
        <label style="display:block;margin-top:.6rem">Notes<textarea name="notes" placeholder="e.g. dog on premises, meter box flooded, seal broken" style="width:100%"></textarea></label>
        <div class="sticky-actions"><button class="btn primary lg block" type="submit">Save reading</button><small class="muted" style="display:block;text-align:center;margin-top:.3rem">Saved on this device first, then sent to the server automatically when online.</small></div>
      </form></div>`);
  const f = $('#rf', root);
  f.value.addEventListener('input', () => {
    const v = Number(f.value.value); if (f.value.value === '') { $('#use').textContent = '—'; $('#usehint').textContent = ''; return; }
    const use = Math.round((v - prev) * 1000) / 1000; $('#use').textContent = fmtM3(use);
    const days = r.last_at ? Math.max(1, (Date.now() - Date.parse(r.last_at)) / 86400e3) : 30;
    $('#usehint').innerHTML = use < 0 ? '<span class="badge crit">Lower than previous — check digits</span>' : use / days > ({ household: 3, business: 15, institution: 30 }[r.customer_type] || 50) ? '<span class="badge serious">Very high — please double-check</span>' : use === 0 ? '<span class="badge warn">No consumption</span>' : esc(`≈ ${fmtNum(use / days, 2)} m³/day`);
  });
  const checkOcr = () => { const box = $('#ocrcheck'); if (!ocr || f.value.value === '') { box.innerHTML = ''; return; } const typed = Math.floor(Number(f.value.value));
    box.innerHTML = typed === ocr.value ? '<span class="badge good">✓ Matches photo</span>' : `<span class="badge crit">Photo shows ${esc(ocr.value)} — please re-check the meter</span>`; };
  f.value.addEventListener('input', checkOcr);
  f.photo.addEventListener('change', async () => { if (!f.photo.files[0]) return; try { photo = await resizePhoto(f.photo.files[0]); ocr = null;
    ocrPanel($('#ocrbox'), photo, r => { if (!r.digits) return; ocr = { value: Number(r.digits), confidence: r.confidence }; if (f.value.value === '') { f.value.value = String(Number(r.digits)); f.value.dispatchEvent(new Event('input')); } checkOcr(); });
  } catch { toast('Could not read the photo', 'err'); } });
  bind(root, {
    gps: () => { if (!navigator.geolocation) return toast('GPS not available', 'err'); $('#gpsinfo').textContent = 'Getting location…';
      navigator.geolocation.getCurrentPosition(p => { gps = { lat: p.coords.latitude, lng: p.coords.longitude, gps_accuracy: Math.round(p.coords.accuracy) }; $('#gpsinfo').textContent = `📍 ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} (±${gps.gps_accuracy} m)`; },
        e => { $('#gpsinfo').textContent = 'GPS unavailable: ' + e.message; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }); }
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (!f.serial_ok.checked) return toast('Confirm the meter serial first', 'err');
    if (f.value.value === '' || Number(f.value.value) < 0) return toast('Enter the register reading', 'err');
    const v = Number(f.value.value);
    if (v < prev && !confirm(`The reading ${v} is LOWER than the previous ${prev}. Save anyway? It will be flagged for review.`)) return;
    if (state.settings.photo_required && !photo && !confirm('A photo is required by your utility. Save without photo? It will be flagged.')) return;
    if (ocr && Math.floor(v) !== ocr.value && !confirm(`The photo reads ${ocr.value} but you entered ${v}. Save anyway? It will be flagged for review.`)) return;
    const item = await saveDraft({ meter_id: r.meter_id, value: v, is_estimated: f.is_estimated.checked, notes: f.notes.value || null, photo, ...(gps || {}), ...(ocr && photo ? { ocr_value: ocr.value, ocr_confidence: ocr.confidence } : {}),
      customer_name: r.name, serial_number: r.serial_number, previous_value: prev });
    toast('Reading saved on device', 'ok');
    if (navigator.onLine) { const s = await syncQueue().catch(err => ({ error: err.message })); const after = (await queueAll(state.user.id)).find(x => x.client_uuid === item.client_uuid);
      if (after && after.sync === 'synced') toast('Sent to server' + (after.flags && after.flags.length ? ' — flagged: ' + after.flags.join(', ') : ''), 'ok'); else toast('Will retry sync later: ' + (after && after.error || s.error || 'offline'), 'err'); }
    location.hash = '#/field';
  });
}
