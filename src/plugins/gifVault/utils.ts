/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";

import { FavGif, getChildFolders, getGifFolderId, getGifMeta, GifMeta, SortMode } from "./vault";

export const cl = classNameFactory("vc-gifvault-");

export const SORT_LABELS: Record<SortMode, string> = {
    recent: "Newest first",
    oldest: "Oldest first",
    "name-az": "Name (A–Z)",
    "name-za": "Name (Z–A)",
    shuffle: "Shuffled"
};

export const SORT_MODES = Object.keys(SORT_LABELS) as SortMode[];

export const FOLDER_COLORS: { label: string; value: string | null; }[] = [
    { label: "Default", value: null },
    { label: "Blurple", value: "#5865f2" },
    { label: "Sky", value: "#3b82f6" },
    { label: "Teal", value: "#14b8a6" },
    { label: "Green", value: "#23a559" },
    { label: "Yellow", value: "#f0b232" },
    { label: "Orange", value: "#f97316" },
    { label: "Red", value: "#f23f43" },
    { label: "Pink", value: "#eb459e" },
    { label: "Purple", value: "#a855f7" }
];

export function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

export function isVideo(gif: FavGif) {
    return gif.format === 2 || /\.(mp4|webm|mov)($|\?)/i.test(gif.src);
}

function safeDecode(str: string) {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

/** Best-effort human readable name for a gif: custom title, else prettified url slug */
export function prettyGifName(gif: FavGif, meta: GifMeta | undefined = getGifMeta(gif.url)): string {
    if (meta?.title) return meta.title;
    try {
        const url = new URL(gif.url || gif.src);
        let slug = safeDecode(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
        slug = slug.replace(/\.(gif|mp4|webm|png|jpe?g|webp|mov)$/i, "");
        if (url.host.includes("tenor")) {
            // "/view/happy-dance-gif-1234567" -> "happy-dance"
            slug = slug.replace(/-?gif-?\d*$/i, "").replace(/-\d+$/, "");
        }
        slug = slug.replace(/[-_+.]+/g, " ").trim();
        return slug || url.host;
    } catch {
        return gif.url;
    }
}

/** Everything about a gif that a search should be able to hit */
export function gifHaystack(gif: FavGif, meta: GifMeta | undefined = getGifMeta(gif.url)): string {
    const parts = [
        meta?.title ?? "",
        (meta?.tags ?? []).join(" "),
        safeDecode(gif.url),
        gif.src !== gif.url ? safeDecode(gif.src) : ""
    ];
    return parts.join(" ").toLowerCase().replace(/[-_/+.%?=&]+/g, " ");
}

/** Every whitespace separated token of the query must appear somewhere in the haystack */
export function matchesQuery(haystack: string, query: string): boolean {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.every(t => haystack.includes(t));
}

function hashStr(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function sortGifs(gifs: FavGif[], mode: SortMode, shuffleSeed: number): FavGif[] {
    const sorted = [...gifs];
    switch (mode) {
        case "recent":
            return sorted.sort((a, b) => b.order - a.order);
        case "oldest":
            return sorted.sort((a, b) => a.order - b.order);
        case "name-az":
            return sorted.sort((a, b) => prettyGifName(a).localeCompare(prettyGifName(b), undefined, { numeric: true, sensitivity: "base" }));
        case "name-za":
            return sorted.sort((a, b) => prettyGifName(b).localeCompare(prettyGifName(a), undefined, { numeric: true, sensitivity: "base" }));
        case "shuffle":
            return sorted.sort((a, b) => hashStr(a.url + shuffleSeed) - hashStr(b.url + shuffleSeed));
        default:
            return sorted;
    }
}

/** Group all favorites by the folder they live in (null bucket = root) */
export function buildFolderIndex(favorites: FavGif[]): Map<string | null, FavGif[]> {
    const index = new Map<string | null, FavGif[]>();
    for (const gif of favorites) {
        const folderId = getGifFolderId(gif.url);
        const bucket = index.get(folderId);
        if (bucket) bucket.push(gif);
        else index.set(folderId, [gif]);
    }
    return index;
}

/** All folder ids inside (and including) `rootId`. `null` root means "everywhere". */
export function collectSubtreeIds(rootId: string | null): Set<string | null> {
    const ids = new Set<string | null>([rootId]);
    const walk = (parentId: string | null) => {
        for (const child of getChildFolders(parentId)) {
            ids.add(child.id);
            walk(child.id);
        }
    };
    walk(rootId);
    return ids;
}

/** Number of gifs in each folder, including everything in its subfolders */
export function buildDeepCounts(index: Map<string | null, FavGif[]>): Map<string | null, number> {
    const counts = new Map<string | null, number>();
    const walk = (folderId: string | null): number => {
        let count = index.get(folderId)?.length ?? 0;
        for (const child of getChildFolders(folderId)) count += walk(child.id);
        counts.set(folderId, count);
        return count;
    };
    walk(null);
    return counts;
}
