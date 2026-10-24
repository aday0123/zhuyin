// g2pW 前處理與結果組合（移植自 g2pW 的 Python 版本：dataset.py、utils.py、api.py）
// 這個檔案不依賴瀏覽器，也能在 Node.js 裡測試。
// 原始專案：https://github.com/GitYCC/g2pW（Apache License 2.0）

const RE_SPACE = /^ +/u;
const RE_ALNUM = /^[a-zA-Z0-9]+/u;
const RE_MN = /\p{Mn}/gu;

function isWhitespace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || /^\p{Zs}$/u.test(c);
}
function isControl(c) {
  if (c === '\t' || c === '\n' || c === '\r') return false;
  return /^\p{C}$/u.test(c);
}
function isPunctuation(c) {
  const cp = c.codePointAt(0);
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /^\p{P}$/u.test(c);
}
function isChineseChar(cp) {
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) ||
    (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
    (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
}

// Python str.lower() 逐字對應（長度改變的極少數字元維持原樣，避免位置錯亂）
function lowerChars(chars) {
  return chars.map(c => {
    const l = c.toLowerCase();
    return Array.from(l).length === 1 ? l : c;
  });
}

export class G2PW {
  constructor(meta) {
    this.meta = meta;
    this.windowSize = meta.window_size || null;
    this.maxLen = meta.max_len || 512;
    this.useMask = meta.use_mask !== false;
    this.useCharPhoneme = !!meta.use_char_phoneme;
    this.lowercase = meta.lowercase !== false;
    this.labels = meta.labels;
    this.numLabels = meta.labels.length;
    this.chars = meta.chars;
    this.charIndex = new Map(meta.chars.map((c, i) => [c, i]));
    this.char2phonemes = meta.char2phonemes;
    this.mono = meta.mono || {};
    this.fallback = meta.fallback || {};
    this.alt = meta.alt || {};
    this.vocab = new Map(meta.vocab.map((t, i) => [t, i]));
    this.unkId = this.vocab.get('[UNK]');
    this.clsId = this.vocab.get('[CLS]');
    this.sepId = this.vocab.get('[SEP]');
  }

  isPolyphonic(c) { return this.charIndex.has(c); }

  // ---- BertTokenizer.tokenize（BasicTokenizer + WordPiece）----
  _basicTokenize(text) {
    let out = '';
    for (const c of text) {
      const cp = c.codePointAt(0);
      if (cp === 0 || cp === 0xFFFD || isControl(c)) continue;
      out += isWhitespace(c) ? ' ' : c;
    }
    let spaced = '';
    for (const c of out) spaced += isChineseChar(c.codePointAt(0)) ? ` ${c} ` : c;
    const result = [];
    for (let tok of spaced.normalize('NFC').trim().split(/ +/).filter(Boolean)) {
      if (this.lowercase) tok = tok.toLowerCase().normalize('NFD').replace(RE_MN, '');
      let cur = '';
      for (const c of tok) {
        if (isPunctuation(c)) { if (cur) result.push(cur); result.push(c); cur = ''; }
        else cur += c;
      }
      if (cur) result.push(cur);
    }
    return result.filter(Boolean);
  }

  _wordpiece(token) {
    const chars = Array.from(token);
    if (chars.length > 100) return ['[UNK]'];
    const out = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length, cur = null;
      while (start < end) {
        let sub = chars.slice(start, end).join('');
        if (start > 0) sub = '##' + sub;
        if (this.vocab.has(sub)) { cur = sub; break; }
        end--;
      }
      if (cur === null) return ['[UNK]'];
      out.push(cur);
      start = end;
    }
    return out;
  }

  tokenize(word) {
    const out = [];
    for (const t of this._basicTokenize(word)) out.push(...this._wordpiece(t));
    return out;
  }

  // ---- utils.wordize_and_map / tokenize_and_map（以「字元陣列」處理，避免 UTF-16 位置誤差）----
  _wordizeAndMap(chars) {
    const words = [], text2word = [], word2text = [];
    let pos = 0;
    while (pos < chars.length) {
      const rest = chars.slice(pos).join('');
      const ms = rest.match(RE_SPACE);
      if (ms) {
        const n = Array.from(ms[0]).length;
        for (let k = 0; k < n; k++) text2word.push(null);
        pos += n; continue;
      }
      const me = rest.match(RE_ALNUM);
      if (me) {
        const n = me[0].length;
        word2text.push([pos, pos + n]);
        for (let k = 0; k < n; k++) text2word.push(words.length);
        words.push(me[0]);
        pos += n;
      } else {
        word2text.push([pos, pos + 1]);
        text2word.push(words.length);
        words.push(chars[pos]);
        pos += 1;
      }
    }
    return { words, text2word, word2text };
  }

  tokenizeAndMap(chars) {
    const { words, text2word, word2text } = this._wordizeAndMap(chars);
    const tokens = [], token2text = [];
    words.forEach((word, wi) => {
      const [ws, we] = word2text[wi];
      const wt = this.tokenize(word);
      if (wt.length === 0 || (wt.length === 1 && wt[0] === '[UNK]')) {
        token2text.push([ws, we]);
        tokens.push('[UNK]');
      } else {
        let cur = ws;
        for (const t of wt) {
          const len = Array.from(t.replace(/^##/, '')).length;
          token2text.push([cur, cur + len]);
          cur += len;
          tokens.push(t);
        }
      }
    });
    const text2token = text2word.slice();
    token2text.forEach(([s, e], i) => { for (let p = s; p < e; p++) text2token[p] = i; });
    return { tokens, text2token, token2text };
  }

  _truncate(chars, q, tokens, text2token, token2text) {
    const L = this.maxLen - 2;
    if (tokens.length <= L) return { chars, q, tokens, text2token };
    const tp = text2token[q];
    let ts = tp - Math.floor(L / 2), te = ts + L;
    const front = -ts, back = te - tokens.length;
    if (front > 0) { ts += front; te += front; } else if (back > 0) { ts -= back; te -= back; }
    const start = token2text[ts][0], end = token2text[te - 1][1];
    return {
      chars: chars.slice(start, end),
      q: q - start,
      tokens: tokens.slice(ts, te),
      text2token: text2token.slice(start, end).map(i => (i === null || i === undefined) ? null : i - ts),
    };
  }

  // 一個破音字查詢 → 模型輸入（對應 TextDataset.__getitem__）
  buildQuery(sentChars, qid) {
    let chars = sentChars, q = qid;
    if (this.windowSize) {
      const half = Math.floor(this.windowSize / 2);
      const start = Math.max(0, qid - half);
      const end = Math.min(sentChars.length, qid + half);
      chars = sentChars.slice(start, end);
      q = qid - start;
    }
    chars = lowerChars(chars);
    let { tokens, text2token, token2text } = this.tokenizeAndMap(chars);
    ({ chars, q, tokens, text2token } = this._truncate(chars, q, tokens, text2token, token2text));
    const ids = [this.clsId, ...tokens.map(t => this.vocab.has(t) ? this.vocab.get(t) : this.unkId), this.sepId];
    const qc = chars[q];
    const allowed = this.char2phonemes[qc] || [];
    return {
      key: chars.join('') + '\u0000' + q,
      inputIds: ids,
      charId: this.charIndex.get(qc),
      positionId: text2token[q] + 1,
      allowed,
    };
  }

  // 一行文字 → 需要模型判斷的查詢，以及不用模型就能決定的讀音
  prepareLine(line) {
    const chars = Array.from(line);
    const queries = [];
    const result = chars.map((c, i) => {
      if (this.charIndex.has(c)) {
        queries.push({ index: i, ...this.buildQuery(chars, i) });
        return { c, p: null, src: 'model' };
      }
      if (c in this.mono) return { c, p: this.mono[c], src: 'mono' };
      if (c in this.fallback) return { c, p: this.fallback[c], src: 'dict' };
      return { c, p: null, src: null };
    });
    return { chars, queries, result };
  }

  // 把一批查詢組成模型的輸入張量資料（pad 到同長度，與 create_mini_batch 相同）
  makeBatch(queries) {
    const B = queries.length;
    const L = Math.max(...queries.map(q => q.inputIds.length));
    const N = this.numLabels;
    const inputIds = new BigInt64Array(B * L);
    const tokenType = new BigInt64Array(B * L);
    const attn = new BigInt64Array(B * L);
    const pmask = new Float32Array(B * N);
    const charIds = new BigInt64Array(B);
    const posIds = new BigInt64Array(B);
    queries.forEach((q, b) => {
      q.inputIds.forEach((id, j) => { inputIds[b * L + j] = BigInt(id); attn[b * L + j] = 1n; });
      if (this.useMask) for (const k of q.allowed) pmask[b * N + k] = 1;
      else pmask.fill(1, b * N, (b + 1) * N);
      charIds[b] = BigInt(q.charId);
      posIds[b] = BigInt(q.positionId);
    });
    return { B, L, N, inputIds, tokenType, attn, pmask, charIds, posIds };
  }

  // 模型輸出機率 → 讀音、信心、候選清單
  decode(probs, b, allowed) {
    const N = this.numLabels;
    let best = -1, bestP = -1;
    for (let k = 0; k < N; k++) {
      const p = probs[b * N + k];
      if (p > bestP) { bestP = p; best = k; }
    }
    if (best < 0 && allowed.length) { best = allowed[0]; bestP = 0; } // 數值異常時退回第一個候選
    const cands = allowed
      .map(k => ({ p: this._labelPron(k), prob: Number.isFinite(probs[b * N + k]) ? probs[b * N + k] : 0 }))
      .sort((a, b2) => b2.prob - a.prob);
    return { p: this._labelPron(best), conf: bestP, cands };
  }

  _labelPron(k) {
    const l = this.labels[k];
    return this.useCharPhoneme ? l.split(' ')[1] : l;
  }

  // 某個字所有可能讀音（模型候選 + 字典其他讀音）
  allReadings(c) {
    const set = [];
    for (const k of (this.char2phonemes[c] || [])) set.push(this._labelPron(k));
    for (const p of (this.alt[c] || [])) if (!set.includes(p)) set.push(p);
    if (!set.length) {
      const p = this.mono[c] || this.fallback[c];
      if (p) set.push(p);
    }
    return set;
  }
}

// ㄏㄤ2 → { base:'ㄏㄤ', tone:'2', text:'ㄏㄤˊ' }
const TONE_MARK = { '1': '', '2': 'ˊ', '3': 'ˇ', '4': 'ˋ', '5': '˙' };
export function splitPron(p) {
  if (!p) return null;
  const tone = p.slice(-1);
  if (!(tone in TONE_MARK)) return { base: p, tone: '1', text: p };
  const base = p.slice(0, -1);
  return { base, tone, text: tone === '5' ? '˙' + base : base + TONE_MARK[tone] };
}

// 使用者輸入「ㄏㄤˊ」或「ㄏㄤ2」→ 內部格式 ㄏㄤ2
export function parsePron(s) {
  s = (s || '').replace(/\s+/g, '');
  if (!s) return null;
  if (/[1-5]$/.test(s)) return s;
  if (s.startsWith('˙')) return s.slice(1) + '5';
  const m = s.match(/[ˊˇˋ˙]$/);
  if (m) return s.slice(0, -1) + { 'ˊ': '2', 'ˇ': '3', 'ˋ': '4', '˙': '5' }[m[0]];
  return s + '1';
}
