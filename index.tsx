import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, Forms, Menu, MessageStore, React, UserStore } from "@webpack/common";

const HIDDEN_ATTR = "data-vc-hidden";
const PLACEHOLDER_CLASS = "vc-hide-user-gifs-placeholder";
const STYLE_ID = "vc-hide-user-gifs-style";

const CURTAIN_CLASS = "vc-hide-curtain";
const CURTAIN_COVER_CLASS = "vc-hide-curtain-cover";
const CURTAIN_REVEAL_CLASS = "vc-hide-curtain-reveal";
const CURTAIN_HANDLE_CLASS = "vc-hide-curtain-handle";

const CURTAIN_GRAD_DOWN = "linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,0))";
const CURTAIN_GRAD_UP = "linear-gradient(to top, rgba(0,0,0,.55), rgba(0,0,0,0))";

// plugin settings
const settings = definePluginSettings({
    blockedUrls: {
        type: OptionType.STRING,
        description: "Media hidden by this plugin.",
        default: ""
    },
    dragToPeek: {
        type: OptionType.BOOLEAN,
        description: "Drag down on a placeholder to peek at the media.",
        default: true
    },
    autoplayGifs: {
        type: OptionType.BOOLEAN,
        description: "Play GIFs automatically while peeking.",
        default: true
    },
    doNotHideMyImages: {
        type: OptionType.BOOLEAN,
        description: "Keep images you send visible. This does not apply to GIFs or videos.",
        default: true,
        onChange: () => { scanHiddenMessages(); scanMessages(); }
    },
    placeholderUrl: {
        type: OptionType.STRING,
        description: "Custom placeholder image data.",
        default: "",
        hidden: true
    },
    placeholderImage: {
        type: OptionType.COMPONENT,
        description: "Choose what appears in place of hidden media.",
        component: () => {
            const [preview, setPreview] = React.useState<string | null>(settings.store.placeholderUrl || null);

            function pickFile() {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = "image/*";
                input.onchange = () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = e => {
                        const dataUrl = e.target?.result as string;
                        settings.store.placeholderUrl = dataUrl;
                        cachedPlaceholderSrc = dataUrl;
                        refreshPlaceholders();
                        setPreview(dataUrl);
                    };
                    reader.readAsDataURL(file);
                };
                input.click();
            }

            function clear() {
                settings.store.placeholderUrl = "";
                cachedPlaceholderSrc = null;
                refreshPlaceholders();
                setPreview(null);
            }

            return (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <div>
                        <Forms.FormTitle>Placeholder image</Forms.FormTitle>
                        <Forms.FormText>Choose an image to show in place of hidden media.</Forms.FormText>
                    </div>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <Button
                            size="small"
                            onClick={pickFile}
                        >
                            Choose image
                        </Button>
                        {preview && (
                            <Button
                                size="small"
                                variant="secondary"
                                onClick={clear}
                            >
                                Use default
                            </Button>
                        )}
                        {preview
                            ? <span style={{ color: "var(--text-positive, #3ba55c)", fontSize: "13px" }}>Custom image selected</span>
                            : <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>Using the default placeholder</span>
                        }
                    </div>
                    {preview && (
                        <img src={preview} alt="placeholder preview" style={{ maxWidth: "150px", maxHeight: "100px", borderRadius: "4px", objectFit: "contain" }} />
                    )}
                </div>
            );
        }
    }
});

const CHAT_MSG_PREFIX = "chat-messages___chat-messages-";
const NO_LIST_PREFIX  = "NO_LIST___";

const ALL_MSG_SELECTOR   = `[data-list-item-id^='${CHAT_MSG_PREFIX}'],[data-list-item-id^='${NO_LIST_PREFIX}']`;
const MEDIA_SELECTORS    = "[class*='embed'],[class*='imageWrapper'],[class*='mediaAttachmentsContainer'],[class*='visualMediaItemContainer'],[class*='oneByOneGrid'],[class*='mosaicItem'],[class*='attachment']";
const EMBED_SELECTORS    = "[class*='embed'],[class*='imageWrapper'],[class*='mediaAttachmentsContainer'],[class*='visualMediaItemContainer']";
const DIALOG_SELECTOR    = '[role="dialog"],[role="alertdialog"]';
const PREVIEW_DIALOG_SELECTOR = '[role="alertdialog"],[role="dialog"][data-dialog="modal"]';
const PICKER_SELECTOR = '[class*="expressionPicker" i],[class*="gifPicker" i],[id*="expression-picker" i]';

// clean up urls

const NORM_CACHE_MAX = 500;
const normCache      = new Map<string, string>();

function dropOldest(map: Map<any, any>) {
    map.delete(map.keys().next().value);
}

