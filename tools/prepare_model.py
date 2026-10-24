# -*- coding: utf-8 -*-
"""
把 g2pW 模型準備成網頁可以用的檔案。
在「zhuyin-web」資料夾裡執行：
    py -m pip install g2pw torch onnx
    py tools\\prepare_model.py

會做這些事：
  1. 找到 g2pW 模型（沒有的話會自動下載，約 600 MB）
  2. 把模型壓縮成 int8（約 1/4 大小）
  3. 用原始模型和壓縮模型跑同一批句子，比對破音字結果
  4. 把壓縮模型切成每份 24 MB 的小檔（GitHub 網頁上傳每檔上限 25 MB）
  5. 匯出網頁需要的字表、設定與自我測試資料
結果放在 model 資料夾。
"""
import os, sys, json, shutil, hashlib, time, tempfile, argparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import onnx  # noqa: F401  壓縮模型需要
except ImportError:
    sys.exit("缺少 onnx 套件，請先執行：py -m pip install onnx")

import numpy as np
import g2pw
from g2pw import G2PWConverter

PART_SIZE = int(os.environ.get("G2PW_PART_SIZE", 24 * 1000 * 1000))  # 每份 24 MB

VERIFY_SENTENCES = [
    "我去銀行領錢。", "爺爺行動不方便。", "弟弟睡著了。", "他看著窗外發呆。", "我了解你的意思。",
    "音樂會很好聽。", "小朋友快樂地唱歌。", "衣服已經乾了。", "他長大以後想當老師。", "這條路又長又彎。",
    "我昨天睡了一覺。", "我覺得這題很難。", "他得到第一名。", "明天你得早點起床。", "這個箱子很重。",
    "寫錯了就重新再寫一次。", "請你數一數有幾顆蘋果。", "我最喜歡上數學課。", "這件衣服很便宜。",
    "老師正在教我們寫字。", "下課後回到教室。", "他為了比賽每天練習。", "她長大後成為一位醫生。",
    "他很好學，常常去圖書館。", "星期一要考試。", "過馬路很危險。", "請把垃圾丟進垃圾桶。",
    "國王的新衣裳。這件衣裳真漂亮！", "這次考試的題目很簡單，我很快就寫完了。",
    "弟弟很聰明，小小年紀就認得很多字。", "這位做事認真的大臣得到國王的信任。",
    "打破花瓶的弟弟低著頭，不敢說話。", "我長大了，會自己上街買東西。",
    "小偷一看到警察就慌張的逃走了。", "這幾天一直下雨，衣服都晒不乾。",
    "城鎮中路面較寬敞，且較為熱鬧繁華的街道。", "這件事他左思右想，還是想不出原因。",
    "他背著書包，背誦課文。", "我們一起參加了這次的活動。", "這個問題很難處理，我們到處找答案。",
    "種子發芽了，他在院子裡種花。", "大家都覺得他說得很有道理。", "他差一點就遲到了。",
    "我們要好好的保護環境。", "請你把門關上，外面的風很大。", "媽媽調了一杯果汁給我喝。",
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def mb(n):
    return f"{n / 1e6:.1f} MB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=None, help="g2pW 模型資料夾（預設用套件內的 G2PWModel）")
    ap.add_argument("--out", default="model", help="輸出資料夾")
    ap.add_argument("--extra", default=None, help="另外拿來比對的文字檔（例如 課文.txt）")
    args = ap.parse_args()

    pkg_dir = os.path.dirname(os.path.abspath(g2pw.__file__))
    model_dir = args.model_dir or os.path.join(pkg_dir, "G2PWModel")
    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    print("【1/5】載入原始模型（第一次會自動下載）...")
    t = time.time()
    conv = G2PWConverter(model_dir=model_dir, style="bopomofo")
    src_onnx = os.path.join(model_dir, "g2pw.onnx")
    if not os.path.exists(src_onnx):
        cands = [f for f in os.listdir(model_dir) if f.lower() == "g2pw.onnx"]
        src_onnx = os.path.join(model_dir, cands[0])
    print(f"  完成（{time.time() - t:.1f} 秒），原始模型 {mb(os.path.getsize(src_onnx))}")

    print("【2/5】壓縮模型（int8），大約需要 1～3 分鐘...")
    from onnxruntime.quantization import quantize_dynamic, QuantType
    tmp = tempfile.mkdtemp(prefix="g2pw_q_")
    q_onnx = os.path.join(tmp, "g2pw.onnx")
    t = time.time()
    quantize_dynamic(src_onnx, q_onnx, weight_type=QuantType.QUInt8)
    print(f"  完成（{time.time() - t:.1f} 秒），壓縮後 {mb(os.path.getsize(q_onnx))}")

    # 讓壓縮模型也能用 G2PWConverter 載入：複製其他小檔到同一個暫存資料夾
    for name in os.listdir(model_dir):
        p = os.path.join(model_dir, name)
        if os.path.isfile(p) and name.lower() != "g2pw.onnx":
            shutil.copy(p, tmp)

    print("【3/5】比對原始模型與壓縮模型的破音字結果...")
    sentences = list(VERIFY_SENTENCES)
    if args.extra and os.path.exists(args.extra):
        with open(args.extra, encoding="utf-8-sig") as f:
            sentences += [l.strip() for l in f if l.strip()]
    qconv = G2PWConverter(model_dir=tmp, style="bopomofo")
    poly = set(conv.chars)
    t = time.time(); ref = conv(sentences); t_ref = time.time() - t
    t = time.time(); got = qconv(sentences); t_q = time.time() - t
    total = diff = 0
    diffs = []
    for s, a, b in zip(sentences, ref, got):
        for i, ch in enumerate(s):
            if ch in poly:
                total += 1
                if a[i] != b[i]:
                    diff += 1
                    diffs.append(f"  「{s[max(0, i - 6):i + 7]}」的「{ch}」 原始：{a[i]}  壓縮：{b[i]}")
    print(f"  破音字 {total} 個，結果不同 {diff} 個（一致率 {(total - diff) / max(total, 1):.1%}）")
    print(f"  推論時間：原始 {t_ref:.1f} 秒，壓縮 {t_q:.1f} 秒")
    for d in diffs[:30]:
        print(d)

    print("【4/5】切割模型檔...")
    for f in os.listdir(out_dir):
        if f.startswith("g2pw.q.onnx.part"):
            os.remove(os.path.join(out_dir, f))
    parts = []
    with open(q_onnx, "rb") as f:
        i = 0
        while True:
            chunk = f.read(PART_SIZE)
            if not chunk:
                break
            name = f"g2pw.q.onnx.part{i:02d}"
            with open(os.path.join(out_dir, name), "wb") as w:
                w.write(chunk)
            parts.append({"name": name, "size": len(chunk),
                          "sha256": hashlib.sha256(chunk).hexdigest()})
            i += 1
    total_size = os.path.getsize(q_onnx)
    full_sha = sha256(q_onnx)
    print(f"  切成 {len(parts)} 份")

    print("【5/5】匯出字表與設定...")
    cfg = conv.config
    vocab = conv.tokenizer.vocab  # token -> id
    vocab_list = [None] * len(vocab)
    for tok, idx in vocab.items():
        vocab_list[idx] = tok
    mono = {c: p for c, p in conv.monophonic_chars}
    fallback = {c: v[0] for c, v in conv.char_bopomofo_dict.items()
                if c not in mono and c not in conv.char2phonemes and v}
    # 每個破音字所有可能讀音（給網頁「點字改音」用）
    alt = {c: v for c, v in conv.char_bopomofo_dict.items() if len(v) > 1}
    meta = {
        "format": 1,
        "window_size": cfg.window_size,
        "use_mask": bool(cfg.use_mask),
        "use_char_phoneme": bool(cfg.use_char_phoneme),
        "max_len": 512,
        "labels": conv.labels,
        "chars": conv.chars,
        "char2phonemes": conv.char2phonemes,
        "mono": mono,
        "fallback": fallback,
        "alt": alt,
        "vocab": vocab_list,
        "lowercase": bool(getattr(conv.tokenizer, "do_lower_case", True)),
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

    # 自我測試：網頁會用壓縮模型重跑這些句子，看結果是否和這裡一樣
    selftest = [{"text": s, "pron": p} for s, p in zip(sentences[:len(VERIFY_SENTENCES)], got)]
    with open(os.path.join(out_dir, "selftest.json"), "w", encoding="utf-8") as f:
        json.dump(selftest, f, ensure_ascii=False)

    manifest = {
        "version": full_sha[:12],
        "file": "g2pw.q.onnx",
        "size": total_size,
        "sha256": full_sha,
        "parts": parts,
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "verify": {"polyphones": total, "diff": diff},
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n完成！檔案在「{os.path.abspath(out_dir)}」：")
    for n in sorted(os.listdir(out_dir)):
        print(f"  {n}  {mb(os.path.getsize(os.path.join(out_dir, n)))}")


if __name__ == "__main__":
    main()
