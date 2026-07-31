/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PROTOCOL_VERSION = 1;

/** Cheap string test on incoming messages, long before any crypto runs. */
export const SIGNAL_PREFIX = "[lm-signal:v1:";
export const GROUP_KEY_PREFIX = "LMS1.";

export const DC_CONTROL = "lm-control";
export const DC_FILE = "lm-file";

/** Per data-channel message. SCTP handles 16KB everywhere without fragmentation drama. */
export const FILE_CHUNK = 16 * 1024;
/** Per readFileChunk IPC round-trip on the host. */
export const IPC_READ_CHUNK = 256 * 1024;
/** Stop feeding the file channel above this bufferedAmount... */
export const BUFFER_HIGH = 4 * 1024 * 1024;
/** ...and resume once it drains below this. */
export const BUFFER_LOW = 1 * 1024 * 1024;

/** Seconds of drift past which the listener hard-seeks instead of nudging. */
export const DRIFT_HARD_SEEK = 0.25;
/** Seconds of drift under which the listener leaves playbackRate alone. */
export const DRIFT_NUDGE_MIN = 0.03;
/** Largest playbackRate deviation used to reel drift in — inaudible territory. */
export const MAX_RATE_NUDGE = 0.02;
export const DRIFT_TICK_MS = 500;

/**
 * How far in the future the host schedules a start, so every client (itself
 * included) can arm a timer against the shared clock and begin together.
 */
export const START_LEAD_MS = 300;

/** One row of the host's library as listeners see it. */
export interface SessionTrack {
    /** sha256 of the host-side path — a stable, session-scoped identity */
    id: string;
    title: string;
    artist: string;
    album: string;
    /** seconds, 0 when unknown */
    duration: number;
    size: number;
    ext: string;
    isVideo: boolean;
}

export interface MemberPerms {
    /** the slider, play/pause and skipping */
    playback: boolean;
    addToQueue: boolean;
    /** reordering, removing and clearing */
    reorderQueue: boolean;
}

export interface SessionMember {
    userId: string;
    username: string;
    perms: MemberPerms;
    connected: boolean;
    /** still downloading the current track */
    syncing: boolean;
}

export interface SessionQueueItem {
    /** mirrors the host's QueueItem.id, so reorder requests are unambiguous */
    qid: string;
    trackId: string;
}

/**
 * "At host clock `hostClock`, `trackId` is (or will be — scheduled starts put
 * hostClock slightly in the future) at `position`, playing or not."
 */
export interface PlaybackState {
    /** monotonic; stale broadcasts arriving out of order are dropped */
    revision: number;
    trackId: string | null;
    isPlaying: boolean;
    /** seconds into the track at hostClock */
    position: number;
    /** host performance.now() milliseconds */
    hostClock: number;
}

// #region signaling (encrypted, chunked over DMs)

export type SignalMessage =
    | { type: "join"; v: number; user: string; username: string; nonce: string; ts: number; }
    | { type: "offer"; nonce: string; sdp: string; }
    | { type: "answer"; nonce: string; sdp: string; }
    | { type: "reject"; nonce: string; reason: "full" | "not-hosting" | "bad-version"; };

// #endregion

// #region control channel

export type RequestAction =
    | "play" | "pause" | "seek" | "next" | "previous" | "play-track"
    | "queue-add" | "queue-remove" | "queue-move" | "queue-play" | "queue-clear";

export type ControlToHost =
    | {
        type: "req";
        /** correlates a later deny */
        id: number;
        action: RequestAction;
        seconds?: number;
        trackId?: string;
        /** queue-add to the front ("play next") rather than the back */
        front?: boolean;
        qid?: string;
        /** null = end of the queue */
        beforeQid?: string | null;
    }
    | { type: "ping"; t0: number; }
    | { type: "status"; state: "syncing" | "ready"; trackId: string | null; progress?: number; }
    | { type: "file-accept"; transferId: string; }
    /** already cached — skip the transfer entirely */
    | { type: "file-have"; transferId: string; }
    | { type: "leave"; };

export type ControlToListener =
    | {
        type: "welcome";
        sessionId: string;
        perms: MemberPerms;
        members: SessionMember[];
        queue: SessionQueueItem[];
        state: PlaybackState | null;
        manifestParts: number;
    }
    | { type: "manifest"; part: number; total: number; tracks: SessionTrack[]; }
    | { type: "members"; list: SessionMember[]; }
    /** targeted: your own permissions changed */
    | { type: "perms"; perms: MemberPerms; }
    | { type: "queue"; rev: number; items: SessionQueueItem[]; }
    | { type: "state"; state: PlaybackState; }
    | { type: "pong"; t0: number; t1: number; t2: number; }
    | { type: "deny"; reqId: number; reason: string; }
    | { type: "file-offer"; transferId: string; trackId: string; contentHash: string; size: number; ext: string; }
    | { type: "kick"; reason?: string; }
    | { type: "end"; };

// #endregion

// #region file channel

/** String frames bracketing the raw ArrayBuffer chunks on the ordered file channel. */
export type FileFrame =
    | { t: "begin"; transferId: string; contentHash: string; size: number; ext: string; }
    | { t: "end"; transferId: string; };

// #endregion
