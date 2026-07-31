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
