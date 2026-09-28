#!/usr/bin/env python3
"""CryptoRadar — static files + allowlisted market-data proxy."""
from __future__ import annotations

import hmac
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
_STATE_LOCK = threading.Lock()
NODE_BIN = shutil.which("node")


def _kv_path() -> str:
    return os.environ.get("RADAR_STORE_FILE") or STATE_FILE


def _kv_load() -> dict:
    with _STATE_LOCK:
        try:
            with open(_kv_path(), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}


def _kv_save(data: dict) -> None:
    path = _kv_path()
    with _STATE_LOCK:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)


def _k(name: str) -> str:
    return KV_PREFIX + ":" + name


def _space_state(space: str) -> dict:
    raw = _kv_load().get(_k("space:%s:state" % space))
    if not raw:
        return {"version": 0, "updatedAt": 0, "portfolio": [], "alerts": [],
                "ledger": [], "subscriptions": {}}
    try:
        data = json.loads(raw)
    except ValueError:
        return {"version": 0, "updatedAt": 0, "portfolio": [], "alerts": [],
                "ledger": [], "subscriptions": {}}
    data.setdefault("version", 0)
    data.setdefault("portfolio", [])
    data.setdefault("alerts", [])
    data.setdefault("ledger", [])
    data.setdefault("subscriptions", {})
    return data


def _write_state(space: str, state: dict) -> None:
    kv = _kv_load()
    kv[_k("space:%s:state" % space)] = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    _kv_save(kv)


def _pulse(space: str):
    raw = _kv_load().get(_k("space:%s:pulse" % space))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _public_state(state: dict) -> dict:
    return {
        "version": state.get("version", 0),
        "updatedAt": state.get("updatedAt", 0),
        "portfolio": state.get("portfolio", []),
        "alerts": state.get("alerts", []),
        "ledger": state.get("ledger", []),
        "subscriptionCount": len(state.get("subscriptions") or {}),
    }


