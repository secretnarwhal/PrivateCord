/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { useEffect, useReducer } from "@webpack/common";

import type { PlayerSessionAdapter } from "./session/SessionStore";
import { settings, ytDlpOptions } from "./settings";
import type {
    DownloadJob, QueueItem, SearchResult, SearchSource, ServerInfo, Track, TrackMetadata, YtDlpInfo
} from "./types";

const Native = VencordNative.pluginHelpers.LocalMusic as PluginNative<typeof import("./native")>;

const FOLDER_KEY = "LocalMusic_folder";
const PREFS_KEY = "LocalMusic_prefs";

export type RepeatMode = "off" | "all" | "one";

export const MIN_VIDEO_HEIGHT = 90;
export const MAX_VIDEO_HEIGHT = 720;
export const MIN_VIDEO_WIDTH = 180;
export const MAX_VIDEO_WIDTH = 1600;

/**
 * Where a popped-out panel sits inside the Discord window. Measured from the
 * bottom rather than the top because the panel grows upwards when resized,
 * exactly as it does while docked.
 */
export interface FloatAnchor {
    left: number;
    bottom: number;
}

interface Prefs {
    volume: number;
    shuffle: boolean;
    repeat: RepeatMode;
    lastPath: string | null;
    videoHeight: number;
    /** pixels, or 0 to just fill the panel it is docked above */
    videoWidth: number;
    floating: boolean;
    /** null until the panel has been popped out for the first time */
    floatAnchor: FloatAnchor | null;
    /** the "play next" queue as bare paths; the ids are minted again on load */
    queue: string[];
}

