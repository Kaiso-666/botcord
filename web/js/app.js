'use strict';
/* Botcord web client — main application.
 * Talks to the Python backend (server.py) over REST + WebSocket.
 * Reuses the desktop client's DOM structure + CSS classes so the
 * Discord-like look is preserved.
 */

/* ============================== state ================================== */

// Must match SERVER_VERSION in server.py. Checked on startup so a stale
// server or cached site fails with a clear message instead of hanging.
const CLIENT_VERSION = 16;

const S = {
    me: null,
    owner: null,
    isTeam: false,
    team: [],
    guilds: [], // [{id,name,icon,acronym,member_count,...}]
    channels: {}, // gid -> [channel,...]
    roles: {}, // gid -> [role,...]
    members: {}, // gid -> [member,...]
    dms: [], // [{channel_id, recipient}]
    emojis: [],
    guildId: null, // selected guild id (null = home/DM view)
    channel: null, // {id, guild_id, name, isDM, recipient}
    channelDiv: null,
    generating: false,
    booting: false, // bootstrap in flight (prevents concurrent stuck loaders)
    typingTimers: {}, // channelId -> {userId: {name, timeout}}
    lastTypingSent: 0,
    splash: true,
    latencyMs: null,
    replyTo: null, // {id, channel_id, authorId, name, snippet} | null
    replyMention: true, // ping the quoted author on reply (Discord default)
};

// Reject a promise that never settles, so the splash screen always either
// completes or shows an error instead of hanging on "Loading servers".
function withTimeout(promise, ms, code) {
    let timer = null;
    const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej({ code: code || 'REQUEST-TIMEOUT' }), ms || 30000);
    });
    return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), timeout]);
}

const store = {
    get defaultToken() {
        return localStorage.getItem('botcord.defaultToken') || '';
    },
    set defaultToken(v) {
        if (v) localStorage.setItem('botcord.defaultToken', v);
        else localStorage.removeItem('botcord.defaultToken');
    },
    get ui() {
        try {
            return JSON.parse(localStorage.getItem('botcord.ui') || '{}');
        } catch (e) {
            return {};
        }
    },
    set ui(v) {
        localStorage.setItem('botcord.ui', JSON.stringify(v));
    },
};

function saveUI(patch) {
    store.ui = Object.assign({}, store.ui, patch);
}
function guildChannels() {
    return store.ui.channels || {};
}
function setGuildChannel(gid, cid) {
    const ui = store.ui;
    ui.channels = Object.assign({}, ui.channels, { [gid]: cid });
    store.ui = ui;
}

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.innerText = text;
    return e;
};
const DEFAULT_AVATAR = '/resources/images/default.png';

function toast(msg, ms) {
    const t = $('toast');
    t.innerText = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), ms || 4000);
}

function copyText(text, label) {    const done = () => toast((label || 'Copied') + ' to clipboard');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => toast('Copy failed'));
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            done();
        } catch (e) {
            toast('Copy failed');
        }
        document.body.removeChild(ta);
    }
}

/* Last-resort traps: if anything unexpected blows up while the splash
 * screen is showing, print it there instead of hanging silently. */
window.addEventListener('error', (e) => {
    try {
        if (typeof S !== 'undefined' && S.splash) {
            setLoadingPerc(
                -1,
                'Something broke while loading: ' +
                    (e.message || 'unknown error') +
                    ' — hard-refresh (Ctrl+Shift+R) and try again'
            );
        }
    } catch (err) {
        /* ignore */
    }
});
window.addEventListener('unhandledrejection', (e) => {
    try {
        const reason =
            (e.reason && (e.reason.code || e.reason.message)) || e.reason;
        if (typeof S !== 'undefined' && S.splash) {
            setLoadingPerc(
                -1,
                'Loading failed: ' + (reason || 'unknown error')
            );
            buildSplashToken(true);
        }
    } catch (err) {
        /* ignore */
    }
});

/* ============================ conn status =============================== */

function setConn(state, text) {
    const dot = $('connDot');
    dot.className = state === 'online' ? 'online' : state === 'connecting' ? 'connecting' : '';
    $('connText').innerText = text || state;
    $('latency').innerText = S.latencyMs != null ? `${S.latencyMs}ms` : '';
}

async function refreshLatency() {
    if (!S.me) return;
    try {
        const d = await Api.me();
        S.latencyMs = d.latency_ms;
        setConn('online', 'online');
    } catch (e) {
        /* ignore */
    }
}

/* ====================== splash / loading screen ========================= */

const LOADING_TEXT = {
    0: 'Fetching token',
    0.01: 'Please enter your token',
    0.05: 'Checking if the token is correct',
    0.1: 'Refreshing the servers',
    0.15: 'Logging into the bot',
    0.2: 'Getting the bot ready',
    0.4: 'Getting the owner of the bot',
    0.5: 'Loading data',
    0.6: 'Setting up direct messages',
    0.8: 'Loading servers',
    0.82: 'Loading channels',
    0.88: 'Loading members',
    0.92: 'Loading messages',
    1: 'All done!',
};

function setLoadingPerc(num, text) {
    if (num < 0) num = 0;
    $('loadingComplete').style.width = `${num * 100}%`;
    if (text) {
        $('percentageText').innerText = text;
    } else if (LOADING_TEXT[num] !== undefined) {
        $('percentageText').innerText = LOADING_TEXT[num];
    }
    if (num === 1) {
        console.log('Finished loading');
        hideSplashScreen();
    }
}

function hideSplashScreen() {
    if (!S.splash) return;
    S.splash = false;
    $('splashLoading').style.opacity = '0';
    setTimeout(() => ($('percentageText').style.opacity = '0'), 2000);
    setTimeout(() => ($('loadingBar').style.opacity = '0'), 2000);
    setTimeout(() => ($('splashScreen').style.opacity = '0'), 3000);
    setTimeout(() => {
        $('splashScreen').style.visibility = 'hidden';
        setTimeout(() => {
            $('percentageText').style.opacity = '1';
            $('loadingBar').style.opacity = '1';
            $('splashScreen').style.opacity = '1';
            setLoadingPerc(0);
        }, 1500);
    }, 3500);
}

function showSplash() {
    S.splash = true;
    $('splashScreen').style.visibility = 'visible';
}

function clearSelectMember() {
    $('selectMember').innerHTML = '';
}

function buildSplashToken(keepText) {
    clearSelectMember();
    if (!keepText) setLoadingPerc(0.01);
    const container = el('div', 'splashTokenContainer');
    $('selectMember').appendChild(container);

    const input = document.createElement('input');
    input.className = 'splashScreenToken tokenbox';
    input.type = 'password';
    input.placeholder = 'Input your token';
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doLogin(input.value, false);
    });
    container.appendChild(input);

    const oneTime = el('div', 'tokenAddButton');
    oneTime.appendChild(el('span', '', 'One time login'));
    oneTime.addEventListener('click', () => doLogin(input.value, false));
    container.appendChild(oneTime);

    const saveBtn = el('div', 'tokenAddButton');
    saveBtn.appendChild(el('span', '', 'Log in and save as default'));
    saveBtn.addEventListener('click', () => doLogin(input.value, true));
    container.appendChild(saveBtn);
}

// Data loaded OK for the login, but a guild/channel step failed (e.g. the
// bot can't read the first channel, or the network timed out). The token is
// fine, so offer a retry instead of asking for the token again — asking for
// the token again is what made failures look like "stuck on Loading servers".
function buildSplashRetry() {
    clearSelectMember();
    const container = el('div', 'splashTokenContainer');
    $('selectMember').appendChild(container);
    const retry = el('div', 'tokenAddButton');
    retry.appendChild(el('span', '', 'Try again'));
    retry.addEventListener('click', async () => {
        clearSelectMember();
        await bootstrap();
    });
    container.appendChild(retry);
    const change = el('div', 'tokenAddButton');
    change.appendChild(el('span', '', 'Use a different token'));
    change.addEventListener('click', () => buildSplashToken(true));
    container.appendChild(change);
}

function buildTeamCards(team, token, save) {
    clearSelectMember();
    setLoadingPerc(0.4, 'Select the bot owner (team app)');
    team.forEach((m) => {
        const container = el('div', 'teamMember');
        $('selectMember').appendChild(container);

        const userArea = el('div', 'userArea');
        container.appendChild(userArea);

        const img = el('img', 'teamMemberIcon');
        img.src = m.avatar || DEFAULT_AVATAR;
        userArea.appendChild(img);

        const tag = el('div', 'teamMemberTag');
        userArea.appendChild(tag);
        tag.appendChild(el('span', 'teamMemberName', m.username));
        tag.appendChild(el('span', 'teamMemberDisc', `#${m.discriminator}`));

        const once = el('div', 'teamMemberButton');
        once.appendChild(el('span', 'oneline', 'Sign in once'));
        once.addEventListener('click', async () => {
            await Api.teamSelect(m.id).catch(() => {});
            if (save) store.defaultToken = token;
            clearSelectMember();
            await bootstrap();
        });
        container.appendChild(once);

        const def = el('div', 'teamMemberButton');
        def.appendChild(el('span', '', 'Sign in and set as default'));
        def.addEventListener('click', async () => {
            await Api.teamSelect(m.id).catch(() => {});
            store.defaultToken = token;
            const ui = store.ui;
            ui.teamUser = m.id;
            store.ui = ui;
            clearSelectMember();
            await bootstrap();
        });
        container.appendChild(def);
    });
}

/* ============================== errors ================================== */

const animations = {
    flashRed: [
        { borderColor: '#313339' },
        { borderColor: '#A00' },
        { borderColor: '#F00' },
        { borderColor: '#A00' },
        { borderColor: '#313339' },
    ],
    flashTextRed: [{ color: '#B4B8BC' }, { color: '#F00' }, { color: '#B4B8BC' }],
};

function flashTokenBoxes() {
    Array.from(document.getElementsByClassName('tokenbox')).forEach((box) => {
        try {
            box.animate(animations.flashRed, 400);
        } catch (e) {
            /* ignore */
        }
        box.value = '';
    });
}

function errorHandler(err) {
    const raw = (err && (err.code || err.error)) || err;
    const code = String(raw && raw.code ? raw.code : raw);
    console.error('Error:', code, err);
    const tokenCodes = [
        'EMPTY-TOKEN',
        'TOKEN-SHORT',
        'TOKEN-LONG',
        'TOKEN-WHITESPACE',
        'INVALID-TOKEN-CHARACTERS',
        'INVALID-TOKEN-FORMAT',
        'INVALID-TOKEN',
        'TOKEN_INVALID',
        'NO-TOKEN',
        'SAME-TOKEN',
    ];
    if (tokenCodes.includes(code)) {
        const messages = {
            'EMPTY-TOKEN': 'The token provided is empty',
            'TOKEN-SHORT': 'The token is too short',
            'TOKEN-LONG': 'The token is too long',
            'TOKEN-WHITESPACE': 'There are spaces or newlines in the token',
            'INVALID-TOKEN-CHARACTERS': 'There are invalid characters in the token',
            'INVALID-TOKEN-FORMAT': 'The format of the token is invalid',
            'INVALID-TOKEN': 'The token provided is invalid',
            TOKEN_INVALID: 'The token provided is invalid',
            'NO-TOKEN': 'No tokens found in the cache',
            'SAME-TOKEN': 'The token is the same as the current one',
        };
        S.me = null;
        setLoadingPerc(-1, messages[code] || String(code));
        // Auto-login with a saved bad token shows no input otherwise —
        // make sure the user always has a way to try again.
        if (!$('selectMember') || !$('selectMember').children.length) {
            buildSplashToken(true);
        }
        flashTokenBoxes();
        return;
    }

    const FRIENDLY = {
        UNAUTHORIZED: 'Wrong server password — reload and try again',
        'PRIVILEGED-INTENTS-REQUIRED':
            'Enable Server Members + Message Content + Presence intents in the developer portal, then log in again',
        'LOGIN-TIMEOUT': 'Login timed out — check the server terminal and try again',
        'REQUEST-TIMEOUT': 'The server took too long to answer — try again in a moment',
        'HISTORY-TIMEOUT': 'Loading messages timed out — try another channel or try again',
        'CONNECTION-REFUSED': 'Could not reach the Python host. Is server.py running?',
        'SESSION-LIMIT': 'The server is full right now — try again in a few minutes',
        'LOGIN-RATE-LIMITED': 'Too many login attempts — wait a few minutes and try again',
        'MISSING-ACCESS': "The bot can't view that channel. Check its roles and permissions",
        'MISSING-PERMISSIONS': "The bot doesn't have permission to do that",
        'REACTION-FAILED': 'Could not add that reaction — check the emoji and try again',
        'BAD-EMOJI': 'Pick an emoji first',
        'FILE-TOO-LARGE': 'That file is over 25 MB — Discord will not take it',
        'BAD-UPLOAD': 'Could not read that file — try another one',
        'UNKNOWN-STICKER': 'Sticker not found',
        'TENOR-NOT-CONFIGURED': 'GIFs need a Tenor key — set BOTCORD_TENOR_KEY and restart the server',
        'TENOR-FAILED': 'GIF search failed — try again in a moment',
        'BAD-QUERY': 'Type something to search',
        'UNKNOWN-CHANNEL': 'That channel is no longer available — try another one',
        'UNKNOWN-GUILD': 'That server is no longer available — try another one',
        'MEMBER-FETCH-FAILED':
            'Could not load members — the bot may need the Server Members intent',
        'NOT-LOGGED-IN': 'Session expired — please log in again',
        'NO-SESSION': 'Session expired — please log in again',
        'CANNOT-DM': "Can't open a DM with them — DMs off or blocked",
        'UNKNOWN-USER': 'User not found',
        'BAD-USER': 'Pick a user first',
        SHARDING_REQUIRED: 'This bot needs sharding, which Botcord does not support',
        'EMPTY-NAME': 'Username is empty or contains invalid characters',
    };
    let msg = FRIENDLY[code];
    if (!msg) {
        if (code.startsWith('MISSING-PERMISSIONS')) msg = FRIENDLY['MISSING-PERMISSIONS'];
        else if (code.startsWith('REACTION-FAILED')) msg = FRIENDLY['REACTION-FAILED'];
        else if (code.startsWith('DISCORD-API-ERROR')) msg = 'Discord API error — try again in a moment';
        else if (code === 'Cannot send messages to this user')
            msg = "This user has DMs disabled or blocked the bot";
        else msg = `Error: ${code}`;
    }

    if (code === 'UNAUTHORIZED') {
        localStorage.removeItem('botcord.webPassword');
    }
    if (code === 'NO-SESSION' || code === 'NOT-LOGGED-IN') {
        // the server-side session is gone (restart/idle timeout): start over
        S.me = null;
        Api.clearSession();
        showSplash();
        setLoadingPerc(-1, msg);
        buildSplashToken(true);
        return;
    }
    if (S.splash) {
        // Logged in but a data step failed (channels/members/messages)?
        // The token is fine — don't ask for it again. Offer a retry so the
        // loader never looks "stuck on Loading servers" with no way forward.
        if (S.me) {
            setLoadingPerc(-1, msg);
            buildSplashRetry();
            return;
        }
        // Not logged in yet: stuck loader, ask for the token again.
        setLoadingPerc(-1, msg);
        buildSplashToken(true);
        flashTokenBoxes();
    } else if (code === 'MISSING-ACCESS' || code.startsWith('MISSING-PERMISSIONS')) {
        barry(msg);
    } else {
        toast(msg, 5000);
    }
}

// Barry — local-only bot responses (same as the desktop client)
function barry(text, del) {
    const list = $('message-list');
    const div = el('div', 'barryCommand');
    div.id = 'messageCont';
    div.style.backgroundColor = 'rgba(50,50,50,0.4)';
    list.appendChild(div);

    const img = el('img', 'messageImg barryImg');
    img.src = '/resources/images/Barry.png';
    div.appendChild(img);

    const inline = el('div', 'inlineMsgCont');
    div.appendChild(inline);

    const name = el('p', '', 'Barry');
    name.id = 'messageUsername';
    name.style.color = '#999999';
    inline.appendChild(name);

    const text2 = el('p', 'messageText');
    const lines = String(text).split('\n');
    text2.innerHTML = lines
        .map((l) => Fmt.parseMessage(l, null, { isDM: isDMSelected() }))
        .join('<br>');
    inline.appendChild(text2);

    list.scrollTop = list.scrollHeight;
    $('msgbox').value = '';
    if (del && del > 1) setTimeout(() => div.remove(), del);
}

/* ================================ login ================================= */

async function doLogin(token, save) {
    token = (token || '').trim();
    if (!token) {
        errorHandler({ code: 'EMPTY-TOKEN' });
        return;
    }
    setLoadingPerc(0.05);
    setConn('connecting', 'connecting');
    let res;
    try {
        res = await Api.login(token);
    } catch (e) {
        errorHandler(e);
        return;
    }
    if (res.same) {
        clearSelectMember();
        await bootstrap();
        return;
    }
    S.me = res.user;
    S.owner = res.owner;
    S.isTeam = !!res.is_team;
    S.team = res.team || [];
    setLoadingPerc(0.15);
    if (S.isTeam && S.team.length) {
        const savedTeamUser = store.ui.teamUser;
        const match = savedTeamUser && S.team.find((m) => m.id === savedTeamUser);
        if (match) {
            await Api.teamSelect(match.id).catch(() => {});
            S.owner = match;
            if (save) store.defaultToken = token;
            clearSelectMember();
            await bootstrap();
        } else {
            if (save) {
                // remember the token; owner choice is saved when picked
                S._pendingToken = token;
                S._pendingSave = true;
            }
            buildTeamCards(S.team, token, save);
        }
        return;
    }
    if (save) store.defaultToken = token;
    else if (S._pendingSave) store.defaultToken = S._pendingToken || token;
    S._pendingToken = null;
    S._pendingSave = false;
    clearSelectMember();
    await bootstrap();
}

/* ============================== bootstrap ================================ */

async function bootstrap() {
    // A second bootstrap (double-click, hello+status race) used to run
    // concurrently and trip the S.generating guard, leaving the loader at
    // 0.8 forever. Serialize instead: wait for the in-flight one, then run.
    if (S.booting) {
        const start = Date.now();
        while (S.booting && Date.now() - start < 60000) {
            await new Promise((r) => setTimeout(r, 200));
        }
        if (S.booting) S.booting = false; // stale lock, force on
    }
    S.booting = true;
    const seq = (S.bootSeq = (S.bootSeq || 0) + 1);
    const superseded = () => seq !== S.bootSeq;
    try {
        setLoadingPerc(0.5);
        const [meData, guildsData, dmsData, emojiData] = await withTimeout(
            Promise.all([
                Api.me(),
                Api.guilds(),
                Api.dms().catch(() => ({ dms: [] })),
                Api.emojis().catch(() => ({ emojis: [] })),
            ]),
            45000,
            'REQUEST-TIMEOUT'
        );
        if (superseded()) return;
        S.me = meData.user;
        S.owner = meData.owner || S.owner;
        S.latencyMs = meData.latency_ms;
        S.guilds = guildsData.guilds || [];
        S.dms = dmsData.dms || [];
        S.emojis = emojiData.emojis || [];
        Fmt.setLookup({
            members: {},
            roles: {},
            channels: {},
            emojis: Object.fromEntries(
                S.emojis.map((e) => [String(e.name).toLowerCase(), e])
            ),
        });

        setLoadingPerc(0.6);
        updateUserCard();
        setConn('online', 'online');

        setLoadingPerc(0.8);
        renderGuildList();

        // All servers' emojis + stickers in the background (media panel,
        // autocomplete and lookups); never blocks channel loading.
        try {
            ensureGuildMedia()
                .then(() => {
                    if ($('mediaPanel')) renderMediaPane();
                })
                .catch(() => {});
        } catch (e) {
            /* best-effort */
        }

        // restore last guild, else first guild, else DM home
        const lastGuild = store.ui.lastGuild;
        if (superseded()) return;
        if (lastGuild && S.guilds.find((g) => g.id === lastGuild)) {
            await selectGuild(lastGuild);
        } else if (S.guilds.length) {
            await selectGuild(S.guilds[0].id);
        } else {
            showDMHome();
            setLoadingPerc(1);
        }
    } catch (e) {
        console.error('bootstrap failed', e);
        errorHandler(e && (e.code || e.error) ? e : { code: 'CONNECTION-REFUSED' });
    } finally {
        S.booting = false;
    }
}

