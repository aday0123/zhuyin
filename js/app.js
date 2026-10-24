import { splitPron, parsePron } from './g2pw-core.js';

const $ = (id) => document.getElementById(id);
const CHECK_BELOW = 0.9;            // 模型信心低於這個值就標黃色
const STORE_KEY = 'zhuyin-notebook-v1';
const PUNCT_RE = /^[\p{P}\p{S}　]$/u;

const state = {
  ready: false,
  lines: null,          // 最近一次的結果
  srcLines: [],
  overrides: {},        // "行:字位置:字" → 讀音（ㄏㄤ2）
  active: null,
  mode: 'font',         // font：字嗨注音標楷（可複製到 Word）；css：網頁自己排注音
};

// ---------- 注音字型（字嗨注音標楷，注音 IVS 規格）----------
// 同一個字的第 N 個讀音 = 字 + 異體字選擇子 U+E01E0+N（第 0 個是預設，不用加）
const WORD_FONT = "'ㄅ字嗨注音標楷','Bpmf Zihi Kai Std'";
const fontData = { readings: {}, covered: new Set(), loaded: null };
function loadFontData() {
  if (!fontData.loaded) {
    fontData.loaded = fetch(new URL('../fonts/bpmf-readings.json', import.meta.url))
      .then(r => r.json())
      .then(d => { fontData.readings = d.readings; fontData.covered = new Set(Array.from(d.covered)); })
      .catch(() => { /* 讀不到就只用網頁排版 */ });
  }
  return fontData.loaded;
}
function fontIndex(c, p) {
  const list = fontData.readings[c];
  if (!list) return { idx: 0, ok: fontData.covered.has(c) };
  const idx = list.indexOf(splitPron(p).text);
  return { idx: Math.max(idx, 0), ok: idx >= 0 };
}
const vsFor = (idx) => (idx > 0 ? String.fromCodePoint(0xE01E0 + idx) : '');
const HAN_RE = /^[\p{Script=Han}]$/u;

// ---------- 背景模型 ----------
if (location.protocol === 'file:') {
  setChip('error', '請用網址開啟');
  $('sheet').innerHTML = '<p class="empty">這個網頁需要用網址開啟（例如 GitHub Pages），直接點兩下 HTML 檔無法載入模型。</p>';
  throw new Error('file protocol');
}
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
function call(type, data = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...data });
  });
}
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'progress') return onDownloadProgress(m);
  if (m.type === 'convertProgress') return setStats(`判斷破音字中… ${m.done} / ${m.total}`);
  if (m.type === 'ready') { state.ready = true; setChip('ready', '模型已就緒'); $('downloadBox').hidden = true; return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m);
};
worker.onerror = (e) => {
  setChip('error', '模型無法啟動');
  setStats('模型程式無法啟動。請用 Chrome 或 Edge 開啟；若是在自己電腦測試，請用 py tools\\serve.py 開啟網頁。');
  for (const p of pending.values()) p.reject(new Error('模型程式無法啟動'));
  pending.clear();
};

function setChip(s, text) { const c = $('modelChip'); c.dataset.state = s; c.textContent = text; }
function setStats(text) { $('stats').textContent = text; }
const mb = (n) => (n / 1e6).toFixed(0);

function onDownloadProgress(p) {
  const box = $('progress');
  if (p.phase === 'download' && !p.fromCache) {
    box.hidden = false;
    $('pgTitle').textContent = '下載破音字模型';
    $('pgFill').style.width = `${(100 * p.loaded / p.total).toFixed(1)}%`;
    $('pgText').textContent = `${mb(p.loaded)} / ${mb(p.total)} MB`;
  } else if (p.phase === 'init') {
    if (!box.hidden) { $('pgFill').style.width = '100%'; $('pgText').textContent = '啟動模型中…'; }
    setChip('idle', '模型啟動中…');
  } else if (p.phase === 'ready') {
    box.hidden = true;
  } else if (p.phase === 'download' && p.fromCache) {
    setChip('idle', '從這台電腦讀取模型…');
  }
}

async function ensureModel() {
  if (state.ready) return true;
  setChip('idle', '模型載入中…');
  try {
    await call('load');
    try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
    return true;
  } catch (e) {
    $('progress').hidden = true;
    setChip('error', '模型載入失敗');
    setStats(`模型載入失敗：${e.message}。請確認網路後重新整理頁面。`);
    return false;
  }
}

async function init() {
  restore();
  loadFontData();
  try {
    const s = await call('status');
    if (s.cached) {
      ensureModel();
    } else if (s.size) {
      $('dlSize').textContent = mb(s.size);
      $('downloadBox').hidden = false;
      setChip('idle', '尚未下載模型');
    } else {
      setChip('error', '找不到模型檔');
      setStats('找不到 model 資料夾裡的模型檔，請確認已經上傳 model 資料夾。');
    }
  } catch (e) {
    setChip('error', '模型檢查失敗');
  }
}

