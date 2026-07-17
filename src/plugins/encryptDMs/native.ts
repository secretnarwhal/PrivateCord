/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Runs in the Electron MAIN process (Node) — no CORS — so it can fetch arbitrary
// link targets to build an on-device preview, the way Signal/WhatsApp generate
// link previews locally instead of leaking the URL to a server. This is only ever
// invoked on an explicit user click (see LinkPreview.tsx), never automatically,
// because fetching a link reveals the user's IP to that host.

import { promises as dns } from "dns";
import { IpcMainInvokeEvent } from "electron";

export type LinkPreviewResult =
    | { ok: true; kind: "media"; mediaType: "image" | "video" | "audio"; url: string; }
    | { ok: true; kind: "link"; url: string; title?: string; description?: string; image?: string; video?: string; siteName?: string; }
    | { ok: false; error: string; };

export type FetchBytesResult =
    | { ok: true; mimeType: string; data: Uint8Array; }
    | { ok: false; error: string; };

const MAX_HTML_BYTES = 512 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 4;

// Best-effort SSRF hardening: refuse to fetch anything that resolves to a
// loopback/link-local/private address so a crafted link can't probe the
// recipient's own machine or LAN. Not bullet-proof against DNS rebinding
// (the host could re-resolve between our check and fetch), but it blocks the
// obvious cases for a click-to-load convenience feature.
function isPrivateIp(ip: string): boolean {
    const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const a = Number(v4[1]);
        const b = Number(v4[2]);
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 192 && b === 168) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a >= 224) return true; // multicast + reserved
        return false;
    }
    const v6 = ip.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
    return false;
}

async function guardHost(hostname: string): Promise<void> {
    const addrs = await dns.lookup(hostname, { all: true });
    if (addrs.length === 0 || addrs.some(a => isPrivateIp(a.address)))
        throw new Error("Refusing to fetch a private/loopback address");
}

// fetch with manual redirect following so every hop is re-validated against the
// private-IP guard (a public URL must not be able to bounce us to an internal one).
async function safeFetch(startUrl: string, signal: AbortSignal): Promise<Response> {
    let current = startUrl;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const parsed = new URL(current);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
            throw new Error("Unsupported protocol");
        await guardHost(parsed.hostname);

        const res = await fetch(parsed.href, {
            signal,
            redirect: "manual",
            headers: {
                // A generic bot UA gets us the same OG tags Discord's own crawler sees.
                "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
                "Accept": "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
            },
        });

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (!location) return res;
            current = new URL(location, parsed.href).href;
            continue;
        }
        return res;
    }
    throw new Error("Too many redirects");
}

async function readCappedBytes(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; }> {
    const reader = res.body?.getReader();
    if (!reader) return { bytes: new Uint8Array(0), truncated: false };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            total += value.length;
            if (total >= maxBytes) {
                truncated = true;
                await reader.cancel();
                break;
            }
        }
    }
    return { bytes: Buffer.concat(chunks), truncated };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
    const { bytes } = await readCappedBytes(res, maxBytes);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
        .replace(/&amp;/g, "&");
}

function codePoint(n: number): string {
    try {
        return String.fromCodePoint(n);
    } catch {
        return "";
    }
}

function matchMeta(html: string, prop: string): string | undefined {
    const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*?content=["']([^"']*)["']`, "i"));
    if (before) return decodeEntities(before[1]);
    const after = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${p}["']`, "i"));
    if (after) return decodeEntities(after[1]);
    return undefined;
}

function absolutize(value: string | undefined, base: string): string | undefined {
    if (!value) return undefined;
    try {
        return new URL(value, base).href;
    } catch {
        return undefined;
    }
}

