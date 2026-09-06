#!/usr/bin/env python3
"""Botcord server — Python host for the Botcord web client.

The Python process owns the discord.py bot connection (login, guilds,
channels, messages, presence, events) and exposes it to the browser UI
over a small REST API + a WebSocket event stream. It also serves the
static web client from ./web (plus the legacy ./css, ./resources and
./themes folders so the Discord-like styling is reused as-is).

Run:
    pip install -r requirements.txt
    python server.py [--host 127.0.0.1] [--port 8080]

Then open http://localhost:8080 and paste a bot token.
"""

import argparse
import asyncio
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

import discord
from aiohttp import WSMsgType, web

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"

# Bump whenever the REST/WS contract changes. The site checks this on
# startup and tells the user to restart / hard-refresh on mismatch
# instead of hanging on the loader forever.
SERVER_VERSION = 4

log = logging.getLogger("botcord")

# ---------------------------------------------------------------------------
# Token validation (mirrors the old desktop client's setToken.js rules)
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"^[\w\-.]+$")
_WS_CHARS = (" ", "\t", "\r", "\n")


def validate_token(token: str = "") -> str | None:
    """Return an error code string, or None when the token looks usable."""
    if not token:
        return "EMPTY-TOKEN"
    if any(c in token for c in _WS_CHARS):
        return "TOKEN-WHITESPACE"
    if len(token.replace(".", "")) < 50:
        return "TOKEN-SHORT"
    if _TOKEN_RE.sub("", token):
        return "INVALID-TOKEN-CHARACTERS"
    if len(token.split(".")) != 3:
        return "INVALID-TOKEN-FORMAT"
    return None


# ---------------------------------------------------------------------------
# Serializers: discord.py objects -> plain JSON for the browser
# ---------------------------------------------------------------------------


def avatar_url(user) -> str | None:
    try:
        return str(user.display_avatar.url)
    except Exception:
        return None


def user_json(u) -> dict:
    disc = getattr(u, "discriminator", "0") or "0"
    return {
        "id": str(u.id),
        "username": getattr(u, "name", getattr(u, "username", "?")),
        "global_name": getattr(u, "global_name", None),
        "discriminator": str(disc),
        "avatar": avatar_url(u),
        "bot": bool(getattr(u, "bot", True)),
    }


def member_json(m) -> dict:
    u = m  # discord.Member is a User subclass
    try:
        color_val = int(m.color.value) if hasattr(m, "color") else 0
    except Exception:
        color_val = 0
    color = f"#{color_val:06x}" if color_val else None
    try:
        status = str(m.status) if getattr(m, "status", None) else "offline"
    except Exception:
        status = "offline"
    try:
        nick = m.nick
    except Exception:
        nick = None
    try:
        role_ids = [str(r.id) for r in getattr(m, "roles", [])[1:]]
    except Exception:
        role_ids = []
    data = user_json(u)
    data.update(
        {
            "display_name": getattr(m, "display_name", data["username"]),
            "nick": nick,
            "color": color,
            "status": status,
            "roles": role_ids,
        }
    )
    return data


def role_json(r) -> dict:
    try:
        color_val = int(r.color.value)
    except Exception:
        color_val = 0
    return {
        "id": str(r.id),
        "name": r.name,
        "color": f"#{color_val:06x}" if color_val else None,
        "position": getattr(r, "position", 0),
        "hoist": bool(getattr(r, "hoist", False)),
    }


def guild_json(g) -> dict:
    try:
        icon = str(g.icon.url) if g.icon else None
    except Exception:
        icon = None
    acronym = "".join(w[0] for w in (g.name or "?").split() if w)[:5]
    return {
        "id": str(g.id),
        "name": g.name,
        "icon": icon,
        "acronym": acronym.upper(),
        "member_count": getattr(g, "member_count", 0) or 0,
        "owner_id": str(g.owner_id) if getattr(g, "owner_id", None) else None,
        "available": bool(getattr(g, "available", True)),
    }


def channel_json(c) -> dict:
    ctype = str(getattr(c, "type", "text"))
    # discord.ChannelType.text -> "text"
    if "." in ctype:
        ctype = ctype.split(".")[-1]
    return {
        "id": str(c.id),
        "guild_id": str(c.guild.id) if getattr(c, "guild", None) else None,
        "name": getattr(c, "name", None)
        or getattr(getattr(c, "recipient", None), "name", "dm"),
        "type": ctype,
        "position": getattr(c, "position", 0),
        "parent_id": str(c.category_id)
        if getattr(c, "category_id", None)
        else None,
        "topic": getattr(c, "topic", None),
    }


