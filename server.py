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
COINLORE = "https://api.coinlore.net/api/"
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
_COINLORE_LOCK = threading.Lock()
_COINLORE_NEXT_AT = 0.0



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


def _wait_for_coinlore_slot(url: str) -> None:
    global _COINLORE_NEXT_AT
    if not url.startswith(COINLORE):
        return
    with _COINLORE_LOCK:
        wait = _COINLORE_NEXT_AT - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _COINLORE_NEXT_AT = time.monotonic() + 1.0


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
    _wait_for_coinlore_slot(upstream)
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
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        if stale is not None:
            return stale, True, True
        err = OSError("upstream unavailable")
        err.status = 502
        raise err from e


def _num(value):
    try:
        if value is None or value == "": return None
        result = float(value)
        return result if result == result and abs(result) != float("inf") else None
    except (TypeError, ValueError, OverflowError):
        return None


def _first(row, *keys):
    if not isinstance(row, dict): return None
    for key in keys:
        if row.get(key) is not None: return row[key]
    return None


def _list_data(raw):
    if isinstance(raw, list): return raw
    if isinstance(raw, dict) and isinstance(raw.get("data"), list): return raw["data"]
    return []


_COINLORE_ALIASES = {
    "the-open-network": "toncoin", "near": "near-protocol",
    "matic-network": "polygon", "polygon-pos": "polygon",
}


def _coinlore_time(value=None):
    timestamp = _num(value)
    if not timestamp or timestamp <= 0: timestamp = time.time()
    if timestamp > 1e12: timestamp /= 1000
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def _normalize_coinlore_ticker(row, id_override=None, info=None):
    if not isinstance(row, dict): return None
    raw_id = id_override or row.get("nameid") or row.get("id") or row.get("symbol")
    coin_id = re.sub(r"[^a-z0-9-]", "", str(raw_id or "").strip().lower())
    price = _num(_first(row, "price_usd", "price"))
    if not coin_id or not price or price <= 0: return None
    provider_time = _coinlore_time(_first(row, "last_updated", "last_updated_at", "timestamp")) if _first(row, "last_updated", "last_updated_at", "timestamp") else None
    info_time = info.get("time") if isinstance(info, dict) else None
    updated = provider_time or _coinlore_time(info_time)
    return {
        "id": coin_id,
        "symbol": str(row.get("symbol") or "").lower(),
        "name": str(row.get("name") or row.get("symbol") or coin_id),
        "current_price": price,
        "market_cap": _num(_first(row, "market_cap_usd", "market_cap")) or 0,
        "total_volume": _num(_first(row, "volume24", "volume_24h", "volume_24h_usd", "volume_usd")) or 0,
        "market_cap_rank": _num(_first(row, "rank", "market_cap_rank")),
        "price_change_percentage_1h_in_currency": _num(_first(row, "percent_change_1h", "percent_change_1h_in_currency")),
        "price_change_percentage_24h_in_currency": _num(_first(row, "percent_change_24h", "percent_change_24h_in_currency")),
        "price_change_percentage_7d_in_currency": _num(_first(row, "percent_change_7d", "percent_change_7d_in_currency")),
        "last_updated": updated,
        "radar_provider": "coinlore",
        "radar_timestamp_kind": "provider" if provider_time else ("provider-batch" if info_time else "server-observed"),
    }


def _normalize_coinlore_global(raw):
    row = raw.get("data") if isinstance(raw, dict) and isinstance(raw.get("data"), dict) else raw
    if isinstance(row, list): row = row[0] if row else {}
    if not isinstance(row, dict): row = {}
    cap = _num(_first(row, "total_mcap", "total_market_cap_usd", "market_cap_usd"))
    volume = _num(_first(row, "total_volume", "total_volume_usd", "volume24"))
    btc = _num(_first(row, "btc_d", "btc_dominance"))
    eth = _num(_first(row, "eth_d", "eth_dominance"))
    return {"data": {
        "market_cap_percentage": {"btc": btc, "eth": eth},
        "total_market_cap": {"usd": cap}, "total_volume": {"usd": volume},
        "market_cap_change_percentage_24h_usd": _num(_first(row, "mcap_change", "market_cap_change_percentage_24h_usd")),
        "active_cryptocurrencies": _num(_first(row, "coins_count", "active_cryptocurrencies", "coins")),
    }}


