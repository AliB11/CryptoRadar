import time
import unittest
from unittest.mock import patch

import server


def ticker(numeric_id, nameid, price=100, rank=1):
    return {
        "id": str(numeric_id), "nameid": nameid, "name": nameid.title(), "symbol": nameid[:3].upper(),
        "price_usd": str(price), "market_cap_usd": str(price * 1000000), "volume24": "2000000",
        "rank": rank, "percent_change_1h": "0.3", "percent_change_24h": "1.2", "percent_change_7d": "-2.1",
    }


def candles(count=168, base=100):
    """Hourly candles in the venue's own shape: strings, open time in ms."""
    now = int(time.time() * 1000)
    rows = []
    for i in range(count - 1, -1, -1):
        t = now - i * 3600000
        c = base + (i % 7)
        rows.append([t, str(c - 1), str(c + 1), str(c - 2), str(c), "12.5",
                     t + 3599999, "250000", 400, "20", "0"])
    return rows


class BinanceRecoveryTests(unittest.TestCase):
    """A CoinGecko 429 must not take the hourly engine down with it."""

    def setUp(self):
        # Both adapters keep process-wide caches (symbol resolution, the venue
        # cool-down); a clean slate per test keeps cases independent.
        server._BINANCE_SYMBOLS.clear()
        server._BINANCE_REJECTED.clear()

    def _stubs(self, venue_status=200):
        rows = [ticker(i + 1, f"asset-{i}", 10 + i, i + 1) for i in range(60)]
        calls = []

        def fake_fetch(url, ttl):
            calls.append(url)
            if url.startswith(server.CG):
                error = OSError("upstream 429")
                error.status = 429
                raise error
            if url.startswith(server.COINLORE + "tickers/"):
                return {"data": rows, "info": {"time": int(time.time())}}, False, False
            if url.startswith(server.BINANCE_HOSTS[0]) or url.startswith(server.BINANCE_HOSTS[1]):
                if venue_status != 200:
                    error = OSError("upstream %d" % venue_status)
                    error.status = venue_status
                    raise error
                return candles(), False, False
            raise AssertionError(url)

        return fake_fetch, calls

    def test_market_history_is_rebuilt_from_hourly_candles(self):
        fake_fetch, calls = self._stubs()
        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            reply = server._coingecko_with_recovery(
                "coins/markets", {"per_page": "150", "sparkline": "true"},
                server.CG + "coins/markets?per_page=150&sparkline=true",
            )
        self.assertEqual(reply["provider"], "binance")
        self.assertEqual(reply["history"], "hourly")
        self.assertGreaterEqual(len(reply["data"]), 50)
        row = reply["data"][0]
        self.assertEqual(len(row["sparkline_in_7d"]["price"]), 168)
        self.assertTrue(all(price > 0 for price in row["sparkline_in_7d"]["price"]))
        self.assertEqual(row["radar_provider"], "binance")
        self.assertEqual(row["market_cap"], 10000000, "market cap stays with the aggregator")
        self.assertEqual(row["price_change_percentage_7d_in_currency"], -2.1)
        self.assertNotIn("atl_date", row, "no project age is invented from candles")
        self.assertTrue(any("/api/v3/klines" in url for url in calls))

    def test_ohlc_is_served_from_the_venue_when_coingecko_cannot(self):
        fake_fetch, calls = self._stubs()

        def wrapped(url, ttl):
            if url.startswith(server.COINLORE + "assets/"):
                return [{"id": "90", "nameid": "bitcoin", "symbol": "BTC"}], False, False
            return fake_fetch(url, ttl)

        with patch.object(server, "fetch_json", side_effect=wrapped):
            reply = server._coingecko_with_recovery(
                "coins/bitcoin/ohlc", {"days": "7"},
                server.CG + "coins/bitcoin/ohlc?days=7",
            )
        self.assertEqual(reply["provider"], "binance")
        self.assertEqual(reply["history"], "hourly")
        self.assertGreaterEqual(len(reply["data"]), 120)
        self.assertEqual(len(reply["data"][0]), 5, "OHLC rows stay five fields wide")
        self.assertTrue(any("BTCUSDT" in url for url in calls))

    def test_global_is_not_answered_by_the_venue(self):
        fake_fetch, calls = self._stubs()
        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            with self.assertRaises(OSError):
                server._binance_recover("global", {})
        self.assertFalse(any("/api/v3/klines" in url for url in calls))

    def test_venue_outage_still_lands_on_the_snapshot_provider(self):
        fake_fetch, calls = self._stubs(venue_status=503)
        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            reply = server._coingecko_with_recovery(
                "coins/markets", {"per_page": "100", "sparkline": "true"},
                server.CG + "coins/markets?per_page=100&sparkline=true",
            )
        self.assertEqual(reply["provider"], "coinlore")
        self.assertEqual(reply["history"], "none")
        self.assertNotIn("sparkline_in_7d", reply["data"][0])


