/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CspPolicies, CssSrc, ImageAndMediaSrc, ImageSrc } from "@main/csp";
import { RendererSettings } from "@main/settings";
import { ChildProcess, spawn } from "child_process";
import { createHash, Hash, randomBytes, timingSafeEqual } from "crypto";
import { app, BrowserWindow, dialog, globalShortcut, IpcMainInvokeEvent, session, shell } from "electron";
import { constants, createReadStream, createWriteStream, Dirent, existsSync, statSync, WriteStream } from "fs";
import { access, cp, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "fs/promises";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { basename, delimiter, dirname, extname, join, resolve, sep } from "path";

import { lookupLyrics, searchLyricCandidates } from "./lyrics";
import { readTags } from "./tags";
import type {
    CustomTool, DownloadJob, FileOpResult, FolderDir, FolderFile, FolderListing, Lyrics,
    LyricsCandidate, LyricsRequest, OrganiseItem, SearchResult, SearchSource, ServerInfo, ToolLine,
    ToolOutput, ToolRun, Track, TrackMetadata, YtDlpInfo, YtDlpOptions
} from "./types";

// The renderer streams media from our loopback server, so 127.0.0.1 needs to be
// allowed as a media/image source. The default entry only covers css and images.
CspPolicies["http://127.0.0.1:*"] = [...new Set([...ImageAndMediaSrc, ...CssSrc])];
// Thumbnails in the yt-dlp search results come from YouTube's own CDNs
CspPolicies["i.ytimg.com"] = ImageSrc;
CspPolicies["lh3.googleusercontent.com"] = ImageSrc;

/**
 * Media keys and the OS "now playing" widget hang off two Chromium features:
 * MediaSessionService (the media session backend — SMTC on Windows, MPRIS on
 * Linux, Now Playing on macOS) and HardwareMediaKeyHandling (routing the
 * physical keys to it). Electron enables both by default on Windows and macOS,
 * but Discord's bootstrap passes both to --disable-features on every platform —
 * which is why stock Discord never reacts to media keys — and on Linux Electron
 * ships with them off in the first place.
 *
 * Chromium only reads feature switches before the app is ready, and Discord's
 * bootstrap runs *after* plugin natives are imported, so this has to happen at
 * import time — and Discord's disable has to be intercepted, not just undone.
 */
const MEDIA_FEATURES = ["MediaSessionService", "HardwareMediaKeyHandling"];

if (RendererSettings.store.plugins?.LocalMusic?.enabled) {
    if (app.isReady()) {
        console.warn(
            "[LocalMusic] the app was already ready, so MediaSessionService could not be enabled. " +
            "If the desktop media controls don't pick the player up, start the client with " +
            "--enable-features=MediaSessionService,HardwareMediaKeyHandling"
        );
    } else {
        const scrub = (value: string) =>
            value.split(",").filter(f => !MEDIA_FEATURES.includes(f.trim())).join(",");

        // anything already on the command line (a host can pass --disable-features itself)
        const preDisabled = app.commandLine.getSwitchValue("disable-features");
        if (preDisabled) {
            app.commandLine.removeSwitch("disable-features");
            app.commandLine.appendSwitch("disable-features", scrub(preDisabled));
        }

        const withMediaFeatures = (value: string) =>
            [...new Set([...value.split(",").filter(Boolean), ...MEDIA_FEATURES])].join(",");

        // Discord's own disable arrives later, when its bootstrap runs. And since
        // Chromium honours only the *last* occurrence of a switch, a later
        // enable-features append would silently drop ours — fold ours into it.
        const originalAppend = app.commandLine.appendSwitch.bind(app.commandLine);
        app.commandLine.appendSwitch = (key: string, value?: string) => {
            if (key === "disable-features" && value) value = scrub(value);
            if (key === "enable-features") value = withMediaFeatures(value ?? "");
            return originalAppend(key, value as string);
        };

        app.commandLine.appendSwitch(
            "enable-features",
            app.commandLine.getSwitchValue("enable-features")
        );
    }
}

// Only formats Chromium can decode. mkv/avi/wmv/wma are intentionally absent -
// they'd show up in the library and then silently refuse to play.
const AUDIO_EXTS = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".weba"]);
const VIDEO_EXTS = new Set([".mp4", ".m4v", ".webm", ".mov"]);

/**
 * Cover art the user keeps as a file rather than inside the tags. Served from
 * /image, which is why the list is a whitelist: it is the only thing that
 * decides what bytes that endpoint will hand out.
 */
const IMAGE_MIME: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif"
};

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

// #region event stream

/**
 * Plugin natives are invoke-only, so the main process has no way to push to the
 * renderer. Rather than poll, the renderer holds an EventSource open against the
 * loopback server we already run, and media key presses and download progress are
 * pushed down it.
 */
const eventClients = new Set<ServerResponse>();
let heartbeat: NodeJS.Timeout | null = null;

function handleEvents(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
    });
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    res.write(": connected\n\n");

    eventClients.add(res);
    req.on("close", () => eventClients.delete(res));

    heartbeat ??= setInterval(() => {
        for (const client of eventClients) client.write(": ping\n\n");
    }, 25_000);
}

function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of eventClients) {
        try {
            client.write(payload);
        } catch {
            eventClients.delete(client);
        }
    }
}

// #endregion

/**
 * The renderer's media element uses crossorigin="anonymous" so the Web Audio
 * analyser behind the visualizer can read samples (a non-CORS element plays but
 * analyses as silence). That makes every media request a CORS request, which
 * fails outright without this header. The token is what actually gates access.
 */
const CORS_HEADER = { "Access-Control-Allow-Origin": "*" };

async function handleMedia(path: string, range: string | undefined, res: ServerResponse) {
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
            ...CORS_HEADER,
            "Content-Type": contentType,
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store"
        });
        return createReadStream(path, { start, end }).pipe(res);
    }

    res.writeHead(200, {
        ...CORS_HEADER,
        "Content-Type": contentType,
        "Content-Length": size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
    });
    createReadStream(path).pipe(res);
}

async function handleArt(path: string, res: ServerResponse) {
    const { picture } = await readTags(path);
    if (!picture) {
        res.writeHead(404);
        return res.end();
    }

    res.writeHead(200, {
        ...CORS_HEADER,
        "Content-Type": picture.mime,
        "Content-Length": picture.data.length,
        "Cache-Control": "no-store"
    });
    res.end(picture.data);
}

/** A cover image kept beside the music, for folders whose tracks embed nothing. */
async function handleImage(path: string, res: ServerResponse) {
    const type = IMAGE_MIME[extname(path).toLowerCase()];
    if (!type) {
        res.writeHead(404);
        return res.end();
    }

    const { size } = await stat(path);
    res.writeHead(200, {
        ...CORS_HEADER,
        "Content-Type": type,
        "Content-Length": size,
        "Cache-Control": "no-store"
    });
    createReadStream(path).pipe(res);
}

