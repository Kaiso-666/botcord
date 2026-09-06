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
