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
