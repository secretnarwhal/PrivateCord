/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let opener: (() => void) | null = null;

/**
 * Registered by the plugin on start. It exists so the settings page can open
 * the panel without importing the modal, which would put the settings module
 * in an import cycle with everything the panel touches.
 */
export function setPanelOpener(fn: (() => void) | null) {
    opener = fn;
}

export function openGhostPanel() {
    opener?.();
}
