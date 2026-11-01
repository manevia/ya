// Public community page: water status per area, water points and quality, report a problem (no account), track a report.
import { html, raw, fmtDT, fmtDate, label, money, esc, phoneHint } from './core.js';
import { resizePhoto } from './ocr.js';
import { initI18n, languagePicker, switchLanguage, weekdays } from './i18n.js';

const SUPPLY = { normal: ['good', '✔ Normal supply'], maintenance: ['warn', '🛠 Planned maintenance'], interrupted: ['crit', '⛔ Supply interrupted'], issues_reported: ['warn', '⚠ Problems reported — teams informed'] };
const QUAL = { pass: ['good', 'Water test passed'], warn: ['warn', 'Water test: attention'], fail: ['crit', 'Water test FAILED — treat water'] };
const STAGES = [['received', 'Received'], ['acknowledged', 'Seen by staff'], ['team_assigned', 'Team assigned'], ['team_working', 'Team working on it'], ['resolved', 'Resolved']];
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(b) }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed'); return d; });

async function track(ref, box) {
  const r = await fetch('/api/public-report/' + encodeURIComponent(ref.trim()));
  if (!r.ok) { box.innerHTML = '<div class="note crit">Reference not found. Check the code (e.g. R-ABC123).</div>'; return; }
  const t = await r.json();
  if (t.kind === 'connection') {
    const CS = [['submitted', 'Application received'], ['survey_scheduled', 'Survey booked'], ['surveyed', 'Surveyed'], ['quoted', 'Quote ready'], ['accepted', 'Accepted'], ['installing', 'Installing'], ['connected', 'Connected']];
    const ci = CS.findIndex(s => s[0] === t.status);
    box.innerHTML = html`<div class="note"><b>${t.ref}</b> — new water connection${t.area ? ' in ' + t.area : ''}, applied ${fmtDate(t.reported_at.slice(0, 10))}. <b>${t.stage_text}</b></div>
      ${ci >= 0 ? html`<div style="display:flex;gap:.3rem;flex-wrap:wrap">${CS.map((s, i) => html`<span class="badge ${i <= ci ? (i === 6 ? 'good' : 'info') : 'outline'}">${i <= ci ? '●' : '○'} ${s[1]}</span>`)}</div>` : ''}
      ${t.quote ? html`<p style="margin-top:.6rem">Quote: <b>${money(t.quote.total, t.quote.currency)}</b>${t.quote.deposit != null ? html` — deposit ${money(t.quote.deposit, t.quote.currency)}${t.quote.instalments ? html`, then ${t.quote.instalments} × ${money(t.quote.instalment_amount, t.quote.currency)} a month on your water bill` : ''}` : ''}</p>` : ''}`.s;
    return;
  }
  const idx = t.stage === 'closed' ? 4 : STAGES.findIndex(s => s[0] === t.stage);
  box.innerHTML = html`<div class="note"><b>${t.ref}</b> — ${label(t.kind)}${t.area ? ' in ' + t.area : ''}, reported ${fmtDT(t.reported_at.replace(' ', 'T') + 'Z')}</div>
    <div style="display:flex;gap:.3rem;flex-wrap:wrap">${STAGES.map((s, i) => html`<span class="badge ${i <= idx ? (i === 4 ? 'good' : 'info') : 'outline'}">${i <= idx ? '●' : '○'} ${t.stage === 'closed' && i === 4 ? 'Reviewed & closed' : s[1]}</span>`)}</div>`.s;
}

