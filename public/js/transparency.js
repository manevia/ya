// Public, read-only transparency page for donors, regulators and communities. Aggregated figures only.
import { html, raw, fmtNum, fmtDate, fmtDT, label, esc } from './core.js';
import { initI18n } from './i18n.js';

const tile = (l, v, sub) => html`<div class="kpi"><div class="label">${l}</div><div class="value">${v ?? '—'}</div>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>`;
const pct = v => (v == null ? '—' : fmtNum(v, 1) + '%');
function grouped(rows) {
  if (!rows.length) return html`<div class="empty">No data yet.</div>`;
  const W = 640, H = 220, L = 48, B = 26, T = 8; const max = Math.max(1, ...rows.flatMap(r => [r.billed_m3 || 0, r.supply_m3 || 0]));
  const step = (W - L - 8) / rows.length, bw = Math.min(22, step / 3); const y = v => T + (H - T - B) * (1 - v / max);
  let m = '';
  rows.forEach((r, i) => { const x = L + i * step + step / 2;
    if (r.supply_m3 != null) m += `<rect x="${x - bw - 1}" y="${y(r.supply_m3)}" width="${bw}" height="${y(0) - y(r.supply_m3)}" rx="2" fill="var(--s2)" data-tip="${esc(r.month)} supplied: ${esc(fmtNum(r.supply_m3, 0))} m³"></rect>`;
    m += `<rect x="${x + 1}" y="${y(r.billed_m3 || 0)}" width="${bw}" height="${y(0) - y(r.billed_m3 || 0)}" rx="2" fill="var(--s1)" data-tip="${esc(r.month)} billed: ${esc(fmtNum(r.billed_m3, 0))} m³"></rect>`;
    m += `<text class="lbl" x="${x}" y="${H - 8}" text-anchor="middle">${esc(r.month)}</text>`; });
  for (let t = 0; t <= 4; t++) { const v = max * t / 4; m = `<g class="grid"><line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"></line></g><text class="lbl" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmtNum(v, 0))}</text>` + m; }
  return html`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly supplied and billed volume">${raw(m)}</svg><div class="tip"></div><div class="legend"><span><i style="background:var(--s2)"></i>Supplied (bulk meters)</span><span><i style="background:var(--s1)"></i>Billed to customers</span></div></div>`;
}
document.addEventListener('mousemove', e => { const t = e.target.closest && e.target.closest('[data-tip]'); document.querySelectorAll('.tip').forEach(x => { x.style.display = 'none'; }); if (!t) return; const box = t.closest('.chart'); const tip = box.querySelector('.tip'); const r = box.getBoundingClientRect(); tip.textContent = t.dataset.tip; tip.style.display = 'block'; tip.style.left = e.clientX - r.left + 'px'; tip.style.top = e.clientY - r.top + 'px'; });

(async () => {
  await initI18n();
  const token = location.pathname.split('/').pop();
  const res = await fetch('/api/public/' + encodeURIComponent(token));
  if (!res.ok) { document.body.innerHTML = html`<div class="login-wrap"><div class="login"><h1>Link not available</h1><p>This page link is not valid or has been withdrawn by the utility.</p></div></div>`.s; return; }
  const d = await res.json();
  document.title = d.title + ' — ' + d.org_name;
  const nrwRows = d.volumes.nrw_by_area;
  document.body.innerHTML = html`${d.mode === 'demo' ? html`<div class="demo-banner">DEMONSTRATION — every figure on this page comes from fictional demo data.</div>` : ''}
  <main class="content" style="margin:0 auto">
    <div class="page-head"><div><div style="display:flex;gap:.6rem;align-items:center"><img src="/img/icon.svg" width="34" height="34" alt=""><div><h1>${d.title}</h1><small>${d.org_name} · ${d.areas.join(', ')}</small></div></div></div>
      <div class="actions"><span class="muted" style="font-size:.85rem">${fmtDate(d.period.from)} – ${fmtDate(d.period.to)} · updated ${fmtDT(d.generated_at)}</span><button class="btn no-print" id="pr">Print / PDF</button></div></div>
    <h2>Access</h2>
    <div class="grid g4">${tile('Active connections', d.connections.active, d.connections.by_type.map(t => `${label(t.type)}: ${t.n}`).join(' · '))}${tile('Connections with a working meter', pct(d.connections.metered_pct))}
      ${tile('Public water points functional', pct(d.water_points.functional_pct), `${d.water_points.total} water points`)}${tile('Water sold at kiosks (pay-as-you-fetch)', d.water_points.liters_sold_pay_as_you_fetch ? fmtNum(d.water_points.liters_sold_pay_as_you_fetch / 1000, 1) + ' m³' : '—', d.water_points.sales ? `${d.water_points.sales} sales` : '')}</div>
    <h2 style="margin-top:1.2rem">Water efficiency</h2>
    <div class="grid g4">${tile('Water supplied', d.volumes.supply_m3 != null ? fmtNum(d.volumes.supply_m3, 0) + ' m³' : '—', `${d.volumes.areas_with_supply_data} of ${d.volumes.areas_total} areas measured`)}${tile('Water billed', fmtNum(d.volumes.billed_m3, 0) + ' m³', d.volumes.estimated_share_pct ? `${fmtNum(d.volumes.estimated_share_pct, 1)}% estimated` : 'from actual meter readings')}
      ${tile('Non-revenue water', pct(d.volumes.nrw_pct), 'supplied but not billed (leaks, theft, meter errors)')}${tile('Meters read in the last month', pct(d.reading_completion_pct))}</div>
    <div class="grid g2" style="margin-top:1rem"><div class="card"><h2>Supplied vs billed by month (m³)</h2>${grouped(d.trend)}</div>
      <div class="card"><h2>Non-revenue water by area</h2><table class="t"><thead><tr><th>Area</th><th class="num">NRW</th><th>Data grade</th></tr></thead><tbody>${nrwRows.map(r => html`<tr><td>${r.area}</td><td class="num">${r.status === 'ok' ? pct(r.nrw_pct) : html`<span class="muted">not measured</span>`}</td><td>${r.grade ? html`<span class="badge ${r.grade === 'A' ? 'good' : r.grade === 'B' ? 'warn' : 'crit'}">${r.grade}</span>` : '—'}</td></tr>`)}</tbody></table>
        <p class="muted" style="font-size:.8rem">Grade A: measured supply and actual readings. B: some estimated bills. C: estimated or simulated supply, or many estimated bills.</p></div></div>
    <h2>Financial sustainability & service</h2>
    <div class="grid g4">${d.collection.map(c => tile(`Collection efficiency (${c.currency})`, pct(c.efficiency_pct), 'collected ÷ billed'))}${tile('Repairs & jobs completed', d.service.work_orders_completed, d.service.median_hours_to_complete != null ? `median ${fmtNum(d.service.median_hours_to_complete, 0)} h from report to completion` : '')}
      ${tile('Leak / problem reports', d.service.leak_reports, `${d.service.leak_reports_resolved} resolved`)}</div>
    <div class="card" style="margin-top:1rem"><h3>About these figures</h3><ul style="margin:0;padding-left:1.2rem;font-size:.88rem">${d.notes.map(n => html`<li>${n}</li>`)}</ul></div>
  </main>`.s;
  document.getElementById('pr').addEventListener('click', () => window.print());
})();
