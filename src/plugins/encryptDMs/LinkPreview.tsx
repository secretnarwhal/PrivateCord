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

import { PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import type { LinkPreviewResult } from "./native";
import { cl } from "./utils";

const Native = VencordNative.pluginHelpers.EncryptDMs as PluginNative<typeof import("./native")>;

// Grab bare http(s) URLs; trailing sentence punctuation is trimmed so
// "see https://x.com/foo." doesn't capture the period.
const URL_RE = /https?:\/\/[^\s<>"']+/g;

export function extractUrls(text: string): string[] {
    const urls = new Set<string>();
    for (const match of text.matchAll(URL_RE)) {
        urls.add(match[0].replace(/[.,!?)\]}'"]+$/, ""));
    }
    // Cap so a message full of links can't fan out into many fetch buttons.
    return [...urls].slice(0, 5);
}

const IMAGE_EXT = ["gif", "apng", "png", "jpg", "jpeg", "webp", "avif", "bmp", "ico"];
const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "gifv"];
const AUDIO_EXT = ["mp3", "ogg", "oga", "wav", "flac", "m4a"];

// Used to give blobs a sensible type when the server sends octet-stream / nothing.
const EXT_MIME: Record<string, string> = {
    gif: "image/gif", apng: "image/apng", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
    ico: "image/x-icon",
    mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav",
    flac: "audio/flac", m4a: "audio/mp4",
};

type MediaKind = "image" | "video" | "audio";

function urlExtension(url: string): string | undefined {
    try {
        return new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    } catch {
        return undefined;
    }
}

function directMediaKind(url: string): MediaKind | null {
    const ext = urlExtension(url);
    if (!ext) return null;
    if (IMAGE_EXT.includes(ext)) return "image";
    if (VIDEO_EXT.includes(ext)) return "video";
    if (AUDIO_EXT.includes(ext)) return "audio";
    return null;
}

interface MediaProps {
    kind: MediaKind;
    url: string;
    /** render like Discord's gifv embeds: autoplaying, looping, muted */
    gif?: boolean;
    /** small preview-card thumbnail instead of full-size media */
    thumb?: boolean;
}

function MediaElement({ kind, src, href, gif, thumb, onError }: {
    src: string;
    href: string;
    onError?: () => void;
} & Pick<MediaProps, "kind" | "gif" | "thumb">) {
    if (kind === "image")
        return (
            <a href={href} target="_blank" rel="noreferrer" className={thumb ? cl("preview-thumb-link") : undefined}>
                <img className={cl(thumb ? "preview-thumb" : "preview-media")} src={src} alt="" onError={onError} />
            </a>
        );
    if (kind === "video")
        return gif
            ? <video className={cl("preview-media")} src={src} autoPlay loop muted playsInline onError={onError} />
            : <video className={cl("preview-media")} src={src} controls onError={onError} />;
    return <audio className={cl("preview-media")} src={src} controls onError={onError} />;
}

// Fetches the media bytes in the main process (no CORS, no CSP) and renders them
// via a blob: URL, which Vencord's CSP patch allows in img-src/media-src.
function NativeBlobMedia(props: MediaProps) {
    const { url } = props;
    const [blobUrl, setBlobUrl] = useState<string>();
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let created: string | undefined;
        (async () => {
            try {
                if (typeof Native?.fetchMedia !== "function") throw new Error("no native helper");
                const res = await Native.fetchMedia(url);
                if (!res.ok) throw new Error(res.error);
                const ext = urlExtension(url);
                const type = /^(image|video|audio)\//.test(res.mimeType)
                    ? res.mimeType
                    : (ext && EXT_MIME[ext]) || "";
                created = URL.createObjectURL(new Blob([res.data as BlobPart], { type }));
                if (cancelled) URL.revokeObjectURL(created);
                else setBlobUrl(created);
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [url]);

    if (failed)
        return (
            <div className={cl("preview-error")}>
                Couldn't load <a className={cl("preview-retry")} href={url} target="_blank" rel="noreferrer">this media</a>.
            </div>
        );
    if (!blobUrl) return <div className={cl("preview-loading")}>Loading media…</div>;
    return <MediaElement {...props} src={blobUrl} href={url} />;
}

// Try rendering the remote URL directly first — zero extra copies for hosts on
// Discord's CSP allowlist (its CDNs, tenor, …). Any load failure — usually the
// CSP silently blocking the host — falls back to fetching the bytes through the
// main process and rendering a blob: URL instead.
function Media(props: MediaProps) {
    const [blocked, setBlocked] = useState(false);
    if (!blocked)
        return <MediaElement {...props} src={props.url} href={props.url} onError={() => setBlocked(true)} />;
    return <NativeBlobMedia {...props} />;
}

type LoadState = "idle" | "loading" | "loaded" | "error";

function LinkPreview({ url }: { url: string; }) {
    const [state, setState] = useState<LoadState>("idle");
    const [result, setResult] = useState<LinkPreviewResult>();

    const directMedia = directMediaKind(url);

    const load = async () => {
        // Links that point straight at a media file skip the metadata fetch — the
        // Media component below renders them (direct or via the native fallback).
        if (directMedia) {
            setState("loaded");
            return;
        }
        if (typeof Native?.fetchLinkPreview !== "function") {
            setState("error");
            return;
        }
        setState("loading");
        try {
            const res = await Native.fetchLinkPreview(url);
            setResult(res);
            setState(res.ok ? "loaded" : "error");
        } catch {
            setState("error");
        }
    };

    if (state === "idle")
        return (
            <button type="button" className={cl("load-preview")} onClick={load} title={url}>
                ▶ Load preview
            </button>
        );

    if (state === "loading")
        return <div className={cl("preview-loading")}>Loading preview…</div>;

    if (directMedia && state === "loaded")
        return <Media kind={directMedia} url={url} gif={urlExtension(url) === "gifv"} />;

    if (state === "error" || !result || !result.ok)
        return (
            <div className={cl("preview-error")}>
                Couldn't load preview{result && !result.ok ? ` — ${result.error}` : ""}.{" "}
                <button type="button" className={cl("preview-retry")} onClick={load}>Retry</button>
            </div>
        );

    if (result.kind === "media")
        return <Media kind={result.mediaType} url={result.url} />;

    return (
        <div className={cl("preview-card")}>
            <div className={cl("preview-card-main")}>
                <div className={cl("preview-body")}>
                    {result.siteName && <span className={cl("preview-site")}>{result.siteName}</span>}
                    {result.title && (
                        <a className={cl("preview-title")} href={result.url} target="_blank" rel="noreferrer">
                            {result.title}
                        </a>
                    )}
                    {result.description && <span className={cl("preview-desc")}>{result.description}</span>}
                </div>
                {!result.video && result.image && <Media kind="image" url={result.image} thumb />}
            </div>
            {result.video && <Media kind="video" url={result.video} gif />}
        </div>
    );
}

export function LinkPreviews({ text }: { text: string; }) {
    // Native fetching only exists on the desktop client; on web there is no main
    // process to bypass CORS, so previews are unavailable.
    if (IS_WEB) return null;

    const urls = extractUrls(text);
    if (urls.length === 0) return null;

    return (
        <div className={cl("previews")}>
            {urls.map(url => <LinkPreview key={url} url={url} />)}
        </div>
    );
}