(async () => {
  await initI18n();
  const res = await fetch('/api/public-status');
  if (!res.ok) { document.body.innerHTML = '<div class="login-wrap"><div class="login"><h1>Not available</h1><p>The public status page is switched off.</p></div></div>'; return; }
  const d = await res.json();
  document.title = 'Water status — ' + d.org_name;
  const qs = new URLSearchParams(location.search);
  document.body.innerHTML = html`${d.mode === 'demo' ? html`<div class="demo-banner">DEMONSTRATION — fictional utility and data. Reports you send here go into the demo system only.</div>` : ''}
  <main class="content" style="margin:0 auto;max-width:1100px">
    <div class="page-head"><div style="display:flex;gap:.6rem;align-items:center"><img src="/img/icon.svg" width="38" height="38" alt=""><div><h1>Water status & report a problem</h1><small>${d.org_name} · updated ${fmtDT(d.generated_at)}</small></div></div>
      <div class="actions"><a class="btn primary" href="#report">Report a problem</a><a class="btn" href="#apply">Apply for a connection</a><a class="btn" href="#track">Track my report</a>${raw(languagePicker('langpub'))}</div></div>
    <div class="note">No smartphone? Dial <b>${d.ussd_code}</b> on any phone, or text <b>LEAK</b> and the place (for example “LEAK near the market”) to the utility number.</div>
    ${d.areas.map(a => html`<div class="card"><div class="card-head"><h2 style="margin:0">${a.area}</h2><span class="badge ${SUPPLY[a.supply][0]}" style="font-size:.85rem">${SUPPLY[a.supply][1]}</span></div>
      ${a.schedule && a.schedule.length ? html`<div class="note"><b>🕒 Piped water times</b>${(() => { const D = weekdays(); return a.schedule.slice(0, 8).map(w => html`<div>${w.flowing ? html`<b style="color:var(--good)">● Flowing now</b> ` : ''}${D[new Date(w.date + 'T00:00:00Z').getUTCDay()]} ${fmtDate(w.date)} <b>${w.start_time}–${w.end_time}</b>${w.zone ? html` · ${w.zone}` : ''}${w.cancelled ? html` <span class="badge crit">Cancelled</span>` : ''}</div>`); })()}
        <small>Text SUPPLY to get your next water time by SMS.</small></div>` : ''}
      ${a.quality_advisory ? html`<div class="note crit"><b>Water quality advisory:</b> boil or treat drinking water from the affected point(s) until further notice.</div>` : ''}
      ${a.notices.map(n => html`<div data-noi18n class="note ${n.notice_type === 'quality' ? 'crit' : n.notice_type === 'outage' ? 'warn' : ''}"><b>${n.title}</b>${n.starts_at ? html` <small>(${fmtDate(n.starts_at)}${n.ends_at && n.ends_at !== n.starts_at ? ' – ' + fmtDate(n.ends_at) : ''})</small>` : ''}<br>${n.body}</div>`)}
      ${a.water_points.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>Water point</th><th>Status</th><th>Price</th><th>Hours</th><th>Water quality</th></tr></thead><tbody>${a.water_points.map(p => html`<tr>
        <td>${p.name}${p.lat != null ? html` <a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}" target="_blank" rel="noopener">map ↗</a>` : ''}</td>
        <td>${p.status === 'operational' && p.active !== 0 ? html`<span class="badge good">Open</span>` : html`<span class="badge crit">${p.status === 'operational' ? 'Closed' : label(p.status)}</span>`}</td>
        <td>${p.mode === 'free' ? 'Free' : p.price_per_container != null ? `${money(p.price_per_container, a.currency)} / ${p.container_liters} L` : '—'}</td><td>${p.opening_hours || '—'}</td>
        <td>${p.quality.result ? html`<span class="badge ${QUAL[p.quality.result][0]}">${QUAL[p.quality.result][1]}</span><br><small>${fmtDate(p.quality.last_tested)}</small>` : html`<span class="muted">Not yet tested</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No public water points listed.</p>`}
      ${a.open_issues ? html`<p class="muted" style="font-size:.85rem">${a.open_issues} reported problem(s) are being handled in this area.</p>` : ''}</div>`)}
    <div class="grid g2"><div class="card" id="report"><h2>Report a problem</h2><p class="muted" style="font-size:.88rem">No account needed. Leave your phone number to get an SMS when it is fixed (optional).</p>
      <form id="rf" class="form">
        <label class="f"><span class="req">What is the problem?</span><select name="kind" required><option value="leak">Leak (dripping / small)</option><option value="burst">Burst pipe (lots of water)</option><option value="no_water">No water</option><option value="quality">Water looks / smells / tastes bad</option><option value="kiosk">Problem at a water point / kiosk</option><option value="other">Other</option></select></label>
        <label class="f"><span>Area</span><select name="area_id"><option value="">— choose —</option>${d.areas_list.map(a => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
        <label class="f"><span>Water point (if relevant)</span><select name="asset_id"><option value="">—</option>${d.points_list.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
        <label class="f"><span>Where exactly?</span><input name="location_text" maxlength="200" placeholder="Street, landmark, near…"></label>
        <label class="f full"><span>Details</span><textarea name="description" maxlength="600"></textarea></label>
        <label class="f"><span>Your phone (optional)</span><input name="phone" type="tel" placeholder="${phoneHint()}"></label>
        <label class="f"><span>Photo (optional)</span><input name="photo" type="file" accept="image/*" capture="environment"></label>
        <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
        <div class="full" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"><button type="button" class="btn" id="gps">📍 Share my location</button><span id="gpsinfo" class="muted" style="font-size:.85rem"></span></div>
        <div class="full"><button class="btn primary lg">Send report</button></div><div class="full" id="rout"></div></form></div>
      <div class="card" id="track"><h2>Track my report</h2><form id="tf" style="display:flex;gap:.5rem"><input name="ref" placeholder="R-ABC123 or C-ABC123" style="flex:1;text-transform:uppercase" value="${qs.get('ref') || ''}"><button class="btn primary">Check</button></form><div id="tout" style="margin-top:.6rem"></div>
        <p class="muted" style="font-size:.85rem;margin-top:1rem">This page shows service information only. It never shows customer names, accounts or bills.</p></div></div>
    <div class="card" id="apply"><h2>Apply for a water connection</h2><p class="muted" style="font-size:.88rem">Get piped water at home or at your business. After a free site survey you get a quote; pay a deposit and the rest can be spread over monthly instalments on your water bill.</p>
      <form id="af" class="form">
        <label class="f"><span class="req">Your name</span><input name="applicant_name" required maxlength="120"></label>
        <label class="f"><span class="req">Phone</span><input name="phone" type="tel" required placeholder="${phoneHint()}"></label>
        <label class="f"><span class="req">Area</span><select name="area_id" required><option value="">— choose —</option>${d.areas_list.map(a => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
        <label class="f"><span>Type</span><select name="customer_type"><option value="household">Home (household)</option><option value="business">Business</option><option value="institution">School / clinic / church</option></select></label>
        <label class="f full"><span class="req">Address</span><input name="address" required maxlength="250" placeholder="Street, house, community"></label>
        <label class="f"><span>Landmark</span><input name="landmark" maxlength="200"></label><label class="f"><span>People in the household</span><input name="household_size" type="number" min="1" max="100"></label>
        <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
        <div class="full" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"><button type="button" class="btn" id="agps">📍 Share my location (helps the survey)</button><span id="agpsinfo" class="muted" style="font-size:.85rem"></span></div>
        <div class="full"><button class="btn primary lg">Send application</button></div><div class="full" id="aout"></div></form></div>
  </main><div id="toasts"></div>`.s;
  const lpub = document.getElementById('langpub'); if (lpub) lpub.addEventListener('change', () => switchLanguage(lpub.value));
  const t0 = Date.now(); let gps = null;
  const f = document.getElementById('rf');
  document.getElementById('gps').addEventListener('click', () => { const i = document.getElementById('gpsinfo'); if (!navigator.geolocation) { i.textContent = 'Not available'; return; } i.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(p => { gps = { lat: p.coords.latitude, lng: p.coords.longitude }; i.textContent = `📍 ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`; }, e => { i.textContent = 'Could not get location: ' + e.message; }, { enableHighAccuracy: true, timeout: 15000 }); });
  f.addEventListener('submit', async e => {
    e.preventDefault(); const out = document.getElementById('rout'); const btn = f.querySelector('button.primary'); btn.disabled = true;
    try {
      const photo = f.photo.files[0] ? await resizePhoto(f.photo.files[0], 1024) : null;
      const body = { kind: f.kind.value, area_id: f.area_id.value ? Number(f.area_id.value) : null, asset_id: f.asset_id.value ? Number(f.asset_id.value) : null, location_text: f.location_text.value || null,
        description: f.description.value || null, phone: f.phone.value || null, photo, website: f.website.value, form_ms: Date.now() - t0, ...(gps || {}) };
      const r = await post('/api/public-report', body);
      out.innerHTML = html`<div class="note"><b>Thank you!</b> Your report number is <b class="mono" style="font-size:1.1rem">${r.ref}</b>. Keep it to check progress${body.phone ? ' — we will also SMS you when it is fixed' : ''}.</div>`.s;
      f.reset(); gps = null; document.getElementById('gpsinfo').textContent = ''; document.querySelector('#tf [name=ref]').value = r.ref;
    } catch (err) { out.innerHTML = `<div class="note crit">${esc(err.message)}</div>`; } finally { btn.disabled = false; }
  });
  let agps = null; const af = document.getElementById('af');
  document.getElementById('agps').addEventListener('click', () => { const i = document.getElementById('agpsinfo'); if (!navigator.geolocation) { i.textContent = 'Not available'; return; } i.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(p => { agps = { lat: p.coords.latitude, lng: p.coords.longitude }; i.textContent = `📍 ${agps.lat.toFixed(5)}, ${agps.lng.toFixed(5)}`; }, e => { i.textContent = 'Could not get location: ' + e.message; }, { enableHighAccuracy: true, timeout: 15000 }); });
  af.addEventListener('submit', async e => {
    e.preventDefault(); const out = document.getElementById('aout'); const btn = af.querySelector('button.primary'); btn.disabled = true;
    try {
      const body = { applicant_name: af.applicant_name.value, phone: af.phone.value, area_id: Number(af.area_id.value), customer_type: af.customer_type.value, address: af.address.value, landmark: af.landmark.value || null,
        household_size: af.household_size.value ? Number(af.household_size.value) : null, website: af.website.value, form_ms: Date.now() - t0, ...(agps || {}) };
      const r = await post('/api/public-connection', body);
      out.innerHTML = html`<div class="note"><b>Application received!</b> Your reference is <b class="mono" style="font-size:1.1rem">${r.ref}</b>. We will SMS you to arrange the site survey. Track it above with this reference.</div>`.s;
      af.reset(); agps = null; document.querySelector('#tf [name=ref]').value = r.ref;
    } catch (err) { out.innerHTML = `<div class="note crit">${esc(err.message)}</div>`; } finally { btn.disabled = false; }
  });
  document.getElementById('tf').addEventListener('submit', e => { e.preventDefault(); track(e.target.ref.value, document.getElementById('tout')); });
  if (qs.get('ref')) track(qs.get('ref'), document.getElementById('tout'));
})();
