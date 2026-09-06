# Botcord Web — Python host + browser client

This is the web version of LiveBot/Botcord. Instead of an Electron desktop
app with discord.js running inside the UI, the architecture is now:

```
browser (static site in ./web/)  <--REST + WebSocket-->  server.py (Python)
                                                              |
                                                     discord.py bot client
                                                              |
                                                           Discord
```

* **Python is the main host.** `server.py` owns the single discord.py bot
  connection: login, guilds, channels, members, messages, presence,
  invites, and all realtime gateway events.
* **The website can be hosted by anything.** `server.py` serves the site
  itself (simplest), or you can host `./web` + the reused `./css`,
  `./resources`, `./themes` folders on any static host and point the UI at
  the Python backend (CORS is open for `/api`).

## Quick start

```sh
pip install -r requirements.txt
python server.py
# open http://localhost:8080 and paste your bot token
```

Options:

```sh
python server.py --host 127.0.0.1 --port 8080
PORT=8080 HOST=0.0.0.0 python server.py
```

## Before you log in

1. Create a bot at <https://discord.com/developers/applications>.
2. Under **Bot**, enable the privileged intents:
   **Server Members**, **Message Content**, **Presence**.
   (Without these, login fails with `PRIVILEGED-INTENTS-REQUIRED`
   and member lists / message content won't load.)
3. Invite the bot to at least one server, copy its token, paste it on
   the login screen. "Log in and save as default" remembers it in the
   browser (localStorage); "One time login" doesn't.

## Protecting the server / public hosting

Each visitor gets a **private session** (`POST /api/session`, kept in
their browser): every user logs in their own bot, on their own isolated
discord.py connection. Nobody can see or touch anyone else's bot, and
tokens are kept only in memory — never written to disk. Idle sessions
are disconnected automatically.

For a public website you should still:

1. **Set a password** (otherwise anyone can use your host):
   ```sh
   BOTCORD_PASSWORD="pick-a-strong-password" python server.py
   ```
   The site asks for it once and remembers it per browser.
2. **Put it behind HTTPS** (Caddy, nginx, Cloudflare Tunnel, …).
   Example with Caddy:
   ```
   botcord.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```
3. Tune the multi-user knobs if needed:

| Variable | Default | Meaning |
|---|---|---|
| `BOTCORD_PASSWORD` | *(none)* | Password required by the site |
| `BOTCORD_MAX_SESSIONS` | `50` | Max concurrent browser sessions |
| `BOTCORD_SESSION_TIMEOUT` | `86400` | Idle seconds before a session's bot is disconnected (24 h) |
| `BOTCORD_LOGIN_LIMIT` / `BOTCORD_LOGIN_WINDOW` | `10` / `300` | Max logins per IP per window (seconds) |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Bind address and port |

Each logged-in session holds one Discord gateway connection, so size
`BOTCORD_MAX_SESSIONS` for what your host can handle.

## Mobile support

The UI is responsive: on screens ≤ 860 px wide the message view takes
the full width and the channel/member lists become slide-over drawers
(☰ and 👥 buttons in the server header, or tap the chat to dismiss).
Message input, the embed builder and menus all fit small
screens, and long-press opens the context menus.

## Stuck on "Loading servers"?

First: **restart `server.py` and hard-refresh the site
(Ctrl+Shift+R / Cmd+Shift+R)**. The app now detects an outdated
server or cached site by itself and says so on the splash screen —
if you see that message, update both sides.

The splash screen otherwise shows the actual reason instead of hanging
silently. The usual causes:

1. **Privileged intents off** — enable Server Members, Message Content
   and Presence in the developer portal, then log in again.
2. **Bot in no servers** (or not in a server *with* you) — invite it
   somewhere first.
3. **Bot can't read the first channel** — check its roles/permissions.
4. Still stuck? Open the server terminal where `python server.py`
   runs for the backend error, and press F12 → Console in the browser
   for the frontend error.

## Features (ported from the desktop client)

* Splash login screen, token validation, team-app owner picker
* Guild list, channel list (categories, voice shown, unread badges)
* DM home with open-DM list
* Message history (100), grouped rendering, markdown / spoilers /
  code blocks / unicode + custom emoji, mentions, embeds, attachments
* Link previews: bare image / video / GIF links (and Giphy share links)
  expand inline with a player and GIF badges, skipping links Discord
  already unfurled or that sit inside code spans
* Sending, inline edit, delete, pin/unpin, purge (`/purge <n>`)
* Instant sends: your message appears immediately, greyed out, and turns
  normal once the server confirms it (red + click-to-retry on failure)
* Composer: attachment (+) button, voice-message recorder (🎤, sent as an
  audio file), emoji picker (😀, unicode + server emoji); uploads cap 25 MB
* Smart timestamps (time-only for today) with labeled Today / Yesterday /
  date dividers between days
* Discord-style shimmer skeletons while a channel's messages load
* Replies: right-click → Reply, composer bar above the input with an
  @ON/@OFF ping toggle, quoted preview on messages (click jumps to the
  original when loaded)
* Discord-style mentions: Shift+Click a name/avatar/member (or type `@`
  for autocomplete) — shows `@Name` pills, sends `<@id>` so it pings
* Reactions: view, toggle by clicking, add via right-click → Add reaction
  (unicode + server emoji), realtime gateway updates
* Message Components V2 + polls rendered (buttons/selects shown disabled —
  bots can't press each other's components; link buttons open normally)
* Realtime via WebSocket: new / edited / deleted messages, typing
  indicator, member join/leave, presence, guild add/remove
* Member list (online/offline), bottom bot status bar (avatar + name)
* Embed builder (📄 icon next to the message box)
* Slash commands: `/help /shrug /tableflip /unflip /lenny /ping
  /server /purge /eval` (eval runs locally in your browser only)
* Right-click menus: reply, copy content/ID/link, edit/delete/pin, copy user
  and channel IDs, create channel invite

## Known limitations vs the desktop app

* Node **scripts** (`scripts/`) are not supported — they executed with
  full bot access, which is unsafe to expose over HTTP.
* No settings panel in the UI: presence, username changes, token-switch,
  invite generation and logout are still available over the REST API
  (see below) for custom frontends, but have no buttons in the client.
* No theme manager UI yet; you can still add a stylesheet link in
  `web/index.html` pointing at `/themes/your-theme.css`.
* History loads the latest 100 messages per channel (same as the
  desktop client), no infinite scroll-back yet.
* Voice channels are listed but voice join/play was never implemented
  in the desktop client either.

## API reference (for custom frontends / bots)

REST (`Content-Type: application/json`). Every call except
`POST /api/session` needs the `X-Botcord-Session` header (the browser
stores it automatically); without it the API answers `NO-SESSION`.

| Method | Path | Body → result |
|---|---|---|
| POST | `/api/session` | → `{session_id}` (one per browser) |
| GET | `/api/status` | `{connected, user?, latency_ms?}` |
| POST | `/api/login` | `{token}` → `{user, owner, is_team, team}` |
| POST | `/api/logout` | — |
| POST | `/api/team-select` | `{user_id}` (team-owned apps) |
| GET | `/api/me` | self + owner + latency |
| GET | `/api/guilds` | guild list |
| GET | `/api/guilds/{id}/channels` | channels + threads |
| GET | `/api/guilds/{id}/members?limit=` | members |
| GET | `/api/guilds/{id}/roles` | roles (position order) |
| GET | `/api/dms` | DM channels + recipients |
| GET | `/api/emojis` | bot emoji list |
| GET | `/api/channels/{id}/messages?limit&before&after` | messages, oldest first |
| GET | `/api/channels/{id}/messages/{mid}` | single message (authoritative reactions/components state) |
| POST | `/api/channels/{id}/messages` | `{content?, embed?, reply_to?, mention_author?}` |
| PATCH | `/api/channels/{id}/messages/{mid}` | `{content}` |
| DELETE | `/api/channels/{id}/messages/{mid}` | — |
| POST | `/api/channels/{id}/bulk-delete` | `{count}` (purge) |
| POST/DELETE | `/api/channels/{id}/pins/{mid}` | pin / unpin |
| POST | `/api/channels/{id}/messages/{mid}/reactions` | `{emoji}` — bot adds a reaction |
| DELETE | `/api/channels/{id}/messages/{mid}/reactions?emoji=` | bot removes its own reaction |
| POST | `/api/channels/{id}/typing` | trigger typing |
| POST | `/api/channels/{id}/invites` | create invite → `{code, url}` |
| PATCH | `/api/me` | `{username}` |
| PUT | `/api/me/presence` | `{status, activity_type, activity_name, stream_url?}` |

WebSocket `/ws?session=…` (server → browser `{t, d}`):
`hello`, `ready`, `message_create`, `message_update`,
`message_delete`, `message_delete_bulk`, `reaction_add`,
`reaction_remove`, `reaction_clear`, `reaction_clear_emoji`, `typing_start`,
`guild_create`, `guild_delete`, `member_add`, `member_remove`,
`presence_update`, `login_error`, `disconnected`.
Browser → server: `{t:"ping"}` keep-alive (→ `{t:"pong"}`).

Errors are JSON `{error: "CODE"}` with codes like `EMPTY-TOKEN`,
`INVALID-TOKEN`, `NOT-LOGGED-IN`, `NO-SESSION`, `SESSION-LIMIT`,
`LOGIN-RATE-LIMITED`, `MISSING-PERMISSIONS`,
`UNKNOWN-CHANNEL`, `PRIVILEGED-INTENTS-REQUIRED`, `LOGIN-TIMEOUT`.

## Files

* `server.py` — aiohttp + discord.py backend (REST, WebSocket, static).
* `requirements.txt` — `aiohttp`, `discord.py`.
* `web/index.html` — site shell (same DOM ids/CSS as the desktop UI).
* `web/js/api.js` — REST + WebSocket client.
* `web/js/format.js` — message markdown/mention formatting.
* `web/js/embeds.js` — embed + attachment rendering.
* `web/js/app.js` — all UI logic (lists, messages, commands).
* `web/js/vendor-converter.js` — emoji shortcut table (unchanged copy).
* `css/web.css` — small web-only styles (status dot, modal, toast).
* Legacy `css/`, `resources/`, `themes/` are served as-is, no duplication.