function updateUserCard() {
    const me = S.me;
    $('userCardName').innerText = me ? me.username : 'User';
    let discrim = me ? `#${me.discriminator}` : '#0000';
    if (me && (me.discriminator === '0' || me.discriminator === 0)) {
        discrim = me.global_name ? me.global_name : '';
    }
    $('userCardDiscrim').innerText = discrim;
    $('userCardIcon').src = (me && me.avatar) || DEFAULT_AVATAR;
}

/* ==================== settings + themes ================================
 * Cog button in the user footer opens a modern settings modal. The only
 * option for now is the theme: light / dark (current) / night (onyx).
 * The choice persists in localStorage (botcord.ui.theme) and applies via
 * `data-theme` on <html> (see the theme variants at the end of modern.css).
 */

const THEME_VALUES = ['light', 'dark', 'night'];

function currentTheme() {
    try {
        const t = store.ui && store.ui.theme;
        if (THEME_VALUES.includes(t)) return t;
    } catch (e) {
        /* ignore */
    }
    return 'dark';
}

function paintThemeChoices() {
    try {
        const cur = currentTheme();
        document.querySelectorAll('.themeChoice').forEach((b) => {
            b.classList.toggle('selected', b.dataset.themeValue === cur);
        });
    } catch (e) {
        /* ignore */
    }
}

function applyTheme(t) {
    if (!THEME_VALUES.includes(t)) t = 'dark';
    try {
        document.documentElement.dataset.theme = t;
    } catch (e) {
        /* ignore */
    }
    try {
        saveUI({ theme: t });
    } catch (e) {
        /* ignore */
    }
    paintThemeChoices();
}

function openSettings() {
    paintThemeChoices();
    paintSettingsAccount();
    paintStatusPills();
    const m = $('settingsModal');
    if (m) m.classList.remove('hidden');
}

function closeSettings() {
    const m = $('settingsModal');
    if (m) m.classList.add('hidden');
}

/* ==================== settings: account + status =======================
 * Token switching (log out / log in with another bot token) and bot
 * presence (status + activity), alongside the theme picker above.
 */

const PresenceSel = { status: 'online' };

