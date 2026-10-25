// 模型下載、快取與推論。瀏覽器（Web Worker）與 Node.js 測試共用。
import { G2PW } from './g2pw-core.js';

const CACHE_PREFIX = 'zhuyin-model-';
const BATCH = 16;

async function sha256Hex(buf) {
  if (!globalThis.crypto?.subtle) return null;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function openCache(version, cacheApi) {
  if (!cacheApi) return null;
  try {
    const name = CACHE_PREFIX + version;
    const cache = await cacheApi.open(name);
    // 刪掉舊版本模型
    for (const k of await cacheApi.keys()) if (k.startsWith(CACHE_PREFIX) && k !== name) await cacheApi.delete(k);
    return cache;
  } catch { return null; }
}

// 下載一個檔案（有快取就用快取），回報下載進度
async function getFile(url, { cache, fetchImpl, expectSize, expectSha, onBytes }) {
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (!expectSize || buf.byteLength === expectSize) { onBytes?.(buf.byteLength, true); return buf; }
      }
    } catch { /* 快取讀不到就重新下載 */ }
  }
  const res = await fetchImpl(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`下載失敗（${res.status}）：${url}`);
  let buf;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.byteLength; onBytes?.(value.byteLength, false);
    }
    const u8 = new Uint8Array(got); let o = 0;
    for (const c of chunks) { u8.set(c, o); o += c.byteLength; }
    buf = u8.buffer;
  } else {
    buf = await res.arrayBuffer(); onBytes?.(buf.byteLength, false);
  }
  if (expectSize && buf.byteLength !== expectSize) throw new Error(`檔案大小不符：${url}`);
  if (expectSha) {
    const h = await sha256Hex(buf);
    if (h && h !== expectSha) throw new Error(`檔案內容檢查失敗，請重新整理再試：${url}`);
  }
  if (cache) { try { await cache.put(url, new Response(buf)); } catch { /* 空間不足時仍可使用 */ } }
  return buf;
}

// 取得模型清單；沒有網路時改用上次存下的清單
async function getManifest(baseUrl, fetchImpl, cacheApi) {
  const key = new URL('manifest.json', baseUrl).href;
  try {
    const r = await fetchImpl(key, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`manifest ${r.status}`);
    return await r.json();
  } catch (e) {
    if (cacheApi) {
      try {
        for (const k of await cacheApi.keys()) {
          if (!k.startsWith(CACHE_PREFIX)) continue;
          const hit = await (await cacheApi.open(k)).match(key);
          if (hit) return await hit.json();
        }
      } catch { /* ignore */ }
    }
    throw e;
  }
}

export async function isModelCached(baseUrl, { fetchImpl = fetch, cacheApi = globalThis.caches } = {}) {
  try {
    const manifest = await getManifest(baseUrl, fetchImpl, cacheApi);
    if (!cacheApi) return { cached: false, manifest };
    const cache = await cacheApi.open(CACHE_PREFIX + manifest.version);
    for (const p of manifest.parts) if (!(await cache.match(new URL(p.name, baseUrl).href))) return { cached: false, manifest };
    return { cached: true, manifest };
  } catch (e) { return { cached: false, manifest: null, error: String(e) }; }
}

export async function clearModelCache(cacheApi = globalThis.caches) {
  if (!cacheApi) return;
  for (const k of await cacheApi.keys()) if (k.startsWith(CACHE_PREFIX)) await cacheApi.delete(k);
}

