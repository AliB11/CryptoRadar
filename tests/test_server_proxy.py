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
