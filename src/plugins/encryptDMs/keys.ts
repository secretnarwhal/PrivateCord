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

// Per-user/per-channel AES secrets and per-channel encryption toggles are stored
// in IndexedDB via @api/DataStore — NOT in definePluginSettings — because plugin
// settings are uploaded to Vencord's cloud sync backend when the user enables it.
// withPrivateSettings only changes the TS type; it does not opt the data out of sync.

import * as DataStore from "@api/DataStore";
import { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, useEffect, UserStore, useState } from "@webpack/common";

import { settings } from "./settings";

export interface KeyedStore<T> {
    get(id: string): T | undefined;
    getAll(): Record<string, T>;
    set(id: string, value: T): Promise<void>;
    remove(id: string): Promise<void>;
    /** Re-renders the component whenever the store changes. */
    use(): Record<string, T>;
}

function createKeyedStore<T>(storeKey: string): KeyedStore<T> {
    let cache: Record<string, T> = {};
    let loaded = false;
    const subscribers = new Set<() => void>();
    const notify = () => subscribers.forEach(fn => fn());

    const ready = DataStore.get<Record<string, T>>(storeKey).then(v => {
        cache = v ?? {};
        loaded = true;
        notify();
    }).catch(e => {
        loaded = true;
        console.error(`[EncryptDMs] Failed to load ${storeKey} from DataStore:`, e);
    });

    return {
        get: id => cache[id],
        getAll: () => cache,
        async set(id, value) {
            await DataStore.update<Record<string, T>>(storeKey, old => ({ ...old, [id]: value }));
            cache = { ...cache, [id]: value };
            notify();
        },
        async remove(id) {
            await DataStore.update<Record<string, T>>(storeKey, old => {
                const { [id]: _, ...rest } = old ?? {};
                return rest;
            });
            const { [id]: _, ...rest } = cache;
            cache = rest;
            notify();
        },
        use() {
            const [, setTick] = useState(0);
            useEffect(() => {
                let active = true;
                const fn = () => { if (active) setTick(v => v + 1); };
                subscribers.add(fn);
                if (!loaded) ready.then(fn);
                return () => {
                    active = false;
                    subscribers.delete(fn);
                };
            }, []);
            return cache;
        },
    };
}

/** userId -> AES secret, used in 1:1 DMs with that user (and for their messages elsewhere). */
export const userKeys = createKeyedStore<string>("encryptDMs_userKeys_v1");
/** channelId -> AES secret. Works for any channel: DMs, group DMs, text/voice channels and threads. */
export const channelKeys = createKeyedStore<string>("encryptDMs_channelKeys_v1");
/** channelId -> true when sending with that channel's own key is toggled off. */
export const disabledChannels = createKeyedStore<true>("encryptDMs_disabledChannels_v1");

function getDmPartnerId(channel: Channel | undefined | null): string | undefined {
    const recipients = channel?.recipients ?? [];
    return channel?.isDM?.() && recipients.length === 1 ? recipients[0] : undefined;
}

export type KeySource = "channel" | "user" | "shared";

/** The key used to encrypt messages sent in this channel: channel key > DM partner's key > shared secret. */
export function resolveSendKey(channel: Channel | undefined | null): { key: string; source: KeySource; } {
    const channelKey = channel && channelKeys.get(channel.id);
    if (channelKey) return { key: channelKey, source: "channel" };

    const partnerId = getDmPartnerId(channel);
    const partnerKey = partnerId && userKeys.get(partnerId);
    if (partnerKey) return { key: partnerKey, source: "user" };

    return { key: settings.store.aesSecret, source: "shared" };
}

/** The key used to decrypt a message: channel key > author's (or, for own DM messages, partner's) key > shared secret. */
export function resolveReceiveKey(message: Message, channel: Channel | undefined | null): { key: string; source: KeySource; } {
    const channelKey = channelKeys.get(message.channel_id);
    if (channelKey) return { key: channelKey, source: "channel" };

    const authorId = message.author?.id;
    const keyOwner = authorId === UserStore.getCurrentUser()?.id ? getDmPartnerId(channel) : authorId;
    const userKey = keyOwner && userKeys.get(keyOwner);
    if (userKey) return { key: userKey, source: "user" };

    return { key: settings.store.aesSecret, source: "shared" };
}

/** Whether this channel has its own key (a channel key, or the DM partner's per-user key) that can be toggled. */
export function hasOwnKey(channel: Channel | undefined | null): boolean {
    return resolveSendKey(channel).source !== "shared";
}

/**
 * Whether outgoing messages in this channel get encrypted. A channel with its own key
 * encrypts unless toggled off for that channel; every other channel follows the global
 * chat bar toggle.
 */
export function isChannelEncrypted(channel: Channel | undefined | null): boolean {
    if (!channel) return false;
    return hasOwnKey(channel)
        ? !disabledChannels.get(channel.id)
        : settings.store.autoEncodeOutgoing;
}

export function toggleChannelEncryption(channelId: string): Promise<void> {
    return disabledChannels.get(channelId)
        ? disabledChannels.remove(channelId)
        : disabledChannels.set(channelId, true);
}

export function getChannelLabel(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return channelId;
    const partnerId = getDmPartnerId(channel);
    if (partnerId) return `@${UserStore.getUser(partnerId)?.username ?? partnerId}`;
    if (channel.isPrivate?.()) {
        return channel.name || channel.recipients.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
    }
    return `#${channel.name}`;
}
