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

    function parseStyling(text, embed) {
        let code = false;
        text = text.replace(
            /(?<!\\)\`\`\`([^\n]+)\n?(.*?)(?:\n)?(?=\`\`\`)\`\`\`/gs,
            (a, b, c) => {
                code = true;
                c = c.length ? c : b;
                return `<div class="codeBlock${
                    embed ? ' codeBlockEmbed' : ''
                } ${b}">${c}</div>`;
            }
        );
        text = text.replace(/(?<!\\)`(.*?)`/gm, (a, b) => {
            if (code) return a;
            code = true;
            return `<span class="inlineCodeBlock">${b}</span>`;
        });

        if (code == false) {
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
        }

        return text;
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

    // clean_content style: "@Name" / "#channel" plain text matched against
    // the message's mention lists + cached guild data.
    function formatPings(msg, text, isDM) {
        let textContent = text;
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
                        : `<span class="ping ${id}">#${c.replace(/\*/g, '&#42')}</span>`
                );
            } else {
                const pingRegex = new RegExp(`(?:(<|>)?@!?(${name}))`, 'g');
                textContent = textContent.replace(pingRegex, (a, b, c) =>
                    b == '<' || b == '>'
                        ? a
                        : `<span class="ping"${color}>@${c.replace(/\*/g, '&#42')}</span>`
                );
            }
        });
        return textContent;
    }

    // raw "<@123>" / "<#123>" forms (embeds, system text) matched by id.
    function formatEmbedPings(msg, text, isDM) {
        let textContent = text;
        const ids = new Set();
        text.replace(/&lt;@!?([0-9]+)&gt;/gm, (a, id) => {
            ids.add(id);
            return a;
        });
        text.replace(/&lt;#(\d+)&gt;/gm, (a, id) => {
            ids.add(id);
            return a;
        });

        ids.forEach((id) => {
            let name = displayNameFor(id);
            let color = '';
            if (name === id && !isDM) {
                const r = lookup.roles[id];
                if (r) {
                    name = r.name;
                    if (r.color) color = ` style="color: ${r.color}"`;
                }
            }
            let chanName = null;
            if (!isDM) {
                const c = lookup.channels[id];
                if (c) chanName = c.name;
            }
            const pingRegex = new RegExp(`(?:(<|>)?&lt;@!?(${id})&gt;)`, 'g');
            const channelRegex = new RegExp(`&lt;#${id}&gt;`, 'g');
            textContent = textContent.replace(pingRegex, (a, b) =>
                b == '<' || b == '>'
                    ? a
                    : `<span class="ping"${color}>@${escReg(String(name)).replace(/\\\*/g, '&#42')}</span>`
            );
            if (!isDM && chanName) {
                textContent = textContent.replace(
                    channelRegex,
                    `<span class="ping ${id}">#${escReg(chanName)}</span>`
                );
            }
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
        textContent = parseStyling(textContent, embed);
        textContent = parseUnicodeEmojis(textContent);
        textContent = parseCustomEmojis(textContent);
        try {
            if (typeof twemoji !== 'undefined') textContent = twemoji.parse(textContent);
        } catch (e) {
            /* twemoji CDN may be blocked; text still renders */
        }
        return textContent;
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
        parseHTML,
        parseLinks,
        parseStyling,
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
