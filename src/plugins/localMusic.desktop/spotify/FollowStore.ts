/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { store } from "@plugins/localMusic.desktop/PlayerStore";
import {
    DRIFT_HARD_SEEK, DRIFT_NUDGE_MIN, DRIFT_TICK_MS, MAX_RATE_NUDGE
} from "@plugins/localMusic.desktop/session/protocol";
import { settings } from "@plugins/localMusic.desktop/settings";
import { Toasts, useEffect, useReducer } from "@webpack/common";

import { findMatch } from "./match";
import {
    fingerprint, nameOf, onPresenceChange, positionOf, readSpotify, SpotifySnapshot, spotifyUrl
} from "./presence";

/**
 * Following someone's Spotify.
 *
 * Their presence is the clock: it carries the track id, and a start timestamp
 * that is re-sent on every seek, pause and resume. So there is no negotiation
 * and no peer to talk to — we read where they are, put the same recording under
 * the needle at the same offset, and keep nudging until the two agree.
 *
 * What we can't do is see ahead. A card only appears once they are already
 * playing something, so a track we don't own has to be fetched *while* it plays
 * and joined part-way through. That is the one unavoidable seam in this.
 */

export type FollowStatus =
    /** not following anyone */
    | "idle"
    /** following, but their Spotify card is gone (stopped, or offline) */
    | "waiting"
    /** their card is there with the progress bar stopped */
    | "paused"
    /** going through the library for this track */
    | "searching"
    | "downloading"
    | "playing"
    /** not in the library, and either no downloader is set up or it couldn't get it */
    | "missing"
    | "error";

/** How long to give a file to report its length before giving up on placing the needle. */
const DURATION_TIMEOUT_MS = 6_000;
/** Past this the local file clearly isn't the same recording; say so rather than fight it. */
const LENGTH_MISMATCH = 10;
/** How long our own play() gets to take effect before a paused element means the user. */
const START_GRACE_MS = 2_500;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

function toast(message: string, type = Toasts.Type.MESSAGE) {
    Toasts.show({ message, id: Toasts.genId(), type });
}

class FollowStore {
    /** who we're following, or null when we aren't */
    userId: string | null = null;
    username = "";

    status: FollowStatus = "idle";
    /** the latest thing worth reading — a reason, a provider's complaint, a hint */
    message = "";

    /** their card, as of the last presence change */
    snapshot: SpotifySnapshot | null = null;

    /** the file we matched their track to */
    path: string | null = null;
    /** 0-1, how sure the matcher was; low means "this might be the wrong recording" */
    matchScore = 0;
    /** set when our copy is a very different length from theirs */
    lengthWarning = false;

    /** the download this track is waiting on, if any */
    runId: string | null = null;
    downloadPercent = -1;

    /** seconds we're behind (positive) or ahead of them */
    drift = 0;

    /** the track id we're currently trying to get to; guards a late download */
    private wanted: string | null = null;
    /** the track id actually under the needle */
    private playing: string | null = null;
    private fp = "";
    private unsubscribe: (() => void) | null = null;
    private timer: number | null = null;
    /** true while playback is supposed to be running, so a manual pause is visible */
    private expectPlaying = false;
    /** when we last asked the element to start; a pause before this lands isn't theirs */
    private playingSince = 0;

    get following() {
        return this.userId !== null;
    }

    /** The tool the user marked as their Spotify downloader, if they marked one. */
    get downloader() {
        return store.tools.find(tool => tool.spotify) ?? null;
    }

    // #region lifecycle

    follow(userId: string) {
        if (store.session)
            return toast("Leave the listen-along session first — it already drives playback", Toasts.Type.FAILURE);

        if (!store.folder)
            return toast("Choose your music folder in the library first", Toasts.Type.FAILURE);

        if (this.userId === userId) return;
        if (this.userId) this.teardown();

        this.userId = userId;
        this.username = nameOf(userId);
        this.status = "waiting";
        this.message = "";
        this.fp = "";

        // what plays next is their decision from here on; ours must not roll on
        store.followLock = true;

        this.unsubscribe = onPresenceChange(() => this.evaluate());
        this.timer = window.setInterval(() => this.tick(), DRIFT_TICK_MS);

        this.evaluate();
        notify();
    }

    stop(reason?: string) {
        if (!this.userId) return;

        const who = this.username;
        this.teardown();

        this.status = "idle";
        this.message = reason ?? "";
        notify();

        toast(reason ? `${reason} — no longer following ${who}` : `No longer following ${who}`);
    }

