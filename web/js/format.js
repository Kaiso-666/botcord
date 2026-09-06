'use strict';
/* Botcord web client — message formatting.
 * Ported from the desktop client's parseFunctions.js / parseMessage.js,
 * adapted to work on plain JSON from the Python backend instead of
 * discord.js objects. Pure functions, no DOM except twemoji at the end.
 * Exposes a global `Fmt` object.
 */

const Fmt = (() => {
    // Lookup tables filled in by app.js:
    // { members: {id: {display_name, username}},
    //   roles: {id: {name, color}},
    //   channels: {id: {name}},
    //   emojis: {lowerName: {id, name, animated}} }
    let lookup = { members: {}, roles: {}, channels: {}, emojis: {} };

    function setLookup(l) {
        lookup = l;
    }

    function escReg(s) {
        return s.replace(/(\[|\]|\(|\)|\\)/g, (a) => '\\' + a).replace(/\*/g, '\\*');
    }

    // --- verbatim ports from parseFunctions.js ----------------------------

    function parseHTML(text) {
        text = text.replace(/<|>|&/gm, (s) =>
            s == '<' ? '&lt;' : s == '>' ? '&gt;' : '&amp'
        );
        return text;
    }

    function parseLinks(text) {
        text = text.replace(
            /https?:\/\/((?:\w|.)+?)(?=\/|(?= )|[>)}\]:; ]|$)(?:[\w\.!@#$%^&*\-\/]+?)*(?:\?.*?(?=[>)}\]:; ]|$))?/gm,
            (a, b, c) => {
                a.endsWith('/') ? undefined : (a += '/');
                return `<a href="${a}" rel="noreferrer noopener" title="${a}" target="_blank">${a}</a>`;
            }
        );
        return text;
    }

    // Code spans/blocks are stashed before any other formatting runs, so
    // markdown, links and emoji never leak inside them — and formatting
    // always applies OUTSIDE them (one backtick used to disable styling
    // for the whole message). Restore with restoreCodeSpans() last.
    function stashCodeSpans(text, embed) {
        const stash = [];
        const put = (html) => {
            stash.push(html);
            return `\u0000${stash.length - 1}\u0000`;
        };
        text = text.replace(
            /(?<!\\)\`\`\`([^\n]+)\n?(.*?)(?:\n)?(?=\`\`\`)\`\`\`/gs,
            (a, b, c) => {
                c = c.length ? c : b;
                return put(
                    `<div class="codeBlock${
                        embed ? ' codeBlockEmbed' : ''
                    } ${b}">${c}</div>`
                );
            }
        );
        text = text.replace(/(?<!\\)`(.*?)`/gm, (a, b) =>
            put(`<span class="inlineCodeBlock">${b}</span>`)
        );
        return { text, stash };
    }

    function restoreCodeSpans(text, stash) {
        if (!stash || !stash.length) return text;
        return text.replace(/\u0000(\d+)\u0000/g, (a, i) =>
            stash[+i] !== undefined ? stash[+i] : a
        );
    }

    function styleMarkdown(text) {
        text = text.replace(
            /(?<!\\)\*\*\*(.+?)(?<!\\)\*\*\*/gm,
            '<strong><i>$1<i></strong>'
        );
        text = text.replace(
            /(?<!\\)\*\*(.+?)(?<!\\)\*\*/gm,
            '<strong>$1</strong>'
        );
        text = text.replace(/(?<!\\)__(.+?)(?<!\\)__/gm, '<u>$1</u>');
        text = text.replace(/(?<!\\)_(.+?)(?<!\\)_/gm, '<i>$1</i>');
        text = text.replace(/(?<!\\)\*(.+?)(?<!\\)\*/gm, '<i>$1</i>');
        text = text.replace(
            /(?<!\\)\|\|(.+?)\|\|(?<!\\)/gm,
            '<span class="spoilerBlock" onclick="discoverSpoiler(this)">$1</span>'
        );
        text = text.replace(/(?<!\\)\~(.+?)(?<!\\)\~/gm, '<del>$1</del>');
        return text;
    }

    function parseStyling(text, embed) {
        // Standalone entry point (kept for compatibility): code spans are
        // protected while the rest of the markdown always applies.
        const stashed = stashCodeSpans(text, embed);
        return restoreCodeSpans(styleMarkdown(stashed.text), stashed.stash);
    }

    function parseUnicodeEmojis(text) {
        if (
            !text.replace(
                /((\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])| |(&lt;a?:!?.+?:\d{17,19}?&gt;))/g,
                ''
            ).length
        ) {
            text = `<span class="bigEmoji">${text}</span>`;
        }
        return text;
    }

    function parseCustomEmojis(text) {
        text = text.replace(
            /&lt;(a)?:!?(.+?):(\d{17,19}?)&gt;/gm,
            (original, animated, name, id) => {
                if (id !== undefined)
                    return `<img class="emoji" draggable="false" alt=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${
                        animated == 'a' ? 'gif' : 'png'
                    }?v=1"></img>`;
                return animated;
            }
        );
        return text;
    }

    // --- mention formatting (backend-JSON aware) ---------------------------

    function displayNameFor(id) {
        const m = lookup.members[id];
        if (m) return m.display_name || m.username || id;
        return id;
    }

    function chanName(id) {
        const c = lookup.channels[String(id)];
        return c ? c.name : null;
    }

    function roleName(id) {
        const r = lookup.roles[String(id)];
        return r ? r.name : null;
    }

    // clean_content style: "@Name" / "#channel" plain text matched against
    // the message's mention lists + cached guild data.
    function formatPings(msg, text, isDM) {
        let textContent = text;
        // @everyone / @here light up like any other ping
        textContent = textContent.replace(
            /(^|\s)(@(everyone|here))(?=[\s<.,!?;:]|$)/gm,
            (a, pre, tag) => `${pre}<span class="ping">${tag}</span>`
        );
        const keys = []; // [name, id, kind]
        const mentions = (msg && msg.mentions) || { users: [], roles: [], channels: [] };

        (mentions.users || []).forEach((u) => {
            const name = displayNameFor(String(u.id)) !== String(u.id)
                ? displayNameFor(String(u.id))
                : u.username || String(u.id);
            keys.push([name, String(u.id), 'user']);
        });
        if (!isDM) {
            (mentions.roles || []).forEach((id) => {
                id = String(id);
                const r = lookup.roles[id];
                keys.push([r ? r.name : id, id, 'role']);
            });
            (mentions.channels || []).forEach((id) => {
                id = String(id);
                const c = lookup.channels[id];
                keys.push([c ? c.name : 'deleted-channel', id, 'channel']);
            });
        }

        keys.forEach(([rawName, id, kind]) => {
            const name = escReg(String(rawName));
            let color = '';
            if (kind === 'role') {
                const r = lookup.roles[id];
                if (r && r.color) color = ` style="color: ${r.color}"`;
            }
            if (kind === 'channel') {
                const channelRegex = new RegExp(`(?:(<|>)?#(${name}))`, 'g');
                textContent = textContent.replace(channelRegex, (a, b, c) =>
                    b == '<' || b == '>'
                        ? a
                        : `<span class="ping ${id}" data-cid="${id}">#${c.replace(/\*/g, '&#42')}</span>`
                );
            } else {
                const pingRegex = new RegExp(`(?:(<|>)?@!?(${name}))`, 'g');
                const dataAttr = kind === 'role' ? ` data-rid="${id}"` : ` data-uid="${id}"`;
                textContent = textContent.replace(pingRegex, (a, b, c) =>
                    b == '<' || b == '>'
                        ? a
                        : `<span class="ping"${color}${dataAttr}>@${c.replace(/\*/g, '&#42')}</span>`
                );
            }
        });
        return textContent;
    }

    // Escape a display name for pill HTML (regex-safe + *-safe).
    function pillName(raw) {
        return escReg(String(raw)).replace(/\\\*/g, '&#42');
    }

    function userPillHtml(id, isDM) {
        id = String(id);
        const name = displayNameFor(id);
        if (name !== id) {
            return `<span class="ping" data-uid="${id}">@${pillName(name)}</span>`;
        }
        if (!isDM && lookup.roles[id]) {
            const r = lookup.roles[id];
            const color = r.color ? ` style="color: ${r.color}"` : '';
            return `<span class="ping"${color} data-rid="${id}">@${pillName(r.name)}</span>`;
        }
        // unknown for now: tagged so resolveMentions() can fill in the real
        // name async instead of leaving @12345… forever
        return `<span class="ping ping-unknown" data-uid="${id}">@${id}</span>`;
    }

    // raw "<@123>" / "<#123>" / "<@&123>" forms (embeds, system text)
    // matched by id. Unknown channels render #deleted-channel like Discord.
    function formatEmbedPings(msg, text, isDM) {
        let textContent = text;
        // roles first: "<@&id>" arrives HTML-escaped, with or without the
        // legacy "&amp" spelling that parseHTML emits for "&"
        textContent = textContent.replace(/&lt;@&amp;?(\d+)&gt;/gm, (a, id) => {
            const r = lookup.roles[String(id)];
            const color = r && r.color ? ` style="color: ${r.color}"` : '';
            const label = r ? `@${pillName(r.name)}` : '@deleted-role';
            return `<span class="ping"${color} data-rid="${id}">${label}</span>`;
        });
        // users
        textContent = textContent.replace(/&lt;@!?(\d+)&gt;/gm, (a, id) =>
            userPillHtml(id, isDM)
        );
        // channels
        textContent = textContent.replace(/&lt;#(\d+)&gt;/gm, (a, id) => {
            const c = lookup.channels[String(id)];
            if (c) {
                return `<span class="ping" data-cid="${id}">#${pillName(c.name)}</span>`;
            }
            return `<span class="ping ping-unknown" data-cid="${id}">#deleted-channel</span>`;
        });
        return textContent;
    }

    function parseMessage(text, msg, opts) {
        opts = opts || {};
        const embed = !!opts.embed;
        const ping = !!opts.ping;
        const embeddedLink = !!opts.embeddedLink;
        const isDM = !!opts.isDM;
        let textContent = parseHTML(text || '');

        // Protect code spans first: mentions, links and markdown never apply
        // inside them — and always apply outside them.
        const stashed = stashCodeSpans(textContent, embed);
        textContent = stashed.text;

        if (ping || !embed) {
            textContent = formatEmbedPings(msg, textContent, isDM);
            textContent = formatPings(msg, textContent, isDM);
        }
        if (embeddedLink) {
            textContent = textContent.replace(
                /(?:\[(?:<(?:[\w\W]+?>([\w\.!@#$%^&*\-\/"=\[\];]+?)<(?:[\w\W\/]+?)>)|([\w\.!@#$%^&*\-\/"=<>\]\[; ]+?))\]\((?:<a href="([\w:\/.<=\-]+?)".+\)|([\w.:\/_"=\-<> ]+?)\)))/gm,
                (a, b, c, d, e) =>
                    `<a title="${b ? b : c}" href="${d ? d : e}">${b ? b : c}</a>`
            );
        }

        textContent = parseLinks(textContent);
        textContent = styleMarkdown(textContent);
        textContent = parseUnicodeEmojis(textContent);
        textContent = parseCustomEmojis(textContent);
        try {
            if (typeof twemoji !== 'undefined') textContent = twemoji.parse(textContent);
        } catch (e) {
            /* twemoji CDN may be blocked; text still renders */
        }
        return restoreCodeSpans(textContent, stashed.stash);
    }

    // Outgoing text: ascii shortcuts -> unicode, :shortcuts: -> unicode,
    // :custom: -> <:_:id> via cached emoji list.
    function parseSend(text) {
        const emojiRegex =
            /(?<!\S)(>:\(|>:-\(|>=\(|>=-\(|:"\)|:-"\)|="\)|=-"\)|<\/3|:-\||=-\\|=-\/|:'\(|:'-\(|:,\(|:,-\(|='\(|='-\(|=,\(|=,-\(|:\(|:-\(|=\(|=-\(|<3|♡|]:\(|\]:-\(|]=\(|]=-\(|o:\)|O:\)|o:-\)|O:-\)|0:\)|0:-\)|o=\)|O=\)|o=-\)|O=-\)|0=\)|0=-\)|:'D|:'-D|:,D|:,-D|='D|='-D|=,D|=,-D|:\*|:-\*|=\*|=-\*|x-\)|X-\)|:\||:-\||=\||=-\||:o|:-o|:O|:-O|=o|=-o|=O|=-O|:@|:-@|=@|=-@|:D|:-D|=D|=-D|:'\)|:'-\)|:,\)|:,-\)|='\)|='-\)|=,\)|=,-\)|:\)|:-\)|=\)|=-\)|]:\)|]:-\)|]=\)|]=-\)|:,'\(|:,'-\(|;\(|;-\(|=,'\(|=,'-\(|:P|:-P|=P|=-P|8-\)|B-\)|,:\(|,:-\(|,=\(|,=-\(|,:\)|,:-\)|,=\)|,=-\)|:s|:-S|:z|:-Z|:\$|:-\$|=s|=-S|=z|=-Z|=\$|=-\$|;\)|;-\))(?!\S)/gm;

        text = text.replace(emojiRegex, (a) => {
            try {
                const shortcut =
                    typeof shortcuts !== 'undefined' &&
                    shortcuts.find((s) => s.face === a);
                if (shortcut && typeof idToUni !== 'undefined' && idToUni[shortcut.id])
                    return idToUni[shortcut.id];
            } catch (e) {
                /* ignore */
            }
            return a;
        });

        text = text.replace(/:(.*):/gm, (a, b) => {
            try {
                if (typeof idToUni !== 'undefined' && idToUni[b]) return idToUni[b];
            } catch (e) {
                /* ignore */
            }
            return a;
        });

        // :custom-emoji: -> <:name:id> using the bot's emoji cache from /api/emojis
        const customEmojiRegex = /^:([\d\w]+):|[^<]:([\d\w]+):/gm;
        text = text
            .replaceAll('::', ': :')
            .replaceAll(customEmojiRegex, (match) => {
                let name = match[1] === ':' ? match.slice(2, -1) : match.slice(1, -1);
                const found = lookup.emojis[String(name).toLowerCase()];
                if (found) return `<:${found.name}:${found.id}>`;
                return match;
            });

        return text;
    }

    return {
        setLookup,
        displayNameFor,
        chanName,
        roleName,
        parseHTML,
        parseLinks,
        parseStyling,
        stashCodeSpans,
        restoreCodeSpans,
        parseUnicodeEmojis,
        parseCustomEmojis,
        formatPings,
        formatEmbedPings,
        parseMessage,
        parseSend,
    };
})();

function discoverSpoiler(spoiler) {
    spoiler.classList.toggle('discovered');
}
