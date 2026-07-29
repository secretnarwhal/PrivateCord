/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CspPolicies, CssSrc, ImageAndMediaSrc } from "@main/csp";
import { randomBytes, timingSafeEqual } from "crypto";
import { BrowserWindow, dialog, IpcMainInvokeEvent } from "electron";
import { createReadStream, Dirent } from "fs";
import { readdir, stat } from "fs/promises";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { basename, extname, join, resolve, sep } from "path";

import { readTags } from "./tags";
import type { ServerInfo, Track, TrackMetadata } from "./types";

// The renderer streams media from our loopback server, so 127.0.0.1 needs to be
// allowed as a media/image source. The default entry only covers css and images.
CspPolicies["http://127.0.0.1:*"] = [...new Set([...ImageAndMediaSrc, ...CssSrc])];

// Only formats Chromium can decode. mkv/avi/wmv/wma are intentionally absent -
// they'd show up in the library and then silently refuse to play.
const AUDIO_EXTS = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".weba"]);
const VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm", ".mov"]);

const MIME_TYPES: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".weba": "audio/webm",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime"
};

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILES = 20_000;

/** Directories the user has explicitly opened. Nothing outside these is servable. */
const allowedRoots = new Set<string>();

let server: Server | null = null;
let serverInfo: ServerInfo | null = null;

function isPathAllowed(path: string) {
    const resolved = resolve(path);
    for (const root of allowedRoots) {
        if (resolved === root || resolved.startsWith(root + sep)) return true;
    }
    return false;
}

function isValidToken(token: string | null) {
    if (!token || !serverInfo) return false;

    const provided = Buffer.from(token);
    const expected = Buffer.from(serverInfo.token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function handleMedia(path: string, range: string | undefined, res: import("http").ServerResponse) {
    const { size } = await stat(path);
    const contentType = MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

    // Range support is what makes seeking (and large video) work at all
    const match = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            return res.end();
        }

        res.writeHead(206, {
            "Content-Type": contentType,
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store"
        });
        return createReadStream(path, { start, end }).pipe(res);
    }

    res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
    });
    createReadStream(path).pipe(res);
}

async function handleArt(path: string, res: import("http").ServerResponse) {
    const { picture } = await readTags(path);
    if (!picture) {
        res.writeHead(404);
        return res.end();
    }

    res.writeHead(200, {
        "Content-Type": picture.mime,
        "Content-Length": picture.data.length,
        "Cache-Control": "no-store"
    });
    res.end(picture.data);
}

function startServer(): Promise<ServerInfo> {
    return new Promise((res, rej) => {
        const token = randomBytes(24).toString("hex");

        const instance = createServer(async (req, response) => {
            try {
                const url = new URL(req.url ?? "/", "http://127.0.0.1");
                const path = url.searchParams.get("p");

                if (!isValidToken(url.searchParams.get("t")) || !path || !isPathAllowed(path)) {
                    response.writeHead(403);
                    return response.end();
                }

                if (url.pathname === "/media") await handleMedia(path, req.headers.range, response);
                else if (url.pathname === "/art") await handleArt(path, response);
                else {
                    response.writeHead(404);
                    response.end();
                }
            } catch (e) {
                console.error("[LocalMusic] request failed:", e);
                if (!response.headersSent) response.writeHead(500);
                response.end();
            }
        });

        instance.on("error", rej);
        // port 0 = let the OS pick a free one; loopback only so nothing else can reach it
        instance.listen(0, "127.0.0.1", () => {
            server = instance;
            serverInfo = { port: (instance.address() as AddressInfo).port, token };
            res(serverInfo);
        });
    });
}

export async function getServerInfo(_: IpcMainInvokeEvent): Promise<ServerInfo> {
    return serverInfo ?? await startServer();
}

export async function pickFolder(e: IpcMainInvokeEvent): Promise<string | null> {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = { properties: ["openDirectory" as const] };

    const { canceled, filePaths } = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

    if (canceled || !filePaths.length) return null;

    const root = resolve(filePaths[0]);
    allowedRoots.add(root);
    return root;
}

/**
 * Re-authorises a folder saved from a previous session, so the library survives
 * a restart without making the user pick the folder again.
 */
export async function authoriseFolder(_: IpcMainInvokeEvent, path: string): Promise<boolean> {
    try {
        const root = resolve(path);
        if (!(await stat(root)).isDirectory()) return false;

        allowedRoots.add(root);
        return true;
    } catch {
        return false;
    }
}

export async function scanFolder(_: IpcMainInvokeEvent, path: string): Promise<Track[]> {
    const root = resolve(path);
    if (!isPathAllowed(root)) throw new Error("Folder has not been authorised");

    const tracks: Track[] = [];

    async function walk(dir: string, depth: number) {
        if (depth > MAX_SCAN_DEPTH || tracks.length >= MAX_SCAN_FILES) return;

        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable directory, skip rather than abort the whole scan
        }

        for (const entry of entries) {
            if (tracks.length >= MAX_SCAN_FILES) return;

            const full = join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name.startsWith(".")) continue;
                await walk(full, depth + 1);
                continue;
            }

            if (!entry.isFile()) continue;

            const ext = extname(entry.name).toLowerCase();
            const isVideo = VIDEO_EXTS.has(ext);
            if (!isVideo && !AUDIO_EXTS.has(ext)) continue;

            try {
                const { size } = await stat(full);
                tracks.push({
                    path: full,
                    fileName: basename(entry.name, extname(entry.name)),
                    ext,
                    size,
                    isVideo
                });
            } catch {
                // file vanished between readdir and stat
            }
        }
    }

    await walk(root, 0);

    tracks.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    return tracks;
}

export async function readMetadata(_: IpcMainInvokeEvent, path: string): Promise<TrackMetadata | null> {
    if (!isPathAllowed(path)) return null;

    const { title, artist, album, picture } = await readTags(path);
    return { title, artist, album, hasArt: !!picture };
}

export async function readMetadataBatch(_: IpcMainInvokeEvent, paths: string[]): Promise<Record<string, TrackMetadata>> {
    const result: Record<string, TrackMetadata> = {};

    for (const path of paths) {
        if (!isPathAllowed(path)) continue;

        const { title, artist, album, picture } = await readTags(path);
        result[path] = { title, artist, album, hasArt: !!picture };
    }

    return result;
}

export async function stopServer(_: IpcMainInvokeEvent) {
    server?.close();
    server = null;
    serverInfo = null;
}