def message_json(m) -> dict:
    try:
        clean = m.clean_content
    except Exception:
        clean = m.content
    embeds = []
    for e in getattr(m, "embeds", []) or []:
        try:
            embeds.append(e.to_dict())
        except Exception:
            pass
    attachments = []
    for a in getattr(m, "attachments", []) or []:
        attachments.append(
            {
                "id": str(a.id),
                "url": a.url,
                "proxy_url": getattr(a, "proxy_url", a.url),
                "filename": getattr(a, "filename", ""),
                "content_type": getattr(a, "content_type", "") or "",
                "width": getattr(a, "width", None),
                "height": getattr(a, "height", None),
                "size": getattr(a, "size", 0),
            }
        )
    mentions_users = [
        {"id": str(u.id), "username": getattr(u, "name", "?")}
        for u in getattr(m, "mentions", []) or []
        if hasattr(u, "id")
    ]
    # discord.py exposes user/role/channel mentions as raw id lists.
    try:
        mention_roles = [str(i) for i in getattr(m, "raw_role_mentions", [])]
    except Exception:
        mention_roles = []
    try:
        mention_channels = [
            str(i) for i in getattr(m, "raw_channel_mentions", [])
        ]
    except Exception:
        mention_channels = []
    member = None
    try:
        if getattr(m, "author", None) is not None and hasattr(
            m.author, "display_name"
        ):
            # author may already be a Member in guild channels
            if isinstance(m.author, discord.Member):
                member = member_json(m.author)
    except Exception:
        member = None
    created = m.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    edited = getattr(m, "edited_at", None)
    if edited is not None and edited.tzinfo is None:
        edited = edited.replace(tzinfo=timezone.utc)
    jump_guild = getattr(getattr(m, "guild", None), "id", None)
    return {
        "id": str(m.id),
        "channel_id": str(m.channel.id),
        "guild_id": str(jump_guild) if jump_guild else None,
        "author": user_json(m.author),
        "member": member,
        "content": m.content or "",
        "clean_content": clean or "",
        "mentions": {
            "users": mentions_users,
            "roles": mention_roles,
            "channels": mention_channels,
        },
        "embeds": embeds,
        "attachments": attachments,
        "timestamp": created.isoformat() if created else None,
        "edited_timestamp": edited.isoformat() if edited else None,
        "pinned": bool(getattr(m, "pinned", False)),
        "tts": bool(getattr(m, "tts", False)),
    }


# ---------------------------------------------------------------------------
# Discord client owned by this server process
# ---------------------------------------------------------------------------


class BotcordClient(discord.Client):
    def __init__(self, state: "BotState"):
        intents = discord.Intents(
            guilds=True,
            guild_messages=True,
            members=True,
            voice_states=True,
            message_content=True,
            guild_typing=True,
            presences=True,
            dm_typing=True,
            dm_messages=True,
        )
        super().__init__(intents=intents, chunk_guilds_at_startup=False)
        self.state = state

    async def on_ready(self):
        log.info("Logged in as %s", self.user)
        self.state.ready_event.set()
        try:
            info = await self.application_info()
            owner = info.owner
            if isinstance(owner, discord.Team):
                self.state.team = [
                    user_json(m.user) for m in owner.members
                ]
                self.state.owner = None
                self.state.is_team = True
            else:
                self.state.owner = user_json(owner)
                self.state.team = []
                self.state.is_team = False
        except Exception as exc:  # teams / owner lookup must not break login
            log.warning("application_info failed: %r", exc)
        await self.state.broadcast(
            "ready", {"user": user_json(self.user)}
        )

    async def on_guild_available(self, guild):
        await self.state.broadcast("guild_available", guild_json(guild))

    async def on_guild_join(self, guild):
        await self.state.broadcast("guild_create", guild_json(guild))

    async def on_guild_remove(self, guild):
        await self.state.broadcast("guild_delete", {"id": str(guild.id)})

    async def on_message(self, message):
        await self.state.broadcast("message_create", message_json(message))

    async def on_message_edit(self, before, after):
        await self.state.broadcast("message_update", message_json(after))

    async def on_message_delete(self, message):
        await self.state.broadcast(
            "message_delete",
            {
                "id": str(message.id),
                "channel_id": str(message.channel.id),
                "guild_id": str(getattr(message.guild, "id", "") or ""),
            },
        )

    async def on_bulk_message_delete(self, messages):
        if not messages:
            return
        first = messages[0]
        await self.state.broadcast(
            "message_delete_bulk",
            {
                "ids": [str(m.id) for m in messages],
                "channel_id": str(first.channel.id),
                "guild_id": str(getattr(first.guild, "id", "") or ""),
            },
        )

    async def on_typing(self, channel, user, when):
        if self.user and user.id == self.user.id:
            return
        payload = {
            "channel_id": str(channel.id),
            "guild_id": str(getattr(channel, "guild", None) and channel.guild.id or ""),
            "user": user_json(user),
        }
        await self.state.broadcast("typing_start", payload)

    async def on_member_join(self, member):
        await self.state.broadcast(
            "member_add",
            {"guild_id": str(member.guild.id), "member": member_json(member)},
        )

    async def on_member_remove(self, member):
        await self.state.broadcast(
            "member_remove",
            {"guild_id": str(member.guild.id), "user_id": str(member.id)},
        )

    async def on_presence_update(self, before, after):
        try:
            status = str(after.status)
        except Exception:
            status = "offline"
        await self.state.broadcast(
            "presence_update",
            {
                "guild_id": str(after.guild.id),
                "user_id": str(after.id),
                "status": status,
            },
        )