function paintSettingsAccount() {
    try {
        const me = S.me;
        const av = $('settingsAccountAvatar');
        if (av) av.src = (me && me.avatar) || DEFAULT_AVATAR;
        const nm = $('settingsAccountName');
        if (nm) {
            nm.innerText = me
                ? `${me.global_name || me.username}${
                      me.discriminator && me.discriminator !== '0'
                          ? `#${me.discriminator}`
                          : ''
                  }`
                : 'Not logged in';
        }
    } catch (e) {
        /* ignore */
    }
}

function paintStatusPills() {
    try {
        document.querySelectorAll('.statusPill').forEach((b) => {
            b.classList.toggle('selected', b.dataset.status === PresenceSel.status);
        });
    } catch (e) {
        /* ignore */
    }
}

async function doLogout() {
    try {
        await Api.logout();
    } catch (e) {
        /* still leave: the session is unusable anyway */
    }
    try {
        store.defaultToken = '';
    } catch (e) {
        /* ignore */
    }
    location.reload();
}

async function doSwitchToken() {
    const box = $('tokenInput');
    const token = ((box && box.value) || '').trim();
    if (!token) {
        toast('Paste a bot token first');
        return;
    }
    const save = $('tokenSaveCheck') ? !!$('tokenSaveCheck').checked : false;
    try {
        await doLogin(token, save);
    } catch (e) {
        errorHandler(e);
        return;
    }
    if (box) box.value = '';
    paintSettingsAccount();
}

async function doSavePresence() {
    const typeSel = $('activityType');
    const nameBox = $('activityName');
    const urlBox = $('streamUrl');
    const activityType = typeSel ? typeSel.value : 'none';
    const activityName = ((nameBox && nameBox.value) || '').trim();
    const streamUrl = ((urlBox && urlBox.value) || '').trim();
    if (activityType !== 'none' && !activityName) {
        toast('Give the activity a name, or set it to No activity');
        return;
    }
    try {
        await Api.updatePresence({
            status: PresenceSel.status,
            activity_type: activityType,
            activity_name: activityName,
            stream_url: streamUrl,
        });
        toast('Status updated');
    } catch (e) {
        errorHandler(e);
    }
}

// The cog art lives in resources as settings.svg (preferred) or
// settings.png — probe in that order so a dropped-in file just works.
// Fixed-size box + object-fit in CSS keeps it from ever stretching;
// when neither file exists a gear glyph is used instead.
function loadSettingsIcon() {
    try {
        const img = $('settingsBtnIcon');
        const btn = $('settingsBtn');
        if (!img || !btn) return;
        const fallback = () => {
            try {
                if (!$('settingsBtnIcon')) return; // already replaced
                const s = document.createElement('span');
                s.className = 'settingsGearFallback';
                s.innerText = '⚙';
                img.replaceWith(s);
            } catch (e) {
                /* ignore */
            }
        };
        img.addEventListener('error', function h() {
            try {
                const cur = img.getAttribute('src') || '';
                if (cur.endsWith('settings.svg')) {
                    img.src = '/resources/icons/settings.png';
                } else {
                    img.removeEventListener('error', h);
                    fallback();
                }
            } catch (e) {
                fallback();
            }
        });
        // cached 404s may not refire `error`: probe explicitly
        try {
            const probe = new Image();
            probe.onerror = () => {
                // svg missing and the <img> already failed silently
                if (!img.isConnected || img.naturalWidth) return;
                img.src = '/resources/icons/settings.png';
            };
            probe.src = '/resources/icons/settings.svg';
        } catch (e) {
            /* the <img> onerror chain covers it */
        }
    } catch (e) {
        /* keep whatever the static HTML rendered */
    }
}

/* ============================== guild list =============================== */

function ensureGuildContainer() {
    if ($('guildContainer')) return;
    const indicator = el('div', '');
    indicator.id = 'guildIndicator';
    const container = el('div', '');
    container.id = 'guildContainer';
    container.appendChild(indicator);
    $('guild-list').appendChild(container);
}

function renderGuildList() {
    ensureGuildContainer();
    const container = $('guildContainer');
    container.querySelectorAll('.guildIconDiv').forEach((n) => n.remove());

    S.guilds.forEach((g) => {
        let img;
        if (!g.icon) {
            img = document.createElement('div');
            img.style.backgroundColor = '#2F3136';
            img.style.marginBottom = '4px';
            const abrev = el('p', '', g.acronym || '?');
            abrev.id = 'guildAbrev';
            img.appendChild(abrev);
        } else {
            img = document.createElement('img');
            img.src = g.icon;
            img.alt = g.name;
            img.height = 40;
            img.width = 40;
        }
        img.style.height = '40px';
        img.style.width = '40px';
        img.classList.add('guild-icon');
        img.id = `guild-${g.id}`;
        img.title = g.name;
        img.addEventListener('click', () => selectGuild(g.id));

        const box = el('div', 'guildIconDiv');
        const nameWrap = el('div', 'guildNameContainer');
        nameWrap.appendChild(el('p', 'guildName', g.name));
        box.appendChild(img);
        box.appendChild(nameWrap);
        container.appendChild(box);

        img.onmouseover = () => {
            const top = img.getBoundingClientRect().top;
            nameWrap.style.top = `${top + 3}px`;
        };
    });
}

function moveGuildIndicator(imgId) {
    const ind = $('guildIndicator');
    if (!ind) return;
    const img = typeof imgId === 'string' ? $(imgId) : imgId;
    ind.style.display = 'block';
    if (img) {
        const listRect = $('guild-list').getBoundingClientRect();
        const r = img.getBoundingClientRect();
        ind.style.top = `${r.top - listRect.top + 4}px`;
    }
}

async function selectGuild(gid) {
    try {
        const g = S.guilds.find((x) => x.id === gid);
        if (!g) return;
        S.guildId = gid;
        saveUI({ lastGuild: gid });
        moveGuildIndicator(`guild-${gid}`);
        // on mobile, picking a server should reveal the channel drawer
        if (window.innerWidth <= 860) {
            document.body.classList.add('show-channels');
            document.body.classList.remove('show-members');
        }

        $('guildName').innerText = g.name;
        $('guildName').classList.remove('directMsg');
        $('guildImg').src = g.icon || DEFAULT_AVATAR;
        $('members-text').style.display = '';
        $('members-count').innerText = g.member_count || '…';

        clearMessages();
        S.channel = null;

    // Stage 1: channels are critical — without them there is nothing to show.
    // Load them first and render immediately so a slow members/messages call
    // can't leave the UI parked on "Loading servers" with no feedback.
    setLoadingPerc(0.82);
    let chData;
    try {
        chData = await withTimeout(Api.guildChannels(gid), 30000, 'REQUEST-TIMEOUT');
    } catch (e) {
        console.error('guild channels failed', e);
        errorHandler(e && (e.code || e.error) ? e : { code: 'CONNECTION-REFUSED' });
        return;
    }
    let all = [];
    try {
        all = (chData.channels || []).concat(chData.threads || []);
        S.channels[gid] = all;
        refreshLookup();
        renderChannelList(g);
    } catch (e) {
        console.error('render channel list failed', e);
        errorHandler({ code: 'CONNECTION-REFUSED' });
        return;
    }

    const textChannels = all.filter((c) => isTextType(c.type));
    if (!textChannels.length) {
        // channels loaded but none readable: don't leave the loader up
        setLoadingPerc(1);
        toast('No readable text channel in this server');
        return;
    }

    // Stage 2: members/roles are best-effort — never let them block messages.
    // A slow member chunk used to stall the whole loader at 0.8.
    setLoadingPerc(0.88);
    const metaPromise = (async () => {
        try {
            const [rolesData, membersData] = await withTimeout(
                Promise.all([
                    Api.guildRoles(gid).catch(() => ({ roles: [] })),
                    Api.guildMembers(gid, 500).catch(() => ({ members: [] })),
                ]),
                35000,
                'REQUEST-TIMEOUT'
            );
            S.roles[gid] = rolesData.roles || [];
            S.members[gid] = membersData.members || [];
            if (membersData.total) {
                $('members-count').innerText = membersData.total;
                g.member_count = membersData.total;
            }
            refreshLookup();
            renderMemberList(g);
        } catch (e) {
            console.warn('guild members/roles slow, continuing with cache', e);
            try {
                refreshLookup();
                renderMemberList(g);
            } catch (err) {
                /* non-fatal */
            }
        }
    })();

    // Stage 3: open the last channel, else the first text channel. If the bot
    // can't read it (common when invites lack permissions), try the next few
    // text channels instead of parking on "Loading servers" forever.
    setLoadingPerc(0.92);
    const last = guildChannels()[gid];
    const preferred =
        textChannels.find((c) => c.id === last) || textChannels[0];
    const ordered = [
        preferred,
        ...textChannels.filter((c) => c.id !== preferred.id),
    ].slice(0, 5);
    // mark the preferred one selected; the loop corrects it if we fall through
    const markSelected = (id) => {
        document.querySelectorAll('#channel-elements .selectedChan').forEach((n) => n.classList.remove('selectedChan'));
        const div = id && $(id);
        if (div) div.classList.add('selectedChan');
    };
    markSelected(preferred.id);
    let loaded = false;
    let lastErr = null;
    for (const target of ordered) {
        markSelected(target.id);
        const ok = await selectChannel(target, $(target.id), { silent: true });
        if (ok) {
            loaded = true;
            setGuildChannel(gid, target.id);
            break;
        } else {
            lastErr = S._lastChannelError || { code: 'MISSING-ACCESS' };
            const raw = lastErr && (lastErr.code || lastErr.error);
            const c = String(raw && raw.code ? raw.code : raw);
            // Network/server trouble will fail for every channel — don't make
            // the user wait through 5 x 30s timeouts. Permission errors are
            // channel-specific, so those are worth trying the next channel.
            if (['REQUEST-TIMEOUT', 'CONNECTION-REFUSED', 'HISTORY-TIMEOUT'].includes(c)) break;
            if (String(c).startsWith('DISCORD-API-ERROR') || String(c).startsWith('HTTP-')) break;
        }
    }
    try {
        await metaPromise;
    } catch (e) {
        /* already logged */
    }
    if (!loaded) {
        console.error('no readable channel in guild', gid, lastErr);
        errorHandler(lastErr && (lastErr.code || lastErr.error) ? lastErr : { code: 'MISSING-ACCESS' });
    }
    } catch (e) {
        console.error('selectGuild failed', e);
        errorHandler(e && (e.code || e.error) ? e : { code: 'CONNECTION-REFUSED' });
    }
}

function isTextType(t) {
    return ['text', 'news', 'forum', 'public_thread', 'private_thread', 'news_thread'].includes(t);
}

/* ============================= channel list ============================== */

const CHANNEL_ICONS = {
    text: 'GuildTextChannel',
    news: 'GuildNewsChannel',
    forum: 'GuildTextChannel',
    voice: 'GuildVoiceChannel',
    stage_voice: 'GuildVoiceChannel',
    public_thread: 'GuildTextChannel',
    private_thread: 'GuildTextChannel',
    news_thread: 'GuildNewsChannel',
};

function renderChannelList(g) {
    const list = $('channel-elements');
    list.innerHTML = '';
    const all = S.channels[g.id] || [];

    // categories first
    all
        .filter((c) => c.type === 'category')
        .sort((a, b) => a.position - b.position)
        .forEach((c) => {
            const category = el('div', 'category open');
            category.id = c.id;
            list.appendChild(category);

            const nameCat = el('div', 'categoryNameContainer');
            category.appendChild(nameCat);
            const svg = el('img', 'categorySVG');
            svg.src = '/resources/icons/categoryArrow.svg';
            nameCat.appendChild(svg);
            nameCat.appendChild(el('h5', 'categoryText', c.name));

            const div = el('div', 'channelContainer');
            category.appendChild(div);
            nameCat.addEventListener('click', () => category.classList.toggle('open'));
        });

    all
        .filter((c) => c.type !== 'category')
        .sort((a, b) => (a.type === 'voice') - (b.type === 'voice') || a.position - b.position)
        .forEach((c) => {
            const div = el('div', 'channel');
            div.id = c.id;

            const svg = el('img', 'channelSVG');
            svg.src = `/resources/icons/${CHANNEL_ICONS[c.type] || 'GuildTextChannel'}.svg`;
            div.appendChild(svg);
            div.appendChild(el('h5', 'viewableText', c.name));

            if (c.parent_id && $(c.parent_id)) {
                $(c.parent_id).getElementsByTagName('div')[1].appendChild(div);
            } else {
                const firstCat = list.querySelector('.category');
                if (firstCat) list.insertBefore(div, firstCat);
                else list.appendChild(div);
            }

            if (!isTextType(c.type)) return; // voice: no chat view
            div.addEventListener('click', () => {
                const prev = list.querySelector('.selectedChan');
                if (prev && prev.id !== c.id) prev.classList.remove('selectedChan');
                if (prev && prev.id === c.id) return;
                div.classList.add('selectedChan');
                setGuildChannel(g.id, c.id);
                selectChannel(c, div);
            });
            div.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                channelContextMenu(e, c);
            });
        });
}

function channelContextMenu(e, c) {
    openRcMenu(e.clientX, e.clientY, [
        { label: 'Copy channel ID', fn: () => copyText(c.id, 'Channel ID') },
        {
            label: 'Create invite',
            fn: async () => {
                try {
                    const inv = await Api.createInvite(c.id);
                    copyText(inv.url, 'Invite');
                } catch (err) {
                    errorHandler(err);
                }
            },
        },
    ]);
}

/* ============================ message rendering ========================== */

function clearMessages() {
    $('message-list').innerHTML = '';
}

function isDMSelected() {
    return !!(S.channel && S.channel.isDM);
}

function refreshLookup() {
    const members = {};
    const roles = {};
    const channels = {};
    Object.values(S.members).forEach((arr) =>
        (arr || []).forEach((m) => {
            members[m.id] = m;
        })
    );
    Object.values(S.roles).forEach((arr) =>
        (arr || []).forEach((r) => {
            roles[r.id] = r;
        })
    );
    Object.values(S.channels).forEach((arr) =>
        (arr || []).forEach((c) => {
            channels[c.id] = c;
        })
    );
    const emojis = {};
    S.emojis.forEach((e) => {
        emojis[String(e.name).toLowerCase()] = e;
    });
    Fmt.setLookup({ members, roles, channels, emojis });
    // guild data often arrives AFTER messages render: re-run the mention
    // pass so @12345… pills pick up freshly cached names
    try {
        const list = document.getElementById('message-list');
        if (list) scheduleResolve(list);
    } catch (e) {
        /* never break rendering */
    }
}

function authorOf(m) {
    const mem = m.member;
    const name = (mem && (mem.display_name || mem.nick)) || m.author.global_name || m.author.username;
    const color = (mem && mem.color) || '#fff';
    const avatar = m.author.avatar || (mem && mem.avatar) || DEFAULT_AVATAR;
    return { name, color, avatar };
}

function sameDay(a, b) {
    const da = new Date(a);
    const db = new Date(b);
    return (
        da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate()
    );
}

function shouldGroup(m, prev) {
    if (!prev || prev.author.id !== m.author.id) return false;
    if (!sameDay(prev.timestamp, m.timestamp)) return false;
    const diff = new Date(m.timestamp) - new Date(prev.timestamp);
    return diff < 7 * 60 * 1000; // 7 minutes, like Discord
}

/* Discord-style timestamps: time only for today ("4:20 PM"), "Yesterday
 * at …" for yesterday, full date + time when older. Day dividers label the
 * same way ("Today" / "Yesterday" / "September 7, 2026"). */

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function dayDiffDays(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
}

function msgTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    try {
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
        return '';
    }
}

function formatMsgTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diff = dayDiffDays(iso);
    const time = msgTime(iso);
    if (diff === 0) return time; // today: time only, like Discord
    if (diff === 1) return `Yesterday at ${time}`;
    try {
        return d.toLocaleString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch (e) {
        return time;
    }
}

function fullMsgTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    try {
        return d.toLocaleString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        });
    } catch (e) {
        return String(iso);
    }
}

function dayLabel(iso) {
    const diff = dayDiffDays(iso);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff === -1) return 'Tomorrow';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    try {
        return d.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
    } catch (e) {
        return '';
    }
}

function daySeparator(iso) {
    const sep = el('div', 'daySeparator');
    sep.appendChild(el('span', 'dayLabel', dayLabel(iso) || ''));
    return sep;
}

/* Discord-style reply/mention highlight: a message that pings you (@you,
 * @everyone/@here, a role you have, or a reply to one of your messages)
 * gets a yellow wash + a thin bar on the left edge of the message block.
 * Own messages never highlight. */

function myRoleIds() {
    const out = new Set();
    try {
        if (!S.me) return out;
        const me = String(S.me.id);
        const pools = [];
        if (S.channel && S.channel.guild_id && S.members[S.channel.guild_id]) {
            pools.push(S.members[S.channel.guild_id]);
        } else {
            Object.values(S.members || {}).forEach((arr) => pools.push(arr));
        }
        pools.forEach((arr) => {
            (arr || []).forEach((m) => {
                if (String(m.id) === me) {
                    (m.roles || []).forEach((r) => out.add(String(r)));
                }
            });
        });
    } catch (e) {
        /* ignore */
    }
    return out;
}

function isEveryoneMention(m) {
    try {
        if (m && typeof m.mention_everyone === 'boolean') return m.mention_everyone;
    } catch (e) {
        /* fall through to text check */
    }
    try {
        const text = m.clean_content || m.content || '';
        return /(^|\s)@(everyone|here)(?=[\s<.,!?;:]|$)/m.test(text);
    } catch (e) {
        return false;
    }
}

function messageMentionsMe(m) {
    try {
        if (!m || !S.me) return false;
        const me = String(S.me.id);
        if (m.author && String(m.author.id) === me) return false; // own messages never highlight
        const users = (m.mentions && m.mentions.users) || [];
        for (const u of users) {
            if (String((u && u.id) || '') === me) return true;
        }
        // mentions list can lag behind the raw text (history edge cases)
        try {
            const raw = m.content || '';
            if (raw.includes(`<@${me}>`) || raw.includes(`<@!${me}>`)) return true;
        } catch (e) {
            /* ignore */
        }
        if (isEveryoneMention(m)) return true;
        const roles = (m.mentions && m.mentions.roles) || [];
        if (roles.length) {
            const mine = myRoleIds();
            const gid = (S.channel && S.channel.guild_id) || m.guild_id || S.guildId;
            for (const r of roles) {
                const rid = String(r);
                if (mine.has(rid)) return true;
                // @everyone's role id equals the guild id: pings the whole server
                if (gid && rid === String(gid)) return true;
            }
        }
    } catch (e) {
        /* never break rendering */
    }
    return false;
}

function isReplyToMeSync(m) {
    try {
        if (!m || !m.reference || !m.reference.message_id || !S.me) return false;
        const me = String(S.me.id);
        const refId = String(m.reference.message_id);
        const target = document.getElementById(refId);
        if (target && target.dataset && target.dataset.authorId) {
            return String(target.dataset.authorId) === me;
        }
        const cached = ReplyCache.get(refId);
        if (cached && cached.authorId) {
            return String(cached.authorId) === me;
        }
    } catch (e) {
        /* ignore */
    }
    return false;
}

function applyMentionHighlight(m, node) {
    try {
        if (!m || !node) return;
        if (messageMentionsMe(m) || isReplyToMeSync(m)) {
            node.classList.add('mention-highlight');
            return;
        }
        // The original isn't loaded yet: fetch it once and highlight late
        // when it turns out to be a reply to one of my messages.
        const ref = m.reference;
        if (!ref || !ref.message_id || !S.me) return;
        if (m.author && S.me && String(m.author.id) === String(S.me.id)) return;
        const refId = String(ref.message_id);
        if (ReplyCache.get(refId)) return; // sync check already failed
        Api.message(ref.channel_id || m.channel_id, ref.message_id)
            .then((res) => {
                try {
                    const om = res && res.message;
                    if (!om) return;
                    const entry = quotePreviewFor(om);
                    if (ReplyCache.size > 200) ReplyCache.clear();
                    ReplyCache.set(refId, entry);
                    if (entry.authorId && S.me && String(entry.authorId) === String(S.me.id)) {
                        if (node.isConnected) node.classList.add('mention-highlight');
                    }
                } catch (e) {
                    /* ignore */
                }
            })
            .catch(() => {});
    } catch (e) {
        /* never break rendering */
    }
}

function messageBlock(m) {
    const darkBG = el('div', 'messageBlock');
    darkBG.id = m.id;
    darkBG.dataset.content = m.content || '';
    darkBG.dataset.authorId = m.author.id;
    darkBG.dataset.timestamp = m.timestamp || '';
    applyMentionHighlight(m, darkBG);

    const isDM = !m.guild_id;
    renderReplyBar(m, darkBG);
    if (m.content && m.content.length) {
        const text = el('p', 'messageText');
        text.innerHTML = Fmt.parseMessage(m.clean_content || m.content, m, { isDM });
        if (m.edited_timestamp) text.innerHTML += ' <time class="edited">(edited)</time>';
        darkBG.appendChild(text);
    }
    (m.attachments || []).forEach((a) => showAttachment(a, darkBG));
    (m.embeds || []).forEach((e) => {
        try {
            showEmbed(e, darkBG, m, isDM);
        } catch (err) {
            console.error('embed render failed', err);
        }
    });
    try {
        showLinkPreviews(m, darkBG);
    } catch (err) {
        console.error('link preview failed', err);
    }
    try {
        showLinkEmbeds(m, darkBG);
    } catch (err) {
        console.error('link unfurl failed', err);
    }
    if (m.uploading) {
        const up = el('div', 'uploading');
        up.appendChild(el('span', 'uploadName', `📎 ${m.uploading.name || 'file'}`));
        const track = el('div', 'uploadTrack');
        track.appendChild(el('div', 'uploadFill'));
        up.appendChild(track);
        darkBG.appendChild(up);
    }
    try {
        renderComponentsV2(m, darkBG, isDM);
    } catch (err) {
        console.error('components render failed', err);
    }
    try {
        renderPoll(m, darkBG, isDM);
    } catch (err) {
        console.error('poll render failed', err);
    }
    try {
        renderReactions(m, darkBG);
    } catch (err) {
        console.error('reactions render failed', err);
    }
    try {
        renderStickers(m, darkBG);
    } catch (err) {
        console.error('stickers render failed', err);
    }
    // async mention pass: fills @12345… / #deleted-channel pills whose data
    // arrived after (or before) this message rendered
    try {
        scheduleResolve(darkBG);
    } catch (err) {
        /* never break rendering */
    }
    if (!darkBG.children.length) {
        const text = el('p', 'messageText', '(empty message)');
        darkBG.appendChild(text);
    }
    darkBG.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        messageContextMenu(e, m);
    });
    return darkBG;
}

// Text of a rendered node (innerText when laid out, else textContent).
function nodeText(n) {
    if (!n) return '';
    try {
        return n.innerText || n.textContent || '';
    } catch (e) {
        return '';
    }
}

// Discord-style quoted reply: curved thread spine from the avatar side,
// the original author's tiny avatar + colored name + grey snippet on one
// line. Jumps to the original when loaded, else a fetched preview (cached).
function quotePreviewFor(om) {
    let text = '';
    try {
        text = ((om.content || '').trim()).slice(0, 80);
    } catch (e) {
        text = '';
    }
    let hasMedia = false;
    try {
        hasMedia = ((om.attachments || []).length > 0);
        if (!hasMedia) {
            hasMedia = (om.embeds || []).some(
                (e) =>
                    e &&
                    (e.image ||
                        e.thumbnail ||
                        e.video ||
                        ['image', 'gifv', 'video'].includes(e.type))
            );
        }
    } catch (e) {
        hasMedia = false;
    }
    let color = null;
    try {
        color = (om.member && om.member.color) || null;
    } catch (e) {
        color = null;
    }
    let avatar = null;
    try {
        avatar = (om.author && om.author.avatar) || null;
    } catch (e) {
        avatar = null;
    }
    let authorId = null;
    try {
        authorId = (om.author && om.author.id != null && String(om.author.id)) || null;
    } catch (e) {
        authorId = null;
    }
    return {
        name: replyNameFor(om),
        snippet: text,
        avatar,
        color,
        authorId,
        hasMedia,
        mediaOnly: !text && hasMedia,
    };
}

function renderReplyBar(m, parent) {
    const ref = m.reference;
    if (!ref || !ref.message_id) return;
    const bar = el('div', 'replyBar replyQuote');
    bar.title = 'Jump to replied message';
    bar.appendChild(el('span', 'replySpine'));
    const av = el('img', 'replyAvatar');
    av.src = DEFAULT_AVATAR;
    av.alt = '';
    av.draggable = false;
    const authorEl = el('span', 'replyAuthor', '…');
    const snippetEl = el('span', 'replySnippet', '');
    bar.appendChild(av);
    bar.appendChild(authorEl);
    bar.appendChild(snippetEl);
    parent.appendChild(bar);

    const paint = (entry) => {
        entry = entry || {};
        authorEl.innerText = entry.name || 'unknown';
        if (entry.color) {
            try {
                authorEl.style.color = entry.color;
            } catch (e) {
                /* ignore */
            }
        }
        if (entry.avatar) {
            try {
                av.src = entry.avatar;
            } catch (e) {
                /* ignore */
            }
        }
        snippetEl.classList.toggle('replyMediaOnly', !!entry.mediaOnly);
        if (entry.mediaOnly) {
            snippetEl.innerText = '🖼 Tap to view attachment';
        } else {
            snippetEl.innerText =
                (entry.hasMedia ? '🖼 ' : '') +
                (entry.snippet ? String(entry.snippet).slice(0, 80) : '');
        }
    };
    // construction-time: the bar isn't in the document yet, so sync fills
    // apply unconditionally — they render with the node on append.
    const fillSync = (entry) => paint(entry);
    const fillAsync = (entry) => {
        // fetch-time: only touch the bar if it actually made it into the
        // DOM and is still there (message may have been deleted already).
        if (!bar.isConnected) return;
        paint(entry);
    };
    const jump = () => {
        const target = document.getElementById(ref.message_id);
        if (!target) {
            toast('Original message is not loaded');
            return;
        }
        try {
            target.scrollIntoView({ block: 'center' });
            target.classList.add('replyFlash');
            setTimeout(() => target.classList.remove('replyFlash'), 1200);
        } catch (err) {
            /* ignore */
        }
    };
    bar.addEventListener('click', (e) => {
        e.stopPropagation();
        jump();
    });

    // 1. already in the DOM? read it directly.
    try {
        const target = document.getElementById(ref.message_id);
        if (target) {
            const nameNode = target.querySelector('.messageUsername');
            const textNode = target.querySelector('.messageText');
            const imgNode = target.querySelector('.messageImg');
            // the timestamp nests inside .messageUsername: strip it so the
            // quote shows just the name, like Discord
            let author = 'a message';
            try {
                const clone = nameNode.cloneNode(true);
                const tsKid = clone.querySelector('.messageTimestamp');
                if (tsKid) tsKid.remove();
                if (nodeText(clone).trim()) author = nodeText(clone).trim();
            } catch (e) {
                if (nodeText(nameNode)) author = nodeText(nameNode);
            }
            const entry = {
                name: author,
                snippet: nodeText(textNode).slice(0, 80),
                avatar: (imgNode && imgNode.src) || null,
                color:
                    (nameNode && nameNode.style && nameNode.style.color) || null,
                authorId:
                    (target.dataset && target.dataset.authorId) || null,
                hasMedia: !!target.querySelector(
                    'img.linkPreview-img, img.embedImage, img.previewImage, video, audio'
                ),
                mediaOnly: false,
            };
            entry.mediaOnly = !entry.snippet && entry.hasMedia;
            fillSync(entry);
            ReplyCache.set(String(ref.message_id), entry);
            return;
        }
    } catch (e) {
        /* fall through to fetch */
    }
    // 2. cached preview?
    const cached = ReplyCache.get(String(ref.message_id));
    if (cached) {
        fillSync(cached);
        return;
    }
    // 3. fetch the original for a preview (other channels included).
    fillSync({ name: '…', snippet: '', avatar: null, color: null });
    Api.message(ref.channel_id || m.channel_id, ref.message_id)
        .then((res) => {
            if (!res || !res.message) throw new Error('no message');
            const entry = quotePreviewFor(res.message);
            if (ReplyCache.size > 200) ReplyCache.clear();
            ReplyCache.set(String(ref.message_id), entry);
            fillAsync(entry);
        })
        .catch(() => fillAsync({ name: 'deleted message' }));
}

function addHeader(darkBG, m) {
    const { name, color, avatar } = authorOf(m);
    const img = el('img', 'messageImg');
    img.src = avatar;
    img.height = 40;
    img.width = 40;
    img.title = `${name} — Shift+Click to mention`;
    img.addEventListener('click', (e) => {
        if (e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            insertMention(m.author.id);
        }
    });
    darkBG.insertBefore(img, darkBG.firstChild);

    const uname = el('p', 'messageUsername', name);
    uname.style.color = color;
    uname.title = `${name} — Shift+Click to mention`;
    uname.addEventListener('click', (e) => {
        // Discord-style: Shift+LeftClick drops a mention pill into the box.
        if (e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            insertMention(m.author.id);
        }
    });
    uname.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        userContextMenu(e, m.author);
    });
    darkBG.insertBefore(uname, img.nextSibling);

    // Timestamp lives INSIDE the username element so name + time always
    // flow inline together (separate grid cells would stack or overlap).
    const ts = el('span', 'messageTimestamp');
    ts.innerText = ' ' + formatMsgTime(m.timestamp);
    ts.title = fullMsgTime(m.timestamp);
    uname.appendChild(ts);
}

function appendMessage(m, prev) {
    const list = $('message-list');
    if ($(m.id)) {
        updateMessageDom(m);
        return;
    }
    if (prev && shouldGroup(m, prev)) {
        const conts = list.getElementsByClassName(prev.author.id);
        const cont = conts[conts.length - 1];
        if (cont) {
            cont.appendChild(messageBlock(m));
            return;
        }
    }
    // new author group
    const div = el('div', `messageCont ${m.author.id}`);
    if (!m.guild_id) div.classList.add('dms');
    const darkBG = messageBlock(m);
    darkBG.classList.add('firstmsg');

    addHeader(darkBG, m);

    div.appendChild(darkBG);
    list.appendChild(div);
}

/* Discord-style loading skeletons: grey avatar + text bars with a shimmer
 * sweep, shown while a channel's history loads. */
function buildMessageSkeletons(n) {
    const wrap = el('div', 'msgSkeletons');
    const widths = [92, 64, 78, 45, 85, 58, 72, 50];
    const total = Math.max(1, Math.min(n || 8, 12));
    for (let i = 0; i < total; i++) {
        const row = el('div', 'msgSkeleton');
        row.appendChild(el('div', 'skAvatar'));
        const body = el('div', 'skBody');
        body.appendChild(el('div', 'skLine skName'));
        const l1 = el('div', 'skLine');
        l1.style.width = widths[i % widths.length] + '%';
        const l2 = el('div', 'skLine');
        l2.style.width = Math.max(18, widths[(i + 3) % widths.length] - 30) + '%';
        body.appendChild(l1);
        body.appendChild(l2);
        row.appendChild(body);
        wrap.appendChild(row);
    }
    return wrap;
}
function renderMessages(messages) {
    clearMessages();
    const list = $('message-list');
    let prev = null;
    messages.forEach((m, i) => {
        // day divider with a label, Discord-style ("Today" / "Yesterday" / date)
        if (!prev || !sameDay(prev.timestamp, m.timestamp)) {
            list.appendChild(daySeparator(m.timestamp));
        }
        appendMessage(m, prev);
        prev = m;
    });
    const shell = el('div', 'sorryNoLoad');
    shell.appendChild(el('p', '', 'Sorry! No messages beyond this point can be displayed.'));
    $('message-list').prepend(shell);
    $('message-list').scrollTop = $('message-list').scrollHeight;
}

function updateMessageDom(m) {
    const node = $(m.id);
    if (!node) return;
    const wasFirst = node.classList.contains('firstmsg');
    const fresh = messageBlock(m);
    if (wasFirst) {
        fresh.classList.add('firstmsg');
        addHeader(fresh, m);
    }
    node.replaceWith(fresh);
}

function removeMessageDom(id) {
    const node = $(id);
    if (!node) return;
    const first = node.classList.contains('firstmsg');
    const parent = node.parentNode; // .messageBlock's parent: .messageCont or firstmsg wrapper
    if (!first) {
        node.remove();
        return;
    }
    // firstmsg: node contains avatar+name of the group; promote next sibling if any
    const cont = node.closest('.messageCont');
    const next = node.nextElementSibling;
    if (cont && next && next.classList.contains('messageBlock')) {
        // move avatar/name/timestamp from removed node to next block
        ['messageImg', 'messageUsername', 'messageTimestamp'].forEach((cls) => {
            const n = node.querySelector('.' + cls);
            if (n && !next.querySelector('.' + cls)) next.insertBefore(n, next.firstChild);
        });
        next.classList.add('firstmsg');
        node.remove();
    } else if (cont && cont.children.length <= 1) {
        cont.remove();
    } else {
        node.remove();
    }
    void parent;
}

/* ============================ channel select ============================= */

async function selectChannel(c, div, opts) {
    const silent = !!(opts && opts.silent);
    if (S.generating) {
        if (!silent) toast('Still loading — try again in a moment');
        return false;
    }
    S.generating = true;
    try {
        S._lastChannelError = null;
        document.body.classList.remove('show-channels', 'show-members');
        S.channel = {
            id: c.id || c.channel_id,
            guild_id: c.guild_id || S.guildId,
            name: c.name || (c.recipient && c.recipient.username) || 'DM',
            isDM: !!c.isDM || !c.guild_id,
            recipient: c.recipient || null,
        };
        S.channelDiv = div || null;
        if (div) div.classList.remove('newMsg');

        // drop optimistic sends from other channels (their history refresh
        // or gateway echo covers them when you return)
        try {
            for (const [k, p] of PendingSends) {
                if (String(p.channelId) !== String(S.channel.id)) PendingSends.delete(k);
            }
        } catch (e) {
            /* ignore */
        }

        $('msgbox').placeholder = S.channel.isDM
            ? `Message @${S.channel.name}`
            : `Message #${S.channel.name}`;
        hideMentionSuggest();
        cancelReply();
        syncMentionBackdrop();

        renderTyping();
        clearMessages();

        const skel = buildMessageSkeletons(8);
        skel.id = 'loading-container';
        $('message-list').appendChild(skel);

        try {
            // make sure lookups know this DM user
            if (S.channel.isDM && S.channel.recipient) {
                refreshLookup();
            }
            const myId = S.channel.id;
            const data = await withTimeout(
                Api.messages(S.channel.id, { limit: 100 }),
                30000,
                'REQUEST-TIMEOUT'
            );
            // superseded by logout / token switch / another channel: don't paint
            // into the cleared UI or hide the splash screen by mistake
            if (!S.me || !S.channel || S.channel.id !== myId) return false;
            renderMessages(data.messages || []);
            // first successful channel view dismisses the splash screen
            setLoadingPerc(1);
        if (S.channel.guild_id) {
            const g = S.guilds.find((x) => x.id === S.channel.guild_id);
            if (g) {
                try {
                    renderMemberList(g);
                } catch (e) {
                    /* non-fatal */
                }
            }
        }
        return true;
        } catch (e) {
            S._lastChannelError = e;
            console.error('channel messages failed', e);
            const d = $('loading-container');
            if (d) d.remove();
            // Silent mode is used by selectGuild's fallback loop: don't surface
            // each failed channel, let the caller try the next one.
            if (!silent) errorHandler(e);
            return false;
        } finally {
            const d = $('loading-container');
            if (d) d.remove();
            S.generating = false;
        }
    } catch (e) {
        // setup itself failed (shouldn't happen): never leave generating stuck
        console.error('selectChannel setup failed', e);
        S.generating = false;
        if (!silent) errorHandler(e && (e.code || e.error) ? e : { code: 'CONNECTION-REFUSED' });
        else S._lastChannelError = e;
        return false;
    }
}

/* ================================ DM home ================================ */

