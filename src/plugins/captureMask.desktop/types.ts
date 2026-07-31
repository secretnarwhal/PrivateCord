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

/** The regions to blank in capture, plus the viewport that scales them. */
export interface TargetRects {
    rects: Array<{ id: string; rect: Rect; }>;
    /** Discord's viewport in CSS px, used to derive the zoom scale */
    viewport: { width: number; height: number; };
}

export interface BlockerStartOptions {
    /**
     * Troubleshooting: draw the blockers red-tinted so they can be seen on the
     * monitor. Capture shows the same black boxes either way — WDA_MONITOR
     * blanks the whole window rect in capture regardless of its alpha.
     */
    debugTint?: boolean;
}

export interface BlockerStartResult {
    ok: boolean;
    reason?: string;
}

/** How far the blocker got, so a hard failure reads differently from a no-op. */
export interface BlockerStatus {
    /** false everywhere but Windows — WDA_MONITOR is a Win32 display affinity */
    supported: boolean;
    helper: "stopped" | "starting" | "ready" | "failed";
    /** blocker windows currently alive */
    blockers: number;
    /** blockers are currently shown (the Discord window is visible) */
    visible: boolean;
    /** Derived zoom factor rects are scaled by; 1 means Discord is at 100% */
    scale?: number;
    /** last physical-pixel bounds pushed, for eyeballing alignment */
    bounds?: string;
    /** Furthest point start() reached; survives teardown so failures stay legible. */
    stage: string;
    lastError?: string;
}
