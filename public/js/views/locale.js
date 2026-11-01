// Country & languages: regional profile (currencies, phone numbers, time zone, mobile money), languages and the translation editor.
import { api, html, raw, mount, $, $$, state, qs, can, label, badge, table, modal, formFields, toast, bind, confirmBox, download } from '../core.js';

export async function countryTab(el) {
  const [s, langs, presets] = await Promise.all([api('/api/settings'), api('/api/i18n/languages'), api('/api/country/presets')]);
  const provs = String(s.momo_providers || '').split(';').map(kv => kv.split('=')).filter(x => x[0]);
  mount(el, html`<div class="grid g2">
    <div class="card"><h2>Country profile</h2>
      <p class="muted">Start from a preset, then check every value locally — mobile-money products and number lengths change.</p>
      <div style="display:flex;gap:.5rem;align-items:end;flex-wrap:wrap;margin-bottom:1rem"><label style="flex:1">Preset<select id="preset">${presets.map(p => html`<option value="${p.code}"${p.code === s.country_code ? raw(' selected') : ''}>${p.name} (${p.currencies}, ${p.phone_prefix})</option>`)}</select></label>
        <button class="btn" data-act="apply">Apply preset</button></div>
      <form id="cf" class="form">${formFields([
        { name: 'country_name', label: 'Country', required: true }, { name: 'country_code', label: 'ISO code (2 letters)', required: true },
        { name: 'phone_prefix', label: 'Dialling code', required: true, placeholder: '+231' }, { name: 'phone_digits', label: 'Significant phone digits', type: 'number', min: 6, max: 12, help: 'Digits after the dialling code used to recognise a phone (e.g. 9 for 077 123 4567).' },
        { name: 'timezone', label: 'Time zone (IANA)', required: true, placeholder: 'Africa/Monrovia', help: 'Used for supply timetables. Examples: Africa/Accra, Africa/Nairobi, Africa/Maputo.' },
        { name: 'default_language', label: 'Default language', type: 'select', blank: false, options: langs.filter(l => l.enabled).map(l => [l.code, `${l.native_name} (${l.name})`]) },
        { name: 'currencies', label: 'Currencies (ISO codes, comma-separated)', required: true, placeholder: 'USD,LRD', help: 'Each service area bills in one of these. Currencies in use cannot be removed.' },
        { name: 'currency_symbols', label: 'Currency symbols', placeholder: 'USD=US$;LRD=L$;XOF=FCFA', help: 'CODE=symbol pairs separated by ;. Without a symbol the ISO code is shown.' },
        { name: 'momo_providers', label: 'Mobile-money providers', full: true, placeholder: 'mpesa=M-Pesa;airtel=Airtel Money', help: 'code=Name pairs separated by ;. Customers pay with these; payments are recorded as "mobile money — Name". Keep existing codes so past payments stay labelled.' },
        { name: 'region_label', label: 'Word for a region', placeholder: 'County / District / Région' },
        { name: 'sms_gsm7_only', label: 'Keep SMS in the basic GSM alphabet (accents like ê, ã, ç are simplified so each SMS holds 160 characters, not 70)', type: 'checkbox', full: true },
        { type: 'section', label: 'Merchant numbers customers pay to' },
        ...provs.map(([code, name]) => ({ name: `momo_${code}_merchant`, label: `${name} merchant / till number` }))], { ...s, sms_gsm7_only: s.sms_gsm7_only !== '0' })}
        <div class="full"><button class="btn primary">Save country profile</button></div></form></div>
    <div class="card"><div class="card-head"><h2>Languages</h2><button class="btn" data-act="add">+ Add language</button></div>
      <p class="muted">Staff choose their language under their name in the menu. Customers get SMS and USSD in the language set on their account, or chosen by USSD option 9 or by texting LANG FR / LANG PT.</p>
      ${table([{ label: 'Language', render: l => html`<b>${l.native_name}</b> <small class="muted">${l.name} · ${l.code}${l.dir === 'rtl' ? ' · right-to-left' : ''}</small>${l.default ? html` ${badge('active', 'default')}` : ''}` },
        { label: 'SMS & USSD', render: l => cov(l.coverage.msg) }, { label: 'Screens', render: l => cov(l.coverage.ui) },
        { label: '', render: l => html`<a class="btn sm primary" href="#/translate/${l.code}?scope=msg">Translate</a> ${l.code !== 'en' && !l.default ? html`<button class="btn sm" data-act="toggle" data-code="${l.code}" data-on="${l.enabled ? 0 : 1}">${l.enabled ? 'Switch off' : 'Switch on'}</button>` : ''}` }], langs)}
      <div class="note">French and Portuguese were translated for this release and should be reviewed by native speakers before customers see them. Untranslated screen text appears in English.</div></div></div>`);
  $('#cf', el).addEventListener('submit', async e => { e.preventDefault(); const f = e.target; const v = {}; for (const i of f.elements) if (i.name) v[i.name] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value;
    try { await api('/api/settings', { method: 'PUT', body: v }); toast('Country profile saved — reloading', 'ok'); setTimeout(() => location.reload(), 700); } catch (err) { toast(err.message, 'err'); } });
  bind(el, {
    apply: async () => { const code = $('#preset', el).value; const p = presets.find(x => x.code === code);
      if (!(await confirmBox('Apply country preset', `Set country, currencies (${p.currencies}), phone format (${p.phone_prefix}), time zone (${p.timezone}), language and mobile-money providers for ${p.name}? Currencies already used by service areas are kept. Exchange rates and merchant numbers must be added afterwards.`, { ok: 'Apply' }))) return;
      const r = await api('/api/country/apply', { body: { code } }); toast(r.note, 'ok'); setTimeout(() => location.reload(), 1200); },
    toggle: async b => { await api('/api/i18n/languages/' + b.dataset.code, { method: 'PUT', body: { enabled: b.dataset.on === '1' } }); countryTab(el); },
    add: () => modal('Add a language', html`<div class="form">${formFields([{ name: 'code', label: 'ISO 639 code', required: true, placeholder: 'sw, ha, ar, kpe…' }, { name: 'name', label: 'Name in English', required: true, placeholder: 'Swahili' },
      { name: 'native_name', label: 'Name in the language', required: true, placeholder: 'Kiswahili' }, { name: 'dir', label: 'Writing direction', type: 'select', blank: false, options: [['ltr', 'Left to right'], ['rtl', 'Right to left (Arabic…)']] }])}
      <div class="full note">The new language starts empty: everything shows in English until you translate it here or import a translated CSV.</div></div>`,
      { onSubmit: async v => { await api('/api/i18n/languages', { body: v }); toast('Language added — now translate it', 'ok'); location.hash = `#/translate/${v.code}?scope=msg`; } })
  });
}
const cov = c => html`<div style="min-width:9rem"><div class="bar"><span style="width:${raw(Math.min(100, c.pct))}%"></span></div><small>${c.pct}% · ${c.translated}/${c.total}${c.edited ? ` · ${c.edited} edited here` : ''}</small></div>`;