class BotState:
    """Holds the single active discord client + connected browsers."""

    def __init__(self):
        self.client: BotcordClient | None = None
        self.login_task: asyncio.Task | None = None
        self.login_error: str | None = None
        self.ready_event = asyncio.Event()
        self.sockets: set = set()
        self.owner: dict | None = None
        self.team: list = []
        self.is_team = False
        self.team_choice: str | None = None
        self.lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        c = self.client
        return bool(c and not c.is_closed() and c.is_ready())

    async def broadcast(self, event: str, data: dict):
        if not self.sockets:
            return
        payload = json.dumps({"t": event, "d": data})
        dead = []
        for ws in list(self.sockets):
            try:
                await ws.send_str(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)

    async def shutdown_client(self):
        if self.login_task and not self.login_task.done():
            self.login_task.cancel()
            try:
                await self.login_task
            except (asyncio.CancelledError, Exception):
                pass
        self.login_task = None
        if self.client:
            try:
                await self.client.close()
            except Exception:
                pass
        self.client = None
        self.login_error = None
        self.ready_event.clear()
        self.owner = None
        self.team = []
        self.is_team = False
        self.team_choice = None

    def _run_client(self, token: str):
        async def _runner():
            try:
                await self.client.start(token)
            except discord.LoginFailure:
                self.login_error = "INVALID-TOKEN"
            except discord.PrivilegedIntentsRequired:
                self.login_error = "PRIVILEGED-INTENTS-REQUIRED"
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # e.g. connection errors
                self.login_error = f"CONNECTION-ERROR: {exc}"
            await self.broadcast(
                "login_error" if self.login_error else "connected",
                {"error": self.login_error},
            )

        return _runner()

    async def login(self, token: str):
        async with self.lock:
            if self.client and not self.client.is_closed():
                # same token already active?
                try:
                    if getattr(self.client, "_token", None) == token:
                        return {"same": True}
                except Exception:
                    pass
            await self.shutdown_client()
            self.ready_event = asyncio.Event()
            self.client = BotcordClient(self)
            try:
                self.client._token = token  # for SAME-TOKEN short-circuit
            except Exception:
                pass
            loop = asyncio.get_running_loop()
            self.login_task = loop.create_task(self._run_client(token))
            try:
                await asyncio.wait_for(self.ready_event.wait(), timeout=45)
            except asyncio.TimeoutError:
                if self.login_error:
                    err = self.login_error
                else:
                    err = "LOGIN-TIMEOUT"
                await self.shutdown_client()
                return {"error": err}
            if self.login_error:
                err = self.login_error
                await self.shutdown_client()
                return {"error": err}
            user = user_json(self.client.user)
            return {
                "user": user,
                "owner": self.owner,
                "is_team": self.is_team,
                "team": self.team,
            }


WEB_PASSWORD = os.environ.get("BOTCORD_PASSWORD", "")
# Multi-user hosting knobs. Each browser session that logs in holds one
# discord.py gateway connection, so cap concurrent sessions and expire
# idle ones to keep a public host healthy.
MAX_SESSIONS = int(os.environ.get("BOTCORD_MAX_SESSIONS", "50"))
SESSION_TIMEOUT = int(os.environ.get("BOTCORD_SESSION_TIMEOUT", "86400"))
LOGIN_LIMIT = int(os.environ.get("BOTCORD_LOGIN_LIMIT", "10"))
LOGIN_WINDOW = int(os.environ.get("BOTCORD_LOGIN_WINDOW", "300"))


class Session:
    """One browser session. Owns a private BotState (= one bot login)."""

    __slots__ = ("id", "state", "last_active", "created")

    def __init__(self, sid: str):
        self.id = sid
        self.state = BotState()
        now = time.monotonic()
        self.last_active = now
        self.created = now

    def touch(self):
        self.last_active = time.monotonic()

    @property
    def idle_for(self) -> float:
        return time.monotonic() - self.last_active