function startServer(): Promise<ServerInfo> {
    return new Promise((res, rej) => {
        const token = randomBytes(24).toString("hex");

        const instance = createServer(async (req, response) => {
            try {
                const url = new URL(req.url ?? "/", "http://127.0.0.1");

                if (!isValidToken(url.searchParams.get("t"))) {
                    response.writeHead(403);
                    return response.end();
                }

                if (url.pathname === "/events") return handleEvents(req, response);

                // everything else serves a file, so it needs a path we're allowed to read
                const path = url.searchParams.get("p");
                if (!path || !isPathAllowed(path)) {
                    response.writeHead(403);
                    return response.end();
                }

                if (url.pathname === "/media") await handleMedia(path, req.headers.range, response);
                else if (url.pathname === "/art") await handleArt(path, response);
                else if (url.pathname === "/image") await handleImage(path, response);
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

    const { title, artist, album, track, disc, picture } = await readTags(path);
    return { title, artist, album, track, disc, hasArt: !!picture };
}

export async function readMetadataBatch(_: IpcMainInvokeEvent, paths: string[]): Promise<Record<string, TrackMetadata>> {
    const result: Record<string, TrackMetadata> = {};

    for (const path of paths) {
        if (!isPathAllowed(path)) continue;

        const { title, artist, album, track, disc, picture } = await readTags(path);
        result[path] = { title, artist, album, track, disc, hasArt: !!picture };
    }

    return result;
}

// #region file explorer

/**
 * The library browser is a real file manager: what it lists is what readdir says
 * is there, and renaming a folder in it renames the folder on disk. Everything
 * below is therefore written defensively — every path is checked against the
 * roots the user opened, nothing is ever overwritten, and deletes go to the
 * recycle bin rather than away.
 */

/** How many child folders we'll look inside for their counts and cover art. */
const DIR_PROBE_LIMIT = 400;

/** What a cover file is usually called, next to the music it belongs to. */
const COVER_NAME = /^(cover|folder|front|album|artwork|art|thumb)$/i;

/** Lyrics kept beside a track; they follow it when it moves. */
const SIDECAR_EXTS = [".lrc", ".txt"];

/**
 * Characters no name may hold. This is the Windows set, applied on every
 * platform: a library that syncs to a Windows machine shouldn't turn into files
 * that can't be copied there.
 */
const BAD_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const BAD_NAME_CHARS_G = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function isPlayable(ext: string) {
    return AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

function isCoverName(name: string) {
    return COVER_NAME.test(basename(name, extname(name)));
}

/** The authorised root a path lives under — the deepest one, if they nest. */
function rootFor(path: string): string | null {
    const resolved = resolve(path);

    let best: string | null = null;
    for (const root of allowedRoots) {
        if (resolved !== root && !resolved.startsWith(root + sep)) continue;
        if (!best || root.length > best.length) best = root;
    }

    return best;
}

/** Anything the browser is allowed to change: inside a root, but not a root itself. */
function requireEditable(path: string) {
    if (!isPathAllowed(path)) throw new Error("That's outside the music folder you opened");
    if (allowedRoots.has(path))
        throw new Error("That's your music folder itself — change it from the library instead");
}

function describeFileError(error: NodeJS.ErrnoException, name: string) {
    switch (error.code) {
        case "EPERM":
        case "EBUSY":
        case "EACCES":
            return `${name} is in use — pause playback or close whatever has it open, then try again`;
        case "ENOENT":
            return `${name} isn't there any more`;
        case "EEXIST":
        case "ENOTEMPTY":
            return `Something called ${name} is already there`;
        case "ENOSPC":
            return "The drive is full";
        default:
            return error.message;
    }
}

/** Validates a name typed by the user, and hands back the trimmed version. */
function checkName(raw: string) {
    const name = raw.trim();

    if (!name || name === "." || name === "..") throw new Error("That name can't be used");
    if (name.startsWith(".")) throw new Error("Names starting with a dot are hidden — pick another");
    if (BAD_NAME_CHARS.test(name)) throw new Error('A name can\'t contain < > : " / \\ | ? *');
    if (name.length > 200) throw new Error("That name is too long");

    if (process.platform === "win32") {
        if (RESERVED_NAMES.test(basename(name, extname(name))))
            throw new Error(`Windows reserves the name “${name}”`);
        if (/[. ]$/.test(name)) throw new Error("Windows won't keep a name that ends in a dot or a space");
    }

    return name;
}

/** The same rules, applied to a tag rather than to something the user typed. */
function toSegment(value: string, fallback: string) {
    const clean = value
        .replace(BAD_NAME_CHARS_G, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "")
        .slice(0, 120)
        .trim();

    if (!clean || clean.startsWith(".") || RESERVED_NAMES.test(clean)) return fallback;
    return clean;
}

/**
 * What a child folder holds, for the tile that represents it: how much is in
 * there and what picture to put on it. One readdir per folder, which is why it
 * is skipped entirely once a directory has an unreasonable number of them.
 */
async function describeDir(path: string, name: string, probe: boolean): Promise<FolderDir> {
    const dir: FolderDir = { path, name, trackCount: -1, folderCount: -1, cover: null };
    if (!probe) return dir;

    let entries: Dirent[];
    try {
        entries = await readdir(path, { withFileTypes: true });
    } catch {
        return dir; // unreadable: still list it, just don't claim to know what's inside
    }

    dir.trackCount = 0;
    dir.folderCount = 0;

    let anyImage: string | null = null;
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
            dir.folderCount++;
            continue;
        }
        if (!entry.isFile()) continue;

        const ext = extname(entry.name).toLowerCase();
        if (isPlayable(ext)) dir.trackCount++;
        else if (IMAGE_MIME[ext]) {
            if (!dir.cover && isCoverName(entry.name)) dir.cover = join(path, entry.name);
            anyImage ??= join(path, entry.name);
        }
    }

    dir.cover ??= anyImage;
    return dir;
}

const byName = (a: { name: string; }, b: { name: string; }) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

export async function listFolder(_: IpcMainInvokeEvent, path: string): Promise<FolderListing> {
    const dir = resolve(path);
    const root = rootFor(dir);
    if (!root) throw new Error("That folder is outside the music folder you opened");

    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
        throw new Error(describeFileError(e as NodeJS.ErrnoException, basename(dir) || dir));
    }

    // dotfiles are skipped for the same reason the scanner skips them: they are
    // never the user's music, and our own bookkeeping lives among them
    const visible = entries.filter(entry => !entry.name.startsWith("."));
    const childDirs = visible.filter(entry => entry.isDirectory());
    const probe = childDirs.length <= DIR_PROBE_LIMIT;

    const dirs = await Promise.all(
        childDirs.map(entry => describeDir(join(dir, entry.name), entry.name, probe))
    );

    let cover: string | null = null;
    let anyImage: string | null = null;

    const files = (await Promise.all(visible.map(async (entry): Promise<FolderFile | null> => {
        if (!entry.isFile()) return null;

        const full = join(dir, entry.name);
        const ext = extname(entry.name).toLowerCase();

        if (IMAGE_MIME[ext]) {
            if (!cover && isCoverName(entry.name)) cover = full;
            anyImage ??= full;
        }

        try {
            const { size } = await stat(full);
            return {
                path: full,
                name: entry.name,
                ext,
                size,
                isVideo: VIDEO_EXTS.has(ext),
                playable: isPlayable(ext)
            };
        } catch {
            return null; // vanished between readdir and stat
        }
    }))).filter((file): file is FolderFile => !!file);

    const crumbs = [{ name: basename(root) || root, path: root }];
    let walk = root;
    for (const part of dir.slice(root.length).split(sep).filter(Boolean)) {
        walk = join(walk, part);
        crumbs.push({ name: part, path: walk });
    }

    return {
        path: dir,
        root,
        parent: dir === root ? null : dirname(dir),
        crumbs,
        dirs: dirs.sort(byName),
        files: files.sort(byName),
        cover: cover ?? anyImage
    };
}

/** A track's lyrics file, so a moved song doesn't leave its words behind. */
function sidecarsOf(path: string) {
    if (!isPlayable(extname(path).toLowerCase())) return [];

    const stem = join(dirname(path), basename(path, extname(path)));
    return SIDECAR_EXTS.map(ext => stem + ext).filter(existsSync);
}

/** rename(), falling back to copy-then-delete when the ends are on different drives. */
async function relocate(from: string, to: string) {
    try {
        await rename(from, to);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;

        await cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await rm(from, { recursive: true, force: true });
    }
}

/**
 * Runs a batch of moves. One entry failing is reported and stepped over rather
 * than abandoning the rest — half a drag landing is still better than none of it,
 * and the browser reloads from disk afterwards either way.
 */
async function runMoves(moves: { from: string; to: string; }[]): Promise<FileOpResult> {
    const result: FileOpResult = { moved: [], removed: [], failed: [] };

    for (const { from, to } of moves) {
        const sidecars = sidecarsOf(from);

        try {
            await relocate(from, to);
            result.moved.push({ from, to });
        } catch (e) {
            result.failed.push({
                path: from,
                error: describeFileError(e as NodeJS.ErrnoException, `“${basename(from)}”`)
            });
            continue;
        }

        // the lyrics follow the song, but a sidecar that won't move is not worth
        // failing a move that has already happened over
        const stem = join(dirname(to), basename(to, extname(to)));
        for (const sidecar of sidecars) {
            const target = stem + extname(sidecar);
            if (existsSync(target)) continue;

            try {
                await relocate(sidecar, target);
                result.moved.push({ from: sidecar, to: target });
            } catch { }
        }
    }

    return result;
}

export async function createFolder(_: IpcMainInvokeEvent, parent: string, name: string): Promise<string> {
    const dir = resolve(parent);
    if (!isPathAllowed(dir)) throw new Error("That's outside the music folder you opened");

    const target = join(dir, checkName(name));
    if (existsSync(target)) throw new Error(`“${basename(target)}” is already there`);

    await mkdir(target);
    return target;
}

export async function renameEntry(_: IpcMainInvokeEvent, path: string, name: string): Promise<FileOpResult> {
    const from = resolve(path);
    requireEditable(from);

    // a file keeps its extension unless the user typed one themselves, so
    // renaming "01 track.mp3" to "Intro" doesn't quietly make it unplayable
    const suffix = extname(from);
    const typed = checkName(name);
    const isDir = statSync(from, { throwIfNoEntry: false })?.isDirectory() ?? false;
    const keepExt = suffix && !isDir && !extname(typed);

    const to = join(dirname(from), keepExt ? typed + suffix : typed);
    if (to === from) return { moved: [], removed: [], failed: [] };
    if (existsSync(to)) throw new Error(`“${basename(to)}” is already there`);

    return runMoves([{ from, to }]);
}

export async function moveEntries(
    _: IpcMainInvokeEvent,
    paths: string[],
    destination: string
): Promise<FileOpResult> {
    const dest = resolve(destination);
    if (!isPathAllowed(dest)) throw new Error("That folder is outside the music folder you opened");
    if (!(await stat(dest).catch(() => null))?.isDirectory()) throw new Error("That isn't a folder any more");

    const failed: FileOpResult["failed"] = [];
    const moves: { from: string; to: string; }[] = [];

    for (const path of paths) {
        const from = resolve(path);
        const name = basename(from);

        try {
            requireEditable(from);
        } catch (e) {
            failed.push({ path: from, error: e instanceof Error ? e.message : String(e) });
            continue;
        }

        if (dirname(from) === dest) continue; // already where it was dropped

        // a folder can't hold itself, and neither can anything under it
        if (dest === from || dest.startsWith(from + sep)) {
            failed.push({ path: from, error: `“${name}” can't be moved inside itself` });
            continue;
        }

        const to = join(dest, name);
        if (existsSync(to)) {
            failed.push({ path: from, error: `“${name}” is already in that folder` });
            continue;
        }

        moves.push({ from, to });
    }

    const done = await runMoves(moves);
    return { ...done, failed: [...failed, ...done.failed] };
}

export async function trashEntries(_: IpcMainInvokeEvent, paths: string[]): Promise<FileOpResult> {
    const result: FileOpResult = { moved: [], removed: [], failed: [] };

    for (const path of paths) {
        const target = resolve(path);

        try {
            requireEditable(target);
            // the recycle bin, never unlink: a misclick in a file manager has to be
            // something the user can walk back
            await shell.trashItem(target);
            result.removed.push(target);

            // the lyrics went with the song when it moved; they go with it here too
            for (const sidecar of sidecarsOf(target)) {
                try {
                    await shell.trashItem(sidecar);
                    result.removed.push(sidecar);
                } catch { }
            }
        } catch (e) {
            result.failed.push({
                path: target,
                error: e instanceof Error ? `“${basename(target)}” — ${e.message}` : String(e)
            });
        }
    }

    return result;
}

export async function revealEntry(_: IpcMainInvokeEvent, path: string): Promise<void> {
    const target = resolve(path);
    if (!isPathAllowed(target)) throw new Error("That's outside the music folder you opened");
    if (!existsSync(target)) throw new Error("That isn't there any more");

    shell.showItemInFolder(target);
}

/**
 * Files the tags into `<root>/<artist>/<album>/`. The renderer works out which
 * artist and album (it already holds every track's tags) and this decides what
 * those are allowed to look like as folder names — a tag is not a path, and is
 * never treated as one.
 */
export async function organiseTracks(
    _: IpcMainInvokeEvent,
    root: string,
    items: OrganiseItem[]
): Promise<FileOpResult> {
    const base = resolve(root);
    if (!isPathAllowed(base)) throw new Error("That's outside the music folder you opened");

    const failed: FileOpResult["failed"] = [];
    const moves: { from: string; to: string; }[] = [];

    for (const item of items) {
        const from = resolve(item.path);

        try {
            requireEditable(from);
        } catch (e) {
            failed.push({ path: from, error: e instanceof Error ? e.message : String(e) });
            continue;
        }

        const dir = join(
            base,
            toSegment(item.artist ?? "", "Unknown Artist"),
            toSegment(item.album ?? "", "Unknown Album")
        );
        if (dirname(from) === dir) continue; // already filed

        const to = join(dir, basename(from));
        if (existsSync(to)) {
            failed.push({ path: from, error: `“${basename(from)}” is already in ${dir}` });
            continue;
        }

        try {
            await mkdir(dir, { recursive: true });
        } catch (e) {
            failed.push({
                path: from,
                error: describeFileError(e as NodeJS.ErrnoException, `“${basename(dir)}”`)
            });
            continue;
        }

        moves.push({ from, to });
    }

    const done = await runMoves(moves);
    return { ...done, failed: [...failed, ...done.failed] };
}

// #endregion

/**
 * Lyrics for whatever is playing. The path is only consulted when it is inside a
 * folder the user opened — a listen-along listener passes none at all and is
 * matched on its tags alone.
 */
export async function getLyrics(_: IpcMainInvokeEvent, req: LyricsRequest): Promise<Lyrics | null> {
    return lookupLyrics(req, !!req.path && isPathAllowed(req.path));
}

/** Candidates for the manual "Fix lyrics…" picker. */
export async function searchLyrics(
    _: IpcMainInvokeEvent,
    query: string,
    duration: number
): Promise<LyricsCandidate[]> {
    return searchLyricCandidates(query, duration);
}

// #region media keys

/**
 * Chromium's own media session handling (SMTC on Windows, MPRIS on Linux) is the
 * good path: the desktop routes the keys, other players keep working, and we get a
 * "now playing" widget for free. globalShortcut is the blunt fallback for setups
 * where that doesn't happen - it grabs the keys process-wide, so it is opt-in.
 */
const MEDIA_KEYS: Record<string, string> = {
    MediaPlayPause: "playpause",
    MediaNextTrack: "next",
    MediaPreviousTrack: "previous",
    MediaStop: "stop"
};

let grabbedKeys: string[] = [];

function releaseMediaKeys() {
    for (const accelerator of grabbedKeys) {
        try {
            globalShortcut.unregister(accelerator);
        } catch { }
    }
    grabbedKeys = [];
}

/**
 * @returns the accelerators that actually registered. Empty on Wayland, where
 * Electron cannot take global shortcuts at all.
 */
export async function setGlobalMediaKeys(_: IpcMainInvokeEvent, enabled: boolean): Promise<string[]> {
    releaseMediaKeys();
    if (!enabled) return [];

    for (const [accelerator, action] of Object.entries(MEDIA_KEYS)) {
        try {
            if (globalShortcut.register(accelerator, () => broadcast("mediaKey", { action })))
                grabbedKeys.push(accelerator);
        } catch (e) {
            console.warn(`[LocalMusic] could not grab ${accelerator}:`, e);
        }
    }

    return [...grabbedKeys];
}

// #endregion

// #region yt-dlp

const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

/** Homebrew and MacPorts aren't on the PATH a GUI app inherits. */
function spawnEnv() {
    if (process.platform !== "darwin") return process.env;
    return { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
}

function resolveBinary(opts: YtDlpOptions) {
    if (opts.binary.trim()) return opts.binary.trim();

    // the usual setup: the binary is dropped in next to the music, run as ./yt-dlp
    if (opts.folder) {
        const names = process.platform === "win32" ? ["yt-dlp.exe", "yt-dlp"] : ["yt-dlp"];
        for (const name of names) {
            const candidate = join(opts.folder, name);
            if (existsSync(candidate)) return candidate;
        }
    }

    return "yt-dlp"; // fall back to PATH
}

function run(binary: string, args: string[]) {
    return isFlatpak
        ? spawn("flatpak-spawn", ["--host", binary, ...args], { env: spawnEnv() })
        : spawn(binary, args, { env: spawnEnv() });
}

function describeSpawnError(error: NodeJS.ErrnoException, binary: string) {
    if (error.code === "ENOENT")
        return `Could not find ${binary} — put yt-dlp in your music folder, install it on your PATH, or set its path in the plugin settings`;
    if (error.code === "EACCES")
        return `${binary} is not executable — try chmod +x ${binary}`;
    return error.message;
}

/** Splits a flag string the way a shell would, minus the parts that could bite. */
function splitArgs(input: string): string[] {
    const out: string[] = [];
    const token = /"([^"]*)"|'([^']*)'|(\S+)/g;

    let match: RegExpExecArray | null;
    while ((match = token.exec(input))) out.push(match[1] ?? match[2] ?? match[3]);

    return out;
}

// #region cookies

/** The browse window's session — signing in there is what makes these cookies exist. */
const BROWSER_PARTITION = "persist:vc-localmusic";

/** Only what YouTube needs; nothing else in the jar ever reaches yt-dlp. */
const COOKIE_DOMAINS = /(^|\.)(youtube\.com|youtu\.be|google\.com|googlevideo\.com)$/i;

function isLoginCookie(name: string) {
    return name === "SAPISID" || name === "__Secure-3PAPISID";
}

function cookieFilePath() {
    return join(app.getPath("userData"), "vc-localmusic-cookies.txt");
}

/** Lets the UI say whether Liked Music is reachable before anyone tries. */
export async function getBrowserLogin(_: IpcMainInvokeEvent): Promise<boolean> {
    try {
        const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({ domain: "youtube.com" });
        return cookies.some(c => isLoginCookie(c.name));
    } catch {
        return false;
    }
}

let cookieExport: Promise<string | null> | null = null;

/**
 * Writes the browse window's YouTube cookies out as a Netscape cookies.txt for
 * yt-dlp's --cookies. Signing in once in the Browse… window is therefore enough to
 * reach Liked Music and private playlists — no --cookies-from-browser, which can't
 * read Chrome's cookie DB on Windows anymore and needs the keyring on Linux.
 *
 * Re-exported before every invocation (a fresh sign-in must be picked up), but
 * concurrent invocations share one export rather than racing over the file.
 */
function exportSessionCookies(): Promise<string | null> {
    cookieExport ??= (async () => {
        const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({});
        const relevant = cookies.filter(c => COOKIE_DOMAINS.test((c.domain ?? "").replace(/^\./, "")));

        // anonymous cookies do nothing for yt-dlp, so don't bother passing them
        if (!relevant.some(c => isLoginCookie(c.name))) return null;

        const lines = relevant.map(c => [
            c.domain ?? "",
            c.domain?.startsWith(".") ? "TRUE" : "FALSE",
            c.path ?? "/",
            c.secure ? "TRUE" : "FALSE",
            // 0 marks a session cookie in the Netscape format
            Math.floor(c.expirationDate ?? 0),
            c.name,
            c.value
        ].join("\t"));

        const file = cookieFilePath();
        await writeFile(file, "# Netscape HTTP Cookie File\n" + lines.join("\n") + "\n", "utf8");
        return file;
    })().finally(() => { cookieExport = null; });

    return cookieExport;
}

// #endregion

/**
 * The exported browse-window cookies win whenever they exist: a file we wrote
 * ourselves always reads, while --cookies-from-browser fails outright on locked
 * or encrypted cookie DBs — which is every Chrome-family browser on Windows now.
 * The setting stays as the fallback for people signed in elsewhere.
 */
async function cookieArgs(opts: YtDlpOptions): Promise<string[]> {
    const file = await exportSessionCookies().catch(() => null);
    if (file) return ["--cookies", file];
    if (opts.cookiesFromBrowser) return ["--cookies-from-browser", opts.cookiesFromBrowser];
    return [];
}

/** A fatal cookie complaint — the run can still succeed without cookies. */
function isCookieError(message: string) {
    return message.startsWith("ERROR:") && /cookie/i.test(message);
}

/** Downloads must land inside a folder the user opened, same rule as the file server. */
function requireAllowedFolder(opts: YtDlpOptions) {
    const folder = resolve(opts.folder);
    if (!isPathAllowed(folder)) throw new Error("Choose your music folder in the library first");
    return folder;
}

/** Collects stdout, with a hard timeout so a wedged yt-dlp can't hang the UI forever. */
function collect(binary: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((res, rej) => {
        const proc = run(binary, args);

        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => {
            proc.kill();
            rej(new Error("yt-dlp timed out"));
        }, timeoutMs);

        proc.stdout.on("data", chunk => stdout += chunk);
        proc.stderr.on("data", chunk => stderr += chunk);

        proc.on("error", e => {
            clearTimeout(timer);
            rej(new Error(describeSpawnError(e, binary)));
        });

        proc.on("close", code => {
            clearTimeout(timer);
            // --ignore-errors still exits non-zero, so only fail when there's nothing usable
            if (code !== 0 && !stdout.trim())
                return rej(new Error(stderr.trim().split("\n").at(-1) || `yt-dlp exited with code ${code}`));
            res(stdout);
        });
    });
}

export async function ytDlpInfo(_: IpcMainInvokeEvent, opts: YtDlpOptions): Promise<YtDlpInfo> {
    const binary = resolveBinary(opts);

    try {
        const version = (await collect(binary, ["--version"], 15_000)).trim();
        return { ok: true, binary, version };
    } catch (e) {
        return { ok: false, binary, error: e instanceof Error ? e.message : String(e) };
    }
}

// #endregion

// #region search

function pickThumbnail(entry: any): string | null {
    const thumbnails: any[] = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];

    // prefer something around list-row size rather than the largest available
    const sized = thumbnails.filter(t => typeof t?.url === "string" && t.width > 0);
    if (sized.length) {
        return sized.reduce((best, t) => Math.abs(t.width - 240) < Math.abs(best.width - 240) ? t : best).url;
    }

    return thumbnails.find(t => typeof t?.url === "string")?.url ?? entry.thumbnail ?? null;
}

