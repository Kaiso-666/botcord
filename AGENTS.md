# AGENTS.md — Botcord working notes

Python (aiohttp + discord.py) backend + no-build browser frontend.
`server.py` owns the bot connection; `./web` is a static site it also serves.
No CI, no linter, no bundler, no modules — plain `<script>` globals in the
order listed in `web/index.html`.

## Verify (no single test runner configured — do all three)

```sh
python3 -m pytest tests/ -q        # needs pip install pytest; no network/Discord needed
python3 -m py_compile server.py
node --check web/js/app.js && node --check web/js/api.js && node --check web/js/embeds.js && node --check web/js/format.js
```

Frontend behavior can't run in a browser here — the established pattern is a
Node harness with a miniature DOM stub in `/tmp` (never in the repo) that
`eval()`s `format.js` + `embeds.js` + `app.js` and asserts against the real
functions. Red-green it against a stub gap before trusting a failure: most
"app bugs" found this way were mock infidelity (`classList`/`className`
sync, live `getElementById`, `CSS.escape`).

## Two version gates that strand users if mismatched

- `CLIENT_VERSION` (`web/js/app.js:12`) must equal `SERVER_VERSION`
  (`server.py`) or the splash errors. Bump together on contract changes only.
- `?v=N` asset pins in `web/index.html` are the cache-buster: bump on **any**
  CSS/JS change or browsers run stale code. Current: `?v=22`.

## Git traps (all verified — `git status` lies by omission here)

- `run.bat` matches `.gitignore`'s `*.bat`, so it is **ignored and untracked**.
  It is a real deliverable: stage with `git add -f run.bat`. Same for anything
  new under ignored patterns (`scripts/*`, `themes/*` except templates).
- `tests/` is new and untracked — remember to `git add` it.
- 5 `__pycache__/*.pyc` files are **tracked** and recompile on every run.
  Revert their churn before committing (`git checkout -- __pycache__/`).
- User's commit flow is the `gitter up` wrapper (commit + sync + push);
  run it when a task is done.

## Repo-specific gotchas

- Backend changes need `server.py` restarted; frontend changes need a
  hard refresh (Ctrl+Shift+R) on top of the `?v=` bump.
- `css/modern.css` loads last and wins. The base layout abuses
  `position: static !important`, so any absolutely-positioned addition needs
  `position: relative !important` on its own rule. Theme overrides must live
  at/after it and beat `!important` base rules (see the `.ping` role-tint
  pattern: inline `!important` from `format.js`).
- `web/js/app.js` (~5700 lines) calls later-declared `const`s (`ReplyCache`,
  `GuildEmojiCache`…) — fine at runtime (all calls happen post-eval), so
  don't "fix" the ordering.
- discord.py 2.x + aiohttp are the only runtime deps; code uses `X | None`
  syntax — Python 3.10+ (`run.bat` enforces this on Windows).
- Batch file rules for `run.bat`: CRLF endings (pinned via `.gitattributes`),
  and never read `%errorlevel%` inside a parenthesized block (parse-time
  expansion) — use the dynamic `if [not] errorlevel N` form.
- API is additive-only by policy: no `/api/v1`, no envelope redesigns.
  New error codes must still render sanely through the generic frontend
  toast path. New WS events must be safe for old clients to ignore.
