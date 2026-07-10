/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Transient, in-memory reveal-mode state. Unlike ./store.ts (persisted secrets in
// DataStore) this holds session-only UI state and is intentionally NOT persisted:
//   - revealMode: the right-click toggle. When on, every invisible message
//     auto-decrypts inline and a second chatbar appears for composing secrets.
//   - secretDrafts: channelId -> text currently typed into the second chatbar.
//   - forcedReveals: messageId -> decrypted text for messages revealed manually
//     (the accessory "Reveal" chip or the message context menu). These render the
//     secret inline next to the message instead of via a Clyde bot message.

import { useEffect, useState } from "@webpack/common";

let revealMode = false;
const secretDrafts = new Map<string, string>();
const forcedReveals = new Map<string, string>();

const revealModeSubs = new Set<() => void>();
const draftSubs = new Set<() => void>();
const forcedSubs = new Set<() => void>();

function notify(subs: Set<() => void>) {
    subs.forEach(fn => fn());
}

/** Subscribes a component to a set of subscribers and re-renders on notify. */
function useSubscription(subs: Set<() => void>) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const fn = () => setTick(v => v + 1);
        subs.add(fn);
        return () => void subs.delete(fn);
    }, [subs]);
}

// ─── Reveal mode toggle ───────────────────────────────────────────────────────

export function isRevealMode(): boolean {
    return revealMode;
}

export function setRevealMode(value: boolean): void {
    if (revealMode === value) return;
    revealMode = value;
    // Turning reveal mode off hides every decrypted message again, including
    // ones that were revealed manually while it was on.
    if (!value && forcedReveals.size) {
        forcedReveals.clear();
        notify(forcedSubs);
    }
    notify(revealModeSubs);
}

export function toggleRevealMode(): void {
    setRevealMode(!revealMode);
}

export function useRevealMode(): boolean {
    useSubscription(revealModeSubs);
    return revealMode;
}

// ─── Second-chatbar secret drafts ─────────────────────────────────────────────

export function getSecretDraft(channelId: string): string {
    return secretDrafts.get(channelId) ?? "";
}

export function setSecretDraft(channelId: string, value: string): void {
    if (value) secretDrafts.set(channelId, value);
    else secretDrafts.delete(channelId);
    notify(draftSubs);
}

export function useSecretDraft(channelId: string): string {
    useSubscription(draftSubs);
    return getSecretDraft(channelId);
}

// ─── Manually-revealed messages (shown inline) ────────────────────────────────

export function getForcedReveal(messageId: string): string | undefined {
    return forcedReveals.get(messageId);
}

export function setForcedReveal(messageId: string, text: string): void {
    forcedReveals.set(messageId, text);
    notify(forcedSubs);
}

export function useForcedReveal(messageId: string): string | undefined {
    useSubscription(forcedSubs);
    return getForcedReveal(messageId);
}
