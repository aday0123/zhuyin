// 「看注音寫國字」學習單：直書排版，生字挖空成田字格，旁邊保留注音
import { splitPron, parsePron } from './g2pw-core.js';

const STORE = 'zhuyin-worksheet-v1';
const NUMS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const CHECK_BELOW = 0.9;
const IVS_ALL = /[\u{E0100}-\u{E01EF}]/gu;
const HAN = /^\p{Script=Han}$/u;
const PT = 0.3528;                                     // 1 點 = 0.3528 mm
const OLD_SIZES = { s: 22, m: 28, l: 34 };             // 舊版存的「小中大」換成點數
const sizePt = (v) => { const n = Number(OLD_SIZES[v] ?? v); return n >= 14 && n <= 60 ? n : 28; };
const PAGE = { portrait: [210, 297], landscape: [297, 210] };
const MARGIN = 10, SIDEBAR = 16;                       // mm

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const vs = (i) => (i > 0 ? String.fromCodePoint(0xE01E0 + i) : '');
const isPunct = (c) => /^[\p{P}\p{S}]$/u.test(c);

// 注音直排：符號一欄，聲調放在右邊、對齊整串符號的正中間
function zyStack(p) {
  const sp = splitPron(p);
  if (!sp) return '';
  const mark = { 2: 'ˊ', 3: 'ˇ', 4: 'ˋ' }[sp.tone] || '';
  const dot = sp.tone === '5' ? '<b class="qs">˙</b>' : '';
  const syms = Array.from(sp.base).map((c) => `<i>${esc(c)}</i>`).join('');
  return `<span class="sy">${dot}${syms}</span>${mark ? `<b class="tm">${mark}</b>` : ''}`;
}

