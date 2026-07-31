/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, StartAt } from "@utils/types";
import { ApplicationStreamingStore, MediaEngineStore, React } from "@webpack/common";

import managedStyle from "./styles.css?managed";
import { findTargetElement, type Target, TARGETS } from "./targets";
import type { BlockerStatus, Rect, TargetRects } from "./types";

const Native = VencordNative.pluginHelpers.CaptureMask as PluginNative<typeof import("./native")>;

const logger = new Logger("CaptureMask");

const TARGET_CLASS = "vc-cmask-target";
const BLUR_CLASS = "vc-cmask-blur";

/** How often engagement, mode and rects are re-checked. */
const TICK_INTERVAL_MS = 400;

/**
 * Wait after the helper's ack before revealing content: the ack proves the
 * SetWindowPos calls ran, this covers the compositor putting them on screen.
 */
const COVER_SLACK_MS = 50;

/** How far a rect may drift from its confirmed cover and still count covered. */
const COVER_TOLERANCE_PX = 3;

const settings = definePluginSettings({
    engageWhen: {
        type: OptionType.SELECT,
        description: "When to censor",
        options: [
            {
                label: "While screen sharing or streaming",
                value: "streaming",
                default: true
            },
            {
                // Discord only knows about its own Go Live, so anything else
                // recording the screen needs this.
                label: "Always (covers OBS, Zoom, Teams and the like)",
                value: "always"
            }
        ],
        onChange: () => update()
    },
    maskDmList: {
        type: OptionType.BOOLEAN,
        description: "Censor the DM list in the sidebar",
        default: true,
        onChange: () => update()
    },
    maskDmChat: {
        type: OptionType.BOOLEAN,
        description: "Censor the conversation when a DM or group DM is open",
        default: true,
        onChange: () => update()
    },
    maskStyle: {
        type: OptionType.SELECT,
        description:
            "Look of the visible mask (the fallback, and the brief cover while the blocker moves into place). "
            + "The capture-side blocker itself is always a solid black box: Windows paints it below the "
            + "compositor and offers no styling.",
        options: [
            { label: "Solid block", value: "blackout", default: true },
            { label: "Heavy blur", value: "blur" }
        ],
        onChange: () => update()
    },
    useFallback: {
        type: OptionType.BOOLEAN,
        description:
            "When the capture cannot be censored — you are sharing the Discord window itself, the blocker "
            + "helper failed, or the platform is unsupported — mask the content inside Discord, visible to you "
            + "too. Turn this off if sharing the client window means you actually want your DMs shown. "
            + "Off also means a blocker failure mid-stream shows your DMs to the capture.",
        default: true,
        onChange: () => update()
    },
    debugTint: {
        type: OptionType.BOOLEAN,
        description:
            "Troubleshooting: tint the blocker windows red so you can see where they are. "
            + "Capture sees the same black boxes either way, so this is safe to stream with.",
        default: false,
        onChange: () => restart()
    }
});

let active = false;
/** Blocker windows are up and confirmed, so the real DOM is left untouched. */
let blocking = false;
let busy = false;
let tickTimer: number | undefined;
/** Why the blocker is not running, when the failure happened on this side. */
let localError: string | undefined;
let lastSentRects = "";

/** Every element we have put a mask class on, so cleanup never misses one. */
const masked = new Set<HTMLElement>();
/** The element currently backing each target id. */
const liveEls = new Map<string, HTMLElement>();
/** Rects (CSS px) confirmed to have a blocker window over them, per target. */
const confirmedRects = new Map<string, Rect>();

let domObserver: MutationObserver | undefined;
let scanScheduled = false;

function enabledTargets(): Target[] {
    return TARGETS.filter(t =>
        (t.id === "dmList" && settings.store.maskDmList) ||
        (t.id === "dmChat" && settings.store.maskDmChat)
    );
}

function isSelfStreaming() {
    try {
        if (ApplicationStreamingStore?.getCurrentUserActiveStream?.() != null) return true;
    } catch { /* store not ready */ }

    try {
        if (MediaEngineStore?.getGoLiveSource?.() != null) return true;
    } catch { /* store not ready */ }

    return false;
}

