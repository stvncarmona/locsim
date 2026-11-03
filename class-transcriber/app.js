// Apuntes de Clase — UI, persistence (IndexedDB), recording and exports.
const $ = (id) => document.getElementById(id);

const MODELS = [
  { id: 'onnx-community/whisper-base', name: 'Rápido · Whisper Base (~150 MB)',
    dtype: { webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
    hint: 'Bueno para audio limpio. Funciona en cualquier ordenador.' },
  { id: 'onnx-community/whisper-small', name: 'Equilibrado · Whisper Small (~350 MB)',
    dtype: { webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
    hint: 'Mejor con acentos y vocabulario técnico. Sin GPU, una clase de 2 h puede tardar varias horas.' },
  { id: 'onnx-community/whisper-large-v3-turbo', name: 'Máxima calidad · Whisper Large v3 Turbo (~1 GB, requiere GPU)',
    dtype: { webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' } }, gpuOnly: true, f16: true,
    hint: 'La mejor precisión. Necesita WebGPU con soporte fp16 y unos 2 GB de memoria de vídeo.' },
];

const SAMPLE = [
  { s: 0, e: 9.4, t: 'Buenos días. Hoy cerramos el tema de termodinámica con la segunda ley y empezamos con entropía.' },
  { s: 9.4, e: 21.8, t: 'Recordad que la entrega del problema 4 se mueve al jueves; lo subo al campus esta tarde.' },
  { s: 21.8, e: 35.2, t: 'La idea clave: en un proceso reversible, la variación de entropía es el calor intercambiado dividido entre la temperatura.' },
  { s: 4520.5, e: 4533.0, t: 'Esto entra en el examen, así que apuntadlo bien: delta S igual a la integral de dQ partido por T.' },
];

const state = {
  file: null, key: null, job: null, running: false, device: 'wasm', f16: false,
  duration: 0, speed: 0, worker: null, wakeLock: null, sample: true,
};

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  let r; try { r = indexedDB.open('apuntes-de-clase', 1); } catch (e) { rej(e); return; }
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('jobs', { keyPath: 'key' });
    db.createObjectStore('recChunks', { autoIncrement: true }).createIndex('rec', 'rec');
    db.createObjectStore('recordings', { keyPath: 'id' });
  };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  try {
    const db = await dbp;
    return await new Promise((res, rej) => {
      const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error);
    });
  } catch (e) { console.warn('IndexedDB', e); return null; }
}
const getJob = (key) => tx('jobs', 'readonly', (s) => s.get(key));
const putJob = (job) => tx('jobs', 'readwrite', (s) => s.put(job));
const delJob = (key) => tx('jobs', 'readwrite', (s) => s.delete(key));

// ---------- helpers ----------
const fmt = (sec, ms = false) => {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return ms ? `${base}${ms}${String(Math.floor((sec % 1) * 1000)).padStart(3, '0')}` : base;
};
const fmtShort = (sec) => (sec >= 3600 ? fmt(sec) : fmt(sec).slice(3));
const human = (sec) => {
  if (!isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
};
const fileKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function showError(msg) { $('error').textContent = msg; $('error').hidden = !msg; }

// ---------- device detection ----------
async function detectDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) { state.device = 'webgpu'; state.f16 = adapter.features.has('shader-f16'); }
    }
  } catch {}
  const pill = $('devicePill');
  if (state.device === 'webgpu') { pill.textContent = 'GPU disponible (WebGPU)'; pill.className = 'pill ok'; }
  else { pill.textContent = 'Sin GPU · se usará la CPU'; pill.className = 'pill warn'; }
  const sel = $('model');
  sel.innerHTML = '';
  for (const m of MODELS) {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.name;
    if (m.gpuOnly && (state.device !== 'webgpu' || (m.f16 && !state.f16))) { o.disabled = true; o.textContent += ' — no disponible aquí'; }
    sel.append(o);
  }
  let saved = null; try { saved = localStorage.getItem('apuntes.model'); } catch {}
  const pick = MODELS.find((m) => m.id === saved && !sel.querySelector(`option[value="${m.id}"]`).disabled);
  sel.value = pick ? pick.id : (state.device === 'webgpu' ? MODELS[1].id : MODELS[0].id);
  updateHint();
}
function currentModel() { return MODELS.find((m) => m.id === $('model').value); }
function updateHint() {
  const m = currentModel();
  const est = state.device === 'webgpu' ? 'Estimación con GPU: entre 10 y 40 min por cada 2 h de clase, según la tarjeta.'
    : 'Estimación sin GPU: aproximadamente igual o más que la duración de la clase.';
  $('modelHint').textContent = `${m.hint} ${est}`;
}
$('model').addEventListener('change', () => { try { localStorage.setItem('apuntes.model', $('model').value); } catch {} updateHint(); });

