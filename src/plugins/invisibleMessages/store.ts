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

// Per-channel passwords and the last-used decrypt password live in IndexedDB via
// @api/DataStore — NEVER in definePluginSettings — because plugin settings are
// uploaded to Vencord's cloud sync backend when the user enables it, and these
// are secrets. Mirrors encryptDMs/keys.ts (memoized load, subscribers, hook).

import * as DataStore from "@api/DataStore";
import { useEffect, useState } from "@webpack/common";

const CHANNEL_PASSWORDS_KEY = "invisibleMessages_channelPasswords_v1";
const LAST_PASSWORD_KEY = "invisibleMessages_lastPassword_v1";
const PERMANENT_PASSWORD_KEY = "invisibleMessages_permanentPassword_v1";

/** channelId -> password */
type ChannelPasswordMap = Record<string, string>;

let channelPasswords: ChannelPasswordMap = {};
let lastUsedPassword: string | undefined;
// The user-set "permanent" password used by reveal mode (auto-decrypt) and by
// the reveal-mode second chatbar. Empty string means "fall back to the channel
// or default password".
let permanentPassword = "";

const subscribers = new Set<() => void>();

function notify() {
    subscribers.forEach(fn => fn());
}

let statePromise: Promise<void> | undefined;

/**
 * Loads persisted state. Memoized: cheap to await repeatedly. A failed load
 * clears the memo so the next call retries instead of caching the rejection.
 */
export function initInvisibleMessagesState(): Promise<void> {
    return statePromise ??= loadState().catch(e => {
        statePromise = undefined;
        throw e;
    });
}

async function loadState(): Promise<void> {
    const [storedChannelPasswords, storedLastPassword, storedPermanentPassword] = await Promise.all([
        DataStore.get<ChannelPasswordMap>(CHANNEL_PASSWORDS_KEY),
        DataStore.get<string>(LAST_PASSWORD_KEY),
        DataStore.get<string>(PERMANENT_PASSWORD_KEY),
    ]);

    channelPasswords = storedChannelPasswords ?? {};
    lastUsedPassword = storedLastPassword ?? undefined;
    permanentPassword = storedPermanentPassword ?? "";
    notify();
}

export function getChannelPassword(channelId: string): string | undefined {
    return channelPasswords[channelId];
}

export function getAllChannelPasswords(): ChannelPasswordMap {
    return channelPasswords;
}

export async function setChannelPassword(channelId: string, password: string): Promise<void> {
    channelPasswords = { ...channelPasswords, [channelId]: password };
    await DataStore.set(CHANNEL_PASSWORDS_KEY, channelPasswords);
    notify();
}

export async function removeChannelPassword(channelId: string): Promise<void> {
    if (!(channelId in channelPasswords)) return;
    const next = { ...channelPasswords };
    delete next[channelId];
    channelPasswords = next;
    await DataStore.set(CHANNEL_PASSWORDS_KEY, channelPasswords);
    notify();
}

export async function clearChannelPasswords(): Promise<void> {
    channelPasswords = {};
    await DataStore.set(CHANNEL_PASSWORDS_KEY, channelPasswords);
    notify();
}

export function getLastUsedPassword(): string | undefined {
    return lastUsedPassword;
}

export async function setLastUsedPassword(password: string): Promise<void> {
    lastUsedPassword = password;
    await DataStore.set(LAST_PASSWORD_KEY, password);
    notify();
}

/** The permanent password set from the chat-bar button's left-click menu ("" = unset). */
export function getPermanentPassword(): string {
    return permanentPassword;
}

export async function setPermanentPassword(password: string): Promise<void> {
    permanentPassword = password;
    await DataStore.set(PERMANENT_PASSWORD_KEY, password);
    notify();
}

/** Re-renders the component whenever any InvisibleMessages state changes. */
export function useInvisibleMessagesState(): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        const fn = () => setTick(v => v + 1);
        subscribers.add(fn);
        return () => void subscribers.delete(fn);
    }, []);
}