function showDMHome() {
    S.guildId = null;
    S.channel = null;
    if ($('guildIndicator')) $('guildIndicator').style.display = 'none';
    $('guildName').innerText = 'Direct Messages';
    $('guildName').classList.add('directMsg');
    $('guildImg').src = '/resources/icons/logo.svg';
    $('members-text').style.display = 'none';
    $('members-count').innerText = '';
    $('memberBar').innerHTML = '';
    clearMessages();
    renderDMList();
}

function renderDMList() {
    const list = $('channel-elements');
    list.innerHTML = '';

    const category = el('div', 'category open');
    category.id = 'dmGroup';
    list.appendChild(category);
    const nameCat = el('div', 'categoryNameContainer');
    category.appendChild(nameCat);
    const svg = el('img', 'categorySVG');
    svg.src = '/resources/icons/categoryArrow.svg';
    nameCat.appendChild(svg);
    nameCat.appendChild(el('h5', 'categoryText', 'Direct Messages'));
    const div = el('div', 'channelContainer');
    category.appendChild(div);
    nameCat.addEventListener('click', () => category.classList.toggle('open'));

    const dmName = (d) => {
        if (d.recipient) return d.recipient.global_name || d.recipient.username || '?';
        const names = (d.recipients || []).map((u) => u.global_name || u.username || '?');
        return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') || 'Group DM';
    };
    const sorted = [...(S.dms || [])].sort((a, b) =>
        String(dmName(a)).localeCompare(String(dmName(b)))
    );
    if (!sorted.length) {
        div.appendChild(
            el('h5', 'viewableText', 'No DMs yet — right-click any user and pick Message to start one.')
        );
        return;
    }
    sorted.forEach((d) => {
        const u = d.recipient;
        const row = el('div', 'dmChannel');
        row.id = u ? `dm-${u.id}` : `dm-chan-${d.channel_id}`;

        if (u) {
            const img = el('img', 'dmChannelImage');
            img.src = u.avatar || DEFAULT_AVATAR;
            img.height = 25;
            img.width = 25;
            row.appendChild(img);
            row.appendChild(el('h5', 'viewableText', u.global_name || u.username));
            if (u.bot) {
                const tag = el('span', 'dmBotTag', 'BOT');
                row.appendChild(tag);
            }
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                userContextMenu(e, u);
            });
        } else {
            // group DM: no single recipient
            const icon = el('div', 'dmGroupIcon', '👥');
            row.appendChild(icon);
            row.appendChild(el('h5', 'viewableText', dmName(d)));
        }

        row.addEventListener('click', () => {
            const prev = list.querySelector('.selectedChan');
            if (prev && prev !== row) prev.classList.remove('selectedChan');
            if (prev === row) return;
            row.classList.add('selectedChan');
            selectChannel(
                { id: d.channel_id, name: dmName(d), isDM: true, recipient: u || null },
                row
            );
        });
        div.appendChild(row);
    });
}

// Open (or reuse) a DM with any user, then jump straight into it.
async function openDMWith(userId) {
    userId = String(userId);
    try {
        const r = await Api.createDM(userId);
        try {
            const d = await Api.dms();
            S.dms = (d && d.dms) || S.dms;
            refreshLookup();
        } catch (e) {
            /* list refresh is best-effort */
        }
        showDMHome();
        const rec = r.recipient || null;
        const row = (rec && $(`dm-${rec.id}`)) || $(`dm-chan-${r.channel_id}`);
        selectChannel(
            {
                id: r.channel_id,
                name: (rec && (rec.global_name || rec.username)) || 'DM',
                isDM: true,
                recipient: rec,
            },
            row
        );
    } catch (e) {
        errorHandler(e);
    }
}

/* =============================== member list ============================= */

function renderMemberList(g) {
    const listDiv = $('memberBar');
    listDiv.innerHTML = '';
    const members = S.members[g.id] || [];

    const onlineGroup = { title: 'Online', nodes: [] };
    const offlineGroup = { title: 'Offline', nodes: [] };

    members.forEach((m) => {
        const outer = el('div', 'mLOuterDiv');
        const userDiv = el('div', 'mLUserDiv');
        userDiv.id = `member-${m.id}`;
        outer.appendChild(userDiv);

        const icon = el('img', 'mLIcon');
        icon.src = m.avatar || DEFAULT_AVATAR;
        userDiv.appendChild(icon);

        const username = el('p', 'mLUsername', m.display_name || m.username);
        username.style.color = m.color || '#8E9297';
        username.title = `${m.display_name || m.username} — Shift+Click to mention`;
        userDiv.appendChild(username);

        userDiv.addEventListener('click', (e) => {
            if (e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                insertMention(m.id);
            }
        });
        userDiv.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            userContextMenu(e, m);
        });

        if (m.status === 'offline') offlineGroup.nodes.push(outer);
        else onlineGroup.nodes.push(outer);
    });

    [onlineGroup, offlineGroup].forEach((gr) => {
        if (!gr || !gr.nodes.length) return;
        if (gr === offlineGroup && members.length >= 1000) return; // like the desktop client
        const cont = el('div', 'roleContainer');
        cont.id = gr.title;
        const title = el('span', 'roleTitle', `${gr.title} — ${gr.nodes.length}`);
        cont.appendChild(title);
        gr.nodes.forEach((n) => cont.appendChild(n));
        listDiv.appendChild(cont);
    });
}

/* ============================ typing indicator =========================== */

function renderTyping() {
    const ind = $('typingIndicator');
    const dots = $('typingDots');
    const cid = S.channel && S.channel.id;
    const users = cid && S.typingTimers[cid] ? Object.values(S.typingTimers[cid]) : [];
    if (!users.length) {
        ind.innerText = '';
        dots.style.display = 'none';
        return;
    }
    dots.style.display = 'block';
    if (users.length === 1) ind.innerText = `${users[0].name} is typing...`;
    else if (users.length === 2) ind.innerText = `${users[0].name} and ${users[1].name} are typing...`;
    else ind.innerText = 'Several people are typing...';
}

function noteTyping(channelId, user) {
    if (S.me && user.id === S.me.id) return;
    S.typingTimers[channelId] = S.typingTimers[channelId] || {};
    const bucket = S.typingTimers[channelId];
    if (bucket[user.id]) clearTimeout(bucket[user.id].timeout);
    bucket[user.id] = {
        name: user.global_name || user.username,
        timeout: setTimeout(() => {
            delete bucket[user.id];
            if (!Object.keys(bucket).length) delete S.typingTimers[channelId];
            renderTyping();
        }, 10000),
    };
    renderTyping();
}

let typingThrottle = 0;
function sendTyping() {
    if (!S.channel) return;
    const now = Date.now();
    if (now - typingThrottle < 8000) return;
    typingThrottle = now;
    Api.typing(S.channel.id).catch(() => {});
}

/* ==================== mentions (Discord-style) ===========================
 * The box value stays raw (`<@id>`, which is what pings on send) while a
 * backdrop layer renders it as `@Name` pills — exactly what Discord shows.
 * Shift+LeftClick on any name/avatar, the Mention menu items, or the `@`
 * autocomplete all insert the same raw tag.
 */

function memberNameById(id) {
    id = String(id);
    const pools = Object.values(S.members || {});
    for (const arr of pools) {
        const hit = (arr || []).find((x) => String(x.id) === id);
        if (hit) return hit.display_name || hit.username || hit.global_name || id;
    }
    for (const d of S.dms || []) {
        if (d.recipient && String(d.recipient.id) === id) {
            return d.recipient.global_name || d.recipient.username || id;
        }
    }
    if (S.me && String(S.me.id) === id) return S.me.global_name || S.me.username;
    if (S.owner && String(S.owner.id) === id) {
        return S.owner.global_name || S.owner.username;
    }
    try {
        const hit = ResolveCache.users[id];
        if (hit && (hit.display || hit.username)) return hit.display || hit.username;
    } catch (e) {
        /* cache not ready yet */
    }
    return id;
}

function escHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Completion engine: `@` lists members + roles + everyone/here, `#` lists
// text channels. The popup hovers over the message bar and filters live.
function userCompleteItems(q) {
    const seen = new Set();
    const members = [];
    const push = (id, name, username, avatar, bot) => {
        id = id != null ? String(id) : '';
        if (!id || seen.has(id)) return;
        seen.add(id);
        if (
            !q ||
            String(name || '').toLowerCase().includes(q) ||
            String(username || '').toLowerCase().includes(q)
        ) {
            members.push({ type: 'member', id, name, username, avatar, bot });
        }
    };
    const byName = (a, b) =>
        String(a.display_name || a.username || '').localeCompare(
            String(b.display_name || b.username || '')
        );
    const gid = S.guildId;
    if (gid && S.members[gid]) {
        [...S.members[gid]].sort(byName).forEach((m) =>
            push(m.id, m.display_name || m.username, m.username, m.avatar, m.bot)
        );
    }
    Object.keys(S.members || {}).forEach((g) => {
        if (String(g) === String(gid)) return;
        [...(S.members[g] || [])].sort(byName).forEach((m) =>
            push(m.id, m.display_name || m.username, m.username, m.avatar, m.bot)
        );
    });
    (S.dms || []).forEach((d) => {
        const u = d.recipient;
        if (u) push(u.id, u.global_name || u.username, u.username, u.avatar, u.bot);
    });
    if (S.me) push(S.me.id, S.me.global_name || S.me.username, S.me.username, S.me.avatar, true);
    const out = members.slice(0, 6);
    if (gid) {
        const roles = [...((S.roles || {})[gid] || [])].sort(
            (a, b) => (b.position || 0) - (a.position || 0)
        );
        for (const r of roles) {
            if (out.length >= 8) break;
            if (String(r.name) === '@everyone') continue; // covered below
            if (q && !String(r.name || '').toLowerCase().includes(q)) continue;
            out.push({ type: 'role', id: String(r.id), name: r.name, color: r.color });
        }
        if (out.length < 8 && (!q || 'everyone'.includes(q))) {
            out.push({ type: 'everyone', name: 'everyone', sub: 'Notify everyone in this channel' });
        }
        if (out.length < 8 && (!q || 'here'.includes(q))) {
            out.push({ type: 'here', name: 'here', sub: 'Notify online members' });
        }
    }
    return out.slice(0, 8);
}

function channelCompleteItems(q) {
    const gid = S.guildId;
    if (!gid || !S.channels[gid]) return [];
    return (S.channels[gid] || [])
        .filter((c) => {
            try {
                return isTextType(c.type);
            } catch (e) {
                return false;
            }
        })
        .filter((c) => !q || String(c.name || '').toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ type: 'channel', id: String(c.id), name: c.name, topic: c.topic || '' }));
}