// ---------- file selection ----------
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) selectFile(f); });
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) selectFile(f); e.target.value = ''; });

async function selectFile(file) {
  if (state.running) return;
  showError('');
  state.file = file; state.key = fileKey(file);
  state.job = (await getJob(state.key)) || null;
  const player = $('player');
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(file); player.hidden = false;
  player.onloadedmetadata = () => { if (isFinite(player.duration)) { state.duration = state.job?.duration || player.duration; renderFileInfo(); } };
  state.duration = state.job?.duration || 0;
  state.sample = false;
  renderFileInfo(); renderTranscript(); updateButtons();
  state.speed = 0; $('progressCard').hidden = !state.job;
  if (state.job) { $('progressCard').hidden = false; updateProgress(state.job.processed, state.job.done ? 'Terminada' : 'En pausa'); }
}
function renderFileInfo() {
  const info = $('fileInfo'); const f = state.file; if (!f) { info.hidden = true; return; }
  const mb = (f.size / 1048576).toFixed(1);
  let status = '';
  if (state.job?.done) status = '<span class="pill ok">Transcripción completa guardada</span>';
  else if (state.job) status = `<span class="pill">Guardado hasta ${fmt(state.job.processed)}</span>`;
  info.innerHTML = `<b>${escapeHtml(f.name)}</b><span class="mono">${mb} MB${state.duration ? ' · ' + fmt(state.duration) : ''}</span>${status}`;
  info.hidden = false;
}
function updateButtons() {
  const has = !!state.file;
  $('startBtn').disabled = !has || state.running;
  $('startBtn').textContent = state.job && !state.job.done && state.job.processed > 0 ? `Continuar desde ${fmt(state.job.processed)}` : (state.job?.done ? 'Volver a transcribir' : 'Transcribir');
  $('stopBtn').hidden = !state.running;
  $('resetBtn').hidden = !state.job || state.running;
  $('model').disabled = $('lang').disabled = state.running;
  $('recBtn').disabled = state.running;
}

// ---------- transcription ----------
function getWorker() {
  if (state.worker) return state.worker;
  const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  let queue = Promise.resolve(); // handle messages strictly in order (handlers await IndexedDB)
  w.onmessage = (e) => { queue = queue.then(() => onWorkerMessage(e)).catch((err) => console.error(err)); };
  w.onerror = (e) => { finishRun(); showError(`Error al cargar el motor de transcripción: ${e.message || 'revisa tu conexión y recarga la página'}.`); };
  state.worker = w; return w;
}

$('startBtn').addEventListener('click', async () => {
  if (!state.file) return;
  const m = currentModel();
  if (state.job?.done || (state.job && (state.job.model !== m.id || state.job.lang !== $('lang').value) && state.job.processed === 0)) {
    state.job = null;
  }
  if (!state.job) {
    state.job = { key: state.key, name: state.file.name, model: m.id, lang: $('lang').value, duration: state.duration, processed: 0, segments: [], done: false, created: Date.now() };
    await putJob(state.job);
  }
  state.running = true; showError(''); updateButtons();
  $('progressCard').hidden = false;
  updateProgress(state.job.processed, 'Cargando modelo…');
  await keepAwake(true);
  const device = m.gpuOnly ? 'webgpu' : state.device;
  getWorker().postMessage({ type: 'start', file: state.file, model: m.id, device, dtype: m.dtype[device], language: $('lang').value, startAt: state.job.processed });
});
$('stopBtn').addEventListener('click', () => { state.worker?.postMessage({ type: 'stop' }); $('stopBtn').disabled = true; $('stState').textContent = 'Pausando al terminar el bloque…'; });
$('resetBtn').addEventListener('click', async () => {
  if ($('resetBtn').dataset.confirm !== '1') { $('resetBtn').dataset.confirm = '1'; $('resetBtn').textContent = 'Pulsa otra vez para borrar lo transcrito'; return; }
  $('resetBtn').dataset.confirm = ''; $('resetBtn').textContent = 'Empezar de cero';
  await delJob(state.key); state.job = null; $('progressCard').hidden = true;
  renderFileInfo(); renderTranscript(); updateButtons();
});