// ---------- 加注音 ----------
async function run() {
  const text = $('src').value.replace(/\r\n?/g, '\n');
  save();
  if (!text.trim()) { setStats('請先貼上文章。'); return; }
  $('runBtn').disabled = true;
  try {
    if (!(await ensureModel())) return;
    setStats('判斷破音字中…');
    const srcLines = text.split('\n');
    const res = await call('convert', { lines: srcLines });
    // 文字改過的位置，舊的手動讀音就不再套用
    for (const k of Object.keys(state.overrides)) {
      const [li, ci, ch] = k.split(':');
      if (Array.from(srcLines[+li] ?? '')[+ci] !== ch) delete state.overrides[k];
    }
    state.srcLines = srcLines;
    state.lines = res.lines;
    if (state.mode === 'font') await waitFont();
    render();
    save();
    $('printBtn').disabled = false;
    $('copyBtn').disabled = false;
    setStats(`完成，花了 ${(res.ms / 1000).toFixed(1)} 秒。` + countText());
  } catch (e) {
    setStats('處理失敗：' + e.message);
  } finally {
    $('runBtn').disabled = false;
  }
}

function counts() {
  let poly = 0, check = 0, nofont = 0;
  state.lines?.forEach((line, li) => line.forEach((r, ci) => {
    if (isPoly(r)) { poly++; if (needsCheck(r, li, ci)) check++; }
    const p = state.overrides[keyOf(li, ci, r.c)] || r.p;
    if (state.mode === 'font' && p && !fontIndex(r.c, p).ok) nofont++;
  }));
  return { poly, check, nofont };
}
function countText() {
  const { poly, check, nofont } = counts();
  return `破音字 ${poly} 個（黃框），點字可以改讀音；其中 ${check} 個模型較不確定（紅框），建議優先檢查。` + (nofont ? `有 ${nofont} 個字的讀音字型無法顯示（紅色波浪線）。` : '');
}
const keyOf = (li, ci, c) => `${li}:${ci}:${c}`;
const isPoly = (r) => r.src === 'model' && r.cands && r.cands.length > 1;
const needsCheck = (r, li, ci) => isPoly(r) && r.conf < CHECK_BELOW && !(keyOf(li, ci, r.c) in state.overrides);

function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function zyHTML(p) {
  const sp = splitPron(p);
  if (!sp) return '';
  const syms = Array.from(sp.base);
  let h = sp.tone === '5' ? '<b class="qs">˙</b>' : '';
  const mark = { '2': 'ˊ', '3': 'ˇ', '4': 'ˋ' }[sp.tone] || '';
  syms.forEach((s, i) => {
    h += `<i>${esc(s)}${i === syms.length - 1 && mark ? `<b class="tn">${mark}</b>` : ''}</i>`;
  });
  return h;
}

function cellHTML(r, li, ci) {
  const k = keyOf(li, ci, r.c);
  const ov = state.overrides[k];
  const p = ov || r.p;
  if (state.mode === 'font') {
    if (!p) return `<span class="raw">${esc(r.c)}</span>`;
    const { idx, ok } = fontIndex(r.c, p);
    const cls = ['fc'];
    if (isPoly(r)) cls.push('poly');
    if (needsCheck(r, li, ci)) cls.push('check');
    if (ov) cls.push('edited');
    if (!ok) cls.push('nofont');
    const label = `${r.c} ${splitPron(p).text}${ok ? '' : '（字型沒有這個讀音）'}`;
    return `<span class="${cls.join(' ')}" data-k="${k}" tabindex="0" role="button" aria-label="${esc(label)}"${ok ? '' : ' title="字型沒有這個讀音，會顯示預設讀音"'}>${esc(r.c)}${vsFor(idx)}</span>`;
  }
  if (p) {
    const cls = ['cell'];
    if (isPoly(r)) cls.push('poly');
    if (needsCheck(r, li, ci)) cls.push('check');
    if (ov) cls.push('edited');
    const label = `${r.c} ${splitPron(p).text}`;
    return `<span class="${cls.join(' ')}" data-k="${k}" tabindex="0" role="button" aria-label="${esc(label)}"><span class="han">${esc(r.c)}</span><span class="zy" aria-hidden="true">${zyHTML(p)}</span></span>`;
  }
  if (PUNCT_RE.test(r.c) && r.c.codePointAt(0) > 0x2000) {
    return `<span class="cell punct"><span class="han">${esc(r.c)}</span><span class="zy"><i>ㄅ</i></span></span>`;
  }
  return `<span class="raw">${esc(r.c)}</span>`;
}