// Detect an @ / # trigger right before the caret. Channels only make sense
// inside a guild; in DMs there is nothing to complete with #.
function detectComplete() {
    const box = $('msgbox');
    if (!box || !S.channel) return null;
    const pos = box.selectionStart != null ? box.selectionStart : box.value.length;
    const before = box.value.slice(0, pos);
    let m = before.match(/(^|\s)@([\p{L}\p{N}_.]{0,32})$/u);
    if (m) return { kind: 'user', query: m[2].toLowerCase(), start: pos - m[2].length - 1 };
    if (S.guildId && S.channel && !S.channel.isDM) {
        m = before.match(/(^|\s)#([\p{L}\p{N}_-]{0,32})$/u);
        if (m) return { kind: 'channel', query: m[2].toLowerCase(), start: pos - m[2].length - 1 };
    }
    return null;
}

function insertMention(userId) {
    const box = $('msgbox');
    if (!box) return;
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    userId = String(userId);
    const tag = `<@${userId}>`;
    const start = box.selectionStart != null ? box.selectionStart : box.value.length;
    const end = box.selectionEnd != null ? box.selectionEnd : box.value.length;
    const before = box.value.slice(0, start);
    const after = box.value.slice(end);
    const needsSpace = before && !/\s$/.test(before) ? ' ' : '';
    box.value = `${before}${needsSpace}${tag} ${after.replace(/^\s/, '')}`;
    const pos = (before + needsSpace + tag + ' ').length;
    try {
        box.focus();
        box.setSelectionRange(pos, pos);
    } catch (e) {
        /* ignore */
    }
    hideMentionSuggest();
    syncMentionBackdrop();
    sendTyping();
}

function ensureMsgWrap() {
    const box = $('msgbox');
    if (!box || $('msgWrap')) return;
    const wrap = document.createElement('div');
    wrap.id = 'msgWrap';
    const bd = document.createElement('div');
    bd.id = 'msgBackdrop';
    bd.setAttribute('aria-hidden', 'true');
    box.parentElement.insertBefore(wrap, box);
    wrap.appendChild(bd);
    wrap.appendChild(box);
    const sug = document.createElement('div');
    sug.id = 'mentionSuggest';
    sug.className = 'hidden';
    wrap.appendChild(sug);
    box.addEventListener('scroll', () => {
        bd.scrollTop = box.scrollTop;
        bd.scrollLeft = box.scrollLeft;
    });
}

function syncMentionBackdrop() {
    const box = $('msgbox');
    const bd = $('msgBackdrop');
    if (!box || !bd) return;
    const raw = box.value;
    if (!raw) {
        bd.innerHTML = '';
        return;
    }
    // Tokenize raw <@id> / <@!id> / <#id> / <@&id> / @everyone / @here;
    // pills show @Name.
    const parts = raw.split(/(<@!?\d+>|<#\d+>|<@&\d+>|@everyone|@here)/g);
    let html = '';
    for (const p of parts) {
        if (p === '@everyone' || p === '@here') {
            html += `<span class="msgMentionPill">${p}</span>`;
            continue;
        }
        let mm = p.match(/^<@!?(\d+)>$/);
        if (mm) {
            html += `<span class="msgMentionPill">@${escHtml(memberNameById(mm[1]))}</span>`;
            continue;
        }
        mm = p.match(/^<#(\d+)>$/);
        if (mm) {
            const ch = (Fmt && Fmt.chanName) ? Fmt.chanName(mm[1]) : null;
            html += `<span class="msgMentionPill msgChannelPill">#${escHtml(ch || 'channel')}</span>`;
            continue;
        }
        mm = p.match(/^<@&(\d+)>$/);
        if (mm) {
            const rn = (Fmt && Fmt.roleName) ? Fmt.roleName(mm[1]) : null;
            html += `<span class="msgMentionPill">@${escHtml(rn || 'role')}</span>`;
            continue;
        }
        html += escHtml(p).replace(/\n/g, '<br>');
    }
    // trailing newline otherwise the backdrop shrinks vs the textarea
    if (raw.endsWith('\n')) html += '<br>';
    bd.innerHTML = html;
    bd.scrollTop = box.scrollTop;
    bd.scrollLeft = box.scrollLeft;
}

/* ---- @ / # autocomplete popup (over the message bar) ---- */

const MentionSuggest = { open: false, items: [], active: 0, kind: null, start: 0 };

function hideMentionSuggest() {
    MentionSuggest.open = false;
    MentionSuggest.items = [];
    MentionSuggest.active = 0;
    MentionSuggest.kind = null;
    const s = $('mentionSuggest');
    if (s) s.classList.add('hidden');
}

function suggestRowIcon(it) {
    if (it.type === 'member') {
        const img = el('img', 'mentionAvatar');
        img.src = it.avatar || DEFAULT_AVATAR;
        return img;
    }
    const badge = el('div', 'mentionGlyph');
    if (it.type === 'channel') {
        badge.innerText = '#';
        badge.classList.add('glyphChan');
    } else if (it.type === 'role') {
        const dot = el('span', 'roleDot');
        dot.style.background = it.color || '#99aab5';
        badge.appendChild(dot);
    } else {
        badge.innerText = '@';
        badge.classList.add('glyphAt');
    }
    return badge;
}

function updateMentionSuggest() {
    const box = $('msgbox');
    const sug = $('mentionSuggest');
    if (!box || !sug || !S.channel) {
        hideMentionSuggest();
        return false;
    }
    const det = detectComplete();
    if (!det) {
        hideMentionSuggest();
        return false;
    }
    const items =
        det.kind === 'channel' ? channelCompleteItems(det.query) : userCompleteItems(det.query);
    if (!items.length) {
        hideMentionSuggest();
        return false;
    }
    MentionSuggest.open = true;
    MentionSuggest.items = items;
    MentionSuggest.kind = det.kind;
    MentionSuggest.start = det.start;
    MentionSuggest.active = Math.min(MentionSuggest.active, items.length - 1);
    sug.innerHTML = '';
    items.forEach((it, i) => {
        const row = el('div', 'mentionRow' + (i === MentionSuggest.active ? ' active' : ''));
        row.appendChild(suggestRowIcon(it));
        const tx = el('div', 'mentionTexts');
        const nameRow = el('div', 'mentionName', (it.type === 'channel' ? '#' : it.type === 'member' ? '' : '@') + (it.name || '?'));
        if (it.type === 'role' && it.color) {
            try {
                nameRow.style.color = it.color;
            } catch (e) {
                /* ignore */
            }
        }
        tx.appendChild(nameRow);
        let sub = it.sub || '';
        if (it.type === 'member') {
            if (it.username && it.username !== it.name) sub = it.username + (it.bot ? ' • BOT' : '');
            else if (it.bot) sub = 'BOT';
        } else if (it.type === 'role') {
            sub = 'ROLE';
        } else if (it.type === 'channel' && it.topic) {
            sub = String(it.topic).slice(0, 60);
        }
        if (sub) tx.appendChild(el('div', 'mentionSub', sub));
        row.appendChild(tx);
        row.addEventListener('mousedown', (e) => {
            // mousedown: beats the textarea blur that would close the list
            e.preventDefault();
            pickMention(i);
        });
        sug.appendChild(row);
    });
    sug.classList.remove('hidden');
    return true;
}

function pickMention(i) {
    const it = MentionSuggest.items[i != null ? i : MentionSuggest.active];
    if (!it) {
        hideMentionSuggest();
        return;
    }
    const box = $('msgbox');
    if (!box) {
        hideMentionSuggest();
        return;
    }
    const pos = box.selectionStart != null ? box.selectionStart : box.value.length;
    const det = detectComplete();
    // the trigger must still be the one the list was built for
    if (!det || det.kind !== MentionSuggest.kind || det.start !== MentionSuggest.start) {
        hideMentionSuggest();
        return;
    }
    let tag;
    if (it.type === 'channel') tag = `<#${it.id}>`;
    else if (it.type === 'role') tag = `<@&${it.id}>`;
    else if (it.type === 'everyone') tag = '@everyone';
    else if (it.type === 'here') tag = '@here';
    else tag = `<@${it.id}>`;
    box.value = `${box.value.slice(0, det.start)}${tag} ${box.value.slice(pos).replace(/^\s/, '')}`;
    const npos = det.start + `${tag} `.length;
    try {
        box.focus();
        box.setSelectionRange(npos, npos);
    } catch (e) {
        /* ignore */
    }
    hideMentionSuggest();
    syncMentionBackdrop();
}
// Returns true when the key was consumed by the autocomplete list.
function mentionSuggestKey(e) {
    if (!MentionSuggest.open) return false;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        MentionSuggest.active = (MentionSuggest.active + 1) % MentionSuggest.items.length;
        updateMentionSuggest();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        MentionSuggest.active =
            (MentionSuggest.active - 1 + MentionSuggest.items.length) % MentionSuggest.items.length;
        updateMentionSuggest();
        return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(MentionSuggest.active);
        return true;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionSuggest();
        return true;
    }
    return false;
}

/* ============ async mention resolution (no more @12345…) ============
 * Anything rendered before its data arrived — history from before login,
 * members not chunked yet — gets tagged data-uid/cid/rid pills. This pass
 * fills them in: local caches first (members often load AFTER messages),
 * one batched /api/resolve per paint otherwise.
 */

const ResolveCache = { users: {}, channels: {}, roles: {} };
let resolveTimer = null;
const resolveRoots = new Set();

function scheduleResolve(root) {
    try {
        if (root) resolveRoots.add(root);
        if (resolveTimer) return;
        resolveTimer = setTimeout(() => {
            resolveTimer = null;
            const roots = [...resolveRoots];
            resolveRoots.clear();
            flushResolve(roots).catch(() => {});
        }, 60);
    } catch (e) {
        /* never break rendering */
    }
}

async function flushResolve(roots) {
    const spans = [];
    (roots || []).forEach((root) => {
        if (!root || !root.isConnected) return;
        try {
            root.querySelectorAll('[data-uid],[data-cid],[data-rid]').forEach((s) => {
                if (!s.isConnected || s.classList.contains('resolved')) return;
                spans.push(s);
            });
        } catch (e) {
            /* ignore */
        }
    });
    if (!spans.length) return;
    // 1. paint everything the local caches already know
    const pending = { users: new Set(), channels: new Set(), roles: new Set() };
    spans.forEach((s) => {
        if (paintResolvedSpan(s)) return;
        if (s.dataset.uid) pending.users.add(s.dataset.uid);
        else if (s.dataset.cid) pending.channels.add(s.dataset.cid);
        else if (s.dataset.rid) pending.roles.add(s.dataset.rid);
    });
    const needU = [...pending.users].filter((id) => !ResolveCache.users[id]).slice(0, 25);
    const needC = [...pending.channels].filter((id) => !ResolveCache.channels[id]).slice(0, 25);
    const needR = [...pending.roles].filter((id) => !ResolveCache.roles[id]).slice(0, 25);
    if (needU.length || needC.length || needR.length) {
        try {
            const data = await Api.resolve(needU, needC, needR);
            try {
                Object.assign(ResolveCache.users, (data && data.users) || {});
                Object.assign(ResolveCache.channels, (data && data.channels) || {});
                Object.assign(ResolveCache.roles, (data && data.roles) || {});
            } catch (e) {
                /* ignore */
            }
        } catch (e) {
            return; // keep @id rather than break anything
        }
    }
    spans.forEach((s) => {
        if (s.isConnected) paintResolvedSpan(s);
    });
}

// Paint one pill from the caches. True when fully resolved.
function paintResolvedSpan(s) {
    try {
        if (s.dataset.uid) {
            const id = String(s.dataset.uid);
            const local = memberNameById(id);
            if (local !== id) {
                s.innerText = '@' + local;
                s.classList.remove('ping-unknown');
                s.classList.add('resolved');
                return true;
            }
            const hit = ResolveCache.users[id];
            if (hit && (hit.display || hit.username)) {
                s.innerText = '@' + (hit.display || hit.username);
                s.classList.remove('ping-unknown');
                s.classList.add('resolved');
                return true;
            }
            return false;
        }
        if (s.dataset.cid) {
            const id = String(s.dataset.cid);
            const name =
                (Fmt && Fmt.chanName && Fmt.chanName(id)) ||
                ((ResolveCache.channels[id] || {}).name || null);
            if (name) {
                s.innerText = '#' + name;
                s.classList.remove('ping-unknown');
                s.classList.add('resolved');
                return true;
            }
            return false;
        }
        if (s.dataset.rid) {
            const id = String(s.dataset.rid);
            let hit = null;
            try {
                const pools = Object.values(S.roles || {});
                for (const arr of pools) {
                    const f = (arr || []).find((x) => String(x.id) === id);
                    if (f) {
                        hit = f;
                        break;
                    }
                }
            } catch (e) {
                hit = null;
            }
            hit = hit || ResolveCache.roles[id];
            if (hit && hit.name) {
                s.innerText = '@' + hit.name;
                if (hit.color) {
                    try {
                        // role pills wear the role color, not blurple
                        s.style.setProperty('color', hit.color, 'important');
                        s.style.setProperty('background-color', `${hit.color}26`, 'important');
                    } catch (e) {
                        /* ignore */
                    }
                }
                s.classList.remove('ping-unknown');
                s.classList.add('resolved');
                return true;
            }
            return false;
        }
    } catch (e) {
        /* ignore */
    }
    return false;
}

/* ==================== reactions (Discord-style) ========================== */

const QUICK_EMOJIS = [
    '👍', '❤️', '😂', '😮', '😢', '🙏',
    '🎉', '🔥', '👀', '✅', '❌', '🤔',
    '👏', '💯', '😅', '🥳', '😭', '🤝',
    '👋', '💀',
];

function reactionApiEmoji(r) {
    // What the REST API / discord.py wants back for this pill
    // (animated custom emoji need the a: prefix).
    if (r.id) {
        let animated = false;
        try {
            const e = (S.emojis || []).find((x) => String(x.id) === String(r.id));
            animated = !!(e && e.animated);
        } catch (err) {
            /* ignore */
        }
        return animated ? `<a:${r.name}:${r.id}>` : `<:${r.name}:${r.id}>`;
    }
    return r.name;
}

function reactionPill(m, r) {
    const pill = el('div', 'reaction' + (r.me ? ' me' : ''));
    pill.dataset.key = r.key;
    pill.title = r.id ? `:${r.name}:` : r.name;
    if (r.url) {
        const img = el('img', 'reactionEmoji');
        img.src = r.url;
        img.alt = r.name;
        img.draggable = false;
        pill.appendChild(img);
    } else {
        const s = el('span', 'reactionEmojiTxt', r.name);
        pill.appendChild(s);
        try {
            if (typeof twemoji !== 'undefined') twemoji.parse(pill);
        } catch (e) {
            /* ignore */
        }
    }
    pill.appendChild(el('span', 'reactionCount', String(r.count)));
    pill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleReaction(m, r.key);
    });
    return pill;
}

function renderReactions(m, parent) {
    const list = m.reactions || [];
    if (!list.length) return;
    const row = el('div', 'reactions');
    row.dataset.mid = m.id;
    list.forEach((r) => {
        try {
            row.appendChild(reactionPill(m, r));
        } catch (e) {
            /* ignore one bad reaction */
        }
    });
    if (row.children.length) parent.appendChild(row);
}

function reactionsRow(mid) {
    const node = document.getElementById(mid);
    if (!node) return null;
    let row = node.querySelector(':scope > .reactions');
    if (!row) {
        row = document.createElement('div');
        row.className = 'reactions';
        row.dataset.mid = mid;
        node.appendChild(row);
    }
    return row;
}

// Absolute correction from gateway truth (count) — safe against double-apply
// between the optimistic toggle and the WS echo.
function patchReaction(mid, emoji, count, me) {
    const row = reactionsRow(mid);
    if (!row) return;
    let pill = row.querySelector(`[data-key="${CSS.escape(emoji.key)}"]`);
    if (count <= 0) {
        if (pill) pill.remove();
        if (!row.children.length) row.remove();
        return;
    }
    if (!pill) {
        const m = { id: mid, channel_id: (S.channel && S.channel.id) || '' };
        pill = reactionPill(m, { ...emoji, count, me: !!me });
        row.appendChild(pill);
    }
    const cnt = pill.querySelector('.reactionCount');
    if (cnt) cnt.innerText = String(count);
    if (me === true) pill.classList.add('me');
    else if (me === false) pill.classList.remove('me');
}

function patchReactionEvent(d, kind) {
    if (!d || !d.message_id) return;
    if (S.channel && d.channel_id && d.channel_id !== S.channel.id) return;
    if (kind === 'clear') {
        const node = document.getElementById(d.message_id);
        const row = node && node.querySelector(':scope > .reactions');
        if (row) row.remove();
        return;
    }
    if (kind === 'clear_emoji') {
        patchReaction(d.message_id, d.emoji, 0, null);
        return;
    }
    const self = S.me && d.user && String(d.user.id) === String(S.me.id);
    if (kind === 'add') {
        patchReaction(d.message_id, d.emoji, d.count || 1, self ? true : null);
    } else if (kind === 'remove') {
        patchReaction(d.message_id, d.emoji, d.count || 0, self ? false : null);
    }
}

// Rebuild the reactions row from an authoritative reaction list, so the UI
// never depends solely on gateway timing after an add/remove.
function syncReactionsRow(m, reactions) {
    m.reactions = reactions || [];
    const node = document.getElementById(m.id);
    if (!node) return;
    const old = node.querySelector(':scope > .reactions');
    if (old) old.remove();
    try {
        renderReactions(m, node);
    } catch (e) {
        /* ignore */
    }
}

async function refreshReactions(m) {
    try {
        const res = await Api.message(m.channel_id, m.id);
        if (res && res.message && Array.isArray(res.message.reactions)) {
            syncReactionsRow(m, res.message.reactions);
        }
    } catch (e) {
        /* gateway echo is the fallback; stay quiet */
    }
}

async function toggleReaction(m, key) {
    if (isPendingId(m.id)) {
        toast('Still sending…');
        return;
    }
    let emoji = null;
    (m.reactions || []).forEach((r) => {
        if (r.key === key) emoji = reactionApiEmoji(r);
    });
    if (!emoji) {
        // pill created from a WS event (no cached message): the key encodes
        // `name` (unicode) or `name:id` (custom) — rebuild the API form.
        emoji = /\d/.test(key) && key.includes(':') ? `<:${key}>` : key;
    }
    if (!emoji) return;
    const node = document.getElementById(m.id);
    const pill = node && node.querySelector(`[data-key="${CSS.escape(key)}"]`);
    const adding = pill ? !pill.classList.contains('me') : true;
    try {
        if (adding) await Api.addReaction(m.channel_id, m.id, emoji);
        else await Api.removeReaction(m.channel_id, m.id, emoji);
        // authoritative state first, gateway echo (now enabled via the
        // reactions intent) keeps it correct afterwards
        await refreshReactions(m);
    } catch (e) {
        errorHandler(e);
    }
}

async function addReactionTo(m, emoji) {
    try {
        await Api.addReaction(m.channel_id, m.id, emoji);
        await refreshReactions(m);
    } catch (e) {
        errorHandler(e);
    }
}

function closeEmojiPicker() {
    const p = $('emojiPicker');
    if (p) p.remove();
}

function openEmojiPicker(x, y, m) {
    closeRcMenu();
    closeEmojiPicker();
    const pop = el('div', 'emojiPicker');
    pop.id = 'emojiPicker';
    QUICK_EMOJIS.forEach((e) => {
        const b = el('div', 'emojiPick', e);
        b.title = e;
        b.addEventListener('click', () => {
            closeEmojiPicker();
            addReactionTo(m, e);
        });
        pop.appendChild(b);
    });
    const customs = (S.emojis || []).slice(0, 48);
    if (customs.length) {
        const sep = el('div', 'emojiSep');
        pop.appendChild(sep);
        customs.forEach((e) => {
            const b = el('div', 'emojiPick');
            b.title = `:${e.name}:`;
            const img = el('img', 'emojiPickImg');
            img.src = e.url;
            img.alt = e.name;
            img.loading = 'lazy';
            b.appendChild(img);
            b.addEventListener('click', () => {
                closeEmojiPicker();
                addReactionTo(m, `<:${e.name}:${e.id}>`);
            });
            pop.appendChild(b);
        });
    }
    document.body.appendChild(pop);
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    setTimeout(() => {
        document.addEventListener('click', function h(ev) {
            if (!pop.contains(ev.target)) {
                closeEmojiPicker();
                document.removeEventListener('click', h);
            }
        });
    }, 0);
}

/* ==================== message stickers ================================ */

function renderStickers(m, parent) {
    const list = m.stickers || [];
    if (!list.length) return;
    const wrap = el('div', 'stickers');
    list.forEach((s) => {
        try {
            if (s.url) {
                const a = document.createElement('a');
                a.href = s.url;
                a.target = '_blank';
                a.rel = 'noreferrer noopener';
                const img = document.createElement('img');
                img.className = 'stickerImg';
                img.src = s.url;
                img.alt = s.name || 'sticker';
                img.loading = 'lazy';
                a.appendChild(img);
                wrap.appendChild(a);
            } else {
                // lottie (animated JSON): no raster preview, still viewable
                wrap.appendChild(el('div', 'stickerLottie', `🎭 ${s.name || 'sticker'}`));
            }
        } catch (e) {
            /* ignore one bad sticker */
        }
    });
    if (wrap.children.length) parent.appendChild(wrap);
}

/* ==================== message components V2 ==============================
 * Renders Discord's Components V2 (containers, sections, text displays,
 * media galleries, buttons, selects…) from the raw dicts the backend sends.
 * Bots can't press each other's buttons / open selects, so interactive
 * components render faithfully but disabled — except link buttons, which
 * open normally.
 */

function v2TextNode(content, msg, isDM) {
    const d = el('div', 'v2text');
    try {
        d.innerHTML = Fmt.parseMessage(content || '', msg, { isDM });
    } catch (e) {
        d.innerText = content || '';
    }
    return d;
}

function v2EmojiNode(emoji) {
    if (!emoji) return null;
    const name = emoji.name || emoji;
    if (emoji.id) {
        const img = document.createElement('img');
        img.className = 'v2emoji';
        img.alt = name || '';
        img.draggable = false;
        img.src = `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}?v=1`;
        return img;
    }
    const s = el('span', 'v2emojiTxt', typeof name === 'string' ? name : '');
    try {
        if (typeof twemoji !== 'undefined') twemoji.parse(s);
    } catch (e) {
        /* ignore */
    }
    return s;
}

const V2_BTN_CLASS = {
    1: 'v2btn-primary',
    2: 'v2btn-secondary',
    3: 'v2btn-success',
    4: 'v2btn-danger',
    5: 'v2btn-link',
};

function renderV2Button(c, parent) {
    const style = Number(c.style || 2);
    const label = c.label || '';
    const emoji = v2EmojiNode(c.emoji);
    const isLink = style === 5 && c.url;
    const node = document.createElement(isLink ? 'a' : 'button');
    node.className = `v2btn ${V2_BTN_CLASS[style] || 'v2btn-secondary'}`;
    if (emoji) node.appendChild(emoji);
    if (label) node.appendChild(el('span', '', label));
    if (!label && !emoji) node.appendChild(el('span', '', 'Button'));
    if (c.disabled) node.classList.add('v2disabled');
    if (isLink) {
        node.href = c.url;
        node.target = '_blank';
        node.rel = 'noreferrer noopener';
    } else {
        node.disabled = true;
        node.title = "Bots can't press buttons";
    }
    parent.appendChild(node);
}

function renderV2Select(c, parent) {
    const d = el('div', 'v2select v2disabled');
    d.title = "Bots can't use select menus";
    const ph = el('span', 'v2select-ph', c.placeholder || 'Select an option');
    d.appendChild(ph);
    d.appendChild(el('span', 'v2select-arrow', '▾'));
    parent.appendChild(d);
}

function renderV2Component(c, parent, msg, isDM) {
    if (!c || typeof c !== 'object') return;
    const t = String(c.type != null ? c.type : '').toLowerCase();
    const is = (n, name) => t === String(n) || t === name;
    if (is(17, 'container')) {
        const d = el('div', 'v2container');
        if (c.accent_color != null) {
            try {
                d.style.borderLeftColor = `#${Number(c.accent_color).toString(16).padStart(6, '0')}`;
            } catch (e) {
                /* ignore */
            }
        }
        (c.components || []).forEach((k) => renderV2Component(k, d, msg, isDM));
        if (d.children.length) parent.appendChild(d);
    } else if (is(1, 'action_row')) {
        const d = el('div', 'v2row');
        (c.components || []).forEach((k) => renderV2Component(k, d, msg, isDM));
        if (d.children.length) parent.appendChild(d);
    } else if (is(9, 'section')) {
        const d = el('div', 'v2section');
        const tx = el('div', 'v2section-text');
        (c.components || []).forEach((k) => renderV2Component(k, tx, msg, isDM));
        d.appendChild(tx);
        if (c.accessory) {
            const acc = el('div', 'v2accessory');
            renderV2Component(c.accessory, acc, msg, isDM);
            d.appendChild(acc);
        }
        parent.appendChild(d);
    } else if (is(10, 'text_display')) {
        parent.appendChild(v2TextNode(c.content || '', msg, isDM));
    } else if (is(14, 'separator')) {
        const hr = document.createElement('hr');
        hr.className = 'v2sep' + (c.divider === false ? ' v2sep-plain' : '');
        parent.appendChild(hr);
    } else if (is(12, 'media_gallery')) {
        const g = el('div', 'v2gallery');
        (c.items || []).forEach((it) => {
            const media = (it && (it.media || it)) || {};
            if (!media.url) return;
            const img = document.createElement('img');
            img.className = 'v2gallery-item';
            img.src = media.url;
            img.loading = 'lazy';
            img.alt = it.description || media.description || '';
            g.appendChild(img);
        });
        if (g.children.length) parent.appendChild(g);
    } else if (is(11, 'thumbnail')) {
        const media = c.media || {};
        if (media.url) {
            const img = document.createElement('img');
            img.className = 'v2thumb';
            img.src = media.url;
            img.loading = 'lazy';
            img.alt = c.description || media.description || '';
            parent.appendChild(img);
        }
    } else if (is(13, 'file')) {
        const f = c.file || c.media || {};
        if (f.url) {
            const d = el('div', 'v2file');
            const a = document.createElement('a');
            a.href = f.url;
            a.target = '_blank';
            a.rel = 'noreferrer noopener';
            a.textContent = `📎 ${c.name || f.filename || 'file'}`;
            d.appendChild(a);
            parent.appendChild(d);
        }
    } else if (is(2, 'button')) {
        renderV2Button(c, parent);
    } else if (
        is(3, 'string_select') || is(5, 'user_select') || is(6, 'role_select') ||
        is(7, 'mentionable_select') || is(8, 'channel_select')
    ) {
        renderV2Select(c, parent);
    } else if (Array.isArray(c.components)) {
        // forward-compatible: recurse into unknown layout wrappers
        c.components.forEach((k) => renderV2Component(k, parent, msg, isDM));
    }
}

function renderComponentsV2(m, parent, isDM) {
    const comps = m.components || [];
    if (!comps.length) return;
    const wrap = el('div', 'v2wrap');
    comps.forEach((c) => {
        try {
            renderV2Component(c, wrap, m, isDM);
        } catch (e) {
            /* ignore one bad component */
        }
    });
    if (wrap.children.length) parent.appendChild(wrap);
}

function renderPoll(m, parent, isDM) {
    const poll = m.poll;
    if (!poll || typeof poll !== 'object') return;
    const q = (poll.question && (poll.question.text || poll.question)) || '';
    const answers = poll.answers || poll.results || [];
    if (!q && !answers.length) return;
    const box = el('div', 'v2poll');
    const qEl = el('div', 'v2poll-q');
    try {
        qEl.innerHTML = `📊 ${Fmt.parseMessage(String(q || 'Poll'), m, { isDM })}`;
    } catch (e) {
        qEl.innerText = `📊 ${q || 'Poll'}`;
    }
    box.appendChild(qEl);
    answers.slice(0, 10).forEach((a) => {
        const media = a.poll_media || a.media || a;
        const text = (media && (media.text || media.question)) || a.text || '';
        if (!text) return;
        const row = el('div', 'v2poll-a');
        try {
            row.innerHTML = Fmt.parseMessage(String(text), m, { isDM });
        } catch (e) {
            row.innerText = String(text);
        }
        box.appendChild(row);
    });
    parent.appendChild(box);
}

/* ================================ sending ================================ */

const HELP_MSG = [
    'Here is a list of available commands.',
    '`/help` - Lists all commands.',
    '`/shrug` - Appends ¯\\_(ツ)_/¯ to your message.',
    '`/tableflip` - Appends (╯°□°）╯︵ ┻━┻ to your message.',
    '`/unflip` - Appends ┬─┬ ノ( ゜-゜ノ) to your message.',
    '`/lenny` - Appends ( ͡° ͜ʖ ͡°) to your message.',
    '`/ping` - Check the heartbeat to discord.',
    '`/server` - Get some info about the server.',
    '`/purge <num>` - Deletes up to 100 recent messages.',
    '`/eval <js>` - Execute JavaScript in your browser (local only).',
].join('\n');

/* ==================== replies (Discord-style) ============================
 * Right-click (or the Reply item) quotes a message: a composer bar above
 * the input shows who you're replying to, with a ping ON/OFF toggle.
 * Sends carry `reply_to` + `mention_author`, like the Discord client.
 */

// Snippet cache for quoted messages not currently in the DOM.
const ReplyCache = new Map(); // mid -> {name, snippet}

function replySnippetFor(m) {    const text = (m.content || '').trim();
    if (text) return text.slice(0, 80);
    if ((m.attachments || []).length) return '📎 attachment';
    if ((m.embeds || []).length) return '📄 embed';
    if ((m.components || []).length) return '▦ message';
    return '(empty message)';
}

function replyNameFor(m) {
    try {
        const mem = m.member;
        return (
            (mem && (mem.display_name || mem.nick)) ||
            m.author.global_name ||
            m.author.username ||
            'unknown'
        );
    } catch (e) {
        return 'unknown';
    }
}

function ensureReplyComposer() {
    if ($('replyComposer')) return;
    const sendmsg = $('sendmsg');
    const bar = $('messageBar');
    if (!sendmsg || !bar) return;
    const c = document.createElement('div');
    c.id = 'replyComposer';
    c.className = 'hidden';
    const label = el('span', 'replyComposerLabel', 'Replying to ');
    const name = el('strong', 'replyComposerName', '');
    name.id = 'replyComposerName';
    const snippet = el('span', 'replyComposerSnippet', '');
    snippet.id = 'replyComposerSnippet';
    const ping = el('button', 'replyPingToggle pingOn', '@ON');
    ping.id = 'replyPingToggle';
    ping.title = 'Toggle whether the reply pings the author';
    ping.addEventListener('click', (e) => {
        e.preventDefault();
        S.replyMention = !S.replyMention;
        renderReplyComposer();
    });
    const x = el('button', 'replyCancel', '✕');
    x.title = 'Cancel reply (Esc)';
    x.addEventListener('click', (e) => {
        e.preventDefault();
        cancelReply();
        $('msgbox') && $('msgbox').focus();
    });
    c.appendChild(label);
    c.appendChild(name);
    c.appendChild(snippet);
    c.appendChild(ping);
    c.appendChild(x);
    sendmsg.insertBefore(c, bar);
}

function renderReplyComposer() {
    ensureReplyComposer();
    const c = $('replyComposer');
    if (!c) return;
    const r = S.replyTo;
    if (!r) {
        c.classList.add('hidden');
        return;
    }
    c.classList.remove('hidden');
    $('replyComposerName').innerText = r.name || 'unknown';
    $('replyComposerSnippet').innerText = r.snippet ? `  ${r.snippet}` : '';
    const ping = $('replyPingToggle');
    ping.innerText = S.replyMention ? '@ON' : '@OFF';
    ping.classList.toggle('pingOn', !!S.replyMention);
    ping.classList.toggle('pingOff', !S.replyMention);
}

function startReply(m) {
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    if (isPendingId(m.id)) {
        toast('Still sending…');
        return;
    }
    S.replyTo = {
        id: String(m.id),
        channel_id: String(m.channel_id),
        authorId: String(m.author.id),
        name: replyNameFor(m),
        snippet: replySnippetFor(m),
    };
    renderReplyComposer();
    try {
        $('msgbox').focus();
    } catch (e) {
        /* ignore */
    }
}

function cancelReply() {
    if (!S.replyTo) return;
    S.replyTo = null;
    renderReplyComposer();
}

async function sendCurrent() {
    if (!S.channel) {
        toast('Select a channel first');
        return true;
    }
    let text = $('msgbox').value;
    if (!text.replace(/ |\n| /gm, '')) return true;

    if (text.startsWith('/')) {
        const cmd = text.split(' ')[0].substring(1);
        const args = text.split(' ').splice(1);
        const msg = args.join(' ');
        switch (cmd) {
            case 'help':
                barry(HELP_MSG);
                break;
            case 'shrug':
                await sendText(msg + '¯\\_(ツ)_/¯ ');
                break;
            case 'tableflip':
                await sendText(msg + '(╯°□°）╯︵ ┻━┻ ');
                break;
            case 'unflip':
                await sendText(msg + '┬─┬ ノ( ゜-゜ノ)');
                break;
            case 'lenny':
                await sendText(msg + '( ͡° ͜ʖ ͡°)');
                break;
            case 'ping':
                try {
                    const d = await Api.me();
                    barry(`🏓 | Pong! The heartbeat is ${Math.round(d.latency_ms || 0)}ms.`);
                } catch (e) {
                    barry('Could not measure ping.');
                }
                break;
            case 'server': {
                const g = S.guilds.find((x) => x.id === S.guildId);
                if (!g) {
                    barry('This command only works inside a server.');
                    break;
                }
                const members = S.members[g.id] || [];
                const bots = members.filter((m) => m.bot).length;
                const users = members.filter((m) => !m.bot).length;
                const chans = (S.channels[g.id] || []).length;
                const roles = (S.roles[g.id] || []).length;
                barry(
                    [
                        `Here is some info about ${g.name}.`,
                        `Members - ${g.member_count}`,
                        `   Bots - ${bots}`,
                        `   Users - ${users}`,
                        `Channels - ${chans}`,
                        `Roles - ${roles}`,
                        `Server ID - ${g.id}`,
                    ].join('\n')
                );
                break;
            }
            case 'purge': {
                const num = parseInt(args[0], 10);
                if (Number.isNaN(num) || num < 1) {
                    barry('Usage: `/purge <number>` (1-100).', 5000);
                    break;
                }
                $('msgbox').value = '';
                syncMentionBackdrop();
                try {
                    const r = await Api.bulkDelete(S.channel.id, Math.min(num, 100));
                    barry(`Deleted ${r.deleted} message(s).`, 5000);
                    const data = await Api.messages(S.channel.id, { limit: 100 });
                    renderMessages(data.messages || []);
                } catch (e) {
                    errorHandler(e);
                }
                break;
            }
            case 'eval': {
                try {
                    // eslint-disable-next-line no-eval
                    const out = eval(msg);
                    barry(`📥 Eval\n${msg}\n\n📤 Output\n${String(out).slice(0, 1500)}`);
                } catch (err) {
                    barry(`📥 Eval\n${msg}\n\n📤 Output\n${err}`);
                }
                break;
            }
            default:
                await sendText(Fmt.parseSend(text));
                break;
        }
        $('msgbox').value = '';
        syncMentionBackdrop();
    } else {
        await sendText(Fmt.parseSend(text));
        setTimeout(() => {
            $('msgbox').value = '';
            syncMentionBackdrop();
        }, 1);
    }
    return false;
}

async function sendText(content, embed, opts) {
    opts = opts || {};
    if (!S.channel) return;
    const stickerIds = (opts.stickers || []).map(String).filter(Boolean).slice(0, 3);
    if (!content && !embed && !stickerIds.length) return;
    const channel = S.channel;
    const r =
        opts.replyTo !== undefined
            ? opts.replyTo
            : S.replyTo && S.replyTo.channel_id === channel.id
              ? S.replyTo
              : null;
    const mention = opts.mention !== undefined ? opts.mention : S.replyMention;
    // Instant local echo, greyed out until the server confirms it —
    // this is what hides network latency, exactly like Discord.
    const tempId = 'pending-' + Date.now().toString(36) + '-' + ++pendingSeq;
    const temp = makePendingMessage(tempId, channel, content, embed, r);
    if (opts.uploadLabel) temp.uploading = { name: opts.uploadLabel };
    PendingSends.set(tempId, {
        content,
        embed,
        stickers: stickerIds,
        reply: r,
        mention,
        channelId: channel.id,
        msg: temp,
    });
    handleIncomingMessage(temp);
    const node = document.getElementById(tempId);
    if (node) node.classList.add('pending');
    // Discord clears the box the moment you hit enter, not on confirm.
    $('msgbox').value = '';
    syncMentionBackdrop();
    const list = $('message-list');
    list.scrollTop = list.scrollHeight;
    try {
        const res = await Api.sendMessage(channel.id, content, embed || null, {
            reply_to: r ? r.id : null,
            mention_author: mention,
            sticker_ids: stickerIds.length ? stickerIds : null,
        });
        PendingSends.delete(tempId);
        if (!S.channel || S.channel.id !== channel.id) return; // switched away; refresh covers it
        removeMessageDom(tempId);
        if (res.message) {
            // the WS echo may already be here; upsert by id prevents duplicates
            handleIncomingMessage(res.message);
        }
        if (r && S.replyTo && S.replyTo.id === r.id) cancelReply();
        list.scrollTop = list.scrollHeight;
    } catch (e) {
        if (S.channel && S.channel.id === channel.id) markSendFailed(tempId);
        else {
            PendingSends.delete(tempId);
            removeMessageDom(tempId);
        }
        errorHandler(e);
    }
}

/* Drop custom art at resources/icons/{attach,emoji,voice}.svg (or .png,
 * 24px viewBox ideal) and the composer picks it up automatically —
 * otherwise the built-in text glyphs (+ / 😀 / 🎤) are used. */
function setCompIcon(btn, base, fallbackText) {
    btn.innerText = fallbackText;
    const chain = [`/resources/icons/${base}.svg`, `/resources/icons/${base}.png`];
    const attempt = (i) => {
        if (i >= chain.length) return; // keep the glyph fallback
        const img = new Image();
        img.onload = () => {
            if (!btn.isConnected) return;
            btn.innerHTML = '';
            img.className = 'compIconImg';
            img.alt = btn.title || base;
            img.draggable = false;
            btn.appendChild(img);
        };
        img.onerror = () => attempt(i + 1);
        img.src = chain[i];
    };
    try {
        attempt(0);
    } catch (e) {
        /* keep fallback */
    }
}

/* ============ composer: attachments, voice, emoji (Discord-style) ======
 * [+] on the left uploads a file, [🎤] records a voice message, [😀]
 * opens an emoji picker — all wired into the same optimistic pipeline.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function insertAtCursor(text) {
    const box = $('msgbox');
    if (!box) return;
    const s = box.selectionStart != null ? box.selectionStart : box.value.length;
    const e = box.selectionEnd != null ? box.selectionEnd : box.value.length;
    box.value = box.value.slice(0, s) + text + box.value.slice(e);
    const pos = s + String(text).length;
    try {
        box.focus();
        box.setSelectionRange(pos, pos);
    } catch (err) {
        /* ignore */
    }
    syncMentionBackdrop();
    sendTyping();
}

