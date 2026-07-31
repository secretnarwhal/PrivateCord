/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** A rect in the main window's CSS pixels, relative to its content area. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Classes and inline custom properties that Discord hangs its theme off of. */
export interface Chrome {
    htmlClass: string;
    htmlStyle: string;
    bodyClass: string;
    bodyStyle: string;
}

/** A full repaint of one target: markup, geometry and scroll state. */
export interface Frame {
    id: string;
    rect: Rect;
    html: string;
    /** scrollTop of every scrollable descendant, in document order */
    scroll: number[];
}

/** A scroll-only update, so dragging the DM list doesn't reserialize it. */
export interface ScrollUpdate {
    id: string;
    scroll: number[];
}

export interface OverlayStartOptions {
    chrome: Chrome;
    css: string;
    /** ids of the targets that will be mirrored */
    ids: string[];
}

/** How far the overlay got, so a hard failure reads differently from a blank mirror. */
export interface OverlayStatus {
    /** false on Linux, where nothing can be hidden from capture */
    supported: boolean;
    created: boolean;
    loaded: boolean;
    visible: boolean;
    contentProtection: boolean;
    /** the preload's context bridge reached the page */
    bridge: boolean;
    /** frames the overlay has applied */
    painted: number;
    /** elements in the last applied frame; 0 means markup arrived but rendered empty */
    nodes: number;
    /** Furthest point start() reached; survives teardown so failures stay legible. */
    stage: string;
    bounds?: string;
    lastError?: string;
}

export interface OverlayStartResult {
    ok: boolean;
    /**
     * Set when the overlay could not be created, or when the platform cannot
     * exclude a window from capture. The renderer keeps the mask up either way.
     */
    reason?: string;
}
