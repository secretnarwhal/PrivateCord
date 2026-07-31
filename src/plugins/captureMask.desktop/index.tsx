/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, StartAt } from "@utils/types";
import { ApplicationStreamingStore, MediaEngineStore, React } from "@webpack/common";

import { harvestCss } from "./css";
import { readChrome, readDefs, TargetMirror } from "./mirror";
import managedStyle from "./styles.css?managed";
import { findTargetElement, type Target, TARGETS } from "./targets";
import type { Frame, OverlayStatus, ScrollUpdate } from "./types";

const Native = VencordNative.pluginHelpers.CaptureMask as PluginNative<typeof import("./native")>;

const logger = new Logger("CaptureMask");

const TARGET_CLASS = "vc-cmask-target";
const BLUR_CLASS = "vc-cmask-blur";
const MIRRORED_CLASS = "vc-cmask-mirrored";

/** How often the masked elements are re-resolved, since Discord swaps its tree. */
const RESCAN_INTERVAL_MS = 500;

const settings = definePluginSettings({
    engageWhen: {
        type: OptionType.SELECT,
        description: "When to mask",
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
        description: "Mask the DM list in the sidebar",
        default: true,
        onChange: () => restart()
    },
    maskDmChat: {
        type: OptionType.BOOLEAN,
        description: "Mask the conversation when a DM or group DM is open",
        default: true,
        onChange: () => restart()
    },
    mirror: {
        type: OptionType.BOOLEAN,
        description:
            "Keep masked content readable to you by drawing it in a window that screen capture cannot see. "
            + "Turn this off to simply black the content out. Windows and macOS only.",
        default: true,
        onChange: () => restart()
    },
    debugOpaque: {
        type: OptionType.BOOLEAN,
        description:
            "Troubleshooting: build the overlay as an opaque magenta window instead of a transparent one. "
            + "If magenta appears, transparency was the problem. Safe to stream with.",
        default: false,
        onChange: () => restart()
    },
    debugNoProtection: {
        type: OptionType.BOOLEAN,
        description:
            "Troubleshooting: turn OFF capture exclusion for the overlay. Only use this while NOT streaming — "
            + "with this on, the overlay is recorded like any other window and your DMs would be visible.",
        default: false,
        onChange: () => restart()
    },
    debugDevTools: {
        type: OptionType.BOOLEAN,
        description:
            "Troubleshooting: open DevTools on the overlay window, to inspect the mirrored copy of the DOM. "
            + "The DevTools window is not capture protected, so close it before streaming.",
        default: false,
        onChange: () => restart()
    },
    maskStyle: {
        type: OptionType.SELECT,
        description: "What the capture sees in place of the content",
        options: [
            { label: "Solid block", value: "blackout", default: true },
            { label: "Heavy blur", value: "blur" }
        ],
        onChange: () => restart()
    }
});

let active = false;
let mirroring = false;
let busy = false;
let rescanTimer: number | undefined;
/** Why the mirror is not running, when the failure happened on this side. */
let localError: string | undefined;

const mirrors = new Map<string, TargetMirror>();
/** Every element we have put a mask class on, so cleanup never misses one. */
const masked = new Set<HTMLElement>();

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

function shouldEngage() {
    if (!enabledTargets().length) return false;
    return settings.store.engageWhen === "always" || isSelfStreaming();
}

function unmask(el: HTMLElement) {
    el.classList.remove(TARGET_CLASS, BLUR_CLASS, MIRRORED_CLASS);
    masked.delete(el);
}

function clearMasks() {
    for (const el of [...masked]) unmask(el);
}

/**
 * Resolves each enabled target and makes sure exactly those elements carry the
 * mask. Runs on a timer because Discord remounts these subtrees freely, and a
 * remounted element would otherwise come back unmasked mid-stream.
 */
