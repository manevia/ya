// On-device meter-photo OCR (tesseract.js, vendored under /vendor/tesseract — no internet needed once cached).
// OCR only SUGGESTS a value: the person reading the meter always confirms it, and any disagreement is flagged for review.
let workerP = null;
function loadScript(src) { return new Promise((res, rej) => { if (window.Tesseract) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load OCR engine')); document.head.appendChild(s); }); }
export async function getWorker(onProgress) {
  if (!workerP) workerP = (async () => {
    await loadScript('/vendor/tesseract/tesseract.min.js');
    const w = await window.Tesseract.createWorker('eng', 1, {
      workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract', langPath: '/vendor/tesseract/lang', workerBlobURL: false, gzip: true,
      logger: m => onProgress && onProgress(m)
    });
    await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
    return w;
  })().catch(e => { workerP = null; throw e; });
  return workerP;
}
/** Warm the browser cache so OCR also works offline later. */
export async function prepareOffline(onProgress) { await getWorker(onProgress); }

function preprocess(img, rect, invert) {
  const sx = Math.round(rect.x * img.naturalWidth), sy = Math.round(rect.y * img.naturalHeight), sw = Math.max(8, Math.round(rect.w * img.naturalWidth)), sh = Math.max(8, Math.round(rect.h * img.naturalHeight));
  const scale = Math.min(4, Math.max(1, 120 / sh)); // aim for ~120 px tall digits strip
  const c = document.createElement('canvas'); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height); const px = d.data; const gray = new Uint8ClampedArray(c.width * c.height);
  let min = 255, max = 0;
  for (let i = 0; i < gray.length; i++) { const v = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; gray[i] = v; if (v < min) min = v; if (v > max) max = v; }
  const span = Math.max(1, max - min); const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) { gray[i] = ((gray[i] - min) / span) * 255; hist[gray[i] | 0]++; }
  // Otsu threshold
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128; const total = gray.length;
  for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF; const between = wB * wF * (mB - mF) ** 2; if (between > best) { best = between; thr = t; } }
  let dark = 0; for (let i = 0; i < gray.length; i++) if (gray[i] < thr) dark++;
  const inv = invert ?? (dark / total > 0.5); // light digits on dark wheels → invert so text is dark on light
  for (let i = 0; i < gray.length; i++) { let v = gray[i] < thr ? 0 : 255; if (inv) v = 255 - v; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  g.putImageData(d, 0, 0);
  // Tesseract reads more reliably with a white margin around the digit strip.
  const pad = Math.round(c.height * 0.35); const o = document.createElement('canvas'); o.width = c.width + pad * 2; o.height = c.height + pad * 2;
  const og = o.getContext('2d'); og.fillStyle = '#fff'; og.fillRect(0, 0, o.width, o.height); og.drawImage(c, pad, pad);
  return o;
}
/** Odometer wheels: find dark wheel columns separated by light gaps and read each wheel on its own (PSM 10). */
export function wheelCells(img, rect) {
  const c = preprocess(img, rect, false); // dark = wheel body; inside the margin
  const g = c.getContext('2d'); const { width: W, height: H } = c; const px = g.getImageData(0, 0, W, H).data;
  const dark = new Array(W).fill(0);
  for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) if (px[(y * W + x) * 4] < 128) n++; dark[x] = n / H; }
  const peak = Math.max(...dark); if (peak < 0.2) return [];
  const cells = []; let start = -1;
  for (let x = 0; x <= W; x++) { const on = x < W && dark[x] > Math.max(0.1, peak * 0.2); if (on && start < 0) start = x; if (!on && start >= 0) { if (x - start > 6) cells.push([start, x]); start = -1; } }
  if (cells.length < 3 || cells.length > 10) return [];
  const widths = cells.map(([a, b]) => b - a).sort((a, b) => a - b); const med = widths[Math.floor(widths.length / 2)];
  const good = cells.filter(([a, b]) => (b - a) > med * 0.6 && (b - a) < med * 1.6);
  if (good.length < 3) return [];
  return good.map(([a, b]) => { // each wheel: crop just the wheel body, invert so the digit is dark on white, add a white margin
    let top = -1, bot = -1;
    for (let y = 0; y < H; y++) { let n = 0; for (let x = a; x < b; x++) if (px[(y * W + x) * 4] < 128) n++; if (n / (b - a) > 0.5) { if (top < 0) top = y; bot = y; } }
    if (top < 0) { top = 0; bot = H - 1; }
    const ch = bot - top + 1, cw = b - a, pad = Math.round(cw * 0.5);
    const o = document.createElement('canvas'); o.width = cw + pad * 2; o.height = ch + pad * 2;
    const og = o.getContext('2d'); og.fillStyle = '#fff'; og.fillRect(0, 0, o.width, o.height);
    const id = g.getImageData(a, top, cw, ch); const d = id.data; for (let i = 0; i < d.length; i += 4) { const v = 255 - d[i]; d[i] = d[i + 1] = d[i + 2] = v; }
    for (let y = 0; y < ch; y++) { let n = 0; for (let x = 0; x < cw; x++) if (d[(y * cw + x) * 4] < 128) n++; if (n / cw > 0.75) for (let x = 0; x < cw; x++) { const k = (y * cw + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; } } // drop wheel-edge lines
    og.putImageData(id, pad, pad); return o;
  });
}