export async function fetchLinkPreview(_: IpcMainInvokeEvent, url: string): Promise<LinkPreviewResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await safeFetch(url, controller.signal);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.startsWith("image/")) return { ok: true, kind: "media", mediaType: "image", url: res.url || url };
        if (contentType.startsWith("video/")) return { ok: true, kind: "media", mediaType: "video", url: res.url || url };
        if (contentType.startsWith("audio/")) return { ok: true, kind: "media", mediaType: "audio", url: res.url || url };
        if (!contentType.includes("html")) return { ok: false, error: "Nothing to preview for this link" };

        const html = await readCapped(res, MAX_HTML_BYTES);
        const baseUrl = res.url || url;

        const title =
            matchMeta(html, "og:title") ??
            matchMeta(html, "twitter:title") ??
            html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
        const description = matchMeta(html, "og:description") ?? matchMeta(html, "twitter:description");
        const image = absolutize(
            matchMeta(html, "og:image") ??
            matchMeta(html, "og:image:url") ??
            matchMeta(html, "og:image:secure_url") ??
            matchMeta(html, "twitter:image") ??
            matchMeta(html, "twitter:image:src"),
            baseUrl
        );
        const siteName = matchMeta(html, "og:site_name");

        // Only surface og:video when it's an actual video file — sites like YouTube
        // put an HTML player page there (og:video:type text/html), which a <video>
        // element can't render. GIF hosts (tenor/giphy/klipy) provide video/mp4;
        // playing that looping+muted is exactly what Discord's own "gifv" embeds do.
        const videoCandidate = absolutize(
            matchMeta(html, "og:video:secure_url") ??
            matchMeta(html, "og:video:url") ??
            matchMeta(html, "og:video"),
            baseUrl
        );
        const videoType = matchMeta(html, "og:video:type");
        const video = videoCandidate && (videoType?.startsWith("video/") || /\.(mp4|webm|m4v|mov)(?:$|\?)/i.test(videoCandidate))
            ? videoCandidate
            : undefined;

        if (!title && !description && !image && !video)
            return { ok: false, error: "No preview information found" };

        return { ok: true, kind: "link", url: baseUrl, title: title && decodeEntities(title), description, image, video, siteName };
    } catch (e) {
        return { ok: false, error: controller.signal.aborted ? "Timed out" : String((e as Error)?.message ?? e) };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Fetch the raw bytes of a media file (og:image thumbnail, direct .gif/.mp4 link, …)
 * so the renderer can display it via a blob: URL. Discord's CSP img-src/media-src
 * only allows an allowlist of hosts, but Vencord's CSP patch adds blob: — so bytes
 * fetched here render fine where a direct <img src="https://other-host/…"> is
 * silently blocked. Same SSRF guard and redirect re-validation as fetchLinkPreview.
 */
export async function fetchMedia(_: IpcMainInvokeEvent, url: string): Promise<FetchBytesResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
        const res = await safeFetch(url, controller.signal);
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const mimeType = (res.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
        // Some CDNs serve media as octet-stream or omit the type; the renderer falls
        // back to guessing from the file extension. text/html means the link is a
        // page, not a file — refuse rather than hand markup to an <img>.
        const isMedia = /^(image|video|audio)\//.test(mimeType) || mimeType === "application/octet-stream" || mimeType === "";
        if (!isMedia) return { ok: false, error: "Not a media file" };

        const { bytes, truncated } = await readCappedBytes(res, MAX_MEDIA_BYTES);
        if (truncated) return { ok: false, error: "Media is too large" };
        return { ok: true, mimeType, data: bytes };
    } catch (e) {
        return { ok: false, error: controller.signal.aborted ? "Timed out" : String((e as Error)?.message ?? e) };
    } finally {
        clearTimeout(timeout);
    }
}

const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/**
 * Fetch an encrypted attachment when the renderer's own fetch is blocked by CORS.
 * Locked to Discord's CDN hosts, so unlike fetchMedia this cannot be pointed at an
 * arbitrary server and needs no DNS guard.
 */
export async function fetchAttachment(_: IpcMainInvokeEvent, url: string): Promise<FetchBytesResult> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, error: "Invalid URL" };
    }
    if (parsed.protocol !== "https:" || !ATTACHMENT_HOSTS.has(parsed.hostname))
        return { ok: false, error: "Only Discord CDN attachments can be fetched" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(parsed.href, { signal: controller.signal });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const { bytes, truncated } = await readCappedBytes(res, MAX_ATTACHMENT_BYTES);
        if (truncated) return { ok: false, error: "Attachment is too large" };
        return { ok: true, mimeType: (res.headers.get("content-type") ?? "").split(";")[0].trim(), data: bytes };
    } catch (e) {
        return { ok: false, error: controller.signal.aborted ? "Timed out" : String((e as Error)?.message ?? e) };
    } finally {
        clearTimeout(timeout);
    }
}
