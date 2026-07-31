/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, spawn } from "child_process";
import { app, BrowserWindow, IpcMainInvokeEvent, screen } from "electron";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import type { BlockerStartOptions, BlockerStartResult, BlockerStatus, TargetRects } from "./types";

/**
 * The blocker relies on SetWindowDisplayAffinity(WDA_MONITOR): a window with
 * that affinity renders normally on the monitor but as an opaque black box in
 * every capture of the screen — BitBlt, Windows.Graphics.Capture, DXGI
 * duplication, screenshots — and the blanking covers the window's whole rect
 * even where the window itself is transparent (verified empirically). So an
 * invisible click-through window over the DM panel censors exactly that region
 * of the capture while the user sees Discord untouched.
 *
 * That is a Win32-only trick. macOS's sharingType and Electron's
 * setContentProtection both *exclude* a window from capture (capture sees what
 * is behind it), which is the opposite of what a censor bar needs.
 */
const CAN_BLOCK = process.platform === "win32";

/**
 * The affinity only sticks when set by the process that owns the window, and
 * Discord's Electron has no API for WDA_MONITOR — so a tiny helper process
 * creates and owns the blocker windows, driven over stdin with one command per
 * line: "set <id> <x> <y> <w> <h> <alpha>" in physical pixels, "drop <id>",
 * "hideall", "quit". It prints "ready" once listening and "err ..." on failure,
 * and exits when stdin closes so a dead Discord never leaves it behind.
 */
const HELPER_SOURCE = `$ErrorActionPreference = "Stop"
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class VcBlocker {
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CreateWindowExW")] static extern IntPtr CreateWindowEx(int ex, string cls, string name, int style, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowDisplayAffinity(IntPtr h, uint aff);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="RegisterClassW")] static extern ushort RegisterClass(ref WNDCLASS wc);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(uint c);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, EntryPoint="GetModuleHandleW")] static extern IntPtr GetModuleHandle(string s);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptx; public int pty; }

    public delegate IntPtr WndProcDel(IntPtr h, uint m, IntPtr w, IntPtr l);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct WNDCLASS {
        public uint style;
        public WndProcDel lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    static WndProcDel keepAlive = Proc;
    static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) { return DefWindowProc(h, m, w, l); }

    static Dictionary<string, IntPtr> windows = new Dictionary<string, IntPtr>();
    static Queue<string> queue = new Queue<string>();
    static object gate = new object();
    static bool quit = false;
    static string clsName = "VencordCaptureMaskBlocker";
    static IntPtr hInst;

    static void Say(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }

    public static void Run() {
        // Per-monitor DPI awareness, so SetWindowPos coordinates are physical
        // pixels on every monitor. The context call needs Win10 1607+; fall
        // back to system DPI awareness on anything older.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }

        hInst = GetModuleHandle(null);
        WNDCLASS wc = new WNDCLASS();
        wc.lpfnWndProc = keepAlive;
        wc.hInstance = hInst;
        wc.hbrBackground = CreateSolidBrush(0x000000FF); // BGR: red, only ever seen via the debug tint
        wc.lpszClassName = clsName;
        if (RegisterClass(ref wc) == 0) { Say("err registerclass " + Marshal.GetLastWin32Error()); return; }

        Thread reader = new Thread(ReadLoop);
        reader.IsBackground = true;
        reader.Start();

        Say("ready");

        MSG msg;
        while (!quit) {
            while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
            string line = null;
            lock (gate) { if (queue.Count > 0) line = queue.Dequeue(); }
            if (line != null) Handle(line); else Thread.Sleep(15);
        }

        foreach (IntPtr h in windows.Values) DestroyWindow(h);
    }

    static void ReadLoop() {
        string line;
        while ((line = Console.In.ReadLine()) != null) { lock (gate) { queue.Enqueue(line); } }
        // stdin closing means Discord is gone; take the blockers down with it
        lock (gate) { queue.Enqueue("quit"); }
    }

    static void Handle(string line) {
        string[] p = line.Trim().Split(' ');
        if (p.Length == 0 || p[0].Length == 0) return;

        if (p[0] == "quit") { quit = true; return; }

        // Commands are processed strictly in order, so a pong proves every
        // command sent before the ping has been applied.
        if (p[0] == "ping" && p.Length >= 2) { Say("pong " + p[1]); return; }

        if (p[0] == "hideall") {
            foreach (IntPtr h in windows.Values) ShowWindow(h, 0);
            Say("ok hideall");
            return;
        }

        if (p[0] == "drop" && p.Length >= 2) {
            IntPtr h;
            if (windows.TryGetValue(p[1], out h)) { DestroyWindow(h); windows.Remove(p[1]); }
            Say("ok drop " + p[1]);
            return;
        }

        if (p[0] == "set" && p.Length >= 7) {
            string id = p[1];
            int x = int.Parse(p[2]), y = int.Parse(p[3]), w = int.Parse(p[4]), hh = int.Parse(p[5]);
            byte alpha = byte.Parse(p[6]);

            IntPtr h;
            if (!windows.TryGetValue(id, out h)) {
                // LAYERED | TRANSPARENT | TOPMOST | TOOLWINDOW | NOACTIVATE, WS_POPUP:
                // invisible-ish, click-through, never focused, not in the taskbar
                h = CreateWindowEx(0x80000 | 0x20 | 0x8 | 0x80 | 0x8000000, clsName, "",
                    unchecked((int)0x80000000), x, y, w, hh, IntPtr.Zero, IntPtr.Zero, hInst, IntPtr.Zero);
                if (h == IntPtr.Zero) { Say("err create " + Marshal.GetLastWin32Error()); return; }

                // The entire point. If this fails the window censors nothing,
                // so it must not exist — the caller falls back to DOM masking.
                if (!SetWindowDisplayAffinity(h, 1 /* WDA_MONITOR */)) {
                    Say("err affinity " + Marshal.GetLastWin32Error());
                    DestroyWindow(h);
                    return;
                }
                windows[id] = h;
            }

            SetLayeredWindowAttributes(h, 0, alpha, 2 /* LWA_ALPHA */);
            // HWND_TOPMOST, SWP_NOACTIVATE | SWP_SHOWWINDOW
            SetWindowPos(h, new IntPtr(-1), x, y, w, hh, 0x10 | 0x40);
            Say("ok set " + id);
            return;
        }
    }
}
'@
Add-Type -TypeDefinition $src
[VcBlocker]::Run()
`;

