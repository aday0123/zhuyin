# -*- coding: utf-8 -*-
"""
在自己電腦上測試網頁用的小伺服器。
在 zhuyin-web 資料夾執行：
    py tools\\serve.py
然後用 Chrome 或 Edge 開 http://localhost:8000/
（按 Ctrl+C 結束）
"""
import http.server, os, sys, functools, webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TYPES = {
    ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
    ".json": "application/json", ".woff2": "font/woff2", ".css": "text/css",
    ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return TYPES.get(ext) or super().guess_type(path)

    def end_headers(self):
        # 開啟多執行緒（和 GitHub Pages 上的 coi-serviceworker 效果相同）
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    os.chdir(ROOT)
    url = f"http://localhost:{PORT}/"
    print(f"網頁已開啟：{url}　（按 Ctrl+C 結束）")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)).serve_forever()