/** The id of whatever Discord is currently capturing, "" when unknown. */
function captureSourceId(): string {
    try {
        // Cast: the source shape varies across Discord builds, so probe it
        const source = MediaEngineStore?.getGoLiveSource?.() as any;
        return String(source?.desktopSource?.id ?? source?.id ?? source?.sourceId ?? "");
    } catch {
        return "";
    }
}

function shouldEngage() {
    if (!enabledTargets().length) return false;
    return settings.store.engageWhen === "always" || isSelfStreaming();
}

/**
 * The blocker censors captures of the *screen*. A capture of the Discord
 * window itself sees only Discord's own pixels — a separate window on top of
 * it, protected or not, is simply not part of that surface — so sharing the
 * Discord window means the blocker cannot help.
 */
function sharingOwnWindow() {
    if (settings.store.engageWhen === "always") return false;
    return captureSourceId().includes("window");
}

function readRect(el: HTMLElement): Rect {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
}

function rectCovered(id: string, rect: Rect) {
    const c = confirmedRects.get(id);
    if (!c) return false;

    return Math.abs(c.x - rect.x) <= COVER_TOLERANCE_PX
        && Math.abs(c.y - rect.y) <= COVER_TOLERANCE_PX
        && Math.abs(c.width - rect.width) <= COVER_TOLERANCE_PX
        && Math.abs(c.height - rect.height) <= COVER_TOLERANCE_PX;
}

function maskEl(el: HTMLElement) {
    masked.add(el);
    el.classList.add(TARGET_CLASS);
    el.classList.toggle(BLUR_CLASS, settings.store.maskStyle === "blur");
}

function unmask(el: HTMLElement) {
    el.classList.remove(TARGET_CLASS, BLUR_CLASS);
    masked.delete(el);
}

function clearMasks() {
    for (const el of [...masked]) unmask(el);
}

/** Puts the visible mask on every enabled target — the fallback cover. */
function applyMasks() {
    const seen = new Set<HTMLElement>();

    for (const target of enabledTargets()) {
        if (!target.isRelevant()) continue;

        const el = findTargetElement(target);
        if (!el) continue;

        seen.add(el);
        maskEl(el);
    }

    for (const el of [...masked]) {
        if (!seen.has(el)) unmask(el);
    }
}

/**
 * Re-resolves the target elements and masks any that appeared without a
 * confirmed blocker over their rect. Called from a pre-paint hook, so a DM
 * panel that just mounted is covered before the browser ever composites it —
 * a frame that never painted cannot have been captured.
 */
function detectNewTargets(): boolean {
    let changed = false;

    for (const target of enabledTargets()) {
        if (!target.isRelevant()) {
            liveEls.delete(target.id);
            continue;
        }

        const el = findTargetElement(target);
        if (!el) {
            liveEls.delete(target.id);
            continue;
        }

        if (liveEls.get(target.id) === el) continue;
        liveEls.set(target.id, el);
        changed = true;

        // A remount at the same place is already behind a black box; only an
        // uncovered rect needs the visible cover until the blocker confirms.
        if (!rectCovered(target.id, readRect(el))) maskEl(el);
    }

    return changed;
}

/**
 * Watches for target subtrees mounting. requestAnimationFrame runs before the
 * frame is painted, so masking inside it beats the first paint of new content.
 */
function watchDom() {
    if (domObserver) return;

    domObserver = new MutationObserver(() => {
        // Fast path: every relevant target is known and still attached
        let missing = false;
        for (const t of enabledTargets()) {
            if (!t.isRelevant()) continue;
            const el = liveEls.get(t.id);
            if (!el || !el.isConnected) { missing = true; break; }
        }
        if (!missing || scanScheduled) return;

        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            if (detectNewTargets()) void syncBlockers(true);
        });
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
}

function unwatchDom() {
    domObserver?.disconnect();
    domObserver = undefined;
    scanScheduled = false;
}

