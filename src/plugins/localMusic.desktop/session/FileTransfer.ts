/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { randomHex } from "./crypto";
import { PeerManager } from "./PeerManager";
import { BUFFER_HIGH, FILE_CHUNK, FileFrame, IPC_READ_CHUNK } from "./protocol";

const Native = VencordNative.pluginHelpers.LocalMusic as PluginNative<typeof import("../native")>;

interface OutgoingTrack {
    trackId: string;
    path: string;
    ext: string;
    size: number;
}

interface OutgoingTransfer extends OutgoingTrack {
    transferId: string;
    contentHash: string;
}

/**
 * The host's side of the file channel for one peer: offers tracks, then streams
 * the accepted ones, one at a time, in offer order. Backpressure comes from the
 * channel's own bufferedAmount, so a slow listener never balloons memory.
 */
export class HostSender {
    private queue: OutgoingTransfer[] = [];
    /** transferId -> everything needed to (re)send; kept so a failed verify can retry */
    private known = new Map<string, OutgoingTransfer>();
    private offered = new Set<string>();
    private sending = false;
    private dead = false;

    constructor(
        private userId: string,
        private peers: PeerManager
    ) { }

    /** Offers a track unless it is already in flight or was already offered. */
    async offer(track: OutgoingTrack): Promise<void> {
        if (this.dead || this.offered.has(track.trackId)) return;
        this.offered.add(track.trackId);

        const contentHash = await Native.hashFile(track.path);
        if (this.dead) return;
        if (!contentHash) {
            // the file went away between manifest and offer; let the listener
            // keep waiting on nothing rather than crash — the host UI will skip it
            this.offered.delete(track.trackId);
            return;
        }

        const transfer: OutgoingTransfer = { ...track, transferId: randomHex(8), contentHash };
        this.known.set(transfer.transferId, transfer);

        this.peers.sendControl(this.userId, {
            type: "file-offer",
            transferId: transfer.transferId,
            trackId: transfer.trackId,
            contentHash: transfer.contentHash,
            size: transfer.size,
            ext: transfer.ext
        });
    }

    /** The listener wants the bytes (also how it asks again after a bad verify). */
    handleAccept(transferId: string) {
        const transfer = this.known.get(transferId);
        if (!transfer || this.dead) return;
        if (this.queue.some(t => t.transferId === transferId)) return;

        this.queue.push(transfer);
        void this.pump();
    }

    /** The listener already has it cached; nothing to send. */
    handleHave(transferId: string) {
        // nothing to do — kept for symmetry and future bookkeeping
    }

    private async pump() {
        if (this.sending) return;
        this.sending = true;

        try {
            while (!this.dead && this.queue.length) {
                await this.sendOne(this.queue.shift()!);
            }
        } finally {
            this.sending = false;
        }
    }

    private async sendOne(transfer: OutgoingTransfer) {
        const begin: FileFrame = {
            t: "begin",
            transferId: transfer.transferId,
            contentHash: transfer.contentHash,
            size: transfer.size,
            ext: transfer.ext
        };
        if (!this.peers.sendFileRaw(this.userId, JSON.stringify(begin))) return;

        for (let offset = 0; offset < transfer.size && !this.dead; offset += IPC_READ_CHUNK) {
            const slab = await Native.readFileChunk(
                transfer.path, offset, Math.min(IPC_READ_CHUNK, transfer.size - offset)
            );
            if (!slab?.length) return; // file shrank or vanished; the verify will catch it

            for (let i = 0; i < slab.length && !this.dead; i += FILE_CHUNK) {
                if (this.peers.fileBufferedAmount(this.userId) > BUFFER_HIGH)
                    await this.peers.waitFileBufferedLow(this.userId);
                if (this.dead) return;

                const chunk = slab.buffer.slice(slab.byteOffset + i, slab.byteOffset + Math.min(i + FILE_CHUNK, slab.length));
                if (!this.peers.sendFileRaw(this.userId, chunk as ArrayBuffer)) return;
            }
        }

        if (!this.dead)
            this.peers.sendFileRaw(this.userId, JSON.stringify({ t: "end", transferId: transfer.transferId } satisfies FileFrame));
    }

    destroy() {
        this.dead = true;
        this.queue = [];
        this.known.clear();
        this.offered.clear();
    }
}

export interface ReceiverEvents {
    /** the file is on disk and verified (or was already cached) */
    onTrackReady(trackId: string, path: string): void;
    /** 0..1 while a wanted track downloads */
    onProgress(trackId: string, fraction: number): void;
    /** verification failed twice, or the transfer broke */
    onFailed(trackId: string): void;
    sendToHost(msg: { type: "file-accept" | "file-have"; transferId: string; }): void;
}

