import { api, html, raw, mount, $, $$, state, qs, can, fmtM3, fmtDT, fmtNum, label, badge, table, modal, formFields, toast, bind, flagBadges, simBadge, FLAGS, confirmBox, esc } from '../core.js';
import { ensureLookups } from './dashboard.js';

export async function review(root, _p, q) {
  const L = await ensureLookups();
  if (!q.status && !q.flag && !q.q && !q.all) q = { ...q, status: 'pending' };
  if (q.group === undefined) q = { ...q, group: 'field' };
  const rows = await api('/api/readings' + qs(q));
  const canReview = can('readings.review');
  mount(root, html`<div class="page-head"><div><h1>Readings review</h1><small>${rows.length} readings · original values are never overwritten; corrections are audited</small></div>
    <div class="actions">${can('readings.import') ? html`<a class="btn" href="#/readings/import">Import CSV</a>` : ''}${can('readings.create') ? html`<button class="btn" data-act="manual">+ Manual entry</button>` : ''}
      ${canReview ? html`<button class="btn primary" data-act="bulk">Approve selected</button>` : ''}</div></div>
    <div class="tabs">${[['field', 'Field & imported readings'], ['device', 'Device / simulator readings'], ['', 'All sources']].map(([k, l]) => html`<a href="#/readings${qs({ ...q, group: k || 'all' })}" class="${(q.group === 'all' ? '' : q.group) === k ? 'active' : ''}">${l}</a>`)}</div>
    <form class="filters" id="rf"><input type="hidden" name="group" value="${q.group}"><label>Status<select name="status"><option value="">All</option>${['pending', 'approved', 'rejected'].map(s => html`<option${s === q.status ? raw(' selected') : ''}>${s}</option>`)}</select></label>
      <label>Flag<select name="flag"><option value="">Any</option><option value="any"${q.flag === 'any' ? raw(' selected') : ''}>Has any flag</option><option value="none"${q.flag === 'none' ? raw(' selected') : ''}>No flags</option>${Object.entries(FLAGS).map(([k, v]) => html`<option value="${k}"${k === q.flag ? raw(' selected') : ''}>${v}</option>`)}</select></label>
      <label>Source<select name="source"><option value="">All</option>${['manual', 'csv_import', 'pulse', 'lorawan', 'nbiot', 'cellular', 'wmbus', 'serial', 'vendor_api', 'simulator'].map(s => html`<option value="${s}"${s === q.source ? raw(' selected') : ''}>${label(s)}</option>`)}</select></label>
      <label>Area<select name="area_id"><option value="">All</option>${L.areas.map(a => html`<option value="${a.id}"${String(a.id) === q.area_id ? raw(' selected') : ''}>${a.name}</option>`)}</select></label>
      <label>Search<input name="q" value="${q.q || ''}" placeholder="Meter, customer"></label><button class="btn primary">Filter</button></form>
    <div class="card flush">${rows.length ? html`<div class="table-wrap"><table class="t"><thead><tr>${canReview ? html`<th><input type="checkbox" id="all" title="Select all unflagged"></th>` : ''}<th>Date</th><th>Customer / meter</th><th class="num">Previous</th><th class="num">Reading</th><th class="num">Use</th><th>Source</th><th>Flags</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(r => { const flags = JSON.parse(r.flags_json); const clean = !flags.filter(f => !['offline_capture', 'simulated'].includes(f)).length; return html`<tr>
        ${canReview ? html`<td>${r.status === 'pending' ? html`<input type="checkbox" class="sel" value="${r.id}" data-clean="${clean ? 1 : 0}">` : ''}</td>` : ''}
        <td>${fmtDT(r.reading_at)}${r.sync_status === 'offline_synced' ? html`<br><small>received ${fmtDT(r.received_at)}</small>` : ''}</td>
        <td>${r.customer_id ? html`<a href="#/customers/${r.customer_id}">${r.customer_name}</a>` : '—'}<br><small class="mono">${r.serial_number}</small></td>
        <td class="num">${fmtNum(r.previous_value, 1)}</td>
        <td class="num">${r.corrected_value != null ? html`<s class="muted" title="Original value (kept)">${fmtNum(r.value, 1)}</s><br><b title="${r.correction_reason}">${fmtNum(r.corrected_value, 1)}</b>` : html`<b>${fmtNum(r.value, 1)}</b>`}</td>
        <td class="num">${r.consumption == null ? '—' : fmtM3(r.consumption)}</td>
        <td>${label(r.source)}${r.is_simulated ? html`<br>${simBadge()}` : ''}${r.integration_id && r.integration_status && r.integration_status !== 'verified' && !r.is_simulated ? html`<br><span class="badge serious">unverified device</span>` : ''}<br><small>${r.reader_name || ''}</small></td>
        <td>${flagBadges(flags)}${r.notes ? html`<br><small>${r.notes}</small>` : ''}${r.review_note ? html`<br><small><i>Review: ${r.review_note}</i></small>` : ''}</td>
        <td>${badge(r.status)}${r.billed_bill_id ? html`<br><span class="badge outline">billed</span>` : ''}</td>
        <td style="white-space:nowrap">${r.has_photo ? html`<button class="btn sm" data-act="photo" data-id="${r.id}">📷</button> ` : ''}${r.lat ? html`<a class="btn sm" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=18/${r.lat}/${r.lng}">📍</a> ` : ''}
          ${canReview && r.status === 'pending' ? html`<button class="btn sm good" data-act="approve" data-id="${r.id}">Approve</button> <button class="btn sm" data-act="correct" data-id="${r.id}" data-v="${r.value}">Correct</button> <button class="btn sm danger" data-act="reject" data-id="${r.id}">Reject</button>` : ''}
          ${canReview && r.status === 'approved' && !r.billed_bill_id ? html`<button class="btn sm" data-act="correct" data-id="${r.id}" data-v="${r.corrected_value ?? r.value}">Correct</button>` : ''}
          <a class="btn sm" href="#/audit?entity=reading&entity_id=${r.id}" title="Audit trail">🕘</a></td></tr>`; })}
      </tbody></table></div>` : html`<div class="empty">No readings match.</div>`}</div>`);
  $('#rf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = '#/readings' + qs(Object.fromEntries(new FormData(e.target))); });
  const allBox = $('#all', root); if (allBox) allBox.addEventListener('change', () => $$('.sel', root).forEach(c => { if (c.dataset.clean === '1') c.checked = allBox.checked; }));
  const reload = () => review(root, _p, q);
  bind(root, {
    approve: async el => { await api(`/api/readings/${el.dataset.id}/approve`, { body: {} }); toast('Reading approved', 'ok'); reload(); },
    reject: async el => { const reason = await confirmBox('Reject reading', 'The reading stays on record but will not be billed.', { reason: true, danger: true, ok: 'Reject' }); if (!reason) return; await api(`/api/readings/${el.dataset.id}/reject`, { body: { reason } }); toast('Rejected', 'ok'); reload(); },
    correct: el => modal('Correct reading', html`<div class="note">The original value (${el.dataset.v}) is kept. The correction, your name and reason are recorded in the audit log.</div><div class="form">${formFields([{ name: 'value', label: 'Corrected register value (m³)', type: 'number', step: 'any', required: true },
      { name: 'reason', label: 'Reason for correction', type: 'textarea', required: true, full: true, placeholder: 'e.g. Photo shows 1,284.6 — digit transposed by reader' }, { name: 'approve', label: 'Approve with this correction', type: 'checkbox', default: true }])}</div>`,
      { onSubmit: async v => { await api(`/api/readings/${el.dataset.id}/correct`, { body: v }); toast('Correction recorded', 'ok'); reload(); } }),
    bulk: async () => { const ids = $$('.sel:checked', root).map(c => Number(c.value)); if (!ids.length) return toast('Select readings first (flagged readings must be reviewed individually)', 'err'); const r = await api('/api/readings/bulk-approve', { body: { ids } }); toast(`${r.approved} approved${r.skipped.length ? `, ${r.skipped.length} skipped (flagged)` : ''}`, 'ok'); reload(); },
    photo: el => modal('Meter photo', html`<img src="/api/readings/${el.dataset.id}/photo" style="max-width:100%" alt="Meter register photo">`, {}),
    manual: () => manualEntry(reload)
  });
}

async function manualEntry(done) {
  const meters = (await api('/api/meters?status=active')).filter(m => m.customer_id);
  modal('Manual reading entry', html`<div class="form">${formFields([{ name: 'meter_id', label: 'Meter', type: 'select', options: meters.map(m => [m.id, `${m.serial_number} — ${m.customer_name}`]), required: true, full: true },
    { name: 'value', label: 'Register reading (m³)', type: 'number', step: 'any', required: true }, { name: 'reading_at', label: 'Date & time read', type: 'datetime-local', required: true },
    { name: 'is_estimated', label: 'Estimated (meter not read)', type: 'checkbox' }, { name: 'notes', label: 'Notes', type: 'textarea', full: true }])}</div>`,
    { onSubmit: async v => { if (v.meter_id) v.meter_id = Number(v.meter_id); const r = await api('/api/readings', { body: v }); toast('Saved' + (JSON.parse(r.flags_json).length ? ' — flagged: ' + JSON.parse(r.flags_json).join(', ') : ''), 'ok'); done(); } });
}

export async function importView(root) {
  mount(root, html`<div class="crumbs"><a href="#/readings">Readings</a> ›</div><div class="page-head"><h1>Import readings from CSV / spreadsheet</h1></div>
    <div class="card"><p>Save your spreadsheet as <b>CSV</b> (File › Save as › CSV UTF-8). Required columns: <span class="mono">meter_serial, reading_value, reading_date</span>. Optional: <span class="mono">reader, estimated (yes/no), notes</span>.</p>
      <p><a href="#" data-act="sample">Download a sample file</a> built from your current meters.</p>
      <input type="file" id="file" accept=".csv,text/csv"> <button class="btn primary" data-act="preview">Check file</button></div><div id="out"></div>`);
  let content = null, filename = null;
  const run = async commit => {
    const f = $('#file', root).files[0]; if (!f && !content) return toast('Choose a CSV file', 'err');
    if (f) { content = await f.text(); filename = f.name; }
    const r = await api('/api/readings/import', { body: { filename, content, commit } });
    $('#out', root).innerHTML = html`<div class="card"><div class="card-head"><h2>${commit ? 'Imported' : 'Preview'}: ${commit ? r.accepted : r.valid} valid, ${commit ? r.rejected : r.invalid} with errors</h2>
      ${!commit && r.valid ? html`<button class="btn primary" data-act="commit">Import ${r.valid} valid rows</button>` : ''}${commit ? html`<a class="btn" href="#/readings?status=pending&source=csv_import">Review imported readings</a>` : ''}</div>
      ${!commit ? html`<div class="note">Rows with errors are skipped. Valid rows enter the review queue as <b>pending</b> — nothing is billed until approved.</div>` : ''}
      ${table([{ label: 'Row', key: 'row' }, { label: 'Meter', render: x => html`<span class="mono">${x.meter_serial}</span>` }, { label: 'Value', cls: 'num', key: 'reading_value' }, { label: 'Date', key: 'reading_date' },
        { label: 'Use', cls: 'num', render: x => (x.consumption != null ? fmtM3(x.consumption) : '—') }, { label: 'Result', render: x => (x.errors.length ? html`<span class="badge crit">${x.errors.join('; ')}</span>` : flagBadges(x.flags || [])) }], r.rows)}</div>`.s;
  };
  bind(root, {
    preview: () => { content = null; return run(false); }, commit: () => run(true),
    sample: async () => { const ms = (await api('/api/meters?status=active')).filter(m => m.customer_id).slice(0, 8);
      const csv = 'meter_serial,reading_value,reading_date,reader,estimated,notes\r\n' + ms.map(m => `${m.serial_number},${((m.last_reading_value || 0) + 12.5).toFixed(1)},${new Date().toISOString().slice(0, 10)},Sample Reader,no,`).join('\r\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'sample-readings.csv'; a.click(); }
  });
}
