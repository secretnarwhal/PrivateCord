/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { formatDuration } from "@utils/text";
import { React, ReactDOM, Tooltip, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { openLibrary } from "./LibraryModal";
import {
    type FloatAnchor,
    MAX_VIDEO_HEIGHT, MAX_VIDEO_WIDTH, MIN_VIDEO_HEIGHT, MIN_VIDEO_WIDTH,
    store, usePlayer, usePlayerPosition
} from "./PlayerStore";
import { settings } from "./settings";

export const cl = classNameFactory("vc-lm-");

export function Icon({ path, label, size = 20 }: { path: string; label: string; size?: number; }) {
    return (
        <svg
            className={cl("icon")}
            height={size}
            width={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label={label}
            focusable={false}
        >
            <path d={path} />
        </svg>
    );
}

// Material Symbols (rounded), matching the set SpotifyControls already uses
export const PATHS = {
    play: "M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z",
    pause: "M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z",
    previous: "M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1zm3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.57.4-.57 1.24 0 1.64z",
    next: "M7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82zM16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1z",
    shuffle: "M10.59 9.17L6.12 4.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l4.46 4.46 1.42-1.4zm4.76-4.32l1.19 1.19L4.7 17.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L17.96 7.46l1.19 1.19c.31.31.85.09.85-.36V4.5c0-.28-.22-.5-.5-.5h-3.79c-.45 0-.67.54-.36.85zm-.52 8.56l-1.41 1.41 3.13 3.13-1.2 1.2c-.31.31-.09.85.36.85h3.79c.28 0 .5-.22.5-.5v-3.79c0-.45-.54-.67-.85-.35l-1.19 1.19-3.13-3.14z",
    repeat: "M7 7h10v1.79c0 .45.54.67.85.35l2.79-2.79c.2-.2.2-.51 0-.71l-2.79-2.79c-.31-.31-.85-.09-.85.36V5H6c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1s1-.45 1-1V7zm10 10H7v-1.79c0-.45-.54-.67-.85-.35l-2.79 2.79c-.2.2-.2.51 0 .71l2.79 2.79c.31.31.85.09.85-.36V19h11c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1s-1 .45-1 1v3z",
    video: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l2.29 2.29c.63.63 1.71.18 1.71-.71V8.91c0-.89-1.08-1.34-1.71-.71L17 10.5z",
    videoOff: "M3.27 2 2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2zM21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5z",
    // a stacked "library card" with a music note — reads as "music library"
    library: "M8 18c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H8zm6.5-3c1.38 0 2.5-1.12 2.5-2.5V8h1.5c.55 0 1-.45 1-1s-.45-1-1-1H17c-.55 0-1 .45-1 1v3.51c-.42-.32-.93-.51-1.5-.51-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5zM4 22c-1.1 0-2-.9-2-2V7c0-.55.45-1 1-1s1 .45 1 1v13h13c.55 0 1 .45 1 1s-.45 1-1 1H4z",
    note: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h3c1.1 0 2-.9 2-2s-.9-2-2-2h-5z",
    fullscreen: "M6 14c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1h3c.55 0 1-.45 1-1s-.45-1-1-1H7v-2c0-.55-.45-1-1-1zm0-4c.55 0 1-.45 1-1V7h2c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1zm11 7h-2c-.55 0-1 .45-1 1s.45 1 1 1h3c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1s-1 .45-1 1v2zM14 6c0 .55.45 1 1 1h2v2c0 .55.45 1 1 1s1-.45 1-1V6c0-.55-.45-1-1-1h-3c-.55 0-1 .45-1 1z",
    exitFullscreen: "M6 16h2v2c0 .55.45 1 1 1s1-.45 1-1v-3c0-.55-.45-1-1-1H6c-.55 0-1 .45-1 1s.45 1 1 1zm2-8H6c-.55 0-1 .45-1 1s.45 1 1 1h3c.55 0 1-.45 1-1V6c0-.55-.45-1-1-1s-1 .45-1 1v2zm7 11c.55 0 1-.45 1-1v-2h2c.55 0 1-.45 1-1s-.45-1-1-1h-3c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1zm1-11V6c0-.55-.45-1-1-1s-1 .45-1 1v3c0 .55.45 1 1 1h3c.55 0 1-.45 1-1s-.45-1-1-1h-2z",
    // an arrow leaving its frame ("open_in_new"): lift the panel out of the sidebar
    popOut: "M19 19H5V5h7c.55 0 1-.45 1-1s-.45-1-1-1H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7c0-.55-.45-1-1-1s-1 .45-1 1v7zM15 4c0 .55.45 1 1 1h1.59l-9.13 9.13c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L19 6.41V8c0 .55.45 1 1 1s1-.45 1-1V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1z",
    // the same arrow folded back in ("close_fullscreen"): drop it back into the dock
    dock: "M21.29 4.12 17.71 7.7l1.94 1.94c.31.32.09.86-.36.86H15c-.55 0-1-.45-1-1V5.29c0-.45.54-.67.85-.36l1.65 1.65 3.58-3.58c.39-.39 1.02-.39 1.41 0 .19.2.29.45.29.71 0 .25-.1.51-.29.71zM4.12 21.29l3.58-3.58 1.65 1.64c.31.32.85.1.85-.35V15c0-.55-.45-1-1-1H4.71c-.45 0-.67.54-.35.85L6.3 16.5l-3.58 3.58c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.4 0z",
    volumeHigh: "M3 10v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71V6.41c0-.89-1.08-1.34-1.71-.71L7 9H4c-.55 0-1 .45-1 1zm13.5 2c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 4.45v.2c0 .38.25.71.6.85C17.18 6.53 19 9.06 19 12s-1.82 5.47-4.4 6.5c-.36.14-.6.47-.6.85v.2c0 .63.63 1.07 1.21.85C18.6 19.11 21 15.84 21 12s-2.4-7.11-5.79-8.4c-.58-.23-1.21.22-1.21.85z",
    volumeLow: "M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 10v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71V6.41c0-.89-1.08-1.34-1.71-.71L9 9H6c-.55 0-1 .45-1 1z",
    volumeMuted: "M3.63 3.63c-.39.39-.39 1.02 0 1.41L7.29 8.7 7 9H4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91-.36.15-.58.53-.58.92 0 .72.73 1.18 1.39.91.8-.33 1.55-.77 2.22-1.31l1.34 1.34c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L5.05 3.63c-.39-.39-1.02-.39-1.42 0zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-3.83-2.4-7.11-5.78-8.4-.59-.23-1.22.23-1.22.86v.19c0 .38.25.71.61.85C17.18 6.54 19 9.06 19 12zm-8.71-6.29l-.17.17L12 7.76V6.41c0-.89-1.08-1.34-1.71-.7zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v1.79l2.48 2.48c.01-.08.02-.16.02-.24z",
    // "playlist_play": a stack with the arrow at its head — cut in at the front
    playNext: "M3 6h11c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1zm0 4h11c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1zm0 4h7c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1zm14.5-11.13v6.26c0 .39.44.63.77.42l4.96-3.13c.31-.19.31-.65 0-.85l-4.96-3.13c-.33-.2-.77.03-.77.43z",
    // "playlist_add": the same stack, joined at the bottom by a plus
    queueAdd: "M3 6h11c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1zm0 4h11c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1zm0 4h7c.55 0 1-.45 1-1s-.45-1-1-1H3c-.55 0-1 .45-1 1s.45 1 1 1zm15-1v-3c0-.55-.45-1-1-1s-1 .45-1 1v3h-3c-.55 0-1 .45-1 1s.45 1 1 1h3v3c0 .55.45 1 1 1s1-.45 1-1v-3h3c.55 0 1-.45 1-1s-.45-1-1-1h-3z",
    // "queue_music": what the queue button in the panel opens
    queue: "M4 10h9c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zm0-4h9c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zm0 8h5c.55 0 1-.45 1-1s-.45-1-1-1H4c-.55 0-1 .45-1 1s.45 1 1 1zm12-9v7.55c-.42-.34-.94-.55-1.5-.55-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5 2.5-1.12 2.5-2.5V7h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1V5z",
    // "drag_indicator": the six-dot grip on a reorderable row
    drag: "M9 20c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm6 0c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z",
    close: "M18.3 5.71c-.39-.39-1.02-.39-1.41 0L12 10.59 7.11 5.7c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41L10.59 12 5.7 16.89c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L12 13.41l4.89 4.89c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L13.41 12l4.89-4.89c.38-.38.38-1.02 0-1.4z"
} as const;

export function ControlButton({ label, onClick, children, className }: {
    label: string;
    onClick: (e: React.MouseEvent) => void;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <Tooltip text={label}>
            {tooltipProps => (
                <button
                    {...tooltipProps}
                    className={cl("button") + (className ? ` ${className}` : "")}
                    onClick={onClick}
                    aria-label={label}
                >
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

/**
 * YouTube-style volume: a speaker icon that mutes on click, with a vertical slider
 * that pops up over it on hover (or while dragging, which can wander off-hover).
 * The slider is hand-rolled with pointer capture, same as the resize handles —
 * range inputs can't be dragged vertically without engine-specific hacks.
 */
function VolumeControl() {
    const player = usePlayer();
    const trackRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);

    const icon = player.volume === 0
        ? PATHS.volumeMuted
        : player.volume < 0.5 ? PATHS.volumeLow : PATHS.volumeHigh;

    function setFromPointer(clientY: number) {
        const track = trackRef.current;
        if (!track) return;

        const { top, height } = track.getBoundingClientRect();
        // setVolume clamps, so pointers in the popup's padding land on 0 or 1
        store.setVolume(1 - (clientY - top) / height);
    }

    return (
        <div
            className={classes(cl("volume"), dragging && cl("volume-dragging"))}
            onWheel={e => store.setVolume(store.volume + (e.deltaY < 0 ? 0.05 : -0.05))}
        >
            <div className={cl("volume-popup")}>
                <div
                    className={cl("volume-slider")}
                    onPointerDown={e => {
                        e.preventDefault();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDragging(true);
                        setFromPointer(e.clientY);
                    }}
                    onPointerMove={e => dragging && setFromPointer(e.clientY)}
                    onPointerUp={() => setDragging(false)}
                    onPointerCancel={() => setDragging(false)}
                >
                    <div
                        ref={trackRef}
                        className={cl("volume-track")}
                        role="slider"
                        aria-label="Volume"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(player.volume * 100)}
                    >
                        <div className={cl("volume-fill")} style={{ height: `${player.volume * 100}%` }} />
                    </div>
                </div>
            </div>

            <ControlButton
                label={player.volume === 0 ? "Unmute" : "Mute"}
                onClick={() => player.toggleMute()}
            >
                <Icon path={icon} label="volume" size={18} />
            </ControlButton>
        </div>
    );
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;

    return [h / 6, s, l];
}

/**
 * Samples the cover art for an accent colour: a weighted average that favours
 * saturated pixels which aren't near-black or blown out, then pulled into a
 * brightness range that stays readable on the dark panel. Returns null (keep
 * the brand fallback) for missing or effectively grayscale art.
 */
export function useArtAccent(art: string | null) {
    const [accent, setAccent] = useState<string | null>(null);

    useEffect(() => {
        setAccent(null);
        if (!art) return;

        let cancelled = false;
        const img = new Image();
        // the local media server sends Access-Control-Allow-Origin: *,
        // so sampling the image doesn't taint the canvas
        img.crossOrigin = "anonymous";
        img.onload = () => {
            if (cancelled) return;
            try {
                const size = 27;
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = size;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;

                ctx.drawImage(img, 0, 0, size, size);
                const { data } = ctx.getImageData(0, 0, size, size);

                let r = 0, g = 0, b = 0, total = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const pr = data[i], pg = data[i + 1], pb = data[i + 2];
                    const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
                    const sat = max ? (max - min) / max : 0;
                    const weight = sat * sat * (max / 255) * (1 - Math.max(0, (min - 200) / 55));

                    r += pr * weight; g += pg * weight; b += pb * weight;
                    total += weight;
                }
                if (total < 1) return;

                let [h, s, l] = rgbToHsl(r / total, g / total, b / total);
                s = Math.min(1, Math.max(s, 0.55));
                l = Math.min(0.62, Math.max(l, 0.5));

                setAccent(`hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`);
            } catch { /* tainted or decode failure: keep the fallback */ }
        };
        img.src = art;

        return () => { cancelled = true; };
    }, [art]);

    return accent;
}

/** How many bars the spectrum is squeezed into. */
const BAR_COUNT = 56;

/**
 * The classic spectrum graph: frequency bars mirrored around the vertical centre,
 * sampled on a log scale so the bass doesn't hog the whole width. Levels get a
 * fast attack and a slow decay, so bars snap up and fall gently — and settle into
 * a flat dotted line when playback stops (or when the analyser isn't available).
 */
function Visualizer({ accent }: { accent: string | null; }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;

        const analyser = store.getAnalyser();
        const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
        const levels = new Float32Array(BAR_COUNT);

        let raf = 0;
        let gradient: CanvasGradient | null = null;

        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
            gradient = null; // sized to the canvas, so it has to follow it
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);

        // skip the DC end and the (usually empty) top octave of the FFT
        const minBin = 2;
        const maxBin = bins ? Math.floor(bins.length * 0.7) : 0;

        const draw = () => {
            raf = requestAnimationFrame(draw);

            const { width: w, height: h } = canvas;
            ctx.clearRect(0, 0, w, h);

            if (!gradient) {
                const color = accent
                    || getComputedStyle(canvas).getPropertyValue("--vc-lm-accent").trim()
                    || "#5865f2";
                gradient = ctx.createLinearGradient(0, h, 0, 0);
                gradient.addColorStop(0, color);
                gradient.addColorStop(0.5, "#ffffff");
                gradient.addColorStop(1, color);
            }

            if (analyser && bins) analyser.getByteFrequencyData(bins);

            const gap = w / BAR_COUNT;
            const barW = Math.max(1, gap * 0.55);
            const mid = h / 2;
            const usable = h * 0.86;

            ctx.fillStyle = gradient;

            for (let i = 0; i < BAR_COUNT; i++) {
                let target = 0;
                if (bins) {
                    const lo = Math.floor(minBin * Math.pow(maxBin / minBin, i / BAR_COUNT));
                    const hi = Math.max(lo + 1, Math.floor(minBin * Math.pow(maxBin / minBin, (i + 1) / BAR_COUNT)));

                    let sum = 0;
                    for (let b = lo; b < hi; b++) sum += bins[b];
                    target = sum / (hi - lo) / 255;
                }

                levels[i] += (target - levels[i]) * (target > levels[i] ? 0.55 : 0.16);

                const barH = Math.max(2, Math.pow(levels[i], 1.3) * usable);
                const x = i * gap + (gap - barW) / 2;

                ctx.beginPath();
                ctx.roundRect(x, mid - barH / 2, barW, barH, barW / 2);
                ctx.fill();
            }
        };
        draw();

        return () => {
            cancelAnimationFrame(raf);
            observer.disconnect();
        };
    }, [accent]);

    return <canvas className={cl("visualizer")} ref={canvasRef} aria-hidden />;
}