/**
 * Searching through yt-dlp rather than the YouTube API means no key, no quota, and
 * the same extractor that will do the download - so anything listed here is
 * downloadable. With --cookies-from-browser a signed-in URL (a personal playlist,
 * liked songs, ...) works too.
 */
export async function search(
    _: IpcMainInvokeEvent,
    query: string,
    source: SearchSource,
    limit: number,
    opts: YtDlpOptions
): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    let target: string;
    if (/^https?:\/\//i.test(trimmed)) target = trimmed;
    else if (source === "ytmusic") target = `https://music.youtube.com/search?q=${encodeURIComponent(trimmed)}#songs`;
    // the ytsearchN: prefix also guarantees the argument can't start with a dash
    else target = `ytsearch${limit}:${trimmed}`;

    const buildArgs = (cookies: string[]) => [
        "--no-warnings",
        ...cookies,
        "--flat-playlist",
        "--dump-json",
        "--ignore-errors",
        "--playlist-end", String(limit),
        target
    ];

    const binary = resolveBinary(opts);
    const cookies = await cookieArgs(opts);

    let stdout: string;
    try {
        stdout = await collect(binary, buildArgs(cookies), 60_000);
    } catch (e) {
        // an unreadable browser jar shouldn't kill a search that works without it
        if (cookies[0] !== "--cookies-from-browser" || !(e instanceof Error) || !isCookieError(e.message)) throw e;
        stdout = await collect(binary, buildArgs([]), 60_000);
    }

    const results: SearchResult[] = [];
    for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;

        let entry: any;
        try {
            entry = JSON.parse(line);
        } catch {
            continue; // yt-dlp interleaves the odd non-JSON line
        }

        const url = entry.url ?? (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
        if (!url || entry._type === "playlist") continue;

        results.push({
            id: String(entry.id ?? url),
            url,
            title: entry.title ?? entry.id ?? url,
            uploader: entry.uploader ?? entry.channel ?? (Array.isArray(entry.artists) ? entry.artists.join(", ") : ""),
            duration: Math.round(entry.duration ?? 0),
            thumbnail: pickThumbnail(entry)
        });
    }

    return results.slice(0, limit);
}