    private teardown() {
        this.unsubscribe?.();
        this.unsubscribe = null;

        if (this.timer !== null) window.clearInterval(this.timer);
        this.timer = null;

        store.followLock = false;
        store.setPlaybackRate(1);

        this.userId = null;
        this.snapshot = null;
        this.wanted = null;
        this.playing = null;
        this.path = null;
        this.matchScore = 0;
        this.lengthWarning = false;
        this.runId = null;
        this.downloadPercent = -1;
        this.drift = 0;
        this.expectPlaying = false;
        this.playingSince = 0;
    }

    destroy() {
        this.teardown();
        this.status = "idle";
        listeners.clear();
    }

    // #endregion

    // #region their side

    /**
     * Re-reads their card. Presence changes constantly and for everyone, so this
     * runs often and does nothing at all unless the part we care about moved.
     */
    private evaluate() {
        if (!this.userId) return;

        const snapshot = readSpotify(this.userId);
        const fp = fingerprint(snapshot);
        if (fp === this.fp) return;

        this.fp = fp;
        this.snapshot = snapshot;
        this.username = nameOf(this.userId);

        if (!snapshot) {
            // they closed Spotify, went offline, or Discord stopped telling us
            this.playing = null;
            this.wanted = null;
            this.status = "waiting";
            this.message = "Nothing playing";
            if (settings.store.spotifyFollowPause) this.pauseOurs();
            return notify();
        }

        if (snapshot.paused) {
            this.status = "paused";
            this.message = "Paused";
            if (settings.store.spotifyFollowPause) this.pauseOurs();
            return notify();
        }

        if (snapshot.trackId !== this.playing) {
            // a seek inside a track we're already fetching (or already gave up on)
            // must not start the search, or the download, over from the top
            if (snapshot.trackId === this.wanted) return notify();

            void this.acquire(snapshot);
            return;
        }

        // same track, moved start: they seeked, or came back from a pause
        this.status = "playing";
        this.message = "";
        this.resync(snapshot, true);
        notify();
    }

    /** Find the track, fetch it if we have to, then put it on. */
    private async acquire(snapshot: SpotifySnapshot) {
        this.wanted = snapshot.trackId;
        this.playing = null;
        this.path = null;
        this.lengthWarning = false;
        this.status = "searching";
        this.message = `${snapshot.title} — ${snapshot.artist}`;
        notify();

        const match = findMatch(snapshot, store.tracks, store.metadata);
        if (match) return void this.begin(snapshot, match.path, match.score);

        if (!settings.store.spotifyFollowDownload || !this.downloader) {
            this.status = "missing";
            this.message = this.downloader
                ? "Not in your library — automatic downloads are off"
                : "Not in your library — set a downloader up in the Download window";
            return notify();
        }

        await this.startDownload(snapshot);
    }

    /** Puts the needle on `path` at the offset they're at, without playing the intro first. */
    private async begin(snapshot: SpotifySnapshot, path: string, score: number) {
        // loaded paused on purpose: starting at zero and seeking afterwards means a
        // blip of the wrong part of the song out of every track change
        if (!await store.loadPath(path, false)) {
            this.status = "error";
            this.message = "That file isn't in the library any more";
            return notify();
        }

        this.path = path;
        this.matchScore = score;
        this.playing = snapshot.trackId;
        this.status = "playing";
        this.message = "";
        notify();

        // the element can't be seeked until it knows how long it is
        const ready = await this.waitForDuration();
        // they may have skipped on while the file was opening
        if (this.playing !== snapshot.trackId || !this.userId) return;

        if (!ready) {
            this.status = "error";
            this.message = store.error ?? "That file wouldn't load";
            return notify();
        }

        this.lengthWarning = snapshot.duration > 0
            && Math.abs(store.duration - snapshot.duration) > LENGTH_MISMATCH;

        this.resync(snapshot, true);
        notify();
    }

    private waitForDuration() {
        return new Promise<boolean>(resolve => {
            const deadline = Date.now() + DURATION_TIMEOUT_MS;

            const check = () => {
                if (store.duration > 0) return resolve(true);
                if (store.error || Date.now() > deadline) return resolve(false);
                window.setTimeout(check, 50);
            };

            check();
        });
    }

    // #endregion

    // #region downloading