/**
 * Ships current rects, waits for the helper to acknowledge them, then lifts
 * the visible mask off anything now provably behind a black box. Serialised
 * through a chain because the tick and the DOM observer both call it.
 */
let syncChain: Promise<void> = Promise.resolve();

function syncBlockers(force = false) {
    syncChain = syncChain
        .then(() => doSyncBlockers(force))
        .catch(err => logger.error("blocker sync failed", err));
    return syncChain;
}

async function doSyncBlockers(force: boolean) {
    if (!blocking) return;

    const rects: TargetRects["rects"] = [];
    for (const [id, el] of liveEls) {
        if (!el.isConnected) continue;
        rects.push({ id, rect: readRect(el) });
    }

    const payload: TargetRects = {
        rects,
        viewport: { width: window.innerWidth, height: window.innerHeight }
    };

    const serialised = JSON.stringify(payload);
    if (force || serialised !== lastSentRects) {
        lastSentRects = serialised;

        await Native.setRects(payload);
        await Native.sync();
        await new Promise(r => setTimeout(r, COVER_SLACK_MS));
        if (!blocking) return;

        for (const { id, rect } of rects) confirmedRects.set(id, rect);
    }

    for (const el of [...masked]) {
        for (const [id, live] of liveEls) {
            if (live === el && rectCovered(id, readRect(el))) {
                unmask(el);
                break;
            }
        }
    }
}

async function engageBlocker() {
    // Cover first: from this moment the content is hidden from capture
    // whether or not the blocker ever comes up. The DOM watcher starts now
    // too, so anything mounting during helper startup is covered pre-paint.
    applyMasks();
    watchDom();

    const result = await Native.start({ debugTint: settings.store.debugTint });
    if (!result.ok) {
        localError = result.reason;
        blocking = false;
        unwatchDom();
        if (!settings.store.useFallback) clearMasks();
        logger.warn("blocker unavailable:", result.reason);
        return;
    }

    localError = undefined;
    blocking = true;
    detectNewTargets();
    await syncBlockers(true);
}

async function disengageBlocker() {
    blocking = false;
    unwatchDom();
    lastSentRects = "";
    confirmedRects.clear();
    liveEls.clear();

    try {
        await Native.stop();
    } catch (err) {
        logger.error("failed to stop the blocker", err);
    }
}

async function tick() {
    if (busy) return;
    busy = true;

    try {
        if (!shouldEngage()) {
            if (active) {
                active = false;
                await disengageBlocker();
                clearMasks();
                localError = undefined;
            }
            return;
        }

        active = true;
        const blockerUseless = sharingOwnWindow() || !(await Native.isSupported());

        if (blockerUseless) {
            if (blocking) await disengageBlocker();
            if (settings.store.useFallback) applyMasks();
            else clearMasks();
            return;
        }

        if (!blocking) {
            await engageBlocker();
            return;
        }

        // Blocker mode, already running: verify it is still alive — a dead
        // helper censors nothing, and silently showing DMs to the capture is
        // the one failure this plugin must never shrug at.
        const status = await Native.getStatus();
        if (status.helper !== "ready") {
            localError = status.lastError ?? "the blocker helper stopped";
            blocking = false;
            unwatchDom();
            confirmedRects.clear();
            if (settings.store.useFallback) applyMasks();
            else clearMasks();
            return;
        }

        detectNewTargets();
        await syncBlockers();
    } catch (err) {
        logger.error("tick failed", err);
        localError = String(err);
        if (active && settings.store.useFallback) applyMasks();
    } finally {
        busy = false;
    }
}

function update() {
    void tick();
}

/** For settings that change what the helper was told at start. */
function restart() {
    if (!active) return;

    void (async () => {
        await disengageBlocker();
        await tick();
    })();
}

const onStoreChange = () => update();
const onResize = () => { if (blocking) void syncBlockers(); };

