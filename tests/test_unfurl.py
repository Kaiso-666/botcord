"""Unfurl validation gates — all offline (rejections happen before any I/O
except creating the shared HTTP session object, which is closed after).

Run with: python -m pytest
"""

import unittest

import server as S


class UnfurlValidationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await S.close_http_session()

    async def test_bad_scheme_rejected(self):
        for url in ("ftp://example.com/f", "file:///etc/passwd", "not-a-url", ""):
            with self.assertRaises(ValueError, msg=url):
                try:
                    await S.fetch_unfurl(url)
                except ValueError as exc:
                    self.assertIn("BAD-URL", str(exc))
                    raise

    async def test_odd_port_blocked_before_network(self):
        # would otherwise let chat links port-scan the intranet
        with self.assertRaises(ValueError) as cm:
            await S.fetch_unfurl("http://example.com:8080/page")
        self.assertIn("UNFURL-BLOCKED", str(cm.exception))

    async def test_local_targets_blocked(self):
        for url in ("http://127.0.0.1/", "http://localhost:8080/x"):
            with self.assertRaises(ValueError, msg=url):
                try:
                    await S.fetch_unfurl(url)
                except ValueError as exc:
                    self.assertIn("UNFURL-BLOCKED", str(exc))
                    raise

    async def test_shared_session_reused(self):
        a = await S.http_session()
        b = await S.http_session()
        self.assertIs(a, b)
