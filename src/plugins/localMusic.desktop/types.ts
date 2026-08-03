/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Track {
    /** absolute path on disk, also the identity of the track */
    path: string;
    /** file name without extension, used as a fallback title */
    fileName: string;
    ext: string;
    size: number;
    isVideo: boolean;
}

/**
 * One slot in the "play next" queue. Carries an id rather than just a path so the
 * same track can be queued twice and still be told apart by a drag or a remove.
 */
export interface QueueItem {
    id: string;
    /** the Track.path this slot points at */
    path: string;
}

export interface TrackMetadata {
    title?: string;
    artist?: string;
    album?: string;
    /** 1 based position on the album; what album order is sorted by */
    track?: number;
    /** which disc of a set, for the albums that come on more than one */
    disc?: number;
    /** whether the file embeds cover art we can serve from /art */
    hasArt: boolean;
}

export interface ServerInfo {
    port: number;
    token: string;
}

/** Everything the main process needs to invoke yt-dlp the way the user configured it. */
export interface YtDlpOptions {
    /** where downloads land; must be inside an authorised folder */
    folder: string;
    /** explicit binary path, or "" to look next to the music and then on PATH */
    binary: string;
    /** extra flags, as typed by the user - split on whitespace, honouring quotes */
    extraArgs: string;
    /** browser name for --cookies-from-browser, or "" to not pass it */
    cookiesFromBrowser: string;
}

export interface YtDlpInfo {
    ok: boolean;
    /** what we actually tried to run, so the UI can say where it looked */
    binary: string;
    version?: string;
    error?: string;
}

export type DownloadStatus = "running" | "done" | "error" | "cancelled";

export interface DownloadJob {
    id: string;
    url: string;
    /** the output file name once yt-dlp reports one, the URL until then */
    title: string;
    /** 0-100, or -1 before yt-dlp reports any progress */
    percent: number;
    status: DownloadStatus;
    /** latest status line; the failure reason once status is "error" */
    message: string;
}

/** One timed word inside a line. Only present when the source carried word timing. */
export interface LyricWord {
    /** seconds from the start of the track */
    start: number;
    end: number;
    text: string;
}

export interface LyricLine {
    start: number;
    /** seconds; the next line's start when the format doesn't give one */
    end: number;
    text: string;
    /**
     * Per-word timing, when the source had it (enhanced LRC, SYLT). Absent lines
     * get their words timed by length at render time, which is what makes the
     * sweep look the same whichever source a track ended up matching.
     */
    words?: LyricWord[];
}

/** Where a set of lyrics came from, in the order the providers are tried. */
export type LyricsSource = "sidecar" | "embedded" | "netease" | "lrclib";

/** A provider that a candidate can be fetched back from on its own. */
export type LyricsProvider = "lrclib" | "netease";

/**
 * One result of a manual lyrics search. Carries enough to re-fetch the exact
 * same lyrics later, so a track the user corrected by hand stays corrected.
 */
export interface LyricsCandidate {
    provider: LyricsProvider;
    /** provider-native id */
    id: string;
    title: string;
    artist: string;
    album: string;
    /** seconds; 0 when the provider didn't say */
    duration: number;
    /** true when this one carries per-word timing */
    wordLevel: boolean;
    synced: boolean;
}

export interface Lyrics {
    lines: LyricLine[];
    /** false when all we found was an untimed block of text */
    synced: boolean;
    /** true when at least one line carried real per-word timing */
    wordLevel: boolean;
    source: LyricsSource;
    /** the track is known to be an instrumental — show that rather than "not found" */
    instrumental: boolean;
}

/** What the renderer knows about a track when it asks for its lyrics. */
export interface LyricsRequest {
    /** null for a listen-along listener, who has no local file to look beside */
    path: string | null;
    title: string;
    artist: string;
    album: string;
    /** seconds; 0 when not known yet */
    duration: number;
    /** false to use only what is already on disk (sidecar, tags, cache) */
    allowNetwork: boolean;
    /** whether to spend a request looking for per-word timing before falling back */
    wordLevel: boolean;
    /**
     * A candidate the user picked by hand for this track. When set it is fetched
     * directly and every other provider, including the local ones, is skipped —
     * an override the file could silently outrank would not be much of one.
     */
    override?: LyricsCandidate;
}

