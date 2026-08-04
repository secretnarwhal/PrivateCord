/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface GhostPreset {
    id: string;
    name: string;
    /** The lines this preset sends. More than one is cycled through. */
    messages: string[];
    /** Delay between sends, in ms. */
    intervalMs: number;
    /** Delete every message this preset sends. */
    ghost: boolean;
    /** Pick the next message at random instead of in order. */
    shuffle: boolean;
    /** Stop after this many sends. 0 runs until stopped. */
    maxSends: number;
}

/**
 * Discord's send limit is 5 messages per 5s per channel, and it gets unhappy
 * long before that when the messages are identical, so repeats are floored
 * well above the raw limit.
 */
export const MIN_INTERVAL_MS = 3000;
/** Deleting immediately races the send, so a little headroom avoids 404s and 429s. */
export const MIN_DELETE_DELAY_MS = 250;
/** Deletions are their own rate limit bucket; never fire them back to back. */
export const MIN_DELETE_SPACING_MS = 250;

export const DEFAULT_INTERVAL_MS = 30_000;

export function makeEmptyPreset(): GhostPreset {
    return {
        id: crypto.randomUUID(),
        name: "New preset",
        messages: [""],
        intervalMs: DEFAULT_INTERVAL_MS,
        ghost: true,
        shuffle: false,
        maxSends: 0
    };
}