// 標點不放在行首：結尾標點黏住前一個字，開頭標點黏住後一個字
const CLOSE_P = new Set('，。、；：！？」』）》〉】…—’”,.;:!?)');
const OPEN_P = new Set('「『（《〈【‘“(');

function lineHTML(line, li) {
  const groups = [];
  let carry = [];
  line.forEach((r, ci) => {
    const h = cellHTML(r, li, ci);
    if (CLOSE_P.has(r.c) && groups.length && !carry.length) groups[groups.length - 1].push(h);
    else if (OPEN_P.has(r.c)) carry.push(h);
    else { groups.push([...carry, h]); carry = []; }
  });
  if (carry.length) groups.push(carry);
  return groups.map(g => g.length > 1 ? `<span class="grp">${g.join('')}</span>` : g[0]).join('');
}

function render() {
  const sheet = $('sheet');
  if (!state.lines) return;
  sheet.innerHTML = state.lines.map((line, li) =>
    line.length ? `<p class="ln">${lineHTML(line, li)}</p>` : '<p class="ln blank"></p>'
  ).join('');
}

function refreshCell(k) {
  const [li, ci] = k.split(':').map(Number);
  const r = state.lines[li][ci];
  const el = $('sheet').querySelector(`[data-k="${CSS.escape(k)}"]`);
  if (el) el.outerHTML = cellHTML(r, li, ci);
  setStats(countText());
}