// discord uses different links for the same file
function cleanUrl(url: string): string {
    const cached = normCache.get(url);
    if (cached !== undefined) return cached;

    let result: string;
    try {
        const parsed = new URL(url);
        const host   = parsed.hostname.toLowerCase();
        const parts  = parsed.pathname.split("/").filter(Boolean);

        if (host.includes("discordapp.net") && parts[0] === "external") {
            const protoIdx = parts.findIndex(p => p === "https" || p === "http");
            if (protoIdx !== -1 && protoIdx + 1 < parts.length) {
                result = cleanUrl(`${parts[protoIdx]}://${parts[protoIdx + 1]}/${parts.slice(protoIdx + 2).join("/")}`);
            } else {
                result = host + "/" + parts.join("/");
            }
        } else if (host.includes("tenor.com") && parts.length >= 2) {
            result = "tenor.com/" + parts[0].replace(/AAA..$/i, "").toLowerCase();
        } else if (host.includes("giphy.com") && parts.length >= 2) {
            result = "giphy.com/" + parts[parts.length - 2].toLowerCase();
        } else if (parts[0] === "attachments" && parts.length >= 4) {
            result = parts.join("/").toLowerCase();
        } else {
            result = host + "/" + parts.join("/");
        }
    } catch {
        result = url;
    }

    if (normCache.size >= NORM_CACHE_MAX) dropOldest(normCache);
    normCache.set(url, result);
    return result;
}

function getFileName(url: string): string {
    const canon = cleanUrl(url);
    const slash  = canon.lastIndexOf("/");
    return slash === -1 ? canon : canon.slice(slash + 1);
}

const GIF_HOST_RE  = /(?:tenor|giphy)\.com/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|avif|bmp|tiff?)$/i;
const GIF_EXT_RE   = /\.gif$/i;
const VIDEO_EXT_RE = /\.(?:mp4|webm|mov|m4v|ogv)$/i;

function isGifUrl(url: string): boolean {
    const canon = cleanUrl(url);
    return GIF_HOST_RE.test(canon) || GIF_EXT_RE.test(canon) || canon.endsWith("giphy.mp4");
}

function isImageUrl(url: string): boolean {
    return IMAGE_EXT_RE.test(cleanUrl(url));
}

function skipOwnImage(url: string, isOwn: boolean): boolean {
    return isOwn && settings.store.doNotHideMyImages && isImageUrl(url);
}


function makeBlockKey(userId: string, url: string): string {
    const filename = getFileName(url);
    return isGifUrl(url) ? filename : `${userId}:${filename}`;
}

// avoids splitting the settings string for every image
let blockedUrlCache = new Set<string>();
let blockedFilenames = new Set<string>();

function updateBlockedFiles() {
    blockedFilenames.clear();
    for (const key of blockedUrlCache) {
        const colon = key.indexOf(":");
        blockedFilenames.add(colon === -1 ? key : key.slice(colon + 1));
    }
}

// keeps blocks from older versions working
function fixOldKey(key: string): string {
    let prefix = "", rest = key;
    const colon = key.indexOf(":");
    if (colon > 0 && /^\d+$/.test(key.slice(0, colon))) { prefix = key.slice(0, colon + 1); rest = key.slice(colon + 1); }

    // old tenor links
    let m = rest.match(/tenor\.com\/([^/]+)\/[^/]+$/i);
    if (m) return prefix + "tenor.com/" + m[1].replace(/aaa..$/i, "").toLowerCase();

    // old giphy links
    m = rest.match(/giphy\.com\/(?:.*\/)?([^/]+)\/giphy\.[^/]+$/i);
    if (m) return prefix + "giphy.com/" + m[1].toLowerCase();

    return key;
}

function loadBlockedMedia() {
    const raw = settings.store.blockedUrls.split(",").map((s: string) => s.trim()).filter(Boolean);
    const migrated = raw.map(fixOldKey);
    blockedUrlCache = new Set(migrated);
    const joined = [...blockedUrlCache].join(",");
    if (joined !== settings.store.blockedUrls) settings.store.blockedUrls = joined;
    updateBlockedFiles();
}

function saveBlockedMedia(keys: Set<string>) {
    blockedUrlCache = keys;
    settings.store.blockedUrls = [...keys].join(",");
    updateBlockedFiles();
}

function isMediaBlocked(userId: string, urls: string[]): boolean {
    for (const u of urls) if (blockedUrlCache.has(makeBlockKey(userId, u))) return true;
    return false;
}

function blockMedia(userId: string, rawUrls: string[]) {
    const next = new Set(blockedUrlCache);
    for (const u of rawUrls) next.add(makeBlockKey(userId, u));
    saveBlockedMedia(next);
    scanMessages();
}

function unblockMedia(userId: string, rawUrls: string[]) {
    const next = new Set(blockedUrlCache);
    for (const u of rawUrls) next.delete(makeBlockKey(userId, u));
    saveBlockedMedia(next);
    scanHiddenMessages();
}

const SEARCH_CACHE_MAX  = 200;
// search messages aren't always in the normal message store
const searchMessageCache = new Map<string, any>();

function saveSearchMessage(id: string, msg: any) {
    if (searchMessageCache.size >= SEARCH_CACHE_MAX) dropOldest(searchMessageCache);
    searchMessageCache.set(id, msg);
}

function getMediaUrls(message: any): string[] {
    const urls: string[] = [];
    for (const att of message?.attachments ?? []) {
        if (att.url)       urls.push(att.url);
        if (att.proxy_url) urls.push(att.proxy_url);
    }
    for (const embed of message?.embeds ?? []) {
        if (embed.url)                urls.push(embed.url);
        if (embed.image?.url)         urls.push(embed.image.url);
        if (embed.image?.proxy_url)   urls.push(embed.image.proxy_url);
        if (embed.video?.url)         urls.push(embed.video.url);
        if (embed.thumbnail?.url)     urls.push(embed.thumbnail.url);
        if (embed.thumbnail?.proxy_url) urls.push(embed.thumbnail.proxy_url);
    }
    return urls;
}

