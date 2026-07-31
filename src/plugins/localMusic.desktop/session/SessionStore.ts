/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { store } from "@plugins/localMusic.desktop/PlayerStore";
import { settings } from "@plugins/localMusic.desktop/settings";
import { PluginNative } from "@utils/types";
import { Toasts, useEffect, useReducer, UserStore } from "@webpack/common";

import { deriveAesKey, generateGroupKey, parseGroupKey, randomHex, sha256Hex } from "./crypto";
import { HostSender, ListenerReceiver } from "./FileTransfer";
import { PeerManager } from "./PeerManager";
import {
    ControlToHost, ControlToListener, DRIFT_HARD_SEEK, DRIFT_NUDGE_MIN, DRIFT_TICK_MS,
    MAX_RATE_NUDGE, MemberPerms, PlaybackState, PROTOCOL_VERSION, RequestAction,
    SessionMember, SessionQueueItem, SessionTrack, SignalMessage, START_LEAD_MS
} from "./protocol";
import { deleteOwnSignals, resetSignaling, resolveDmChannel, sendSignal, setSignalContext } from "./signaling";

const Native = VencordNative.pluginHelpers.LocalMusic as PluginNative<typeof import("../native")>;

export type SessionRole = "none" | "host" | "listener";
export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting";

/** The contract PlayerStore consults before acting on any mutating call. */
export interface PlayerSessionAdapter {
    role: "host" | "listener";
    /** listener: forward/deny and return true (handled); host: return false (act locally) */
    intercept(action: RequestAction | "load", args?: { seconds?: number; qid?: string; beforeQid?: string | null; }): boolean;
    /** host only: a local mutation happened; broadcast it */
    onLocalChange(kind: "state" | "queue" | "library"): void;
}

const JOIN_TIMEOUT_MS = 30_000;
const RECONNECT_DELAYS = [2_000, 5_000, 15_000];
/** how long a host remembers a dropped member's perms, waiting for a rejoin */
const MEMBER_LINGER_MS = 5 * 60_000;
const MANIFEST_TRACKS_PER_PART = 200;
/** how many queued tracks past the current one are pushed to listeners ahead of time */
const PREFETCH_DEPTH = 2;
const CLOCK_SAMPLES = 8;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

function defaultPerms(): MemberPerms {
    return {
        playback: settings.store.listenAlongAllowPlayback,
        addToQueue: settings.store.listenAlongAllowAddToQueue,
        reorderQueue: settings.store.listenAlongAllowReorderQueue
    };
}

function permFor(action: RequestAction): keyof MemberPerms {
    switch (action) {
        case "queue-add":
            return "addToQueue";
        case "queue-remove":
        case "queue-move":
        case "queue-clear":
            return "reorderQueue";
        default:
            return "playback";
    }
}

function toast(message: string, type = Toasts.Type.MESSAGE) {
    Toasts.show({ message, id: Toasts.genId(), type });
}

interface HostPeerState {
    member: SessionMember;
    channelId: string | null;
    sender: HostSender | null;
    /** pending removal after a disconnect, cancelled by a rejoin */
    lingerTimer: number | null;
}

class SessionStore {
    role: SessionRole = "none";
    connection: ConnectionState = "idle";
    groupKey: string | null = null;
    error: string | null = null;

    /** mirrored to listeners; on the host this is the authority */
    members: SessionMember[] = [];
    myPerms: MemberPerms = { playback: true, addToQueue: true, reorderQueue: true };

    /** listener: the host's library. host: what was last broadcast. */
    manifest = new Map<string, SessionTrack>();
    sessionQueue: SessionQueueItem[] = [];
    playback: PlaybackState | null = null;
    syncing: { trackId: string; progress: number; } | null = null;

    clockOffset = 0;
    rtt = 0;

    hostUserId: string | null = null;
    hostUsername = "";

    private aesKey: CryptoKey | null = null;
    private peers: PeerManager | null = null;

    // host state
    private hostPeers = new Map<string, HostPeerState>();
    private pathToTrackId = new Map<string, string>();
    private trackIdToPath = new Map<string, string>();
    private stateRevision = 0;
    private queueRevision = 0;
    private lastBroadcastTrackId: string | null = null;
    private scheduledPlayTimer: number | null = null;
    /** true while the store itself is poking the media element (scheduled starts) */
    private muteStateEvents = false;
    private queueBroadcastTimer: number | null = null;