/** Small "1:23 / 4:56" readout; separate so 4Hz position ticks stay contained. */
function TimeLabel() {
    const position = usePlayerPosition();
    const { duration } = store;

    if (!duration) return null;

    return (
        <span className={cl("time")}>
            {formatDuration(position * 1000)} / {formatDuration(duration * 1000)}
        </span>
    );
}

/** Which edges a handle drags. "n" is vertical only, "e" horizontal only, "ne" both. */
type ResizeEdge = "n" | "e" | "ne";

const HANDLES: ResizeEdge[] = ["n", "e", "ne"];

function clamp(value: number, min: number, max: number) {
    return Math.round(Math.max(min, Math.min(max, value)));
}

interface AnchorRect {
    left: number;
    /** distance from the bottom of the window, since the panel grows upwards */
    bottom: number;
    width: number;
}

/** Keeps a floating panel of this size wholly inside the Discord window. */
function clampFloat(anchor: FloatAnchor, width: number, height: number): FloatAnchor {
    return {
        left: clamp(anchor.left, 0, Math.max(0, window.innerWidth - width)),
        bottom: clamp(anchor.bottom, 0, Math.max(0, window.innerHeight - height))
    };
}

/**
 * The player itself. Video files show their picture (unless showVideo is off);
 * everything else gets the visualizer over the blurred cover art, with the track
 * strip along the top and the transport along the bottom.
 *
 * It renders into a portal rather than into the account panel, because a panel that
 * can be dragged wider than the sidebar would otherwise be clipped by it. A spacer
 * stays behind in the sidebar to reserve the height, and the portal is pinned to
 * that spacer's rect.
 *
 * Popped out, the only thing that changes is what it is pinned to: a free anchor in
 * the window that the track strip drags around, with the spacer collapsed so the
 * sidebar gets its space back. It is still the same portal inside the same window,
 * so it stays put relative to the client and clips at its edges.
 */