const status: BlockerStatus = {
    supported: CAN_BLOCK,
    helper: "stopped",
    blockers: 0,
    visible: false,
    stage: "idle"
};

let helper: ChildProcess | undefined;
let helperReady: Promise<void> | undefined;

let main: BrowserWindow | undefined;
let teardown: Array<() => void> = [];

/** Last rects from the renderer, in CSS px; geometry re-derives from these. */
let cssRects: TargetRects["rects"] = [];
let viewportWidth = 0;
let tintAlpha = 1;
/** ids that currently have a live blocker window in the helper */
const liveIds = new Set<string>();

let pingCounter = 0;
const pongWaiters = new Map<string, () => void>();

function sendCmd(line: string) {
    try {
        helper?.stdin?.write(line + "\n");
    } catch (err) {
        status.lastError = `helper write: ${err}`;
    }
}

function killHelper() {
    const h = helper;
    helper = undefined;
    helperReady = undefined;
    liveIds.clear();
    status.helper = "stopped";
    status.blockers = 0;
    status.visible = false;

    if (!h) return;
    try {
        h.stdin?.write("quit\n");
    } catch { /* already gone */ }
    // quit destroys its windows; the timer covers a hung helper
    const timer = setTimeout(() => { try { h.kill(); } catch { /* already gone */ } }, 1500);
    h.once("exit", () => clearTimeout(timer));
}

app.on("will-quit", killHelper);

async function ensureHelper(): Promise<void> {
    if (helper && status.helper === "ready") return;
    if (helperReady) return helperReady;

    status.helper = "starting";
    status.stage = "starting helper";

    helperReady = (async () => {
        const dir = join(process.env.DATA_DIR || app.getPath("userData"), "CaptureMask");
        await mkdir(dir, { recursive: true });

        const script = join(dir, "blocker.ps1");
        await writeFile(script, HELPER_SOURCE, "utf-8");

        const child = spawn("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        helper = child;

        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500); });

        await new Promise<void>((resolve, reject) => {
            // Add-Type compiles C# on first run, which can take a few seconds
            const timer = setTimeout(() => reject(new Error("helper start timed out")), 20_000);

            let buffer = "";
            child.stdout?.on("data", (chunk: Buffer) => {
                buffer += chunk.toString();
                let nl;
                while ((nl = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);

                    if (line === "ready") {
                        clearTimeout(timer);
                        status.helper = "ready";
                        resolve();
                    } else if (line.startsWith("pong ")) {
                        const id = line.slice(5).trim();
                        pongWaiters.get(id)?.();
                        pongWaiters.delete(id);
                    } else if (line.startsWith("err")) {
                        // Affinity refusal in particular means nothing is being
                        // censored; surface it so the renderer can re-mask.
                        status.lastError = `helper: ${line}`;
                        if (line.startsWith("err affinity") || line.startsWith("err registerclass")) {
                            status.helper = "failed";
                        }
                    }
                }
            });

            child.on("error", err => { clearTimeout(timer); reject(err); });
            child.on("exit", code => {
                clearTimeout(timer);
                if (helper === child) {
                    helper = undefined;
                    helperReady = undefined;
                    liveIds.clear();
                    if (status.helper !== "stopped") {
                        status.helper = "failed";
                        status.lastError = `helper exited (${code}) ${stderr.trim()}`.trim();
                    }
                    status.blockers = 0;
                    status.visible = false;
                }
                reject(new Error(`helper exited with code ${code}: ${stderr.trim()}`));
            });
        });
    })();

    try {
        await helperReady;
    } catch (err) {
        helperReady = undefined;
        status.helper = "failed";
        throw err;
    }
}

/**
 * Recomputes every blocker rect from the stored CSS rects and pushes them to
 * the helper. Runs on renderer updates and on every main-window move or
 * resize, so dragging the Discord window keeps the black boxes glued to it.
 */