/** Translation editor: one language, SMS/USSD messages or screen text. */
export async function translate(root, p, q) {
  const lang = p.lang; const scope = q.scope === 'ui' ? 'ui' : 'msg';
  const d = await api(`/api/i18n/strings/${lang}` + qs({ scope, missing: q.missing, q: q.q, where: q.where, limit: 300 }));
  mount(root, html`<div class="crumbs"><a href="#/admin/country">Country & languages</a> ›</div>
    <div class="page-head"><div><h1>Translate: ${lang}</h1><small>${scope === 'msg' ? 'SMS and USSD messages customers receive. Keep {placeholders} exactly; \\n is a new line on the phone.' : 'Text on the app screens. Untranslated text shows in English.'}</small></div>
      <div class="actions"><button class="btn" data-act="export">Export CSV</button><label class="btn" style="cursor:pointer">Import CSV<input type="file" accept=".csv,text/csv" id="imp" hidden></label></div></div>
    <div class="tabs">${[['msg', 'SMS & USSD messages'], ['ui', 'Screen text']].map(([k, l]) => html`<a href="#/translate/${lang}?scope=${k}" class="${k === scope ? 'active' : ''}">${l}</a>`)}</div>
    <form class="filters" id="tf"><input type="hidden" name="scope" value="${scope}"><label>Search<input name="q" value="${q.q || ''}"></label>
      <label>${scope === 'ui' ? 'Screen' : 'Group'}<select name="where"><option value="">All</option>${d.areas.map(a => html`<option${a === q.where ? raw(' selected') : ''}>${a}</option>`)}</select></label>
      <label class="chk" style="display:flex;gap:.3rem;align-items:center"><input type="checkbox" name="missing" value="1"${q.missing === '1' ? raw(' checked') : ''}> Only untranslated</label><button class="btn primary">Show</button></form>
    <div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th style="width:38%">English</th><th>${lang}</th><th style="width:7rem"></th></tr></thead><tbody>
      ${d.rows.map((r, i) => html`<tr><td><small class="muted mono">${scope === 'msg' ? r.key : r.where}</small><div style="white-space:pre-wrap" data-noi18n>${r.en}</div></td>
        <td><textarea data-i="${i}" rows="${raw(String(Math.min(6, Math.ceil(String(r.en).length / 60) + (String(r.en).match(/\n/g) || []).length)))}" style="width:100%" data-noi18n>${r.text}</textarea></td>
        <td>${r.edited ? badge('issued', 'edited here') : r.text ? badge('good', 'done') : badge('pending', 'missing')}${scope === 'msg' ? html`<br><button class="btn sm" data-act="preview" data-key="${r.key}">Preview</button>` : ''}</td></tr>`)}
    </tbody></table></div></div>
    <p class="muted">${d.total > d.rows.length ? `Showing ${d.rows.length} of ${d.total} — use the filters to narrow down.` : `${d.total} strings.`}</p>
    <div style="position:sticky;bottom:0;background:var(--bg);padding:.6rem 0"><button class="btn primary lg" data-act="save">Save changes</button> <span id="chg" class="muted"></span></div>`);
  const changed = new Map();
  $$('textarea[data-i]', root).forEach(t => t.addEventListener('input', () => { const r = d.rows[Number(t.dataset.i)]; changed.set(r.key, t.value); $('#chg', root).textContent = `${changed.size} unsaved change(s)`; }));
  $('#tf', root).addEventListener('submit', e => { e.preventDefault(); location.hash = `#/translate/${lang}` + qs(Object.fromEntries(new FormData(e.target))); });
  $('#imp', root).addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return;
    try { const r = await api(`/api/i18n/import/${lang}`, { body: { scope, content: await f.text() } }); toast(`${r.saved} translation(s) imported`, 'ok'); translate(root, p, q); } catch (err) { toast(err.message, 'err'); } });
  bind(root, {
    save: async () => { if (!changed.size) return toast('Nothing changed');
      const r = await api(`/api/i18n/strings/${lang}`, { method: 'PUT', body: { scope, items: [...changed].map(([key, text]) => ({ key, text })) } }); toast(`${r.saved} saved`, 'ok'); translate(root, p, q); },
    export: () => download(`/api/i18n/export/${lang}?scope=${scope}`),
    preview: async b => { const r = await api(`/api/i18n/preview/${lang}/${encodeURIComponent(b.dataset.key)}`); modal('Preview (sample values)', html`<pre style="white-space:pre-wrap" data-noi18n>${r.text}</pre><p class="muted">${r.text.length} characters${r.text.length > 160 ? ' — more than one SMS part' : ''}</p>`, {}); }
  });
}
