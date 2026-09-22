#!/usr/bin/env python3
"""CryptoRadar — static files + allowlisted market-data proxy."""
from __future__ import annotations

import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
CG = "https://api.coingecko.com/api/v3/"
FNG = "https://api.alternative.me/fng/"
UA = "CryptoRadar/1.1 (signal-terminal; +https://github.com/AliB11/CryptoRadar)"
ALLOW_PATH = re.compile(r"^(coins/markets|global|search/trending|coins/[a-z0-9-]+/ohlc)$")
ALLOW_QS = {
    "vs_currency", "order", "per_page", "page", "sparkline",
    "price_change_percentage", "days", "ids", "limit",
}
CTX = ssl.create_default_context()
_CACHE: dict[str, tuple[float, object]] = {}
_LOCK = threading.Lock()


def ttl_for(path: str, src: str) -> int:
    if src == "fng" or path == "search/trending":
        return 600
    if path.endswith("/ohlc"):
        return 600
    return 70


def cache_get(url: str, ttl: int):
    with _LOCK:
        hit = _CACHE.get(url)
    if hit and (time.time() - hit[0]) < ttl:
        return hit[1], True, False
    return None, False, False


def cache_put(url: str, data: object) -> None:
    with _LOCK:
        _CACHE[url] = (time.time(), data)
        if len(_CACHE) > 80:
            oldest = min(_CACHE, key=lambda k: _CACHE[k][0])
            _CACHE.pop(oldest, None)


def fetch_json(url: str, ttl: int):
    stale = None
    with _LOCK:
        hit = _CACHE.get(url)
    if hit:
        age = time.time() - hit[0]
        if age < ttl:
            return hit[1], True, False
        stale = hit[1]
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=12, context=CTX) as r:
            raw = r.read()
            data = json.loads(raw.decode("utf-8"))
            cache_put(url, data)
            return data, False, False
    except urllib.error.HTTPError as e:
        if e.code == 429 and stale is not None:
            return stale, True, True
        err = OSError(f"upstream {e.code}")
        err.status = 429 if e.code == 429 else (e.code if 400 <= e.code < 600 else 502)
        raise err from e


def json_bytes(obj: object) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("[radar] " + (fmt % args) + "\n")

    def translate_path(self, path: str) -> str:
        result = super().translate_path(path)
        rel = os.path.normpath(os.path.relpath(result, ROOT))
        top = rel.split(os.sep)[0]
        if top in {".git", ".env", ".venv"} or top.startswith(".env"):
            return os.path.join(ROOT, "__forbidden__")
        return result

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/proxy":
            self.handle_proxy(parsed)
            return
        super().do_HEAD()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/proxy":
            self.handle_proxy(parsed)
            return
        if parsed.path in ("/", "/index.html"):
            self.send_file_no_cache("index.html", "text/html; charset=utf-8")
            return
        if parsed.path == "/sw.js":
            self.send_file_no_cache("sw.js", "application/javascript; charset=utf-8")
            return
        super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept")
        self.end_headers()

    def send_file_no_cache(self, name: str, ctype: str) -> None:
        fp = os.path.join(ROOT, name)
        try:
            with open(fp, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def handle_proxy(self, parsed: urllib.parse.ParseResult) -> None:
        q = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        def one(key: str, default: str = "") -> str:
            v = q.get(key, [default])
            return v[0] if v else default

        src = one("src")
        try:
            if src == "health":
                with _LOCK:
                    n = len(_CACHE)
                return self._json(200, {"ok": True, "cache": n, "ts": int(time.time() * 1000)}, "MISS")
            if src == "fng":
                try:
                    limit = int(one("limit", "30") or "30")
                except ValueError:
                    limit = 30
                limit = min(30, max(1, limit))
                data, cached, stale = fetch_json(f"{FNG}?limit={limit}", 600)
                return self._json(200, data, "STALE" if stale else ("HIT" if cached else "MISS"))
            if src != "cg":
                return self._json(400, {"error": "src"})
            path = one("path")
            if not ALLOW_PATH.match(path):
                return self._json(400, {"error": "path"})
            fwd = []
            for k, vs in q.items():
                if k in ("src", "path") or k not in ALLOW_QS:
                    continue
                if vs:
                    fwd.append((k, vs[0]))
            qs = urllib.parse.urlencode(fwd)
            up = CG + path + (("?" + qs) if qs else "")
            data, cached, stale = fetch_json(up, ttl_for(path, src))
            return self._json(200, data, "STALE" if stale else ("HIT" if cached else "MISS"))
        except OSError as e:
            st = int(getattr(e, "status", 502) or 502)
            self._json(st, {"error": "upstream", "detail": str(e)})

    def _json(self, status: int, obj: object, cache: str | None = None) -> None:
        body = json_bytes(obj)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=30")
        self.send_header("Access-Control-Allow-Origin", "*")
        if cache:
            self.send_header("X-Radar-Cache", cache)
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"CryptoRadar on http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
