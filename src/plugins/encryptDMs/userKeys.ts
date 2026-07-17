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

// Per-user AES secrets are stored in IndexedDB via @api/DataStore — NOT in
// definePluginSettings — because plugin settings are uploaded to Vencord's
// cloud sync backend when the user enables it. withPrivateSettings only
// changes the TS type; it does not opt the data out of sync.

import * as DataStore from "@api/DataStore";
import { useEffect, useState } from "@webpack/common";

const STORE_KEY = "encryptDMs_userKeys_v1";

type UserKeyMap = Record<string, string>;

let cache: UserKeyMap = {};
let loaded = false;
const subscribers = new Set<() => void>();
const ready: Promise<void> = DataStore.get<UserKeyMap>(STORE_KEY).then(v => {
    cache = v ?? {};
    loaded = true;
    notify();
}).catch(e => {
    loaded = true;
    console.error("[EncryptDMs] Failed to load user keys from DataStore:", e);
});

function notify() {
    subscribers.forEach(fn => fn());
}

export function userKeysReady(): Promise<void> {
    return ready;
}

export function getUserKey(userId: string): string | undefined {
    return cache[userId];
}

export function getAllUserKeys(): UserKeyMap {
    return cache;
}

export async function setUserKey(userId: string, key: string): Promise<void> {
    await DataStore.update<UserKeyMap>(STORE_KEY, old => ({ ...(old ?? {}), [userId]: key }));
    cache = { ...cache, [userId]: key };
    notify();
}

export async function removeUserKey(userId: string): Promise<void> {
    await DataStore.update<UserKeyMap>(STORE_KEY, old => {
        if (!old) return {};
        const { [userId]: _, ...rest } = old;
        return rest;
    });
    const { [userId]: _, ...rest } = cache;
    cache = rest;
    notify();
}

export function useUserKeys(): UserKeyMap {
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
}