interface IncomingTransfer {
    transferId: string;
    trackId: string;
    contentHash: string;
    size: number;
    ext: string;
    cacheId: string | null;
    received: number;
    pending: Uint8Array[];
    pendingBytes: number;
    retried: boolean;
}

/** Flush cacheAppend in slabs rather than per 16KB chunk — IPC is the slow part. */
const FLUSH_BYTES = 256 * 1024;

/**
 * The listener's side of the file channel: accepts offers it doesn't have
 * cached, streams the bytes into the native cache, and reports readiness.
 */
export class ListenerReceiver {
    /** transferId -> offer metadata; `current` is the one the ordered channel is streaming */
    private transfers = new Map<string, IncomingTransfer>();
    private current: IncomingTransfer | null = null;
    /** serialises the async native writes against the synchronous message events */
    private writeChain: Promise<void> = Promise.resolve();
    private dead = false;

    constructor(private events: ReceiverEvents) { }

    async handleOffer(offer: { transferId: string; trackId: string; contentHash: string; size: number; ext: string; }) {
        if (this.dead) return;

        const cached = await Native.cacheHas(offer.contentHash);
        if (this.dead) return;

        if (cached) {
            this.events.sendToHost({ type: "file-have", transferId: offer.transferId });
            this.events.onTrackReady(offer.trackId, cached);
            return;
        }

        this.transfers.set(offer.transferId, {
            ...offer,
            cacheId: null,
            received: 0,
            pending: [],
            pendingBytes: 0,
            retried: false
        });
        this.events.sendToHost({ type: "file-accept", transferId: offer.transferId });
    }

    /** Every message of the file channel lands here, frames and chunks alike. */
    handleFileMessage(data: ArrayBuffer | string) {
        if (this.dead) return;

        if (typeof data === "string") {
            let frame: FileFrame;
            try {
                frame = JSON.parse(data);
            } catch {
                return;
            }

            if (frame.t === "begin") this.chain(() => this.begin(frame.transferId));
            else if (frame.t === "end") this.chain(() => this.end(frame.transferId));
            return;
        }

        const transfer = this.current;
        if (!transfer) return;

        transfer.pending.push(new Uint8Array(data));
        transfer.pendingBytes += data.byteLength;
        transfer.received += data.byteLength;

        if (transfer.pendingBytes >= FLUSH_BYTES) this.chain(() => this.flush(transfer));

        this.events.onProgress(transfer.trackId, transfer.size ? transfer.received / transfer.size : 0);
    }

    private chain(work: () => Promise<void>) {
        this.writeChain = this.writeChain.then(work).catch(() => { });
    }

    private async begin(transferId: string) {
        const transfer = this.transfers.get(transferId);
        if (!transfer || this.dead) return;

        transfer.cacheId = await Native.cacheBegin(transfer.contentHash, transfer.ext, transfer.size);
        this.current = transfer;
    }

    private async flush(transfer: IncomingTransfer) {
        if (!transfer.cacheId || !transfer.pending.length) {
            transfer.pending = [];
            transfer.pendingBytes = 0;
            return;
        }

        const slab = new Uint8Array(transfer.pendingBytes);
        let offset = 0;
        for (const chunk of transfer.pending) {
            slab.set(chunk, offset);
            offset += chunk.length;
        }
        transfer.pending = [];
        transfer.pendingBytes = 0;

        await Native.cacheAppend(transfer.cacheId, slab);
    }

    private async end(transferId: string) {
        const transfer = this.transfers.get(transferId);
        if (!transfer) return;

        this.transfers.delete(transferId);
        if (this.current === transfer) this.current = null;

        if (!transfer.cacheId) {
            this.events.onFailed(transfer.trackId);
            return;
        }

        await this.flush(transfer);
        const path = await Native.cacheFinish(transfer.cacheId);
        if (this.dead) return;

        if (path) {
            this.events.onTrackReady(transfer.trackId, path);
            return;
        }

        // the bytes did not hash to what was promised — one clean retry
        if (!transfer.retried) {
            this.transfers.set(transferId, {
                ...transfer, cacheId: null, received: 0, pending: [], pendingBytes: 0, retried: true
            });
            this.events.sendToHost({ type: "file-accept", transferId });
        } else {
            this.events.onFailed(transfer.trackId);
        }
    }

    destroy() {
        this.dead = true;

        for (const transfer of this.transfers.values()) {
            if (transfer.cacheId) void Native.cacheAbort(transfer.cacheId);
        }
        this.transfers.clear();
        this.current = null;
    }
}