    private async startDownload(snapshot: SpotifySnapshot) {
        const tool = this.downloader;
        if (!tool) return;

        this.status = "downloading";
        this.downloadPercent = -1;
        this.message = `Fetching ${snapshot.title}…`;
        notify();

        try {
            const run = await store.runTool(tool.id, {
                url: spotifyUrl(snapshot.trackId),
                query: `${snapshot.artist} - ${snapshot.title}`.trim()
            });
            this.runId = run.id;
        } catch (e) {
            this.runId = null;
            this.status = "error";
            this.message = e instanceof Error ? e.message : String(e);
        }

        notify();
    }

    /** Retry, or start a download the user turned down automatic fetching for. */
    fetchNow() {
        const { snapshot } = this;
        if (!snapshot || !this.downloader || this.runId) return;

        void this.startDownload(snapshot);
    }

    private async onDownloadFinished(outputPath: string | null) {
        const { snapshot } = this;
        this.runId = null;
        this.downloadPercent = -1;

        // the file is on disk either way, so it is worth having even if they moved on
        await store.rescan();

        if (!this.userId || !snapshot || snapshot.trackId !== this.wanted) {
            this.message = "Downloaded — they'd already moved on";
            return notify();
        }

        // the tool told us exactly what it wrote; trust that over guessing again
        if (outputPath && store.hasTrack(outputPath))
            return void this.begin(snapshot, outputPath, 1);

        const match = findMatch(snapshot, store.tracks, store.metadata);
        if (!match) {
            this.status = "missing";
            this.message = "Downloaded, but the file doesn't look like the track — check the console";
            return notify();
        }

        void this.begin(snapshot, match.path, match.score);
    }

    // #endregion

    // #region our side

    private pauseOurs() {
        this.expectPlaying = false;
        store.setPlaybackRate(1);
        if (store.isPlaying) store.pause();
    }

    /** Drops the needle where they are and keeps it there. */
    private resync(snapshot: SpotifySnapshot, hard: boolean) {
        if (this.playing !== snapshot.trackId || store.duration <= 0) return;

        // two track changes in quick succession race each other for the media
        // element, and seeking the loser to the winner's position would be worse
        // than doing nothing — the next card they play puts it right
        if (store.currentTrack?.path !== this.path) return;

        const target = positionOf(snapshot, settings.store.spotifyFollowOffset);
        this.drift = target - store.position;

        if (hard || Math.abs(this.drift) > DRIFT_HARD_SEEK) {
            store.setPlaybackRate(1);
            store.hardSeekSilently(target);
            this.drift = 0;
        } else if (Math.abs(this.drift) > DRIFT_NUDGE_MIN) {
            // catching up by playing very slightly faster is inaudible where a seek
            // every few seconds would not be
            const nudge = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, this.drift * 0.5));
            store.setPlaybackRate(1 + nudge);
        } else {
            store.setPlaybackRate(1);
        }

        if (!store.isPlaying) {
            this.playingSince = Date.now();
            void store.play();
        }

        this.expectPlaying = true;
    }

    /** The 2Hz heartbeat: download progress, drift, and noticing the user taking over. */
    private tick() {
        if (!this.userId) return;

        if (this.runId) {
            const run = store.toolRuns.find(r => r.id === this.runId);

            if (!run) {
                this.runId = null;
            } else if (run.status === "running") {
                this.downloadPercent = run.percent;
                this.message = run.message;
                notify();
            } else if (run.status === "done") {
                void this.onDownloadFinished(run.outputPath);
            } else {
                this.runId = null;
                this.status = "missing";
                this.message = run.status === "cancelled" ? "Download cancelled" : run.message;
                notify();
            }
        }

        if (this.status !== "playing" || !this.snapshot || this.snapshot.paused) return;

        // the user hit pause (or the panel's own transport) — that is them opting
        // out, and fighting them over it would be worse than stopping. The grace
        // period is for our own play() call, which only shows up as isPlaying once
        // the element has actually started
        if (this.expectPlaying
            && !store.isPlaying
            && Date.now() - this.playingSince > START_GRACE_MS
            && store.position < store.duration - 1.5)
            return this.stop("You paused");

        this.resync(this.snapshot, false);
    }

    /** Manual "put me back with them", for a local file that turned out to be edited. */
    resyncNow() {
        if (this.snapshot && !this.snapshot.paused) this.resync(this.snapshot, true);
        notify();
    }

    // #endregion
}

export const followStore = new FollowStore();

export function useFollow() {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    return followStore;
}