// #endregion

// #region downloads

const jobs = new Map<string, DownloadJob>();
const processes = new Map<string, ChildProcess>();

let pendingBroadcast: NodeJS.Timeout | null = null;

/**
 * yt-dlp spawns ffmpeg as a child while postprocessing, and on Windows killing the
 * parent leaves that child holding the file. taskkill takes the whole tree.
 */
function killProcess(proc: ChildProcess) {
    if (process.platform === "win32" && proc.pid) {
        try {
            spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"]).on("error", () => proc.kill());
            return;
        } catch { }
    }

    proc.kill();
}

/** Progress lines arrive far faster than the UI needs them. */
function publishJobs(immediate = false) {
    if (immediate) {
        if (pendingBroadcast) clearTimeout(pendingBroadcast);
        pendingBroadcast = null;
        return broadcast("downloads", [...jobs.values()]);
    }

    pendingBroadcast ??= setTimeout(() => {
        pendingBroadcast = null;
        broadcast("downloads", [...jobs.values()]);
    }, 250);
}

const PROGRESS = /^\[download\]\s+([\d.]+)%/;
const DESTINATION = /^\[(?:download|ExtractAudio|VideoConvertor)\] Destination: (.+)$/;
const MERGING = /^\[Merger\] Merging formats into "(.+)"$/;
const ALREADY_DONE = /^\[download\] (.+) has already been downloaded$/;

function consumeOutput(job: DownloadJob, text: string) {
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;

        const progress = PROGRESS.exec(line);
        if (progress) {
            job.percent = Number(progress[1]);
            continue;
        }

        const destination = DESTINATION.exec(line) ?? MERGING.exec(line) ?? ALREADY_DONE.exec(line);
        if (destination) {
            job.title = basename(destination[1]);
            continue;
        }

        // postprocessing steps report no percentage, so surface them as status text
        if (line.startsWith("[")) job.message = line;
    }

    publishJobs();
}

async function beginDownload(url: string, playlist: boolean, opts: YtDlpOptions): Promise<DownloadJob> {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be downloaded");

    const folder = requireAllowedFolder(opts);
    const binary = resolveBinary(opts);

    const id = randomBytes(8).toString("hex");
    const job: DownloadJob = { id, url, title: url, percent: -1, status: "running", message: "Starting…" };
    jobs.set(id, job);
    publishJobs(true);

    const cookies = await cookieArgs(opts);

    const buildArgs = (cookieSet: string[]) => [
        "--no-warnings",
        ...cookieSet,
        "--newline", // one progress update per line instead of \r overwrites
        // the archive is what makes re-downloading a whole playlist (Liked Music,
        // say) incremental: everything already fetched once is skipped. Single
        // downloads skip it so re-downloading one track on purpose still works.
        ...(playlist
            ? ["--yes-playlist", "--download-archive", join(folder, ".vc-localmusic-archive.txt")]
            : ["--no-playlist"]),
        "--paths", folder,
        ...splitArgs(opts.extraArgs),
        url
    ];

    // a jar yt-dlp can't read fails the whole run before it downloads anything,
    // but the download itself usually works fine with no cookies at all
    let canRetryWithoutCookies = cookies[0] === "--cookies-from-browser";

    const start = (cookieSet: string[]) => {
        let proc: ReturnType<typeof run>;
        try {
            proc = run(binary, buildArgs(cookieSet));
        } catch (e) {
            // spawn can also throw synchronously (a bad binary path on Windows, say). The
            // job is already in the map by now, so it has to be failed here or it would sit
            // at "Starting…" with nothing left to move it along.
            job.status = "error";
            job.message = describeSpawnError(e as NodeJS.ErrnoException, binary);
            publishJobs(true);
            return;
        }

        processes.set(id, proc);

        proc.stdout.on("data", chunk => consumeOutput(job, String(chunk)));

        proc.stderr.on("data", chunk => {
            const lines = String(chunk).split(/\r?\n/).filter(l => l.trim());
            const failure = lines.reverse().find(l => l.startsWith("ERROR:"));
            if (failure) job.message = failure;
            publishJobs();
        });

        proc.on("error", e => {
            processes.delete(id);
            job.status = "error";
            job.message = describeSpawnError(e, binary);
            publishJobs(true);
        });

        proc.on("close", code => {
            processes.delete(id);
            if (job.status !== "running") return publishJobs(true); // cancelled

            if (code === 0) {
                job.status = "done";
                job.percent = 100;
                job.message = "Done";
            } else if (canRetryWithoutCookies && isCookieError(job.message)) {
                canRetryWithoutCookies = false;
                job.percent = -1;
                job.message = "Browser cookies were unreadable — retrying without them";
                start([]);
            } else {
                job.status = "error";
                if (!job.message.startsWith("ERROR:")) job.message = `yt-dlp exited with code ${code}`;
            }

            publishJobs(true);
        });
    };

    start(cookies);
    return job;
}