function ensureComposerButtons() {
    const bar = $('messageBar');
    const misc = $('msgMisc');
    if (bar && !$('attachBtn')) {
        // [+] on the left of the message bar
        const plus = document.createElement('button');
        plus.id = 'attachBtn';
        plus.type = 'button';
        plus.title = 'Attach a file';
        setCompIcon(plus, 'attach', '+');
        plus.addEventListener('click', () => {
            if (!S.channel) {
                toast('Select a channel first');
                return;
            }
            const inp = $('fileInput');
            if (inp) inp.click();
        });
        bar.insertBefore(plus, bar.firstChild);
        // hidden picker behind the [+] button
        if (!$('fileInput')) {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.id = 'fileInput';
            inp.className = 'hidden';
            inp.addEventListener('change', () => {
                const f = inp.files && inp.files[0];
                inp.value = '';
                if (f) sendFileMessage(f);
            });
            document.body.appendChild(inp);
        }
    }
    if (misc && !$('emojiBtn')) {
        // emoji + voice on the right, next to the embed icon
        const anchor = $('embedBuilderIcon');
        const emoji = document.createElement('button');
        emoji.id = 'emojiBtn';
        emoji.type = 'button';
        emoji.className = 'compIconBtn';
        emoji.title = 'Emoji';
        setCompIcon(emoji, 'emoji', '😀');
        emoji.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMediaPanel();
        });
        const voice = document.createElement('button');
        voice.id = 'voiceBtn';
        voice.type = 'button';
        voice.className = 'compIconBtn';
        voice.title = 'Record a voice message';
        setCompIcon(voice, 'voice', '🎤');
        voice.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleVoice();
        });
        misc.insertBefore(voice, anchor);
        misc.insertBefore(emoji, voice);
    }
}

async function sendFileMessage(file, opts) {
    opts = opts || {};
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
        errorHandler({ code: 'FILE-TOO-LARGE' });
        return;
    }
    if (!file.size) {
        errorHandler({ code: 'BAD-UPLOAD' });
        return;
    }
    const channel = S.channel;
    const caption =
        opts.caption !== undefined ? opts.caption : $('msgbox').value;
    if (!caption.trim()) {
        // file-only send, like dropping a file into Discord
    }
    const r =
        opts.replyTo !== undefined
            ? opts.replyTo
            : S.replyTo && S.replyTo.channel_id === channel.id
              ? S.replyTo
              : null;
    const mention = opts.mention !== undefined ? opts.mention : S.replyMention;
    const tempId = 'pending-' + Date.now().toString(36) + '-' + ++pendingSeq;
    const temp = makePendingMessage(tempId, channel, caption, null, r);
    temp.uploading = { name: file.name, size: file.size };
    PendingSends.set(tempId, {
        content: caption,
        embed: null,
        file,
        reply: r,
        mention,
        channelId: channel.id,
        msg: temp,
    });
    handleIncomingMessage(temp);
    const node = document.getElementById(tempId);
    if (node) node.classList.add('pending');
    $('msgbox').value = '';
    syncMentionBackdrop();
    const list = $('message-list');
    list.scrollTop = list.scrollHeight;
    try {
        const res = await Api.sendFile(channel.id, {
            file,
            content: caption,
            reply_to: r ? r.id : null,
            mention_author: mention,
        });
        PendingSends.delete(tempId);
        if (!S.channel || S.channel.id !== channel.id) return;
        removeMessageDom(tempId);
        if (res.message) handleIncomingMessage(res.message);
        if (r && S.replyTo && S.replyTo.id === r.id) cancelReply();
        list.scrollTop = list.scrollHeight;
    } catch (e) {
        if (S.channel && S.channel.id === channel.id) markSendFailed(tempId);
        else {
            PendingSends.delete(tempId);
            removeMessageDom(tempId);
        }
        errorHandler(e);
    }
}

/* ---- media panel: Emojis | GIFs | Stickers (Discord-style) ----
 * Emoji tab: frequently used + unicode catalog + per-server custom emoji.
 * GIF tab: Tenor trending/search (needs BOTCORD_TENOR_KEY server-side).
 * Sticker tab: per-server guild stickers. Each tab has its own search. */

const MediaPanel = { tab: 'emoji', q: { emoji: '', gif: '', sticker: '' } };
const StickerCache = {}; // gid -> [sticker]
const GuildEmojiCache = {}; // gid -> [emoji]
const GifState = { items: [], next: '', loading: false, q: null, trending: null };
let guildMediaLoading = null;

function customEmojiTag(e) {
    return e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
}

// Unicode catalog from vendor-converter's idToUni table: [{name, char}].
let UniEmojiList = null;
function uniEmojiList() {
    if (UniEmojiList) return UniEmojiList;
    UniEmojiList = [];
    try {
        const table = typeof idToUni !== 'undefined' ? idToUni : {};
        const seen = new Set();
        Object.keys(table).forEach((name) => {
            const ch = table[name];
            if (!ch || seen.has(ch)) return;
            seen.add(ch);
            UniEmojiList.push({ name, char: ch });
        });
    } catch (e) {
        /* ignore */
    }
    return UniEmojiList;
}

// Usage stats for the media panel's Recent sections (emojis + stickers).
// Values are {c: use count, t: last-used timestamp}; plain numbers from
// older builds are upgraded on read.
function freqGet() {
    try {
        const raw = JSON.parse(localStorage.getItem('botcord.freqEmoji') || '{}');
        const out = {};
        Object.keys(raw || {}).forEach((k) => {
            const v = raw[k];
            out[k] = typeof v === 'number' ? { c: v, t: 0 } : v;
        });
        return out;
    } catch (e) {
        return {};
    }
}

function freqBump(key) {
    try {
        const m = freqGet();
        const prev = m[key] || { c: 0, t: 0 };
        m[key] = { c: (prev.c || 0) + 1, t: Date.now() };
        const top = Object.keys(m)
            .sort((a, b) => (m[b].t || 0) - (m[a].t || 0) || (m[b].c || 0) - (m[a].c || 0))
            .slice(0, 60);
        const trimmed = {};
        top.forEach((k) => {
            trimmed[k] = m[k];
        });
        localStorage.setItem('botcord.freqEmoji', JSON.stringify(trimmed));
    } catch (e) {
        /* ignore */
    }
}

// Most-recently-used keys starting with `prefix` ('u:'/'c:'/'s:'), newest first.
function freqRecent(prefix, limit) {
    try {
        const m = freqGet();
        return Object.keys(m)
            .filter((k) => k.startsWith(prefix))
            .sort((a, b) => (m[b].t || 0) - (m[a].t || 0) || (m[b].c || 0) - (m[a].c || 0))
            .slice(0, limit || 24);
    } catch (e) {
        return [];
    }
}

function findCustomEmoji(id) {
    try {
        return (S.emojis || []).find((e) => String(e.id) === String(id)) || null;
    } catch (e) {
        return null;
    }
}

function findStickerById(id) {
    try {
        id = String(id);
        const pools = Object.values(StickerCache || {});
        for (const arr of pools) {
            const hit = (arr || []).find((s) => String(s.id) === id);
            if (hit) return hit;
        }
    } catch (e) {
        /* ignore */
    }
    return null;
}

function allStickersFlat() {
    const out = [];
    const seen = new Set();
    try {
        Object.values(StickerCache || {}).forEach((arr) => {
            (arr || []).forEach((s) => {
                const id = String((s && s.id) || '');
                if (!id || seen.has(id)) return;
                seen.add(id);
                out.push(s);
            });
        });
    } catch (e) {
        /* ignore */
    }
    return out;
}

// Merge one guild's fresh emoji list into the cache + flat list (shared by
// the startup fetch and the live guild_emojis_update handler).
function mergeGuildEmojis(gid, list) {
    gid = String(gid || '');
    list = list || [];
    try {
        GuildEmojiCache[gid] = list;
        const ids = new Set(list.map((e) => String(e.id)));
        S.emojis = (S.emojis || []).filter(
            (e) => String(e.guild_id || '') !== gid || ids.has(String(e.id))
        );
        const have = new Set((S.emojis || []).map((e) => String(e.id)));
        list.forEach((e) => {
            if (!have.has(String(e.id))) {
                S.emojis.push(e);
                have.add(String(e.id));
            }
        });
        refreshLookup();
    } catch (e) {
        /* never break live updates */
    }
}

function mergeGuildStickers(gid, list) {
    gid = String(gid || '');
    list = list || [];
    try {
        StickerCache[gid] = list;
    } catch (e) {
        /* never break live updates */
    }
}