function MediaPanel() {
    const player = usePlayer();
    const { showVideo } = settings.use(["showVideo"]);
    const spacerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [anchor, setAnchor] = useState<AnchorRect | null>(null);
    const [isFullscreen, setFullscreen] = useState(false);
    const { floating } = player;

    // a callback ref rather than an effect, because the surface only exists once the
    // portal has somewhere to go — which is a render later than this component mounts
    const attachSurface = useCallback((surface: HTMLDivElement | null) => {
        const element = store.getMediaElement();

        // the surface is never given React children, so moving the element in and out
        // of it can't confuse reconciliation
        if (surface) {
            surface.appendChild(element);
            element.classList.add("vc-lm-video-visible");
            return;
        }

        element.classList.remove("vc-lm-video-visible");
        // hand it back to the offscreen host rather than destroying it,
        // so audio keeps playing when the panel unmounts
        document.querySelector(".vc-lm-media-host")?.appendChild(element);
    }, []);

    useEffect(() => {
        const spacer = spacerRef.current;
        if (!spacer) return;

        let last = "";
        const update = () => {
            const rect = spacer.getBoundingClientRect();
            const next: AnchorRect = {
                left: Math.round(rect.left),
                bottom: Math.round(window.innerHeight - rect.bottom),
                width: Math.round(rect.width)
            };

            const key = `${next.left}:${next.bottom}:${next.width}`;
            if (key === last) return;
            last = key;
            setAnchor(next);
        };

        update();
        const observer = new ResizeObserver(update);
        observer.observe(spacer);
        window.addEventListener("resize", update);
        // collapsing the server list or opening a voice panel moves us without ever
        // resizing the spacer, so a slow poll keeps the two glued together cheaply
        const interval = window.setInterval(update, 400);

        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
            window.clearInterval(interval);
        };
    }, []);

    useEffect(() => {
        const onChange = () => setFullscreen(document.fullscreenElement === panelRef.current);
        document.addEventListener("fullscreenchange", onChange);

        return () => {
            document.removeEventListener("fullscreenchange", onChange);
            if (clickTimer.current) clearTimeout(clickTimer.current);
        };
    }, []);

    // shrinking the window can leave a floating panel hanging off the edge, so pull
    // it back in — and persist that, since it can't be dragged back from out there
    useEffect(() => {
        if (!floating) return;

        const onResize = () => {
            const rect = panelRef.current?.getBoundingClientRect();
            if (!rect) return;

            const anchor = clampFloat(
                { left: Math.round(rect.left), bottom: Math.round(window.innerHeight - rect.bottom) },
                rect.width,
                rect.height
            );

            // resizing the window fires this continuously, so only write when the panel
            // was actually hanging off an edge — every commit is a DataStore write
            const current = store.floatAnchor;
            if (current && current.left === anchor.left && current.bottom === anchor.bottom) return;

            store.setFloatAnchor(anchor);
        };

        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [floating]);

    function toggleFullscreen() {
        const panel = panelRef.current;
        if (!panel) return;

        if (document.fullscreenElement === panel) document.exitFullscreen();
        else panel.requestFullscreen().catch(() => { });
    }

    /** Pops out from wherever the panel currently is, so it doesn't jump on the way. */
    function toggleFloating() {
        if (store.floating) {
            store.setFloating(false);
            return;
        }

        const rect = panelRef.current?.getBoundingClientRect();
        store.setFloating(true, rect && {
            left: Math.round(rect.left),
            bottom: Math.round(window.innerHeight - rect.bottom)
        });
    }

    /**
     * Floating only: the track strip doubles as a title bar. Like the resize handles,
     * the move is written straight to the element and only committed to the store on
     * release, so dragging doesn't re-render the panel on every frame.
     */
    function startDrag(e: React.PointerEvent<HTMLDivElement>) {
        const panel = panelRef.current;
        if (!panel) return;

        e.preventDefault();

        const strip = e.currentTarget;
        const rect = panel.getBoundingClientRect();
        // where in the panel it was grabbed, so it tracks the pointer exactly
        const grabX = e.clientX - rect.left;
        const grabBottom = e.clientY - rect.bottom;

        // rounded up front: a press that never moved still commits this on release
        let next: FloatAnchor = {
            left: Math.round(rect.left),
            bottom: Math.round(window.innerHeight - rect.bottom)
        };

        strip.setPointerCapture(e.pointerId);
        panel.classList.add("vc-lm-video-dragging");

        const move = (ev: PointerEvent) => {
            next = clampFloat({
                left: Math.round(ev.clientX - grabX),
                bottom: Math.round(window.innerHeight - (ev.clientY - grabBottom))
            }, rect.width, rect.height);

            panel.style.left = `${next.left}px`;
            panel.style.bottom = `${next.bottom}px`;
        };

        const stop = () => {
            strip.removeEventListener("pointermove", move);
            strip.removeEventListener("pointerup", stop);
            strip.removeEventListener("pointercancel", stop);
            panel.classList.remove("vc-lm-video-dragging");
            store.setFloatAnchor(next);
        };

        strip.addEventListener("pointermove", move);
        strip.addEventListener("pointerup", stop);
        strip.addEventListener("pointercancel", stop);
    }

    /**
     * The panel is anchored to the account panel below it and to the sidebar's left
     * edge, so dragging up makes it taller and dragging right makes it wider — out
     * over the chat, past the sidebar it lives in.
     */
    function startResize(e: React.PointerEvent<HTMLDivElement>, edge: ResizeEdge) {
        e.preventDefault();
        e.stopPropagation();

        const handle = e.currentTarget;
        const panel = panelRef.current;
        // a popped-out panel reserves no sidebar space, so its spacer stays collapsed
        const spacer = store.floating ? null : spacerRef.current;
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startHeight = store.videoHeight;
        const startWidth = rect.width;
        // stop it being dragged out of the window and out of reach. The panel is pinned
        // by its bottom edge, so the room it has to grow upwards is that edge's offset.
        const maxWidth = Math.min(MAX_VIDEO_WIDTH, window.innerWidth - rect.left - 8);
        const maxHeight = Math.max(MIN_VIDEO_HEIGHT, Math.min(MAX_VIDEO_HEIGHT, rect.bottom - 8));

        // a purely vertical drag must leave the width alone, including when it is
        // still 0 — the "just fill the sidebar" default
        let width = store.videoWidth;
        let height = startHeight;

        handle.setPointerCapture(e.pointerId);

        // written straight to the elements while dragging — committing to the store on
        // every pointermove would re-render the whole panel 60 times a second
        const move = (ev: PointerEvent) => {
            if (edge !== "e") {
                height = clamp(startHeight + startY - ev.clientY, MIN_VIDEO_HEIGHT, maxHeight);
                panel.style.height = `${height}px`;
                if (spacer) spacer.style.height = `${height}px`;
            }

            if (edge !== "n") {
                width = clamp(startWidth + ev.clientX - startX, MIN_VIDEO_WIDTH, maxWidth);
                panel.style.width = `${width}px`;
            }
        };

        const stop = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", stop);
            handle.removeEventListener("pointercancel", stop);
            // leave the final height on the spacer rather than clearing it: a drag that
            // ended back where it started is a no-op to React, so nothing would restore it
            if (spacer) spacer.style.height = `${height}px`;
            store.setVideoSize(width, height);
        };

        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
    }

    // click plays/pauses and double click goes fullscreen, so the first click has to
    // wait long enough to find out which one it was
    function onClick() {
        if (clickTimer.current) return;

        clickTimer.current = setTimeout(() => {
            clickTimer.current = null;
            store.togglePlay();
        }, 200);
    }

    function onDoubleClick() {
        if (clickTimer.current) clearTimeout(clickTimer.current);
        clickTimer.current = null;
        toggleFullscreen();
    }

    const track = player.currentTrack;
    const art = track && player.artUrl(track);
    const accent = useArtAccent(art || null);
    const showingVideo = player.hasVideo && showVideo;
    const queued = player.queueEntries.length;

    const width = anchor ? player.videoWidth || anchor.width : 0;
    // falling back to the docked anchor covers a floating panel that was restored
    // from prefs before it had ever been dragged
    const position = anchor && (floating
        ? clampFloat(player.floatAnchor ?? anchor, width, player.videoHeight)
        : anchor);

    const panel = position && (
        <div
            className={classes(
                cl("video"),
                !showingVideo && cl("mode-viz"),
                floating && cl("video-floating")
            )}
            ref={panelRef}
            style={{
                left: position.left,
                bottom: position.bottom,
                width,
                height: player.videoHeight,
                // the panel-wide accent: fills, badges, glows and the visualizer
                ...(accent && { "--vc-lm-accent": accent })
            } as React.CSSProperties}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
        >
            {!isFullscreen && HANDLES.map(edge => (
                <div
                    key={edge}
                    className={classes(cl("video-resize"), cl(`video-resize-${edge}`))}
                    onPointerDown={e => startResize(e, edge)}
                    onClick={e => e.stopPropagation()}
                    // a horizontal handle snaps back to "fill the sidebar" on double click
                    onDoubleClick={e => {
                        e.stopPropagation();
                        if (edge !== "n") store.setVideoSize(0, store.videoHeight);
                    }}
                />
            ))}

            {showingVideo
                ? <div className={cl("video-surface")} ref={attachSurface} />
                : (
                    <>
                        {art && <div className={cl("backdrop")} style={{ backgroundImage: `url(${art})` }} />}
                        <Visualizer accent={accent} />
                    </>
                )}

            <div
                className={classes(cl("meta"), floating && cl("meta-drag"))}
                onPointerDown={floating ? startDrag : undefined}
                // a drag ends on the strip, so without this the panel behind it would
                // read the release as a click and play/pause
                onClick={floating ? (e => e.stopPropagation()) : undefined}
                onDoubleClick={floating ? (e => e.stopPropagation()) : undefined}
            >
                {!showingVideo && (art
                    ? <img className={cl("meta-art")} src={art} alt="" />
                    : (
                        <div className={classes(cl("meta-art"), cl("meta-art-placeholder"))}>
                            <Icon path={PATHS.note} label="" size={18} />
                        </div>
                    ))}

                <div className={cl("meta-text")}>
                    <div className={cl("title")} title={player.displayTitle}>{player.displayTitle}</div>
                    {player.displayArtist && (
                        <div className={cl("artist")} title={player.displayArtist}>{player.displayArtist}</div>
                    )}
                </div>

                <div
                    className={cl("meta-actions")}
                    onClick={e => e.stopPropagation()}
                    // the strip around them is a drag handle while floating
                    onPointerDown={e => e.stopPropagation()}
                >
                    {player.hasVideo && (
                        <ControlButton
                            label={showVideo ? "Hide the video" : "Show the video"}
                            onClick={() => settings.store.showVideo = !settings.store.showVideo}
                        >
                            <Icon path={showVideo ? PATHS.videoOff : PATHS.video} label="toggle video" size={16} />
                        </ControlButton>
                    )}

                    <ControlButton
                        label={queued ? `Up next (${queued})` : "Up next"}
                        onClick={() => openLibrary("queue")}
                    >
                        <Icon path={PATHS.queue} label="queue" size={16} />
                        {queued > 0 && (
                            <span className={cl("count-badge")}>{queued > 9 ? "9+" : queued}</span>
                        )}
                    </ControlButton>

                    <ControlButton
                        label="Open library"
                        onClick={() => openLibrary()}
                    >
                        <Icon path={PATHS.library} label="library" size={16} />
                    </ControlButton>

                    <ControlButton
                        label={floating ? "Dock the player" : "Pop out the player"}
                        onClick={toggleFloating}
                    >
                        <Icon
                            path={floating ? PATHS.dock : PATHS.popOut}
                            label="pop out"
                            size={15}
                        />
                    </ControlButton>

                    <ControlButton
                        label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                        onClick={toggleFullscreen}
                    >
                        <Icon
                            path={isFullscreen ? PATHS.exitFullscreen : PATHS.fullscreen}
                            label="fullscreen"
                            size={16}
                        />
                    </ControlButton>
                </div>
            </div>

            <div className={cl("video-overlay")} onClick={e => e.stopPropagation()}>
                <ProgressBar className={cl("video-progress")} />

                <div className={cl("controls-row")}>
                    <ControlButton
                        label="Shuffle"
                        className={player.shuffle ? cl("button-active") : undefined}
                        onClick={() => player.toggleShuffle()}
                    >
                        <Icon path={PATHS.shuffle} label="shuffle" size={15} />
                    </ControlButton>

                    <ControlButton label="Previous" onClick={() => player.previous()}>
                        <Icon path={PATHS.previous} label="previous" size={18} />
                    </ControlButton>

                    <ControlButton
                        label={player.isPlaying ? "Pause" : "Play"}
                        className={cl("play-button")}
                        onClick={() => player.togglePlay()}
                    >
                        <Icon path={player.isPlaying ? PATHS.pause : PATHS.play} label="play/pause" size={18} />
                    </ControlButton>

                    <ControlButton label="Next" onClick={() => player.next()}>
                        <Icon path={PATHS.next} label="next" size={18} />
                    </ControlButton>

                    <ControlButton
                        label={`Repeat: ${player.repeat === "off" ? "off" : player.repeat === "all" ? "all" : "one"}`}
                        className={player.repeat !== "off" ? cl("button-active") : undefined}
                        onClick={() => player.cycleRepeat()}
                    >
                        <Icon path={PATHS.repeat} label="repeat" size={15} />
                        {player.repeat === "one" && <span className={cl("repeat-badge")}>1</span>}
                    </ControlButton>

                    <TimeLabel />

                    <VolumeControl />
                </div>
            </div>
        </div>
    );

    return (
        <>
            {/* collapsed rather than removed while floating: it is still what the panel
                measures its left edge and its docked position from */}
            <div className={cl("spacer")} ref={spacerRef} style={{ height: floating ? 0 : player.videoHeight }} />
            {panel && ReactDOM.createPortal(panel, document.body)}
        </>
    );
}

function ProgressBar({ className }: { className?: string; }) {
    const position = usePlayerPosition();
    const { duration } = store;
    const [scrubbing, setScrubbing] = useState(false);

    const percent = duration > 0 ? (position / duration) * 100 : 0;

    function seekFromPointer(e: React.PointerEvent<HTMLDivElement>) {
        if (!store.duration) return;
        const { left, width } = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - left) / width));
        store.seek(ratio * store.duration);
    }

    return (
        <div
            className={classes(cl("progress"), scrubbing && cl("progress-scrubbing"), className)}
            onPointerDown={e => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setScrubbing(true);
                seekFromPointer(e);
            }}
            onPointerMove={e => scrubbing && seekFromPointer(e)}
            onPointerUp={() => setScrubbing(false)}
            onPointerCancel={() => setScrubbing(false)}
        >
            <div className={cl("progress-track")}>
                <div className={cl("progress-fill")} style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

export function MiniPlayer() {
    const player = usePlayer();

    return (
        <div className={classes(cl("player"), player.floating && cl("player-floating"))}>
            <MediaPanel />

            {player.error && (
                <div className={cl("error")} onClick={() => player.dismissError()}>
                    {player.error}
                </div>
            )}
        </div>
    );
}