def _authorized(handler) -> bool:
    token = os.environ.get("RADAR_TOKEN", "")
    if not token:
        return True          # dev server: nothing to protect yet
    presented = handler.headers.get("x-radar-token") or ""
    auth = handler.headers.get("Authorization") or ""
    if auth.lower().startswith("bearer "):
        presented = presented or auth[7:].strip()
    return hmac.compare_digest(str(presented), str(token))


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
        self.send_header("Cache-Control", cache or "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-radar-token")
        self.end_headers()
        self.wfile.write(body)

    def handle_state(self, parsed: urllib.parse.ParseResult) -> None:
        if not _authorized(self):
            return self._json(401, {"error": "unauthorized"})
        q = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        space = (q.get("space", [""])[0] or os.environ.get("RADAR_SPACE") or "default")
        if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", str(space)):
            space = "default"

        if self.command in ("GET", "HEAD"):
            state = _space_state(space)
            payload = {"ok": True, "space": space, "store": "file", "pulse": _pulse(space),
                       "intervalSec": int(os.environ.get("PULSE_INTERVAL_SEC") or 90)}
            payload.update(_public_state(state))
            pub = os.environ.get("VAPID_PUBLIC_KEY") or ""
            payload["push"] = {"configured": bool(pub), "publicKey": pub}
            return self._json(200, payload)

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            return self._json(400, {"ok": False, "error": "json"})

        state = _space_state(space)
        if self.command == "PUT":
            base = body.get("base")
            if base is not None and int(base) != int(state.get("version", 0)):
                payload = {"ok": False, "error": "version-conflict",
                           "detail": "وضعیتِ سرور جلوتر است؛ ابتدا بخوانید."}
                payload.update(_public_state(state))
                return self._json(409, payload)
            if isinstance(body.get("portfolio"), list):
                state["portfolio"] = body["portfolio"][:400]
            if isinstance(body.get("alerts"), list):
                state["alerts"] = body["alerts"][:500]
            if len(state.get("ledger") or []) > 2000:
                state["ledger"] = state["ledger"][-2000:]
        elif self.command == "DELETE":
            keep = state.get("subscriptions") or {}
            state = {"version": int(state.get("version", 0)) + 1, "updatedAt": int(time.time() * 1000),
                     "portfolio": [], "alerts": [], "ledger": state.get("ledger") or [],
                     "subscriptions": {} if body.get("keepSubscriptions") is False else keep}
        elif self.command == "POST":
            sub = body.get("subscription") or {}
            subs = state.get("subscriptions") or {}
            if body.get("action") == "unsubscribe":
                subs.pop(body.get("endpoint") or sub.get("endpoint"), None)
            elif sub.get("endpoint") and sub.get("keys", {}).get("p256dh"):
                if len(subs) >= 20:
                    oldest = min(subs, key=lambda k: subs[k].get("addedAt") or 0)
                    subs.pop(oldest, None)
                subs[sub["endpoint"]] = {"endpoint": sub["endpoint"], "keys": sub["keys"],
                                         "label": str(body.get("label") or "")[:80],
                                         "addedAt": int(time.time() * 1000)}
            else:
                return self._json(400, {"ok": False, "error": "subscription"})
            state["subscriptions"] = subs
        else:
            return self._json(405, {"error": "method"})

        state["version"] = int(state.get("version", 0)) + 1
        state["updatedAt"] = int(time.time() * 1000)
        _write_state(space, state)
        payload = {"ok": True}
        payload.update(_public_state(state))
        return self._json(200, payload)

    def handle_pulse(self, parsed: urllib.parse.ParseResult) -> None:
        # CRON_SECRET (Bearer, what Vercel Cron sends) and RADAR_TOKEN (what the
        # page and tools/pinger.mjs send) are both accepted — same contract as
        # api/pulse.js. Requiring only CRON_SECRET when it is set would stop an
        # open tab from driving the heartbeat.
        secrets = [s for s in (os.environ.get("CRON_SECRET"), os.environ.get("RADAR_TOKEN")) if s]
        if secrets:
            auth = self.headers.get("Authorization") or ""
            presented = self.headers.get("x-radar-token") or ""
            if auth.lower().startswith("bearer "):
                presented = presented or auth[7:].strip()
            if not any(hmac.compare_digest(str(presented), str(s)) for s in secrets):
                return self._json(401, {"error": "unauthorized"})

        q = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        space = (q.get("space", [""])[0] or os.environ.get("RADAR_SPACE") or "default")
        pulse = _pulse(space)
        interval = int(os.environ.get("PULSE_INTERVAL_SEC") or 90)

        if q.get("status", [""])[0] == "1":
            age = (int(time.time() * 1000) - pulse["lastRun"]) if pulse and pulse.get("lastRun") else None
            return self._json(200, {
                "ok": True, "mode": "status", "store": "file", "pulse": pulse, "ageMs": age,
                "late": age is not None and age > interval * 1000 * 4,
                "nextInMs": max(0, pulse["lastRun"] + interval * 1000 - int(time.time() * 1000))
                if pulse and pulse.get("lastRun") else 0,
            })

        if not NODE_BIN:
            # Without Node we cannot run the real rule engine, and re-implementing
            # it here would create a second, divergent source of truth.
            return self._json(200, {
                "ok": True, "skipped": "node-runtime-required", "space": space,
                "store": "file", "intervalSec": interval, "pulse": pulse,
                "detail": "برای اجرای تیکِ واقعی، Node لازم است (lib/monitor.js).",
            })

        script = (
            "require(%s).tick({now:Date.now(),space:%s,force:%s}).then(r=>process.stdout.write(JSON.stringify(r))).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e)}));process.exit(0)})"
            % (json.dumps(os.path.join(ROOT, "lib", "monitor.js")), json.dumps(space),
               "true" if q.get("force", [""])[0] in ("1", "true") else "false")
        )
        env = dict(os.environ)
        env["RADAR_STORE_FILE"] = _kv_path()
        try:
            proc = subprocess.run([NODE_BIN, "-e", script], cwd=ROOT, env=env,
                                  capture_output=True, timeout=90)
            out = (proc.stdout or b"").decode("utf-8", "replace").strip()
            if not out:
                raise RuntimeError((proc.stderr or b"").decode("utf-8", "replace")[:300] or "empty output")
            result = json.loads(out)
        except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the caller
            return self._json(500, {"ok": False, "error": str(exc)[:400], "store": "file"})
        return self._json(200 if result.get("ok", True) else 500, result)



def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"CryptoRadar on http://{HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