// Fetch every server's emojis + stickers once (background, best-effort) and
// merge them into the caches + flat list. `force` refetches even cached
// guilds. Called at startup and when the media panel opens.
async function ensureGuildMedia(force) {
    if (guildMediaLoading) {
        try {
            await guildMediaLoading;
        } catch (e) {
            /* ignore */
        }
        return;
    }
    const need = (S.guilds || []).filter(
        (g) => force || !GuildEmojiCache[g.id] || !StickerCache[g.id]
    );
    if (!need.length) return;
    guildMediaLoading = (async () => {
        await Promise.all(
            need.map(async (g) => {
                try {
                    const [em, st] = await Promise.all([
                        Api.guildEmojis(g.id).catch(() => null),
                        Api.guildStickers(g.id).catch(() => null),
                    ]);
                    // null = request failed: leave the cache untouched so the
                    // next open retries instead of showing an empty section
                    if (em && Array.isArray(em.emojis)) {
                        mergeGuildEmojis(g.id, em.emojis);
                    }
                    if (st && Array.isArray(st.stickers)) {
                        mergeGuildStickers(g.id, st.stickers);
                    }
                } catch (e) {
                    /* per-guild failure is non-fatal */
                    try {
                        console.warn('guild media fetch failed for', g.id, e);
                    } catch (err) {
                        /* ignore */
                    }
                }
            })
        );
        try {
            refreshLookup();
        } catch (e) {
            /* ignore */
        }
    })();
    try {
        await guildMediaLoading;
    } finally {
        guildMediaLoading = null;
    }
}

function closeMediaPanel() {
    const p = $('mediaPanel');
    if (p) p.remove();
}

function toggleMediaPanel(forceTab) {
    const old = $('mediaPanel');
    closeEmojiPicker();
    if (old) {
        const was = MediaPanel.tab;
        old.remove();
        if (!forceTab || forceTab === was) return;
    }
    openMediaPanel(forceTab || MediaPanel.tab || 'emoji');
}

function openMediaPanel(tab) {
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    closeMediaPanel();
    MediaPanel.tab = tab;
    const panel = el('div', '');
    panel.id = 'mediaPanel';
    // search (per-tab memory, like Discord)
    const search = document.createElement('input');
    search.id = 'mediaSearch';
    search.autocomplete = 'off';
    search.spellcheck = false;
    search.value = MediaPanel.q[tab] || '';
    search.addEventListener('input', () => {
        MediaPanel.q[MediaPanel.tab] = search.value;
        if (MediaPanel.tab === 'gif') {
            gifSearchSoon(search.value);
        } else {
            renderMediaPane();
        }
    });
    search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && MediaPanel.tab === 'gif') {
            e.preventDefault();
            gifSearchNow(search.value);
        }
        if (e.key === 'Escape') closeMediaPanel();
    });
    search.addEventListener('click', (e) => e.stopPropagation());
    panel.appendChild(search);
    // tabs
    const tabs = el('div', 'mediaTabs');
    [
        ['emoji', 'Emojis'],
        ['gif', 'GIFs'],
        ['sticker', 'Stickers'],
    ].forEach(([key, label]) => {
        const b = el('button', 'mediaTab' + (key === tab ? ' active' : ''), label);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (MediaPanel.tab === key) return;
            MediaPanel.tab = key;
            const s = $('mediaSearch');
            if (s) {
                s.value = MediaPanel.q[key] || '';
                s.placeholder = searchPlaceholder(key);
            }
            renderMediaTabs();
            renderMediaPane();
        });
        tabs.appendChild(b);
    });
    const refresh = el('button', 'mediaRefresh', '↻');
    refresh.title = 'Refresh emojis & stickers';
    refresh.addEventListener('click', (e) => {
        e.stopPropagation();
        refresh.classList.add('spinning');
        ensureGuildMedia(true)
            .catch(() => {})
            .finally(() => {
                try {
                    refresh.classList.remove('spinning');
                } catch (err) {
                    /* ignore */
                }
                if ($('mediaPanel')) renderMediaPane();
            });
    });
    tabs.appendChild(refresh);
    panel.appendChild(tabs);
    const body = el('div', '');
    body.id = 'mediaBody';
    panel.appendChild(body);
    document.body.appendChild(panel);
    // anchor above the message bar, like Discord's picker
    try {
        const bar = $('messageBar');
        if (bar) {
            const r = bar.getBoundingClientRect();
            panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
            panel.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
        }
    } catch (e) {
        /* default CSS position applies */
    }
    search.placeholder = searchPlaceholder(tab);
    renderMediaPane();
    setTimeout(() => {
        document.addEventListener('click', function h(ev) {
            const p = $('mediaPanel');
            if (!p || (!p.contains(ev.target) && !(ev.target.closest && ev.target.closest('#emojiBtn')))) {
                closeMediaPanel();
                document.removeEventListener('click', h);
            }
        });
    }, 0);
    // guild media in the background; re-paint when it lands
    ensureGuildMedia().then(() => {
        if ($('mediaPanel')) renderMediaPane();
    });
}

function searchPlaceholder(tab) {
    if (tab === 'gif') return 'Search Tenor GIFs';
    if (tab === 'sticker') return 'Search stickers';
    return 'Search emojis';
}

function renderMediaTabs() {
    const tabs = document.querySelectorAll('#mediaPanel .mediaTab');
    tabs.forEach((b) => {
        const isActive =
            (b.innerText === 'Emojis' && MediaPanel.tab === 'emoji') ||
            (b.innerText === 'GIFs' && MediaPanel.tab === 'gif') ||
            (b.innerText === 'Stickers' && MediaPanel.tab === 'sticker');
        b.classList.toggle('active', isActive);
    });
}

function renderMediaPane() {
    const body = $('mediaBody');
    if (!body) return;
    body.innerHTML = '';
    if (MediaPanel.tab === 'gif') renderGifPane(body);
    else if (MediaPanel.tab === 'sticker') renderStickerPane(body);
    else renderEmojiPane(body);
}

function mediaSection(body, title, iconUrl) {
    const h = el('div', 'mediaSectionTitle');
    if (iconUrl) {
        const img = el('img', 'mediaSectionIcon');
        img.src = iconUrl;
        img.loading = 'lazy';
        h.appendChild(img);
    }
    h.appendChild(el('span', '', title));
    body.appendChild(h);
    const grid = el('div', 'mediaGrid');
    body.appendChild(grid);
    return grid;
}

/* ---- emoji tab ---- */

function pickUnicodeEmoji(ch) {
    insertAtCursor(ch);
    freqBump('u:' + ch);
}

function pickCustomEmoji(e) {
    insertAtCursor(customEmojiTag(e));
    freqBump('c:' + e.id);
}

function renderEmojiPane(body) {
    const q = (MediaPanel.q.emoji || '').trim().toLowerCase();
    if (q) {
        const grid = mediaSection(body, 'Search results');
        let n = 0;
        uniEmojiList().forEach((u) => {
            if (n >= 60) return;
            if (!u.name.includes(q)) return;
            const b = el('div', 'emojiPick', u.char);
            b.title = `:${u.name}:`;
            b.addEventListener('click', () => pickUnicodeEmoji(u.char));
            grid.appendChild(b);
            n++;
        });
        (S.emojis || []).forEach((e) => {
            if (n >= 80) return;
            if (!String(e.name || '').toLowerCase().includes(q)) return;
            grid.appendChild(customEmojiCell(e));
            n++;
        });
        if (!n) body.appendChild(el('div', 'mediaEmpty', 'No emojis match.'));
        return;
    }
    // recently used (unicode + custom)
    const recentKeys = freqRecent('u:', 24).concat(freqRecent('c:', 24));
    recentKeys.sort((a, b) => {
        let ta = 0;
        let tb = 0;
        try {
            const m = freqGet();
            ta = (m[a] && m[a].t) || 0;
            tb = (m[b] && m[b].t) || 0;
        } catch (e) {
            /* ignore */
        }
        return tb - ta;
    });
    if (recentKeys.length) {
        const grid = mediaSection(body, 'Recent');
        recentKeys.slice(0, 24).forEach((k) => {
            if (k.startsWith('u:')) {
                const ch = k.slice(2);
                const b = el('div', 'emojiPick', ch);
                b.title = ch;
                b.addEventListener('click', () => pickUnicodeEmoji(ch));
                grid.appendChild(b);
            } else if (k.startsWith('c:')) {
                const e = findCustomEmoji(k.slice(2));
                if (e) grid.appendChild(customEmojiCell(e));
            }
        });
    }
    // every server's custom emoji (all guilds, not just the open one)
    (S.guilds || []).forEach((g) => {
        const list = GuildEmojiCache[g.id] !== undefined ? GuildEmojiCache[g.id] : (S.emojis || []).filter((e) => String(e.guild_id || '') === String(g.id));
        if (!list.length) return;
        const grid = mediaSection(body, g.name || 'Server', g.icon);
        list.forEach((e) => grid.appendChild(customEmojiCell(e)));
    });
    // default unicode catalog always last
    const ugrid = mediaSection(body, 'Emoji');
    uniEmojiList().forEach((u) => {
        const b = el('div', 'emojiPick', u.char);
        b.title = `:${u.name}:`;
        b.addEventListener('click', () => pickUnicodeEmoji(u.char));
        ugrid.appendChild(b);
    });
}

function customEmojiCell(e) {
    const b = el('div', 'emojiPick customPick');
    b.title = `:${e.name}:`;
    const img = el('img', 'emojiPickImg');
    img.src = e.url;
    img.alt = e.name;
    img.loading = 'lazy';
    b.appendChild(img);
    b.addEventListener('click', () => pickCustomEmoji(e));
    return b;
}

/* ---- GIF tab (Tenor) ---- */

let gifDebounce = null;

function gifSearchSoon(q) {
    if (gifDebounce) clearTimeout(gifDebounce);
    gifDebounce = setTimeout(() => gifSearchNow(q), 450);
}

async function gifSearchNow(q) {
    q = (q || '').trim();
    MediaPanel.q.gif = q;
    if (!q) {
        GifState.q = null;
        renderMediaPane();
        return;
    }
    GifState.loading = true;
    GifState.q = q;
    GifState.items = [];
    GifState.next = '';
    renderMediaPane();
    try {
        const res = await Api.tenorSearch(q);
        if (MediaPanel.tab !== 'gif' || MediaPanel.q.gif.trim() !== q) return; // stale
        GifState.items = (res && res.gifs) || [];
        GifState.next = (res && res.next) || '';
    } catch (e) {
        GifState.items = [];
        GifState.next = '';
        GifState.error = (e && e.code) || 'TENOR-FAILED';
    } finally {
        GifState.loading = false;
        if ($('mediaPanel') && MediaPanel.tab === 'gif') renderMediaPane();
    }
}

async function gifLoadMore() {
    if (GifState.loading || !GifState.next) return;
    GifState.loading = true;
    renderMediaPane();
    try {
        const res = await Api.tenorSearch(GifState.q || '', GifState.next);
        if (MediaPanel.tab !== 'gif') return;
        GifState.items = GifState.items.concat((res && res.gifs) || []);
        GifState.next = (res && res.next) || '';
    } catch (e) {
        /* keep what we have */
    } finally {
        GifState.loading = false;
        if ($('mediaPanel') && MediaPanel.tab === 'gif') renderMediaPane();
    }
}

async function gifEnsureTrending() {
    if (GifState.trending || GifState.loading) return;
    GifState.loading = true;
    try {
        const res = await Api.tenorTrending();
        GifState.trending = (res && res.gifs) || [];
        GifState.trendingError = null;
    } catch (e) {
        GifState.trending = [];
        GifState.trendingError = (e && e.code) || 'TENOR-FAILED';
    } finally {
        GifState.loading = false;
    }
}

function renderGifPane(body) {
    const q = (MediaPanel.q.gif || '').trim();
    if (!q && !GifState.trending && !GifState.trendingError) {
        body.appendChild(el('div', 'mediaSpinner', 'Loading…'));
        gifEnsureTrending().then(() => {
            if ($('mediaPanel') && MediaPanel.tab === 'gif') renderMediaPane();
        });
        return;
    }
    const items = q ? GifState.items : GifState.trending || [];
    const err = q ? GifState.error : GifState.trendingError;
    if (err === 'TENOR-NOT-CONFIGURED') {
        const note = el('div', 'mediaNotice');
        note.innerHTML =
            'GIFs need a free Tenor API key.<br><br>Set <code>BOTCORD_TENOR_KEY</code> ' +
            'where <code>server.py</code> runs and restart it.<br>' +
            'Get one at <b>developers.google.com/tenor</b> (Guides → Quickstart).';
        body.appendChild(note);
        return;
    }
    if (GifState.loading && !items.length) {
        body.appendChild(el('div', 'mediaSpinner', 'Loading…'));
        return;
    }
    if (err && !items.length) {
        const note = el('div', 'mediaNotice');
        note.appendChild(el('div', '', 'GIF search failed — try again in a moment.'));
        const retry = el('button', 'settingsUpdateBtn', 'Retry');
        retry.addEventListener('click', () => {
            GifState.error = null;
            GifState.trendingError = null;
            renderMediaPane();
        });
        note.appendChild(retry);
        body.appendChild(note);
        return;
    }
    if (!items.length) {
        body.appendChild(el('div', 'mediaEmpty', q ? 'No GIFs found.' : 'No trending GIFs right now.'));
        return;
    }
    const grid = el('div', 'gifGrid');
    items.forEach((g) => {
        const cell = el('div', 'gifCell');
        cell.title = g.title || 'GIF';
        const img = el('img', 'gifThumb');
        img.src = g.preview_url || g.gif_url;
        img.alt = g.title || 'GIF';
        img.loading = 'lazy';
        cell.appendChild(img);
        cell.addEventListener('click', () => sendGif(g.gif_url || g.page_url));
        grid.appendChild(cell);
    });
    body.appendChild(grid);
    if (GifState.loading) body.appendChild(el('div', 'mediaSpinner', 'Loading…'));
    else if (q && GifState.next) {
        const more = el('button', 'settingsUpdateBtn', 'Load more');
        more.addEventListener('click', gifLoadMore);
        body.appendChild(more);
    }
}

async function sendGif(gifUrl) {
    if (!gifUrl) return;
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    closeMediaPanel();
    await sendText(gifUrl, null, {});
}

/* ---- sticker tab ---- */

function renderStickerPane(body) {
    const q = (MediaPanel.q.sticker || '').trim().toLowerCase();
    if (q) {
        const grid = mediaSection(body, 'Search results');
        let n = 0;
        allStickersFlat().forEach((s) => {
            if (n >= 60) return;
            if (!String(s.name || '').toLowerCase().includes(q)) return;
            grid.appendChild(stickerCell(s));
            n++;
        });
        if (!n) body.appendChild(el('div', 'mediaEmpty', 'No stickers match.'));
        return;
    }
    let any = false;
    // recently used stickers
    const recentIds = freqRecent('s:', 12);
    if (recentIds.length) {
        const grid = mediaSection(body, 'Recent');
        recentIds.forEach((k) => {
            const s = findStickerById(k.slice(2));
            if (s) {
                grid.appendChild(stickerCell(s));
                any = true;
            }
        });
    }
    // every server's stickers (all guilds, not just the open one)
    (S.guilds || []).forEach((g) => {
        const list = StickerCache[g.id] !== undefined ? StickerCache[g.id] : [];
        if (!list.length) return;
        any = true;
        const grid = mediaSection(body, g.name || 'Server', g.icon);
        list.forEach((s) => grid.appendChild(stickerCell(s)));
    });
    if (!any) {
        body.appendChild(
            el('div', 'mediaEmpty', 'No guild stickers — add some in Server Settings → Stickers.')
        );
    }
}

function stickerCell(s) {
    const b = el('div', 'stickerCell');
    b.title = s.name || 'sticker';
    if (s.url) {
        const img = el('img', 'stickerThumb');
        img.src = s.url;
        img.alt = s.name || 'sticker';
        img.loading = 'lazy';
        b.appendChild(img);
    } else {
        b.appendChild(el('div', 'stickerLottieBadge', '🎭'));
    }
    b.addEventListener('click', () => sendSticker(s.id, s.name));
    return b;
}

async function sendSticker(stickerId, name) {
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    try {
        freqBump('s:' + String(stickerId));
    } catch (e) {
        /* ignore */
    }
    closeMediaPanel();
    await sendText('', null, {
        stickers: [String(stickerId)],
        uploadLabel: `sticker: ${name || ''}`.trim(),
    });
}

/* ---- voice messages ---- */

let voiceRec = null; // {rec, chunks, stream, timer, startedAt, mime}

function pickVoiceMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
        return '';
    }
    const cands = [
        'audio/ogg;codecs=opus',
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
    ];
    for (const c of cands) {
        try {
            if (MediaRecorder.isTypeSupported(c)) return c;
        } catch (e) {
            /* ignore */
        }
    }
    return '';
}

function voiceExt(mime) {
    if (String(mime).includes('ogg')) return '.ogg';
    if (String(mime).includes('mp4')) return '.m4a';
    return '.webm';
}

function ensureVoiceBar() {
    if ($('voiceBar')) return;
    const sendmsg = $('sendmsg');
    const bar = $('messageBar');
    if (!sendmsg || !bar) return;
    const v = document.createElement('div');
    v.id = 'voiceBar';
    v.className = 'hidden';
    const dot = el('span', 'recDot');
    const timer = el('span', 'recTimer', '0:00');
    timer.id = 'recTimer';
    const stop = el('button', 'recStop', 'Stop & send');
    stop.addEventListener('click', () => stopVoice(true));
    const cancel = el('button', 'recCancel', '✕');
    cancel.title = 'Discard recording';
    cancel.addEventListener('click', () => stopVoice(false));
    v.appendChild(dot);
    v.appendChild(el('span', '', 'Recording'));
    v.appendChild(timer);
    v.appendChild(stop);
    v.appendChild(cancel);
    sendmsg.insertBefore(v, bar);
}

function voiceTick() {
    const t = $('recTimer');
    if (!t || !voiceRec) return;
    const s = Math.floor((Date.now() - voiceRec.startedAt) / 1000);
    t.innerText = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 300) stopVoice(true); // 5 min cap
}

async function toggleVoice() {
    if (voiceRec) {
        stopVoice(true);
        return;
    }
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia ||
        typeof MediaRecorder === 'undefined'
    ) {
        toast('Voice messages are not supported in this browser');
        return;
    }
    const mime = pickVoiceMime();
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        voiceRec = {
            rec,
            chunks: [],
            stream,
            mime: rec.mimeType || mime,
            startedAt: Date.now(),
            timer: null,
        };
        rec.ondataavailable = (ev) => {
            if (ev.data && ev.data.size) voiceRec.chunks.push(ev.data);
        };
        rec.onstop = () => {
            const cur = voiceRec;
            voiceRec = null;
            const bar = $('voiceBar');
            if (bar) bar.classList.add('hidden');
            try {
                cur.stream.getTracks().forEach((tr) => tr.stop());
            } catch (e) {
                /* ignore */
            }
            if (cur.send && cur.chunks.length) {
                const type = cur.mime || 'audio/webm';
                const blob = new Blob(cur.chunks, { type });
                const file = new File([blob], 'voice-message' + voiceExt(type), { type });
                sendFileMessage(file, { caption: '' });
            }
        };
        rec.start(250);
        ensureVoiceBar();
        $('voiceBar').classList.remove('hidden');
        voiceTick();
        voiceRec.timer = setInterval(voiceTick, 500);
    } catch (e) {
        voiceRec = null;
        toast('Microphone blocked — allow access to record');
    }
}

function stopVoice(send) {
    if (!voiceRec) return;
    if (voiceRec.timer) {
        try {
            clearInterval(voiceRec.timer);
        } catch (e) {
            /* ignore */
        }
    }
    voiceRec.send = !!send;
    try {
        voiceRec.rec.stop();
    } catch (e) {
        voiceRec = null;
        const bar = $('voiceBar');
        if (bar) bar.classList.add('hidden');
    }
}

/* ---- optimistic (client-sided) sends ---- */