function hasBlockedMedia(message: any): boolean {
    const authorId = message?.author?.id;
    if (!authorId) return false;
    const isOwn = authorId === UserStore.getCurrentUser()?.id;
    for (const u of getMediaUrls(message)) {
        if (skipOwnImage(u, isOwn)) continue;
        if (blockedUrlCache.has(makeBlockKey(authorId, u))) return true;
    }
    return false;
}

const CHANNEL_CACHE_MAX = 300;
const channelForMessage  = new Map<string, string>();

// tries the saved channel first, then searches the store
function findMessage(messageId: string): any | null {
    const cached = channelForMessage.get(messageId);
    if (cached) return MessageStore.getMessage(cached, messageId) ?? null;

    const store      = MessageStore as any;
    const channelMap = store._channelMessages ?? store.__channelMessages;
    if (!channelMap) return null;

    const entries = channelMap instanceof Map ? channelMap.entries() : Object.entries(channelMap);
    for (const [channelId] of entries) {
        const msg = MessageStore.getMessage(channelId, messageId);
        if (msg) {
            if (channelForMessage.size >= CHANNEL_CACHE_MAX) dropOldest(channelForMessage);
            channelForMessage.set(messageId, channelId);
            return msg;
        }
    }
    return null;
}

function getMessage(el: HTMLElement): any | null {
    const rawId = el.dataset.listItemId;
    if (!rawId) return null;

    if (rawId.startsWith(CHAT_MSG_PREFIX)) {
        const tail = rawId.slice(CHAT_MSG_PREFIX.length);
        const dash  = tail.lastIndexOf("-");
        if (dash < 0) return null;
        return MessageStore.getMessage(tail.slice(0, dash), tail.slice(dash + 1)) ?? null;
    }

    if (rawId.startsWith(NO_LIST_PREFIX)) {
        const messageId = rawId.slice(NO_LIST_PREFIX.length);
        return searchMessageCache.get(messageId) ?? findMessage(messageId);
    }

    return null;
}

function isMessageRow(id: string): boolean {
    return id.startsWith(CHAT_MSG_PREFIX) || id.startsWith(NO_LIST_PREFIX);
}

let cachedPlaceholderSrc: string | null | undefined = undefined;

function getPlaceholderSrc(): string | null {
    if (cachedPlaceholderSrc !== undefined) return cachedPlaceholderSrc;
    const raw = settings.store.placeholderUrl?.trim() || "";
    cachedPlaceholderSrc = raw || null;
    return cachedPlaceholderSrc;
}

const IF_IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|avif)$/i;
const IF_GIF_HOST_RE  = /^(.+?\.)?(tenor|giphy|imgur)\.com$/i;

function showFullUrl(): boolean {
    try {
        return !!(Vencord as any).Settings?.plugins?.ImageFilename?.showFullUrl;
    } catch {
        return false;
    }
}

function getMediaTitle(src: string): string {
    try {
        const url   = new URL(src);
        const isGif = IF_GIF_HOST_RE.test(url.hostname);
        if (isGif || showFullUrl()) return src;
        if (IF_IMAGE_EXT_RE.test(url.pathname)) return url.pathname.split("/").pop() || src;
        return src;
    } catch {
        return src;
    }
}

function getPlaceholderTitle(message: any): string | undefined {
    const authorId = message?.author?.id;
    if (!authorId) return undefined;
    const isOwn = authorId === UserStore.getCurrentUser()?.id;

    const candidates: string[] = [];
    for (const att of message?.attachments ?? []) {
        const u = att.url || att.proxy_url;
        if (u) candidates.push(u);
    }
    for (const embed of message?.embeds ?? []) {
        const u = embed.url || embed.image?.url || embed.video?.url || embed.thumbnail?.url;
        if (u) candidates.push(u);
    }

    for (const u of candidates) {
        if (skipOwnImage(u, isOwn)) continue;
        if (blockedUrlCache.has(makeBlockKey(authorId, u))) return getMediaTitle(u);
    }
    return undefined;
}

interface RevealSource { src: string; kind: "image" | "gif" | "video"; nw?: number; nh?: number; poster?: string; }

interface ImgCandidate { u: string; w?: number; h?: number; poster?: string; }

interface PlaceholderDims { w: number; h: number; }

