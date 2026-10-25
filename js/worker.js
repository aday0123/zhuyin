// 在背景執行模型，避免網頁卡住
import * as ort from '../vendor/ort/ort.wasm.min.js';
import { loadEngine, isModelCached, clearModelCache } from './engine.js';

const base = new URL('../model/', import.meta.url);
// 用 .js 副檔名：有些伺服器（例如 Windows 上的 py -m http.server）會把 .mjs 當成純文字，瀏覽器就不肯執行
ort.env.wasm.wasmPaths = {
  mjs: new URL('../vendor/ort/ort-wasm-simd-threaded.js', import.meta.url).href,
  wasm: new URL('../vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

let engine = null;
let loading = null;

function post(type, data = {}) { self.postMessage({ type, ...data }); }

async function ensureEngine() {
  if (engine) return engine;
  if (!loading) {
    loading = loadEngine({
      ort, baseUrl: base,
      onProgress: p => post('progress', p),
    }).then(e => {
      engine = e;
      post('ready', { version: e.manifest.version, size: e.manifest.size, threads: ort.env.wasm.numThreads });
      return e;
    }).catch(err => { loading = null; throw err; });
  }
  return loading;
}

self.onmessage = async (ev) => {
  const { type, id } = ev.data;
  try {
    if (type === 'status') {
      const s = await isModelCached(base);
      post('status', { id, cached: s.cached, size: s.manifest?.size ?? null, error: s.error ?? null });
    } else if (type === 'load') {
      await ensureEngine();
      post('loaded', { id });
    } else if (type === 'convert') {
      const e = await ensureEngine();
      const t0 = performance.now();
      const lines = await e.convert(ev.data.lines, null, {
        onPlan: (p) => post('plan', { id, ...p }),
        onPartial: (p) => post('partial', { id, ...p }),
      });
      post('converted', { id, lines, ms: Math.round(performance.now() - t0) });
    } else if (type === 'readings') {
      const e = await ensureEngine();
      post('readings', { id, list: e.g.allReadings(ev.data.char) });
    } else if (type === 'selftest') {
      const e = await ensureEngine();
      const tests = await (await fetch(new URL('selftest.json', base), { cache: 'no-cache' })).json();
      const res = await e.convert(tests.map(t => t.text));
      let n = 0; const bad = [];
      tests.forEach((t, i) => {
        const cs = Array.from(t.text);
        t.pron.forEach((p, j) => {
          n++;
          if ((res[i][j].p ?? null) !== (p ?? null)) bad.push({ text: t.text, c: cs[j], got: res[i][j].p, want: p });
        });
      });
      post('selftest', { id, total: n, bad });
    } else if (type === 'clear') {
      engine = null; loading = null;
      await clearModelCache();
      post('cleared', { id });
    }
  } catch (err) {
    post('error', { id, message: String(err?.message || err) });
  }
};
