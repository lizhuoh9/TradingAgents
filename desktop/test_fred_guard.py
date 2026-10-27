import unittest
from unittest.mock import patch

from fred_guard import guarded_fred, install_fred_guard, safe_fred_get


class FredGuardTests(unittest.TestCase):
    def test_tool_results_and_errors_do_not_expose_key(self):
        key = "fictionalFredKey012345"
        self.assertEqual(guarded_fred(lambda: f"data {key}", key)(), "data [REDACTED]")

        def fail():
            raise ValueError(f"FRED error echoed {key}")

        with self.assertRaises(RuntimeError) as caught:
            guarded_fred(fail, key)()
        self.assertNotIn(key, str(caught.exception))

    def test_actual_vendor_400_is_sanitized_before_router(self):
        from tradingagents.dataflows import router
        from tradingagents.dataflows.vendors import fred

        key = "fictionalFredKey012345"

        class Response:
            status_code = 400
            text = f"echo {key}"

            def json(self):
                return {"error_message": self.text}

        original = router.VENDOR_METHODS["get_macro_indicators"]["fred"]
        original_get = fred.get_scrubbed
        try:
            install_fred_guard(key)
            with patch.dict("os.environ", {"FRED_API_KEY": key}), patch("requests.get", return_value=Response()):
                with self.assertRaises(RuntimeError) as caught:
                    router.VENDOR_METHODS["get_macro_indicators"]["fred"]("cpi", "2026-10-27")
                with patch.object(router, "get_vendor", return_value="fred"):
                    result = router.route_to_vendor("get_macro_indicators", "cpi", "2026-10-27")
                self.assertIn("DATA_UNAVAILABLE", result)
                self.assertNotIn(key, result)
            self.assertNotIn(key, str(caught.exception))
        finally:
            router.VENDOR_METHODS["get_macro_indicators"]["fred"] = original
            fred.get_scrubbed = original_get

    def test_refuses_redirect_and_non_fred_hosts(self):
        class Redirect:
            status_code = 302

        with patch("requests.get", return_value=Redirect()) as request:
            with self.assertRaises(RuntimeError):
                safe_fred_get("https://api.stlouisfed.org/fred/series", params={"api_key": "fake"}, timeout=1, secret="fake")
            self.assertFalse(request.call_args.kwargs["allow_redirects"])
            with self.assertRaises(RuntimeError):
                safe_fred_get("https://example.com/fred/series", params={"api_key": "fake"}, timeout=1, secret="fake")
            self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
