/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { useEffect, useReducer } from "@webpack/common";

import { settings, ytDlpOptions } from "./settings";
import type { DownloadJob, SearchResult, SearchSource, ServerInfo, Track, TrackMetadata, YtDlpInfo } from "./types";

const Native = VencordNative.pluginHelpers.LocalMusic as PluginNative<typeof import("./native")>;

const FOLDER_KEY = "LocalMusic_folder";
const PREFS_KEY = "LocalMusic_prefs";

export type RepeatMode = "off" | "all" | "one";

export const MIN_VIDEO_HEIGHT = 90;
export const MAX_VIDEO_HEIGHT = 720;
export const MIN_VIDEO_WIDTH = 180;
export const MAX_VIDEO_WIDTH = 1600;

interface Prefs {
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    lastPath: string | null;
    videoHeight: number;
    /** pixels, or 0 to just fill the panel it is docked above */
    videoWidth: number;
}

const DEFAULT_PREFS: Prefs = {
    volume: 0.5,
    shuffle: false,
    repeat: "off",
    lastPath: null,
    videoHeight: 200,
    videoWidth: 0
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
        store.syncMediaSession();
        notify();
    });
    media.addEventListener("pause", () => {
        store.isPlaying = false;
        store.syncMediaSession();
        notify();
    });
    media.addEventListener("ended", () => void store.next(true));
    media.addEventListener("timeupdate", () => {
        store.position = media!.currentTime;
        store.syncPositionState();
        positionListeners.forEach(l => l());
    });
    media.addEventListener("durationchange", () => {
        store.duration = Number.isFinite(media!.duration) ? media!.duration : 0;
        store.syncPositionState(true);
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

/**
 * Hands play/pause/skip to the OS. On Windows this is the SMTC overlay, on Linux
 * it is MPRIS - which is what KDE/GNOME/Hyprland bind the media keys to - and on
 * macOS the Now Playing widget. Every handler is registered defensively because
 * Chromium throws NotSupportedError for actions it doesn't implement.
 */
const MEDIA_SESSION_ACTIONS: MediaSessionAction[] =
    ["play", "pause", "stop", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"];

function registerMediaSessionHandlers() {
    const session = navigator.mediaSession;
    if (!session?.setActionHandler) return;

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
        ["play", () => void store.play()],
        ["pause", () => store.pause()],
        ["stop", () => store.pause()],
        ["previoustrack", () => void store.previous()],
        ["nexttrack", () => void store.next()],
        ["seekbackward", d => store.seek(store.position - (d.seekOffset ?? 10))],
        ["seekforward", d => store.seek(store.position + (d.seekOffset ?? 10))],
        ["seekto", d => d.seekTime != null && store.seek(d.seekTime)]
    ];

    for (const [action, handler] of handlers) {
        try {
            session.setActionHandler(action, handler);
        } catch { }
    }
}

/** Dropping every handler is what makes Chromium stop offering us to the OS. */
function clearMediaSessionHandlers() {
    const session = navigator.mediaSession;
    if (!session?.setActionHandler) return;

    for (const action of MEDIA_SESSION_ACTIONS) {
        try {
            session.setActionHandler(action, null);
        } catch { }
    }

    session.metadata = null;
    session.playbackState = "none";
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
    /** whether the player panel should be shown above the account panel */
    videoDocked = true;
    videoHeight = DEFAULT_PREFS.videoHeight;
    videoWidth = DEFAULT_PREFS.videoWidth;

    downloads: DownloadJob[] = [];
    /** accelerators globalShortcut actually took; empty when that mode is off or refused */
    grabbedMediaKeys: string[] = [];

    private server: ServerInfo | null = null;
    private events: EventSource | null = null;
    private history: number[] = [];
    private finishedDownloads = new Set<string>();
    private lastPositionSync = 0;

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

        const { volume, shuffle, repeat, lastPath, videoHeight, videoWidth } = { ...DEFAULT_PREFS, ...prefs };
        this.volume = volume;
        this.shuffle = shuffle;
        this.repeat = repeat;
        this.videoHeight = videoHeight;
        this.videoWidth = videoWidth;
        if (media) media.volume = volume;

        registerMediaSessionHandlers();

        if (folder && await Native.authoriseFolder(folder)) {
            this.folder = folder;
            await this.rescan();

            if (lastPath) {
                const index = this.tracks.findIndex(t => t.path === lastPath);
                // restore the selection but don't start playing on its own
                if (index !== -1) await this.load(index, false);
            }
        }

        await this.ensureServer();
        await this.applyMediaKeyMode();
        // downloads outlive the renderer, so adopt whatever main is still working on
        await this.refreshDownloads();

        notify();
    }

    private savePrefs() {
        DataStore.set(PREFS_KEY, {
            volume: this.volume,
            shuffle: this.shuffle,
            repeat: this.repeat,
            lastPath: this.currentTrack?.path ?? null,
            videoHeight: this.videoHeight,
            videoWidth: this.videoWidth
        } satisfies Prefs);
    }

    private async ensureServer() {
        this.server ??= await Native.getServerInfo();
        this.connectEvents();
        return this.server;
    }

    mediaUrl(track: Track) {
        if (!this.server) return "";
        return `http://127.0.0.1:${this.server.port}/media?t=${this.server.token}&p=${encodeURIComponent(track.path)}`;
    }

    artUrl(track: Track) {
        if (!this.server || !this.metadata[track.path]?.hasArt) return null;
        return `http://127.0.0.1:${this.server.port}/art?t=${this.server.token}&p=${encodeURIComponent(track.path)}`;
    }

    // #region OS integration

    /** Pushes the current track into the OS "now playing" surface. */
    syncMediaSession() {
        const session = navigator.mediaSession;
        if (!session || settings.store.mediaKeys === "off") return;

        const track = this.currentTrack;
        if (!track) {
            session.metadata = null;
            session.playbackState = "none";
            return;
        }

        const meta = this.metadata[track.path];
        const art = this.artUrl(track);

        try {
            session.metadata = new MediaMetadata({
                title: meta?.title || track.fileName,
                artist: meta?.artist || "",
                album: meta?.album || "",
                artwork: art ? [{ src: art }] : []
            });
        } catch { }

        session.playbackState = this.isPlaying ? "playing" : "paused";
    }

    /** Feeds the scrubber in the OS widget. Throttled — timeupdate fires ~4Hz. */
    syncPositionState(force = false) {
        const session = navigator.mediaSession;
        if (!session?.setPositionState || !media) return;

        const now = Date.now();
        if (!force && now - this.lastPositionSync < 1000) return;
        this.lastPositionSync = now;

        // setPositionState throws on a duration of 0/NaN or a position past the end
        if (!Number.isFinite(media.duration) || media.duration <= 0) return;

        try {
            session.setPositionState({
                duration: media.duration,
                position: Math.min(Math.max(media.currentTime, 0), media.duration),
                playbackRate: media.playbackRate || 1
            });
        } catch { }
    }

    /** Applies the mediaKeys setting; safe to call again whenever it changes. */
    async applyMediaKeyMode() {
        const mode = settings.store.mediaKeys;

        // the OS widget is worth having in "global" too — the global grab just wins
        // for the physical keys, since it takes them at the OS level
        if (mode === "off") {
            clearMediaSessionHandlers();
        } else {
            registerMediaSessionHandlers();
            this.syncMediaSession();
        }

        this.grabbedMediaKeys = await Native.setGlobalMediaKeys(mode === "global");
        notify();
    }

    handleMediaKey(action: string) {
        switch (action) {
            case "playpause": return void this.togglePlay();
            case "next": return void this.next();
            case "previous": return void this.previous();
            case "stop": return this.pause();
        }
    }

    /**
     * Plugin natives can only be invoked from the renderer, so progress and media
     * key presses come back over an SSE stream on the loopback server instead.
     */
    private connectEvents() {
        if (this.events || !this.server) return;

        const source = new EventSource(
            `http://127.0.0.1:${this.server.port}/events?t=${this.server.token}`
        );

        source.addEventListener("mediaKey", e => {
            this.handleMediaKey(JSON.parse((e as MessageEvent).data).action);
        });

        source.addEventListener("downloads", e => {
            this.downloads = JSON.parse((e as MessageEvent).data);

            // a finished download means new files on disk
            const finished = this.downloads.filter(j => j.status === "done" && !this.finishedDownloads.has(j.id));
            finished.forEach(j => this.finishedDownloads.add(j.id));
            if (finished.length) this.rescan();

            notify();
        });

        this.events = source;
    }

    // #endregion

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
            // tags for the loaded track may only have arrived in this batch
            this.syncMediaSession();
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

        this.syncMediaSession();
        this.savePrefs();
        notify();
    }

    async play() {
        if (this.currentIndex === -1) {
            if (this.tracks.length) await this.load(0);
            return;
        }

        try {
            await ensureMedia().play();
        } catch {
            this.error = "Playback failed";
            notify();
        }
    }

    pause() {
        ensureMedia().pause();
    }

    async togglePlay() {
        if (ensureMedia().paused) await this.play();
        else this.pause();
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
            this.syncPositionState(true);
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

    /** @param width 0 to go back to filling the panel rather than a fixed size */
    setVideoSize(width: number, height: number) {
        this.videoHeight = Math.round(Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, height)));
        this.videoWidth = width
            ? Math.round(Math.max(MIN_VIDEO_WIDTH, Math.min(MAX_VIDEO_WIDTH, width)))
            : 0;

        this.savePrefs();
        notify();
    }

    // #region downloads

    ytDlpInfo(): Promise<YtDlpInfo> {
        return Native.ytDlpInfo(ytDlpOptions(this.folder ?? ""));
    }

    search(query: string, source: SearchSource, limit = 25): Promise<SearchResult[]> {
        return Native.search(query, source, limit, ytDlpOptions(this.folder ?? ""));
    }

    async startDownload(url: string, playlist = false) {
        if (!this.folder) throw new Error("Choose your music folder in the library first");

        const job = await Native.startDownload(url, playlist, ytDlpOptions(this.folder));
        // the SSE stream will keep this up to date; seed it so the row shows instantly
        this.downloads = [...this.downloads.filter(j => j.id !== job.id), job];
        notify();
    }

    /**
     * Pulls the real job list out of the main process. The SSE stream is the fast
     * path, but a stream that dropped its connection leaves this list frozen — a
     * download that has long since failed keeps rendering as "running", which is
     * exactly the state where cancelling looks like it does nothing.
     */
    async refreshDownloads() {
        try {
            this.downloads = await Native.getDownloads();
            notify();
        } catch { }
    }

    async cancelDownload(id: string) {
        // update locally first: if the job is already gone in main, the row still has
        // to stop claiming to run so it can be dismissed
        this.downloads = this.downloads.map((job): DownloadJob =>
            job.id === id && job.status === "running"
                ? { ...job, status: "cancelled", message: "Cancelled" }
                : job);
        notify();

        await Native.cancelDownload(id);
        await this.refreshDownloads();
    }

    async removeDownload(id: string) {
        this.downloads = this.downloads.filter(job => job.id !== id);
        notify();

        await Native.removeDownload(id);
    }

    async clearFinishedDownloads() {
        await Native.clearFinishedDownloads();
        await this.refreshDownloads();
    }

    /** Opens the browsing window; clicking a track in it queues a download here. */
    openBrowser(playlist: boolean, url = "") {
        if (!this.folder) throw new Error("Choose your music folder in the library first");
        return Native.openBrowser(url, playlist, ytDlpOptions(this.folder));
    }

    updateBrowserOptions(playlist: boolean) {
        return Native.updateBrowserOptions(playlist, ytDlpOptions(this.folder ?? "")).catch(() => { });
    }

    // #endregion

    dismissError() {
        this.error = null;
        notify();
    }

    destroy() {
        this.events?.close();
        this.events = null;

        // hand the media keys back to whatever else wants them
        Native.setGlobalMediaKeys(false).catch(() => { });
        Native.closeBrowser().catch(() => { });

        media?.pause();
        media?.removeAttribute("src");
        media?.load();
        mediaHost?.remove();
        media = null;
        mediaHost = null;

        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
        }

        this.isPlaying = false;
        this.currentIndex = -1;
        this.tracks = [];
        this.downloads = [];
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
