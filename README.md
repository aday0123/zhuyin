# 注音校對簿

貼上文章，自動加注音並判斷破音字。注音排在國字右側，和國語課本相同。

- 破音字由開源模型 g2pW 判斷，模型在瀏覽器裡執行，**文字不會上傳**
- 第一次使用要下載模型（約 150 MB），之後存在瀏覽器裡，可以離線使用
- 模型不太確定的字會標黃色，點任何一個字都能改讀音
- 注音用「字嗨注音標楷」字型顯示，按「複製到 Word」貼上後，破音字讀音會保留
- 可直接列印或另存 PDF（列印時不會印出標示）

## 複製到 Word

1. 電腦先安裝字型「ㄅ字嗨注音標楷」（免費）：到 [bpmfvs 下載頁](https://github.com/ButTaiwan/bpmfvs/releases) 下載，解壓縮後在 `BpmfZihiKaiStd-Regular.ttf` 上按右鍵選「安裝」。
2. 在網頁按「加注音」，確認讀音後按「複製到 Word」。
3. 在 Word 貼上。如果只看到國字，選取全文，把字型改成「ㄅ字嗨注音標楷」。

原理：每個破音字後面加了一個看不見的「異體字選擇子」（注音 IVS 規格），字型會依照它顯示對應的注音。
所以要給別人修改的 Word 檔，對方電腦也要安裝這套字型；只是要給人看的話，建議存成 PDF。
Google 文件不支援這種方式。

## 資料夾內容

| 路徑 | 說明 |
|---|---|
| `index.html`、`css/`、`js/` | 網頁本身 |
| `vendor/ort/` | 在瀏覽器執行模型的程式（ONNX Runtime Web） |
| `coi-serviceworker.min.js` | 讓 GitHub Pages 能用多執行緒，加快速度 |
| `fonts/` | 字嗨注音標楷網頁字型與讀音順序表 |
| `model/` | 壓縮後的模型（由 `tools/prepare_model.py` 產生） |
| `tools/prepare_model.py` | 把 g2pW 模型壓縮、驗證、切檔的腳本 |

## 一、產生模型檔（在自己電腦上做一次）

在這個資料夾開啟命令提示字元：

```
py -m pip install g2pw torch onnx
py tools\prepare_model.py
```

完成後 `model` 資料夾裡會有 `g2pw.q.onnx.part00`、`part01`… 以及 `manifest.json`、`meta.json`、`selftest.json`。
畫面會顯示「原始模型與壓縮模型的一致率」，應該接近 100%。

## 二、放到 GitHub Pages

1. 在 GitHub 建立新的 repository（例如 `zhuyin`），設成 **Public**。
2. 在 repository 頁面按 **Add file → Upload files**，把這個資料夾裡的**所有檔案和資料夾**拖進去，按 **Commit changes**。
   （每個模型分段都小於 25 MB，可以直接用網頁上傳。）
3. 到 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 **main**、資料夾選 **/ (root)**，按 **Save**。
4. 等 1～2 分鐘，網址會是 `https://你的帳號.github.io/zhuyin/`。

打開網址後，可以按頁尾的「檢查模型是否正常」，確認網頁結果和電腦版完全一樣。

## 在自己電腦測試

直接點兩下 `index.html` 無法載入模型，請在這個資料夾執行：

```
py tools\serve.py
```

會自動用瀏覽器打開 `http://localhost:8000/`（按 Ctrl+C 結束）。

## 授權與來源

- 破音字模型：[g2pW](https://github.com/GitYCC/g2pW)（Yi-Chang Chen 等人，INTERSPEECH 2022），Apache License 2.0。本網站使用的是以 ONNX Runtime 動態量化（int8）壓縮後的版本。
- 斷字字表：bert-base-chinese，Apache License 2.0。
- 注音字型：[字嗨注音標楷](https://github.com/ButTaiwan/bpmfvs)（But Ko／The Bpmf Project Authors），SIL Open Font License 1.1；讀音順序依「注音 IVS 字型規格」，Apache License 2.0。
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)：MIT License。
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)：MIT License。

詳細授權文字見 `NOTICE.md`。