function verdict(status: BlockerStatus): [string, string] {
    if (!status.supported) {
        return settings.store.useFallback
            ? ["#f0b232", "This platform has no capture censor bar, so the content is masked for you too."]
            : ["#f23f43", "This platform has no capture censor bar and the fallback is off — nothing is protected."];
    }
    if (active && !blocking && sharingOwnWindow()) {
        return settings.store.useFallback
            ? ["#f0b232", "You are sharing the Discord window itself — the blocker cannot censor a window capture, so the visible mask is covering instead."]
            : ["#80848e", "You are sharing the Discord window itself and the fallback is off, so your DMs are shown — as configured."];
    }
    if (localError) {
        return settings.store.useFallback
            ? ["#f23f43", `Blocker unavailable, the visible mask is covering: ${localError}`]
            : ["#f23f43", `Blocker unavailable and the fallback is off — DMs are visible to capture: ${localError}`];
    }
    if (status.helper === "failed") return ["#f23f43", `The blocker helper failed: ${status.lastError ?? "unknown error"}`];
    if (!active) return ["#80848e", "Idle — will engage when you stream."];
    if (!blocking) return ["#f0b232", "Starting up — content is masked until the blocker confirms."];
    if (!status.blockers) return ["#f0b232", "Blocker is ready but no DM panel is on screen to censor."];

    return ["#23a55a", "Censoring capture — you see everything; the capture sees black boxes over your DMs."];
}

function StatusPanel() {
    const [status, setStatus] = React.useState<BlockerStatus | null>(null);

    React.useEffect(() => {
        let alive = true;
        const poll = () => Native.getStatus()
            .then(s => { if (alive) setStatus(s); })
            .catch(() => { /* main process not reachable */ });

        poll();
        const id = setInterval(poll, 1000);
        return () => { alive = false; clearInterval(id); };
    }, []);

    if (!status) return null;

    const [colour, message] = verdict(status);
    const rows: Array<[string, string]> = [
        ["Engaged", active ? "yes" : "no"],
        ["Mode", blocking ? "capture blocker" : active ? (settings.store.useFallback ? "visible mask" : "unprotected") : "—"],
        ["Fallback", settings.store.useFallback ? "enabled" : "disabled"],
        ["Helper", status.helper],
        ["Blockers up", String(status.blockers)],
        ["Zoom scale", status.scale ? status.scale.toFixed(3) : "—"],
        ["Blocker bounds", status.bounds ?? "—"],
        ["Furthest stage", status.stage],
        ["Last error", localError ?? status.lastError ?? "—"]
    ];

    return (
        <div style={{ marginBottom: 16, fontSize: 14, color: "var(--text-default)" }}>
            <div style={{
                padding: "8px 12px",
                marginBottom: 8,
                borderLeft: `3px solid ${colour}`,
                background: "var(--background-secondary)",
                borderRadius: 4
            }}>
                {message}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
                {rows.map(([label, value]) => (
                    <React.Fragment key={label}>
                        <span style={{ color: "var(--text-muted)" }}>{label}</span>
                        <span>{value}</span>
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}

export default definePlugin({
    name: "CaptureMask",
    description:
        "Hides your DMs from screen capture without hiding them from you: invisible censor windows black out "
        + "those regions in anything that records the screen, while Discord itself stays completely untouched.",
    tags: ["Privacy", "Voice"],
    authors: [{ name: "Ryan", id: 0n }],
    settings,
    managedStyle,
    settingsAboutComponent: StatusPanel,

    // The DM sidebar only exists once Discord has drawn its chrome
    startAt: StartAt.WebpackReady,

    start() {
        ApplicationStreamingStore?.addChangeListener?.(onStoreChange);
        MediaEngineStore?.addChangeListener?.(onStoreChange);
        window.addEventListener("resize", onResize);

        tickTimer = window.setInterval(tick, TICK_INTERVAL_MS);
        update();
    },

    stop() {
        ApplicationStreamingStore?.removeChangeListener?.(onStoreChange);
        MediaEngineStore?.removeChangeListener?.(onStoreChange);
        window.removeEventListener("resize", onResize);

        if (tickTimer !== undefined) clearInterval(tickTimer);
        tickTimer = undefined;

        active = false;
        blocking = false;
        unwatchDom();
        confirmedRects.clear();
        liveEls.clear();
        Native.stop().catch(() => { });
        clearMasks();
    }
});
