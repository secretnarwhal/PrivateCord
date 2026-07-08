/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useReducer } from "@webpack/common";

import { fetchSessions, fetchUsage, OpenClawSession, OpenClawUsage } from "./utils";

// Background store so the panel's data is fetched ahead of time (warmed on plugin
// start) and survives the panel being closed/reopened — opening it shows the last
// snapshot instantly, then refreshes. The current-session view is derived from the
// session list (+ an optional user focus) rather than a separate status call.
interface DataState {
    sessions: OpenClawSession[];
    usage: OpenClawUsage | null;
    focusedKey: string | null;
    coreLoading: boolean;
    usageLoading: boolean;
    error: string | null;
    loadedOnce: boolean;
}

let state: DataState = {
    sessions: [],
    usage: null,
    focusedKey: null,
    coreLoading: false,
    usageLoading: false,
    error: null,
    loadedOnce: false
};

const listeners = new Set<() => void>();

function update(patch: Partial<DataState>): void {
    state = { ...state, ...patch };
    listeners.forEach(l => l());
}

export function getData(): DataState {
    return state;
}

/** The session the panel currently acts on: the focused one, else the latest. */
export function getCurrentSession(): OpenClawSession | null {
    const { sessions, focusedKey } = state;
    if (focusedKey) {
        const found = sessions.find(s => s.key === focusedKey);
        if (found) return found;
    }
    return sessions[0] ?? null;
}

export function setFocusedKey(key: string | null): void {
    update({ focusedKey: key });
}

export async function loadSessions(silent = false): Promise<void> {
    if (!silent) update({ coreLoading: true });
    try {
        const sessions = await fetchSessions();
        update({ sessions, error: null, loadedOnce: true });
    } catch (e) {
        update({ error: e instanceof Error ? e.message : String(e), loadedOnce: true });
    } finally {
        if (!silent) update({ coreLoading: false });
    }
}

export async function loadUsage(silent = false): Promise<void> {
    if (!silent) update({ usageLoading: true });
    try {
        update({ usage: await fetchUsage() });
    } catch {
        // Best-effort: keep the previous snapshot on failure.
    } finally {
        if (!silent) update({ usageLoading: false });
    }
}

/** Warm the cache so the panel is populated the moment it first opens. */
export function preload(): void {
    loadSessions(true);
    loadUsage(true);
}

export function useOpenClawData(): DataState {
    const [, forceUpdate] = useReducer(x => x + 1, 0);
    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);
    return state;
}