def _coinlore_assets(ids):
    raw, cached, stale = fetch_json(COINLORE + "assets/", 6 * 60 * 60)
    rows = _list_data(raw)
    if not rows: raise OSError("CoinLore asset directory unavailable")
    by_name, by_id = {}, {}
    for asset in rows:
        if not isinstance(asset, dict): continue
        nameid = re.sub(r"[^a-z0-9-]", "", str(asset.get("nameid") or "").strip().lower())
        numeric_id = str(asset.get("id") or "")
        if nameid: by_name[nameid] = asset
        if numeric_id.isdigit(): by_id[numeric_id] = asset
    found = {}
    for requested in ids:
        normalized = str(requested).strip().lower()
        asset = by_name.get(_COINLORE_ALIASES.get(normalized, normalized)) or (by_id.get(normalized) if normalized.isdigit() else None)
        if asset and str(asset.get("id", "")).isdigit(): found[requested] = asset
    return found


def _coinlore_fallback(path, query):
    now = time.time()
    if path == "global":
        raw, cached, stale = fetch_json(COINLORE + "global/", 70)
        data = _normalize_coinlore_global(raw)
        if _coingecko_incomplete("global", {}, data): raise OSError("CoinLore global data incomplete")
        return {"data": data, "cached": cached, "stale": stale, "provider": "coinlore", "history": "none"}
    if path == "coins/markets":
        requested = [part.strip() for part in str(query.get("ids", "")).split(",") if part.strip()]
        if requested:
            assets = _coinlore_assets(requested)
            if not assets:
                return {"data": [], "cached": False, "stale": False, "provider": "coinlore", "history": "none"}
            numeric_ids = list(dict.fromkeys(str(asset["id"]) for asset in assets.values()))
            url = COINLORE + "ticker/?id=" + urllib.parse.quote(",".join(numeric_ids), safe=",")
            raw, cached, stale = fetch_json(url, 70)
            rows = _list_data(raw)
            info = raw.get("info") if isinstance(raw, dict) else None
            by_id = {str(row.get("id")): row for row in rows if isinstance(row, dict)}
            data = []
            for coin_id in requested:
                asset = assets.get(coin_id)
                ticker = by_id.get(str(asset.get("id"))) if asset else None
                row = _normalize_coinlore_ticker(ticker, coin_id, info)
                if row: data.append(row)
            return {"data": data, "cached": cached, "stale": stale, "provider": "coinlore", "history": "none"}
        try: per_page = max(1, min(100, int(query.get("per_page", "100"))))
        except (TypeError, ValueError): per_page = 100
        try: page = max(1, int(query.get("page", "1")))
        except (TypeError, ValueError): page = 1
        url = COINLORE + "tickers/?" + urllib.parse.urlencode({"start": (page - 1) * per_page, "limit": per_page})
        raw, cached, stale = fetch_json(url, 70)
        info = raw.get("info") if isinstance(raw, dict) else None
        data = [row for item in _list_data(raw) if (row := _normalize_coinlore_ticker(item, info=info))]
        return {"data": data, "cached": cached, "stale": stale, "provider": "coinlore", "history": "none"}
    if path == "search/trending":
        raw, cached, stale = fetch_json(COINLORE + "movers/?sort=24h", 600)
        rows = _list_data(raw)
        if not rows and isinstance(raw, dict) and isinstance(raw.get("data"), dict):
            rows = (raw["data"].get("winners") or []) + (raw["data"].get("losers") or [])
        mapped, seen = [], set()
        info = raw.get("info") if isinstance(raw, dict) else None
        for item in rows:
            row = _normalize_coinlore_ticker(item, info=info)
            if not row or row["id"] in seen: continue
            seen.add(row["id"])
            mapped.append({"item": {"id": row["id"], "symbol": row["symbol"], "name": row["name"],
                "market_cap_rank": row["market_cap_rank"], "data": {"price": row["current_price"],
                "price_change_percentage_24h": {"usd": row["price_change_percentage_24h_in_currency"]}}}})
            if len(mapped) >= 10: break
        if not mapped: raise OSError("CoinLore movers unavailable")
        return {"data": {"coins": mapped}, "cached": cached, "stale": stale, "provider": "coinlore", "history": "none"}
    match = re.fullmatch(r"coins/([a-z0-9-]+)/ohlc", path)
    if match:
        coin_id = match.group(1)
        asset = _coinlore_assets([coin_id]).get(coin_id)
        if not asset: raise OSError("CoinLore asset not found")
        raw, cached, stale = fetch_json(COINLORE + "coin/ohlcv/?coin=" + urllib.parse.quote(str(asset["id"])), 600)
        records = raw.get("data") if isinstance(raw, dict) and isinstance(raw.get("data"), dict) else raw
        try: days = max(1, min(365, int(query.get("days", "7"))))
        except (TypeError, ValueError): days = 7
        cutoff = now - days * 86400
        data = []
        values = records.values() if isinstance(records, dict) else records if isinstance(records, list) else []
        for item in values:
            if not isinstance(item, list) or len(item) < 5: continue
            stamp, opn, high, low, close = (_num(v) for v in item[:5])
            if not stamp or not opn or not high or not low or not close: continue
            seconds = stamp / 1000 if stamp > 1e12 else stamp
            if seconds < cutoff: continue
            data.append([int(seconds * 1000), opn, high, low, close])
        data.sort(key=lambda row: row[0])
        if not data: raise OSError("CoinLore daily OHLC unavailable")
        return {"data": data, "cached": cached, "stale": stale, "provider": "coinlore", "history": "daily"}
    raise OSError("CoinLore does not support " + path)


