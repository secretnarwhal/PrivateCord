/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { useEffect, useReducer } from "@webpack/common";

import type { ServerInfo, Track, TrackMetadata } from "./types";

const Native = VencordNative.pluginHelpers.LocalMusic as PluginNative<typeof import("./native")>;

const FOLDER_KEY = "LocalMusic_folder";
const PREFS_KEY = "LocalMusic_prefs";

export type RepeatMode = "off" | "all" | "one";

interface Prefs {
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    lastPath: string | null;
}

const DEFAULT_PREFS: Prefs = {
    volume: 0.5,
    shuffle: false,
    repeat: "off",
    lastPath: null
};

const stateListeners = new Set<() => void>();
const positionListeners = new Set<() => void>();

/**
 * A single <video> element backs everything, including audio-only files. Keeping
 * one element (rather than one per track) means the VideoDock can adopt it with
 * appendChild without ever interrupting playback.
 */
let media: HTMLVideoElement | null = null;
let mediaHost: HTMLDivElement | null = null;

function ensureMedia() {
    if (media) return media;

    mediaHost = document.createElement("div");
    mediaHost.className = "vc-lm-media-host";
    document.body.appendChild(mediaHost);

    media = document.createElement("video");
    media.preload = "metadata";
    media.volume = store.volume;
    mediaHost.appendChild(media);

    media.addEventListener("play", () => {
        store.isPlaying = true;
        notify();
    });
    media.addEventListener("pause", () => {
        store.isPlaying = false;
        notify();
    });
    media.addEventListener("ended", () => void store.next(true));
    media.addEventListener("timeupdate", () => {
        store.position = media!.currentTime;
        positionListeners.forEach(l => l());
    });
    media.addEventListener("durationchange", () => {
        store.duration = Number.isFinite(media!.duration) ? media!.duration : 0;
        notify();
    });
    media.addEventListener("error", () => {
        store.error = `Could not play ${store.currentTrack?.fileName ?? "this file"}`;
        store.isPlaying = false;
        notify();
    });

    return media;
}

function notify() {
    stateListeners.forEach(l => l());
}

class PlayerStore {
    folder: string | null = null;
    tracks: Track[] = [];
    metadata: Record<string, TrackMetadata> = {};

    currentIndex = -1;
    isPlaying = false;
    position = 0;
    duration = 0;
    error: string | null = null;

    volume = DEFAULT_PREFS.volume;
    shuffle = DEFAULT_PREFS.shuffle;
    repeat: RepeatMode = DEFAULT_PREFS.repeat;

    isScanning = false;
    /** whether the video surface should be shown above the mini player */
    videoDocked = true;

    private server: ServerInfo | null = null;
    private history: number[] = [];

    get currentTrack(): Track | null {
        return this.tracks[this.currentIndex] ?? null;
    }

    get currentMetadata(): TrackMetadata | undefined {
        const track = this.currentTrack;
        return track ? this.metadata[track.path] : undefined;
    }

    get displayTitle() {
        const track = this.currentTrack;
        if (!track) return "Nothing playing";
        return this.metadata[track.path]?.title || track.fileName;
    }

    get displayArtist() {
        const track = this.currentTrack;
        return track ? this.metadata[track.path]?.artist ?? "" : "";
    }

    /** true when a video file is loaded and actually has a picture to show */
    get hasVideo() {
        return !!this.currentTrack?.isVideo;
    }

    getMediaElement() {
        return ensureMedia();
    }

    async init() {
        const [folder, prefs] = await Promise.all([
            DataStore.get<string>(FOLDER_KEY),
            DataStore.get<Prefs>(PREFS_KEY)
        ]);

        const { volume, shuffle, repeat, lastPath } = { ...DEFAULT_PREFS, ...prefs };
        this.volume = volume;
        this.shuffle = shuffle;
        this.repeat = repeat;
        if (media) media.volume = volume;

        if (folder && await Native.authoriseFolder(folder)) {
            this.folder = folder;
            await this.rescan();

            if (lastPath) {
                const index = this.tracks.findIndex(t => t.path === lastPath);
                // restore the selection but don't start playing on its own
                if (index !== -1) await this.load(index, false);
            }
        }

        notify();
    }

    private savePrefs() {
        DataStore.set(PREFS_KEY, {
            volume: this.volume,
            shuffle: this.shuffle,
            repeat: this.repeat,
            lastPath: this.currentTrack?.path ?? null
        } satisfies Prefs);
    }

    private async ensureServer() {
        return this.server ??= await Native.getServerInfo();
    }

    mediaUrl(track: Track) {
        if (!this.server) return "";
        return `http://127.0.0.1:${this.server.port}/media?t=${this.server.token}&p=${encodeURIComponent(track.path)}`;
    }

    artUrl(track: Track) {
        if (!this.server || !this.metadata[track.path]?.hasArt) return null;
        return `http://127.0.0.1:${this.server.port}/art?t=${this.server.token}&p=${encodeURIComponent(track.path)}`;
    }

    async pickFolder() {
        const folder = await Native.pickFolder();
        if (!folder) return;

        this.folder = folder;
        DataStore.set(FOLDER_KEY, folder);
        await this.rescan();
    }

