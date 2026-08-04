/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let opener: ((open?: boolean) => void) | null = null;

/**
 * Registered by the plugin on start. It exists so the settings page (and the
 * store) can open the panel without importing the panel component, which would
 * put those modules in an import cycle with everything the panel touches.
 *
 * Module-scope reads across a cycle produce a TDZ error that takes down every
 * Vencord plugin at load, not just this one — hence the indirection.
 */
export function setPanelOpener(fn: ((open?: boolean) => void) | null) {
    opener = fn;
}

export function openIrcPanel() {
    opener?.(true);
}

export function toggleIrcPanel() {
    opener?.();
}
