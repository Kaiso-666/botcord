'use strict';
/* Botcord web client — main application.
 * Talks to the Python backend (server.py) over REST + WebSocket.
 * Reuses the desktop client's DOM structure + CSS classes so the
 * Discord-like look is preserved.
 */

/* ============================== state ================================== */

// Must match SERVER_VERSION in server.py. Checked on startup so a stale
// server or cached site fails with a clear message instead of hanging.
const CLIENT_VERSION = 4;

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
    settingsOpen: false,
    latencyMs: null,
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
        'UNKNOWN-CHANNEL': 'That channel is no longer available — try another one',
        'UNKNOWN-GUILD': 'That server is no longer available — try another one',
        'MEMBER-FETCH-FAILED':
            'Could not load members — the bot may need the Server Members intent',
        'NOT-LOGGED-IN': 'Session expired — please log in again',
        'NO-SESSION': 'Session expired — please log in again',
        SHARDING_REQUIRED: 'This bot needs sharding, which Botcord does not support',
        'EMPTY-NAME': 'Username is empty or contains invalid characters',
    };
    let msg = FRIENDLY[code];
    if (!msg) {
        if (code.startsWith('MISSING-PERMISSIONS')) msg = FRIENDLY['MISSING-PERMISSIONS'];
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

async function logout() {
    // invalidate any in-flight bootstrap/channel load so it can't hide the
    // splash screen or render into the cleared UI after logout
    S.bootSeq = (S.bootSeq || 0) + 1;
    S.booting = false;
    S.generating = false;
    try {
        await Api.logout();
    } catch (e) {
        /* ignore */
    }
    store.defaultToken = '';
    S.me = null;
    S.guilds = [];
    S.guildId = null;
    S.channel = null;
    $('guildContainer') && $('guildContainer').remove();
    $('channel-elements').innerHTML = '';
    $('message-list').innerHTML = '';
    $('memberBar').innerHTML = '';
    updateUserCard();
    setConn('closed', 'offline');
    showSplash();
    buildSplashToken();
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
        nameWrap.style.width = '51px';
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

function messageBlock(m) {
    const darkBG = el('div', 'messageBlock');
    darkBG.id = m.id;
    darkBG.dataset.content = m.content || '';
    darkBG.dataset.authorId = m.author.id;

    const isDM = !m.guild_id;
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

function addHeader(darkBG, m) {
    const { name, color, avatar } = authorOf(m);
    const img = el('img', 'messageImg');
    img.src = avatar;
    img.height = 40;
    img.width = 40;
    darkBG.insertBefore(img, darkBG.firstChild);

    const uname = el('p', 'messageUsername', name);
    uname.style.color = color;
    uname.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        userContextMenu(e, m.author);
    });
    darkBG.insertBefore(uname, img.nextSibling);

    const ts = el('p', 'messageTimestamp');
    ts.innerText =
        ' ' +
        new Date(m.timestamp).toLocaleString('en-US', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    darkBG.insertBefore(ts, uname.nextSibling);
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
    if (prev && !sameDay(prev.timestamp, m.timestamp)) div.classList.add('timeSeparated');

    addHeader(darkBG, m);

    div.appendChild(darkBG);
    list.appendChild(div);
}

function renderMessages(messages) {
    clearMessages();
    let prev = null;
    messages.forEach((m, i) => {
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

        $('msgbox').placeholder = S.channel.isDM
            ? `Message @${S.channel.name}`
            : `Message #${S.channel.name}`;

        renderTyping();
        clearMessages();

        const dots = el('div', 'dot-bricks');
        dots.id = 'loading-container';
        dots.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)';
        $('message-list').appendChild(dots);

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

    const groups = [
        { id: 'openDM', title: "Open DM's" },
        { id: 'receivedDM', title: "Received DM's" },
    ];
    const containers = {};
    groups.forEach((gr) => {
        const category = el('div', 'category open');
        category.id = gr.id;
        list.appendChild(category);
        const nameCat = el('div', 'categoryNameContainer');
        category.appendChild(nameCat);
        const svg = el('img', 'categorySVG');
        svg.src = '/resources/icons/categoryArrow.svg';
        nameCat.appendChild(svg);
        nameCat.appendChild(el('h5', 'categoryText', gr.title));
        const div = el('div', 'channelContainer');
        category.appendChild(div);
        nameCat.addEventListener('click', () => category.classList.toggle('open'));
        containers[gr.id] = div;
    });

    const sorted = [...S.dms]
        .filter((d) => d.recipient && !d.recipient.bot)
        .sort((a, b) => (a.recipient.username || '').localeCompare(b.recipient.username || ''));
    if (!sorted.length) {
        containers.openDM.appendChild(el('h5', 'viewableText', 'No DMs yet — chat with a user from a server to open one.'));
    }
    sorted.forEach((d) => {
        const u = d.recipient;
        const row = el('div', 'dmChannel');
        row.id = `dm-${u.id}`;

        const img = el('img', 'dmChannelImage');
        img.src = u.avatar || DEFAULT_AVATAR;
        img.height = 25;
        img.width = 25;
        row.appendChild(img);
        row.appendChild(el('h5', 'viewableText', u.username));

        row.addEventListener('click', () => {
            const prev = list.querySelector('.selectedChan');
            if (prev && prev !== row) prev.classList.remove('selectedChan');
            if (prev === row) return;
            row.classList.add('selectedChan');
            selectChannel({ id: d.channel_id, name: u.username, isDM: true, recipient: u }, row);
        });
        containers.openDM.appendChild(row);
    });
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
        userDiv.appendChild(username);

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
    } else {
        await sendText(Fmt.parseSend(text));
        setTimeout(() => {
            $('msgbox').value = '';
        }, 1);
    }
    return false;
}

async function sendText(content, embed) {
    if (!S.channel) return;
    if (!content && !embed) return;
    try {
        const res = await Api.sendMessage(S.channel.id, content, embed || null);
        if (res.message) {
            // the WS echo will also arrive; upsert by id prevents duplicates
            const list = $('message-list');
            handleIncomingMessage(res.message);
            list.scrollTop = list.scrollHeight;
        }
        $('msgbox').value = '';
    } catch (e) {
        errorHandler(e);
    }
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
    const own = S.me && m.author.id === S.me.id;
    const items = [
        { label: 'Copy content', fn: () => copyText(m.content || '', 'Message') },
        { label: 'Copy message ID', fn: () => copyText(m.id, 'Message ID') },
        {
            label: 'Copy link',
            fn: () => {
                const gid = m.guild_id ? `${m.guild_id}/` : '@me/';
                copyText(`https://discord.com/channels/${gid}${m.channel_id}/${m.id}`, 'Link');
            },
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

/* =========================== settings panel ============================== */

const INVITE_PERMS = [
    ['General Permissions', null],
    ['Administrator', 8, false],
    ['View Audit Log', 80, false],
    ['Manage Server', 20, false],
    ['Manage Roles', 10000000, false],
    ['Manage Channels', 10, false],
    ['Kick Members', 2, false],
    ['Ban Members', 4, false],
    ['Create Instant Invite', 1, true],
    ['Change Nickname', 4000000, true],
    ['Manage Nicknames', 8000000, false],
    ['Manage Emojis', 40000000, false],
    ['Manage Webhooks', 20000000, false],
    ['View Channels', 400, true],
    ['Text Permissions', null],
    ['Send Messages', 800, true],
    ['Send TTS Messages', 1000, false],
    ['Manage Messages', 2000, false],
    ['Embed Links', 4000, true],
    ['Attach Files', 8000, false],
    ['Read Message History', 10000, true],
    ['Mention @everyone', 20000, false],
    ['Use External Emojis', 40000, true],
    ['Add Reactions', 40, true],
    ['Voice Permissions', null],
    ['Connect', 100000, true],
    ['Mute Members', 400000, false],
    ['Move Members', 1000000, false],
    ['Speak', 200000, true],
    ['Deafen Members', 800000, false],
    ['Use Voice Activity', 2000000, false],
    ['Priority Speaker', 100, false],
];

function toggleSettings() {
    const card = $('userSettings');
    card.classList.toggle('userSettingsToggle');
    const icon = $('userPullOutIcon');
    icon.classList.toggle('userSettingsFlip');
    S.settingsOpen = !S.settingsOpen;
    if (S.settingsOpen) closePopups();
}

function closePopups() {
    document.querySelectorAll('#optionGroups .settingsPopup').forEach((n) => n.remove());
    document.querySelectorAll('#optionGroups .optionCategory.toggledOn').forEach((n) => n.classList.remove('toggledOn'));
}

function buildSettingsMenu() {
    const parent = $('optionGroups');
    parent.innerHTML = '';
    const center = el('center');
    center.appendChild(el('h2', '', 'User Options'));
    parent.appendChild(center);

    const groups = [
        { name: 'Presence', build: buildPresencePopup },
        { name: 'User', build: buildUserPopup },
        { name: 'Scripts', build: null },
        { name: 'Servers', build: null },
    ];
    groups.forEach((gr) => {
        const wrap = el('div', 'optionCategoryContainer');
        const cat = el('div', 'optionCategory');
        cat.appendChild(el('span', 'settingLabel', gr.name));
        cat.addEventListener('click', () => {
            if (!gr.build) {
                try {
                    cat.animate(animations.flashTextRed, { duration: 350 });
                } catch (e) {
                    /* ignore */
                }
                return;
            }
            const wasOpen = cat.classList.contains('toggledOn');
            closePopups();
            document.querySelectorAll('#optionGroups .optionCategory').forEach((c) => c.classList.remove('toggledOn'));
            if (!wasOpen) {
                cat.classList.add('toggledOn');
                gr.build(wrap);
            }
        });
        wrap.appendChild(cat);
        parent.appendChild(wrap);
    });
}

function popupShell(parent) {
    const pop = el('div', 'settingsPopup');
    parent.appendChild(pop);
    return pop;
}

function optionBlock(pop, title, desc) {
    const opt = el('div', 'option');
    pop.appendChild(opt);
    opt.appendChild(el('label', '', title));
    if (desc) {
        const d = el('p', 'description', desc);
        opt.appendChild(d);
    }
    return opt;
}

function makeDropdown(parent, options, def) {
    const dd = el('div', 'dropdown');
    dd.tabIndex = 0;
    const display = el('div', 'dropdownDisplay');
    const title = el('span', 'dropDownTitle', options[def || 0]);
    display.appendChild(title);
    const icon = el('img', 'dropdownIcon');
    icon.src = '/resources/icons/pullOut.svg';
    display.appendChild(icon);
    dd.appendChild(display);
    const kids = el('div', 'dropdownChildren');
    dd.appendChild(kids);
    options.forEach((t, i) => {
        const o = el('option', i === (def || 0) ? 'selectedOption' : '', t);
        o.addEventListener('click', (ev) => {
            ev.stopPropagation();
            title.innerText = t;
            kids.querySelectorAll('option').forEach((k) => k.classList.remove('selectedOption'));
            o.classList.add('selectedOption');
            dd.classList.remove('openDrop');
            dd.dispatchEvent(new CustomEvent('change', { detail: t }));
        });
        kids.appendChild(o);
    });
    dd.addEventListener('click', () => dd.classList.toggle('openDrop'));
    parent.appendChild(dd);
    return { root: dd, value: () => title.innerText };
}

function makeInput(parent, placeholder, cls) {
    const inp = document.createElement('input');
    inp.placeholder = placeholder;
    if (cls) inp.className = cls;
    parent.appendChild(inp);
    return inp;
}

function buildPresencePopup(parent) {
    const pop = popupShell(parent);
    const opt = optionBlock(
        pop,
        'Activity, Status & Message',
        'Set the activity status for your bot. This may take a while to update if changed often.'
    );
    const status = makeDropdown(opt, ['Online', 'Idle', 'Do Not Disturb', 'Invisible'], 0);
    const activity = makeDropdown(opt, ['None', 'Playing', 'Streaming', 'Listening', 'Watching', 'Competing'], 0);
    const nameInp = makeInput(opt, 'Name of the game / action', 'activityInput');
    const urlInp = makeInput(opt, 'URL of the stream', 'streamURLInput');
    const btn = el('button', 'settingsUpdateBtn', 'Update');
    btn.addEventListener('click', async () => {
        const statusMap = { Online: 'online', Idle: 'idle', 'Do Not Disturb': 'dnd', Invisible: 'invisible' };
        const actMap = { None: 'none', Playing: 'playing', Streaming: 'streaming', Listening: 'listening', Watching: 'watching', Competing: 'competing' };
        try {
            await Api.updatePresence({
                status: statusMap[status.value()] || 'online',
                activity_type: actMap[activity.value()] || 'none',
                activity_name: nameInp.value,
                stream_url: urlInp.value,
            });
            toast('Presence updated');
        } catch (e) {
            errorHandler(e);
        }
    });
    opt.appendChild(btn);
}

function buildUserPopup(parent) {
    const pop = popupShell(parent);

    const nameOpt = optionBlock(pop, 'Display Information', 'Change things like your username. Personalize yourself!');
    const nameInp = makeInput(nameOpt, 'New username', 'newNameInput');
    const nameBtn = el('button', 'settingsUpdateBtn', 'Update');
    nameBtn.addEventListener('click', async () => {
        try {
            const r = await Api.updateUsername(nameInp.value);
            S.me = r.user;
            updateUserCard();
            toast('Username updated');
        } catch (e) {
            errorHandler(e);
            try {
                nameInp.animate(animations.flashRed, { duration: 500 });
            } catch (err) {
                /* ignore */
            }
        }
    });
    nameOpt.appendChild(nameBtn);
    pop.appendChild(el('hr'));

    const tokOpt = optionBlock(
        pop,
        'Switch Token',
        'Log into a different bot account. Paste your token, press enter, or save it as default.'
    );
    const tokInp = makeInput(tokOpt, 'Input the token here', 'tokenbox');
    tokInp.type = 'password';
    tokInp.id = 'tokenbox';
    tokInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') switchToken(tokInp.value, false);
    });
    const tokBtn = el('button', 'settingsUpdateBtn', 'Save as Default');
    tokBtn.addEventListener('click', () => switchToken(tokInp.value, true));
    tokOpt.appendChild(tokBtn);
    pop.appendChild(el('hr'));

    const invOpt = optionBlock(pop, 'Generate Invite', 'Select permissions, then copy the invite URL for your bot.');
    INVITE_PERMS.forEach(([label, value, def]) => {
        if (value === null) {
            invOpt.appendChild(el('p', 'settingsSeparator', label));
            return;
        }
        const cont = el('div', 'checkBoxContainer');
        cont.appendChild(el('span', '', label));
        const box = el('div', 'checkbox' + (def ? ' toggled' : ''));
        box.id = `perm-${value}`;
        const check = el('img');
        check.src = '/resources/icons/checkmark.svg';
        box.appendChild(check);
        cont.appendChild(box);
        cont.addEventListener('click', () => box.classList.toggle('toggled'));
        invOpt.appendChild(cont);
    });
    const invBtn = el('button', 'settingsUpdateBtn', 'Copy');
    invBtn.addEventListener('click', () => {
        const sum = Array.from(invOpt.querySelectorAll('.checkbox.toggled')).reduce(
            (a, b) => a + parseInt(b.id.replace('perm-', ''), 10),
            0
        );
        if (!S.me) return;
        copyText(
            `https://discordapp.com/oauth2/authorize?client_id=${S.me.id}&scope=bot&permissions=${sum}`,
            'Invite'
        );
    });
    invOpt.appendChild(invBtn);
    pop.appendChild(el('hr'));

    const outOpt = optionBlock(pop, 'Session', 'Log out of the bot on this server.');
    const outBtn = el('button', 'settingsUpdateBtn', 'Log out');
    outBtn.addEventListener('click', logout);
    outOpt.appendChild(outBtn);
}

async function switchToken(token, save) {
    S.bootSeq = (S.bootSeq || 0) + 1;
    S.booting = false;
    S.generating = false;
    showSplash();
    setLoadingPerc(0.05);
    clearSelectMember();
    await doLogin(token, save);
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
    $('homeBtn').addEventListener('click', showDMHome);
    $('userPullOutIcon').addEventListener('click', toggleSettings);

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
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendCurrent();
            $('sendmsg').style.height = '38px';
            $('sendmsg').style.transform = '';
        }
    });
    $('msgbox').addEventListener('input', () => {
        sendTyping();
        const textElem = $('msgbox');
        const box = $('sendmsg');
        if (textElem.scrollHeight < 38 * 5) {
            box.style.height = '0px';
            box.style.height = `${textElem.scrollHeight}px`;
            box.style.transform = `translateY(-${textElem.scrollHeight - 38}px)`;
        }
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
    buildSettingsMenu();
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
