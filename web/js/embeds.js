'use strict';
/* Botcord web client — embed rendering.
 * Ported from the desktop client's showEmbed.js. Accepts embed dicts as
 * returned by the Python backend (discord.py `Embed.to_dict()`, snake_case)
 * as well as discord.js-style camelCase payloads.
 * Exposes a global `showEmbed(embed, element, msg, isDM)`.
 */

function _pick(obj, ...keys) {
    for (const k of keys) {
        if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
}

function showEmbed(embed, element, msg, isDM) {
    if (!embed) return;
    const type = embed.type || 'rich';
    if (['rich', 'link'].includes(type)) {
        showRichEmbed(embed, msg, element, type, isDM);
    } else if (['article'].includes(type)) {
        showArticleEmbed(embed, msg, element, isDM);
    } else if (['image'].includes(type)) {
        showImageEmbed(embed, msg, element);
    } else if (['gifv', 'video'].includes(type)) {
        showVideoEmbed(embed, msg, element);
    } else {
        showRichEmbed(embed, msg, element, type, isDM);
    }
}

function _fmtEmbedText(text, msg, isDM) {
    return Fmt.parseMessage(text, msg, { embed: true, ping: true, embeddedLink: true, isDM: !!isDM });
}

function showRichEmbed(embed, msg, element, type, isDM) {
    const embedCont = document.createElement('div');
    element.appendChild(embedCont);
    embedCont.classList.add('embed');

    if (embed.color) {
        let color = Number(embed.color).toString(16);
        color = '0'.repeat(6 - color.length) + color;
        embedCont.style.borderColor = `#${color}`;
    }

    const thumbnail = _pick(embed, 'thumbnail');
    if (thumbnail) {
        const url = _pick(thumbnail, 'url', 'proxy_url');
        if (url) {
            const largeIcon = document.createElement('img');
            largeIcon.classList.add(type === 'embed' ? 'embedLargeIcon' : 'embedSmallIcon');
            largeIcon.src = _pick(thumbnail, 'proxy_url', 'url');
            largeIcon.loading = 'lazy';
            embedCont.appendChild(largeIcon);
        }
    }

    const author = _pick(embed, 'author');
    if (author && author.name) {
        const authorContainer = document.createElement('div');
        authorContainer.classList.add('embedAuthor');
        embedCont.appendChild(authorContainer);

        const iconURL = _pick(author, 'iconURL', 'icon_url', 'proxy_icon_url');
        if (iconURL) {
            const authorImage = document.createElement('img');
            authorImage.classList.add('embedAuthorImg');
            authorImage.src = iconURL;
            authorImage.loading = 'lazy';
            authorContainer.appendChild(authorImage);
        }

        const authorName = document.createElement('p');
        authorName.classList.add('embedAuthorName');
        const url = _pick(author, 'url');
        if (url) {
            const link = document.createElement('a');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            link.textContent = author.name;
            authorName.appendChild(link);
        } else {
            authorName.appendChild(document.createTextNode(author.name));
        }
        authorContainer.appendChild(authorName);
    }

    const provider = _pick(embed, 'provider');
    if (provider && provider.name) {
        const prov = document.createElement('p');
        prov.classList.add('embedContent');
        prov.classList.add('embedProviderName');
        prov.innerHTML = _fmtEmbedText(provider.name, msg, isDM);
        embedCont.appendChild(prov);
    }

    if (embed.title) {
        const url = _pick(embed, 'url');
        let title;
        if (!url) {
            title = document.createElement('p');
        } else {
            title = document.createElement('a');
            title.href = url;
            title.target = '_blank';
            title.rel = 'noreferrer noopener';
        }
        title.classList.add('embedTitle');
        title.innerHTML = _fmtEmbedText(embed.title, msg, isDM);
        embedCont.appendChild(title);
    }

    if (embed.description) {
        const description = document.createElement('p');
        description.classList.add('embedDescription');
        description.classList.add('embedContent');
        description.innerHTML = _fmtEmbedText(embed.description, msg, isDM);
        embedCont.appendChild(description);
    }

    const fields = _pick(embed, 'fields') || [];
    fields.forEach((field) => {
        const fieldCont = document.createElement('div');
        fieldCont.classList.add('field');
        embedCont.appendChild(fieldCont);

        const fieldTitle = document.createElement('p');
        fieldTitle.classList.add('fieldName');
        fieldTitle.classList.add('embedContent');
        fieldTitle.innerHTML = _fmtEmbedText(field.name || '', msg, isDM);
        fieldCont.appendChild(fieldTitle);

        const fieldValue = document.createElement('p');
        fieldValue.classList.add('fieldText');
        fieldValue.classList.add('embedContent');
        fieldValue.innerHTML = _fmtEmbedText(field.value || '', msg, isDM);
        fieldCont.appendChild(fieldValue);

        if (field.inline) fieldCont.style.display = 'inline-block';
    });

    const image = _pick(embed, 'image');
    if (image) {
        const url = _pick(image, 'proxy_url', 'url');
        if (url) {
            const img = document.createElement('img');
            img.classList.add('embedImage');
            img.src = url;
            img.loading = 'lazy';
            embedCont.appendChild(img);
        }
    }

    const footer = _pick(embed, 'footer');
    if (footer && footer.text) {
        const footCont = document.createElement('div');
        footCont.classList.add('footer');
        embedCont.appendChild(footCont);

        const iconURL = _pick(footer, 'iconURL', 'icon_url', 'proxy_icon_url');
        if (iconURL) {
            const footIcon = document.createElement('img');
            footIcon.classList.add('embedAuthorImg');
            footIcon.src = iconURL;
            footIcon.loading = 'lazy';
            footCont.appendChild(footIcon);
        }

        const footText = document.createElement('p');
        footText.classList.add('footerText');
        footText.innerHTML = _fmtEmbedText(footer.text, msg, isDM);
        footCont.appendChild(footText);
    }

    const video = _pick(embed, 'video');
    if (video && video.url && !image) {
        const vid = document.createElement('video');
        vid.src = video.url;
        vid.classList.add('previewImage');
        vid.style.height = '200px';
        vid.setAttribute('controls', 'true');
        embedCont.appendChild(vid);
    }
}

function showArticleEmbed(embed, msg, element, isDM) {
    const embedCont = document.createElement('div');
    element.appendChild(embedCont);
    embedCont.classList.add('embed');

    const provider = _pick(embed, 'provider');
    if (provider && provider.name) {
        const prov = document.createElement('p');
        prov.classList.add('embedContent');
        prov.classList.add('embedProviderName');
        prov.innerHTML = _fmtEmbedText(provider.name, msg, isDM);
        embedCont.appendChild(prov);
    }

    if (embed.title) {
        const title = document.createElement('a');
        title.classList.add('embedTitle');
        if (embed.url) {
            title.href = embed.url;
            title.target = '_blank';
            title.rel = 'noreferrer noopener';
        }
        title.innerHTML = _fmtEmbedText(embed.title, msg, isDM);
        embedCont.appendChild(title);
    }

    if (embed.description) {
        const description = document.createElement('p');
        description.classList.add('embedDescription');
        description.classList.add('embedContent');
        description.innerHTML = _fmtEmbedText(embed.description, msg, isDM);
        embedCont.appendChild(description);
    }

    const thumbnail = _pick(embed, 'thumbnail');
    if (thumbnail) {
        const url = _pick(thumbnail, 'proxy_url', 'url');
        if (url) {
            const largeIcon = document.createElement('img');
            largeIcon.classList.add('embedArticleLargeIcon');
            largeIcon.src = url;
            largeIcon.loading = 'lazy';
            embedCont.appendChild(largeIcon);
        }
    }
}

function showImageEmbed(embed, msg, element) {
    const thumb = _pick(embed, 'thumbnail', 'image') || {};
    const url = _pick(thumb, 'proxy_url', 'url');
    if (!url) return;
    const img = document.createElement('img');
    const w = thumb.width || 400;
    const h = thumb.height || 300;
    const newWidth = w < 400 ? w : 400;
    const separator = url.includes('?') ? '&' : '?';
    img.src = `${url}${separator}width=${newWidth}&height=${Math.floor(
        (newWidth / w) * h
    )}`;
    img.classList.add('previewImage');
    img.loading = 'lazy';
    element.appendChild(img);
}

function showVideoEmbed(embed, msg, element) {
    const video = _pick(embed, 'video') || {};
    const url = video.url;
    if (!url) return;
    const vid = document.createElement('video');
    const newHeight = (video.height || 300) < 300 ? video.height : 400;
    vid.style.height = newHeight + 'px';
    vid.style.width = 'auto';
    vid.src = url;
    vid.classList.add('previewImage');
    vid.onmouseenter = () => vid.setAttribute('controls', 'true');
    vid.onmouseleave = () => vid.removeAttribute('controls');
    vid.onclick = () => (vid.paused ? vid.play() : vid.pause());
    vid.onended = () => {
        vid.currentTime = 0;
    };
    element.appendChild(vid);
}

// Link media previews, Discord-style: bare image / video / GIF links in the
// message text expand inline (images, video players, GIF badges). Links
// Discord already unfurled into embeds/attachments are skipped so nothing
// renders twice; links inside code spans are left alone.
const LINK_IMG_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)([?#]|$)/i;
const LINK_VID_RE = /\.(mp4|webm|mov|m4v)([?#]|$)/i;
const LINK_FMT_RE = /[?&](?:format|fm)=(png|jpe?g|gif|webp|avif)/i;
const MAX_LINK_PREVIEWS = 4;

function extractLinkUrls(text) {
    if (!text) return [];
    // ignore code blocks / inline code: examples shouldn't expand
    const scrubbed = String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
    const out = [];
    const re = /https?:\/\/[^\s<>()"']+/gi;
    let m;
    while ((m = re.exec(scrubbed))) {
        // trim trailing punctuation that isn't part of the URL
        const url = m[0].replace(/[.,!?;:)\]}>]+$/, '');
        if (url && out.indexOf(url) === -1) out.push(url);
    }
    return out;
}

// Giphy share-page URL -> direct GIF (Discord unfurls these the same way).
// Tenor/imgur-album pages need API resolution, so they're left as links —
// Discord's own server-side embeds cover them when it generates them.
function giphyGifUrl(url) {
    const m = String(url).match(
        /^https?:\/\/(?:www\.)?giphy\.com\/gifs\/(?:.*-)?([A-Za-z0-9]+)\/?(?:[?#].*)?$/
    );
    if (m) return `https://media.giphy.com/media/${m[1]}/giphy.gif`;
    return null;
}

function collectCoveredUrls(msg) {
    const covered = new Set();
    const add = (u) => {
        if (typeof u === 'string' && u) covered.add(u);
    };
    (msg.embeds || []).forEach((e) => {
        if (!e || typeof e !== 'object') return;
        add(e.url);
        ['image', 'thumbnail', 'video'].forEach((k) => {
            const o = e[k];
            if (o && typeof o === 'object') {
                add(o.proxy_url);
                add(o.url);
            }
        });
    });
    (msg.attachments || []).forEach((a) => {
        if (!a) return;
        add(a.url);
        add(a.proxy_url);
    });
    return covered;
}

function linkPreviewKind(url) {
    const gif = giphyGifUrl(url);
    if (gif) return { kind: 'image', src: gif };
    let path = '';
    try {
        path = new URL(url).pathname || '';
    } catch (e) {
        return null;
    }
    if (LINK_VID_RE.test(path)) return { kind: 'video', src: url };
    if (LINK_IMG_RE.test(path) || LINK_FMT_RE.test(url)) {
        return { kind: 'image', src: url };
    }
    return null;
}

function showLinkPreviews(msg, element) {
    const urls = extractLinkUrls(msg.content);
    if (!urls.length) return;
    const covered = collectCoveredUrls(msg);
    const samePage = (u) => {
        const base = String(u).split('?')[0].split('#')[0];
        for (const c of covered) {
            if (String(c).split('?')[0].split('#')[0] === base) return true;
        }
        return false;
    };
    let shown = 0;
    for (const url of urls) {
        if (shown >= MAX_LINK_PREVIEWS) break;
        const found = linkPreviewKind(url);
        if (!found) continue;
        // Discord already unfurled this one (embed/attachment): skip it.
        if (covered.has(url) || covered.has(found.src) || samePage(url)) continue;
        const wrap = document.createElement('div');
        wrap.className = 'linkPreview';
        if (found.kind === 'video') {
            const vid = document.createElement('video');
            vid.className = 'linkPreview-vid';
            vid.src = found.src;
            vid.setAttribute('controls', 'true');
            vid.setAttribute('preload', 'metadata');
            vid.setAttribute('playsinline', 'true');
            vid.onerror = () => wrap.remove();
            wrap.appendChild(vid);
        } else {
            const link = document.createElement('a');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noreferrer noopener';
            const holder = document.createElement('span');
            holder.className = 'linkWrap';
            const img = document.createElement('img');
            img.className = 'linkPreview-img';
            img.src = found.src;
            img.alt = url;
            img.loading = 'lazy';
            img.onerror = () => wrap.remove();
            holder.appendChild(img);
            if (/\.gif([?#]|$)/i.test(found.src)) {
                const badge = document.createElement('span');
                badge.className = 'gifBadge';
                badge.textContent = 'GIF';
                holder.appendChild(badge);
            }
            link.appendChild(holder);
            wrap.appendChild(link);
        }
        element.appendChild(wrap);
        shown++;
    }
}

// Website unfurls, Discord/WhatsApp-style: bare page links get a small card
// with the site name, title, description and preview image. Metadata is
// fetched server-side via /api/unfurl (browsers would block the
// cross-origin read). Media links and links Discord already unfurled into
// embeds/attachments are skipped so nothing renders twice.
const MAX_LINK_EMBEDS = 2;
const UnfurlCache = new Map(); // url -> data | null (empty/failed)
const UnfurlPending = new Map(); // url -> in-flight promise

// Brand mark for imageless pages. `longlogo.svg` wins when present, with the
// bundled wide logo as fallback — probed once, then cached.
const BRAND_LOGO_CANDIDATES = [
    '/resources/icons/longlogo.svg',
    '/resources/icons/logoLarge.svg',
];
let BrandLogoUrl = '/resources/icons/logoLarge.svg';
let brandLogoProbed = false;

function probeBrandLogo() {
    if (brandLogoProbed) return;
    brandLogoProbed = true;
    try {
        const img = new Image();
        img.onload = () => {
            BrandLogoUrl = BRAND_LOGO_CANDIDATES[0];
        };
        img.onerror = () => {
            /* keep the bundled logo */
        };
        img.src = BRAND_LOGO_CANDIDATES[0];
    } catch (e) {
        /* ignore */
    }
}

function unfurlFor(url) {
    if (UnfurlCache.has(url)) return Promise.resolve(UnfurlCache.get(url));
    if (UnfurlPending.has(url)) return UnfurlPending.get(url);
    const p = Api.unfurl(url)
        .then((data) => {
            const usable =
                data && (data.title || data.description || data.image) ? data : null;
            if (UnfurlCache.size > 150) UnfurlCache.clear();
            UnfurlCache.set(url, usable);
            return usable;
        })
        .catch(() => {
            if (UnfurlCache.size > 150) UnfurlCache.clear();
            UnfurlCache.set(url, null);
            return null;
        });
    p.finally(() => {
        UnfurlPending.delete(url);
    }).catch(() => {});
    UnfurlPending.set(url, p);
    return p;
}

function renderLinkEmbed(data, element) {
    let origin = '';
    try {
        origin = new URL(data.url).origin;
    } catch (e) {
        /* ignore */
    }
    const card = document.createElement('div');
    card.className = 'embed linkEmbed';

    if (data.site) {
        const prov = document.createElement('p');
        prov.className = 'embedContent embedProviderName linkEmbedProv';
        const favSrc = data.icon || (origin ? origin + '/favicon.ico' : null);
        if (favSrc) {
            const fav = document.createElement('img');
            fav.className = 'embedFavicon';
            fav.src = favSrc;
            fav.alt = '';
            fav.loading = 'lazy';
            fav.draggable = false;
            fav.onerror = () => fav.remove();
            prov.appendChild(fav);
        }
        prov.appendChild(document.createTextNode(data.site));
        card.appendChild(prov);
    }

    const main = document.createElement('div');
    main.className = 'linkEmbedMain';
    card.appendChild(main);

    const texts = document.createElement('div');
    texts.className = 'linkEmbedTexts';
    main.appendChild(texts);

    const title = document.createElement('a');
    title.className = 'embedTitle';
    title.href = data.url;
    title.target = '_blank';
    title.rel = 'noreferrer noopener';
    title.textContent = data.title || data.site || data.url;
    texts.appendChild(title);

    if (data.description) {
        const desc = document.createElement('p');
        desc.className = 'embedDescription embedContent';
        desc.textContent = data.description;
        texts.appendChild(desc);
    }

    const thumb = document.createElement('img');
    const branded = !data.image;
    thumb.className = 'linkEmbedThumb' + (branded ? ' linkEmbedBrand' : '');
    thumb.src = data.image || BrandLogoUrl;
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.draggable = false;
    if (branded) {
        // brand art missing: fall back to a text-only card
        thumb.onerror = () => thumb.remove();
    } else {
        // dead site image: swap in the brand mark instead of dropping the card
        thumb.onerror = () => {
            thumb.onerror = () => thumb.remove();
            thumb.classList.add('linkEmbedBrand');
            thumb.src = BrandLogoUrl;
        };
    }
    main.appendChild(thumb);

    element.appendChild(card);
}

function showLinkEmbeds(msg, element) {
    const urls = extractLinkUrls(msg.content);
    if (!urls.length) return;
    const covered = collectCoveredUrls(msg);
    const samePage = (u) => {
        const base = String(u).split('?')[0].split('#')[0];
        for (const c of covered) {
            if (String(c).split('?')[0].split('#')[0] === base) return true;
        }
        return false;
    };
    probeBrandLogo();
    let shown = 0;
    for (const url of urls) {
        if (shown >= MAX_LINK_EMBEDS) break;
        if (linkPreviewKind(url)) continue; // the media preview handles it
        if (covered.has(url) || samePage(url)) continue; // Discord unfurled it
        shown++;
        unfurlFor(url)
            .then((data) => {
                if (!data) return;
                try {
                    if (element.isConnected) renderLinkEmbed(data, element);
                } catch (e) {
                    /* ignore */
                }
            })
            .catch(() => {});
    }
}

// Attachments rendered with the same embed styles
function showAttachment(att, element) {
    if (!att) return;
    const ct = (att.content_type || '').toLowerCase();
    const name = (att.filename || '').toLowerCase();
    const isImg =
        ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
    const isVid =
        ct.startsWith('video/') || /\.(mp4|webm|mov|gifv)$/.test(name);
    const isAud =
        ct.startsWith('audio/') || /\.(mp3|wav|flac|ogg)$/.test(name);
    if (isImg) {
        showEmbed(
            { type: 'image', thumbnail: { proxy_url: att.proxy_url || att.url, url: att.url, width: att.width, height: att.height } },
            element
        );
    } else if (isVid) {
        showEmbed(
            { type: 'video', video: { url: att.url, width: att.width, height: att.height } },
            element
        );
    } else if (isAud) {
        const audio = document.createElement('audio');
        audio.src = att.url;
        audio.setAttribute('controls', 'true');
        element.appendChild(audio);
    } else {
        const link = document.createElement('a');
        link.href = att.url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.className = 'messageText';
        link.textContent = `📎 ${att.filename || att.url}`;
        element.appendChild(link);
    }
}
