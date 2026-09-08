# Botcord Web — Python host + browser client

Use your Discord **bot** like a normal Discord client, from any browser.
This is the web version of Botcord (fork of LiveBot). Instead of an
Electron desktop app with discord.js running inside the UI, the
architecture is now:

```
browser (static site in ./web/)  <--REST + WebSocket-->  server.py (Python)
                                                              |
                                                     discord.py bot client
                                                              |
                                                           Discord
```

* **Python is the main host.** `server.py` owns the discord.py bot
  connection: login, guilds, channels, members, messages, presence,
  invites, unfurls, and all realtime gateway events.
* **The website can be hosted by anything.** `server.py` serves the site
  itself (simplest), or you can host `./web` plus the reused `./css`,
  `./resources`, `./themes` folders on any static host and point the UI at
  the Python backend (CORS is open for `/api`).

## Quick start

**Windows — easiest:** double-click **`run.bat`**. It checks for Python,
installs the requirements (and warns you if that fails instead of dying
silently), starts the server, and opens Botcord in your default browser.
Leave the black "Botcord Server" window open while you use it; close it
to stop. It respects the `PORT` variable if you set one first:

```bat
set PORT=8080
run.bat
```

**Any OS — manual:**

```sh
pip install -r requirements.txt   # needs Python 3.10+
python server.py
# open http://127.0.0.1:8080 and paste your bot token
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

## Using it

* Bottom-left bar shows your bot (avatar + name + BOT tag) with a ⚙
  **settings** button next to it. Settings currently holds:
  **Appearance** (Light / Dark / Night themes, saved automatically),
  **Account** (switch to another bot token, or log out), and
  **Status** (online/idle/DND/invisible + activity: playing, streaming,
  listening, watching, competing).
* Type in the message box and hit Enter. `@` completes members, roles
  and @everyone/@here; `#` completes channels. Shift+Click any
  name/avatar to drop a mention in.
