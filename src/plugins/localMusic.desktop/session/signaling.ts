/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendMessage } from "@utils/discord";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, MessageActions, UserStore } from "@webpack/common";

import { openSignal, randomHex, sealSignal } from "./crypto";
import { SIGNAL_PREFIX, SignalMessage } from "./protocol";

const ChannelActionCreators = findByPropsLazy("openPrivateChannel");

/**
 * Discord's limit is 2000; headroom for the header and any future prefixing.
 * The SDP of a non-trickle offer usually lands at 2-4KB sealed, so a handshake
 * is typically 2-3 messages per leg.
 */
const PART_SIZE = 1800;
/** ms between the parts of one signal, and between deletions — rate limit headroom */
const SEND_SPACING = 350;
const REASSEMBLY_TTL = 60_000;

const HEADER = /^\[lm-signal:v1:([0-9a-f]{8}):(\d+)\/(\d+)\]([\s\S]+)$/;

const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/**
 * The one active session (a client hosts or listens, never both) registers
 * itself here; without a context every signal-shaped message is ignored cheaply.
 */
interface SignalContext {
    aesKey: CryptoKey;
    onSignal(authorId: string, channelId: string, msg: SignalMessage): void;
}

let context: SignalContext | null = null;

export function setSignalContext(ctx: SignalContext | null) {
    context = ctx;
}

interface PartialSignal {
    parts: (string | undefined)[];
    received: number;
    expires: number;
}

const reassembly = new Map<string, PartialSignal>();

/** channelId -> ids of signal messages this client sent there and hasn't cleaned up */
const ownSignals = new Map<string, Set<string>>();

/**
 * Sends one logical signal as encrypted chunked messages. The message ids for
 * later cleanup are collected by our own MESSAGE_CREATE echo rather than the
 * send response, so nothing depends on MessageActions' return shape.
 */
export async function sendSignal(channelId: string, aesKey: CryptoKey, msg: SignalMessage): Promise<void> {
    const senderId = UserStore.getCurrentUser().id;
    const msgId = randomHex(4);
    const sealed = await sealSignal(aesKey, senderId, msgId, msg);

    const total = Math.ceil(sealed.length / PART_SIZE);
    for (let part = 0; part < total; part++) {
        const body = sealed.slice(part * PART_SIZE, (part + 1) * PART_SIZE);
        await sendMessage(channelId, {
            content: `[lm-signal:v1:${msgId}:${part + 1}/${total}]${body}`
        });
        if (part + 1 < total) await sleep(SEND_SPACING);
    }
}

/**
 * Deletes this client's own signaling messages in the channel (each side can
 * only delete its own in a DM). Best-effort — a failure just leaves an odd
 * message behind, it doesn't affect the session.
 */
export async function deleteOwnSignals(channelId: string) {
    const ids = ownSignals.get(channelId);
    if (!ids?.size) return;

    ownSignals.delete(channelId);
    for (const id of ids) {
        try {
            await MessageActions.deleteMessage(channelId, id);
        } catch { }
        await sleep(SEND_SPACING + 50);
    }
}

/**
 * Fed every MESSAGE_CREATE by the plugin. Cheap rejects first; only messages
 * that look like signals, in DMs, while a session is active, reach the crypto.
 */
export function handleIncomingSignal(message: any) {
    const content: string | undefined = message?.content;
    if (!content?.startsWith(SIGNAL_PREFIX)) return;

    const authorId: string | undefined = message?.author?.id;
    const channelId: string | undefined = message?.channel_id;
    if (!authorId || !channelId) return;

    // our own echo: remember the id so the handshake can clean up after itself
    if (authorId === UserStore.getCurrentUser()?.id) {
        let ids = ownSignals.get(channelId);
        if (!ids) ownSignals.set(channelId, ids = new Set());
        if (message.id) ids.add(message.id);
        return;
    }

    if (!context) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.isDM?.()) return;

    const match = content.match(HEADER);
    if (!match) return;

    const [, msgId, partText, totalText, body] = match;
    const part = Number(partText);
    const total = Number(totalText);
    if (!part || !total || part > total || total > 64) return;

    const key = `${authorId}:${msgId}`;
    const now = Date.now();

    // sweep expired assemblies while we're here
    for (const [k, v] of reassembly) {
        if (v.expires < now) reassembly.delete(k);
    }

    let partial = reassembly.get(key);
    if (!partial) reassembly.set(key, partial = { parts: new Array(total), received: 0, expires: now + REASSEMBLY_TTL });

    if (partial.parts.length !== total || partial.parts[part - 1] !== undefined) return;
    partial.parts[part - 1] = body;
    partial.received++;

    if (partial.received < total) return;
    reassembly.delete(key);

    const { aesKey, onSignal } = context;
    void openSignal(aesKey, authorId, msgId, partial.parts.join("")).then(msg => {
        // null = not for us / wrong key / garbage; silently ignore either way
        if (msg && context?.aesKey === aesKey) onSignal(authorId, channelId, msg);
    });
}

/**
 * Finds (or creates) the DM channel with a user. Creation prefers whatever
 * non-navigating ensure function this Discord build exposes; the last resort
 * openPrivateChannel also focuses the DM, which is acceptable for a join.
 */
export async function resolveDmChannel(userId: string): Promise<string | null> {
    const existing = ChannelStore.getDMFromUserId(userId);
    if (existing) return existing;

    try {
        const ensured = await ChannelActionCreators.ensurePrivateChannel?.(userId);
        if (typeof ensured === "string" && ensured) return ensured;
    } catch { }

    const found = ChannelStore.getDMFromUserId(userId);
    if (found) return found;

    try {
        await ChannelActionCreators.openPrivateChannel(userId);
    } catch {
        return null;
    }

    for (let i = 0; i < 20; i++) {
        const id = ChannelStore.getDMFromUserId(userId);
        if (id) return id;
        await sleep(250);
    }

    return null;
}

/** Drops all transient signaling state; part of session teardown. */
export function resetSignaling() {
    context = null;
    reassembly.clear();
    ownSignals.clear();
}
