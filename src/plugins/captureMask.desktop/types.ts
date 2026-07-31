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
    /** Discord's viewport in CSS px, used to derive the zoom scale */
    viewport: { width: number; height: number; };
}

/** A scroll-only update, so dragging the DM list doesn't reserialize it. */
export interface ScrollUpdate {
    id: string;
    scroll: number[];
}

/** Discord's styling, read as text in the renderer where it is same-origin. */
export interface HarvestedCss {
    css: string;
    sheets: number;
    failed: number;
}

export interface OverlayStartOptions {
    chrome: Chrome;
    /** Global SVG mask/clipPath definitions the cloned markup references by id */
    defs: string;
    /** ids of the targets that will be mirrored */
    ids: string[];
    /** Troubleshooting: build the window opaque, to test transparency support. */
    debugOpaque?: boolean;
    /** Troubleshooting: skip capture exclusion, to test whether it is what hides the window. */
    debugNoProtection?: boolean;
    /** Troubleshooting: open DevTools on the overlay to inspect the mirrored DOM. */
    debugDevTools?: boolean;
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
    /** Derived zoom factor the overlay is scaling by; 1 means Discord is at 100% */
    scale?: number;
    /** Stylesheets read in the renderer, and the bytes the overlay applied */
    cssSheets?: number;
    cssFailed?: number;
    cssBytes?: number;
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
