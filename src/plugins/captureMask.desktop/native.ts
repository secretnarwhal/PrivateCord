/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import overlayHtml from "file://overlay.html?minify&base64";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import type { OverlayStartOptions, OverlayStartResult,OverlayStatus } from "./types";

/**
 * Excluding a window from screen capture is SetWindowDisplayAffinity on Windows
 * and NSWindow.sharingType on macOS. X11 and Wayland have no equivalent, and
 * Electron's setContentProtection is a silent no-op there — which would make
 * the overlay *visible* to the capture it is supposed to hide from, turning the
 * plugin into the exact leak it exists to prevent. Never create it on Linux.
 */
const CAN_EXCLUDE_FROM_CAPTURE = process.platform === "win32" || process.platform === "darwin";

const CHANNEL = "vc-cmask";

const REPORT_CHANNEL = `${CHANNEL}-report`;

/**
 * The overlay is sandboxed with no node integration, so it needs a preload to
 * receive anything. Plugin natives are bundled into the main script rather than
 * emitted as files, so the preload has to be materialised on disk at runtime.
 */
const PRELOAD_SOURCE = `"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__captureMask", {
    onMessage: callback => ipcRenderer.on(${JSON.stringify(CHANNEL)}, (_event, message) => callback(message)),
    report: info => ipcRenderer.send(${JSON.stringify(REPORT_CHANNEL)}, info)
});
`;

interface Overlay {
    window: BrowserWindow;
    teardown: Array<() => void>;
}

const overlays = new Map<number, Overlay>();

/**
 * Whether the overlay actually came up is invisible from the renderer — a
 * window can be created, protected and still paint nothing. This records each
 * stage so a failure can be told apart from a blank mirror.
 */
const status: OverlayStatus = {
    supported: CAN_EXCLUDE_FROM_CAPTURE,
    created: false,
    loaded: false,
    visible: false,
    contentProtection: false,
    bridge: false,
    painted: 0,
    nodes: 0,
    stage: "idle"
};

// The overlay's preload reports back through here, so `bridge` proves the
// context bridge survived and `painted` proves markup reached the page.
ipcMain.on(REPORT_CHANNEL, (_event, info: Partial<OverlayStatus>) => {
    Object.assign(status, info);
});

/**
 * Discord ships its own Electron fork, and it does not expose
 * webContents.getZoomFactor/setZoomFactor — on this build zoom is only readable
 * as the `zoomFactor` property. Probe for whichever exists rather than assuming,
 * and fall back to 1:1 so a missing API costs alignment, not the whole overlay.
 */
function readZoom(contents: Electron.WebContents): number {
    try {
        const wc = contents as any;
        if (typeof wc.getZoomFactor === "function") return wc.getZoomFactor();
        if (typeof wc.zoomFactor === "number" && wc.zoomFactor > 0) return wc.zoomFactor;
    } catch { /* fall through to 1 */ }

    return 1;
}

function writeZoom(contents: Electron.WebContents, zoom: number) {
    try {
        const wc = contents as any;
        if (typeof wc.setZoomFactor === "function") wc.setZoomFactor(zoom);
        else if ("zoomFactor" in wc) wc.zoomFactor = zoom;
    } catch { /* zoom mismatch is cosmetic */ }
}

let preloadPath: string | undefined;

async function ensurePreload() {
    if (preloadPath) return preloadPath;

    const dir = join(process.env.DATA_DIR || app.getPath("userData"), "CaptureMask");
    await mkdir(dir, { recursive: true });

    const path = join(dir, "overlayPreload.js");
    await writeFile(path, PRELOAD_SOURCE, "utf-8");

    return preloadPath = path;
}

function destroy(mainId: number) {
    const overlay = overlays.get(mainId);
    if (!overlay) return;

    overlays.delete(mainId);
    for (const undo of overlay.teardown) {
        try {
            undo();
        } catch { /* the window may already be gone */ }
    }

    if (!overlay.window.isDestroyed()) overlay.window.destroy();

    status.created = status.loaded = status.visible = false;
    status.contentProtection = status.bridge = false;
    status.painted = status.nodes = 0;
    // `stage` and `lastError` deliberately survive: when start() fails it
    // destroys the half-built window, and wiping these would erase the only
    // record of how far it got.
}

