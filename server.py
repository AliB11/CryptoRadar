#!/usr/bin/env python3
"""CryptoRadar — static files + allowlisted market-data proxy."""
from __future__ import annotations

import json
import os
import re
import shutil
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(ROOT, ".radar-state")
STATE_FILE = os.path.join(STATE_DIR, "kv.json")
KV_PREFIX = os.environ.get("RADAR_KV_PREFIX", "radar")
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



# --------------------------------------------------------------------------
# Monitoring state — the same HTTP contract as api/state.js and api/pulse.js.
#
# `python3 server.py` is a development server, so it keeps state in one JSON
# file that lib/store.js also reads (RADAR_STORE_FILE). That lets the whole
# browser <-> server <-> monitor loop be exercised locally with no Upstash
# account. Real ticks still run in Node: the protection rule engine must stay
# single-implementation, so this process shells out to lib/monitor.js rather
# than re-implementing it in Python.
# --------------------------------------------------------------------------
NODE_BIN = shutil.which("node")


def _kv_path() -> str:
    return os.environ.get("RADAR_STORE_FILE") or STATE_FILE


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
    headers = {"Accept": "application/json", "User-Agent": UA}
    upstream = url
    if url.startswith(CG):
        pro = os.environ.get("COINGECKO_PRO_API_KEY")
        demo = os.environ.get("COINGECKO_DEMO_API_KEY")
        if pro:
            upstream = url.replace(CG, "https://pro-api.coingecko.com/api/v3/", 1)
            headers["x-cg-pro-api-key"] = pro
        elif demo:
            headers["x-cg-demo-api-key"] = demo
    req = urllib.request.Request(upstream, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=12, context=CTX) as r:
            raw = r.read()
            data = json.loads(raw.decode("utf-8"))
            cache_put(url, data)
            return data, False, False
    except urllib.error.HTTPError as e:
        if (e.code == 429 or e.code >= 500) and stale is not None:
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
        if top in {".git", ".env", ".venv", ".radar-state"} or top.startswith(".env"):
            return os.path.join(ROOT, "__forbidden__")
        return result

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/state":
            self.handle_state(parsed)
            return
        self.send_error(405)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/state":
            self.handle_state(parsed)
            return
        self.send_error(405)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/state":
            self.handle_state(parsed)
            return
        if parsed.path.rstrip("/") == "/api/pulse":
            self.handle_pulse(parsed)
            return
        self.send_error(405)

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/proxy":
            self.handle_proxy(parsed)
            return
        if parsed.path.rstrip("/") == "/api/state":
            self.handle_state(parsed)
            return
        if parsed.path.rstrip("/") == "/api/pulse":
            self.handle_pulse(parsed)
            return
        super().do_HEAD()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/proxy":
            self.handle_proxy(parsed)
            return
        if parsed.path.rstrip("/") == "/api/state":
            self.handle_state(parsed)
            return
        if parsed.path.rstrip("/") == "/api/pulse":
            self.handle_pulse(parsed)
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
        if self.command != "HEAD": self.wfile.write(body)

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
        self.send_header("Cache-Control", "no-store")
        if cache: self.send_header("X-Radar-Cache", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-radar-token")
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def handle_state(self, parsed: urllib.parse.ParseResult) -> None:
        # Use the production handler, including auth, validation and atomic CAS.
        # A second Python writer used to race the monitor and erase its ledger.
        if not NODE_BIN:
            return self._json(503, {"error": "node-runtime-required"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0 or length > 2_000_000:
                return self._json(413, {"error": "body-too-large"})
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            if not isinstance(body, dict):
                return self._json(400, {"error": "json-object-required"})
        except (ValueError, UnicodeError):
            return self._json(400, {"error": "json"})
        request = {"method": self.command, "url": self.path,
                   "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
        script = """
const fs=require('node:fs');
const req=JSON.parse(fs.readFileSync(0,'utf8'));
const headers={};
const res={statusCode:200,setHeader:(k,v)=>headers[k]=v,
  end:body=>process.stdout.write(JSON.stringify({status:res.statusCode,body:JSON.parse(body||'{}')}))};
require('./api/state.js')(req,res).catch(()=>{process.stdout.write(JSON.stringify({status:500,body:{error:'state-failed'}}))});
"""
        env = dict(os.environ)
        env["RADAR_STORE_FILE"] = _kv_path()
        try:
            proc = subprocess.run([NODE_BIN, "-e", script], cwd=ROOT, env=env,
                                  input=json_bytes(request), capture_output=True, timeout=30)
            result = json.loads(proc.stdout.decode("utf-8"))
            return self._json(result["status"], result["body"])
        except Exception:
            return self._json(500, {"error": "state-failed"})

    def handle_pulse(self, parsed: urllib.parse.ParseResult) -> None:
        if not NODE_BIN:
            return self._json(503, {"ok": False, "error": "node-runtime-required"})
        request = {"method": self.command, "url": self.path,
                   "headers": {k.lower(): v for k, v in self.headers.items()}}
        script = """
const fs=require('node:fs'); const req=JSON.parse(fs.readFileSync(0,'utf8'));
const res={statusCode:200,setHeader:()=>{},end:body=>process.stdout.write(JSON.stringify({status:res.statusCode,body:JSON.parse(body||'{}')}))};
require('./api/pulse.js')(req,res).catch(()=>process.stdout.write(JSON.stringify({status:500,body:{ok:false,error:'pulse-failed'}})));
"""
        env = dict(os.environ)
        env["RADAR_STORE_FILE"] = _kv_path()
        try:
            proc = subprocess.run([NODE_BIN, "-e", script], cwd=ROOT, env=env,
                                  input=json_bytes(request), capture_output=True, timeout=90)
            result = json.loads(proc.stdout.decode("utf-8"))
            return self._json(result["status"], result["body"])
        except Exception:
            return self._json(500, {"ok": False, "error": "pulse-failed"})



def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"CryptoRadar on http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