function push() {
    if (!helper || status.helper !== "ready") return;
    if (!main || main.isDestroyed()) return;

    // Minimised or hidden: nothing of Discord is on screen, and a floating
    // black box would censor a rectangle of whatever app is there instead.
    if (main.isMinimized() || !main.isVisible()) {
        sendCmd("hideall");
        status.visible = false;
        return;
    }

    let content;
    try {
        content = main.getContentBounds();
    } catch (err) {
        status.lastError = `bounds: ${err}`;
        return;
    }

    // Discord's Electron has no getZoomFactor; the viewport (CSS px) against
    // the content bounds (DIPs) of the same area *is* the zoom factor.
    const zoom = viewportWidth > 0 ? content.width / viewportWidth : 1;
    if (Number.isFinite(zoom) && zoom > 0) status.scale = zoom;

    const wanted = new Set<string>();
    const boundsSummary: string[] = [];

    for (const { id, rect } of cssRects) {
        if (rect.width < 1 || rect.height < 1) continue;
        wanted.add(id);

        const dip = {
            x: Math.round(content.x + rect.x * zoom),
            y: Math.round(content.y + rect.y * zoom),
            width: Math.round(rect.width * zoom),
            height: Math.round(rect.height * zoom)
        };

        // SetWindowPos in a per-monitor-aware process wants physical pixels;
        // Electron speaks DIPs. This is the exact conversion for the monitor
        // the window is on, whatever its scale factor.
        let phys = dip;
        try {
            phys = screen.dipToScreenRect(main, dip);
        } catch { /* fall back to DIPs, correct at 100% scaling */ }

        sendCmd(`set ${id} ${phys.x} ${phys.y} ${phys.width} ${phys.height} ${tintAlpha}`);
        liveIds.add(id);
        boundsSummary.push(`${id}: ${phys.width}x${phys.height} @ ${phys.x},${phys.y}`);
    }

    for (const id of [...liveIds]) {
        if (!wanted.has(id)) {
            sendCmd(`drop ${id}`);
            liveIds.delete(id);
        }
    }

    status.blockers = wanted.size;
    status.visible = wanted.size > 0;
    status.bounds = boundsSummary.join("; ") || undefined;
}

function unhookMain() {
    for (const undo of teardown) {
        try {
            undo();
        } catch { /* window already gone */ }
    }
    teardown = [];
    main = undefined;
}

export async function start(event: IpcMainInvokeEvent, options: BlockerStartOptions): Promise<BlockerStartResult> {
    if (!CAN_BLOCK) {
        return { ok: false, reason: `${process.platform} has no WDA_MONITOR equivalent; falling back to masking` };
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, reason: "could not resolve the Discord window" };

    tintAlpha = options.debugTint ? 70 : 1;
    status.lastError = undefined;

    try {
        await ensureHelper();
    } catch (err) {
        status.stage = "helper failed";
        return { ok: false, reason: String(err) };
    }

    if (main !== win) {
        unhookMain();
        main = win;

        const on = (events: string[], handler: () => void) => {
            for (const name of events) {
                win.on(name as any, handler);
                teardown.push(() => win.off?.(name as any, handler));
            }
        };

        // Deliberately not focus/blur: a blocker that vanished on alt-tab
        // would expose the DMs to capture while Discord is still on screen.
        on(["move", "moved", "resize", "resized", "maximize", "unmaximize",
            "enter-full-screen", "leave-full-screen", "show", "restore"], push);
        on(["hide", "minimize"], () => { sendCmd("hideall"); status.visible = false; });
        on(["closed"], () => { unhookMain(); killHelper(); });
    }

    status.stage = "running";
    push();
    return { ok: true };
}

/** The renderer's rect updates: where the DM panels are, in CSS pixels. */
export function setRects(_event: IpcMainInvokeEvent, payload: TargetRects) {
    cssRects = payload.rects;
    viewportWidth = payload.viewport.width;
    push();
}

/**
 * Resolves once the helper has applied every command sent before this call —
 * it answers in order — so the renderer can hold its cover mask until the
 * black boxes provably exist. Resolves immediately when there is no helper:
 * there is nothing to wait for, and the caller's own state says whether that
 * is a failure.
 */
export function sync(_event: IpcMainInvokeEvent): Promise<void> {
    if (!helper || status.helper !== "ready") return Promise.resolve();

    const id = String(++pingCounter);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            pongWaiters.delete(id);
            resolve();
        }, 2000);

        pongWaiters.set(id, () => {
            clearTimeout(timer);
            resolve();
        });
        sendCmd(`ping ${id}`);
    });
}

export function stop(_event: IpcMainInvokeEvent) {
    cssRects = [];
    killHelper();
    unhookMain();
    status.stage = "idle";
    status.lastError = undefined;
}

/** Snapshot for the settings panel and the renderer's failure detection. */
export function getStatus(_event: IpcMainInvokeEvent): BlockerStatus {
    return { ...status };
}

/** Lets the renderer decide whether to attempt the blocker at all. */
export function isSupported(_event: IpcMainInvokeEvent) {
    return CAN_BLOCK;
}