    // listener state
    private receiver: ListenerReceiver | null = null;
    private readyTracks = new Map<string, string>();
    private hostChannelId: string | null = null;
    private joinNonce: string | null = null;
    private pendingOffer: { resolve(sdp: string): void; reject(err: Error): void; } | null = null;
    private pingTimer: number | null = null;
    private pingCount = 0;
    private clockSamples: { offset: number; rtt: number; }[] = [];
    private driftTimer: number | null = null;
    private scheduledStartTimer: number | null = null;
    private loadedTrackId: string | null = null;
    private reconnectAttempt = 0;
    private leaving = false;
    private reqSeq = 0;

    // #region lifecycle

    async startHosting() {
        if (this.role !== "none") return;

        const me = UserStore.getCurrentUser();
        const { key, secret } = generateGroupKey(me.id);

        this.role = "host";
        this.connection = "connected";
        this.groupKey = key;
        this.aesKey = await deriveAesKey(secret, me.id);
        this.hostUserId = me.id;
        this.hostUsername = me.username;
        this.myPerms = { playback: true, addToQueue: true, reorderQueue: true };
        this.peers = new PeerManager({
            onControlMessage: (userId, msg) => this.hostOnControl(userId, msg),
            onFileMessage: () => { },
            onOpen: userId => this.hostOnPeerOpen(userId),
            onClose: userId => this.hostOnPeerClose(userId)
        });

        setSignalContext({
            aesKey: this.aesKey,
            onSignal: (author, channel, msg) => void this.hostOnSignal(author, channel, msg)
        });

        await this.rebuildManifest();

        store.setSession(this.adapter("host"));
        notify();
    }

    async join(keyString: string) {
        if (this.role !== "none") return;

        const parsed = parseGroupKey(keyString.trim());
        if (!parsed) {
            this.error = "That doesn't look like a valid group key";
            notify();
            return;
        }

        if (parsed.hostUserId === UserStore.getCurrentUser().id) {
            this.error = "That's your own key — hand it to someone else";
            notify();
            return;
        }

        this.role = "listener";
        this.connection = "connecting";
        this.groupKey = keyString.trim();
        this.error = null;
        this.leaving = false;
        this.hostUserId = parsed.hostUserId;
        this.hostUsername = UserStore.getUser(parsed.hostUserId)?.username ?? "the host";
        this.aesKey = await deriveAesKey(parsed.secret, parsed.hostUserId);
        notify();

        try {
            await Native.getCacheInfo(settings.store.listenAlongCacheLimit);
            await this.connectToHost();
        } catch (e) {
            this.error = e instanceof Error ? e.message : "Could not reach the host — check the key";
            this.teardown();
        }
        notify();
    }