export async function loadEngine({ ort, baseUrl, onProgress, fetchImpl = fetch, cacheApi = globalThis.caches, sessionOptions = {} }) {
  const manifest = await getManifest(baseUrl, fetchImpl, cacheApi);
  const cache = await openCache(manifest.version, cacheApi);
  const total = manifest.size;
  let loaded = 0, fromCache = true;
  const report = (n, cached) => { loaded += n; if (!cached) fromCache = false; onProgress?.({ phase: 'download', loaded, total, fromCache }); };

  const metaUrl = new URL(`meta.json?v=${manifest.version}`, baseUrl).href;
  const metaBuf = await getFile(metaUrl, { cache, fetchImpl });
  const meta = JSON.parse(new TextDecoder().decode(metaBuf));

  const model = new Uint8Array(total);
  let off = 0;
  for (const p of manifest.parts) {
    const buf = await getFile(new URL(p.name, baseUrl).href, { cache, fetchImpl, expectSize: p.size, expectSha: p.sha256, onBytes: report });
    model.set(new Uint8Array(buf), off); off += buf.byteLength;
  }
  if (cache) { try { await cache.put(new URL('manifest.json', baseUrl).href, new Response(JSON.stringify(manifest))); } catch { /* ignore */ } }
  onProgress?.({ phase: 'init', loaded: total, total, fromCache });
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions });
  const g = new G2PW(meta);
  const engine = new Engine(ort, session, g, manifest);
  onProgress?.({ phase: 'ready', loaded: total, total, fromCache });
  return engine;
}

export class Engine {
  constructor(ort, session, g2pw, manifest) {
    this.ort = ort; this.session = session; this.g = g2pw; this.manifest = manifest;
    this.memo = new Map(); // 同樣上下文的破音字不重算
  }

  async _run(queries) {
    const { ort, g } = this;
    const t = g.makeBatch(queries);
    const feeds = {
      input_ids: new ort.Tensor('int64', t.inputIds, [t.B, t.L]),
      token_type_ids: new ort.Tensor('int64', t.tokenType, [t.B, t.L]),
      attention_mask: new ort.Tensor('int64', t.attn, [t.B, t.L]),
      phoneme_mask: new ort.Tensor('float32', t.pmask, [t.B, t.N]),
      char_ids: new ort.Tensor('int64', t.charIds, [t.B]),
      position_ids: new ort.Tensor('int64', t.posIds, [t.B]),
    };
    const out = await this.session.run(feeds);
    const probs = out[this.session.outputNames[0]].data;
    return queries.map((q, b) => g.decode(probs, b, q.allowed));
  }

  // lines：字串陣列 → 每行每字的 { c, p, src, conf?, cands? }
  // hooks.onPlan({ lines, total })：開始判斷前，先給「每個字的初步結果」和破音字總數
  // hooks.onPartial({ results: [[行, 字, {p,conf,cands}], ...], done, total })：每判斷完一批就回報
  async convert(lines, onProgress, hooks = {}) {
    if (this.memo.size > 20000) this.memo.clear();
    const prepared = lines.map(l => this.g.prepareLine(l));
    const posOf = new Map(); // key → 文字中所有出現的位置
    let total = 0;
    prepared.forEach((pl, li) => pl.queries.forEach(q => {
      total++;
      if (!posOf.has(q.key)) posOf.set(q.key, []);
      posOf.get(q.key).push([li, q.index]);
    }));
    hooks.onPlan?.({ lines: prepared.map(pl => pl.result), total });

    let done = 0;
    const report = (keys) => {
      if (!hooks.onPartial || !keys.length) return;
      const results = [];
      for (const k of keys) { const d = this.memo.get(k); for (const [li, ci] of posOf.get(k)) results.push([li, ci, { p: d.p, conf: d.conf, cands: d.cands }]); }
      done += results.length;
      hooks.onPartial({ results, done, total });
    };

    // 之前判斷過的直接回報；其餘照文章順序判斷，畫面會由上往下更新
    const todo = new Map();
    const cached = [];
    for (const pl of prepared) for (const q of pl.queries) {
      if (this.memo.has(q.key)) { if (!cached.includes(q.key) && !todo.has(q.key)) cached.push(q.key); }
      else if (!todo.has(q.key)) todo.set(q.key, q);
    }
    report(cached);
    const list = [...todo.values()];
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const res = await this._run(batch);
      batch.forEach((q, k) => this.memo.set(q.key, res[k]));
      onProgress?.({ done: Math.min(i + BATCH, list.length), total: list.length });
      report(batch.map(q => q.key));
    }
    return prepared.map(pl => {
      const out = pl.result.map(r => ({ ...r }));
      for (const q of pl.queries) {
        const d = this.memo.get(q.key);
        Object.assign(out[q.index], { p: d.p, conf: d.conf, cands: d.cands });
      }
      return out;
    });
  }
}