class LocalProxyFallbackTests(unittest.TestCase):
    def test_market_snapshot_falls_back_after_coingecko_429(self):
        rows = [ticker(i + 1, f"asset-{i}", 10 + i, i + 1) for i in range(60)]
        calls = []

        def fake_fetch(url, ttl):
            calls.append(url)
            if url.startswith(server.CG):
                error = OSError("upstream 429")
                error.status = 429
                raise error
            if url.startswith(server.COINLORE + "tickers/"):
                return {"data": rows, "info": {"time": int(time.time())}}, False, False
            raise AssertionError(url)

        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            reply = server._coingecko_with_recovery(
                "coins/markets", {"per_page": "150", "sparkline": "true"},
                server.CG + "coins/markets?per_page=150&sparkline=true",
            )

        self.assertEqual(reply["provider"], "coinlore")
        self.assertEqual(reply["history"], "none")
        self.assertEqual(len(reply["data"]), 60)
        self.assertEqual(reply["data"][0]["id"], "asset-0")
        self.assertNotIn("sparkline_in_7d", reply["data"][0])
        self.assertTrue(any(url.startswith(server.COINLORE) for url in calls))

    def test_missing_coingecko_hourly_history_is_treated_as_incomplete(self):
        rows = [ticker(i + 1, f"asset-{i}", 10 + i, i + 1) for i in range(55)]

        def fake_fetch(url, ttl):
            if url.startswith(server.CG):
                return [{"id": "asset-0", "current_price": 10}], False, False
            if url.startswith(server.COINLORE + "tickers/"):
                return {"data": rows, "info": {"time": int(time.time())}}, False, False
            raise AssertionError(url)

        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            reply = server._coingecko_with_recovery(
                "coins/markets", {"per_page": "100", "sparkline": "true"},
                server.CG + "coins/markets?per_page=100&sparkline=true",
            )
        self.assertEqual(reply["provider"], "coinlore")
        self.assertEqual(len(reply["data"]), 55)

    def test_id_quote_fallback_preserves_the_requested_asset_id(self):
        def fake_fetch(url, ttl):
            if url.startswith(server.CG):
                error = OSError("upstream 429")
                error.status = 429
                raise error
            if url == server.COINLORE + "assets/":
                return [
                    {"id": "90", "nameid": "bitcoin", "symbol": "BTC"},
                    {"id": "80", "nameid": "ethereum", "symbol": "ETH"},
                ], False, False
            if url == server.COINLORE + "ticker/?id=90%2C80":
                # The real query uses commas as safe URL characters.
                return [ticker(90, "bitcoin", 68000, 1), ticker(80, "ethereum", 3400, 2)], False, False
            if url == server.COINLORE + "ticker/?id=90,80":
                return [ticker(90, "bitcoin", 68000, 1), ticker(80, "ethereum", 3400, 2)], False, False
            raise AssertionError(url)

        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            reply = server._coingecko_with_recovery(
                "coins/markets", {"ids": "bitcoin,ethereum", "sparkline": "false"},
                server.CG + "coins/markets?ids=bitcoin%2Cethereum&sparkline=false",
            )
        self.assertEqual([row["id"] for row in reply["data"]], ["bitcoin", "ethereum"])
        self.assertEqual(reply["data"][0]["current_price"], 68000)
        self.assertEqual(reply["data"][0]["radar_provider"], "coinlore")

    def test_both_sources_offline_raises_instead_of_manufacturing_data(self):
        def fake_fetch(url, ttl):
            error = OSError("offline")
            error.status = 429 if url.startswith(server.CG) else 503
            raise error

        with patch.object(server, "fetch_json", side_effect=fake_fetch):
            with self.assertRaises(OSError) as raised:
                server._coingecko_with_recovery(
                    "coins/markets", {"sparkline": "true"},
                    server.CG + "coins/markets?sparkline=true",
                )
        self.assertEqual(raised.exception.status, 429)


if __name__ == "__main__":
    unittest.main()
