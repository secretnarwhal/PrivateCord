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

// All key material and per-channel state is stored in IndexedDB via
// @api/DataStore — NOT in definePluginSettings — because plugin settings are
// uploaded to Vencord's cloud sync backend when the user enables it. This
// mirrors baseConverter's userKeys.ts.

import * as DataStore from "@api/DataStore";
import { useEffect, useState } from "@webpack/common";

import { generateIdentity, Identity } from "./crypto";

const IDENTITY_KEY = "encryptDMs_identity_v1";
const USER_KEYS_KEY = "encryptDMs_userKeys_v1";
const CHANNEL_KEYS_KEY = "encryptDMs_channelKeys_v1";
const ENABLED_CHANNELS_KEY = "encryptDMs_enabledChannels_v1";

/** userId -> b64 SPKI public key */
type UserKeyMap = Record<string, string>;
/** channelId -> (userId -> b64 SPKI public key) */
type ChannelKeyMap = Record<string, Record<string, string>>;
type EnabledChannelMap = Record<string, boolean>;

let identity: Identity | undefined;
let userKeys: UserKeyMap = {};
let channelKeys: ChannelKeyMap = {};
let enabledChannels: EnabledChannelMap = {};

const subscribers = new Set<() => void>();

function notify() {
    subscribers.forEach(fn => fn());
}

let statePromise: Promise<void> | undefined;

/**
 * Loads persisted state and lazily generates the RSA identity on first start.
 * Memoized: safe (and cheap) to await from every send. A failed load clears
 * the memo so the next call retries instead of caching the rejection.
 *
 * IMPORTANT: PluginManager registers the pre-send listener without awaiting
 * start(), so outgoing handlers MUST await this before consulting
 * isChannelEnabled — otherwise an enabled channel reads as disabled during
 * startup and plaintext would be sent.
 */
export function initEncryptDMsState(): Promise<void> {
    return statePromise ??= loadState().catch(e => {
        statePromise = undefined;
        throw e;
    });
}

async function loadState(): Promise<void> {
    const [storedIdentity, storedUserKeys, storedChannelKeys, storedEnabled] = await Promise.all([
        DataStore.get<Identity>(IDENTITY_KEY),
        DataStore.get<UserKeyMap>(USER_KEYS_KEY),
        DataStore.get<ChannelKeyMap>(CHANNEL_KEYS_KEY),
        DataStore.get<EnabledChannelMap>(ENABLED_CHANNELS_KEY),
    ]);

    userKeys = storedUserKeys ?? {};
    channelKeys = storedChannelKeys ?? {};
    enabledChannels = storedEnabled ?? {};

    if (storedIdentity?.publicKey && storedIdentity.privateKey) {
        identity = storedIdentity;
    } else {
        identity = await generateIdentity();
        await DataStore.set(IDENTITY_KEY, identity);
    }
    notify();
}

export function getIdentity(): Identity | undefined {
    return identity;
}

export async function regenerateIdentity(): Promise<Identity> {
    identity = await generateIdentity();
    await DataStore.set(IDENTITY_KEY, identity);
    notify();
    return identity;
}

export function getUserKey(userId: string): string | undefined {
    return userKeys[userId];
}

export function getChannelKeys(channelId: string): Record<string, string> {
    return channelKeys[channelId] ?? {};
}

export function isChannelEnabled(channelId: string): boolean {
    return enabledChannels[channelId] === true;
}

export async function setChannelEnabled(channelId: string, enabled: boolean): Promise<void> {
    enabledChannels = { ...enabledChannels, [channelId]: enabled };
    await DataStore.set(ENABLED_CHANNELS_KEY, enabledChannels);
    notify();
}

/** Store a peer's public key globally (userKeys). */
export async function setUserKey(userId: string, publicKeyB64: string): Promise<void> {
    userKeys = { ...userKeys, [userId]: publicKeyB64 };
    await DataStore.set(USER_KEYS_KEY, userKeys);
    notify();
}

/**
 * Store an accepted key in both userKeys[userId] and
 * channelKeys[channelId][userId], like the Java plugin's acceptKey.
 */
export async function storeAcceptedKey(channelId: string, userId: string, publicKeyB64: string): Promise<void> {
    userKeys = { ...userKeys, [userId]: publicKeyB64 };
    channelKeys = {
        ...channelKeys,
        [channelId]: { ...(channelKeys[channelId] ?? {}), [userId]: publicKeyB64 },
    };
    await Promise.all([
        DataStore.set(USER_KEYS_KEY, userKeys),
        DataStore.set(CHANNEL_KEYS_KEY, channelKeys),
    ]);
    notify();
}

/**
 * Recipient keys for a channel = channelKeys[channelId] plus, for every
 * recipient of the DM/group DM, userKeys[userId] (userKeys entries win,
 * matching the Java plugin's getKnownKeysForChannel put order).
 */
export function getKnownKeysForChannel(channelId: string, recipientIds: string[]): Record<string, string> {
    const result: Record<string, string> = { ...getChannelKeys(channelId) };
    for (const userId of recipientIds) {
        const key = userKeys[userId];
        if (key != null) result[userId] = key;
    }
    return result;
}

/** Re-renders the component whenever any EncryptDMs state changes. */
export function useEncryptDMsState(): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        const fn = () => setTick(v => v + 1);
        subscribers.add(fn);
        return () => void subscribers.delete(fn);
    }, []);
}