    private async connectToHost() {
        const me = UserStore.getCurrentUser();

        const channelId = await resolveDmChannel(this.hostUserId!);
        if (!channelId) throw new Error("Could not open a DM with the host — you may need to share a server or be friends");
        this.hostChannelId = channelId;

        this.peers?.closeAll();
        this.peers = new PeerManager({
            onControlMessage: (_, msg) => this.listenerOnControl(msg),
            onFileMessage: (_, data) => this.receiver?.handleFileMessage(data),
            onOpen: () => this.listenerOnOpen(),
            onClose: () => this.listenerOnClose()
        });
        this.receiver?.destroy();
        this.receiver = new ListenerReceiver({
            onTrackReady: (trackId, path) => this.onTrackReady(trackId, path),
            onProgress: (trackId, fraction) => {
                if (this.syncing?.trackId === trackId) {
                    this.syncing = { trackId, progress: fraction };
                    notify();
                }
            },
            onFailed: trackId => {
                if (this.syncing?.trackId === trackId) {
                    this.error = "The host's file could not be transferred";
                    this.syncing = null;
                    notify();
                }
            },
            sendToHost: msg => void this.sendToHost(msg)
        });

        this.joinNonce = randomHex(8);
        setSignalContext({
            aesKey: this.aesKey!,
            onSignal: (author, channel, msg) => void this.listenerOnSignal(author, channel, msg)
        });

        const offerSdp = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("The host didn't answer — are they online with the session running?")),
                JOIN_TIMEOUT_MS
            );
            this.pendingOffer = {
                resolve: sdp => {
                    clearTimeout(timer);
                    resolve(sdp);
                },
                reject: err => {
                    clearTimeout(timer);
                    reject(err);
                }
            };

            void sendSignal(channelId, this.aesKey!, {
                type: "join",
                v: PROTOCOL_VERSION,
                user: me.id,
                username: me.username,
                nonce: this.joinNonce!,
                ts: Date.now()
            }).catch(reject);
        }).finally(() => (this.pendingOffer = null));

        const answerSdp = await this.peers.acceptOfferAsListener(this.hostUserId!, offerSdp);
        await sendSignal(channelId, this.aesKey!, { type: "answer", nonce: this.joinNonce!, sdp: answerSdp });
    }

    /** Host: shut the whole session down. */
    endSession() {
        if (this.role !== "host") return;

        this.peers?.broadcastControl({ type: "end" });
        this.teardown();
        toast("Listen along session ended");
    }

    /** Listener: leave quietly. */
    leave() {
        if (this.role !== "listener") return;

        this.leaving = true;
        if (this.hostUserId) this.peers?.sendControl(this.hostUserId, { type: "leave" });
        this.teardown();
    }

    /** Full reset to solo, shared by every exit path. */
    private teardown() {
        setSignalContext(null);
        resetSignaling();

        this.pendingOffer?.reject(new Error("Session closed"));
        this.pendingOffer = null;

        for (const peer of this.hostPeers.values()) {
            peer.sender?.destroy();
            if (peer.lingerTimer !== null) clearTimeout(peer.lingerTimer);
        }
        this.hostPeers.clear();

        this.peers?.closeAll();
        this.peers = null;
        this.receiver?.destroy();
        this.receiver = null;

        for (const timer of [
            this.pingTimer, this.driftTimer, this.scheduledStartTimer,
            this.scheduledPlayTimer, this.queueBroadcastTimer
        ]) {
            if (timer !== null) clearTimeout(timer);
        }
        this.pingTimer = this.driftTimer = this.scheduledStartTimer = null;
        this.scheduledPlayTimer = this.queueBroadcastTimer = null;

        const wasListener = this.role === "listener";

        this.role = "none";
        this.connection = "idle";
        this.groupKey = null;
        this.aesKey = null;
        this.members = [];
        this.manifest.clear();
        this.sessionQueue = [];
        this.playback = null;
        this.syncing = null;
        this.clockSamples = [];
        this.clockOffset = 0;
        this.rtt = 0;
        this.readyTracks.clear();
        this.loadedTrackId = null;
        this.hostUserId = null;
        this.hostChannelId = null;
        this.pathToTrackId.clear();
        this.trackIdToPath.clear();
        this.lastBroadcastTrackId = null;
        this.reconnectAttempt = 0;

        store.setSession(null);
        if (wasListener) {
            store.setPlaybackRate(1);
            store.clearExternal();
        }
        notify();
    }

    destroy() {
        if (this.role === "host") this.peers?.broadcastControl({ type: "end" });
        else if (this.role === "listener") this.leave();
        if (this.role !== "none") this.teardown();
        listeners.clear();
    }

    // #endregion

    // #region host: signaling & membership

    private async hostOnSignal(authorId: string, channelId: string, msg: SignalMessage) {
        if (this.role !== "host" || !this.peers) return;

        if (msg.type === "join") {
            // possession of the key got them decrypted; the author must still be
            // who the payload claims, or someone is replaying a captured join
            if (msg.user !== authorId) return;

            if (msg.v !== PROTOCOL_VERSION) {
                void sendSignal(channelId, this.aesKey!, { type: "reject", nonce: msg.nonce, reason: "bad-version" });
                return;
            }

            let peer = this.hostPeers.get(authorId);
            if (peer?.lingerTimer !== null && peer?.lingerTimer !== undefined) {
                clearTimeout(peer.lingerTimer);
                peer.lingerTimer = null;
            }

            if (!peer) {
                peer = {
                    member: {
                        userId: authorId,
                        username: UserStore.getUser(authorId)?.username ?? msg.username,
                        perms: defaultPerms(),
                        connected: false,
                        syncing: false
                    },
                    channelId,
                    sender: null,
                    lingerTimer: null
                };
                this.hostPeers.set(authorId, peer);
            }
            peer.channelId = channelId;

            const sdp = await this.peers.createHostPeer(authorId);
            await sendSignal(channelId, this.aesKey!, { type: "offer", nonce: msg.nonce, sdp });
        } else if (msg.type === "answer") {
            await this.peers.completeHostSide(authorId, msg.sdp);
        }
    }

    private hostOnPeerOpen(userId: string) {
        const peer = this.hostPeers.get(userId);
        if (!peer || !this.peers) return;

        peer.member.connected = true;
        peer.sender?.destroy();
        peer.sender = new HostSender(userId, this.peers);

        // the handshake worked; both sides can clean their DM traces up now
        if (peer.channelId) void deleteOwnSignals(peer.channelId);

        const manifestTracks = [...this.manifest.values()];
        const parts = Math.max(1, Math.ceil(manifestTracks.length / MANIFEST_TRACKS_PER_PART));

        this.peers.sendControl(userId, {
            type: "welcome",
            sessionId: this.groupKey!.slice(-8),
            perms: peer.member.perms,
            members: this.publicMembers(),
            queue: this.buildSessionQueue(),
            state: this.currentPlaybackState(),
            manifestParts: parts
        });

        for (let part = 0; part < parts; part++) {
            this.peers.sendControl(userId, {
                type: "manifest",
                part: part + 1,
                total: parts,
                tracks: manifestTracks.slice(part * MANIFEST_TRACKS_PER_PART, (part + 1) * MANIFEST_TRACKS_PER_PART)
            });
        }

        this.broadcastMembers();
        this.prefetchTo(userId);
        toast(`${peer.member.username} joined the listening session`);
        notify();
    }

    private hostOnPeerClose(userId: string) {
        const peer = this.hostPeers.get(userId);
        if (!peer) return;

        peer.member.connected = false;
        peer.member.syncing = false;
        peer.sender?.destroy();
        peer.sender = null;

        // keep the membership (and any tweaked perms) around for a while, so a
        // flaky connection doesn't reset what the host granted them
        peer.lingerTimer ??= window.setTimeout(() => {
            this.hostPeers.delete(userId);
            this.broadcastMembers();
            notify();
        }, MEMBER_LINGER_MS);

        this.broadcastMembers();
        notify();
    }

    kick(userId: string) {
        if (this.role !== "host") return;

        const peer = this.hostPeers.get(userId);
        this.peers?.sendControl(userId, { type: "kick" });
        // give the message a beat to flush before the channel dies
        setTimeout(() => this.peers?.close(userId), 250);

        if (peer) {
            if (peer.lingerTimer !== null) clearTimeout(peer.lingerTimer);
            peer.sender?.destroy();
            this.hostPeers.delete(userId);
        }
        this.broadcastMembers();
        notify();
    }

    setMemberPerms(userId: string, perms: MemberPerms) {
        if (this.role !== "host") return;

        const peer = this.hostPeers.get(userId);
        if (!peer) return;

        peer.member.perms = perms;
        this.peers?.sendControl(userId, { type: "perms", perms });
        this.broadcastMembers();
        notify();
    }

    private publicMembers(): SessionMember[] {
        return [...this.hostPeers.values()].map(p => ({ ...p.member, perms: { ...p.member.perms } }));
    }

    private broadcastMembers() {
        this.members = this.publicMembers();
        this.peers?.broadcastControl({ type: "members", list: this.members });
    }

    // #endregion

    // #region host: library, queue & playback authority

    /** Hashes every library path into a session track id and builds the manifest. */
    private async rebuildManifest() {
        this.pathToTrackId.clear();
        this.trackIdToPath.clear();
        this.manifest.clear();

        for (const track of store.tracks) {
            const id = await sha256Hex(track.path);
            this.pathToTrackId.set(track.path, id);
            this.trackIdToPath.set(id, track.path);

            const meta = store.metadata[track.path];
            this.manifest.set(id, {
                id,
                title: meta?.title || track.fileName,
                artist: meta?.artist ?? "",
                album: meta?.album ?? "",
                duration: 0,
                size: track.size,
                ext: track.ext,
                isVideo: track.isVideo
            });
        }
    }

    private buildSessionQueue(): SessionQueueItem[] {
        const items: SessionQueueItem[] = [];
        for (const item of store.queue) {
            const trackId = this.pathToTrackId.get(item.path);
            if (trackId) items.push({ qid: item.id, trackId });
        }
        return items;
    }

    private currentPlaybackState(): PlaybackState | null {
        const track = store.currentTrack;
        if (!track) return null;

        const trackId = this.pathToTrackId.get(track.path);
        if (!trackId) return null;

        return {
            revision: this.stateRevision,
            trackId,
            isPlaying: store.isPlaying,
            position: store.position,
            hostClock: performance.now()
        };
    }

    private adapter(role: "host" | "listener"): PlayerSessionAdapter {
        return {
            role,
            intercept: (action, args) => this.intercept(role, action, args),
            onLocalChange: kind => this.hostOnLocalChange(kind)
        };
    }

    private intercept(role: "host" | "listener", action: RequestAction | "load", args?: { seconds?: number; qid?: string; beforeQid?: string | null; }): boolean {
        if (role !== "listener") return false;

        if (action === "load") return true; // local library loads make no sense mid-session

        this.request(action, args ?? {});
        return true;
    }

    private hostOnLocalChange(kind: "state" | "queue" | "library") {
        if (this.role !== "host" || !this.peers) return;

        if (kind === "queue") {
            // burst mutations (drag reorder) collapse into one broadcast
            this.queueBroadcastTimer ??= window.setTimeout(() => {
                this.queueBroadcastTimer = null;
                this.sessionQueue = this.buildSessionQueue();
                this.peers?.broadcastControl({ type: "queue", rev: ++this.queueRevision, items: this.sessionQueue });
                this.prefetchToAll();
                notify();
            }, 100);
            return;
        }

        if (kind === "library") {
            void this.rebuildManifest().then(() => {
                if (this.role !== "host" || !this.peers) return;

                const tracks = [...this.manifest.values()];
                const parts = Math.max(1, Math.ceil(tracks.length / MANIFEST_TRACKS_PER_PART));
                for (let part = 0; part < parts; part++) {
                    this.peers.broadcastControl({
                        type: "manifest",
                        part: part + 1,
                        total: parts,
                        tracks: tracks.slice(part * MANIFEST_TRACKS_PER_PART, (part + 1) * MANIFEST_TRACKS_PER_PART)
                    });
                }
                this.hostOnLocalChange("queue");
                this.hostOnLocalChange("state");
            });
            return;
        }

        if (this.muteStateEvents) return;

        const state = this.currentPlaybackState();
        if (!state) {
            this.playback = null;
            return;
        }

        // a brand-new track that is already playing gets a scheduled start: pause,
        // tell everyone when t=0 happens on the shared clock, then hit it together
        if (state.isPlaying && state.trackId !== this.lastBroadcastTrackId && state.position < 1) {
            this.lastBroadcastTrackId = state.trackId;
            this.scheduleHostStart(state.trackId!);
            return;
        }

        this.lastBroadcastTrackId = state.trackId;
        state.revision = ++this.stateRevision;
        this.playback = state;
        this.peers.broadcastControl({ type: "state", state });
        this.prefetchToAll();
    }

    /** Pause the freshly-started track, broadcast a start moment, play into it. */
    private scheduleHostStart(trackId: string) {
        const element = store.getMediaElement();

        this.muteStateEvents = true;
        element.pause();
        element.currentTime = 0;

        const state: PlaybackState = {
            revision: ++this.stateRevision,
            trackId,
            isPlaying: true,
            position: 0,
            hostClock: performance.now() + START_LEAD_MS
        };
        this.playback = state;
        this.peers?.broadcastControl({ type: "state", state });
        this.prefetchToAll();

        if (this.scheduledPlayTimer !== null) clearTimeout(this.scheduledPlayTimer);
        this.scheduledPlayTimer = window.setTimeout(() => {
            this.scheduledPlayTimer = null;
            element.play().catch(() => { });
            // let the resulting play event through, but it must not re-broadcast
            setTimeout(() => (this.muteStateEvents = false), 100);
        }, START_LEAD_MS);
    }

    /** Sends the current track and the next few queued ones to every listener that lacks them. */
    private prefetchToAll() {
        for (const userId of this.hostPeers.keys()) this.prefetchTo(userId);
    }

    private prefetchTo(userId: string) {
        const peer = this.hostPeers.get(userId);
        if (!peer?.sender || !peer.member.connected) return;

        const wanted: string[] = [];
        const current = store.currentTrack && this.pathToTrackId.get(store.currentTrack.path);
        if (current) wanted.push(current);

        // offer order is send order, so the soonest-needed track still streams first
        for (const item of this.buildSessionQueue().slice(0, PREFETCH_DEPTH)) {
            if (!wanted.includes(item.trackId)) wanted.push(item.trackId);
        }

        for (const trackId of wanted) {
            const path = this.trackIdToPath.get(trackId);
            const track = path && store.tracks.find(t => t.path === path);
            if (track) void peer.sender.offer({ trackId, path: track.path, ext: track.ext, size: track.size });
        }
    }

    private hostOnControl(userId: string, msg: ControlToHost) {
        if (this.role !== "host") return;

        const peer = this.hostPeers.get(userId);
        if (!peer) return;

        switch (msg.type) {
            case "ping":
                this.peers?.sendControl(userId, { type: "pong", t0: msg.t0, t1: performance.now(), t2: performance.now() });
                break;

            case "req":
                this.executeRequest(userId, peer, msg);
                break;

            case "status": {
                const syncing = msg.state === "syncing";
                if (peer.member.syncing !== syncing) {
                    peer.member.syncing = syncing;
                    this.broadcastMembers();
                    notify();
                }
                break;
            }

            case "file-accept":
                peer.sender?.handleAccept(msg.transferId);
                break;

            case "file-have":
                peer.sender?.handleHave(msg.transferId);
                break;

            case "leave":
                if (peer.lingerTimer !== null) clearTimeout(peer.lingerTimer);
                peer.sender?.destroy();
                this.hostPeers.delete(userId);
                this.peers?.close(userId);
                this.broadcastMembers();
                toast(`${peer.member.username} left the listening session`);
                notify();
                break;
        }
    }

    /** Permissions are re-checked here, at execution time — the UI check is cosmetic. */
    private executeRequest(userId: string, peer: HostPeerState, msg: Extract<ControlToHost, { type: "req"; }>) {
        if (!peer.member.perms[permFor(msg.action)]) {
            this.peers?.sendControl(userId, { type: "deny", reqId: msg.id, reason: "You don't have permission to do that" });
            return;
        }

        switch (msg.action) {
            case "play": void store.play(); break;
            case "pause": store.pause(); break;
            case "seek": if (msg.seconds !== undefined) store.seek(msg.seconds); break;
            case "next": void store.next(); break;
            case "previous": void store.previous(); break;

            case "play-track": {
                const path = msg.trackId && this.trackIdToPath.get(msg.trackId);
                const index = path ? store.tracks.findIndex(t => t.path === path) : -1;
                if (index !== -1) void store.load(index);
                break;
            }

            case "queue-add": {
                const path = msg.trackId && this.trackIdToPath.get(msg.trackId);
                const index = path ? store.tracks.findIndex(t => t.path === path) : -1;
                if (index !== -1) {
                    if (msg.front) store.playNext(index);
                    else store.addToQueue(index);
                }
                break;
            }

            case "queue-remove": if (msg.qid) store.removeFromQueue(msg.qid); break;
            case "queue-move": if (msg.qid) store.moveInQueue(msg.qid, msg.beforeQid ?? null); break;
            case "queue-play": if (msg.qid) void store.playQueued(msg.qid); break;
            case "queue-clear": store.clearQueue(); break;
        }
    }

    // #endregion

    // #region listener: signaling, control & sync

    private async listenerOnSignal(authorId: string, _channelId: string, msg: SignalMessage) {
        if (this.role !== "listener" || authorId !== this.hostUserId) return;

        if (msg.type === "offer" && msg.nonce === this.joinNonce) {
            this.pendingOffer?.resolve(msg.sdp);
        } else if (msg.type === "reject" && msg.nonce === this.joinNonce) {
            const reason = msg.reason === "bad-version"
                ? "The host runs an incompatible plugin version"
                : msg.reason === "full" ? "The session is full" : "The host isn't running a session";
            this.pendingOffer?.reject(new Error(reason));
        }
    }

    private listenerOnOpen() {
        this.connection = "connected";
        this.reconnectAttempt = 0;
        this.error = null;

        if (this.hostChannelId) void deleteOwnSignals(this.hostChannelId);

        store.setSession(this.adapter("listener"));
        this.startClockSync();
        this.startDriftLoop();
        notify();
    }

    private listenerOnClose() {
        if (this.role !== "listener" || this.leaving) return;

        store.getMediaElement().pause();

        if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
            this.error = "Lost the connection to the host";
            this.teardown();
            toast("Listen along: lost the connection to the host", Toasts.Type.FAILURE);
            return;
        }

        this.connection = "reconnecting";
        notify();

        const delay = RECONNECT_DELAYS[this.reconnectAttempt++];
        setTimeout(() => {
            if (this.role !== "listener" || this.leaving || this.connection !== "reconnecting") return;

            this.connectToHost().catch(() => this.listenerOnClose());
        }, delay);
    }

    private listenerOnControl(msg: ControlToListener) {
        if (this.role !== "listener") return;

        switch (msg.type) {
            case "welcome":
                this.myPerms = msg.perms;
                this.members = msg.members;
                this.sessionQueue = msg.queue;
                this.manifest.clear();
                if (msg.state) this.applyState(msg.state);
                notify();
                break;

            case "manifest":
                for (const track of msg.tracks) this.manifest.set(track.id, track);
                notify();
                break;

            case "members":
                this.members = msg.list;
                break;

            case "perms":
                this.myPerms = msg.perms;
                toast("Your listen along permissions changed");
                break;

            case "queue":
                this.sessionQueue = msg.items;
                break;

            case "state":
                this.applyState(msg.state);
                break;

            case "pong":
                this.onPong(msg.t0, msg.t1, msg.t2);
                break;

            case "deny":
                toast(msg.reason, Toasts.Type.FAILURE);
                break;

            case "file-offer":
                void this.receiver?.handleOffer(msg);
                break;

            case "kick":
                this.leaving = true;
                this.teardown();
                toast("The host removed you from the listening session", Toasts.Type.FAILURE);
                return;

            case "end":
                this.leaving = true;
                this.teardown();
                toast("The host ended the listening session");
                return;
        }

        notify();
    }

    private onTrackReady(trackId: string, path: string) {
        this.readyTracks.set(trackId, path);

        if (this.syncing?.trackId === trackId) {
            this.syncing = null;
            void this.sendToHost({ type: "status", state: "ready", trackId });
            // the state that made us wait may have been superseded; apply the latest
            if (this.playback) this.applyState(this.playback, true);
        }
        notify();
    }

    /** The heart of listener playback: make the local element match the host's clock. */
    private applyState(state: PlaybackState, reapply = false) {
        if (!reapply && this.playback && state.revision <= this.playback.revision) return;
        this.playback = state;

        if (this.scheduledStartTimer !== null) {
            clearTimeout(this.scheduledStartTimer);
            this.scheduledStartTimer = null;
        }

        if (!state.trackId) {
            store.clearExternal();
            this.loadedTrackId = null;
            return;
        }

        const path = this.readyTracks.get(state.trackId);
        if (!path) {
            // not on disk yet: report syncing and wait for the transfer the host
            // fired alongside this state (or already has in flight)
            if (this.syncing?.trackId !== state.trackId) {
                this.syncing = { trackId: state.trackId, progress: 0 };
                void this.sendToHost({ type: "status", state: "syncing", trackId: state.trackId });
            }
            // raw element pause — store.pause() would loop back into request()
            store.getMediaElement().pause();
            return;
        }

        const track = this.manifest.get(state.trackId);
        const element = store.getMediaElement();

        if (this.loadedTrackId !== state.trackId) {
            this.loadedTrackId = state.trackId;
            store.loadExternal(store.fileUrl(path), {
                title: track?.title ?? "Shared track",
                artist: track?.artist ?? "",
                album: track?.album ?? "",
                isVideo: track?.isVideo ?? false
            });
        }

        if (!state.isPlaying) {
            element.pause();
            element.currentTime = state.position;
            return;
        }

        const leadMs = state.hostClock - this.hostNow();
        if (leadMs > 20) {
            // a scheduled start: arm a timer against the shared clock
            element.pause();
            element.currentTime = state.position;
            this.scheduledStartTimer = window.setTimeout(() => {
                this.scheduledStartTimer = null;
                element.play().catch(() => { });
            }, leadMs);
        } else {
            element.currentTime = state.position + -leadMs / 1000;
            element.play().catch(() => { });
        }
    }

    // #region clock

    private startClockSync() {
        this.pingCount = 0;
        this.clockSamples = [];

        const tick = () => {
            if (this.role !== "listener" || !this.hostUserId) return;

            this.peers?.sendControl(this.hostUserId, { type: "ping", t0: performance.now() });
            this.pingCount++;
            this.pingTimer = window.setTimeout(tick, this.pingCount < CLOCK_SAMPLES ? 2_000 : 10_000);
        };

        if (this.pingTimer !== null) clearTimeout(this.pingTimer);
        tick();
    }

    private onPong(t0: number, t1: number, t2: number) {
        const t3 = performance.now();
        const offset = (t1 - t0 + (t2 - t3)) / 2;
        const rtt = t3 - t0 - (t2 - t1);

        this.clockSamples.push({ offset, rtt });
        if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();

        // the sample with the least queueing delay carries the truest offset
        const best = this.clockSamples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
        this.rtt = best.rtt;
        this.clockOffset = this.clockSamples.length === 1
            ? best.offset
            : this.clockOffset * 0.8 + best.offset * 0.2;
    }

    private hostNow() {
        return performance.now() + this.clockOffset;
    }

    // #endregion

    // #region drift

    private startDriftLoop() {
        if (this.driftTimer !== null) clearTimeout(this.driftTimer);

        const tick = () => {
            if (this.role !== "listener") return;
            this.driftTimer = window.setTimeout(tick, DRIFT_TICK_MS);

            const state = this.playback;
            if (!state?.isPlaying || !state.trackId || this.syncing || this.scheduledStartTimer !== null) return;
            if (this.loadedTrackId !== state.trackId) return;

            const element = store.getMediaElement();
            if (element.paused || !Number.isFinite(element.duration)) return;

            const expected = state.position + Math.max(0, this.hostNow() - state.hostClock) / 1000;
            if (expected >= element.duration) return; // host will flip tracks any moment

            const err = expected - element.currentTime;

            if (Math.abs(err) > DRIFT_HARD_SEEK) {
                store.setPlaybackRate(1);
                store.hardSeekSilently(expected);
            } else if (Math.abs(err) > DRIFT_NUDGE_MIN) {
                store.setPlaybackRate(1 + Math.sign(err) * Math.min(MAX_RATE_NUDGE, Math.abs(err) * 0.1));
            } else {
                store.setPlaybackRate(1);
            }
        };

        tick();
    }

    // #endregion

    /** Listener-side request path; the permission check here is just fast feedback. */
    request(action: RequestAction, args: { seconds?: number; trackId?: string; front?: boolean; qid?: string; beforeQid?: string | null; }) {
        if (this.role !== "listener" || !this.hostUserId) return;

        if (!this.myPerms[permFor(action)]) {
            toast("The host hasn't given you permission to do that", Toasts.Type.FAILURE);
            return;
        }

        this.peers?.sendControl(this.hostUserId, { type: "req", id: ++this.reqSeq, action, ...args });
    }

    private sendToHost(msg: ControlToHost) {
        if (this.hostUserId) this.peers?.sendControl(this.hostUserId, msg);
    }

    // #endregion

    /** How many people are in the session, counting the host. */
    get memberCount() {
        if (this.role === "none") return 0;
        return 1 + this.members.filter(m => m.connected).length;
    }
}

export const sessionStore = new SessionStore();

export function useSession() {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    return sessionStore;
}