def _coingecko_incomplete(path, query, data):
    if path == "coins/markets":
        if not isinstance(data, list) or not data: return True
        if str(query.get("sparkline", "")).lower() == "true":
            try: per_page = max(1, int(query.get("per_page", "100")))
            except (TypeError, ValueError): per_page = 100
            required = max(50, min(75, (per_page + 1) // 2))
            if len(data) < required: return True
            good = sum(1 for row in data if isinstance(row, dict) and isinstance(row.get("sparkline_in_7d"), dict)
                       and isinstance(row["sparkline_in_7d"].get("price"), list) and len(row["sparkline_in_7d"]["price"]) >= 120)
            return good < required
        return False
    if path == "global":
        payload = data.get("data") if isinstance(data, dict) else None
        cap = _num(payload.get("total_market_cap", {}).get("usd")) if isinstance(payload, dict) and isinstance(payload.get("total_market_cap"), dict) else None
        volume = _num(payload.get("total_volume", {}).get("usd")) if isinstance(payload, dict) and isinstance(payload.get("total_volume"), dict) else None
        return not (cap is not None and cap > 0 and volume is not None and volume > 0)
    if path == "search/trending":
        coins = data.get("coins") if isinstance(data, dict) else None
        return not isinstance(coins, list) or len(coins) < 4
    if path.endswith("/ohlc"): return not isinstance(data, list) or len(data) < 10
    return False


def _coingecko_with_recovery(path, query, url):
    primary = None
    primary_error = None
    try:
        data, cached, stale = fetch_json(url, ttl_for(path, "cg"))
        primary = {"data": data, "cached": cached, "stale": stale, "provider": "coingecko",
                   "history": "hourly" if path == "coins/markets" and str(query.get("sparkline", "")).lower() == "true" else "none"}
        if not stale and not _coingecko_incomplete(path, query, data): return primary
        primary_error = OSError("CoinGecko cache is stale" if stale else "CoinGecko response incomplete")
        if stale: primary_error.status = 503
    except OSError as e:
        primary_error = e
        if getattr(e, "status", None) == 400: raise
    try:
        return _coinlore_fallback(path, query)
    except (OSError, ValueError, TypeError) as backup_error:
        if primary and primary["stale"]: return primary
        raise primary_error or backup_error


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
                return self._json(200, {"ok": True, "cache": n, "ts": int(time.time() * 1000)}, "MISS", "local")
            if src == "fng":
                try:
                    limit = int(one("limit", "30") or "30")
                except ValueError:
                    limit = 30
                limit = min(30, max(1, limit))
                data, cached, stale = fetch_json(f"{FNG}?limit={limit}", 600)
                return self._json(200, data, "STALE" if stale else ("HIT" if cached else "MISS"), "alternative.me")
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
            query = dict(fwd)
            qs = urllib.parse.urlencode(fwd)
            up = CG + path + (("?" + qs) if qs else "")
            reply = _coingecko_with_recovery(path, query, up)
            history = reply.get("history") or ("hourly" if path == "coins/markets" and query.get("sparkline") == "true" else "none")
            return self._json(200, reply["data"], "STALE" if reply.get("stale") else ("HIT" if reply.get("cached") else "MISS"),
                              reply.get("provider", "coingecko"), history)
        except (OSError, ValueError, TypeError) as e:
            st = int(getattr(e, "status", 502) or 502)
            self._json(st, {"error": "upstream", "detail": str(e)})

    def _json(self, status: int, obj: object, cache: str | None = None,
              provider: str | None = None, history: str | None = None) -> None:
        body = json_bytes(obj)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cache: self.send_header("X-Radar-Cache", cache)
        if provider: self.send_header("X-Radar-Provider", provider)
        if history: self.send_header("X-Radar-History", history)
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