function applyMasks() {
    const seen = new Set<HTMLElement>();

    for (const target of enabledTargets()) {
        if (!target.isRelevant()) continue;

        const el = findTargetElement(target);
        if (!el) continue;

        seen.add(el);
        masked.add(el);

        el.classList.add(TARGET_CLASS);
        el.classList.toggle(BLUR_CLASS, settings.store.maskStyle === "blur");
        el.classList.toggle(MIRRORED_CLASS, mirroring);
    }

    for (const el of [...masked]) {
        if (!seen.has(el)) unmask(el);
    }

    return seen;
}

const sendFrame = (frame: Frame) => {
    Native.send({ type: "frame", frame }).catch(err => logger.error("failed to send frame", err));
};

const sendScroll = (update: ScrollUpdate) => {
    Native.send({ type: "scroll", update }).catch(() => { /* next frame will resync */ });
};

/** Small enough that no single IPC message carries the whole stylesheet set. */
const CSS_CHUNK_SIZE = 512 * 1024;

/**
 * Ships the harvested CSS to the overlay in pieces. The full set is tens of
 * megabytes, which is what made sending it as one message fail silently.
 */
async function sendCss({ css, sheets, failed }: Awaited<ReturnType<typeof harvestCss>>) {
    for (let i = 0; i < css.length; i += CSS_CHUNK_SIZE) {
        await Native.send({ type: "css-chunk", text: css.slice(i, i + CSS_CHUNK_SIZE) });
    }

    await Native.send({ type: "css-done", sheets, failed });
    logger.info(`sent ${css.length} bytes of css from ${sheets} sheets (${failed} skipped)`);
}

function syncMirrors() {
    if (!mirroring) return;

    for (const target of enabledTargets()) {
        let mirror = mirrors.get(target.id);
        if (!mirror) {
            mirror = new TargetMirror(target, sendFrame, sendScroll);
            mirrors.set(target.id, mirror);
        }

        if (!mirror.sync()) {
            Native.send({ type: "drop", id: target.id }).catch(() => { });
        }
    }

    for (const [id, mirror] of [...mirrors]) {
        if (enabledTargets().some(t => t.id === id)) continue;

        mirror.detach();
        mirrors.delete(id);
        Native.send({ type: "drop", id }).catch(() => { });
    }
}

function stopMirrors() {
    for (const mirror of mirrors.values()) mirror.detach();
    mirrors.clear();
}

async function activate() {
    active = true;

    // The mask goes on before anything else, so from this point the content is
    // covered whether or not the overlay ever comes up.
    applyMasks();

    if (!settings.store.mirror) return;

    localError = undefined;

    try {
        if (!await Native.isSupported()) {
            logger.info("this platform cannot hide a window from screen capture; masking without a mirror");
            return;
        }

        const chrome = readChrome();
        const harvested = await harvestCss();
        const result = await Native.start({
            chrome,
            defs: readDefs(),
            ids: enabledTargets().map(t => t.id),
            debugOpaque: settings.store.debugOpaque,
            debugNoProtection: settings.store.debugNoProtection,
            debugDevTools: settings.store.debugDevTools
        });

        if (!result.ok) {
            localError = result.reason;
            logger.warn("mirror unavailable, masking without it:", result.reason);
            return;
        }

        if (!active) {
            // Deactivated while we were setting up
            await Native.stop();
            return;
        }

        await sendCss(harvested);

        mirroring = true;
        syncMirrors();

        // Let the first frames land before the real content stops painting,
        // otherwise the panel blinks empty for a moment.
        setTimeout(() => {
            if (mirroring) applyMasks();
        }, 120);
    } catch (err) {
        localError = String(err);
        logger.error("failed to start the mirror, masking without it", err);
    }
}

async function deactivate() {
    active = false;
    mirroring = false;
    stopMirrors();

    try {
        await Native.stop();
    } catch (err) {
        logger.error("failed to tear down the overlay", err);
    }

    clearMasks();
}

function update() {
    if (busy) return;

    const wanted = shouldEngage();
    if (wanted === active) {
        if (active) {
            applyMasks();
            syncMirrors();
        }
        return;
    }

    busy = true;
    (wanted ? activate() : deactivate())
        .catch(err => logger.error("state change failed", err))
        .finally(() => { busy = false; });
}