// finds the file that goes behind the cover
function getRevealMedia(message: any): RevealSource | undefined {
    const authorId = message?.author?.id;
    if (!authorId) return undefined;

    const img: ImgCandidate[] = [];
    const gifVid: ImgCandidate[] = [];
    const vidFile: ImgCandidate[] = [];

    const addImg = (u?: string, w?: number, h?: number) => {
        if (!u) return;
        const canon = cleanUrl(u);
        if (GIF_EXT_RE.test(canon) || IMAGE_EXT_RE.test(canon)) img.push({ u, w, h });
    };

    for (const att of message?.attachments ?? []) {
        if (att.content_type?.startsWith("video/") || VIDEO_EXT_RE.test(cleanUrl(att.url || att.proxy_url || ""))) {
            const poster = att.placeholder ? `data:image/jpeg;base64,${att.placeholder}` : undefined;
            if (att.proxy_url) vidFile.push({ u: att.proxy_url, w: att.width, h: att.height, poster });
            if (att.url)       vidFile.push({ u: att.url, w: att.width, h: att.height, poster });
        } else {
            addImg(att.proxy_url, att.width, att.height);
            addImg(att.url,       att.width, att.height);
        }
    }
    for (const embed of message?.embeds ?? []) {
        const vid = embed.video;
        if (vid) {
            const poster = embed.thumbnail?.proxy_url || embed.thumbnail?.url;
            if (embed.type === "gifv") {
                if (vid.proxy_url) gifVid.push({ u: vid.proxy_url, w: vid.width, h: vid.height, poster });
                if (vid.url)       gifVid.push({ u: vid.url, w: vid.width, h: vid.height, poster });
            } else if (VIDEO_EXT_RE.test(cleanUrl(vid.proxy_url || vid.url || ""))) {
                if (vid.proxy_url) vidFile.push({ u: vid.proxy_url, w: vid.width, h: vid.height, poster });
                if (vid.url)       vidFile.push({ u: vid.url, w: vid.width, h: vid.height, poster });
            }
        }
        addImg(embed.image?.proxy_url,     embed.image?.width,     embed.image?.height);
        addImg(embed.image?.url,           embed.image?.width,     embed.image?.height);
        addImg(embed.thumbnail?.proxy_url, embed.thumbnail?.width, embed.thumbnail?.height);
        addImg(embed.thumbnail?.url,       embed.thumbnail?.width, embed.thumbnail?.height);
    }

    const blocked = (u: string) => blockedUrlCache.has(makeBlockKey(authorId, u));
    const pick = (c: ImgCandidate, kind: RevealSource["kind"]): RevealSource => ({ src: c.u, kind, nw: c.w, nh: c.h, poster: c.poster });

    for (const c of gifVid)  if (blocked(c.u)) return pick(c, "gif");
    for (const c of vidFile) if (blocked(c.u)) return pick(c, "video");
    for (const c of img)     if (blocked(c.u)) return pick(c, "image");
    return undefined;
}

const META_MAX_W = 550, META_MAX_H = 350;
function fitSize(nw: number, nh: number): PlaceholderDims {
    const scale = Math.min(1, META_MAX_W / nw, META_MAX_H / nh);
    return { w: Math.round(nw * scale), h: Math.round(nh * scale) };
}

function sameShape(a: PlaceholderDims, b: { w: number; h: number }): boolean {
    return Math.abs(a.w / a.h - b.w / b.h) / (b.w / b.h) <= 0.1;
}

const MEASURED_DIMS_MAX = 300;
const measuredDimsCache  = new Map<string, PlaceholderDims>();
function saveSize(key: string, dims: PlaceholderDims) {
    if (measuredDimsCache.size >= MEASURED_DIMS_MAX) dropOldest(measuredDimsCache);
    measuredDimsCache.set(key, dims);
}

function isGoodSize(dims: PlaceholderDims, nat?: { w: number; h: number }): boolean {
    if (dims.w < 1 || dims.h < 1) return false;
    if (!nat) return true;
    if (!sameShape(dims, nat)) return false;

    const expected = fitSize(nat.w, nat.h);
    return dims.w >= Math.min(96, expected.w * 0.35)
        && dims.h >= Math.min(96, expected.h * 0.35);
}

// the wrapper stays more stable while images load
function measureMedia(container: HTMLElement, nat?: { w: number; h: number }): PlaceholderDims | undefined {
    if (!nat) {
        const el = container.querySelector<HTMLElement>("img,video,canvas") ?? container;
        const r  = el.getBoundingClientRect();
        return r.width >= 1 && r.height >= 1 ? { w: Math.round(r.width), h: Math.round(r.height) } : undefined;
    }
    let best: PlaceholderDims | undefined;
    const checkEl = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        if (!sameShape({ w: r.width, h: r.height }, nat!)) return;
        if (!best || r.width * r.height > best.w * best.h) best = { w: Math.round(r.width), h: Math.round(r.height) };
    };
    checkEl(container);
    for (const el of container.querySelectorAll("*")) checkEl(el);
    return best;
}

// reuse a good size so the message doesn't jump around
function getPlaceholderSize(measured: PlaceholderDims | undefined, reveal?: RevealSource): PlaceholderDims | undefined {
    const key    = reveal ? cleanUrl(reveal.src) : undefined;
    const nat    = reveal?.nw && reveal?.nh ? { w: reveal.nw, h: reveal.nh } : undefined;
    const cached = key ? measuredDimsCache.get(key) : undefined;
    if (cached) {
        if (isGoodSize(cached, nat)) return cached;
        measuredDimsCache.delete(key!);
    }
    if (measured && isGoodSize(measured, nat)) {
        if (key) saveSize(key, measured);
        return measured;
    }
    return nat ? fitSize(nat.w, nat.h) : undefined;
}