export async function startDownload(
    _: IpcMainInvokeEvent,
    url: string,
    playlist: boolean,
    opts: YtDlpOptions
): Promise<DownloadJob> {
    return beginDownload(url, playlist, opts);
}

/**
 * The renderer normally learns about jobs from the SSE stream, but a stream that
 * dropped (or a plugin that restarted) leaves it holding a snapshot that can never
 * catch up — which is what strands a failed download as a row that still looks like
 * it is running. This is the reconcile that gets it unstuck.
 */
export async function getDownloads(_: IpcMainInvokeEvent): Promise<DownloadJob[]> {
    return [...jobs.values()];
}

export async function cancelDownload(_: IpcMainInvokeEvent, id: string) {
    const job = jobs.get(id);
    const proc = processes.get(id);

    if (job?.status === "running") {
        // a running job with no live process behind it is a leftover from a spawn that
        // never reported back; either way the row has to stop claiming to be running
        job.status = "cancelled";
        job.message = proc ? "Cancelled" : "Stopped";
    }

    if (proc) {
        killProcess(proc);
        // a process that never reports close would otherwise be tracked forever and
        // hold up shutdown, so stop waiting on it after a grace period
        setTimeout(() => {
            if (processes.get(id) === proc) processes.delete(id);
        }, 5_000).unref?.();
    }

    publishJobs(true);
}

/** Drops a single job, however it ended — the escape hatch for a row that wedged. */
export async function removeDownload(_: IpcMainInvokeEvent, id: string) {
    const proc = processes.get(id);
    if (proc) {
        killProcess(proc);
        processes.delete(id);
    }

    jobs.delete(id);
    publishJobs(true);
}

/** Drops everything that isn't still running, so the list doesn't grow forever. */
export async function clearFinishedDownloads(_: IpcMainInvokeEvent) {
    for (const [id, job] of jobs) {
        if (job.status !== "running") jobs.delete(id);
    }
    publishJobs(true);
}

// #endregion

// #region custom tools

/**
 * Runs whatever the user configured — a python script, a shell one-liner, another
 * downloader entirely. The plugin knows nothing about the tool beyond how to start
 * it, so the deal is deliberately small: we spawn it, keep every line it prints,
 * and let the user type back at it.
 *
 * The process is owned here, in main, and not by the modal that started it. That is
 * the whole reason closing the Download window (or reloading Discord) doesn't
 * interrupt a download: the renderer is a viewer onto this map, never its owner.
 *
 * A tool that wants a progress bar instead of just scrollback can opt in by
 * printing prefixed lines — see TOOL_PROTOCOL. Anything unrecognised is still
 * shown verbatim, so a tool that knows none of this works fine.
 */

/** How much scrollback a run keeps. Older lines are dropped from the head. */
const MAX_TOOL_LINES = 3000;
/** A line-noisy tool shouldn't get to drive the SSE stream at its own pace. */
const TOOL_FLUSH_MS = 120;
/** A tool printing without newlines still has to reach the console eventually. */
const MAX_PARTIAL = 4096;

interface RunState {
    run: ToolRun;
    /** the tail of the output; `run.total` counts every line ever produced */
    lines: ToolLine[];
    proc: ChildProcess | null;
    /** produced since the last flush, waiting to go out over the event stream */
    pending: ToolLine[];
    /** absolute index of pending[0] */
    pendingFrom: number;
    /** trailing text from a chunk that ended mid-line, per stream */
    partial: { out: string; err: string; };
    /** the tool's own last complaint, preferred over "exited with code n" */
    lastError: string;
}

const runs = new Map<string, RunState>();
let toolFlush: NodeJS.Timeout | null = null;

/** Absolute index of lines[0], once the head has started falling off. */
function firstIndex(state: RunState) {
    return state.run.total - state.lines.length;
}

function flushTools() {
    if (toolFlush) clearTimeout(toolFlush);
    toolFlush = null;

    for (const state of runs.values()) {
        if (!state.pending.length) continue;

        broadcast("toolOutput", {
            runId: state.run.id,
            from: state.pendingFrom,
            total: state.run.total,
            lines: state.pending
        } satisfies ToolOutput);

        state.pending = [];
        state.pendingFrom = state.run.total;
    }

    broadcast("toolRuns", [...runs.values()].map(s => s.run));
}

function publishTools(immediate = false) {
    if (immediate) return flushTools();
    toolFlush ??= setTimeout(flushTools, TOOL_FLUSH_MS);
}

function appendLine(state: RunState, stream: ToolLine["stream"], text: string) {
    const line: ToolLine = { stream, text };

    state.lines.push(line);
    state.pending.push(line);
    state.run.total++;

    if (state.lines.length > MAX_TOOL_LINES)
        state.lines.splice(0, state.lines.length - MAX_TOOL_LINES);

    publishTools();
}

/**
 * The opt-in line protocol. Everything here is optional — a tool that prints none
 * of it just gets a spinning bar and its raw output, which is the normal case.
 */
const TOOL_PROTOCOL = /^\[(log|progress|done|error|status|session|break)\]\s?(.*)$/;

function consumeToolLine(state: RunState, text: string) {
    const match = TOOL_PROTOCOL.exec(text);
    if (!match) return;

    const [, kind, body] = match;
    const trimmed = body.trim();

    switch (kind) {
        case "progress": {
            const percent = Number(trimmed);
            if (Number.isFinite(percent)) state.run.percent = Math.max(0, Math.min(100, percent));
            break;
        }

        case "done":
            state.run.outputPath = trimmed || null;
            state.run.percent = 100;
            state.run.message = trimmed ? basename(trimmed) : "Done";
            break;

        case "error":
            // remembered rather than applied: the run is only failed by a non-zero
            // exit, so a tool that reports an error and then recovers still counts
            state.lastError = trimmed || state.lastError;
            state.run.message = trimmed || state.run.message;
            break;

        default:
            if (trimmed) state.run.message = trimmed;
    }
}

function consumeToolChunk(state: RunState, stream: "out" | "err", chunk: string) {
    const parts = (state.partial[stream] + chunk).split(/\r?\n/);

    // whatever trails the last newline is an unfinished line, held for the next chunk
    let rest = parts.pop() ?? "";
    // a bare \r is a progress bar redrawing in place; only the newest draw matters
    if (rest.includes("\r")) rest = rest.slice(rest.lastIndexOf("\r") + 1);
    // ...but a tool that never emits a newline at all still has to show up
    if (rest.length > MAX_PARTIAL) {
        parts.push(rest);
        rest = "";
    }
    state.partial[stream] = rest;

    for (const raw of parts) {
        const line = raw.includes("\r") ? raw.slice(raw.lastIndexOf("\r") + 1) : raw;

        appendLine(state, stream, line);
        if (stream === "err" && line.trim()) state.lastError = line.trim();
        consumeToolLine(state, line);
    }
}

// #region finding the program