const DEFAULT_PREFS: Prefs = {
    volume: 0.5,
    shuffle: false,
    repeat: "off",
    lastPath: null,
    videoHeight: 200,
    videoWidth: 0,
    floating: false,
    floatAnchor: null,
    queue: []
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
    // the loopback server is another origin; without clean CORS the analyser
    // behind the visualizer would read nothing but silence
    media.crossOrigin = "anonymous";
    media.volume = store.volume;
    mediaHost.appendChild(media);

    media.addEventListener("play", () => {
        store.isPlaying = true;
        // the context starts suspended when it was created while nothing played
        audioCtx?.resume().catch(() => { });
        store.syncMediaSession();
        notify();
        store.session?.onLocalChange("state");
    });
    media.addEventListener("pause", () => {
        store.isPlaying = false;
        store.syncMediaSession();
        notify();
        store.session?.onLocalChange("state");
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

/**
 * Pass-through analyser tap for the visualizer. Built lazily on first use and
 * kept for the life of the media element: createMediaElementSource permanently
 * reroutes the element's audio through the graph, so tearing the graph down
 * while the element lives would mute it.
 */
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

function ensureAnalyser(): AnalyserNode | null {
    if (analyser) return analyser;

    const element = ensureMedia();

    try {
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(element);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);

        if (!element.paused) audioCtx.resume().catch(() => { });
    } catch (e) {
        console.error("[LocalMusic] could not build the audio analyser:", e);
        audioCtx?.close().catch(() => { });
        audioCtx = null;
        analyser = null;
    }

    return analyser;
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
    videoHeight = DEFAULT_PREFS.videoHeight;
    videoWidth = DEFAULT_PREFS.videoWidth;
    floating = DEFAULT_PREFS.floating;
    floatAnchor: FloatAnchor | null = DEFAULT_PREFS.floatAnchor;

    /** what plays next, ahead of whatever the library order or shuffle would pick */
    queue: QueueItem[] = [];

    downloads: DownloadJob[] = [];
    /** accelerators globalShortcut actually took; empty when that mode is off or refused */
    grabbedMediaKeys: string[] = [];

    /**
     * Installed by the SessionStore while a listen-along session runs. Mutating
     * methods consult it first: for a listener it forwards the action to the
     * host instead; for the host it broadcasts what just changed. Null = solo,
     * and every guard below is inert.
     */
    session: PlayerSessionAdapter | null = null;
    /** what a listener is playing — served from cache, not from the library */
    sessionNowPlaying: { title: string; artist: string; album: string; isVideo: boolean; } | null = null;

    private server: ServerInfo | null = null;
    private events: EventSource | null = null;
    private history: number[] = [];
    private finishedDownloads = new Set<string>();
    private lastPositionSync = 0;
    /** path -> index in tracks, so resolving a queue entry isn't a scan of the library */
    private indexByPath = new Map<string, number>();
    private queueSeq = 0;

    get currentTrack(): Track | null {
        return this.tracks[this.currentIndex] ?? null;
    }

    get currentMetadata(): TrackMetadata | undefined {
        const track = this.currentTrack;
        return track ? this.metadata[track.path] : undefined;
    }

    get displayTitle() {
        if (this.sessionNowPlaying) return this.sessionNowPlaying.title;

        const track = this.currentTrack;
        if (!track) return "Nothing playing";
        return this.metadata[track.path]?.title || track.fileName;
    }

    get displayArtist() {
        if (this.sessionNowPlaying) return this.sessionNowPlaying.artist;

        const track = this.currentTrack;
        return track ? this.metadata[track.path]?.artist ?? "" : "";
    }

    /** true when a video file is loaded and actually has a picture to show */
    get hasVideo() {
        if (this.sessionNowPlaying) return this.sessionNowPlaying.isVideo;
        return !!this.currentTrack?.isVideo;
    }

    getMediaElement() {
        return ensureMedia();
    }

    /** null when the Web Audio graph could not be built; the visualizer just idles */
    getAnalyser() {
        return ensureAnalyser();
    }

    async init() {
        const [folder, prefs] = await Promise.all([
            DataStore.get<string>(FOLDER_KEY),
            DataStore.get<Prefs>(PREFS_KEY)
        ]);

        const {
            volume, shuffle, repeat, lastPath, videoHeight, videoWidth, floating, floatAnchor, queue
        } = { ...DEFAULT_PREFS, ...prefs };
        this.volume = volume;
        this.shuffle = shuffle;
        this.repeat = repeat;
        this.videoHeight = videoHeight;
        this.videoWidth = videoWidth;
        this.floating = floating;
        this.floatAnchor = floatAnchor;
        this.queue = queue.map(path => this.mintQueueItem(path));
        if (media) media.volume = volume;

        registerMediaSessionHandlers();

        if (folder && await Native.authoriseFolder(folder)) {
            this.folder = folder;
            await this.rescan();

            if (lastPath) {
                const index = this.indexByPath.get(lastPath);
                // restore the selection but don't start playing on its own
                if (index !== undefined) await this.load(index, false);
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
            videoWidth: this.videoWidth,
            floating: this.floating,
            floatAnchor: this.floatAnchor,
            queue: this.queue.map(item => item.path)
        } satisfies Prefs);
    }

    private async ensureServer() {
        this.server ??= await Native.getServerInfo();
        this.connectEvents();
        return this.server;
    }

    mediaUrl(track: Track) {
        return this.fileUrl(track.path);
    }

    /** /media URL for any path the native side allows — library or session cache. */
    fileUrl(path: string) {
        if (!this.server) return "";
        return `http://127.0.0.1:${this.server.port}/media?t=${this.server.token}&p=${encodeURIComponent(path)}`;
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
        if (!track && !this.sessionNowPlaying) {
            session.metadata = null;
            session.playbackState = "none";
            return;
        }

        const meta = track ? this.metadata[track.path] : undefined;
        const art = track ? this.artUrl(track) : null;

        try {
            session.metadata = new MediaMetadata({
                title: this.sessionNowPlaying?.title ?? (meta?.title || track!.fileName),
                artist: this.sessionNowPlaying?.artist ?? (meta?.artist || ""),
                album: this.sessionNowPlaying?.album ?? (meta?.album || ""),
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
            this.indexByPath = new Map(this.tracks.map((track, index) => [track.path, index]));
            // keep pointing at the same file if it survived the rescan
            this.currentIndex = currentPath ? this.indexByPath.get(currentPath) ?? -1 : -1;
            // a queued file that is no longer on disk can never play, so drop it
            this.queue = this.queue.filter(item => this.indexByPath.has(item.path));

            await this.ensureServer();
            this.loadMetadata();
        } catch (e) {
            this.error = e instanceof Error ? e.message : String(e);
        } finally {
            this.isScanning = false;
            notify();
            // a hosted session shares the library — its mirror needs the rescan too
            this.session?.onLocalChange("library");
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

    /** Installed and removed by the SessionStore; solo behavior needs it null. */
    setSession(adapter: PlayerSessionAdapter | null) {
        this.session = adapter;
        notify();
    }

    async load(index: number, autoplay = true) {
        // a listener has no meaningful local library indexes mid-session
        if (this.session?.role === "listener") return;

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
        this.session?.onLocalChange("state");
    }

    /**
     * Session playback: points the media element at a served file (the listen
     * along cache) without touching currentIndex, history or saved prefs —
     * lastPath must never become a cache path. Loads paused; the sync engine
     * decides when playback actually starts.
     */
    loadExternal(url: string, meta: { title: string; artist: string; album: string; isVideo: boolean; }) {
        const element = ensureMedia();

        this.sessionNowPlaying = meta;
        this.currentIndex = -1;
        this.position = 0;
        this.duration = 0;
        this.error = null;

        element.src = url;
        element.volume = this.volume;
        element.playbackRate = 1;

        this.syncMediaSession();
        notify();
    }

    /** Back to solo: drop the session track and leave the element empty. */
    clearExternal() {
        if (!this.sessionNowPlaying) return;
        this.sessionNowPlaying = null;

        const element = ensureMedia();
        element.pause();
        element.removeAttribute("src");
        element.load();
        element.playbackRate = 1;

        this.position = 0;
        this.duration = 0;
        this.isPlaying = false;
        this.syncMediaSession();
        notify();
    }

    async play() {
        if (this.session?.intercept("play")) return;

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
        if (this.session?.intercept("pause")) return;

        ensureMedia().pause();
    }

    async togglePlay() {
        if (ensureMedia().paused) await this.play();
        else this.pause();
    }

    // #region queue

    private mintQueueItem(path: string): QueueItem {
        return { id: `q${++this.queueSeq}`, path };
    }

    /**
     * The queue paired up with the tracks it points at, in queue order. Entries the
     * library no longer has are skipped rather than rendered as unplayable rows.
     */
    get queueEntries(): { item: QueueItem; track: Track; index: number; }[] {
        const entries: { item: QueueItem; track: Track; index: number; }[] = [];

        for (const item of this.queue) {
            const index = this.indexByPath.get(item.path);
            if (index !== undefined) entries.push({ item, track: this.tracks[index], index });
        }

        return entries;
    }

    /** Jumps a track to the front of the queue, so it plays as soon as this one ends. */
    playNext(index: number) {
        const track = this.tracks[index];
        if (!track) return;

        this.queue = [this.mintQueueItem(track.path), ...this.queue];
        this.saveQueue();
    }

    addToQueue(index: number) {
        const track = this.tracks[index];
        if (!track) return;

        this.queue = [...this.queue, this.mintQueueItem(track.path)];
        this.saveQueue();
    }

    removeFromQueue(id: string) {
        if (this.session?.intercept("queue-remove", { qid: id })) return;

        this.queue = this.queue.filter(item => item.id !== id);
        this.saveQueue();
    }

    clearQueue() {
        if (this.session?.intercept("queue-clear")) return;
        if (!this.queue.length) return;

        this.queue = [];
        this.saveQueue();
    }

    /**
     * Drag-to-reorder. Expressed against the id it lands in front of rather than a
     * numeric slot, so it stays right even when the list being dragged has skipped
     * entries the library lost.
     *
     * @param beforeId null to drop it at the very end
     */
    moveInQueue(id: string, beforeId: string | null) {
        if (this.session?.intercept("queue-move", { qid: id, beforeQid: beforeId })) return;
        if (id === beforeId) return;

        const from = this.queue.findIndex(item => item.id === id);
        if (from === -1) return;

        const next = [...this.queue];
        const [item] = next.splice(from, 1);

        const to = beforeId === null ? -1 : next.findIndex(entry => entry.id === beforeId);
        next.splice(to === -1 ? next.length : to, 0, item);

        this.queue = next;
        this.saveQueue();
    }

    /** Plays a queued entry right now, taking it out of the queue on the way. */
    async playQueued(id: string) {
        if (this.session?.intercept("queue-play", { qid: id })) return;

        const item = this.queue.find(entry => entry.id === id);
        if (!item) return;

        const index = this.indexByPath.get(item.path);
        this.removeFromQueue(id);
        if (index !== undefined) await this.load(index);
    }

    /**
     * Pops the front of the queue, discarding entries whose file has since gone.
     * Returns null when there is nothing queued left to play.
     */
    private takeFromQueue(): number | null {
        let index: number | undefined;
        let took = false;

        while (this.queue.length) {
            const [item, ...rest] = this.queue;
            this.queue = rest;
            took = true;

            index = this.indexByPath.get(item.path);
            if (index !== undefined) break;
        }

        if (took) this.saveQueue();
        return index ?? null;
    }

    private saveQueue() {
        this.savePrefs();
        notify();
        this.session?.onLocalChange("queue");
    }

    // #endregion

    /** Where playback would go on its own, once the queue has had its say. */
    private pickNextIndex(): number | null {
        if (!this.tracks.length) return null;

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
        // a listener's track running out means nothing — the host's broadcast
        // decides what plays next, so just sit quietly until it arrives
        if (automatic && this.session?.role === "listener") {
            this.isPlaying = false;
            notify();
            return;
        }
        if (this.session?.intercept("next")) return;

        // repeat-one outranks even the queue: it is the one mode that means "do not
        // move on", and the queue is still there whenever it gets turned off
        if (this.repeat === "one" && this.currentIndex !== -1) {
            // a natural end should restart rather than reload
            if (automatic) {
                const element = ensureMedia();
                element.currentTime = 0;
                await element.play().catch(() => { });
                return;
            }

            await this.load(this.currentIndex);
            return;
        }

        const queued = this.takeFromQueue();
        const index = queued ?? this.pickNextIndex();

        if (index === null) {
            this.isPlaying = false;
            notify();
            return;
        }

        await this.load(index);
    }

    async previous(restartThresholdSeconds = 3) {
        if (this.session?.intercept("previous")) return;

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
        if (this.session?.intercept("seek", { seconds })) return;

        const element = ensureMedia();
        if (Number.isFinite(element.duration)) {
            element.currentTime = Math.max(0, Math.min(seconds, element.duration));
            this.position = element.currentTime;
            this.syncPositionState(true);
            positionListeners.forEach(l => l());
            this.session?.onLocalChange("state");
        }
    }

    /**
     * The sync engine's own seek: skips the session guard (it *is* the session)
     * and the state broadcast — only the host broadcasts, and the host never
     * calls this.
     */
    hardSeekSilently(seconds: number) {
        const element = ensureMedia();
        if (Number.isFinite(element.duration) && element.duration > 0) {
            element.currentTime = Math.max(0, Math.min(seconds, element.duration));
            this.position = element.currentTime;
        }
    }

    setPlaybackRate(rate: number) {
        ensureMedia().playbackRate = rate;
    }

    /** what unmuting restores; only ever a volume the user actually had set */
    private lastVolume = DEFAULT_PREFS.volume;

    setVolume(volume: number) {
        this.volume = Math.max(0, Math.min(1, volume));
        if (this.volume > 0) this.lastVolume = this.volume;
        ensureMedia().volume = this.volume;
        this.savePrefs();
        notify();
    }

    toggleMute() {
        this.setVolume(this.volume > 0 ? 0 : this.lastVolume);
    }

    toggleShuffle() {
        if (this.session?.role === "listener") return;

        this.shuffle = !this.shuffle;
        this.savePrefs();
        notify();
    }

    cycleRepeat() {
        if (this.session?.role === "listener") return;

        this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
        this.savePrefs();
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

    /**
     * Pops the panel out of the sidebar, or puts it back. Nothing about the panel
     * itself changes — it already renders into a portal on document.body — only
     * what it is pinned to: a free window-relative anchor rather than the rect of
     * the spacer it left behind in the account panel.
     *
     * @param anchor where to start floating from, so popping out doesn't jump
     */
    setFloating(floating: boolean, anchor?: FloatAnchor) {
        this.floating = floating;
        if (floating && anchor) this.floatAnchor = anchor;

        this.savePrefs();
        notify();
    }

    setFloatAnchor(anchor: FloatAnchor) {
        this.floatAnchor = anchor;
        this.savePrefs();
        notify();
    }

    // #region downloads

    ytDlpInfo(): Promise<YtDlpInfo> {
        return Native.ytDlpInfo(ytDlpOptions(this.folder ?? ""));
    }

    /** whether the browse window's session is signed in to YouTube */
    browserLogin(): Promise<boolean> {
        return Native.getBrowserLogin();
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

        // the graph is bound to the element that just went away
        audioCtx?.close().catch(() => { });
        audioCtx = null;
        analyser = null;

        if (navigator.mediaSession) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
        }

        this.session = null;
        this.sessionNowPlaying = null;
        this.isPlaying = false;
        this.currentIndex = -1;
        this.tracks = [];
        this.indexByPath.clear();
        // left in prefs on purpose — the queue comes back with the plugin
        this.queue = [];
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