* Right-click a message for Reply, reactions, edit/delete/pin, copying
  IDs and links, and invites. The 😀 button opens the
  Emojis / GIFs / Stickers panel (per-tab search, recent items first,
  every server's customs included).
* Messages that mention you — direct pings, @everyone/@here, role pings
  you hold, or replies to your messages — glow yellow with a bar on the
  left, just like Discord. Role pills wear the role's own color.

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
| `BOTCORD_MAX_UPLOAD_BYTES` | `26214400` | Max attachment bytes per message (25 MB) |
| `BOTCORD_TENOR_KEY` | *(none)* | Tenor GIF API key — enables the GIFs tab (free at developers.google.com/tenor, Guides → Quickstart) |
| `BOTCORD_TENOR_CLIENT_KEY` / `BOTCORD_TENOR_LOCALE` | `botcord` / `en` | Sent with Tenor requests |
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
(Ctrl+Shift+R / Cmd+Shift+R)**. The app detects an outdated
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

## Features

* Splash login screen, token validation, team-app owner picker
* Guild list, channel list (categories, voice shown, unread badges)
* DM home with full DM list (users, bots, group DMs) — right-click any
  user and pick Message to open a new DM; history, sending, reactions,
  typing and replies all work in DMs
* Settings modal (⚙ by the bot bar): Light / Dark / Night (onyx) themes,
  token switching + logout, bot status and activity
* Autocomplete over the message bar: `@` completes members, roles and
  @everyone/@here; `#` completes text channels — both filter as you type
* Message history (100), grouped rendering, markdown / spoilers /
  code blocks / unicode + custom emoji, mentions, embeds, attachments
* Discord-style mention highlight: messages that ping you
  (@you, @everyone/@here, your roles, replies to you) get a yellow wash
  plus a bar on the message's left edge; role pills use the role's color,
  user/channel/@everyone pills keep the blurple tag look
* Link previews: bare image / video / GIF links (and Giphy share links)
  expand inline with a player and GIF badges, skipping links Discord
  already unfurled or that sit inside code spans
* Website unfurls: pasting a page link grows a Discord/WhatsApp-style
  card (site + favicon, title, description, preview image, Botcord logo
  as fallback) via `GET /api/unfurl`
* Sending, inline edit, delete, pin/unpin, purge (`/purge <n>`)
* Instant sends: your message appears immediately, greyed out, and turns
  normal once the server confirms it (red + click-to-retry on failure)
* Composer: attachment (+) button, voice-message recorder (🎤, sent as an
  audio file), emoji picker (😀, unicode + server emoji); uploads cap 25 MB
* Media panel (😀 button): Emojis / GIFs / Stickers tabs with per-tab
  search — recent first, every server's customs, unicode last; Tenor GIFs
  (needs `BOTCORD_TENOR_KEY`); recent stickers too; ↻ button force-refreshes
  from the server; new/removed server emoji and stickers arrive live
* Smart timestamps (time-only for today) with labeled Today / Yesterday /
  date dividers between days
* Discord-style shimmer skeletons while a channel's messages load
* Replies: right-click → Reply, composer bar above the input with an
  @ON/@OFF ping toggle, quoted preview on messages (click jumps to the
  original when loaded)
* Discord-style mentions: Shift+Click a name/avatar/member (or type `@`
  for autocomplete) — shows `@Name` pills, sends `<@id>` so it pings.
  Unknown ids (`@12345…`, also in pre-login history, embeds and V2 text)
  resolve to real names via `POST /api/resolve` once the data arrives
* Full markdown everywhere: message bodies, embeds, polls and Components
  V2 text all render bold/italic/underline/spoilers/code/links/emoji —
  code spans are protected, never disable the rest
* Custom icons: drop your own art at `resources/icons/attach.svg`,
  `resources/icons/emoji.svg`, `resources/icons/voice.svg`,
  `resources/icons/settings.svg`, `resources/icons/longlogo.svg`
  (`.png` also works, ~24px ideal, logo art never stretches) —
  otherwise the built-ins are used
* Reactions: view, toggle by clicking, add via right-click → Add reaction
  (unicode + server emoji), realtime gateway updates
* Message Components V2 + polls rendered (buttons/selects shown disabled —
  bots can't press each other's components; link buttons open normally)
* Realtime via WebSocket: new / edited / deleted messages, typing
  indicator, member join/leave, presence, guild add/remove,
  server emoji and sticker updates
* Member list (online/offline), bottom bot status bar (avatar + name)
* Embed builder (📄 icon next to the message box)
* Slash commands: `/help /shrug /tableflip /unflip /lenny /ping
  /server /purge /eval` (eval runs locally in your browser only)
* Right-click menus: reply, copy content/ID/link, edit/delete/pin, copy user
  and channel IDs, create channel invite

## Known limitations

* No scripting support — executing user scripts with full bot access
  would be unsafe to expose over HTTP.
* History loads the latest 100 messages per channel, no infinite
  scroll-back yet.
* Custom themes still work via `themes/` (see `themes/template.css`),
  alongside the built-in Light / Dark / Night switcher.
* Voice channels are listed but voice join/play is not implemented.
* Bots can't press each other's buttons or use select menus (Discord
  limitation), so those render disabled — except link buttons.

## API reference (for custom frontends / bots)

REST (`Content-Type: application/json`). Every call except
`POST /api/session` needs the `X-Botcord-Session` header (the browser
stores it automatically); without it the API answers `NO-SESSION`.

| Method | Path | Body → result |
|---|---|---|
| POST | `/api/session` | → `{session_id}` (one per browser) |
| GET | `/api/version` | site/server contract version |
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
| POST | `/api/dms` | `{user_id}` → open/reuse a DM → `{channel_id, recipient}` |
| GET | `/api/emojis` | bot emoji list |
| GET | `/api/guilds/{id}/emojis` | per-server custom emoji |
| GET | `/api/guilds/{id}/stickers` | per-server stickers |
| POST | `/api/resolve` | `{users[], channels[], roles[]}` → display names for unknown ids |
| GET | `/api/tenor/trending` | trending GIFs (needs `BOTCORD_TENOR_KEY`) |
| GET | `/api/tenor/search?q=&pos=` | Tenor GIF search, paged (needs `BOTCORD_TENOR_KEY`) |
| GET | `/api/unfurl?url=` | website preview `{url, site, title, description, image, icon}` |
| GET | `/api/channels/{id}/messages?limit&before&after` | messages, oldest first |
| GET | `/api/channels/{id}/messages/{mid}` | single message (authoritative reactions/components state) |
| POST | `/api/channels/{id}/messages` | `{content?, embed?, reply_to?, mention_author?, sticker_ids?}` (or multipart with `file`) |
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
`guild_create`, `guild_available`, `guild_delete`, `guild_emojis_update`,
`guild_stickers_update`, `member_add`, `member_remove`,
`presence_update`, `login_error`, `connected`, `disconnected`.
Browser → server: `{t:"ping"}` keep-alive (→ `{t:"pong"}`).

Errors are JSON `{error: "CODE"}` with codes like `EMPTY-TOKEN`,
`INVALID-TOKEN`, `NOT-LOGGED-IN`, `NO-SESSION`, `SESSION-LIMIT`,
`LOGIN-RATE-LIMITED`, `MISSING-PERMISSIONS`, `MISSING-ACCESS`,
`UNKNOWN-CHANNEL`, `PRIVILEGED-INTENTS-REQUIRED`, `LOGIN-TIMEOUT`,
`UNFURL-BLOCKED`, `FILE-TOO-LARGE`, `TENOR-NOT-CONFIGURED`.

## Files

* `run.bat` — Windows one-click installer + launcher (checks Python,
  installs requirements, starts the server, opens the browser).
* `server.py` — aiohttp + discord.py backend (REST, WebSocket, static).
* `requirements.txt` — `aiohttp`, `discord.py`.
* `web/index.html` — site shell (versioned `?v=` asset URLs — bump them
  whenever CSS/JS changes so browsers don't run stale code).
* `web/js/api.js` — REST + WebSocket client.
* `web/js/format.js` — message markdown/mention formatting.
* `web/js/embeds.js` — embed, attachment, link-preview and unfurl rendering.
* `web/js/app.js` — all UI logic (lists, messages, commands, settings).
* `web/js/vendor-converter.js` — emoji shortcut table (unchanged copy).
* `css/modern.css` — current theme/layout (loads last, wins overrides).
* `css/web.css` — web-only styles (status dot, modal, toast, panels).
* Legacy `css/`, `resources/`, `themes/` are served as-is, no duplication.