// ---------- 點字換讀音 ----------
async function openPop(el) {
  closePop();
  const k = el.dataset.k;
  const [li, ci] = k.split(':').map(Number);
  const r = state.lines[li][ci];
  state.active = { el, k, r };
  el.classList.add('active');

  const chars = Array.from(state.srcLines[li] || '');
  $('popChar').textContent = r.c;
  $('popCtx').textContent = chars.slice(Math.max(0, ci - 4), ci + 5).join('');

  const current = state.overrides[k] || r.p;
  let list = (r.cands || []).map(c => ({ p: c.p, prob: c.prob }));
  try {
    const all = (await call('readings', { char: r.c })).list;
    for (const p of all) if (!list.some(x => x.p === p)) list.push({ p, prob: null });
  } catch { /* 只顯示模型候選 */ }
  if (state.mode === 'font') {
    const fl = fontData.readings[r.c];
    if (fl) {
      const probOf = (p) => list.find(x => x.p === p)?.prob ?? null;
      const fontList = fl.map(t => { const p = parsePron(t); return { p, prob: probOf(p) }; });
      const extra = list.filter(x => !fontList.some(f => f.p === x.p)).map(x => ({ ...x, disabled: true }));
      list = [...fontList, ...extra];
    }
  }
  if (!list.length && current) list = [{ p: current, prob: null }];

  $('popList').innerHTML = list.map(x =>
    `<button type="button" data-p="${esc(x.p)}" aria-pressed="${x.p === current}"${x.disabled ? ' disabled title="字型沒有這個讀音"' : ''}><span>${esc(splitPron(x.p).text)}${x.disabled ? '<small>字型無此音</small>' : ''}</span>${x.prob != null && isPoly(r) ? `<span class="pct">${Math.round(x.prob * 100)}%</span>` : ''}</button>`
  ).join('');
  $('popInput').value = '';
  $('popReset').hidden = !(k in state.overrides);

  const pop = $('pop');
  pop.hidden = false;
  const rect = el.getBoundingClientRect();
  const w = pop.offsetWidth;
  const left = Math.min(window.scrollX + rect.left, window.scrollX + document.documentElement.clientWidth - w - 8);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${window.scrollY + rect.bottom + 6}px`;
  pop.querySelector('[aria-pressed="true"]')?.focus() || pop.querySelector('button')?.focus();
}

function closePop(refocus = false) {
  const a = state.active;
  $('pop').hidden = true;
  if (a) {
    const el = $('sheet').querySelector(`[data-k="${CSS.escape(a.k)}"]`);
    el?.classList.remove('active');
    if (refocus) el?.focus();
  }
  state.active = null;
}

function applyReading(p) {
  const a = state.active;
  if (!a) return;
  if (!p || p === a.r.p) delete state.overrides[a.k];
  else state.overrides[a.k] = p;
  save();
  const k = a.k;
  closePop();
  refreshCell(k);
  $('sheet').querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus();
}

$('sheet').addEventListener('click', (e) => {
  const el = e.target.closest('[data-k]');
  if (el) openPop(el);
});
$('sheet').addEventListener('keydown', (e) => {
  const el = e.target.closest('[data-k]');
  if (el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPop(el); }
});
$('popList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (b) applyReading(b.dataset.p);
});
$('popForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = parsePron($('popInput').value);
  if (p) applyReading(p);
});
$('popReset').addEventListener('click', () => applyReading(null));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pop').hidden) closePop(true); });
document.addEventListener('pointerdown', (e) => {
  if (!$('pop').hidden && !e.target.closest('#pop') && !e.target.closest('#sheet [data-k]')) closePop();
});

// ---------- 設定與儲存 ----------
function applyView() {
  document.documentElement.style.setProperty('--fs', `${$('fontSize').value}px`);
  $('sheet').dataset.mark = $('markMode').value;
  state.mode = $('renderMode').value;
  $('sheet').classList.toggle('fontmode', state.mode === 'font');
  $('copyBtn').hidden = state.mode !== 'font';
}
async function waitFont() {
  await loadFontData();
  try { await document.fonts.load(`${$('fontSize').value}px BpmfZihiKai`, '注'); } catch { /* ignore */ }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      text: $('src').value, overrides: state.overrides,
      fontSize: $('fontSize').value, markMode: $('markMode').value, markV2: true, renderMode: $('renderMode').value,
    }));
  } catch { /* 無痕模式等情況存不了，不影響使用 */ }
}
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (d) {
      $('src').value = d.text || '';
      state.overrides = d.overrides || {};
      if (d.fontSize) $('fontSize').value = d.fontSize;
      if (d.markMode && d.markV2) $('markMode').value = d.markMode;
      if (d.renderMode) $('renderMode').value = d.renderMode;
    }
  } catch { /* ignore */ }
  applyView();
}

$('runBtn').addEventListener('click', run);
$('src').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });
$('src').addEventListener('input', () => { clearTimeout(save.t); save.t = setTimeout(save, 500); });
$('printBtn').addEventListener('click', () => { closePop(); window.print(); });
$('fontSize').addEventListener('change', () => { applyView(); save(); });
$('markMode').addEventListener('change', () => { applyView(); save(); });
$('renderMode').addEventListener('change', async () => {
  applyView(); save();
  if (state.mode === 'font') await waitFont();
  closePop(); render();
  if (state.lines) setStats(countText());
});

// ---------- 複製到 Word ----------
function ivsLines() {
  return state.lines.map((line, li) => line.map((r, ci) => {
    const p = state.overrides[keyOf(li, ci, r.c)] || r.p;
    return p ? r.c + vsFor(fontIndex(r.c, p).idx) : r.c;
  }).join(''));
}
async function copyToWord() {
  if (!state.lines) return;
  await loadFontData();
  const lines = ivsLines();
  const pt = Math.round($('fontSize').value * 0.6);
  const html = '<html><body>' + lines.map(l =>
    `<p style="margin:0 0 6pt 0;font-family:${WORD_FONT};font-size:${pt}pt">${l ? esc(l) : '&nbsp;'}</p>`).join('') + '</body></html>';
  const text = lines.join('\r\n');
  let ok = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    })]);
    ok = true;
  } catch {
    const box = document.createElement('div');
    box.contentEditable = 'true';
    box.style.cssText = 'position:fixed;left:-9999px;top:0';
    box.innerHTML = html;
    document.body.appendChild(box);
    const range = document.createRange(); range.selectNodeContents(box);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    sel.removeAllRanges(); box.remove();
  }
  $('copyTip').hidden = !ok;
  setStats(ok ? '已複製，可以貼到 Word 了。' : '複製失敗，請改用 Chrome 或 Edge 再試一次。');
}
$('copyBtn').addEventListener('click', copyToWord);
$('copyTipClose').addEventListener('click', () => { $('copyTip').hidden = true; });
$('dlBtn').addEventListener('click', async () => {
  $('dlBtn').disabled = true;
  await ensureModel();
  $('dlBtn').disabled = false;
});
$('testBtn').addEventListener('click', async () => {
  if (!(await ensureModel())) return;
  setStats('檢查模型中…');
  try {
    const r = await call('selftest');
    setStats(r.bad.length
      ? `檢查完成：${r.total} 個字中有 ${r.bad.length} 個和電腦版結果不同（例如「${r.bad[0].text}」的「${r.bad[0].c}」）。`
      : `檢查完成：${r.total} 個字和電腦版結果完全相同，模型正常。`);
  } catch (e) { setStats('檢查失敗：' + e.message); }
});
$('clearBtn').addEventListener('click', async () => {
  if (!confirm('要刪除這台電腦上已下載的模型嗎？下次使用時需要重新下載。')) return;
  await call('clear');
  state.ready = false;
  setChip('idle', '尚未下載模型');
  $('downloadBox').hidden = false;
  setStats('已刪除模型。');
});

init();
