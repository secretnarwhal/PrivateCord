/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BUFFER_LOW, ControlToHost, ControlToListener, DC_CONTROL, DC_FILE } from "./protocol";

const ICE_SERVERS: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
];

/** How long a "disconnected" connection may flap before it counts as gone. */
const DISCONNECT_GRACE_MS = 10_000;
/** Vanilla (non-trickle) ICE: how long to wait for gathering before sending what we have. */
const GATHER_CAP_MS = 5_000;

interface Peer {
    pc: RTCPeerConnection;
    control: RTCDataChannel | null;
    file: RTCDataChannel | null;
    disconnectTimer: number | null;
    closed: boolean;
}

export interface PeerEvents {
    onControlMessage(userId: string, msg: any): void;
    onFileMessage(userId: string, data: ArrayBuffer | string): void;
    /** both data channels are open */
    onOpen(userId: string): void;
    /** fired exactly once per peer, however the connection died */
    onClose(userId: string): void;
}

/** Waits until the local description has all its candidates baked in. */
function gatherComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();

    return new Promise(res => {
        const timer = setTimeout(done, GATHER_CAP_MS);

        function done() {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", check);
            res();
        }

        function check() {
            if (pc.iceGatheringState === "complete") done();
        }

        pc.addEventListener("icegatheringstatechange", check);
    });
}

/**
 * Owns every RTCPeerConnection of the session, star-topology: the host holds
 * one per listener, a listener holds exactly one (to the host). The host
 * always creates the offer and both data channels, so channel configuration
 * lives in one place.
 */
export class PeerManager {
    private peers = new Map<string, Peer>();

    constructor(private events: PeerEvents) { }

    private newPeer(userId: string): Peer {
        this.close(userId);

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const peer: Peer = { pc, control: null, file: null, disconnectTimer: null, closed: false };
        this.peers.set(userId, peer);

        pc.addEventListener("connectionstatechange", () => {
            const state = pc.connectionState;

            if (state === "failed" || state === "closed") {
                this.teardown(userId, peer);
            } else if (state === "disconnected") {
                // transient blips recover on their own; only a lasting one is a loss
                peer.disconnectTimer ??= window.setTimeout(
                    () => this.teardown(userId, peer), DISCONNECT_GRACE_MS
                );
            } else if (state === "connected" && peer.disconnectTimer !== null) {
                clearTimeout(peer.disconnectTimer);
                peer.disconnectTimer = null;
            }
        });

        return peer;
    }

    private adoptChannel(userId: string, peer: Peer, channel: RTCDataChannel) {
        if (channel.label === DC_CONTROL) {
            peer.control = channel;
            channel.addEventListener("message", e => {
                try {
                    this.events.onControlMessage(userId, JSON.parse(e.data));
                } catch { }
            });
            // the control channel is the session's heartbeat: it closing is fatal
            channel.addEventListener("close", () => this.teardown(userId, peer));
        } else if (channel.label === DC_FILE) {
            peer.file = channel;
            channel.binaryType = "arraybuffer";
            channel.bufferedAmountLowThreshold = BUFFER_LOW;
            channel.addEventListener("message", e => this.events.onFileMessage(userId, e.data));
        } else {
            return;
        }

        channel.addEventListener("open", () => {
            if (peer.control?.readyState === "open" && peer.file?.readyState === "open")
                this.events.onOpen(userId);
        });
    }

    /** Host side: build the connection and both channels, return the offer SDP. */
    async createHostPeer(userId: string): Promise<string> {
        const peer = this.newPeer(userId);

        this.adoptChannel(userId, peer, peer.pc.createDataChannel(DC_CONTROL, { ordered: true }));
        this.adoptChannel(userId, peer, peer.pc.createDataChannel(DC_FILE, { ordered: true }));

        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        await gatherComplete(peer.pc);

        return peer.pc.localDescription!.sdp;
    }

    /** Listener side: accept the host's offer, return the answer SDP. */
    async acceptOfferAsListener(hostUserId: string, sdp: string): Promise<string> {
        const peer = this.newPeer(hostUserId);

        peer.pc.addEventListener("datachannel", e => this.adoptChannel(hostUserId, peer, e.channel));

        await peer.pc.setRemoteDescription({ type: "offer", sdp });
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await gatherComplete(peer.pc);

        return peer.pc.localDescription!.sdp;
    }

    /** Host side: the answer came back, connection now negotiates on its own. */
    async completeHostSide(userId: string, answerSdp: string): Promise<void> {
        const peer = this.peers.get(userId);
        if (!peer || peer.closed) return;

        await peer.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    }

    sendControl(userId: string, msg: ControlToHost | ControlToListener): boolean {
        const channel = this.peers.get(userId)?.control;
        if (channel?.readyState !== "open") return false;

        try {
            channel.send(JSON.stringify(msg));
            return true;
        } catch {
            return false;
        }
    }

    broadcastControl(msg: ControlToListener) {
        for (const userId of this.peers.keys()) this.sendControl(userId, msg);
    }

    sendFileRaw(userId: string, data: ArrayBuffer | string): boolean {
        const channel = this.peers.get(userId)?.file;
        if (channel?.readyState !== "open") return false;

        try {
            channel.send(data as any);
            return true;
        } catch {
            return false;
        }
    }

    fileBufferedAmount(userId: string): number {
        return this.peers.get(userId)?.file?.bufferedAmount ?? 0;
    }

    /** Resolves when the file channel has drained below the low watermark. */
    waitFileBufferedLow(userId: string): Promise<void> {
        const channel = this.peers.get(userId)?.file;
        if (!channel || channel.readyState !== "open" || channel.bufferedAmount <= BUFFER_LOW)
            return Promise.resolve();

        return new Promise(res => {
            const done = () => {
                channel.removeEventListener("bufferedamountlow", done);
                channel.removeEventListener("close", done);
                res();
            };
            channel.addEventListener("bufferedamountlow", done);
            channel.addEventListener("close", done);
        });
    }

    isConnected(userId: string): boolean {
        return this.peers.get(userId)?.control?.readyState === "open";
    }

    connectedPeers(): string[] {
        return [...this.peers.keys()].filter(id => this.isConnected(id));
    }

    /** Internal death path: emits onClose exactly once, then forgets the peer. */
    private teardown(userId: string, peer: Peer) {
        if (peer.closed) return;
        peer.closed = true;

        if (peer.disconnectTimer !== null) clearTimeout(peer.disconnectTimer);
        try {
            peer.pc.close();
        } catch { }

        if (this.peers.get(userId) === peer) this.peers.delete(userId);
        this.events.onClose(userId);
    }

    /** Deliberate local close: no onClose callback, the caller already knows. */
    close(userId: string) {
        const peer = this.peers.get(userId);
        if (!peer) return;

        peer.closed = true;
        if (peer.disconnectTimer !== null) clearTimeout(peer.disconnectTimer);
        try {
            peer.pc.close();
        } catch { }
        this.peers.delete(userId);
    }

    closeAll() {
        for (const userId of [...this.peers.keys()]) this.close(userId);
    }
}