function isFile(path: string) {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * Finds a bare command name on the PATH, returning an absolute path.
 *
 * Handing the bare name to spawn would be the obvious thing, but the platform's
 * own search is not dependable: a single malformed PATH entry (a stray quote is
 * enough) makes Windows give up on the whole search, and every command then comes
 * back ENOENT even though it is plainly installed. Doing the walk here means one
 * bad entry costs that entry and nothing else.
 */
function resolveOnPath(name: string): string | null {
    // anything with a separator in it is already a path, not a name to look up
    if (name.includes("/") || name.includes(sep)) return null;

    const extensions = process.platform === "win32"
        ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
        : [""];

    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
        // entries can arrive quoted, and sometimes half-quoted
        const dir = entry.trim().replace(/^["']+|["']+$/g, "");
        if (!dir) continue;

        for (const extension of extensions) {
            const candidate = join(dir, name + extension);
            if (isFile(candidate)) return candidate;
        }
    }

    return null;
}

/**
 * Scripts can't be executed on their own — Windows can only start a real binary,
 * so pointing the command at a .py fails with EFTYPE before a line of it runs.
 * The names are tried in order and the first one actually installed wins; `py`
 * leads for .py because the Windows launcher picks a real Python, while a bare
 * `python` is so often some unrelated virtualenv's shim.
 */
const INTERPRETERS: Record<string, string[]> = {
    ".py": ["py", "python3", "python"],
    ".js": ["node"],
    ".mjs": ["node"],
    ".cjs": ["node"],
    ".rb": ["ruby"],
    ".pl": ["perl"],
    ".sh": ["bash", "sh"],
    ".ps1": ["pwsh", "powershell"]
};

/** The program to actually start, and whatever has to come before the user's args. */
interface LaunchPlan {
    program: string;
    leading: string[];
}

async function isExecutable(path: string) {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function planLaunch(command: string): Promise<LaunchPlan> {
    const direct = { program: resolveOnPath(command) ?? command, leading: [] };

    const names = INTERPRETERS[extname(command).toLowerCase()];
    if (!names) return direct;

    // a script carrying a shebang and an exec bit already knows how to start
    // itself, and it knows better than this table does — leave it alone
    if (process.platform !== "win32" && await isExecutable(command)) return direct;

    for (const name of names) {
        const program = resolveOnPath(name);
        if (!program) continue;

        // powershell has to be told this is a script rather than a command to eval
        const flag = /pwsh|powershell/.test(name) ? ["-File"] : [];
        return { program, leading: [...flag, command] };
    }

    // nothing suitable is installed; let the spawn fail and say so properly
    return direct;
}

// #endregion

/** What a run can be told about the moment it was started. */
interface ToolContext {
    url: string;
    query: string;
    folder: string;
    tool: string;
}

const PLACEHOLDER = /\{(url|query|folder|tool)\}/g;

function fillPlaceholders(text: string, ctx: ToolContext) {
    return text.replace(PLACEHOLDER, (_, key: keyof ToolContext) => ctx[key] ?? "");
}

/** Quoting for the shell path only — the normal path never builds a command string. */
function shellQuote(value: string) {
    return process.platform === "win32"
        ? `"${value.replace(/"/g, '""')}"`
        : `'${value.replace(/'/g, "'\\''")}'`;
}

function buildToolArgs(tool: CustomTool, ctx: ToolContext) {
    // split first, substitute second: a value containing spaces then stays one
    // argument instead of being torn into several by whatever it happens to hold
    return splitArgs(tool.args)
        .map(token => ({ token, filled: fillPlaceholders(token, ctx) }))
        // a placeholder that resolved to nothing should disappear, not become ""
        .filter(({ token, filled }) => filled !== "" || token === "")
        .map(({ filled }) => filled);
}

async function checkToolCwd(cwd: string) {
    if (!cwd) return "";

    const dir = resolve(cwd);
    try {
        if (!(await stat(dir)).isDirectory()) throw new Error("not a directory");
    } catch {
        throw new Error(`The folder for this tool doesn't exist: ${dir}`);
    }

    return dir;
}

export async function startTool(
    _: IpcMainInvokeEvent,
    tool: CustomTool,
    context: Partial<ToolContext>
): Promise<ToolRun> {
    const command = tool.command.trim();
    if (!command) throw new Error("This tool has no command to run — set one first");

    const cwd = await checkToolCwd(tool.cwd.trim());

    const ctx: ToolContext = {
        url: context.url ?? "",
        query: context.query ?? "",
        folder: context.folder ?? "",
        tool: tool.name
    };

    const filledCommand = fillPlaceholders(command, ctx);
    const args = buildToolArgs(tool, ctx);

    // a script goes behind its interpreter, and a bare name becomes a real path
    const plan = tool.shell
        ? { program: filledCommand, leading: [] as string[] }
        : await planLaunch(filledCommand);
    const argv = [...plan.leading, ...args];

    // in shell mode the shell does the splitting, so we hand over one string and
    // quote every substituted value into it rather than trusting what they contain
    const line = tool.shell
        ? [filledCommand, ...splitArgs(tool.args).map(token => {
            const filled = fillPlaceholders(token, ctx);
            return filled === token ? token : shellQuote(filled);
        })].join(" ")
        : "";

    const id = randomBytes(8).toString("hex");
    const run: ToolRun = {
        id,
        toolId: tool.id,
        toolName: tool.name,
        commandLine: tool.shell ? line : [plan.program, ...argv].join(" "),
        status: "running",
        percent: -1,
        message: "Starting…",
        startedAt: Date.now(),
        outputPath: null,
        total: 0
    };

    const state: RunState = {
        run,
        lines: [],
        proc: null,
        pending: [],
        pendingFrom: 0,
        partial: { out: "", err: "" },
        lastError: ""
    };
    runs.set(id, state);

    appendLine(state, "meta", `$ ${run.commandLine}`);
    if (cwd) appendLine(state, "meta", `  in ${cwd}`);

    let proc: ChildProcess;
    try {
        proc = tool.shell
            ? spawn(line, { cwd: cwd || undefined, env: spawnEnv(), shell: true, windowsHide: true })
            : spawn(plan.program, argv, { cwd: cwd || undefined, env: spawnEnv(), windowsHide: true });
    } catch (e) {
        // EFTYPE and friends throw synchronously rather than arriving on "error".
        // The run is already in the map, so it has to be failed here or it sits
        // at "Starting…" with nothing left to move it along
        run.status = "error";
        run.message = describeToolSpawnError(e as NodeJS.ErrnoException, plan.program);
        appendLine(state, "err", run.message);
        publishTools(true);
        return run;
    }

    state.proc = proc;
    run.message = "Running";

    proc.stdout?.on("data", chunk => consumeToolChunk(state, "out", String(chunk)));
    proc.stderr?.on("data", chunk => consumeToolChunk(state, "err", String(chunk)));
    // a tool that exits while we still hold its stdin would otherwise raise EPIPE
    proc.stdin?.on("error", () => { });

    proc.on("error", e => {
        state.proc = null;
        run.status = "error";
        run.message = describeToolSpawnError(e, plan.program);
        appendLine(state, "err", run.message);
        publishTools(true);
    });

    proc.on("close", code => {
        state.proc = null;

        // flush whatever the tool printed without a trailing newline
        for (const stream of ["out", "err"] as const) {
            if (state.partial[stream]) {
                appendLine(state, stream, state.partial[stream]);
                state.partial[stream] = "";
            }
        }

        if (run.status === "running") {
            if (code === 0) {
                run.status = "done";
                run.percent = 100;
                if (!run.outputPath) run.message = "Done";
            } else {
                run.status = "error";
                run.message = state.lastError || `${tool.name} exited with code ${code}`;
            }
        }

        appendLine(state, "meta", `— exited with code ${code}`);
        publishTools(true);
    });

    publishTools(true);
    return run;
}

function describeToolSpawnError(error: NodeJS.ErrnoException, command: string) {
    // the extension table covers the usual scripts, so reaching this means either
    // an unusual one or an interpreter that isn't installed
    if (error.code === "EFTYPE" || error.code === "ENOEXEC")
        return `${command} isn't a program this system can run on its own — `
            + "put the interpreter (py, node, bash) in Command and this file first in Arguments";
    if (error.code === "ENOENT")
        return `Could not find ${command} — give the tool an absolute path, or make sure it's on your PATH`;
    if (error.code === "EACCES")
        return `${command} is not executable — try chmod +x ${command}`;
    return error.message;
}

export async function getToolRuns(_: IpcMainInvokeEvent): Promise<ToolRun[]> {
    return [...runs.values()].map(s => s.run);
}

/**
 * Hands back the scrollback from `from` onwards. A console that reopened knows
 * nothing, so it asks from 0 and gets whatever survived the ring buffer — the
 * returned `from` says where that actually starts.
 */
export async function getToolOutput(_: IpcMainInvokeEvent, id: string, from = 0): Promise<ToolOutput | null> {
    const state = runs.get(id);
    if (!state) return null;

    const start = Math.max(from, firstIndex(state));

    return {
        runId: id,
        from: start,
        total: state.run.total,
        lines: state.lines.slice(start - firstIndex(state))
    };
}

/** Types a line at the running tool, echoed into the console so it's visible. */
export async function writeToolInput(_: IpcMainInvokeEvent, id: string, text: string): Promise<boolean> {
    const state = runs.get(id);
    if (!state?.proc?.stdin?.writable) return false;

    appendLine(state, "meta", `> ${text}`);
    state.proc.stdin.write(text + "\n");
    publishTools(true);
    return true;
}

export async function cancelTool(_: IpcMainInvokeEvent, id: string) {
    const state = runs.get(id);
    if (!state) return;

    if (state.run.status === "running") {
        // a running row with no process behind it is a leftover from a spawn that
        // never reported back — either way it has to stop claiming to be running
        state.run.status = "cancelled";
        state.run.message = state.proc ? "Cancelled" : "Stopped";
        appendLine(state, "meta", "— cancelled");
    }

    if (state.proc) {
        killProcess(state.proc);
        state.proc = null;
    }

    publishTools(true);
}

export async function removeToolRun(_: IpcMainInvokeEvent, id: string) {
    const state = runs.get(id);
    if (state?.proc) killProcess(state.proc);

    runs.delete(id);
    publishTools(true);
}

export async function clearFinishedToolRuns(_: IpcMainInvokeEvent) {
    for (const [id, state] of runs) {
        if (state.run.status !== "running") runs.delete(id);
    }
    publishTools(true);
}

/** Kills every running tool — for when the plugin itself is being shut down. */
export async function stopTools(_: IpcMainInvokeEvent) {
    for (const state of runs.values()) {
        if (state.proc) killProcess(state.proc);
        state.proc = null;
    }
    runs.clear();
}

/** Directory picker for a tool's working folder. Deliberately not a music root. */
export async function pickToolFolder(e: IpcMainInvokeEvent): Promise<string | null> {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = {
        properties: ["openDirectory" as const],
        title: "Choose the folder your downloader lives in"
    };

    const { canceled, filePaths } = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

    return canceled || !filePaths.length ? null : resolve(filePaths[0]);
}

/**
 * File picker for the command itself. Picking a script is the natural thing to do
 * and the one thing that cannot work — nothing executes a .py directly — so the
 * split is done here: the interpreter becomes the command, the script becomes the
 * first argument, and what comes back is a configuration that actually runs.
 */
export async function pickToolCommand(
    e: IpcMainInvokeEvent
): Promise<{ command: string; args: string; } | null> {
    const window = BrowserWindow.fromWebContents(e.sender);
    const options = {
        properties: ["openFile" as const],
        title: "Choose the program or script to run"
    };

    const { canceled, filePaths } = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

    if (canceled || !filePaths.length) return null;

    const plan = await planLaunch(resolve(filePaths[0]));

    return {
        command: plan.program,
        // the args field is re-split on whitespace later, so a path has to survive it
        args: plan.leading.map(part => /\s/.test(part) ? `"${part}"` : part).join(" ")
    };
}

// #endregion

// #region browser

/**
 * A plain Electron window pointed at YouTube Music. The site itself is left
 * completely alone — browsing, searching and playback all behave like a normal
 * browser. Our additions live in the bar along the bottom: "Download playing"
 * queues whatever the page's player is currently playing, and "Queue this page"
 * queues the page URL itself (an album, a playlist, a video).
 *
 * The page can't talk to us directly — it has no preload and no node access, which
 * is the point. Instead the injected script navigates to an unresolvable sentinel
 * host and `will-navigate` reads the request off the URL and cancels it. That works
 * regardless of what the page's own CSP allows.
 */
const BROWSER_ORIGIN = "https://vc-localmusic.invalid/";
const DEFAULT_BROWSE_URL = "https://music.youtube.com/";

let browser: BrowserWindow | null = null;
/** the download settings the browser was opened with, reused for everything it queues */
let browseOptions: { playlist: boolean; opts: YtDlpOptions; } | null = null;

function browserToast(text: string, tone: "ok" | "error" = "ok") {
    browser?.webContents
        .executeJavaScript(`window.__vcLocalMusicToast?.(${JSON.stringify(text)},${JSON.stringify(tone)})`)
        .catch(() => { });
}

async function enqueueFromBrowser(url: string) {
    if (!browseOptions) return;

    try {
        await beginDownload(url, browseOptions.playlist, browseOptions.opts);
        browserToast("Added to downloads");
    } catch (e) {
        browserToast(e instanceof Error ? e.message : String(e), "error");
    }
}

/** Runs in the page, in the page's own world. Kept idempotent — it is re-injected on every navigation. */
const BROWSER_SCRIPT = `(() => {
    const SENTINEL = ${JSON.stringify(BROWSER_ORIGIN)};

    const ask = (path, params) => {
        const url = new URL(path, SENTINEL);
        for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
        location.href = url.toString();
    };

    const isTrack = href => {
        try {
            const url = new URL(href, location.href);
            if (/(^|\\.)youtu\\.be$/i.test(url.hostname)) return url.pathname.length > 1;
            if (!/(^|\\.)youtube\\.com$/i.test(url.hostname)) return false;
            return (url.pathname === "/watch" && url.searchParams.has("v"))
                || url.pathname.startsWith("/shorts/");
        } catch {
            return false;
        }
    };

    // Running in the page's world means the player element is reachable, and
    // getVideoData() is how the page itself knows what it is playing — so this
    // works from anywhere in the app, not just on a /watch page. Both YouTube and
    // YouTube Music mount their player as #movie_player.
    const playingUrl = () => {
        try {
            const data = document.getElementById("movie_player")?.getVideoData?.();
            if (data?.video_id) return location.origin + "/watch?v=" + data.video_id;
        } catch { }
        return isTrack(location.href) ? location.href : null;
    };

    // the bar lives in a shadow root so the page's stylesheets can't reach it, and is
    // re-attached on demand because a client-side route change can wipe the body
    const mount = () => {
        let host = window.__vcLocalMusicBar;

        if (!host) {
            host = window.__vcLocalMusicBar = document.createElement("div");
            host.attachShadow({ mode: "open" }).innerHTML =
                "<style>" +
                ":host{position:fixed;inset-inline:0;inset-block-end:0;z-index:2147483647;font-family:system-ui,sans-serif}" +
                ".bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111;color:#fff;box-shadow:0 -2px 12px rgb(0 0 0 / 50%)}" +
                "button{font:inherit;font-size:13px;padding:4px 10px;border:0;border-radius:4px;background:#2b2d31;color:#fff;cursor:pointer}" +
                "button:hover{background:#3f4248}" +
                ".primary{background:#5865f2}" +
                ".primary:hover{background:#4752c4}" +
                ".hint{flex:1 1 auto;font-size:12px;opacity:.65}" +
                ".toast{font-size:12px;opacity:0;transition:opacity .15s ease}" +
                ".toast.show{opacity:1}" +
                ".toast.error{color:#f38688}" +
                "</style>" +
                "<div class=bar>" +
                "<button id=back>&#8592;</button>" +
                "<button id=forward>&#8594;</button>" +
                "<button id=reload>&#8635;</button>" +
                "<span class=hint>Browse and play as normal, then download from here</span>" +
                "<span class=toast id=toast></span>" +
                "<button id=queue>Queue this page</button>" +
                "<button class=primary id=playing>&#10515; Download playing</button>" +
                "</div>";

            const shadow = host.shadowRoot;
            const on = (id, fn) => shadow.getElementById(id).addEventListener("click", fn);

            on("back", () => history.back());
            on("forward", () => history.forward());
            on("reload", () => location.reload());
            on("queue", () => ask("/enqueue", { url: location.href }));
            on("playing", () => {
                const url = playingUrl();
                if (url) ask("/enqueue", { url });
                else window.__vcLocalMusicToast?.("Nothing is playing yet", "error");
            });

            let timer;
            window.__vcLocalMusicToast = (text, tone) => {
                const toast = window.__vcLocalMusicBar?.shadowRoot?.getElementById("toast");
                if (!toast) return;

                toast.textContent = text;
                toast.className = "toast show" + (tone === "error" ? " error" : "");
                clearTimeout(timer);
                timer = setTimeout(() => toast.classList.remove("show"), 4000);
            };
        }

        if (!host.isConnected) document.documentElement.appendChild(host);
    };

    mount();
})();`;

export async function openBrowser(
    _: IpcMainInvokeEvent,
    startUrl: string,
    playlist: boolean,
    opts: YtDlpOptions
): Promise<void> {
    // fail before opening a window the user would only be able to browse uselessly
    requireAllowedFolder(opts);
    browseOptions = { playlist, opts };

    const target = /^https?:\/\//i.test(startUrl) ? startUrl : DEFAULT_BROWSE_URL;

    if (browser && !browser.isDestroyed()) {
        if (startUrl) browser.webContents.loadURL(target).catch(() => { });
        browser.focus();
        return;
    }

    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        autoHideMenuBar: true,
        backgroundColor: "#0b0b0b",
        title: "LocalMusic — pick something to download",
        webPreferences: {
            // its own session, so signing in here never touches Discord's cookies —
            // and the cookie export above is what lets yt-dlp reuse that sign-in
            partition: BROWSER_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    browser = win;
    win.on("closed", () => {
        if (browser === win) browser = null;
    });
    win.on("page-title-updated", e => e.preventDefault());

    const { webContents } = win;

    const inject = () => webContents.executeJavaScript(BROWSER_SCRIPT, true).catch(() => { });
    webContents.on("did-finish-load", inject);
    // YouTube is a single page app, so most "navigation" never reloads the document
    webContents.on("did-navigate-in-page", inject);

    webContents.setWindowOpenHandler(({ url }) => {
        // keep everything in the one window rather than spawning unmanaged popups
        if (/^https?:\/\//i.test(url)) webContents.loadURL(url).catch(() => { });

        return { action: "deny" };
    });

    webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith(BROWSER_ORIGIN)) return;
        event.preventDefault();

        try {
            const request = new URL(url);
            const target = request.searchParams.get("url");
            if (request.pathname === "/enqueue" && target) void enqueueFromBrowser(target);
        } catch { }
    });

    win.loadURL(target).catch(() => { });
}

/** Keeps an already-open browser in step with the downloader's settings. */
export async function updateBrowserOptions(_: IpcMainInvokeEvent, playlist: boolean, opts: YtDlpOptions) {
    if (browser && !browser.isDestroyed()) browseOptions = { playlist, opts };
}

export async function closeBrowser(_: IpcMainInvokeEvent) {
    browser?.destroy();
    browser = null;
    browseOptions = null;
}

// #endregion

// #region listen-along cache

/**
 * Where files received from a listen-along host land. Keyed by content hash so
 * a rejoin (or the same track queued again) never transfers twice. Registered
 * as an allowed root, which lets the existing /media endpoint serve cached
 * files — Range support and all — exactly like library files.
 */
// resolved lazily: app.getPath at module scope would run during Discord's
// bootstrap, and this module must never be able to break startup
const cacheDir = () => join(app.getPath("userData"), "vc-localmusic-cache");
const cacheIndexFile = () => join(cacheDir(), "cache-index.json");

interface CacheEntry {
    hash: string;
    file: string;
    size: number;
    lastUsed: number;
}

let cacheLimit = 2 * 1024 * 1024 * 1024;
let cacheIndex: Map<string, CacheEntry> | null = null;

interface CacheTransfer {
    stream: WriteStream;
    hasher: Hash;
    hash: string;
    ext: string;
    partPath: string;
    finalPath: string;
    written: number;
    expected: number;
}

const cacheTransfers = new Map<string, CacheTransfer>();

const isValidHash = (hash: string) => /^[0-9a-f]{64}$/.test(hash);

async function loadCacheIndex(): Promise<Map<string, CacheEntry>> {
    if (cacheIndex) return cacheIndex;

    cacheIndex = new Map();
    try {
        const entries: CacheEntry[] = JSON.parse(await readFile(cacheIndexFile(), "utf8"));
        for (const entry of entries) {
            // only trust rows whose file still exists
            if (existsSync(join(cacheDir(), entry.file))) cacheIndex.set(entry.hash, entry);
        }
    } catch {
        // first run, or a corrupt index — rebuild from what is on disk
        try {
            for (const name of await readdir(cacheDir())) {
                const hash = name.slice(0, 64);
                if (!isValidHash(hash) || name.endsWith(".part") || name === basename(cacheIndexFile())) continue;

                const { size, mtimeMs } = await stat(join(cacheDir(), name));
                cacheIndex.set(hash, { hash, file: name, size, lastUsed: mtimeMs });
            }
        } catch { }
    }

    return cacheIndex;
}

function saveCacheIndex() {
    if (!cacheIndex) return;
    writeFile(cacheIndexFile(), JSON.stringify([...cacheIndex.values()])).catch(() => { });
}

/** Oldest-used entries go first until the cache fits the configured limit. */
async function evictCache() {
    const index = await loadCacheIndex();

    let total = 0;
    for (const entry of index.values()) total += entry.size;
    if (total <= cacheLimit) return;

    const byAge = [...index.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of byAge) {
        if (total <= cacheLimit) break;

        index.delete(entry.hash);
        total -= entry.size;
        await rm(join(cacheDir(), entry.file), { force: true }).catch(() => { });
    }

    saveCacheIndex();
}

/**
 * Prepares the cache for a session: creates it, makes it servable, sweeps
 * orphaned .part files, and applies the size limit (0 = unlimited).
 */
export async function getCacheInfo(_: IpcMainInvokeEvent, limitBytes: number): Promise<{ dir: string; }> {
    await mkdir(cacheDir(), { recursive: true });
    allowedRoots.add(resolve(cacheDir()));
    cacheLimit = limitBytes > 0 ? limitBytes : Number.MAX_SAFE_INTEGER;

    try {
        for (const name of await readdir(cacheDir())) {
            if (name.endsWith(".part")) await rm(join(cacheDir(), name), { force: true }).catch(() => { });
        }
    } catch { }

    await loadCacheIndex();
    await evictCache();
    return { dir: cacheDir() };
}

/** Full path of a cached file, or null. Touches the entry for LRU purposes. */
export async function cacheHas(_: IpcMainInvokeEvent, contentHash: string): Promise<string | null> {
    if (!isValidHash(contentHash)) return null;

    const entry = (await loadCacheIndex()).get(contentHash);
    if (!entry) return null;

    const path = join(cacheDir(), entry.file);
    if (!existsSync(path)) {
        cacheIndex!.delete(contentHash);
        saveCacheIndex();
        return null;
    }

    entry.lastUsed = Date.now();
    saveCacheIndex();
    return path;
}

export async function cacheBegin(_: IpcMainInvokeEvent, contentHash: string, ext: string, size: number): Promise<string | null> {
    const cleanExt = ext.toLowerCase();
    if (!isValidHash(contentHash) || !(AUDIO_EXTS.has(cleanExt) || VIDEO_EXTS.has(cleanExt))) return null;

    await mkdir(cacheDir(), { recursive: true });
    allowedRoots.add(resolve(cacheDir()));

    const id = randomBytes(8).toString("hex");
    const partPath = join(cacheDir(), `${contentHash}${cleanExt}.${id}.part`);

    cacheTransfers.set(id, {
        stream: createWriteStream(partPath),
        hasher: createHash("sha256"),
        hash: contentHash,
        ext: cleanExt,
        partPath,
        finalPath: join(cacheDir(), `${contentHash}${cleanExt}`),
        written: 0,
        expected: size
    });

    return id;
}

export async function cacheAppend(_: IpcMainInvokeEvent, id: string, chunk: Uint8Array): Promise<boolean> {
    const transfer = cacheTransfers.get(id);
    if (!transfer) return false;

    // a runaway sender must not fill the disk past what it declared
    if (transfer.written + chunk.length > transfer.expected) {
        await abortTransfer(id);
        return false;
    }

    transfer.hasher.update(chunk);
    transfer.written += chunk.length;

    if (!transfer.stream.write(chunk)) {
        await new Promise<void>(res => transfer.stream.once("drain", () => res()));
    }
    return true;
}

async function abortTransfer(id: string) {
    const transfer = cacheTransfers.get(id);
    if (!transfer) return;

    cacheTransfers.delete(id);
    await new Promise<void>(res => transfer.stream.end(() => res()));
    await rm(transfer.partPath, { force: true }).catch(() => { });
}

/**
 * Ends a transfer, verifying the bytes really are the file the host promised.
 * @returns the final path on success, null on a hash/size mismatch
 */
export async function cacheFinish(_: IpcMainInvokeEvent, id: string): Promise<string | null> {
    const transfer = cacheTransfers.get(id);
    if (!transfer) return null;

    cacheTransfers.delete(id);
    await new Promise<void>(res => transfer.stream.end(() => res()));

    if (transfer.written !== transfer.expected || transfer.hasher.digest("hex") !== transfer.hash) {
        await rm(transfer.partPath, { force: true }).catch(() => { });
        return null;
    }

    await rename(transfer.partPath, transfer.finalPath);

    const index = await loadCacheIndex();
    index.set(transfer.hash, {
        hash: transfer.hash,
        file: basename(transfer.finalPath),
        size: transfer.written,
        lastUsed: Date.now()
    });
    saveCacheIndex();
    await evictCache();

    return transfer.finalPath;
}

export async function cacheAbort(_: IpcMainInvokeEvent, id: string) {
    await abortTransfer(id);
}

/** hash memo keyed by path — invalidated when the file's mtime or size moves */
const hashMemo = new Map<string, { mtimeMs: number; size: number; hash: string; }>();

/** Streaming sha256 of a library file; the identity a transfer is verified against. */
export async function hashFile(_: IpcMainInvokeEvent, path: string): Promise<string | null> {
    if (!isPathAllowed(path)) return null;

    try {
        const { mtimeMs, size } = await stat(path);

        const memo = hashMemo.get(path);
        if (memo && memo.mtimeMs === mtimeMs && memo.size === size) return memo.hash;

        const hash = await new Promise<string>((res, rej) => {
            const hasher = createHash("sha256");
            createReadStream(path)
                .on("data", chunk => hasher.update(chunk))
                .on("end", () => res(hasher.digest("hex")))
                .on("error", rej);
        });

        hashMemo.set(path, { mtimeMs, size, hash });
        return hash;
    } catch {
        return null;
    }
}

/** One slice of a file, for the host's file-channel sender. */
export async function readFileChunk(_: IpcMainInvokeEvent, path: string, offset: number, length: number): Promise<Uint8Array | null> {
    if (!isPathAllowed(path)) return null;

    let handle;
    try {
        handle = await open(path, "r");
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => { });
    }
}

// #endregion

export async function stopServer(_: IpcMainInvokeEvent) {
    releaseMediaKeys();

    browser?.destroy();
    browser = null;
    browseOptions = null;

    for (const proc of processes.values()) killProcess(proc);
    processes.clear();
    jobs.clear();

    // half-written listen-along transfers can never be completed now
    for (const id of [...cacheTransfers.keys()]) await abortTransfer(id);

    // the exported cookie jar is only ever needed while yt-dlp runs
    unlink(cookieFilePath()).catch(() => { });

    for (const client of eventClients) client.end();
    eventClients.clear();

    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;

    server?.close();
    server = null;
    serverInfo = null;
}
