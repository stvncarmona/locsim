// Transcription worker: streams audio out of the file (no full decode in memory),
// resamples to 16 kHz mono, cuts ~2 min segments at quiet points and runs Whisper on each.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
import { Input, BlobSource, ALL_FORMATS, AudioSampleSink } from 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.6/dist/bundles/mediabunny.min.mjs';

env.allowLocalModels = false;

const SR = 16000;
const SEGMENT_S = 120;      // audio per Whisper call batch
const SEARCH_S = 6;         // window before the segment end where we look for a pause
const FRAME = SR / 20;      // 50 ms energy frames

let asr = null;
let asrKey = '';
let stopRequested = false;

const HALLUCINATIONS = [
  /subt[ií]tulos (realizados|por)/i, /amara\.org/i, /suscr[ií]bete/i, /gracias por ver/i,
  /thanks for watching/i, /^\s*\[?(m[uú]sica|music|aplausos|silencio)\]?\s*$/i, /^\s*[.…♪-]*\s*$/,
];

function post(type, data = {}) { self.postMessage({ type, ...data }); }

async function loadModel(model, device, dtype) {
  const key = `${model}|${device}|${JSON.stringify(dtype)}`;
  if (asr && asrKey === key) return;
  if (asr) { try { await asr.dispose(); } catch {} asr = null; }
  const files = new Map();
  asr = await pipeline('automatic-speech-recognition', model, {
    device, dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let l = 0, t = 0; for (const [a, b] of files.values()) { l += a; t += b; }
        post('model-progress', { loaded: l, total: t });
      }
    },
  });
  asrKey = key;
  post('model-ready', { device });
}

class Resampler {
  constructor(inRate) { this.r = inRate / SR; this.buf = new Float32Array(0); this.pos = 0; }
  push(x) {
    const d = new Float32Array(this.buf.length + x.length); d.set(this.buf); d.set(x, this.buf.length);
    const half = Math.max(this.r / 2, 0.5);
    const out = new Float32Array(Math.ceil(d.length / this.r) + 2); let n = 0;
    while (this.pos + half < d.length) {
      const s = Math.max(0, Math.floor(this.pos - half)), e = Math.min(d.length, Math.floor(this.pos + half) + 1);
      let acc = 0; for (let i = s; i < e; i++) acc += d[i];
      out[n++] = acc / (e - s); this.pos += this.r;
    }
    const keep = Math.max(0, Math.floor(this.pos - half) - 1);
    this.buf = d.slice(keep); this.pos -= keep;
    return out.subarray(0, n);
  }
}

class Accumulator {
  constructor() { this.parts = []; this.length = 0; }
  push(x) { if (x.length) { this.parts.push(x.slice()); this.length += x.length; } }
  take(n) {
    const out = new Float32Array(n); let o = 0;
    while (o < n) {
      const p = this.parts[0], k = Math.min(p.length, n - o);
      out.set(p.subarray(0, k), o); o += k;
      if (k === p.length) this.parts.shift(); else this.parts[0] = p.subarray(k);
    }
    this.length -= n; return out;
  }
  peekTail(fromIdx, n) {
    // copy samples [fromIdx, fromIdx+n) from the accumulated stream
    const out = new Float32Array(n); let idx = 0, o = 0;
    for (const p of this.parts) {
      const s = Math.max(fromIdx - idx, 0), e = Math.min(p.length, fromIdx + n - idx);
      if (e > s) { out.set(p.subarray(s, e), o); o += e - s; }
      idx += p.length; if (idx >= fromIdx + n) break;
    }
    return out;
  }
}

function quietCut(acc, target) {
  const start = target - SEARCH_S * SR;
  const win = acc.peekTail(start, SEARCH_S * SR);
  let best = target, bestE = Infinity;
  for (let i = 0; i + FRAME <= win.length; i += FRAME / 2) {
    let e = 0; for (let j = i; j < i + FRAME; j++) e += win[j] * win[j];
    if (e < bestE) { bestE = e; best = start + i + FRAME / 2; }
  }
  return Math.round(best);
}

function rms(x) { let e = 0; for (let i = 0; i < x.length; i += 4) e += x[i] * x[i]; return Math.sqrt(e / (x.length / 4)); }

function cleanChunks(chunks, offset, segLen) {
  const out = []; let last = '', rep = 0;
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text || HALLUCINATIONS.some((r) => r.test(text))) continue;
    if (text === last) { if (++rep >= 2) continue; } else { last = text; rep = 0; }
    const [a, b] = c.timestamp || [0, null];
    const s = offset + Math.min(a ?? 0, segLen), e = offset + Math.min(b ?? segLen, segLen);
    out.push({ s: +s.toFixed(2), e: +Math.max(e, s).toFixed(2), t: text });
  }
  return out;
}

async function transcribeSegment(audio, offset, opts) {
  const len = audio.length / SR;
  if (rms(audio) < 0.002) return { s: offset, e: offset + len, chunks: [] }; // silence: skip, avoids hallucinations
  const res = await asr(audio, {
    chunk_length_s: 30, stride_length_s: 5, return_timestamps: true,
    language: opts.language || null, task: 'transcribe',
  });
  return { s: offset, e: offset + len, chunks: cleanChunks(res.chunks, offset, len) };
}

async function run({ file, model, device, dtype, language, startAt }) {
  stopRequested = false;
  await loadModel(model, device, dtype);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('El archivo no contiene una pista de audio.');
  if (!(await track.canDecode())) throw new Error(`Este navegador no puede decodificar el códec de audio (${track.codec}).`);
  const duration = await input.computeDuration();
  post('duration', { duration });

  const sink = new AudioSampleSink(track);
  const acc = new Accumulator();
  let resampler = null, first = true, offset = startAt, t0 = performance.now(), audioDone = 0;

  const flush = async (final) => {
    for (;;) {
      if (final ? acc.length <= SR / 4 : acc.length < (SEGMENT_S + 2) * SR) return false;
      const n = acc.length >= SEGMENT_S * SR ? quietCut(acc, SEGMENT_S * SR) : acc.length;
      const audio = acc.take(n);
      const seg = await transcribeSegment(audio, offset, { language });
      offset = seg.e; audioDone += audio.length / SR;
      post('segment', { seg, processed: offset, speed: audioDone / ((performance.now() - t0) / 1000) });
      if (stopRequested) return true;
    }
  };

  for await (const sample of sink.samples(startAt)) {
    try {
      if (!resampler) resampler = new Resampler(sample.sampleRate);
      const ch = sample.numberOfChannels, n = sample.numberOfFrames;
      let skip = 0;
      if (first) { skip = Math.max(0, Math.min(n, Math.round((startAt - sample.timestamp) * sample.sampleRate))); first = false; }
      const mono = new Float32Array(n);
      const tmp = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        sample.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch;
      }
      acc.push(resampler.push(skip ? mono.subarray(skip) : mono));
    } finally { sample.close(); }
    if (acc.length >= (SEGMENT_S + 2) * SR && await flush(false)) { post('stopped', { processed: offset }); return; }
  }
  if (await flush(true)) { post('stopped', { processed: offset }); return; }
  post('done', { processed: offset });
}

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { stopRequested = true; return; }
  if (data.type === 'start') {
    try { await run(data); }
    catch (err) { post('error', { message: err?.message || String(err) }); }
  }
};