    async rescan() {
        if (!this.folder) return;

        this.isScanning = true;
        this.error = null;
        notify();

        try {
            const currentPath = this.currentTrack?.path;
            this.tracks = await Native.scanFolder(this.folder);
            // keep pointing at the same file if it survived the rescan
            this.currentIndex = currentPath ? this.tracks.findIndex(t => t.path === currentPath) : -1;

            await this.ensureServer();
            this.loadMetadata();
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.isScanning = false;
            notify();
        }
    }

    /** Reads tags in the background, in chunks, so a big library stays responsive. */
    private async loadMetadata() {
        const pending = this.tracks.map(t => t.path).filter(p => !(p in this.metadata));

        for (let i = 0; i < pending.length; i += 50) {
            const batch = await Native.readMetadataBatch(pending.slice(i, i + 50));
            Object.assign(this.metadata, batch);
            notify();
        }
    }

    async load(index: number, autoplay = true) {
        const track = this.tracks[index];
        if (!track) return;

        await this.ensureServer();

        // fetch this track's tags up front if the background pass hasn't reached it
        if (!this.metadata[track.path]) {
            const meta = await Native.readMetadata(track.path);
            if (meta) this.metadata[track.path] = meta;
        }

        if (this.currentIndex !== -1 && this.currentIndex !== index)
            this.history.push(this.currentIndex);

        this.currentIndex = index;
        this.position = 0;
        this.duration = 0;
        this.error = null;

        const element = ensureMedia();
        element.src = this.mediaUrl(track);
        element.volume = this.volume;

        if (autoplay) {
            try {
                await element.play();
            } catch (e) {
                this.error = `Could not play ${track.fileName}`;
            }
        }

        this.savePrefs();
        notify();
    }

    async togglePlay() {
        if (this.currentIndex === -1) {
            if (this.tracks.length) await this.load(0);
            return;
        }

        const element = ensureMedia();
        if (element.paused) {
            try {
                await element.play();
            } catch {
                this.error = "Playback failed";
                notify();
            }
        } else {
            element.pause();
        }
    }

    private pickNextIndex(): number | null {
        if (!this.tracks.length) return null;
        if (this.repeat === "one") return this.currentIndex;

        if (this.shuffle) {
            if (this.tracks.length === 1) return 0;

            let next = this.currentIndex;
            while (next === this.currentIndex) next = Math.floor(Math.random() * this.tracks.length);
            return next;
        }

        const next = this.currentIndex + 1;
        if (next < this.tracks.length) return next;
        return this.repeat === "all" ? 0 : null;
    }

    /** @param automatic true when triggered by a track ending rather than the user */
    async next(automatic = false) {
        const index = this.pickNextIndex();

        if (index === null) {
            this.isPlaying = false;
            notify();
            return;
        }

        // repeat-one on a natural end should restart rather than reload
        if (automatic && this.repeat === "one") {
            const element = ensureMedia();
            element.currentTime = 0;
            await element.play().catch(() => { });
            return;
        }

        await this.load(index);
    }

    async previous(restartThresholdSeconds = 3) {
        const element = ensureMedia();

        // matches every other music player: rewind first, skip back only if near the start
        if (this.currentIndex !== -1 && element.currentTime > restartThresholdSeconds) {
            element.currentTime = 0;
            return;
        }

        if (this.shuffle && this.history.length) {
            const index = this.history.pop()!;
            await this.load(index);
            this.history.pop(); // load() re-pushed the track we just left
            return;
        }

        if (!this.tracks.length) return;

        const index = this.currentIndex <= 0 ? this.tracks.length - 1 : this.currentIndex - 1;
        await this.load(index);
    }

    seek(seconds: number) {
        const element = ensureMedia();
        if (Number.isFinite(element.duration)) {
            element.currentTime = Math.max(0, Math.min(seconds, element.duration));
            this.position = element.currentTime;
            positionListeners.forEach(l => l());
        }
    }

    setVolume(volume: number) {
        this.volume = Math.max(0, Math.min(1, volume));
        ensureMedia().volume = this.volume;
        this.savePrefs();
        notify();
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        this.savePrefs();
        notify();
    }

    cycleRepeat() {
        this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
        this.savePrefs();
        notify();
    }

    toggleVideoDock() {
        this.videoDocked = !this.videoDocked;
        notify();
    }

    dismissError() {
        this.error = null;
        notify();
    }

    destroy() {
        media?.pause();
        media?.removeAttribute("src");
        media?.load();
        mediaHost?.remove();
        media = null;
        mediaHost = null;

        this.isPlaying = false;
        this.currentIndex = -1;
        this.tracks = [];
        stateListeners.clear();
        positionListeners.clear();
    }
}

export const store = new PlayerStore();

/** Subscribes a component to player state (track, playing, library, ...). */
export function usePlayer() {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        stateListeners.add(forceUpdate);
        return () => void stateListeners.delete(forceUpdate);
    }, []);

    return store;
}

/** Separate from usePlayer so 4Hz time updates don't re-render the whole panel. */
export function usePlayerPosition() {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        positionListeners.add(forceUpdate);
        return () => void positionListeners.delete(forceUpdate);
    }, []);

    return store.position;
}
