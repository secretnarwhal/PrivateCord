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