export async function start(event: IpcMainInvokeEvent, options: OverlayStartOptions): Promise<OverlayStartResult> {
    if (!CAN_EXCLUDE_FROM_CAPTURE) {
        return {
            ok: false,
            reason: `${process.platform} cannot exclude a window from screen capture, so an overlay would be recorded too`
        };
    }

    const main = BrowserWindow.fromWebContents(event.sender);
    if (!main) return { ok: false, reason: "could not resolve the Discord window" };

    destroy(main.id);
    status.stage = "creating";

    try {
        const preload = await ensurePreload();

        const overlay = new BrowserWindow({
            // Deliberately not a child of the Discord window: on Windows a
            // transparent owned window frequently composites to nothing, which
            // is exactly the "overlay is up but paints nothing" failure. Being
            // top level costs us the automatic follow of minimise and restore,
            // which the show/hide/minimise handlers below do explicitly, and the
            // blur handler keeps it from floating over other applications.
            alwaysOnTop: true,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: "#00000000",
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            focusable: false,
            acceptFirstMouse: false,
            webPreferences: {
                preload,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
                // Its own partition keeps Discord's session and cookies out of a
                // window whose whole job is rendering other people's content.
                partition: "persist:vencord-capturemask",
                backgroundThrottling: false
            }
        });

        // Applied before the window is ever shown, so no frame of it can be
        // recorded in the gap between creation and protection.
        overlay.setContentProtection(true);
        overlay.setIgnoreMouseEvents(true);
        overlay.setMenu?.(null);
        // "pop-up-menu" sits above normal windows without the aggression of the
        // screen-saver level, which can punch through other apps' fullscreen.
        overlay.setAlwaysOnTop(true, "pop-up-menu");

        status.created = true;
        status.contentProtection = true;
        status.lastError = undefined;
        status.stage = "created";

        const record: Overlay = { window: overlay, teardown: [] };
        overlays.set(main.id, record);

        // Geometry runs on every window move and resize, so a single bad call
        // must never propagate — throwing here once used to tear down an
        // otherwise working overlay and silently drop back to mask-only.
        const syncBounds = () => {
            if (overlay.isDestroyed() || main.isDestroyed()) return;

            try {
                overlay.setBounds(main.getContentBounds());

                // Match Discord's zoom so one CSS pixel means the same thing in
                // both windows and the mirrored rects land where they should.
                const zoom = readZoom(main.webContents);
                if (readZoom(overlay.webContents) !== zoom) writeZoom(overlay.webContents, zoom);
            } catch (err) {
                status.lastError = `bounds sync: ${err}`;
            }
        };

        const setVisible = (visible: boolean) => {
            if (overlay.isDestroyed()) return;

            if (visible) {
                syncBounds();
                // showInactive, never show: the overlay must not take focus away
                // from Discord, or typing would break.
                if (!overlay.isVisible()) overlay.showInactive();
            } else if (overlay.isVisible()) {
                overlay.hide();
            }

            status.visible = overlay.isVisible();
            const b = overlay.getBounds();
            status.bounds = `${b.width}x${b.height} @ ${b.x},${b.y}`;
        };

        const on = (emitter: BrowserWindow, events: string[], handler: () => void) => {
            for (const name of events) {
                emitter.on(name as any, handler);
                record.teardown.push(() => emitter.off?.(name as any, handler));
            }
        };

        on(main, ["move", "moved", "resize", "resized", "maximize", "unmaximize",
            "enter-full-screen", "leave-full-screen"], syncBounds);
        on(main, ["show", "restore", "focus"], () => setVisible(true));
        // Losing focus means something else is in front; the overlay is
        // click-through and would otherwise hang over whatever that is.
        on(main, ["hide", "minimize", "blur"], () => setVisible(false));
        on(main, ["close", "closed"], () => destroy(main.id));

        const loaded = new Promise<void>((resolve, reject) => {
            overlay.webContents.once("did-finish-load", () => resolve());
            overlay.webContents.once("did-fail-load", (_e, code, desc) =>
                reject(new Error(`overlay failed to load: ${desc} (${code})`)));
        });

        await overlay.loadURL(`data:text/html;base64,${overlayHtml}`);
        await loaded;
        status.loaded = true;
        status.stage = "loaded";

        overlay.webContents.send(CHANNEL, { type: "init", css: options.css, chrome: options.chrome });

        if (main.isVisible() && !main.isMinimized()) setVisible(true);

        status.stage = "running";
        return { ok: true };
    } catch (err) {
        status.lastError = String(err);
        destroy(main.id);
        return { ok: false, reason: String(err) };
    }
}

/** Snapshot of how far the overlay actually got, for the settings panel. */
export function getStatus(_event: IpcMainInvokeEvent): OverlayStatus {
    return { ...status };
}

export function send(event: IpcMainInvokeEvent, message: unknown) {
    const main = BrowserWindow.fromWebContents(event.sender);
    if (!main) return;

    const overlay = overlays.get(main.id);
    if (!overlay || overlay.window.isDestroyed()) return;

    overlay.window.webContents.send(CHANNEL, message);
}

export function stop(event: IpcMainInvokeEvent) {
    const main = BrowserWindow.fromWebContents(event.sender);
    if (main) destroy(main.id);

    status.stage = "idle";
    status.lastError = undefined;
}

/** Lets the renderer decide whether to offer mirroring at all. */
export function isSupported(_event: IpcMainInvokeEvent) {
    return CAN_EXCLUDE_FROM_CAPTURE;
}
