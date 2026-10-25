// 「看注音寫國字」學習單：直書排版，生字挖空成田字格，旁邊保留注音
import { splitPron, parsePron } from './g2pw-core.js';

const STORE = 'zhuyin-worksheet-v1';
const NUMS = ['一', '二', '三', '四', '五', '六'];
const CHECK_BELOW = 0.9;
const IVS_ALL = /[\u{E0100}-\u{E01EF}]/gu;
const HAN = /^\p{Script=Han}$/u;
const SIZES = { s: 8, m: 10, l: 12 };                 // 國字大小（mm）
const PAGE = { portrait: [210, 297], landscape: [297, 210] };
const MARGIN = 10, SIDEBAR = 16;                       // mm

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const vs = (i) => (i > 0 ? String.fromCodePoint(0xE01E0 + i) : '');
const vText = (t) => Array.from(t).map((c) => `<span>${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('');
const isPunct = (c) => /^[\p{P}\p{S}]$/u.test(c);

function zyStack(p) {
  const sp = splitPron(p);
  if (!sp) return '';
  const syms = Array.from(sp.base);
  const mark = { 2: 'ˊ', 3: 'ˇ', 4: 'ˋ' }[sp.tone] || '';
  let h = sp.tone === '5' ? '<b class="qs">˙</b>' : '';
  syms.forEach((s, i) => { h += `<i>${esc(s)}${i === syms.length - 1 && mark ? `<b class="tn">${mark}</b>` : ''}</i>`; });
  return h;
}

export function setupWorksheet({ call, ensureModel, loadFontData, fontData, waitFont, setStats }) {
  const ws = { tokens: [], data: null, menuFor: null };

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
      lessons: NUMS.map((_, i) => ({ text: $(`wsText${i}`).value, chars: $(`wsChars${i}`).value })),
    };
  }
  function writeForm(d) {
    if (!d) return;
    $('wsTitle').value = d.title || '';
    if (d.size) $('wsSize').value = d.size;
    const o = document.querySelector(`input[name="wsOrient"][value="${d.orient}"]`);
    if (o) o.checked = true;
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
        ws.tokens.push({ kind: 'num', c: l.num, p: null });
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
      $('wsSizeView').value = d.size;
      openView();
      const notFound = lessons.flatMap((l) => [...l.chars].filter((c) => !l.text.includes(c)).map((c) => `第${l.num}課「${c}」`));
      let msg = '點有紅框的字可以確認讀音，也可以點任何多音字換讀音。';
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

  function layout() {
    const [pw, ph] = PAGE[ws.data.orient];
    const s = SIZES[ws.data.size] || SIZES.m;
    const rowH = s * 1.22, colW = s * 1.72;
    const nRows = Math.max(4, Math.floor((ph - 2 * MARGIN) / rowH));
    const nCols = Math.max(2, Math.floor((pw - 2 * MARGIN - SIDEBAR - 3) / colW));
    const pages = [];
    let cols = [], col = [];
    const pushCol = () => { if (col.length) cols.push(col); col = []; if (cols.length === nCols) { pages.push(cols); cols = []; } };
    ws.tokens.forEach((t, i) => {
      if (t.kind === 'num') { pushCol(); }
      if (col.length >= nRows) {
        if (t.kind === 'char' && isPunct(t.c) && col.length === nRows) { col.push(i); return; } // 標點不放行首
        pushCol();
      }
      col.push(i);
    });
    pushCol();
    if (cols.length) pages.push(cols);
    return { pages, pw, ph, s, rowH, colW, nRows };
  }

  function cellHTML(t, i) {
    const red = t.kind === 'char' && t.conf < CHECK_BELOW ? ' low' : '';
    const pick = t.kind === 'char' && (fontData.readings[t.c]?.length || 0) > 1 ? ' pick' : '';
    if (t.kind === 'num') return `<div class="wc num">${esc(t.c)}</div>`;
    if (t.hide) {
      return `<div class="wc hid${red}${pick}" data-i="${i}"><span class="box"></span><span class="zy">${zyStack(t.p)}</span></div>`;
    }
    if (!t.p) return `<div class="wc plain${isPunct(t.c) ? ' punct' : ''}">${esc(t.c)}</div>`;
    return `<div class="wc ch${red}${pick}" data-i="${i}">${esc(t.c)}${vs(idxOf(t.c, t.p))}</div>`;
  }

  function render() {
    const L = layout();
    const title = ws.data.title || '看注音寫國字';
    $('wsPages').innerHTML = L.pages.map((cols, pi) => `
      <section class="wspage" style="width:${L.pw}mm;height:${L.ph}mm;--s:${L.s}mm;--rh:${L.rowH}mm;--cw:${L.colW}mm">
        <aside class="wsside"><span class="wst">${vText(title)}</span><span class="wsn">${vText('姓名')}</span>${L.pages.length > 1 ? `<span class="wsp">${pi + 1}/${L.pages.length}</span>` : ''}</aside>
        <div class="wscols">${cols.map((c) => `<div class="wscol">${c.map((i) => cellHTML(ws.tokens[i], i)).join('')}</div>`).join('')}</div>
      </section>`).join('');
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
  $('wsPrint').addEventListener('click', () => { closeMenu(); window.print(); });
  $('wsOrientView').addEventListener('change', () => { ws.data.orient = $('wsOrientView').value; render(); });
  $('wsSizeView').addEventListener('change', () => { ws.data.size = $('wsSizeView').value; render(); });
  $('wsView').addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('wsMenu').hidden) closeMenu(); else closeView(); } });

  // ---------- 點字換讀音 ----------
  function closeMenu() { $('wsMenu').hidden = true; ws.menuFor = null; }
  $('wsPages').addEventListener('click', (e) => {
    const el = e.target.closest('.wc.pick');
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