export function setupWorksheet({ call, ensureModel, loadFontData, fontData, waitFont, setStats }) {
  const ws = { tokens: [], data: null, menuFor: null };

  // ---------- 字級選單：14～60 點，另外標出小、中、大 ----------
  const sizeOpts = Array.from({ length: 24 }, (_, k) => 14 + k * 2).map((n) => {
    const tag = { 22: '（小）', 28: '（中）', 34: '（大）' }[n] || '';
    return `<option value="${n}"${n === 28 ? ' selected' : ''}>${n}${tag}</option>`;
  }).join('');
  $('wsSize').innerHTML = sizeOpts;
  $('wsSizeView').innerHTML = sizeOpts;

  // ---------- 輸入視窗 ----------
  const rows = $('wsRows');
  rows.innerHTML = NUMS.map((n, i) => `
    <tr>
      <th scope="row">第${n}課</th>
      <td><textarea id="wsText${i}" rows="3" aria-label="第${n}課 課文或語詞" placeholder="${i === 0 ? '例：美麗。唾沫。忠實。守衛。' : ''}"></textarea></td>
      <td><textarea id="wsChars${i}" rows="3" aria-label="第${n}課 生字" placeholder="${i === 0 ? '例：麗沫忠衛' : ''}"></textarea></td>
    </tr>`).join('');

  function readForm() {
    return {
      title: $('wsTitle').value.trim(),
      size: $('wsSize').value,
      orient: document.querySelector('input[name="wsOrient"]:checked')?.value || 'landscape',
      dir: document.querySelector('input[name="wsDir"]:checked')?.value || 'v',
      lessons: NUMS.map((_, i) => ({ text: $(`wsText${i}`).value, chars: $(`wsChars${i}`).value })),
    };
  }
  function writeForm(d) {
    if (!d) return;
    $('wsTitle').value = d.title || '';
    if (d.size) $('wsSize').value = String(sizePt(d.size));
    const o = document.querySelector(`input[name="wsOrient"][value="${d.orient}"]`);
    if (o) o.checked = true;
    const dr = document.querySelector(`input[name="wsDir"][value="${d.dir || 'v'}"]`);
    if (dr) dr.checked = true;
    (d.lessons || []).forEach((l, i) => { if ($(`wsText${i}`)) { $(`wsText${i}`).value = l.text || ''; $(`wsChars${i}`).value = l.chars || ''; } });
  }
  const saveForm = () => { try { localStorage.setItem(STORE, JSON.stringify(readForm())); } catch { /* ignore */ } };
  try { writeForm(JSON.parse(localStorage.getItem(STORE) || 'null')); } catch { /* ignore */ }

  $('wsDialog').addEventListener('input', () => { clearTimeout(saveForm.t); saveForm.t = setTimeout(saveForm, 400); });
  $('wsOpenBtn').addEventListener('click', () => { $('wsDialog').hidden = false; $('wsMsg').textContent = ''; $('wsTitle').focus(); });
  $('wsCancel').addEventListener('click', () => { $('wsDialog').hidden = true; });
  $('wsClear').addEventListener('click', () => {
    if (!confirm('要清除表格裡所有的課文和生字嗎？')) return;
    NUMS.forEach((_, i) => { $(`wsText${i}`).value = ''; $(`wsChars${i}`).value = ''; });
    saveForm();
  });
  // 從 Excel／Google 試算表複製兩欄（課文、生字）貼上，自動往下填滿表格
  function parseTSV(text) {
    const out = []; let row = [], cell = '', i = 0, q = false;
    text = text.replace(/\r\n?/g, '\n');
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        if (c === '"') { q = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"' && cell === '') { q = true; i++; continue; }
      if (c === '\t') { row.push(cell); cell = ''; i++; continue; }
      if (c === '\n') { row.push(cell); out.push(row); row = []; cell = ''; i++; continue; }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter((r) => r.some((x) => x.trim()));
  }
  rows.addEventListener('paste', (e) => {
    const ta = e.target.closest('textarea');
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!ta || !text.includes('\t')) return;           // 一般貼上（沒有 Tab）照原本方式
    e.preventDefault();
    const m = ta.id.match(/^ws(Text|Chars)(\d+)$/);
    const startRow = Number(m[2]), startCol = m[1] === 'Text' ? 0 : 1;
    const data = parseTSV(text);
    let n = 0;
    data.forEach((r, k) => {
      const ri = startRow + k;
      if (ri >= NUMS.length) return;
      r.slice(0, 2 - startCol).forEach((v, c) => {
        $(`${startCol + c === 0 ? 'wsText' : 'wsChars'}${ri}`).value = v.trim();
      });
      n++;
    });
    const over = data.length - n;
    $('wsMsg').textContent = `已填入 ${n} 課。` + (over > 0 ? `還有 ${over} 列超過第十二課，沒有填入。` : '');
    saveForm();
  });

  $('wsDialog').addEventListener('keydown', (e) => { if (e.key === 'Escape') $('wsDialog').hidden = true; });

  // 每一課的文字：換行當作分隔，沒有標點的行尾補「。」
  function lessonText(t) {
    return t.replace(/\r\n?/g, '\n').replace(IVS_ALL, '').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => (isPunct(Array.from(l).pop()) ? l : l + '。')).join('');
  }

  $('wsMake').addEventListener('click', async () => {
    const d = readForm();
    saveForm();
    const lessons = d.lessons.map((l, i) => ({ num: NUMS[i], text: lessonText(l.text), chars: new Set(Array.from(l.chars).filter((c) => HAN.test(c))) }))
      .filter((l) => l.text);
    if (!lessons.length) { $('wsMsg').textContent = '請至少輸入一課的課文或語詞。'; return; }
    const missing = lessons.filter((l) => !l.chars.size).map((l) => `第${l.num}課`);
    $('wsMake').disabled = true;
    $('wsMsg').textContent = '判斷讀音中…';
    try {
      if (!(await ensureModel())) { $('wsMsg').textContent = '模型還沒準備好，請先下載模型。'; return; }
      await loadFontData();
      await waitFont();
      const res = await call('convert', { lines: lessons.map((l) => l.text) });
      ws.tokens = [];
      lessons.forEach((l, li) => {
        Array.from(l.num).forEach((c, k) => ws.tokens.push({ kind: k ? 'num2' : 'num', c, p: null }));
        res.lines[li].forEach((r) => {
          ws.tokens.push({
            kind: 'char', c: r.c, p: r.p, conf: r.src === 'model' && r.cands?.length > 1 ? r.conf : 1,
            hide: l.chars.has(r.c) && !!r.p,
          });
        });
      });
      ws.data = d;
      $('wsDialog').hidden = true;
      $('wsOrientView').value = d.orient;
      $('wsDirView').value = d.dir || 'v';
      $('wsSizeView').value = String(sizePt(d.size));
      openView();
      const notFound = lessons.flatMap((l) => [...l.chars].filter((c) => !l.text.includes(c)).map((c) => `第${l.num}課「${c}」`));
      let msg = '請先檢查讀音（紅字是生字）。點字可以換讀音，有紅框的字建議優先確認。改好後按右邊的按鈕輸出作業單。';
      if (missing.length) msg = `${missing.join('、')} 沒有填生字，這幾課不會挖空。` + msg;
      if (notFound.length) msg = `這些生字在課文裡找不到：${notFound.slice(0, 6).join('、')}${notFound.length > 6 ? '…' : ''}。` + msg;
      $('wsNote').textContent = msg;
    } catch (e) {
      $('wsMsg').textContent = '產生失敗：' + e.message;
    } finally {
      $('wsMake').disabled = false;
    }
  });

  // ---------- 排版 ----------
  function idxOf(c, p) {
    const list = fontData.readings[c];
    if (!list || !p) return 0;
    return Math.max(0, list.indexOf(splitPron(p).text));
  }

  // dir: 'v' 直書（由右往左一行一行）、'h' 橫書（由上往下一列一列）
  const OPENERS = /^[（(「『《〈【［\[｛{〔“‘]$/u;
  function layout() {
    const [pw, ph] = PAGE[ws.data.orient];
    const s = sizePt(ws.data.size) * PT;
    const v = ws.data.dir !== 'h';
    // 直書：cellH = 每格高、lineW = 每行寬；橫書：cellH = 每格寬、lineW = 每列高
    const cellH = v ? s * 1.22 : s * 1.62;
    const lineW = v ? s * 1.72 : s * 1.5;
    const along = v ? ph - 2 * MARGIN : pw - 2 * MARGIN - cellH;     // 橫書留一格給行尾標點
    const across = (v ? pw : ph) - 2 * MARGIN - SIDEBAR - 3;
    const nRows = Math.max(4, Math.floor(along / cellH));
    const gap = lineW * 0.6;                                          // 每一課之間空一點
    const pages = [];
    let cols = [], col = [], used = 0;
    const pushCol = () => {
      if (!col.length) return;
      let need = lineW + (col.ls && cols.length ? gap : 0);
      if (cols.length && used + need > across + 0.01) { pages.push(cols); cols = []; used = 0; need = lineW; }
      cols.push(col); used += need;
      col = [];
    };
    ws.tokens.forEach((t, i) => {
      if (t.kind === 'num') { pushCol(); col.ls = true; }
      if (col.length >= nRows) {
        if (t.kind === 'char' && isPunct(t.c) && !OPENERS.test(t.c) && col.length === nRows) { col.push(i); return; } // 標點不放行首
        pushCol();
      } else if (t.kind === 'char' && OPENERS.test(t.c) && col.length === nRows - 1) {
        pushCol();                                                                      // 前括號不放行尾
      }
      col.push(i);
    });
    pushCol();
    if (cols.length) pages.push(cols);
    return { pages, pw, ph, s, rowH: cellH, colW: lineW, nRows, v, gap };
  }

  // 直書時把標點換成直排用的字形（括號、引號、破折號、刪節號…）
  const VERT = {
    '（': '︵', '）': '︶', '(': '︵', ')': '︶', '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄',
    '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀', '【': '︻', '】': '︼', '［': '﹇', '］': '﹈', '[': '﹇', ']': '﹈',
    '｛': '︷', '｝': '︸', '{': '︷', '}': '︸', '〔': '︹', '〕': '︺', '“': '﹁', '”': '﹂', '‘': '﹃', '’': '﹄',
    '—': '︱', '－': '︱', '-': '︱', '…': '︙', '⋯': '︙', '：': '︰', ':': '︰', '；': '︔', ';': '︔',
    '_': '︳', '＿': '︳',
  };
  const ROTATE = /^[～~〜]$/u;                                      // 沒有直排字形的，轉 90 度
  const vChar = (c) => (ROTATE.test(c) ? `<span class="rot">${esc(c)}</span>` : esc(VERT[c] || c));
  const punctHTML = (c) => (ws.data.dir !== 'h' ? vChar(c) : esc(c));
  const sideText = (t, v) => Array.from(t).map((c) => `<span>${c === ' ' ? '&nbsp;' : v ? vChar(c) : esc(c)}</span>`).join('');

  // mode: 'zy2hz' 看注音寫國字、'hz2zy' 看國字寫注音、'ans' 答案卷
  function cellHTML(t, i, mode) {
    const red = t.kind === 'char' && t.conf < CHECK_BELOW ? ' low' : '';
    const pick = t.kind === 'char' && (fontData.readings[t.c]?.length || 0) > 1 ? ' pick' : '';
    if (t.kind === 'num' || t.kind === 'num2') return `<div class="wc num">${esc(t.c)}</div>`;
    if (t.hide && mode === 'zy2hz') {
      return `<div class="wc hid${red}${pick}" data-i="${i}"><span class="box"></span><span class="zy">${zyStack(t.p)}</span></div>`;
    }
    if (t.hide && mode === 'hz2zy') {
      return `<div class="wc zq${red}${pick}" data-i="${i}"><span class="hz">${esc(t.c)}\u{E01E0}</span><span class="zbox"></span></div>`;
    }
    if (!t.p) return `<div class="wc plain${isPunct(t.c) ? ' punct' : ''}">${isPunct(t.c) ? punctHTML(t.c) : esc(t.c)}</div>`;
    const ans = t.hide && mode === 'ans' ? ' ans' : '';
    return `<div class="wc ch${ans}${red}${pick}" data-i="${i}">${esc(t.c)}${vs(idxOf(t.c, t.p))}</div>`;
  }

  const MODES = { zy2hz: '看注音寫國字', hz2zy: '看國字寫注音', ans: '答案卷' };

  function pagesHTML(mode) {
    const L = layout();
    const base = ws.data.title || '';
    const title = base ? `${base}　${MODES[mode]}` : MODES[mode];
    return L.pages.map((cols, pi) => `
      <section class="wspage ${L.v ? 'v' : 'h'}" data-mode="${mode}" style="width:${L.pw}mm;height:${L.ph}mm;--s:${L.s}mm;--rh:${L.rowH}mm;--cw:${L.colW}mm;--gap:${L.gap}mm">
        <aside class="wsside"><span class="wst">${sideText(title, L.v)}</span>${mode === 'ans' ? '' : `<span class="wsn">${sideText('姓名', L.v)}</span>`}${L.pages.length > 1 ? `<span class="wsp">${pi + 1}/${L.pages.length}</span>` : ''}</aside>
        <div class="wscols">${cols.map((c, ci) => `<div class="wscol${c.ls && ci ? ' ls' : ''}">${c.map((i) => cellHTML(ws.tokens[i], i, mode)).join('')}</div>`).join('')}</div>
      </section>`).join('');
  }

  // 畫面上預覽一種；列印時把勾選的幾種接在一起
  function render(modes) {
    const list = modes || ['ans'];   // 畫面上先給答案卷，讓老師校對讀音
    $('wsPages').innerHTML = list.map(pagesHTML).join('');
    $('wsPageStyle').textContent = `@page { size: A4 ${ws.data.orient}; margin: 0; }`;
  }

  function openView() {
    render();
    $('wsView').hidden = false;
    document.body.classList.add('ws-open');
    $('wsPrint').focus();
  }
  function closeView() {
    closeMenu();
    $('wsView').hidden = true;
    document.body.classList.remove('ws-open');
    $('wsPageStyle').textContent = '';
  }

  $('wsClose').addEventListener('click', closeView);
  $('wsBack').addEventListener('click', () => { closeView(); $('wsDialog').hidden = false; });
  // 列印：先問要印哪幾種
  const PSTORE = 'zhuyin-worksheet-print';
  try { const saved = JSON.parse(localStorage.getItem(PSTORE) || 'null'); if (saved) Object.keys(MODES).forEach((m) => { $(`wsPm_${m}`).checked = saved.includes(m); }); } catch { /* ignore */ }
  $('wsPrint').addEventListener('click', () => { closeMenu(); $('wsPrintMsg').textContent = ''; $('wsPrintDlg').hidden = false; $('wsPrintGo').focus(); });
  $('wsPrintCancel').addEventListener('click', () => { $('wsPrintDlg').hidden = true; });
  $('wsPrintGo').addEventListener('click', () => {
    const modes = Object.keys(MODES).filter((m) => $(`wsPm_${m}`).checked);
    if (!modes.length) { $('wsPrintMsg').textContent = '請至少勾選一種。'; return; }
    try { localStorage.setItem(PSTORE, JSON.stringify(modes)); } catch { /* ignore */ }
    $('wsPrintDlg').hidden = true;
    render(modes);
    setTimeout(() => { window.print(); render(); }, 50);
  });

  $('wsDirView').addEventListener('change', () => { ws.data.dir = $('wsDirView').value; closeMenu(); render(); });
  $('wsOrientView').addEventListener('change', () => { ws.data.orient = $('wsOrientView').value; render(); });
  $('wsSizeView').addEventListener('change', () => { ws.data.size = $('wsSizeView').value; render(); });
  $('wsView').addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('wsPrintDlg').hidden) $('wsPrintDlg').hidden = true; else if (!$('wsMenu').hidden) closeMenu(); else closeView(); } });

  // ---------- 點字換讀音 ----------
  function closeMenu() { $('wsMenu').hidden = true; ws.menuFor = null; }
  $('wsPages').addEventListener('click', (e) => {
    const el = e.target.closest('.wc.pick');
    if (!$('wsPrintDlg').hidden) return;
    if (!el) { closeMenu(); return; }
    const i = Number(el.dataset.i), t = ws.tokens[i];
    const list = fontData.readings[t.c] || [];
    const cur = splitPron(t.p)?.text;
    $('wsMenu').innerHTML = `<p class="wsm-h">「${esc(t.c)}」要讀哪一個音？</p>` + list.map((r, k) =>
      `<button type="button" data-k="${k}" aria-pressed="${r === cur}"><span class="wsm-c">${esc(t.c)}${vs(k)}</span>${esc(r)}</button>`).join('');
    const m = $('wsMenu');
    m.hidden = false;
    const rect = el.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(rect.right + 6, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - m.offsetHeight - 8))}px`;
    ws.menuFor = i;
    m.querySelector('[aria-pressed="true"]')?.focus();
  });
  $('wsMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || ws.menuFor == null) return;
    const t = ws.tokens[ws.menuFor];
    t.p = parsePron(fontData.readings[t.c][Number(b.dataset.k)]);
    t.conf = 1;
    closeMenu();
    render();
  });
}
