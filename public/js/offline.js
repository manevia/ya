// Offline storage for field work: IndexedDB keeps the route list, the signed-in profile and every
// unsynchronised reading (with photo) until the server confirms it. Nothing is lost if the browser closes or power fails.
import { api, state, uuid } from './core.js';

const DB = 'aquatrack-field'; const V = 2;
let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB + '-' + (state.mode || 'demo'), V);
    r.onupgradeneeded = e => { const d = r.result; if (e.oldVersion < 1) { d.createObjectStore('kv'); d.createObjectStore('queue', { keyPath: 'client_uuid' }); } if (e.oldVersion < 2) d.createObjectStore('wpqueue', { keyPath: 'client_uuid' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); });
}
export const kvGet = k => tx('kv', 'readonly', s => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
export async function queueAll(userId) { const all = await tx('queue', 'readonly', s => s.getAll()); return (all || []).filter(i => !userId || i.user_id === userId).sort((a, b) => a.saved_at.localeCompare(b.saved_at)); }
export const queuePut = item => tx('queue', 'readwrite', s => s.put(item));
export const queueDel = id => tx('queue', 'readwrite', s => s.delete(id));

export async function saveDraft(reading) {
  const item = { ...reading, client_uuid: reading.client_uuid || uuid(), user_id: state.user.id, saved_at: new Date().toISOString(), captured_at: reading.captured_at || new Date().toISOString(), sync: 'queued' };
  await queuePut(item);
  return item;
}

let syncing = false;
/** Push queued readings to the server. Safe to repeat: the server de-duplicates on client_uuid. */
export async function syncQueue() {
  if (syncing || !navigator.onLine) return { skipped: true };
  syncing = true;
  try {
    const items = (await queueAll(state.user.id)).filter(i => i.sync !== 'synced');
    if (!items.length) return { sent: 0 };
    let ok = 0, failed = 0;
    for (let i = 0; i < items.length; i += 10) {
      const batch = items.slice(i, i + 10);
      const res = await api('/api/readings/sync', { body: { items: batch.map(({ user_id, saved_at, sync, error, customer_name, serial_number, previous_value, ...rest }) => rest) } });
      for (const r of res.results) {
        const it = batch.find(b => b.client_uuid === r.client_uuid); if (!it) continue;
        if (r.ok) { ok++; await queuePut({ ...it, sync: 'synced', server_id: r.id, flags: r.flags, photo: it.photo ? '(uploaded)' : null, error: null, synced_at: new Date().toISOString() }); }
        else { failed++; await queuePut({ ...it, sync: 'error', error: r.error }); }
      }
    }
    // keep synced items for 7 days as a local receipt, then tidy up
    for (const it of await queueAll(state.user.id)) if (it.sync === 'synced' && Date.now() - Date.parse(it.synced_at || it.saved_at) > 7 * 86400e3) await queueDel(it.client_uuid);
    return { sent: ok, failed };
  } finally { syncing = false; }
}
export async function pendingCount() { if (!state.user) return 0; return (await queueAll(state.user.id)).filter(i => i.sync !== 'synced').length; }

// ---- Water-point attendant queue (sales and card top-ups), same safety model as readings ----
export async function wpAll() { const all = await tx('wpqueue', 'readonly', s => s.getAll()); return (all || []).filter(i => i.user_id === state.user.id).sort((a, b) => a.captured_at.localeCompare(b.captured_at)); }
export async function wpSave(item) { const it = { ...item, client_uuid: uuid(), user_id: state.user.id, captured_at: new Date().toISOString(), offline: !navigator.onLine, sync: 'queued' }; await tx('wpqueue', 'readwrite', s => s.put(it)); return it; }
let wpSyncing = false;
export async function wpSync() {
  if (wpSyncing || !navigator.onLine) return { skipped: true };
  wpSyncing = true;
  try {
    const items = (await wpAll()).filter(i => i.sync !== 'synced'); if (!items.length) return { sent: 0 };
    let ok = 0, failed = 0;
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      const res = await api('/api/wp/sync', { body: { items: batch.map(({ user_id, sync, error, label, holder, ...rest }) => rest) } });
      for (const r of res.results) { const it = batch.find(b => b.client_uuid === r.client_uuid); if (!it) continue;
        await tx('wpqueue', 'readwrite', s => s.put(r.ok ? { ...it, sync: 'synced', synced_at: new Date().toISOString(), flags: r.flags, error: null } : { ...it, sync: 'error', error: r.error }));
        r.ok ? ok++ : failed++; }
    }
    for (const it of await wpAll()) if (it.sync === 'synced' && Date.now() - Date.parse(it.synced_at || it.captured_at) > 2 * 86400e3) await tx('wpqueue', 'readwrite', s => s.delete(it.client_uuid));
    return { sent: ok, failed };
  } finally { wpSyncing = false; }
}
