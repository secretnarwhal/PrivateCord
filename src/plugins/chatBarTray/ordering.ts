/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Folds the buttons Discord/plugins are currently rendering (`natural`, in the order they
 * would normally appear) into the user's saved order.
 *
 * Ids the user has never seen are inserted next to the natural neighbour they normally follow,
 * so a newly installed plugin shows up where it would have without this plugin instead of being
 * dumped at one end. Saved ids that aren't currently rendered are kept — buttons come and go
 * depending on the channel (gift/sticker/submit), and dropping them would silently reset their
 * position every time you visit a channel that hides them.
 */
export function mergeOrder(natural: readonly string[], saved: readonly string[]): string[] {
    const result = [...saved];
    const placed = new Set(result);

    for (let i = 0; i < natural.length; i++) {
        const id = natural[i];
        if (placed.has(id)) continue;

        let anchor = -1;
        for (let j = i - 1; j >= 0; j--) {
            const idx = result.indexOf(natural[j]);
            if (idx !== -1) {
                anchor = idx;
                break;
            }
        }

        result.splice(anchor + 1, 0, id);
        placed.add(id);
    }

    return result;
}

/** Moves `id` so that it sits directly after `afterId`, or first if `afterId` is undefined. */
export function place(list: readonly string[], id: string, afterId: string | undefined): string[] {
    const out = list.filter(x => x !== id);

    if (afterId === undefined) {
        out.unshift(id);
        return out;
    }

    const idx = out.indexOf(afterId);
    if (idx === -1) out.push(id);
    else out.splice(idx + 1, 0, id);

    return out;
}