SESSIONS: dict[str, Session] = {}
SESSIONS_LOCK = asyncio.Lock()
LOGIN_ATTEMPTS: dict[str, list] = {}


def _prune_attempts(ip: str, now: float) -> list:
    attempts = [t for t in LOGIN_ATTEMPTS.get(ip, []) if now - t < LOGIN_WINDOW]
    LOGIN_ATTEMPTS[ip] = attempts
    return attempts


def login_allowed(ip: str) -> bool:
    now = time.time()
    if len(LOGIN_ATTEMPTS) > 2000:  # bound memory on public hosts
        for key in list(LOGIN_ATTEMPTS):
            _prune_attempts(key, now)
            if not LOGIN_ATTEMPTS[key]:
                del LOGIN_ATTEMPTS[key]
    return len(_prune_attempts(ip, now)) < LOGIN_LIMIT


def record_login_attempt(ip: str):
    LOGIN_ATTEMPTS.setdefault(ip, []).append(time.time())


async def create_session() -> Session | None:
    """Make a new browser session, or None when the host is full."""
    async with SESSIONS_LOCK:
        if len(SESSIONS) >= MAX_SESSIONS:
            return None
        sess = Session(secrets.token_urlsafe(24))
        SESSIONS[sess.id] = sess
        return sess


async def drop_session(sid: str):
    async with SESSIONS_LOCK:
        sess = SESSIONS.pop(sid, None)
    if sess is not None:
        try:
            await sess.state.shutdown_client()
        except Exception:
            pass


async def session_janitor():
    """Background task: disconnect bots of long-idle browser sessions."""
    while True:
        try:
            await asyncio.sleep(300)
            stale = []
            async with SESSIONS_LOCK:
                for sid, sess in list(SESSIONS.items()):
                    if sess.idle_for > SESSION_TIMEOUT:
                        stale.append(SESSIONS.pop(sid))
            for sess in stale:
                log.info("Expiring idle session")
                try:
                    await sess.state.shutdown_client()
                except Exception:
                    pass
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.warning("session janitor error: %r", exc)


def req_state(request) -> BotState:
    sess = request["session"]
    sess.touch()
    return sess.state


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def require_bot(request):
    state = req_state(request)
    if state.client is None or state.client.is_closed():
        raise web.HTTPBadRequest(
            text=json.dumps({"error": "NOT-LOGGED-IN"}),
            content_type="application/json",
        )
    return state.client


class _MemberTimeout(Exception):
    """Internal: member HTTP fetch exceeded its budget; use the cache."""


def get_text_channel(client, channel_id: str):
    try:
        cid = int(channel_id)
    except (TypeError, ValueError):
        raise web.HTTPNotFound(
            text=json.dumps({"error": "UNKNOWN-CHANNEL"}),
            content_type="application/json",
        )
    channel = client.get_channel(cid)
    if channel is None:
        # DM channels may not be cached; try fetching the user instead
        raise web.HTTPNotFound(
            text=json.dumps({"error": "UNKNOWN-CHANNEL"}),
            content_type="application/json",
        )
    return channel


async def fetch_history(channel, limit=50, before_id=None, after_id=None):
    kwargs = {"limit": max(1, min(int(limit or 50), 100))}
    if before_id:
        try:
            kwargs["before"] = discord.Object(id=int(before_id))
        except (TypeError, ValueError):
            pass
    if after_id:
        try:
            kwargs["after"] = discord.Object(id=int(after_id))
        except (TypeError, ValueError):
            pass
    messages = []
    try:

        async def _collect():
            out = []
            async for m in channel.history(**kwargs):
                out.append(message_json(m))
            return out

        # Never hang the loader forever: Discord HTTP can stall or get
        # rate-limited. The browser aborts after 30s, so answer before that.
        messages = await asyncio.wait_for(_collect(), timeout=25)
    except asyncio.TimeoutError:
        raise web.HTTPGatewayTimeout(
            text=json.dumps({"error": "HISTORY-TIMEOUT"}),
            content_type="application/json",
        )
    except discord.Forbidden:
        raise web.HTTPForbidden(
            text=json.dumps({"error": "MISSING-ACCESS"}),
            content_type="application/json",
        )
    except discord.HTTPException as exc:
        raise web.HTTPBadGateway(
            text=json.dumps({"error": f"DISCORD-API-ERROR: {exc}"}),
            content_type="application/json",
        )
    messages.reverse()  # oldest first, like the desktop client rendered
    return messages


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

routes = web.RouteTableDef()