// the hidden file gets added when the cover is first dragged
function addCurtain(cover: HTMLElement, reveal: RevealSource, dims?: PlaceholderDims): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `${PLACEHOLDER_CLASS} ${CURTAIN_CLASS}`;

    cover.classList.add(CURTAIN_COVER_CLASS);

    const size = dims ?? (reveal.nw && reveal.nh ? fitSize(reveal.nw, reveal.nh) : { w: 200, h: 150 });
    wrapper.style.width = `${size.w}px`;
    wrapper.style.height = `${size.h}px`;
    cover.style.position = "absolute";
    cover.style.inset = "0";
    cover.style.width = "100%";
    cover.style.height = "100%";
    cover.style.boxSizing = "border-box";
    cover.style.objectFit = "cover";

    if (cover instanceof HTMLDivElement) {
        cover.style.display = "flex";
        cover.style.alignItems = "center";
        cover.style.justifyContent = "center";
        cover.style.background = "var(--background-secondary)";
    }

    const handle = document.createElement("div");
    handle.className = CURTAIN_HANDLE_CLASS;

    wrapper.append(cover, handle);

    let revealEl: HTMLElement | null = null;
    let revealPx = 0;
    let startY   = 0;
    let startPx  = 0;
    let height   = 0;
    let dragging = false;

    height = size.h;

    const HANDLE_H = 18;
    let atBottomState: boolean | null = null;
    const apply = () => {
        cover.style.transform = `translateY(${revealPx}px)`;
        const maxTop = (height || wrapper.clientHeight) - HANDLE_H;
        const top    = Math.max(0, Math.min(revealPx, maxTop));
        handle.style.top = `${top}px`;
        const atBottom = top >= maxTop - 0.5;
        if (atBottom !== atBottomState) {
            atBottomState = atBottom;
            handle.style.background   = atBottom ? CURTAIN_GRAD_UP : CURTAIN_GRAD_DOWN;
            handle.style.borderRadius = atBottom ? "0 0 4px 4px" : "4px 4px 0 0";
        }
    };

    let rafPending = false;
    const scheduleApply = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; apply(); });
    };

    const ensureReveal = () => {
        if (revealEl) return;
        if (reveal.kind === "image") {
            const img = new Image();
            img.src  = reveal.src;
            revealEl = img;
        } else {
            const v = document.createElement("video");
            v.src         = reveal.src;
            v.playsInline = true;
            v.setAttribute("playsinline", "");
            if (reveal.poster) v.poster = reveal.poster;
            if (reveal.kind === "gif" && settings.store.autoplayGifs) {
                v.autoplay = true;
                v.loop     = true;
                v.muted    = true;
            } else {
                if (reveal.kind === "gif") { v.loop = true; v.muted = true; }
                v.autoplay = false;
                v.preload  = "auto";
                v.controls = true;
                v.addEventListener("canplay", () => {
                    v.muted = true;
                    v.play().then(() => { v.pause(); v.muted = false; }).catch(() => {});
                }, { once: true });
            }
            revealEl = v;
        }
        revealEl.className = CURTAIN_REVEAL_CLASS;
        wrapper.insertBefore(revealEl, cover);
    };

    handle.addEventListener("pointerdown", e => {
        e.preventDefault();
        e.stopPropagation();
        ensureReveal();
        startY   = e.clientY;
        startPx  = revealPx;
        height   = wrapper.clientHeight;
        dragging = true;
        try { handle.setPointerCapture(e.pointerId); } catch {}
    });
    handle.addEventListener("pointermove", e => {
        if (!dragging) return;
        revealPx = Math.max(0, Math.min(height, startPx + (e.clientY - startY)));
        scheduleApply();
    });
    const end = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch {}
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("dblclick", e => {
        e.stopPropagation();
        revealPx = 0;
        apply();
    });

    if (reveal.kind !== "image") ensureReveal();

    return wrapper;
}

function makePlaceholder(title?: string, reveal?: RevealSource, dims?: PlaceholderDims): HTMLElement {
    const src = getPlaceholderSrc();
    const cover: HTMLElement = src
        ? Object.assign(document.createElement("img"), { src })
        : Object.assign(document.createElement("div"), { textContent: "Hidden media" });
    cover.className = PLACEHOLDER_CLASS;
    if (title) cover.title = title;

    if (settings.store.dragToPeek && reveal) return addCurtain(cover, reveal, dims);

    if (dims) {
        cover.style.width  = `${dims.w}px`;
        cover.style.height = `${dims.h}px`;
        if (src) cover.style.objectFit = "cover";
    }
    return cover;
}