async function onWorkerMessage({ data }) {
  const job = state.job;
  switch (data.type) {
    case 'model-progress':
      $('stState').textContent = `Descargando modelo ${Math.round((data.loaded / data.total) * 100)}%`; break;
    case 'model-ready':
      $('stState').textContent = 'Transcribiendo…'; break;
    case 'duration':
      if (data.duration && isFinite(data.duration)) { state.duration = data.duration; job.duration = data.duration; renderFileInfo(); }
      break;
    case 'segment':
      job.segments.push(...data.seg.chunks); job.processed = data.processed; state.speed = data.speed;
      await putJob(job);
      appendSegments(data.seg.chunks); updateProgress(job.processed, 'Transcribiendo…'); renderFileInfo(); updateButtons();
      break;
    case 'stopped':
      finishRun(); updateProgress(job.processed, 'En pausa'); break;
    case 'done':
      job.done = true; job.processed = Math.max(job.processed, data.processed); if (state.duration) job.processed = state.duration;
      await putJob(job); finishRun(); updateProgress(job.processed, 'Terminada'); renderFileInfo(); break;
    case 'error':
      finishRun(); showError(friendlyError(data.message)); updateProgress(job?.processed || 0, 'Detenida'); break;
  }
}
function friendlyError(msg) {
  if (/fetch|network|Failed to load/i.test(msg)) return `No se pudo descargar el modelo (${msg}). Comprueba la conexión y vuelve a intentarlo; lo ya transcrito está guardado.`;
  if (/memory|OOM|allocation/i.test(msg)) return `El equipo se quedó sin memoria (${msg}). Prueba un modelo más pequeño; puedes continuar desde donde se quedó.`;
  if (/webgpu|adapter|shader/i.test(msg)) return `Fallo de la GPU (${msg}). Elige el modelo «Rápido» o «Equilibrado» y continúa.`;
  return msg;
}
function finishRun() {
  state.running = false; $('stopBtn').disabled = false; updateButtons(); keepAwake(false);
  if (state.worker) { state.worker.terminate(); state.worker = null; } // frees model memory; it reloads from cache
}
function updateProgress(processed, label) {
  const total = state.duration || state.job?.duration || 0;
  const pct = total ? Math.min(100, (processed / total) * 100) : 0;
  $('barFill').style.width = pct.toFixed(1) + '%'; $('bar').setAttribute('aria-valuenow', pct.toFixed(0));
  $('stState').textContent = label;
  $('stDone').textContent = total ? `${fmt(processed)} / ${fmt(total)}` : fmt(processed);
  $('stSpeed').textContent = state.speed ? `${state.speed.toFixed(1)}× tiempo real` : '—';
  $('stEta').textContent = state.running && state.speed && total ? human((total - processed) / state.speed) : (label === 'Terminada' ? 'Listo' : '—');
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (state.running && document.visibilityState === 'visible') keepAwake(true); });
window.addEventListener('beforeunload', (e) => { if (state.running || recorder) { e.preventDefault(); e.returnValue = ''; } });

// ---------- transcript rendering ----------
function segments() { return state.sample ? SAMPLE : (state.job?.segments || []); }
function segHtml(c, q) {
  let t = escapeHtml(c.t);
  if (q) t = t.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
  return `<div class="seg" data-s="${c.s}"><button class="ts" type="button" data-s="${c.s}">${fmtShort(c.s)}</button><p>${t}</p></div>`;
}
function renderTranscript() {
  const q = $('search').value.trim();
  const list = segments().filter((c) => !q || c.t.toLowerCase().includes(q.toLowerCase()));
  $('sampleTag').hidden = !state.sample;
  const el = $('transcript');
  if (!list.length) {
    el.innerHTML = `<p class="empty">${q ? 'Ningún fragmento contiene ese texto.' : state.file ? 'Pulsa «Transcribir». El texto irá apareciendo aquí cada 2 minutos de audio procesado.' : 'Aquí aparecerá la transcripción con marcas de tiempo.'}</p>`;
    return;
  }
  el.innerHTML = list.map((c) => segHtml(c, q)).join('');
}
function appendSegments(chunks) {
  if ($('search').value.trim()) { renderTranscript(); return; }
  const el = $('transcript');
  if (el.querySelector('.empty')) el.innerHTML = '';
  el.insertAdjacentHTML('beforeend', chunks.map((c) => segHtml(c, '')).join(''));
}
$('search').addEventListener('input', renderTranscript);
$('transcript').addEventListener('click', (e) => {
  const b = e.target.closest('button.ts'); if (!b || state.sample) return;
  const p = $('player'); p.currentTime = +b.dataset.s; p.play().catch(() => {});
});
let lastNow = null;
$('player').addEventListener('timeupdate', () => {
  const t = $('player').currentTime; const nodes = $('transcript').querySelectorAll('.seg');
  let cur = null; for (const n of nodes) { if (+n.dataset.s <= t) cur = n; else break; }
  if (cur !== lastNow) { lastNow?.classList.remove('now'); cur?.classList.add('now'); lastNow = cur; }
});

