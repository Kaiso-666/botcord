"""Phase 0 safety net, part 2: live HTTP contract tests.

Spins up the real app on localhost (no Discord login needed) and checks
routing, auth boundaries and the observability headers. Run with:
    python -m pytest
"""

import asyncio
import unittest

from aiohttp.test_utils import TestClient, TestServer

import server as S


class AppContractTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = TestClient(TestServer(S.build_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_healthz_needs_no_auth(self):
        resp = await self.client.get("/healthz")
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["version"], S.SERVER_VERSION)
        self.assertTrue(resp.headers.get("X-Request-Id"))

    async def test_version_requires_session_like_other_api(self):
        # no session -> rejected, like every /api route except /api/session
        resp = await self.client.get("/api/version")
        self.assertEqual(resp.status, 401)
        # with a session -> served, with a request id
        sess = await self.client.post("/api/session")
        sid = (await sess.json())["session_id"]
        try:
            resp2 = await self.client.get(
                "/api/version", headers={"X-Botcord-Session": sid}
            )
            self.assertEqual(resp2.status, 200)
            body = await resp2.json()
            self.assertEqual(body["version"], S.SERVER_VERSION)
            self.assertTrue(resp2.headers.get("X-Request-Id"))
        finally:
            await S.drop_session(sid)

    async def test_api_without_session_is_rejected(self):
        resp = await self.client.get("/api/me")
        self.assertEqual(resp.status, 401)
        body = await resp.json()
        self.assertEqual(body["error"], "NO-SESSION")

    async def test_session_without_bot_login_is_unauthorized(self):
        sess = await self.client.post("/api/session")
        sid = (await sess.json())["session_id"]
        try:
            resp = await self.client.get(
                "/api/me", headers={"X-Botcord-Session": sid}
            )
            self.assertEqual(resp.status, 401)
            body = await resp.json()
            self.assertEqual(body["error"], "NOT-LOGGED-IN")
        finally:
            await S.drop_session(sid)

    async def test_session_creation_roundtrip(self):
        resp = await self.client.post("/api/session")
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        sid = body.get("session_id")
        self.assertTrue(sid)
        # unknown session id is still rejected (no leak across sessions)
        resp2 = await self.client.get(
            "/api/me", headers={"X-Botcord-Session": "bogus"}
        )
        self.assertEqual(resp2.status, 401)
        # each request carries a unique id for log correlation
        r1 = await self.client.get("/healthz")
        r2 = await self.client.get("/healthz")
        self.assertNotEqual(
            r1.headers.get("X-Request-Id"), r2.headers.get("X-Request-Id")
        )
        await S.drop_session(sid)


class BroadcastTest(unittest.IsolatedAsyncioTestCase):
    async def test_slow_socket_neither_blocks_nor_survives(self):
        state = S.BotState()
        received = []

        class Fast:
            async def send_str(self, payload):
                received.append(payload)

        class Slow:
            async def send_str(self, payload):
                await asyncio.sleep(30)

        class Broken:
            async def send_str(self, payload):
                raise ConnectionResetError("gone")

        fast, slow, broken = Fast(), Slow(), Broken()
        state.sockets.update([fast, slow, broken])
        await asyncio.wait_for(state.broadcast("ping", {"n": 1}), timeout=10)
        self.assertEqual(len(received), 1)
        self.assertIn(fast, state.sockets)
        self.assertNotIn(slow, state.sockets)
        self.assertNotIn(broken, state.sockets)