let pendingSeq = 0;
const PendingSends = new Map(); // tempId -> {content, embed, reply, mention, channelId, msg}

function isPendingId(id) {
    return typeof id === 'string' && id.indexOf('pending-') === 0;
}

function makePendingMessage(tempId, channel, content, embed, reply) {
    const me = S.me || {
        id: 'me',
        username: '?',
        global_name: null,
        discriminator: '0',
        avatar: null,
        bot: true,
    };
    return {
        id: tempId,
        channel_id: channel.id,
        guild_id: channel.guild_id || null,
        author: {
            id: String(me.id),
            username: me.username,
            global_name: me.global_name,
            discriminator: me.discriminator,
            avatar: me.avatar,
            bot: true,
        },
        member: null,
        content: content || '',
        clean_content: content || '',
        mentions: { users: [], roles: [], channels: [] },
        mention_everyone: false,
        embeds: embed ? [embed] : [],
        attachments: [],
        reactions: [],
        components: [],
        flags: 0,
        is_components_v2: false,
        poll: null,
        reference: reply
            ? {
                  message_id: String(reply.id),
                  channel_id: String(channel.id),
                  guild_id: channel.guild_id || null,
              }
            : null,
        timestamp: new Date().toISOString(),
        edited_timestamp: null,
        pinned: false,
        tts: false,
        pending: true,
        failed: false,
    };
}

function markSendFailed(tempId) {
    const p = PendingSends.get(tempId);
    if (p && p.msg) p.msg.failed = true;
    const node = document.getElementById(tempId);
    if (!node) return;
    node.classList.remove('pending');
    node.classList.add('failed');
    node.title = 'Not delivered — click to retry';
    node.addEventListener('click', (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('a')) return;
        retrySend(tempId);
    });
}

async function retrySend(tempId) {
    const p = PendingSends.get(tempId);
    if (!p) return;
    if (!S.channel || String(S.channel.id) !== String(p.channelId)) {
        toast('Switch back to that channel to retry');
        return;
    }
    removeMessageDom(tempId);
    PendingSends.delete(tempId);
    if (p.file) {
        await sendFileMessage(p.file, {
            caption: p.content,
            replyTo: p.reply,
            mention: p.mention,
        });
        return;
    }
    await sendText(p.content, p.embed, {
        replyTo: p.reply,
        mention: p.mention,
        stickers: p.stickers || [],
        uploadLabel: p.msg && p.msg.uploading ? p.msg.uploading.name : undefined,
    });
}

/* ============================ incoming events ============================ */

function handleIncomingMessage(m) {
    if (!m || !m.id) return;
    if (S.channel && m.channel_id === S.channel.id) {
        if ($(m.id)) {
            updateMessageDom(m);
        } else {
            const blocks = document.querySelectorAll('#message-list .messageBlock');
            let prev = null;
            if (blocks.length) {
                const last = blocks[blocks.length - 1];
                if (last.dataset.authorId === m.author.id) {
                    // group with the previous message if same author + recent
                    prev = { author: { id: last.dataset.authorId }, timestamp: new Date().toISOString() };
                }
                // day divider for live messages crossing midnight, like history
                if (last.dataset.timestamp && !sameDay(last.dataset.timestamp, m.timestamp)) {
                    $('message-list').appendChild(daySeparator(m.timestamp));
                }
            } else if (m.timestamp) {
                // first message in an empty view still gets its day label
                $('message-list').appendChild(daySeparator(m.timestamp));
            }
            appendMessage(m, prev);
        }
        const list = $('message-list');
        const nearBottom = list.scrollHeight - Math.floor(list.scrollTop) - list.clientHeight < 200;
        if (nearBottom) list.scrollTop = list.scrollHeight;
    } else if (S.guildId && m.guild_id === S.guildId) {
        const div = $(m.channel_id);
        if (div) div.classList.add('newMsg');
    }
}

/* ============================= context menus ============================= */

function closeRcMenu() {
    const rc = $('rcMenu');
    rc.innerHTML = '';
    rc.style.display = 'none';
}

function openRcMenu(x, y, items) {
    const rc = $('rcMenu');
    rc.innerHTML = '';
    items.forEach((it, i) => {
        if (it.break) {
            rc.appendChild(el('hr'));
            return;
        }
        const opt = el('div', 'rcOption', it.label);
        if (it.danger) opt.classList.add('rcDanger');
        opt.addEventListener('click', () => {
            closeRcMenu();
            it.fn && it.fn();
        });
        rc.appendChild(opt);
    });
    rc.style.display = 'block';
    const r = rc.getBoundingClientRect();
    rc.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    rc.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

function messageContextMenu(e, m) {
    // Client-sided pending message: no server actions make sense yet.
    if (isPendingId(m.id)) {
        if (m.failed) {
            openRcMenu(e.clientX, e.clientY, [
                { label: 'Retry send', fn: () => retrySend(m.id) },
                {
                    label: 'Delete',
                    danger: true,
                    fn: () => {
                        PendingSends.delete(m.id);
                        removeMessageDom(m.id);
                    },
                },
                { break: true },
                { label: 'Copy content', fn: () => copyText(m.content || '', 'Message') },
            ]);
        } else {
            toast('Still sending…');
        }
        return;
    }
    const own = S.me && m.author.id === S.me.id;
    const items = [
        { label: 'Reply', fn: () => startReply(m) },
        { label: 'Copy content', fn: () => copyText(m.content || '', 'Message') },
        { label: 'Copy message ID', fn: () => copyText(m.id, 'Message ID') },
        {
            label: 'Copy link',
            fn: () => {
                const gid = m.guild_id ? `${m.guild_id}/` : '@me/';
                copyText(`https://discord.com/channels/${gid}${m.channel_id}/${m.id}`, 'Link');
            },
        },
        { label: 'Mention author', fn: () => insertMention(m.author.id) },
        {
            label: 'Add reaction…',
            fn: () => openEmojiPicker(e.clientX, e.clientY, m),
        },
        { break: true },
    ];
    if (own) {
        items.push({ label: 'Edit message', fn: () => inlineEdit(m) });
        items.push({ label: 'Delete message', danger: true, fn: () => deleteMessage(m) });
    } else {
        items.push({ label: 'Delete message', danger: true, fn: () => deleteMessage(m) });
    }
    items.push({ label: m.pinned ? 'Unpin message' : 'Pin message', fn: () => togglePin(m) });
    openRcMenu(e.clientX, e.clientY, items);
}

function userContextMenu(e, u) {
    openRcMenu(e.clientX, e.clientY, [
        { label: `Message @${u.global_name || u.username || u.id}`, fn: () => openDMWith(u.id) },
        { label: `Mention @${u.username || u.global_name || u.id}`, fn: () => insertMention(u.id) },
        { label: `Copy user ID (${u.id})`, fn: () => copyText(String(u.id), 'User ID') },
        ...(u.avatar ? [{ label: 'Copy avatar URL', fn: () => copyText(u.avatar, 'Avatar URL') }] : []),
    ]);
}

async function deleteMessage(m) {
    try {
        await Api.deleteMessage(m.channel_id, m.id);
        removeMessageDom(m.id);
    } catch (e) {
        errorHandler(e);
    }
}

async function togglePin(m) {
    try {
        if (m.pinned) await Api.unpinMessage(m.channel_id, m.id);
        else await Api.pinMessage(m.channel_id, m.id);
        toast(m.pinned ? 'Unpinned' : 'Pinned');
    } catch (e) {
        errorHandler(e);
    }
}

function inlineEdit(m) {
    const node = $(m.id);
    if (!node) return;
    const textP = node.querySelector('.messageText');
    if (!textP) return;
    const ta = document.createElement('textarea');
    ta.value = m.content || '';
    ta.className = 'editTextarea';
    ta.style.width = '100%';
    textP.replaceWith(ta);
    ta.focus();
    const save = async () => {
        const content = ta.value;
        try {
            const res = await Api.editMessage(m.channel_id, m.id, content);
            m.content = res.message.content;
            m.clean_content = res.message.clean_content;
            m.edited_timestamp = res.message.edited_timestamp;
            updateMessageDom(m);
        } catch (e) {
            errorHandler(e);
            updateMessageDom(m);
        }
    };
    ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            save();
        } else if (ev.key === 'Escape') {
            updateMessageDom(m);
        }
    });
    ta.addEventListener('blur', () => updateMessageDom(m));
}

/* ============================ embed builder ============================== */

function openEmbedModal() {
    if (!S.channel) {
        toast('Select a channel first');
        return;
    }
    $('embedModal').classList.remove('hidden');
}

function closeEmbedModal() {
    $('embedModal').classList.add('hidden');
}

async function sendEmbedModal() {
    const title = $('embedTitle').value.trim();
    const desc = $('embedDesc').value.trim();
    const url = $('embedUrl').value.trim();
    const colorRaw = $('embedColor').value.trim().replace('#', '');
    const footer = $('embedFooter').value.trim();
    if (!title && !desc) {
        toast('Embed needs a title or description');
        return;
    }
    const embed = { type: 'rich' };
    if (title) embed.title = title;
    if (desc) embed.description = desc;
    if (url) embed.url = url;
    if (/^[0-9a-fA-F]{6}$/.test(colorRaw)) embed.color = parseInt(colorRaw, 16);
    if (footer) embed.footer = { text: footer };
    closeEmbedModal();
    await sendText('', embed);
    $('embedTitle').value = '';
    $('embedDesc').value = '';
    $('embedUrl').value = '';
    $('embedColor').value = '';
    $('embedFooter').value = '';
}

/* ============================ socket wiring ============================== */

function wireSocket() {
    Api.on('socket_state', ({ state }) => {
        if (state === 'open') {
            if (S.me) {
                setConn('online', 'online');
                refreshLatency();
            } else setConn('connecting', 'connecting');
        } else if (state === 'closed') {
            setConn('closed', 'reconnecting');
        }
    });
    Api.on('hello', (d) => {
        if (d.connected && d.user && !S.me) {
            // server already has a session (e.g. page reloaded mid-session)
            S.me = d.user;
            clearSelectMember();
            bootstrap();
        }
    });
    Api.on('ready', () => {
        /* login flow already handles this */
    });
    Api.on('message_create', handleIncomingMessage);
    Api.on('message_update', (m) => {
        if (S.channel && m.channel_id === S.channel.id) updateMessageDom(m);
    });
    Api.on('message_delete', (d) => {
        if (S.channel && d.channel_id === S.channel.id) removeMessageDom(d.id);
    });
    Api.on('message_delete_bulk', (d) => {
        if (S.channel && d.channel_id === S.channel.id) {
            (d.ids || []).forEach(removeMessageDom);
        }
    });
    Api.on('reaction_add', (d) => patchReactionEvent(d, 'add'));
    Api.on('reaction_remove', (d) => patchReactionEvent(d, 'remove'));
    Api.on('reaction_clear', (d) => patchReactionEvent(d, 'clear'));
    Api.on('reaction_clear_emoji', (d) => patchReactionEvent(d, 'clear_emoji'));
    Api.on('typing_start', (d) => {
        noteTyping(d.channel_id, d.user);
    });
    Api.on('guild_create', (g) => {
        if (!S.guilds.find((x) => x.id === g.id)) {
            S.guilds.push(g);
            renderGuildList();
        }
    });
    Api.on('guild_delete', (d) => {
        S.guilds = S.guilds.filter((x) => x.id !== d.id);
        renderGuildList();
        if (S.guildId === d.id) {
            if (S.guilds.length) selectGuild(S.guilds[0].id);
            else showDMHome();
        }
    });
    Api.on('guild_emojis_update', (d) => {
        if (!d || !d.guild_id) return;
        mergeGuildEmojis(d.guild_id, d.emojis || []);
        if ($('mediaPanel') && MediaPanel.tab === 'emoji') renderMediaPane();
    });
    Api.on('guild_stickers_update', (d) => {
        if (!d || !d.guild_id) return;
        mergeGuildStickers(d.guild_id, d.stickers || []);
        if ($('mediaPanel') && MediaPanel.tab === 'sticker') renderMediaPane();
    });
    Api.on('member_add', (d) => {
        const arr = S.members[d.guild_id] || [];
        if (!arr.find((m) => m.id === d.member.id)) {
            arr.push(d.member);
            refreshLookup();
            if (S.guildId === d.guild_id) {
                const g = S.guilds.find((x) => x.id === d.guild_id);
                if (g) {
                    g.member_count = (g.member_count || 0) + 1;
                    $('members-count').innerText = g.member_count;
                    renderMemberList(g);
                }
            }
        }
    });
    Api.on('member_remove', (d) => {
        const arr = S.members[d.guild_id] || [];
        S.members[d.guild_id] = arr.filter((m) => m.id !== d.user_id);
        refreshLookup();
        if (S.guildId === d.guild_id) {
            const g = S.guilds.find((x) => x.id === d.guild_id);
            if (g) {
                g.member_count = Math.max(0, (g.member_count || 1) - 1);
                $('members-count').innerText = g.member_count;
                renderMemberList(g);
            }
        }
    });
    Api.on('presence_update', (d) => {
        const arr = S.members[d.guild_id] || [];
        const m = arr.find((x) => x.id === d.user_id);
        if (m) {
            m.status = d.status;
            refreshLookup();
        }
    });
    Api.on('disconnected', () => {
        setConn('closed', 'offline');
    });
}

/* ================================= init ================================== */

function wireStaticUI() {
    ensureMsgWrap();
    ensureReplyComposer();
    ensureComposerButtons();
    applyTheme(currentTheme());
    loadSettingsIcon();
    $('homeBtn').addEventListener('click', showDMHome);

    const settingsBtn = $('settingsBtn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openSettings();
        });
    }
    const settingsClose = $('settingsClose');
    if (settingsClose) {
        settingsClose.addEventListener('click', (e) => {
            e.stopPropagation();
            closeSettings();
        });
    }
    const settingsModal = $('settingsModal');
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) closeSettings();
        });
    }
    document.querySelectorAll('.themeChoice').forEach((b) => {
        b.addEventListener('click', () => applyTheme(b.dataset.themeValue));
    });
    const logoutBtn = $('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => doLogout());
    }
    const switchBtn = $('switchTokenBtn');
    if (switchBtn) {
        switchBtn.addEventListener('click', () => doSwitchToken());
    }
    const tokenBox = $('tokenInput');
    if (tokenBox) {
        tokenBox.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSwitchToken();
            }
        });
    }
    document.querySelectorAll('.statusPill').forEach((b) => {
        b.addEventListener('click', () => {
            PresenceSel.status = b.dataset.status || 'online';
            paintStatusPills();
        });
    });
    const activitySel = $('activityType');
    if (activitySel) {
        activitySel.addEventListener('change', () => {
            const url = $('streamUrl');
            if (url) url.classList.toggle('hidden', activitySel.value !== 'streaming');
        });
    }
    const presenceBtn = $('savePresenceBtn');
    if (presenceBtn) {
        presenceBtn.addEventListener('click', () => doSavePresence());
    }

    // mobile drawers
    $('chanToggle').addEventListener('click', (e) => {
        e.stopPropagation();
        document.body.classList.toggle('show-channels');
        document.body.classList.remove('show-members');
    });
    $('memberToggle').addEventListener('click', (e) => {
        e.stopPropagation();
        document.body.classList.toggle('show-members');
        document.body.classList.remove('show-channels');
    });

    $('msgbox').addEventListener('keydown', (event) => {
        if (mentionSuggestKey(event)) return;
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            hideMentionSuggest();
            sendCurrent();
            $('sendmsg').style.height = '38px';
            $('sendmsg').style.transform = '';
        }
    });
    $('msgbox').addEventListener('input', () => {
        sendTyping();
        syncMentionBackdrop();
        updateMentionSuggest();
        const textElem = $('msgbox');
        const box = $('sendmsg');
        if (textElem.scrollHeight < 38 * 5) {
            box.style.height = '0px';
            box.style.height = `${textElem.scrollHeight}px`;
            box.style.transform = `translateY(-${textElem.scrollHeight - 38}px)`;
        }
    });
    $('msgbox').addEventListener('click', () => {
        // re-evaluate @ query on caret moves; close list when clicking away
        if (!updateMentionSuggest()) hideMentionSuggest();
    });

    $('clearCache').addEventListener('click', () => {
        store.defaultToken = '';
        store.ui = {};
        $('clearCache').parentElement.innerHTML =
            "<p class='greenText'>Saved data cleared! Now log in again.</p>";
    });

    $('embedBuilderIcon').addEventListener('click', openEmbedModal);
    $('embedCancel').addEventListener('click', closeEmbedModal);
    $('embedSend').addEventListener('click', sendEmbedModal);
    $('embedModal').addEventListener('click', (e) => {
        if (e.target === $('embedModal')) closeEmbedModal();
    });

    document.addEventListener('click', (e) => {
        const rc = $('rcMenu');
        if (rc.style.display === 'block' && !rc.contains(e.target)) closeRcMenu();
        // tapping the chat on mobile dismisses the slide-over drawers
        if (e.target.closest && e.target.closest('#message-list')) {
            document.body.classList.remove('show-channels', 'show-members');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeRcMenu();
            closeEmbedModal();
            closeSettings();
            hideMentionSuggest();
            closeEmojiPicker();
            closeMediaPanel();
            cancelReply();
        }
    });
    document.addEventListener('contextmenu', (e) => {
        // let message/user/channel handlers (with stopPropagation) take precedence
        if (e.defaultPrevented) return;
    });
}

async function init() {
    wireStaticUI();
    wireSocket();
    setConn('connecting', 'connecting');

    // Each browser gets a private session; the server scopes the bot
    // login to it so multiple users never share a connection.
    try {
        await Api.ensureSession();
    } catch (e) {
        if (e && e.code === 'UNAUTHORIZED') {
            const pw = prompt('This Botcord server needs a password:');
            if (pw) {
                localStorage.setItem('botcord.webPassword', pw);
                location.reload();
            } else {
                setLoadingPerc(-1, 'Server password required');
            }
            return;
        }
        setLoadingPerc(
            -1,
            e && e.code === 'SESSION-LIMIT'
                ? 'The server is full right now — try again in a few minutes'
                : 'Could not reach the Python host. Is server.py running?'
        );
        return;
    }
    Api.connect();

    // site/server contract check: a stale server.py or cached site hangs
    // the loader in confusing ways — fail loudly instead
    try {
        const v = await Api.version();
        if (!v || v.version !== CLIENT_VERSION) throw { code: 'VERSION-MISMATCH' };
    } catch (e) {
        if (e && (e.code === 'VERSION-MISMATCH' || e.status === 404)) {
            setLoadingPerc(
                -1,
                'Site and server are out of sync — restart server.py and hard-refresh (Ctrl+Shift+R)'
            );
            return;
        }
        // version endpoint hiccup alone shouldn't block login
        console.warn('version check failed', e);
    }

    // already logged in on the server? (page reload keeps the session)
    try {
        const st = await Api.status();
        if (st.connected && st.user) {
            S.me = st.user;
            S.owner = st.owner;
            clearSelectMember();
            await bootstrap();
            return;
        }
    } catch (e) {
        if (e && e.code === 'UNAUTHORIZED') {
            const pw = prompt('This Botcord server needs a password:');
            if (pw) {
                localStorage.setItem('botcord.webPassword', pw);
                location.reload();
            } else {
                setLoadingPerc(-1, 'Server password required');
            }
            return;
        }
        // server unreachable — still show the login screen; errors surface on login
        console.warn('status check failed', e);
    }

    if (store.defaultToken) {
        await doLogin(store.defaultToken, true);
    } else {
        buildSplashToken();
    }

    setInterval(refreshLatency, 30000);
}

document.addEventListener('DOMContentLoaded', init);