/** Read digits from the selected rectangle (fractions 0..1 of the image). Returns {digits, confidence, preview}. */
export async function readDigits(img, rect, onProgress) {
  const w = await getWorker(onProgress);
  const tries = [];
  for (const inv of [undefined, true, false]) {
    const c = preprocess(img, rect, inv);
    const { data } = await w.recognize(c, {}, { text: true, blocks: true });
    const digits = (data.text || '').replace(/\D/g, '');
    const words = []; for (const bl of data.blocks || []) for (const pa of bl.paragraphs || []) for (const li of pa.lines || []) for (const wd of li.words || []) if (/\d/.test(wd.text)) words.push(wd.confidence);
    tries.push({ digits, engine: Math.round(words.length ? words.reduce((a, b) => a + b, 0) / words.length : (data.confidence || 0)), preview: c.toDataURL('image/png') });
  }
  // Wheel-by-wheel pass for odometer-style registers (light digits on dark wheels).
  const cells = wheelCells(img, rect);
  if (cells.length) {
    await w.setParameters({ tessedit_pageseg_mode: '10' });
    let digits = '', confs = [];
    for (const cell of cells) {
      let d = '', conf = 0;
      for (const psm of ['10', '8', '13', '6']) { // single-character mode is fastest but occasionally returns nothing
        await w.setParameters({ tessedit_pageseg_mode: psm });
        const { data } = await w.recognize(cell, {}, { text: true, blocks: true }); d = (data.text || '').replace(/\D/g, '').slice(0, 1);
        const words = []; for (const bl of data.blocks || []) for (const pa of bl.paragraphs || []) for (const li of pa.lines || []) for (const wd of li.words || []) words.push(wd.confidence);
        conf = words.length ? Math.max(...words) : 0; if (d) break;
      }
      digits += d || '?'; confs.push(conf);
    }
    await w.setParameters({ tessedit_pageseg_mode: '7' });
    if (!digits.includes('?')) { const lineHit = tries.find(t => t.digits.replace(/^0+/, '') === digits.replace(/^0+/, ''));
      tries.unshift({ digits, engine: Math.round(confs.reduce((a, b) => a + b, 0) / confs.length), wheels: true, preview: cells[0].toDataURL('image/png'), confirmed: !!lineHit }); }
  }
  const wheel = tries.find(t => t.wheels);
  if (wheel) return { digits: wheel.digits, confidence: Math.max(wheel.engine, wheel.confirmed ? 85 : 55), engine_confidence: wheel.engine, agreement: wheel.confirmed ? 2 : 1, method: 'wheels', preview: wheel.preview };
  // Combine three passes (auto / inverted / normal): the value most passes agree on wins.
  const votes = {}; for (const t of tries) if (t.digits.length >= 2) votes[t.digits] = (votes[t.digits] || 0) + 1;
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  if (!best) return { digits: '', confidence: 0, preview: tries[0].preview, agreement: 0 };
  const agree = tries.filter(t => t.digits === best[0]);
  const engine = Math.max(...agree.map(t => t.engine));
  const confidence = Math.max(engine, best[1] === 3 ? 80 : best[1] === 2 ? 60 : 30); // agreement-based floor when the engine reports no score
  return { digits: best[0], confidence, engine_confidence: engine, agreement: best[1], preview: agree[0].preview };
}

