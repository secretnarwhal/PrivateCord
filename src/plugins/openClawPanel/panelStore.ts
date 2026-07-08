/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useReducer } from "@webpack/common";

// Tiny external store so the header toggle button and the docked panel (rendered
// via a portal) share one open/closed state without prop-drilling through Discord's
// component tree. The body class lets CSS react to the docked state if needed.
let open = false;
const listeners = new Set<() => void>();

export function isPanelOpen(): boolean {
    return open;
}

export function setPanelOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    document.body.classList.toggle("vc-openclaw-docked-open", open);
    listeners.forEach(l => l());
}

export function togglePanel(): void {
    setPanelOpen(!open);
}

/** Subscribe a component to the open/closed state. */
export function usePanelOpen(): boolean {
    const [, forceUpdate] = useReducer(x => x + 1, 0);
    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);
    return open;
}