@web.middleware
async def password_middleware(request, handler):
    def cors(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        return resp

    if WEB_PASSWORD and request.path.startswith("/api"):
        given = request.headers.get("X-Botcord-Password", "") or request.query.get(
            "password", ""
        )
        if given != WEB_PASSWORD:
            return cors(web.json_response({"error": "UNAUTHORIZED"}, status=401))
    # permissive CORS so the site can be hosted separately from the bot host
    if request.method == "OPTIONS":
        return cors(web.Response(status=204))
    # every API call except session creation needs a live browser session,
    # so one user's bot can never leak into another user's browser
    if request.path.startswith("/api") and request.path != "/api/session":
        sid = request.headers.get("X-Botcord-Session", "") or request.query.get(
            "session", ""
        )
        sess = SESSIONS.get(sid) if sid else None
        if sess is None:
            return cors(web.json_response({"error": "NO-SESSION"}, status=401))
        sess.touch()
        request["session"] = sess
    try:
        resp = await handler(request)
    except web.HTTPException as exc:
        # convert to a plain response so CORS headers still apply
        resp = web.Response(
            status=exc.status,
            text=exc.text or "",
            content_type=getattr(exc, "content_type", None) or "text/plain",
        )
    return cors(resp)


@routes.post("/api/session")
async def api_session(request):
    sess = await create_session()
    if sess is None:
        return web.json_response({"error": "SESSION-LIMIT"}, status=503)
    return web.json_response({"session_id": sess.id})


@routes.get("/api/version")
async def api_version(request):
    return web.json_response({"version": SERVER_VERSION, "sessions": True})


@routes.get("/api/status")
async def api_status(request):
    state = req_state(request)
    client = state.client
    if client is None or client.is_closed():
        return web.json_response(
            {"connected": False, "error": state.login_error}
        )
    return web.json_response(
        {
            "connected": client.is_ready(),
            "user": user_json(client.user) if client.user else None,
            "owner": state.owner,
            "is_team": state.is_team,
            "team": state.team,
            "latency_ms": round(client.latency * 1000),
        }
    )


@routes.post("/api/login")
async def api_login(request):
    ip = request.remote or "unknown"
    if not login_allowed(ip):
        return web.json_response({"error": "LOGIN-RATE-LIMITED"}, status=429)
    try:
        body = await request.json()
    except Exception:
        body = {}
    token = (body.get("token") or "").strip()
    err = validate_token(token)
    if err:
        return web.json_response({"error": err}, status=400)
    record_login_attempt(ip)
    state = req_state(request)
    result = await state.login(token)
    if "error" in result:
        code = result["error"]
        status = 401 if code == "INVALID-TOKEN" else 500
        return web.json_response({"error": code}, status=status)
    if result.get("same"):
        return web.json_response({"ok": True, "same": True})
    return web.json_response({"ok": True, **result})


@routes.post("/api/logout")
async def api_logout(request):
    state = req_state(request)
    async with state.lock:
        await state.shutdown_client()
    await state.broadcast("disconnected", {})
    return web.json_response({"ok": True})


@routes.post("/api/team-select")
async def api_team_select(request):
    state = req_state(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    state.team_choice = str(body.get("user_id") or "")
    return web.json_response({"ok": True, "owner_id": state.team_choice})


@routes.get("/api/me")
async def api_me(request):
    client = require_bot(request)
    state = req_state(request)
    return web.json_response(
        {
            "user": user_json(client.user),
            "owner": state.owner,
            "is_team": state.is_team,
            "team": state.team,
            "latency_ms": round(client.latency * 1000),
        }
    )


@routes.get("/api/guilds")
async def api_guilds(request):
    client = require_bot(request)
    return web.json_response({"guilds": [guild_json(g) for g in client.guilds]})


@routes.get("/api/guilds/{gid}/channels")
async def api_guild_channels(request):
    client = require_bot(request)
    try:
        guild = client.get_guild(int(request.match_info["gid"]))
    except (TypeError, ValueError):
        guild = None
    if guild is None:
        return web.json_response({"error": "UNKNOWN-GUILD"}, status=404)
    channels = []
    for c in guild.channels:
        channels.append(channel_json(c))
    channels.sort(key=lambda c: (c["type"] == "voice", c["position"]))
    threads = []
    try:
        for t in guild.threads:
            threads.append(channel_json(t))
    except Exception:
        pass
    return web.json_response({"channels": channels, "threads": threads})


@routes.get("/api/guilds/{gid}/members")
async def api_guild_members(request):
    client = require_bot(request)
    try:
        guild = client.get_guild(int(request.match_info["gid"]))
    except (TypeError, ValueError):
        guild = None
    if guild is None:
        return web.json_response({"error": "UNKNOWN-GUILD"}, status=404)
    try:
        limit = max(1, min(int(request.query.get("limit", "500")), 1000))
    except ValueError:
        limit = 500
    members = []
    try:
        # chunk first so large guilds resolve display names.
        # Never wait forever: without the members intent no chunk ever
        # arrives and this would hang the request (stuck loader).
        if not guild.chunked:
            try:
                await asyncio.wait_for(guild.chunk(cache=True), timeout=10)
            except (asyncio.TimeoutError, Exception):
                pass

        async def _collect_members():
            out = []
            async for m in guild.fetch_members(limit=limit):
                out.append(member_json(m))
            return out

        # fetch_members() is plain Discord HTTP with internal retries /
        # rate-limit waits. Cap it so we always answer before the browser's
        # 30s fetch timeout fires; on timeout fall back to the cache below.
        try:
            members = await asyncio.wait_for(_collect_members(), timeout=20)
        except asyncio.TimeoutError:
            raise _MemberTimeout()
    except _MemberTimeout:
        try:
            members = [member_json(m) for m in list(guild.members)[:limit]]
        except Exception as exc:
            return web.json_response(
                {"error": f"MEMBER-FETCH-FAILED: {exc}"}, status=500
            )
    except Exception:
        # fall back to whatever is cached
        try:
            members = [member_json(m) for m in list(guild.members)[:limit]]
        except Exception as exc:
            return web.json_response(
                {"error": f"MEMBER-FETCH-FAILED: {exc}"}, status=500
            )
    members.sort(key=lambda m: (m["bot"], (m["display_name"] or "").lower()))
    return web.json_response({"members": members, "total": guild.member_count})


@routes.get("/api/guilds/{gid}/roles")
async def api_guild_roles(request):
    client = require_bot(request)
    try:
        guild = client.get_guild(int(request.match_info["gid"]))
    except (TypeError, ValueError):
        guild = None
    if guild is None:
        return web.json_response({"error": "UNKNOWN-GUILD"}, status=404)
    roles = sorted(
        [role_json(r) for r in guild.roles],
        key=lambda r: r["position"],
        reverse=True,
    )
    return web.json_response({"roles": roles})


@routes.get("/api/dms")
async def api_dms(request):
    client = require_bot(request)
    dms = []
    for ch in client.private_channels:
        try:
            recipient = getattr(ch, "recipient", None)
            me = client.user
            other = None
            if recipient is not None:
                other = recipient
            else:  # group DM
                recipients = getattr(ch, "recipients", [])
                other = recipients[0] if recipients else None
            dms.append(
                {
                    "channel_id": str(ch.id),
                    "type": str(getattr(ch, "type", "private")).split(".")[-1],
                    "recipient": user_json(other) if other else None,
                    "me": user_json(me) if me else None,
                }
            )
        except Exception:
            continue
    return web.json_response({"dms": dms})


@routes.get("/api/emojis")
async def api_emojis(request):
    client = require_bot(request)
    emojis = []
    try:
        for e in client.emojis:
            emojis.append(
                {
                    "id": str(e.id),
                    "name": e.name,
                    "animated": bool(e.animated),
                    "url": str(e.url),
                }
            )
    except Exception:
        pass
    return web.json_response({"emojis": emojis})


@routes.get("/api/channels/{cid}/messages")
async def api_get_messages(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    messages = await fetch_history(
        channel,
        limit=request.query.get("limit", "50"),
        before_id=request.query.get("before"),
        after_id=request.query.get("after"),
    )
    return web.json_response({"messages": messages})


@routes.post("/api/channels/{cid}/messages")
async def api_send_message(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        body = await request.json()
    except Exception:
        body = {}
    content = body.get("content") or ""
    embed_data = body.get("embed")
    if not content.strip() and not embed_data:
        return web.json_response({"error": "EMPTY-MESSAGE"}, status=400)
    if len(content) > 2000:
        return web.json_response({"error": "MESSAGE-TOO-LONG"}, status=400)
    embed = None
    if embed_data:
        try:
            embed = discord.Embed.from_dict(dict(embed_data))
        except Exception as exc:
            return web.json_response(
                {"error": f"BAD-EMBED: {exc}"}, status=400
            )
    try:
        msg = await channel.send(
            content if content.strip() else None, embed=embed
        )
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-PERMISSIONS"}, status=403)
    except discord.HTTPException as exc:
        return web.json_response(
            {"error": f"SEND-FAILED: {exc}"}, status=502
        )
    return web.json_response({"message": message_json(msg)})


@routes.patch("/api/channels/{cid}/messages/{mid}")
async def api_edit_message(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        body = await request.json()
    except Exception:
        body = {}
    content = body.get("content") or ""
    if not content.strip():
        return web.json_response({"error": "EMPTY-MESSAGE"}, status=400)
    try:
        msg = await channel.fetch_message(int(request.match_info["mid"]))
    except (ValueError, discord.NotFound):
        return web.json_response({"error": "UNKNOWN-MESSAGE"}, status=404)
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-ACCESS"}, status=403)
    try:
        await msg.edit(content=content)
    except discord.HTTPException as exc:
        return web.json_response({"error": f"EDIT-FAILED: {exc}"}, status=502)
    return web.json_response({"message": message_json(msg)})


@routes.delete("/api/channels/{cid}/messages/{mid}")
async def api_delete_message(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        msg = await channel.fetch_message(int(request.match_info["mid"]))
    except (ValueError, discord.NotFound):
        return web.json_response({"error": "UNKNOWN-MESSAGE"}, status=404)
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-ACCESS"}, status=403)
    try:
        await msg.delete()
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-PERMISSIONS"}, status=403)
    except discord.HTTPException as exc:
        return web.json_response(
            {"error": f"DELETE-FAILED: {exc}"}, status=502
        )
    return web.json_response({"ok": True})


@routes.post("/api/channels/{cid}/bulk-delete")
async def api_bulk_delete(request):
    """Purge N recent messages (the old `/purge <num>` command)."""
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        count = max(1, min(int(body.get("count", 1)), 100))
    except (TypeError, ValueError):
        return web.json_response({"error": "BAD-COUNT"}, status=400)
    try:
        deleted = await channel.purge(limit=count)
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-PERMISSIONS"}, status=403)
    except discord.HTTPException as exc:
        return web.json_response({"error": f"PURGE-FAILED: {exc}"}, status=502)
    return web.json_response({"deleted": len(deleted)})


@routes.post("/api/channels/{cid}/pins/{mid}")
async def api_pin_message(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        msg = await channel.fetch_message(int(request.match_info["mid"]))
    except (ValueError, discord.NotFound):
        return web.json_response({"error": "UNKNOWN-MESSAGE"}, status=404)
    try:
        await msg.pin()
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-PERMISSIONS"}, status=403)
    except discord.HTTPException as exc:
        return web.json_response({"error": f"PIN-FAILED: {exc}"}, status=502)
    return web.json_response({"ok": True})


@routes.delete("/api/channels/{cid}/pins/{mid}")
async def api_unpin_message(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        msg = await channel.fetch_message(int(request.match_info["mid"]))
    except (ValueError, discord.NotFound):
        return web.json_response({"error": "UNKNOWN-MESSAGE"}, status=404)
    try:
        await msg.unpin()
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-PERMISSIONS"}, status=403)
    except discord.HTTPException as exc:
        return web.json_response({"error": f"UNPIN-FAILED: {exc}"}, status=502)
    return web.json_response({"ok": True})


@routes.post("/api/channels/{cid}/typing")
async def api_typing(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        await channel.trigger_typing()
    except Exception:
        pass
    return web.json_response({"ok": True})


@routes.post("/api/channels/{cid}/invites")
async def api_create_invite(request):
    client = require_bot(request)
    channel = get_text_channel(client, request.match_info["cid"])
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        invite = await channel.create_invite(
            max_age=int(body.get("max_age", 86400)),
            max_uses=int(body.get("max_uses", 0) or 0),
            unique=True,
        )
    except discord.Forbidden:
        return web.json_response({"error": "MISSING-PERMISSIONS"}, status=403)
    except discord.HTTPException as exc:
        return web.json_response(
            {"error": f"INVITE-FAILED: {exc}"}, status=502
        )
    return web.json_response({"code": invite.code, "url": str(invite.url)})


@routes.patch("/api/me")
async def api_update_me(request):
    client = require_bot(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    username = (body.get("username") or "").strip()
    if not username or not username.replace(" ", "").replace("#", ""):
        return web.json_response({"error": "EMPTY-NAME"}, status=400)
    try:
        await client.user.edit(username=username)
    except discord.HTTPException as exc:
        return web.json_response(
            {"error": f"USERNAME-FAILED: {exc}"}, status=502
        )
    return web.json_response({"user": user_json(client.user)})


_STATUS_MAP = {
    "online": discord.Status.online,
    "idle": discord.Status.idle,
    "dnd": discord.Status.dnd,
    "invisible": discord.Status.invisible,
    "offline": discord.Status.invisible,
}

_ACTIVITY_MAP = {
    "playing": discord.ActivityType.playing,
    "streaming": discord.ActivityType.streaming,
    "listening": discord.ActivityType.listening,
    "watching": discord.ActivityType.watching,
    "competing": discord.ActivityType.competing,
}


@routes.put("/api/me/presence")
async def api_update_presence(request):
    client = require_bot(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    status = _STATUS_MAP.get(
        str(body.get("status", "online")).lower(), discord.Status.online
    )
    activity = None
    activity_type = str(body.get("activity_type") or "none").lower()
    name = (body.get("activity_name") or "").strip()
    url = (body.get("stream_url") or "").strip() or None
    if activity_type != "none" and name:
        atype = _ACTIVITY_MAP.get(activity_type, discord.ActivityType.playing)
        if activity_type == "streaming" and url:
            activity = discord.Streaming(name=name, url=url)
        else:
            activity = discord.Activity(type=atype, name=name)
    try:
        await client.change_presence(status=status, activity=activity)
    except Exception as exc:
        return web.json_response(
            {"error": f"PRESENCE-FAILED: {exc}"}, status=502
        )
    return web.json_response({"ok": True})


@routes.get("/ws")
async def websocket_handler(request):
    sid = request.query.get("session", "")
    sess = SESSIONS.get(sid) if sid else None
    if sess is None:
        return web.Response(status=401, text="NO-SESSION")
    state = sess.state
    sess.touch()
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    state.sockets.add(ws)
    try:
        # hello so the UI can sync immediately
        client = state.client
        await ws.send_str(
            json.dumps(
                {
                    "t": "hello",
                    "d": {
                        "connected": bool(
                            client and not client.is_closed() and client.is_ready()
                        ),
                        "user": user_json(client.user)
                        if client and client.user
                        else None,
                    },
                }
            )
        )
        async for msg in ws:
            sess.touch()
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except Exception:
                    continue
                # keep-alive pings from the browser
                if data.get("t") == "ping":
                    await ws.send_str(json.dumps({"t": "pong", "d": {}}))
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        state.sockets.discard(ws)
    return ws


# ---------------------------------------------------------------------------
# Static files: ./web first, then legacy folders for reused assets
# ---------------------------------------------------------------------------


def build_app() -> web.Application:
    app = web.Application(middlewares=[password_middleware])
    app.add_routes(routes)
    app.router.add_static("/js/", WEB_DIR / "js", show_index=False)
    # legacy asset folders reused directly (no duplication)
    for public, folder in (
        ("/css/", BASE_DIR / "css"),
        ("/resources/", BASE_DIR / "resources"),
        ("/themes/", BASE_DIR / "themes"),
    ):
        if folder.exists():
            app.router.add_static(public, folder, show_index=False)

    async def index(request):
        # never cache the shell: it pins versioned asset URLs, so users
        # always get the matching site after an update
        resp = web.FileResponse(WEB_DIR / "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    app.router.add_get("/", index)
    # anything else that is not /api/* falls back to the SPA shell
    async def spa_fallback(request):
        if request.path.startswith("/api") or request.path.startswith("/ws"):
            return web.json_response({"error": "NOT-FOUND"}, status=404)
        index_file = WEB_DIR / "index.html"
        if index_file.exists():
            resp = web.FileResponse(index_file)
            resp.headers["Cache-Control"] = "no-cache"
            return resp
        return web.json_response({"error": "NOT-FOUND"}, status=404)

    app.router.add_get("/{tail:.*}", spa_fallback)

    async def on_startup(app):
        app["janitor"] = asyncio.create_task(session_janitor())

    async def on_shutdown(app):
        janitor = app.get("janitor")
        if janitor:
            janitor.cancel()
            try:
                await janitor
            except (asyncio.CancelledError, Exception):
                pass
        async with SESSIONS_LOCK:
            sessions = list(SESSIONS.values())
            SESSIONS.clear()
        for sess in sessions:
            try:
                await sess.state.shutdown_client()
            except Exception:
                pass

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app


def main():
    parser = argparse.ArgumentParser(description="Botcord Python host")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PORT", "8080"))
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if not (WEB_DIR / "index.html").exists():
        log.warning(
            "web/index.html not found — the API will run but there is no UI yet."
        )
    if WEB_PASSWORD:
        log.info("Password protection enabled (BOTCORD_PASSWORD is set).")
    else:
        log.info(
            "No BOTCORD_PASSWORD set — anyone who can reach this server can "
            "log in their own bot. Bind to 127.0.0.1 or use a reverse-proxy "
            "auth for public hosting."
        )
    log.info(
        "Sessions: max %d per host, idle expiry after %ds, login rate limit "
        "%d attempts per %ds per IP.",
        MAX_SESSIONS,
        SESSION_TIMEOUT,
        LOGIN_LIMIT,
        LOGIN_WINDOW,
    )
    web.run_app(build_app(), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
