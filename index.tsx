import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, Forms, Menu, MessageStore, React } from "@webpack/common";

const HIDDEN_ATTR = "data-vc-hidden";
const MOSAIC_ATTR = "data-vc-hidden-mosaic";
const MOSAIC_MEDIA_ATTR = "data-vc-mosaic-media-hidden";
const MOSAIC_PLACEHOLDER_ATTR = "data-vc-mosaic-placeholder";
const MOSAIC_POSITION_ATTR = "data-vc-mosaic-position";
const MOSAIC_VISIBILITY_ATTR = "data-vc-mosaic-visibility";
const MOSAIC_URL_ATTR = "data-vc-mosaic-url";
const MOSAIC_MESSAGE_ATTR = "data-vc-mosaic-message";
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
    urlHashMap: {
        type: OptionType.STRING,
        description: "Cached image identities.",
        default: "",
        hidden: true
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
        } else if (host === "youtu.be" && parts[0]) {
            result = "youtube.com/" + parts[0];
        } else if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) {
            const videoId = parsed.searchParams.get("v")
                ?? (["embed", "live", "shorts"].includes(parts[0]) ? parts[1] : undefined);
            result = videoId ? "youtube.com/" + videoId : host + "/" + parts.join("/");
        } else if (host.includes("tenor.com") && parts.length > 0) {
            let tenorId: string;
            if (host === "media.tenor.com") {
                tenorId = parts[0].replace(/AAA..$/i, "");
            } else if (parts[0] === "view" && parts[1]) {
                tenorId = parts[1].match(/(?:gif-)?(\d+)$/i)?.[1] ?? parts[1];
            } else if (parts[0] === "m" && parts[1]) {
                tenorId = parts[1];
            } else {
                tenorId = parts[0];
            }
            result = "tenor.com/" + tenorId.toLowerCase();
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

function isDirectVideoUrl(url: string): boolean {
    try {
        return VIDEO_EXT_RE.test(new URL(url).pathname);
    } catch {
        return VIDEO_EXT_RE.test(url.split("?")[0]);
    }
}

function isImageUrl(url: string): boolean {
    return IMAGE_EXT_RE.test(cleanUrl(url));
}

function makeSignatureKey(urls: string[]): string {
    const signature = [...new Set(urls.map(cleanUrl))].sort().join("\n");
    return `v4:${encodeURIComponent(signature)}`;
}

function makeBlockKeys(urls: string[]): string[] {
    return [makeSignatureKey(urls)];
}

// avoids splitting the settings string for every image
let blockedUrlCache = new Set<string>();
let blockedCanonicalUrls = new Set<string>();
let blockedFileNames = new Set<string>();
// hashes catch the same image even when Discord changes its URL
let blockedHashes = new Set<string>();
let blockedHashFilters: Array<{ hash: string; size: number; width: number; height: number; }> = [];
const mediaHashes = new Map<string, string>();
const hashRequests = new Map<string, Promise<string | null>>();
const MEDIA_HASH_CACHE_MAX = 1500;
let hashSaveTimer: number | null = null;
let activeBlockCount = 0;

function updateBlockedFiles() {
    blockedCanonicalUrls.clear();
    blockedFileNames.clear();
    blockedHashes.clear();
    blockedHashFilters = [];
    activeBlockCount = 0;
    for (const key of blockedUrlCache) {
        const hashMatch = key.match(/^v4h:(?:(\d+):(\d+)x(\d+):)?([a-f0-9]{64})$/i);
        if (hashMatch) {
            activeBlockCount++;
            const hash = hashMatch[4].toLowerCase();
            blockedHashes.add(hash);
            blockedHashFilters.push({
                hash,
                size: Number(hashMatch[1] ?? 0),
                width: Number(hashMatch[2] ?? 0),
                height: Number(hashMatch[3] ?? 0)
            });
            continue;
        }

        const match = key.match(/^v4:(.+)$/);
        if (match) {
            activeBlockCount++;
            try {
                for (const url of decodeURIComponent(match[1]).split("\n"))
                    if (url) blockedCanonicalUrls.add(url);
            } catch {}
            continue;
        }

        const fileMatch = key.match(/^v4f:(.+)$/);
        if (fileMatch) {
            activeBlockCount++;
            try { blockedFileNames.add(decodeURIComponent(fileMatch[1]).toLowerCase()); } catch {}
        }
    }
}

function removeCoveredBlockKeys(keys: Set<string>): Set<string> {
    const globalNames = new Set<string>();
    for (const key of keys) {
        const match = key.match(/^v4f:(.+)$/);
        if (!match) continue;
        try { globalNames.add(decodeURIComponent(match[1]).toLowerCase()); } catch {}
    }

    return new Set([...keys].filter(key => {
        const urlMatch = key.match(/^v4:(.+)$/);
        if (!urlMatch) return true;
        try {
            return !decodeURIComponent(urlMatch[1]).split("\n")
                .some(url => globalNames.has(getFileName(url).toLowerCase()));
        } catch {
            return true;
        }
    }));
}

function loadBlockedMedia() {
    const raw = settings.store.blockedUrls.split(",").map((s: string) => s.trim()).filter(Boolean);
    const invalidTenorKeys = new Set(["v4f:m", "v4f:view", "v4:tenor.com%2Fm", "v4:tenor.com%2Fview"]);
    const cleanSavedKey = (key: string): string | null => {
        const match = key.match(/^v4:(.+)$/);
        if (!match) return key;
        try {
            const urls = decodeURIComponent(match[1]).split("\n").filter(url =>
                !/^(?:www\.|m\.|music\.)?youtube\.com\/watch$/i.test(url)
            );
            return urls.length > 0 ? `v4:${encodeURIComponent(urls.join("\n"))}` : null;
        } catch {
            return key;
        }
    };
    // channel image keys became obsolete when images moved to content hashes
    blockedUrlCache = removeCoveredBlockKeys(new Set(raw
        .filter(key => !invalidTenorKeys.has(key.toLowerCase()) && !key.startsWith("v4i:"))
        .map(cleanSavedKey)
        .filter((key): key is string => !!key)));
    const joined = [...blockedUrlCache].join(",");
    if (joined !== settings.store.blockedUrls) settings.store.blockedUrls = joined;
    updateBlockedFiles();
}

function saveBlockedMedia(keys: Set<string>) {
    blockedUrlCache = keys;
    settings.store.blockedUrls = [...keys].join(",");
    updateBlockedFiles();
}

function loadMediaHashes() {
    mediaHashes.clear();
    for (const line of settings.store.urlHashMap.split("\n")) {
        const split = line.lastIndexOf("|");
        if (split < 1) continue;
        const url = line.slice(0, split);
        const hash = line.slice(split + 1).toLowerCase();
        if (/^[a-f0-9]{64}$/.test(hash)) mediaHashes.set(url, hash);
    }
}

function saveMediaHashes() {
    while (mediaHashes.size > MEDIA_HASH_CACHE_MAX) dropOldest(mediaHashes);
    settings.store.urlHashMap = [...mediaHashes]
        .map(([url, hash]) => `${url}|${hash}`)
        .join("\n");
    hashSaveTimer = null;
}

function rememberMediaHash(urls: string[], hash: string) {
    let changed = false;
    for (const url of urls) {
        const canonicalUrl = cleanUrl(url);
        if (mediaHashes.get(canonicalUrl) === hash) continue;
        mediaHashes.set(canonicalUrl, hash);
        changed = true;
    }
    if (changed && hashSaveTimer === null)
        hashSaveTimer = window.setTimeout(saveMediaHashes, 250);
}

async function getMediaHash(url: string): Promise<string | null> {
    const canonicalUrl = cleanUrl(url);
    const cached = mediaHashes.get(canonicalUrl);
    if (cached) return cached;

    const pending = hashRequests.get(canonicalUrl);
    if (pending) return pending;

    const request = fetch(url)
        .then(response => {
            if (!response.ok) throw new Error(String(response.status));
            return response.arrayBuffer();
        })
        .then(buffer => crypto.subtle.digest("SHA-256", buffer))
        .then(digest => [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""))
        .catch(() => null)
        .finally(() => hashRequests.delete(canonicalUrl));
    hashRequests.set(canonicalUrl, request);
    return request;
}

async function getAttachmentHash(urls: string[]): Promise<string | null> {
    const cached = urls.map(cleanUrl).map(url => mediaHashes.get(url)).find(Boolean);
    if (cached) {
        rememberMediaHash(urls, cached);
        return cached;
    }

    for (const url of urls) {
        const hash = await getMediaHash(url);
        if (!hash) continue;
        rememberMediaHash(urls, hash);
        return hash;
    }
    return null;
}

function makeHashBlockKey(hash: string, attachment?: any): string {
    const size = Number(attachment?.size) || 0;
    const width = Number(attachment?.width) || 0;
    const height = Number(attachment?.height) || 0;
    return size && width && height
        ? `v4h:${size}:${width}x${height}:${hash}`
        : `v4h:${hash}`;
}

function getHashFromBlockKey(key: string): string | undefined {
    return key.match(/^v4h:(?:\d+:\d+x\d+:)?([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
}

// this keeps us from downloading every image just to compare hashes
function couldMatchBlockedHash(attachment: any): boolean {
    const size = Number(attachment?.size) || 0;
    const width = Number(attachment?.width) || 0;
    const height = Number(attachment?.height) || 0;
    return blockedHashFilters.some(filter =>
        (!filter.size || !size || filter.size === size)
        && (!filter.width || !width || filter.width === width)
        && (!filter.height || !height || filter.height === height)
    );
}

function isMediaBlocked(urls: string[]): boolean {
    if (urls.length === 0) return false;
    if (urls.some(url => {
        const canon = cleanUrl(url);
        const fileName = getFileName(url).toLowerCase();
        const hash = mediaHashes.get(canon);
        return blockedCanonicalUrls.has(canon)
            || blockedFileNames.has(fileName)
            || !!hash && blockedHashes.has(hash);
    })) return true;

    return makeBlockKeys(urls).some(key => blockedUrlCache.has(key));
}

function blockMedia(rawUrls: string[]) {
    const next = new Set(blockedUrlCache);
    for (const key of makeBlockKeys(rawUrls)) next.add(key);
    saveBlockedMedia(next);
    scanMessages();
}

function blockExactMedia(rawUrl: string) {
    const next = new Set(blockedUrlCache);
    next.add(makeSignatureKey([rawUrl]));
    saveBlockedMedia(next);
    scanMessages();
}

async function blockImageByContent(rawUrl: string, relatedUrls: string[], attachment?: any) {
    const urls = [...new Set([rawUrl, ...relatedUrls])];
    const hash = await getAttachmentHash(urls);
    if (!hash) {
        blockExactMedia(rawUrl);
        return;
    }

    const next = new Set(blockedUrlCache);
    next.add(makeHashBlockKey(hash, attachment));
    saveBlockedMedia(next);
    scanMessages();
}

async function unblockImageByContent(rawUrl: string, relatedUrls: string[]) {
    const urls = [...new Set([rawUrl, ...relatedUrls])];
    const hash = await getAttachmentHash(urls);
    unblockMedia(urls);
    if (!hash) return;

    const next = new Set(blockedUrlCache);
    for (const key of next)
        if (getHashFromBlockKey(key) === hash) next.delete(key);
    saveBlockedMedia(next);
    scanHiddenMessages();
}

async function blockAttachmentGroup(attachments: any[]) {
    const blocks = await Promise.all(attachments.map(async attachment => {
        const urls = getAttachmentUrls(attachment);
        if (urls.length === 0) return undefined;
        const primaryUrl = attachment.url ?? attachment.proxy_url;
        if (!primaryUrl) return undefined;

        const isImage = attachment.content_type?.startsWith("image/") || urls.some(isImageUrl);
        const hash = isImage ? await getAttachmentHash(urls) : null;
        return hash ? makeHashBlockKey(hash, attachment) : makeSignatureKey([primaryUrl]);
    }));

    const next = new Set(blockedUrlCache);
    for (const key of blocks) if (key) next.add(key);
    saveBlockedMedia(next);
    scanMessages();
}

async function unblockAttachmentGroup(attachments: any[]) {
    const groups = attachments
        .map(attachment => ({
            attachment,
            urls: getAttachmentUrls(attachment)
        }))
        .filter(group => group.urls.length > 0);
    const allUrls = groups.flatMap(group => group.urls);
    unblockMedia(allUrls);

    const hashes = await Promise.all(groups.map(group => {
        const isImage = group.attachment.content_type?.startsWith("image/") || group.urls.some(isImageUrl);
        return isImage ? getAttachmentHash(group.urls) : null;
    }));
    const blockedGroupHashes = new Set(hashes.filter((hash): hash is string => !!hash));
    if (blockedGroupHashes.size === 0) return;

    const next = new Set(blockedUrlCache);
    for (const key of next) {
        const hash = getHashFromBlockKey(key);
        if (hash && blockedGroupHashes.has(hash)) next.delete(key);
    }
    saveBlockedMedia(next);
    scanHiddenMessages();
}

function unblockMedia(rawUrls: string[]) {
    const next = new Set(blockedUrlCache);
    for (const key of makeBlockKeys(rawUrls)) next.delete(key);
    const canonicalUrls = new Set(rawUrls.map(cleanUrl));
    const fileNames = new Set(rawUrls.map(url => getFileName(url).toLowerCase()));
    for (const key of next) {
        const urlMatch = key.match(/^v4:(.+)$/);
        if (urlMatch) {
            try {
                if (decodeURIComponent(urlMatch[1]).split("\n").some(url => canonicalUrls.has(url))) next.delete(key);
            } catch {}
            continue;
        }

        const fileMatch = key.match(/^v4f:(.+)$/);
        if (fileMatch) {
            try { if (fileNames.has(decodeURIComponent(fileMatch[1]).toLowerCase())) next.delete(key); } catch {}
            continue;
        }

    }
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
        urls.push(...getAttachmentUrls(att));
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

function getAttachmentUrls(attachment: any): string[] {
    return [attachment?.url, attachment?.proxy_url].filter((url): url is string => !!url);
}

// only hash attachments that could match something already blocked
function queueMessageHashes(message: any, messageEl: HTMLElement) {
    if (blockedHashes.size === 0) return;

    for (const attachment of message?.attachments ?? []) {
        const urls = getAttachmentUrls(attachment);
        if (urls.length === 0) continue;
        if (!attachment.content_type?.startsWith("image/") && !urls.some(isImageUrl)) continue;
        if (urls.some(url => mediaHashes.has(cleanUrl(url)))) continue;
        if (!couldMatchBlockedHash(attachment)) continue;

        void getAttachmentHash(urls).then(hash => {
            if (hash && blockedHashes.has(hash) && messageEl.isConnected)
                checkMessageSoon(messageEl);
        });
    }
}

function hasBlockedMedia(message: any): boolean {
    return isMediaBlocked(getMediaUrls(message));
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
    const candidates: string[] = [];
    for (const att of message?.attachments ?? []) {
        const u = att.url || att.proxy_url;
        if (u) candidates.push(u);
    }
    for (const embed of message?.embeds ?? []) {
        const u = embed.url || embed.image?.url || embed.video?.url || embed.thumbnail?.url;
        if (u) candidates.push(u);
    }

    return isMediaBlocked(getMediaUrls(message))
        ? candidates[0] && getMediaTitle(candidates[0])
        : undefined;
}

interface RevealSource { src: string; kind: "image" | "gif" | "video"; nw?: number; nh?: number; poster?: string; }

interface ImgCandidate { u: string; w?: number; h?: number; poster?: string; }

interface PlaceholderDims { w: number; h: number; }

// finds the file that goes behind the cover
function getRevealMedia(message: any): RevealSource | undefined {
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
        if (embed.url) {
            const w = embed.image?.width ?? embed.thumbnail?.width;
            const h = embed.image?.height ?? embed.thumbnail?.height;
            const poster = embed.thumbnail?.proxy_url || embed.thumbnail?.url || embed.image?.proxy_url || embed.image?.url;
            if (isDirectVideoUrl(embed.url)) vidFile.push({ u: embed.url, w, h, poster });
            else if (isGifUrl(embed.url)) gifVid.push({ u: embed.url, w, h, poster });
        }
        addImg(embed.image?.proxy_url,     embed.image?.width,     embed.image?.height);
        addImg(embed.image?.url,           embed.image?.width,     embed.image?.height);
        addImg(embed.thumbnail?.proxy_url, embed.thumbnail?.width, embed.thumbnail?.height);
        addImg(embed.thumbnail?.url,       embed.thumbnail?.width, embed.thumbnail?.height);
    }

    for (const match of message?.content?.matchAll(/https?:\/\/[^\s<>]+/g) ?? []) {
        const url = match[0];
        if (isDirectVideoUrl(url)) vidFile.push({ u: url });
        else if (isGifUrl(url)) gifVid.push({ u: url });
        else addImg(url);
    }

    const messageBlocked = isMediaBlocked(getMediaUrls(message));
    const blocked = (_u: string) => messageBlocked;
    const pick = (c: ImgCandidate, kind: RevealSource["kind"]): RevealSource => ({ src: c.u, kind, nw: c.w, nh: c.h, poster: c.poster });

    for (const c of gifVid)  if (blocked(c.u)) return pick(c, "gif");
    for (const c of vidFile) if (blocked(c.u)) return pick(c, "video");
    for (const c of img)     if (blocked(c.u)) return pick(c, "image");
    return undefined;
}

function getDomRevealMedia(container: HTMLElement): RevealSource | undefined {
    const media = container.matches("img,video")
        ? container as HTMLImageElement | HTMLVideoElement
        : container.querySelector<HTMLImageElement | HTMLVideoElement>("img,video");
    if (!media) return undefined;

    const src = media.currentSrc || media.getAttribute("src") || "";
    if (!src) return undefined;

    if (media instanceof HTMLVideoElement) {
        return {
            src,
            kind: "video",
            nw: media.videoWidth || undefined,
            nh: media.videoHeight || undefined,
            poster: media.poster || undefined
        };
    }

    return {
        src,
        kind: isGifUrl(src) ? "gif" : "image",
        nw: media.naturalWidth || undefined,
        nh: media.naturalHeight || undefined
    };
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
    const canonicalUrl = reveal ? cleanUrl(reveal.src) : undefined;
    const key = canonicalUrl;
    const nat    = reveal?.nw && reveal?.nh ? { w: reveal.nw, h: reveal.nh } : undefined;
    if (measured && isGoodSize(measured, nat)) {
        if (key) saveSize(key, measured);
        return measured;
    }

    const cached = key ? measuredDimsCache.get(key) : undefined;
    if (cached) {
        if (isGoodSize(cached, nat)) return cached;
        measuredDimsCache.delete(key!);
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
        cover.style.background = "var(--background-primary, #1e1f22)";
    }
    cover.style.zIndex = "0";

    const handle = document.createElement("div");
    handle.className = CURTAIN_HANDLE_CLASS;

    wrapper.append(cover, handle);

    let revealEl: HTMLElement | null = null;
    let revealFrame: HTMLElement | null = null;
    let revealPx = 0;
    let startY   = 0;
    let startPx  = 0;
    let height   = 0;
    let dragging = false;

    height = size.h;

    const HANDLE_H = 18;
    let atBottomState: boolean | null = null;
    const apply = () => {
        if (revealFrame) revealFrame.style.height = `${revealPx}px`;
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
        revealEl.style.height = `${size.h}px`;

        revealFrame = document.createElement("div");
        revealFrame.style.position = "absolute";
        revealFrame.style.inset = "0 0 auto";
        revealFrame.style.height = `${revealPx}px`;
        revealFrame.style.overflow = "hidden";
        revealFrame.style.zIndex = "1";
        revealFrame.appendChild(revealEl);
        wrapper.insertBefore(revealFrame, handle);
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
    for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))
        showMessageMedia(el);
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

function getMosaicItems(messageEl: HTMLElement, attachmentCount: number): Array<{ cell: HTMLElement; media: HTMLElement; }> {
    const groupSelector = "[class*='mediaAttachmentsContainer'],[class*='oneByOneGrid']";
    const group = [...messageEl.querySelectorAll<HTMLElement>(groupSelector)]
        .find(el => el.querySelectorAll("img,video").length >= attachmentCount);
    const root = group ?? messageEl;
    const cellSelector = group
        ? "[class*='mosaicItem'],[class*='visualMediaItemContainer'],[class*='imageWrapper']"
        : "[class*='mosaicItem'],[class*='visualMediaItemContainer']";
    const items = new Map<HTMLElement, HTMLElement>();

    for (const media of root.querySelectorAll<HTMLElement>("img,video")) {
        if (media.closest(`.${PLACEHOLDER_CLASS}`)) continue;
        const cell = media.closest<HTMLElement>(cellSelector);
        if (!cell || !root.contains(cell) || items.has(cell)) continue;
        items.set(cell, media);
    }

    return [...items].slice(0, attachmentCount).map(([cell, media]) => ({ cell, media }));
}

function restoreMosaicItem(cell: HTMLElement, media: HTMLElement) {
    cell.querySelector(`[${MOSAIC_PLACEHOLDER_ATTR}]`)?.remove();

    if (media.hasAttribute(MOSAIC_MEDIA_ATTR)) {
        media.style.visibility = media.getAttribute(MOSAIC_VISIBILITY_ATTR) || "";
        media.removeAttribute(MOSAIC_VISIBILITY_ATTR);
        media.removeAttribute(MOSAIC_MEDIA_ATTR);
    }

    if (cell.hasAttribute(MOSAIC_POSITION_ATTR)) {
        cell.style.position = cell.getAttribute(MOSAIC_POSITION_ATTR) || "";
        cell.removeAttribute(MOSAIC_POSITION_ATTR);
    }

}

function getMosaicItem(message: any, media: HTMLElement, index: number): { attachment: any; urls: string[]; } {
    const src = (media as HTMLImageElement).currentSrc
        || (media as HTMLImageElement).src
        || media.getAttribute("src")
        || "";
    const attachments = [...(message?.attachments ?? [])];
    const canonicalSrc = src ? cleanUrl(src) : "";
    const attachment = attachments.find(att =>
        getAttachmentUrls(att).some(url => cleanUrl(url) === canonicalSrc)
    ) ?? attachments[index];

    return {
        attachment,
        urls: [...new Set([src, ...getAttachmentUrls(attachment)].filter(Boolean))]
    };
}

// mosaics need a separate placeholder for each attachment
function hideMosaicMedia(messageEl: HTMLElement, message: any): boolean {
    if ((message?.attachments?.length ?? 0) < 2) return false;

    const items = getMosaicItems(messageEl, message.attachments.length)
        .map(item => ({ ...item, rect: item.cell.getBoundingClientRect() }))
        .filter(item => item.rect.width >= 1 && item.rect.height >= 1);
    if (items.length < 2) return false;

    let hiddenCount = 0;

    for (const [index, { cell, media, rect }] of items.entries()) {
        const item = getMosaicItem(message, media, index);
        const urls = item.urls;
        if (!isMediaBlocked(urls)) {
            restoreMosaicItem(cell, media);
            continue;
        }

        hiddenCount++;
        const reveal = getDomRevealMedia(media);
        const existing = cell.querySelector<HTMLElement>(`[${MOSAIC_PLACEHOLDER_ATTR}]`);
        const needsCurtain = !!existing
            && settings.store.dragToPeek
            && !existing.classList.contains(CURTAIN_CLASS);

        if (!media.hasAttribute(MOSAIC_MEDIA_ATTR)) {
            media.setAttribute(MOSAIC_MEDIA_ATTR, "");
            media.setAttribute(MOSAIC_VISIBILITY_ATTR, media.style.visibility);
            media.style.visibility = "hidden";
        }

        if (getComputedStyle(cell).position === "static") {
            cell.setAttribute(MOSAIC_POSITION_ATTR, cell.style.position);
            cell.style.position = "relative";
        }

        if (existing && (!needsCurtain || !reveal)) continue;
        existing?.remove();

        const src = (media as HTMLImageElement).currentSrc || (media as HTMLImageElement).src || media.getAttribute("src") || "";
        const placeholder = makePlaceholder(src ? getMediaTitle(src) : undefined, reveal, {
            w: Math.round(rect.width),
            h: Math.round(rect.height)
        });
        placeholder.setAttribute(MOSAIC_PLACEHOLDER_ATTR, "");
        const originalUrl = item.attachment?.url ?? item.attachment?.proxy_url;
        if (originalUrl) placeholder.setAttribute(MOSAIC_URL_ATTR, originalUrl);
        if (message.id) placeholder.setAttribute(MOSAIC_MESSAGE_ATTR, message.id);
        placeholder.style.position = "absolute";
        placeholder.style.inset = "0";
        placeholder.style.width = "100%";
        placeholder.style.height = "100%";
        placeholder.style.zIndex = "1";
        cell.appendChild(placeholder);
    }

    if (hiddenCount > 0) {
        messageEl.setAttribute(HIDDEN_ATTR, "");
        messageEl.setAttribute(MOSAIC_ATTR, "");
    } else {
        messageEl.removeAttribute(HIDDEN_ATTR);
        messageEl.removeAttribute(MOSAIC_ATTR);
    }

    return hiddenCount > 0;
}


// mark the message because discord replaces image elements while scrolling
function hideMessageMedia(messageEl: HTMLElement, message?: any): boolean {
    if ((message?.attachments?.length ?? 0) > 1) {
        return hideMosaicMedia(messageEl, message);
    }

    const placeholder = messageEl.querySelector<HTMLElement>(`.${PLACEHOLDER_CLASS}`);
    const needsCurtain = !!placeholder
        && settings.store.dragToPeek
        && !placeholder.classList.contains(CURTAIN_CLASS);
    const firstMedia = messageEl.querySelector<HTMLElement>(MEDIA_SELECTORS);

    const title = message ? getPlaceholderTitle(message) : undefined;
    const messageReveal = message ? getRevealMedia(message) : undefined;
    const domReveal = firstMedia ? getDomRevealMedia(firstMedia) : undefined;
    const reveal = messageReveal && !messageReveal.nw && !messageReveal.nh && domReveal?.nw && domReveal?.nh
        ? { ...messageReveal, nw: domReveal.nw, nh: domReveal.nh, poster: messageReveal.poster ?? domReveal.poster }
        : messageReveal ?? domReveal;
    const nat    = reveal?.nw && reveal?.nh ? { w: reveal.nw, h: reveal.nh } : undefined;
    const measured = !placeholder && firstMedia
        ? measureMedia(firstMedia, nat)
        : undefined;

    messageEl.setAttribute(HIDDEN_ATTR, "");

    if (!firstMedia) return false;
    if (placeholder && !needsCurtain) return true;
    if (needsCurtain && !reveal) return false;
    placeholder?.remove();
    const dims = getPlaceholderSize(measured, reveal);
    firstMedia.insertAdjacentElement("afterend", makePlaceholder(title, reveal, dims));
    return true;
}

function showMessageMedia(messageEl: HTMLElement) {
    const next = messageEl.nextElementSibling;
    if (next?.classList.contains(PLACEHOLDER_CLASS)) next.remove();

    messageEl.removeAttribute(HIDDEN_ATTR);
    messageEl.removeAttribute(MOSAIC_ATTR);
    for (const media of messageEl.querySelectorAll<HTMLElement>(`[${MOSAIC_MEDIA_ATTR}]`)) {
        media.style.visibility = media.getAttribute(MOSAIC_VISIBILITY_ATTR) || "";
        media.removeAttribute(MOSAIC_VISIBILITY_ATTR);
        media.removeAttribute(MOSAIC_MEDIA_ATTR);
    }
    for (const cell of messageEl.querySelectorAll<HTMLElement>(`[${MOSAIC_POSITION_ATTR}]`)) {
        cell.style.position = cell.getAttribute(MOSAIC_POSITION_ATTR) || "";
        cell.removeAttribute(MOSAIC_POSITION_ATTR);
    }
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
    if (blockedCanonicalUrls.size === 0) return;
    for (const el of root.querySelectorAll<HTMLElement>("img,video")) {
        if (el.hasAttribute(PREVIEW_HIDDEN_ATTR)) continue;
        if (el.closest(`.${PLACEHOLDER_CLASS}`)) continue;
        if (!inDialog && el.closest(`[${HIDDEN_ATTR}]`)) continue;
        if (!inDialog && el.closest("[data-list-item-id]")) continue;
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute("src") || "";
        if (!src || !blockedCanonicalUrls.has(cleanUrl(src))) continue;

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
    if (blockedCanonicalUrls.size === 0) return;
    const els = root.matches("img,video") ? [root] : [...root.querySelectorAll<HTMLElement>("img,video")];
    for (const el of els) {
        if (el.hasAttribute(PREVIEW_HIDDEN_ATTR)) continue;
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute("src") || "";
        if (!src || !blockedCanonicalUrls.has(cleanUrl(src))) continue;

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
    queueMessageHashes(message, messageEl);
    if (hasBlockedMedia(message)) {
        if (!hideMessageMedia(messageEl, message)) return false;
        log("HIDE", message.id);
    } else {
        if (DEBUG) {
            const urls = getMediaUrls(message);
            if (urls.length) {
                const authorId = message.author?.id ?? "";
                log("NOT blocked", message.id, "author", authorId, urls.map(u => ({
                    url: u,
                    keys: makeBlockKeys(urls),
                    inCache: makeBlockKeys(urls).some(key => blockedUrlCache.has(key))
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

// message data can show up late, so keep one retry loop per row
const pendingMessageChecks = new WeakSet<HTMLElement>();

function checkMessageSoon(messageEl: HTMLElement, attempt = 0) {
    if (attempt === 0) {
        if (pendingMessageChecks.has(messageEl)) return;
        pendingMessageChecks.add(messageEl);
    }

    if (!messageEl.isConnected || checkMessage(messageEl)) {
        pendingMessageChecks.delete(messageEl);
        return;
    }

    if (attempt < 120) {
        requestAnimationFrame(() => checkMessageSoon(messageEl, attempt + 1));
    } else {
        pendingMessageChecks.delete(messageEl);
    }
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
    if (activeBlockCount === 0) return;

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
    if (activeBlockCount === 0) return;

    const hasBlocked = isMediaBlocked(getMediaUrls(message));
    if (!hasBlocked) return;

    const els = document.querySelectorAll<HTMLElement>(
        `[data-list-item-id='${CHAT_MSG_PREFIX}${message.channel_id}-${message.id}'],` +
        `[data-list-item-id='${NO_LIST_PREFIX}${message.id}']`
    );
    if (els.length === 0) return;

    for (const el of els) checkMessageSoon(el);
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
                        checkMessageSoon(el);
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
let mosaicContextTarget: { messageId: string; url: string; } | null = null;

function captureMosaicContext(event: MouseEvent) {
    mosaicContextTarget = null;
    if (!(event.target instanceof Element)) return;
    const placeholder = event.target.closest<HTMLElement>(`[${MOSAIC_URL_ATTR}]`);
    const messageId = placeholder?.getAttribute(MOSAIC_MESSAGE_ATTR);
    const url = placeholder?.getAttribute(MOSAIC_URL_ATTR);
    if (messageId && url) mosaicContextTarget = { messageId, url };
}

function getContextAttachment(message: any, props: any): { attachment: any; url: string; urls: string[]; } | undefined {
    const clickedUrls = [props?.src, props?.itemHref, props?.itemSrc, props?.itemSafeSrc]
        .filter((url): url is string => !!url);
    const capturedTarget = mosaicContextTarget;
    if (capturedTarget && capturedTarget.messageId === message?.id)
        clickedUrls.unshift(capturedTarget.url);
    if (clickedUrls.length === 0) return undefined;

    const clicked = new Set(clickedUrls.map(cleanUrl));
    for (const attachment of message?.attachments ?? []) {
        const urls = getAttachmentUrls(attachment);
        if (urls.some(url => clicked.has(cleanUrl(url)))) {
            return { attachment, url: attachment.url ?? attachment.proxy_url, urls };
        }
    }
    return undefined;
}

function addContextItem(children: any[], item: React.ReactElement) {
    const group = findGroupChildrenByChildId("copy-text", children)
        ?? findGroupChildrenByChildId("copy-link", children)
        ?? findGroupChildrenByChildId("copy-native-link", children);
    if (group) group.push(item);
    else children.push(item);
}

const messageContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const message  = props?.message;
    if (!message) return;

    const mediaUrls = getMediaUrls(message);
    if (mediaUrls.length === 0) return;

    const attachments = [...(message.attachments ?? [])];
    const target = getContextAttachment(message, props) ?? (attachments.length === 1
        ? (() => {
            const urls = getAttachmentUrls(attachments[0]);
            return urls.length > 0
                ? { attachment: attachments[0], url: attachments[0].url ?? attachments[0].proxy_url, urls }
                : undefined;
        })()
        : undefined);
    const targetUrls = target?.urls ?? [];
    const multipleAttachments = attachments.length > 1;

    if (target && targetUrls.length > 0) {
        const targetBlocked = isMediaBlocked(targetUrls);
        const targetIsImage = targetUrls.some(isImageUrl);
        addContextItem(children, (
            <Menu.MenuItem
                id="vc-hide-media-single-toggle"
                label={targetBlocked
                    ? `Unhide this ${targetIsImage ? "image" : "media"}`
                    : `Hide this ${targetIsImage ? "image" : "media"}`}
                action={() => targetBlocked
                    ? void unblockImageByContent(target.url, targetUrls)
                    : void blockImageByContent(target.url, targetUrls, target.attachment)}
            />
        ));

        if (!multipleAttachments) return;
    }

    const groups = attachments
        .map(getAttachmentUrls)
        .filter(urls => urls.length > 0);
    const allUrls = groups.length > 0 ? groups.flat() : mediaUrls;
    const allBlocked = groups.length > 0
        ? groups.every(urls => isMediaBlocked(urls))
        : isMediaBlocked(mediaUrls);
    const allLabel = multipleAttachments
        ? (allBlocked ? "Unhide all media" : "Hide all media")
        : (allBlocked ? "Unhide this media" : "Hide this media");

    addContextItem(children, (
        <Menu.MenuItem
            id="vc-hide-media-all-toggle"
            label={allLabel}
            action={() => allBlocked
                ? (groups.length > 0
                    ? void unblockAttachmentGroup(attachments)
                    : unblockMedia(allUrls))
                : (groups.length > 0
                    ? void blockAttachmentGroup(attachments)
                    : blockMedia(allUrls))}
        />
    ));
};

const imageContextPatch: NavContextMenuPatchCallback = (children, props) => {
    if (props?.message) {
        messageContextPatch(children, props);
        return;
    }

    const src = props?.src;
    if (!src) return;
    const canonicalSrc = cleanUrl(src);
    const hash = mediaHashes.get(canonicalSrc);
    const blocked = blockedCanonicalUrls.has(canonicalSrc) || !!hash && blockedHashes.has(hash);
    addContextItem(children, (
        <Menu.MenuItem
            id="vc-hide-media-image-toggle"
            label={blocked ? "Unhide this image" : "Hide this image"}
            action={() => blocked
                ? void unblockImageByContent(src, [src])
                : void blockImageByContent(src, [src])}
        />
    ));
};

// start and stop
let observer: MutationObserver | null = null;
let startupRescanTimer: number | null = null;

export default definePlugin({
    name: "HideMediaEverywhere",
    description: "Hide specific images, GIFs, and videos from the message context menu.",
    authors: [{ name: "t6rtar", id: 738215409559404562n }],

    settings,
    tags: ["Media", "Privacy", "Utility"],

    start() {
        Vencord.Api.ContextMenu.addContextMenuPatch("message", messageContextPatch);
        Vencord.Api.ContextMenu.addContextMenuPatch("image-context", imageContextPatch);
        document.addEventListener("contextmenu", captureMosaicContext, true);
        loadMediaHashes();
        loadBlockedMedia();
        cachedPlaceholderSrc = undefined;
        loadPlaceholderImage(false);

        const style       = document.createElement("style");
        style.id          = STYLE_ID;
        style.textContent = `
            [${HIDDEN_ATTR}]:not([${MOSAIC_ATTR}]) :is(${MEDIA_SELECTORS}) { display: none !important; }
            .${PLACEHOLDER_CLASS} { display: block; border-radius: 4px; }
            .${PLACEHOLDER_CLASS}:is(img) { width: 200px; height: auto; }
            .${PLACEHOLDER_CLASS}:is(div) { padding: 6px 10px; font-size: 12px; color: var(--text-muted); background: var(--background-primary, #1e1f22); width: fit-content; }

            /* Drag-to-peek curtain */
            .${PLACEHOLDER_CLASS}.${CURTAIN_CLASS} { position: relative; width: fit-content; padding: 0; background: var(--background-primary, #1e1f22); overflow: hidden; isolation: isolate; }
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
        startupRescanTimer = window.setTimeout(() => {
            loadBlockedMedia();
            scanMessages();
        }, 1000);
    },

    stop() {
        Vencord.Api.ContextMenu.removeContextMenuPatch("message", messageContextPatch);
        Vencord.Api.ContextMenu.removeContextMenuPatch("image-context", imageContextPatch);
        document.removeEventListener("contextmenu", captureMosaicContext, true);
        mosaicContextTarget = null;
        observer?.disconnect();
        observer = null;
        if (startupRescanTimer !== null) window.clearTimeout(startupRescanTimer);
        startupRescanTimer = null;

        stopWatchingSearch();
        searchMessageCache.clear();
        channelForMessage.clear();
        normCache.clear();
        measuredDimsCache.clear();
        hashRequests.clear();
        if (hashSaveTimer !== null) {
            window.clearTimeout(hashSaveTimer);
            saveMediaHashes();
        }
        mediaHashes.clear();

        FluxDispatcher.unsubscribe("MESSAGE_UPDATE",       checkMessageUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_EMBED_UPDATE", checkMessageUpdate);

        document.getElementById(STYLE_ID)?.remove();

        for (const el of document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`))
            showMessageMedia(el);
        for (const el of document.querySelectorAll<HTMLElement>(`[${PREVIEW_HIDDEN_ATTR}]`)) {
            el.style.removeProperty("display");
            el.removeAttribute(PREVIEW_HIDDEN_ATTR);
        }
        for (const el of document.querySelectorAll(`.${PLACEHOLDER_CLASS}`)) el.remove();
    }
});