// ---------- exports ----------
function baseName() { return (state.file?.name || 'clase').replace(/\.[^.]+$/, ''); }
function buildExport(kind) {
  const segs = segments();
  if (kind === 'txt') return segs.map((c) => `[${fmt(c.s)}] ${c.t}`).join('\n');
  if (kind === 'md') {
    // Group into paragraphs every ~5 minutes for readability
    let out = `# ${baseName()}\n\n`; let block = -1;
    for (const c of segs) {
      const b = Math.floor(c.s / 300);
      if (b !== block) { out += `${block >= 0 ? '\n\n' : ''}## ${fmt(b * 300)}\n\n`; block = b; } else out += ' ';
      out += c.t;
    }
    return out + '\n';
  }
  if (kind === 'srt') return segs.map((c, i) => `${i + 1}\n${fmt(c.s, ',')} --> ${fmt(c.e, ',')}\n${c.t}\n`).join('\n');
  if (kind === 'vtt') return 'WEBVTT\n\n' + segs.map((c) => `${fmt(c.s, '.')} --> ${fmt(c.e, '.')}\n${c.t}\n`).join('\n');
  return segs.map((c) => c.t).join(' ');
}
document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.export;
  const blob = new Blob([buildExport(kind)], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${baseName()}.${kind}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}));
$('copyBtn').addEventListener('click', async () => {
  const text = buildExport('plain');
  try { await navigator.clipboard.writeText(text); $('copyBtn').textContent = 'Copiado'; }
  catch { $('copyBtn').textContent = 'No se pudo copiar'; }
  setTimeout(() => ($('copyBtn').textContent = 'Copiar texto'), 1800);
});

// ---------- live recording (saved to IndexedDB every 10 s, survives crashes) ----------
let recorder = null, recStream = null, recId = null, recStart = 0, recTimer = null;
$('recBtn').addEventListener('click', async () => {
  if (recorder) { recorder.stop(); return; }
  showError('');
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (e) { showError('No hay acceso al micrófono. Permite el micrófono para esta página en los ajustes del navegador.'); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  recorder = new MediaRecorder(recStream, { mimeType: mime || undefined, audioBitsPerSecond: 48000 });
  recId = `rec-${Date.now()}`; recStart = Date.now();
  await tx('recordings', 'readwrite', (s) => s.put({ id: recId, mime: recorder.mimeType, started: recStart, finished: false }));
  recorder.ondataavailable = (e) => { if (e.data.size) tx('recChunks', 'readwrite', (s) => s.add({ rec: recId, blob: e.data })); };
  recorder.onstop = async () => {
    clearInterval(recTimer); recStream.getTracks().forEach((t) => t.stop());
    const id = recId, mime = recorder.mimeType; recorder = null; $('recLive').hidden = true; $('recBtn').textContent = '● Grabar clase';
    await new Promise((r) => setTimeout(r, 300)); // let the last chunk land
    await tx('recordings', 'readwrite', (s) => s.put({ id, mime, started: recStart, finished: true }));
    const file = await recordingFile(id); if (file) selectFile(file);
    refreshRecordings();
  };
  recorder.start(10000);
  $('recBtn').textContent = '■ Detener grabación'; $('recLive').hidden = false;
  recTimer = setInterval(() => ($('recTime').textContent = fmt((Date.now() - recStart) / 1000)), 500);
  keepAwake(true);
});
async function recordingFile(id) {
  const meta = await tx('recordings', 'readonly', (s) => s.get(id));
  const blobs = await tx('recChunks', 'readonly', (s) => s.index('rec').getAll(id));
  if (!meta || !blobs?.length) return null;
  const type = (meta.mime || 'audio/webm').split(';')[0];
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const d = new Date(meta.started);
  const name = `clase-${d.toISOString().slice(0, 10)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.${ext}`;
  return new File(blobs.map((b) => b.blob), name, { type, lastModified: meta.started });
}
async function refreshRecordings() {
  const recs = (await tx('recordings', 'readonly', (s) => s.getAll())) || [];
  document.querySelectorAll('.saved-rec').forEach((n) => n.remove());
  for (const r of recs.sort((a, b) => b.started - a.started).slice(0, 5)) {
    if (r.id === recId && recorder) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'saved-rec';
    b.textContent = `Usar grabación del ${new Date(r.started).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}`;
    b.addEventListener('click', async () => { const f = await recordingFile(r.id); if (f) selectFile(f); else showError('Esa grabación está vacía.'); });
    $('recBtn').parentElement.append(b);
  }
}

// ---------- boot ----------
detectDevice();
renderTranscript();
refreshRecordings();
updateButtons();