/** Interactive crop box over a photo. Returns an element; call .getRect() for the selection. */
export function cropper(dataUrl) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'position:relative;display:inline-block;max-width:100%;touch-action:none;user-select:none;margin-top:.5rem';
  const img = new Image(); img.src = dataUrl; img.draggable = false; img.style.cssText = 'max-width:100%;max-height:300px;display:block;border-radius:6px;-webkit-user-drag:none';
  const box = document.createElement('div'); box.style.cssText = 'position:absolute;border:3px solid #eb6834;box-shadow:0 0 0 9999px rgba(0,0,0,.35);border-radius:4px;pointer-events:none';
  wrap.append(img, box);
  let rect = { x: 0.15, y: 0.38, w: 0.7, h: 0.22 };
  const draw = () => { box.style.left = rect.x * 100 + '%'; box.style.top = rect.y * 100 + '%'; box.style.width = rect.w * 100 + '%'; box.style.height = rect.h * 100 + '%'; };
  draw();
  let start = null;
  const pos = e => { const r = img.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  wrap.addEventListener('pointerdown', e => { e.preventDefault(); start = pos(e); wrap.setPointerCapture(e.pointerId); });
  wrap.addEventListener('dragstart', e => e.preventDefault());
  wrap.addEventListener('pointermove', e => { if (!start) return; const p = pos(e); rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; draw(); });
  wrap.addEventListener('pointerup', () => { start = null; if (rect.w < 0.05 || rect.h < 0.03) { rect = { x: 0.15, y: 0.38, w: 0.7, h: 0.22 }; draw(); } });
  wrap.getRect = () => rect; wrap.img = img;
  return wrap;
}

/** Wire a complete "photo → crop → read" panel into a container. onResult({digits, confidence}) */
export function ocrPanel(container, dataUrl, onResult) {
  container.innerHTML = '<div class="note" style="margin:.4rem 0">Drag a box around the <b>black number wheels</b> (whole cubic metres), then tap <b>Read numbers</b>. Always check the result against the meter.</div>';
  const crop = cropper(dataUrl); container.appendChild(crop);
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.5rem';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn primary'; btn.textContent = '🔍 Read numbers from photo';
  const out = document.createElement('span'); out.className = 'muted'; out.style.fontSize = '.88rem';
  row.append(btn, out); container.appendChild(row);
  btn.addEventListener('click', async () => {
    btn.disabled = true; out.textContent = 'Starting OCR…';
    try {
      await crop.img.decode?.().catch(() => {});
      const r = await readDigits(crop.img, crop.getRect(), m => { if (m.status) out.textContent = `${m.status}${m.progress ? ' ' + Math.round(m.progress * 100) + '%' : ''}`; });
      out.innerHTML = r.digits ? `Photo reads <b class="mono" style="font-size:1.1rem">${r.digits}</b> (confidence ${r.confidence}%)` : 'Could not read digits — adjust the box or retake the photo.';
      onResult(r);
    } catch (e) { out.textContent = 'OCR unavailable: ' + e.message; }
    finally { btn.disabled = false; }
  });
}
export async function resizePhoto(file, max = 1280) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src); return c.toDataURL('image/jpeg', 0.75);
}