/**
 * A downloader the user wired up themselves — anything runnable, described well
 * enough that the plugin can spawn it and show its output. Nothing here is
 * specific to any one tool; the placeholders in `args` are the whole contract.
 */
export interface CustomTool {
    id: string;
    /** what the button says */
    name: string;
    /** working directory the process is started in; "" leaves it at Discord's */
    cwd: string;
    /** the program to run — an absolute path, or a name found on PATH */
    command: string;
    /**
     * Argument template. Split on whitespace (quotes honoured) *before*
     * substitution, so a value containing spaces stays a single argument.
     * Placeholders: {url} {query} {folder} {tool}
     */
    args: string;
    /**
     * Hand the whole line to the platform shell instead of spawning the command
     * directly. Off is both safer and enough for a normal script; on is what
     * makes pipes, redirection and `&&` work.
     */
    shell: boolean;
}

export type ToolRunStatus = "running" | "done" | "error" | "cancelled";

/** One invocation of a CustomTool, owned by the main process for its whole life. */
export interface ToolRun {
    id: string;
    toolId: string;
    /** copied at launch, so the row still reads right if the tool is renamed */
    toolName: string;
    /** the command line as actually run, shown above the console */
    commandLine: string;
    status: ToolRunStatus;
    /** 0-100, or -1 until the tool reports progress */
    percent: number;
    /** the latest thing worth reading: a [log] line, an error, or a lifecycle note */
    message: string;
    startedAt: number;
    /** absolute path the tool announced with [done], when it announced one */
    outputPath: string | null;
    /** how many lines the run has produced in total, including any since dropped */
    total: number;
}

/** Where an output line came from. "meta" is the plugin talking, not the tool. */
export type ToolStream = "out" | "err" | "meta";

export interface ToolLine {
    stream: ToolStream;
    text: string;
}

/**
 * A window onto a run's scrollback. `from` is the absolute index of the first
 * line, which is what lets the console tell "here is more" from "you missed
 * some, resynchronise" without the two sides ever comparing whole buffers.
 */
export interface ToolOutput {
    runId: string;
    from: number;
    /** lines produced in total, so the console knows if it is behind */
    total: number;
    lines: ToolLine[];
}

// #region file explorer

/** What every row in the folder browser has, whether it is a folder or a file. */
interface FolderEntryBase {
    /** absolute path on disk — the identity of the entry */
    path: string;
    name: string;
}

export interface FolderDir extends FolderEntryBase {
    /** playable files sitting directly inside, or -1 when we didn't look */
    trackCount: number;
    /** directories directly inside, or -1 when we didn't look */
    folderCount: number;
    /** a cover.jpg (or folder/front/album art) inside it, when there is one */
    cover: string | null;
}

export interface FolderFile extends FolderEntryBase {
    /** lowercased, with its dot */
    ext: string;
    size: number;
    isVideo: boolean;
    /** false for files the player can't decode — listed, but not playable */
    playable: boolean;
}

/**
 * One directory as it really is on disk. Everything the browser shows comes from
 * here, so what is on screen and what is in the file manager can't drift apart.
 */
export interface FolderListing {
    path: string;
    /** the authorised root this sits under; the browser never goes above it */
    root: string;
    /** null at the root itself */
    parent: string | null;
    /** the root first, then every folder down to this one */
    crumbs: { name: string; path: string; }[];
    dirs: FolderDir[];
    files: FolderFile[];
    /** cover art sitting in this folder itself */
    cover: string | null;
}

/**
 * What a rename/move/delete actually did. Partial success is normal — one file
 * being locked shouldn't undo the other nine — so every outcome is reported per
 * entry rather than as one throw.
 */
export interface FileOpResult {
    /** every path that changed, including the sidecars carried along with a track */
    moved: { from: string; to: string; }[];
    /** paths that are no longer there (moved to the recycle bin) */
    removed: string[];
    failed: { path: string; error: string; }[];
}

/** One track's proposed home, as worked out from its tags by the renderer. */
export interface OrganiseItem {
    path: string;
    artist: string;
    album: string;
}

// #endregion

export type SearchSource = "youtube" | "ytmusic";

export interface SearchResult {
    id: string;
    /** watch URL, handed straight back to yt-dlp to download */
    url: string;
    title: string;
    uploader: string;
    /** seconds, 0 when unknown */
    duration: number;
    thumbnail: string | null;
}