function refreshPlaceholders() {
    for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`)) {
        const next = el.nextElementSibling;
        if (next?.classList.contains(PLACEHOLDER_CLASS)) next.remove();
        el.removeAttribute(HIDDEN_ATTR);
    }
    for (const el of document.querySelectorAll(`.${PLACEHOLDER_CLASS}`)) el.remove();
    scanMessages();
}

async function loadPlaceholderImage(rescan = true) {
    const src = getPlaceholderSrc();
    if (src) {
        try {
            const img = new Image();
            await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = src; });
        } catch {
            cachedPlaceholderSrc = null;
        }
    }
    if (rescan) refreshPlaceholders();
}


// mark the message because discord replaces image elements while scrolling
function hideMessageMedia(messageEl: HTMLElement, message?: any) {
    const hasPlaceholder = !!messageEl.querySelector(`.${PLACEHOLDER_CLASS}`);
    const firstMedia     = hasPlaceholder ? null : messageEl.querySelector<HTMLElement>(MEDIA_SELECTORS);

    const title  = !hasPlaceholder && message ? getPlaceholderTitle(message) : undefined;
    const reveal = !hasPlaceholder && message ? getRevealMedia(message) : undefined;
    const nat    = reveal?.nw && reveal?.nh ? { w: reveal.nw, h: reveal.nh } : undefined;

    const measured = firstMedia ? measureMedia(firstMedia, nat) : undefined;

    messageEl.setAttribute(HIDDEN_ATTR, "");

    if (hasPlaceholder || !firstMedia) return;
    const dims = getPlaceholderSize(measured, reveal);
    firstMedia.insertAdjacentElement("afterend", makePlaceholder(title, reveal, dims));
}

function showMessageMedia(messageEl: HTMLElement) {
    messageEl.removeAttribute(HIDDEN_ATTR);
    for (const ph of messageEl.querySelectorAll(`.${PLACEHOLDER_CLASS}`)) ph.remove();
}

// popup previews
const PREVIEW_HIDDEN_ATTR = "data-vc-preview-hidden";

function hideDialogMedia(root: HTMLElement) {
    for (const msgEl of root.querySelectorAll<HTMLElement>(ALL_MSG_SELECTOR)) {
        if (msgEl.hasAttribute(HIDDEN_ATTR)) continue;
        const message = getMessage(msgEl);
        if (!message || !hasBlockedMedia(message)) continue;
        msgEl.setAttribute(HIDDEN_ATTR, "");
    }
}

function hidePreviewMedia(root: HTMLElement, inDialog = false) {
    if (blockedFilenames.size === 0) return;
    for (const el of root.querySelectorAll<HTMLElement>("img,video")) {
        if (el.hasAttribute(PREVIEW_HIDDEN_ATTR)) continue;
        if (el.closest(`.${PLACEHOLDER_CLASS}`)) continue;
        if (!inDialog && el.closest(`[${HIDDEN_ATTR}]`)) continue;
        if (!inDialog && el.closest("[data-list-item-id]")) continue;
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute("src") || "";
        if (!src || !blockedFilenames.has(getFileName(src))) continue;

        el.setAttribute(PREVIEW_HIDDEN_ATTR, "");
        const r    = el.getBoundingClientRect();
        const dims = r.width >= 1 && r.height >= 1 ? { w: Math.round(r.width), h: Math.round(r.height) } : undefined;
        el.style.display = "none";
        el.insertAdjacentElement("afterend", makePlaceholder(undefined, undefined, dims));
    }
}

// gif picker
const PICKER_CELL_SELECTOR = '[class*="gridItem" i],[class*="result" i],[role="button"],[role="gridcell"]';

function hidePickerMedia(root: HTMLElement) {
    if (blockedUrlCache.size === 0) return;
    const els = root.matches("img,video") ? [root] : [...root.querySelectorAll<HTMLElement>("img,video")];
    for (const el of els) {
        if (el.hasAttribute(PREVIEW_HIDDEN_ATTR)) continue;
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute("src") || "";
        if (!src || !blockedUrlCache.has(getFileName(src))) continue;

        el.setAttribute(PREVIEW_HIDDEN_ATTR, "");
        el.style.visibility = "hidden";

        const cell = el.closest<HTMLElement>(PICKER_CELL_SELECTOR) ?? el.parentElement ?? el;
        if (getComputedStyle(cell).position === "static") cell.style.position = "relative";

        const phSrc = getPlaceholderSrc();
        const ph: HTMLElement = phSrc
            ? Object.assign(document.createElement("img"), { src: phSrc })
            : Object.assign(document.createElement("div"), { textContent: "Hidden media" });
        ph.className = PLACEHOLDER_CLASS;
        ph.style.cssText = "position:absolute; inset:0; width:100%; height:100%; object-fit:cover; pointer-events:none; border-radius:4px; z-index:1;";
        cell.appendChild(ph);
    }
}

// set this to true when something isn't hiding and i need to check why
const DEBUG = false;
const log = (...args: any[]) => { if (DEBUG) console.log("[HideMedia]", ...args); };

function checkMessage(messageEl: HTMLElement, allowUnhide = false): boolean {
    const message = getMessage(messageEl);
    if (!message) {
        log("unresolved", messageEl.dataset.listItemId);
        return false;
    }
    if (hasBlockedMedia(message)) {
        hideMessageMedia(messageEl, message);
        log("HIDE", message.id);
    } else {
        if (DEBUG) {
            const urls = getMediaUrls(message);
            if (urls.length) {
                const authorId = message.author?.id ?? "";
                log("NOT blocked", message.id, "author", authorId, urls.map(u => ({
                    url: u,
                    key: makeBlockKey(authorId, u),
                    inCache: blockedUrlCache.has(makeBlockKey(authorId, u))
                })));
            }
        }
        if (allowUnhide) {
            showMessageMedia(messageEl);
            log("unhide", message.id);
        }
    }
    return true;
}

// message data can show up a few frames after the element
function checkMessageSoon(messageEl: HTMLElement, attempt = 0) {
    if (!messageEl.isConnected) return;
    if (checkMessage(messageEl)) return;
    if (attempt < 20) requestAnimationFrame(() => checkMessageSoon(messageEl, attempt + 1));
}

function scanMessages() {
    for (const el of document.querySelectorAll<HTMLElement>(ALL_MSG_SELECTOR))
        checkMessageSoon(el);
}

function scanHiddenMessages() {
    for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))
        checkMessage(el, true);
}

// catches messages and picker rows added after startup
function checkNewNodes(mutations: MutationRecord[]) {
    if (blockedUrlCache.size === 0) return;

    const toProcess   = new Set<HTMLElement>();
    const dialogsSeen = new Set<HTMLElement>();
    const pickersToHide = new Set<HTMLElement>();

    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.classList.contains(PLACEHOLDER_CLASS)) continue;

            const nodeInDialog = node.closest<HTMLElement>(DIALOG_SELECTOR);

            const alertDialog = node.closest<HTMLElement>(PREVIEW_DIALOG_SELECTOR)
                ?? node.querySelector<HTMLElement>(PREVIEW_DIALOG_SELECTOR);
            if (alertDialog) dialogsSeen.add(alertDialog);

            if (node.closest(PICKER_SELECTOR)) pickersToHide.add(node);
            else { const p = node.querySelector<HTMLElement>(PICKER_SELECTOR); if (p) pickersToHide.add(p); }

            if (isMessageRow(node.dataset?.listItemId ?? "")) {
                if (!nodeInDialog) toProcess.add(node);
                continue;
            }

            for (const el of node.querySelectorAll<HTMLElement>(ALL_MSG_SELECTOR))
                if (!el.closest(DIALOG_SELECTOR)) toProcess.add(el);

            if (node.matches(MEDIA_SELECTORS) || node.querySelector(MEDIA_SELECTORS)) {
                const msgEl = node.closest<HTMLElement>(ALL_MSG_SELECTOR);
                if (msgEl && !msgEl.closest(DIALOG_SELECTOR)) toProcess.add(msgEl);
            }
        }
    }

    const retryHideDialog = (d: HTMLElement, n = 0) => {
        if (!d.isConnected) return;
        hidePreviewMedia(d, true);
        hideDialogMedia(d);
        if (n < 20) requestAnimationFrame(() => retryHideDialog(d, n + 1));
    };
    for (const d of dialogsSeen) retryHideDialog(d);

    const retryHidePicker = (p: HTMLElement, n = 0) => {
        if (!p.isConnected) return;
        hidePickerMedia(p);
        if (n < 8) requestAnimationFrame(() => retryHidePicker(p, n + 1));
    };
    for (const p of pickersToHide) retryHidePicker(p);

    if (toProcess.size === 0) return;
    if (DEBUG) log("mutation → processing", toProcess.size, "message(s); cache:", [...blockedUrlCache]);

    for (const el of toProcess)
        for (const ph of el.querySelectorAll<HTMLElement>(`.${PLACEHOLDER_CLASS}`))
            if (!ph.closest(`[${HIDDEN_ATTR}]`)) ph.remove();

    for (const el of toProcess) checkMessageSoon(el);
}

function checkMessageUpdate({ message }: any) {
    if (!message?.id || !message?.channel_id) return;
    if (blockedUrlCache.size === 0) return;

    const authorId = message?.author?.id;
    if (!authorId) return;

    const isOwn = authorId === UserStore.getCurrentUser()?.id;
    const hasBlocked = getMediaUrls(message).some(
        u => !skipOwnImage(u, isOwn) && blockedUrlCache.has(makeBlockKey(authorId, u))
    );
    if (!hasBlocked) return;

    const els = document.querySelectorAll<HTMLElement>(
        `[data-list-item-id='${CHAT_MSG_PREFIX}${message.channel_id}-${message.id}'],` +
        `[data-list-item-id='${NO_LIST_PREFIX}${message.id}']`
    );
    if (els.length === 0) return;

    for (const el of els) {
        hideMessageMedia(el, message);
        let attempts = 0;
        const ensurePlaceholder = () => {
            if (!el.isConnected) return;
            if (el.querySelector(EMBED_SELECTORS)) {
                hideMessageMedia(el, message);
            } else if (++attempts < 30) {
                requestAnimationFrame(ensurePlaceholder);
            }
        };
        requestAnimationFrame(ensurePlaceholder);
    }
}

let xhrOpenOrig: typeof XMLHttpRequest.prototype.open | null = null;
let xhrSendOrig: typeof XMLHttpRequest.prototype.send | null = null;

// save search results when they come back from discord
function watchSearchResults() {
    xhrOpenOrig = XMLHttpRequest.prototype.open;
    xhrSendOrig = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(this: any, method: string, url: string, ...rest: any[]) {
        this._vc_url = url;
        return (xhrOpenOrig as Function).call(this, method, url, ...rest);
    } as any;

    XMLHttpRequest.prototype.send = function(this: any, ...args: any[]) {
        if (this._vc_url?.includes("/messages/search")) {
            this.addEventListener("load", function(this: XMLHttpRequest) {
                try {
                    const data = JSON.parse(this.responseText);
                    for (const group of data?.messages ?? [])
                        for (const msg of group)
                            if (msg?.id) saveSearchMessage(msg.id, msg);
                    for (const el of document.querySelectorAll<HTMLElement>(`[data-list-item-id^='${NO_LIST_PREFIX}']`))
                        checkMessage(el);
                } catch {}
            });
        }
        return xhrSendOrig!.call(this, ...args);
    } as any;
}

function stopWatchingSearch() {
    if (xhrOpenOrig) XMLHttpRequest.prototype.open = xhrOpenOrig;
    if (xhrSendOrig) XMLHttpRequest.prototype.send = xhrSendOrig;
    xhrOpenOrig = xhrSendOrig = null;
}

// right click menu
const messageContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const message  = props?.message;
    const authorId = message?.author?.id;
    if (!authorId) return;

    const isOwn = authorId === UserStore.getCurrentUser()?.id;
    const mediaUrls = getMediaUrls(message).filter(u => !skipOwnImage(u, isOwn));
    if (mediaUrls.length === 0) return;

    const blocked = isMediaBlocked(authorId, mediaUrls);

    const menuItem = (
        <Menu.MenuItem
            id="vc-hide-gif-toggle"
            label={blocked ? "Unhide this media" : "Hide this media"}
            action={() => blocked ? unblockMedia(authorId, mediaUrls) : blockMedia(authorId, mediaUrls)}
        />
    );

    const group = findGroupChildrenByChildId("copy-text", children) ?? findGroupChildrenByChildId("copy-link", children);
    if (group) group.push(menuItem);
    else children.push(menuItem);
};

// start and stop
let observer: MutationObserver | null = null;

export default definePlugin({
    name: "HideMediaEverywhere",
    description: "Hide specific images, GIFs, and videos from the message context menu.",
    authors: [{ name: "t6rtar", id: 738215409559404562n }],

    settings,
    tags: ["Media", "Privacy", "Utility"],

    start() {
        Vencord.Api.ContextMenu.addContextMenuPatch("message", messageContextPatch);
        Vencord.Api.ContextMenu.addContextMenuPatch("image-context", messageContextPatch);
        loadBlockedMedia();
        cachedPlaceholderSrc = undefined;
        loadPlaceholderImage(false);

        const style       = document.createElement("style");
        style.id          = STYLE_ID;
        style.textContent = `
            [${HIDDEN_ATTR}] :is(${MEDIA_SELECTORS}) { display: none !important; }
            .${PLACEHOLDER_CLASS} { display: block; border-radius: 4px; }
            .${PLACEHOLDER_CLASS}:is(img) { width: 200px; height: auto; }
            .${PLACEHOLDER_CLASS}:is(div) { padding: 6px 10px; font-size: 12px; color: var(--text-muted); background: var(--background-secondary); width: fit-content; }

            /* Drag-to-peek curtain */
            .${PLACEHOLDER_CLASS}.${CURTAIN_CLASS} { position: relative; width: fit-content; padding: 0; background: none; overflow: hidden; }
            .${CURTAIN_REVEAL_CLASS} { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; z-index: 0; border-radius: 4px; background: var(--background-secondary); }
            .${CURTAIN_COVER_CLASS} { position: relative; z-index: 1; }
            .${CURTAIN_HANDLE_CLASS} { position: absolute; left: 0; right: 0; top: 0; height: 18px; z-index: 2; display: flex; align-items: center; justify-content: center; cursor: row-resize; background: linear-gradient(to bottom, rgba(0,0,0,.55), rgba(0,0,0,0)); border-radius: 4px 4px 0 0; touch-action: none; }
            .${CURTAIN_HANDLE_CLASS}::before { content: ""; width: 34px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.9); }
        `;
        document.head.appendChild(style);

        watchSearchResults();

        observer = new MutationObserver(checkNewNodes);
        observer.observe(document.body, { childList: true, subtree: true });

        FluxDispatcher.subscribe("MESSAGE_UPDATE",       checkMessageUpdate);
        FluxDispatcher.subscribe("MESSAGE_EMBED_UPDATE", checkMessageUpdate);

        scanMessages();
    },

    stop() {
        Vencord.Api.ContextMenu.removeContextMenuPatch("message", messageContextPatch);
        Vencord.Api.ContextMenu.removeContextMenuPatch("image-context", messageContextPatch);
        observer?.disconnect();
        observer = null;

        stopWatchingSearch();
        searchMessageCache.clear();
        channelForMessage.clear();
        normCache.clear();
        measuredDimsCache.clear();

        FluxDispatcher.unsubscribe("MESSAGE_UPDATE",       checkMessageUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_EMBED_UPDATE", checkMessageUpdate);

        document.getElementById(STYLE_ID)?.remove();

        for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))
            el.removeAttribute(HIDDEN_ATTR);
        for (const el of document.querySelectorAll<HTMLElement>(`[${PREVIEW_HIDDEN_ATTR}]`)) {
            el.style.removeProperty("display");
            el.removeAttribute(PREVIEW_HIDDEN_ATTR);
        }
        for (const el of document.querySelectorAll(`.${PLACEHOLDER_CLASS}`)) el.remove();
    }
});