/** Rebuilds from scratch, for settings that change what the overlay was told. */
function restart() {
    if (!active) {
        update();
        return;
    }

    busy = true;
    deactivate()
        .then(() => activate())
        .catch(err => logger.error("restart failed", err))
        .finally(() => { busy = false; });
}

const onStoreChange = () => update();

/**
 * A created, protected overlay window can still paint nothing, so "is it
 * working" cannot be answered from the renderer alone. This reports which stage
 * the overlay actually reached.
 */
function verdict(status: OverlayStatus): [string, string] {
    if (!settings.store.mirror) return ["#f0b232", "Mirroring is off — content is masked for you too."];
    if (!status.supported) return ["#f0b232", "This platform cannot hide a window from screen capture, so only masking is active."];
    if (localError) return ["#f23f43", `Could not start the mirror: ${localError}`];
    if (status.lastError) return ["#f23f43", `Overlay error: ${status.lastError}`];
    if (!status.created) return ["#f23f43", "The overlay window was never created."];
    if (!status.loaded) return ["#f23f43", "The overlay window exists but its page never loaded."];
    if (!status.bridge) return ["#f23f43", "The overlay loaded but its preload bridge did not attach, so no frames can reach it."];
    if (!status.painted) return ["#f23f43", "The bridge is up but no frames have arrived — check that a DM target is on screen."];
    if (!status.nodes) return ["#f23f43", "Frames are arriving but rendering empty — the mirrored markup is not surviving the copy."];
    if (!status.cssBytes) return ["#f23f43", "Markup is mirroring but no CSS reached the overlay, so it renders unstyled."];
    if (!status.visible) return ["#f0b232", "The overlay is hidden. It only shows while the Discord window is focused."];

    return ["#23a55a", "Mirror is live — you should see your DMs, and capture should not."];
}

function StatusPanel() {
    const [status, setStatus] = React.useState<OverlayStatus | null>(null);

    React.useEffect(() => {
        let alive = true;
        const tick = () => Native.getStatus()
            .then(s => { if (alive) setStatus(s); })
            .catch(() => { /* main process not reachable */ });

        tick();
        const id = setInterval(tick, 1000);
        return () => { alive = false; clearInterval(id); };
    }, []);

    if (!status) return null;

    const [colour, message] = verdict(status);
    const rows: Array<[string, string]> = [
        ["Masking now", active ? "yes" : "no"],
        ["Mirroring", mirroring ? "yes" : "no"],
        ["Overlay created", status.created ? "yes" : "no"],
        ["Page loaded", status.loaded ? "yes" : "no"],
        ["Preload bridge", status.bridge ? "yes" : "no"],
        ["Frames painted", String(status.painted)],
        ["Nodes in last frame", String(status.nodes)],
        ["Overlay visible", status.visible ? "yes" : "no"],
        ["Overlay bounds", status.bounds ?? "—"],
        ["Zoom scale", status.scale ? status.scale.toFixed(3) : "—"],
        ["Stylesheets read", `${(status.cssSheets ?? 0) - (status.cssFailed ?? 0)} / ${status.cssSheets ?? 0}`],
        ["CSS applied", status.cssBytes ? `${Math.round(status.cssBytes / 1024)} KB` : "—"],
        ["Furthest stage", status.stage]
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
        "Hides your DMs from screen capture. The content is drawn in a window that screen recorders cannot see, "
        + "so you can still read it while everyone watching your stream sees a blank panel.",
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

        rescanTimer = window.setInterval(update, RESCAN_INTERVAL_MS);
        update();
    },

    stop() {
        ApplicationStreamingStore?.removeChangeListener?.(onStoreChange);
        MediaEngineStore?.removeChangeListener?.(onStoreChange);

        if (rescanTimer !== undefined) clearInterval(rescanTimer);
        rescanTimer = undefined;

        stopMirrors();
        mirroring = false;
        active = false;
        Native.stop().catch(() => { });
        clearMasks();
    }
});
