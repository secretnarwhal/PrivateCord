/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useState } from "@webpack/common";

import { settings } from "./settings";
import { logger } from "./utils";

/** A pasted kaomoji longer than this is almost certainly not a kaomoji. */
const MAX_LENGTH = 120;
/** Enough that the list stays a list rather than a second library. */
const MAX_CUSTOM = 500;

interface StoredData {
    version: 1;
    /** the user's own kaomoji, newest first */
    custom: string[];
    /** most recently used first, built-in and custom alike */
    recent: string[];
}

let data: StoredData = { version: 1, custom: [], recent: [] };

let version = 0;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function persist() {
    // recents churn on every single click, so coalesce the writes
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            settings.store.storedData = JSON.stringify(data);
        } catch (e) {
            logger.error("Failed to save kaomoji", e);
        }
    }, 400);
}

function mutated() {
    version++;
    for (const l of listeners) l();
    persist();
}

export function loadStore() {
    if (!settings.store.storedData) return;

    try {
        const stored = JSON.parse(settings.store.storedData) as Partial<StoredData>;
        data = {
            version: 1,
            custom: Array.isArray(stored.custom) ? stored.custom : [],
            recent: Array.isArray(stored.recent) ? stored.recent : []
        };
    } catch (e) {
        logger.error("Stored kaomoji were corrupt, starting fresh", e);
    }

    version++;
    for (const l of listeners) l();
}

/** Re-renders the caller whenever the custom or recent lists change. */
export function useKaomojiStore(): number {
    const [v, setV] = useState(version);

    useEffect(() => {
        const l = () => setV(version);
        listeners.add(l);
        // the store may have loaded between the initial render and this effect
        l();
        return () => void listeners.delete(l);
    }, []);

    return v;
}

export const getCustom = () => data.custom;

export function getRecent(): string[] {
    return data.recent.slice(0, settings.store.recentCount);
}

/** The whole recent list, past what the Recent section shows — used to spot deletions. */
export const getAllRecent = () => data.recent;

/**
 * Splits a pasted blob into kaomoji. One per line, so pasting a list from a
 * website adds the whole list rather than one giant unusable entry.
 *
 * Returns only the ones that are actually new.
 */
export function addCustom(raw: string): string[] {
    const added = raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && line.length <= MAX_LENGTH)
        // a paste with the same face twice shouldn't add it twice
        .filter((line, i, all) => all.indexOf(line) === i)
        .filter(line => !data.custom.includes(line));

    if (!added.length) return [];

    data.custom = [...added, ...data.custom].slice(0, MAX_CUSTOM);
    mutated();
    return added;
}

export function removeCustom(text: string) {
    const next = data.custom.filter(t => t !== text);
    if (next.length === data.custom.length) return;

    data.custom = next;
    // a deleted kaomoji lingering in Recent would look like it came back
    data.recent = data.recent.filter(t => t !== text);
    mutated();
}

export function noteUsed(text: string) {
    if (settings.store.recentCount === 0) return;

    data.recent = [text, ...data.recent.filter(t => t !== text)].slice(0, 40);
    mutated();
}

export function clearRecent() {
    if (!data.recent.length) return;

    data.recent = [];
    mutated();
}
