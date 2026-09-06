'use strict';
/* Botcord web client — transport layer.
 * Small wrapper around the Python backend REST API + WebSocket stream.
 * No dependencies. Exposes a global `Api` object.
 */

const Api = (() => {
    const base = ''; // same origin (works when the site is served by server.py)
    const password = () => localStorage.getItem('botcord.webPassword') || '';
    const sessionId = () => localStorage.getItem('botcord.session') || '';
    const setSessionId = (sid) => {
        if (sid) localStorage.setItem('botcord.session', sid);
    };
    const clearSessionId = () => localStorage.removeItem('botcord.session');

    const DEFAULT_TIMEOUT_MS = 30000;
    const BODY_TIMEOUT_MS = 10000;

    async function ensureSession() {
        if (sessionId()) return sessionId();
        // Never hang the splash forever if the host is unreachable:
        // fail visibly so the UI can say "is server.py running?"
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        const opts = { method: 'POST', headers: sessionHeaders() };
        if (ctrl) {
            opts.signal = ctrl.signal;
            timer = setTimeout(() => ctrl.abort(), 30000);
        }
        let res;
        try {
            res = await fetch(base + '/api/session', opts);
        } catch (e) {
            if (timer) clearTimeout(timer);
            const timedOut = e && e.name === 'AbortError';
            throw {
                code: timedOut ? 'REQUEST-TIMEOUT' : 'CONNECTION-REFUSED',
                message: String(e),
            };
        }
        if (timer) clearTimeout(timer);
        let data = {};
        try {
            data = await Promise.race([
                res.json().catch(() => ({})),
                new Promise((_, rej) => setTimeout(() => rej(new Error('body-timeout')), BODY_TIMEOUT_MS)),
            ]);
        } catch (e) {
            throw { code: 'REQUEST-TIMEOUT', message: String(e) };
        }
        if (!res.ok) throw { code: data.error || `HTTP-${res.status}`, status: res.status, data };
        setSessionId(data.session_id);
        return data.session_id;
    }

    function sessionHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (password()) headers['X-Botcord-Password'] = password();
        if (sessionId()) headers['X-Botcord-Session'] = sessionId();
        return headers;
    }

    async function req(method, path, body, retried, timeoutMs) {
        const budget = timeoutMs || DEFAULT_TIMEOUT_MS;
        const opts = { method, headers: sessionHeaders() };
        if (body !== undefined) opts.body = JSON.stringify(body);
        // never hang the loader forever: fail visibly after the budget
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        if (ctrl) {
            opts.signal = ctrl.signal;
            timer = setTimeout(() => ctrl.abort(), budget);
        }
        let res;
        try {
            res = await fetch(base + path, opts);
        } catch (e) {
            if (timer) clearTimeout(timer);
            const timedOut = e && e.name === 'AbortError';
            throw {
                code: timedOut ? 'REQUEST-TIMEOUT' : 'CONNECTION-REFUSED',
                message: String(e),
            };
        }
        // Keep the deadline for the body read too: some proxies/servers can
        // send headers quickly but stall the body, which used to hang the
        // "Loading servers" screen forever (timer was cleared too early).
        let data = {};
        try {
            data = await Promise.race([
                res.json().catch(() => ({})),
                new Promise((_, rej) =>
                    setTimeout(() => rej(new Error('body-timeout')), BODY_TIMEOUT_MS)
                ),
            ]);
        } catch (e) {
            if (timer) clearTimeout(timer);
            throw { code: 'REQUEST-TIMEOUT', message: String(e && e.message || e) };
        }
        if (timer) clearTimeout(timer);
        if (!res.ok) {
            const code = data.error || `HTTP-${res.status}`;
            // session expired/cleared server-side (restart, idle timeout):
            // grab a fresh one and retry once
            if (code === 'NO-SESSION' && !retried) {
                clearSessionId();
                try {
                    await ensureSession();
                    disconnect();
                    connect();
                } catch (e) {
                    throw { code, status: res.status, data };
                }
                return req(method, path, body, true, timeoutMs);
            }
            throw { code, status: res.status, data };
        }
        return data;
    }

    const get = (p, timeoutMs) => req('GET', p, undefined, false, timeoutMs);
    const post = (p, b, timeoutMs) => req('POST', p, b || {}, false, timeoutMs);
    const patch = (p, b, timeoutMs) => req('PATCH', p, b || {}, false, timeoutMs);
    const put = (p, b, timeoutMs) => req('PUT', p, b || {}, false, timeoutMs);
    const del = (p, timeoutMs) => req('DELETE', p, undefined, false, timeoutMs);

    // -- WebSocket event bus ---------------------------------------------
    const handlers = {};
    let ws = null;
    let wsWanted = true;
    let reconnectTimer = null;

    function on(event, fn) {
        (handlers[event] = handlers[event] || []).push(fn);
    }

    function emit(event, data) {
        (handlers[event] || []).forEach((fn) => {
            try {
                fn(data);
            } catch (e) {
                console.error('WS handler error for', event, e);
            }
        });
    }

    function connect() {
        wsWanted = true;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const qs = sessionId() ? `?session=${encodeURIComponent(sessionId())}` : '';
        ws = new WebSocket(proto + '//' + location.host + '/ws' + qs);
        emit('socket_state', { state: 'connecting' });
        ws.onopen = () => {
            emit('socket_state', { state: 'open' });
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };
        ws.onmessage = (ev) => {
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            if (msg.t === 'pong') return;
            emit(msg.t, msg.d || {});
            emit('*', { t: msg.t, d: msg.d || {} });
        };
        ws.onclose = () => {
            emit('socket_state', { state: 'closed' });
            ws = null;
            if (wsWanted && !reconnectTimer) {
                reconnectTimer = setTimeout(connect, 3000);
            }
        };
        ws.onerror = () => {
            try {
                ws.close();
            } catch (e) {
                /* ignore */
            }
        };
        // keep-alive
        const pingTimer = setInterval(() => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                clearInterval(pingTimer);
                return;
            }
            try {
                ws.send(JSON.stringify({ t: 'ping' }));
            } catch (e) {
                /* ignore */
            }
        }, 25000);
    }

    function disconnect() {
        wsWanted = false;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            try {
                ws.close();
            } catch (e) {
                /* ignore */
            }
            ws = null;
        }
    }

    return {
        // session (one per browser; the server scopes each bot login to it)
        ensureSession,
        sessionId,
        clearSession: clearSessionId,
        version: () => get('/api/version'),
        // auth / session
        status: () => get('/api/status'),
        login: (token) => post('/api/login', { token }, 60000),
        logout: () => post('/api/logout'),
        teamSelect: (user_id) => post('/api/team-select', { user_id }),
        me: () => get('/api/me'),
        // data
        guilds: () => get('/api/guilds'),
        guildChannels: (gid) => get(`/api/guilds/${gid}/channels`),
        guildMembers: (gid, limit) => get(`/api/guilds/${gid}/members?limit=${limit || 500}`),
        guildRoles: (gid) => get(`/api/guilds/${gid}/roles`),
        dms: () => get('/api/dms'),
        emojis: () => get('/api/emojis'),
        messages: (cid, opts) => {
            const q = new URLSearchParams();
            q.set('limit', (opts && opts.limit) || 50);
            if (opts && opts.before) q.set('before', opts.before);
            if (opts && opts.after) q.set('after', opts.after);
            return get(`/api/channels/${cid}/messages?${q.toString()}`);
        },
        sendMessage: (cid, content, embed) => post(`/api/channels/${cid}/messages`, { content, embed }),
        editMessage: (cid, mid, content) => patch(`/api/channels/${cid}/messages/${mid}`, { content }),
        deleteMessage: (cid, mid) => del(`/api/channels/${cid}/messages/${mid}`),
        bulkDelete: (cid, count) => post(`/api/channels/${cid}/bulk-delete`, { count }),
        pinMessage: (cid, mid) => post(`/api/channels/${cid}/pins/${mid}`),
        unpinMessage: (cid, mid) => del(`/api/channels/${cid}/pins/${mid}`),
        addReaction: (cid, mid, emoji) =>
            post(`/api/channels/${cid}/messages/${mid}/reactions`, { emoji }),
        removeReaction: (cid, mid, emoji) =>
            del(
                `/api/channels/${cid}/messages/${mid}/reactions?emoji=${encodeURIComponent(emoji)}`
            ),
        typing: (cid) => post(`/api/channels/${cid}/typing`),
        createInvite: (cid) => post(`/api/channels/${cid}/invites`, {}),
        updateUsername: (username) => patch('/api/me', { username }),
        updatePresence: (presence) => put('/api/me/presence', presence),
        // socket
        on,
        emit,
        connect,
        disconnect,
    };
})();
