/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { openModal, React, ReactDOM, Tooltip, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { LibraryModal } from "./LibraryModal";
import {
    MAX_VIDEO_HEIGHT, MAX_VIDEO_WIDTH, MIN_VIDEO_HEIGHT, MIN_VIDEO_WIDTH,
    store, usePlayer, usePlayerPosition
} from "./PlayerStore";

export const cl = classNameFactory("vc-lm-");

function Icon({ path, label, size = 20 }: { path: string; label: string; size?: number; }) {
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
const PATHS = {
    play: "M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18c.62-.39.62-1.29 0-1.69L9.54 5.98C8.87 5.55 8 6.03 8 6.82z",
    pause: "M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2zm6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2z",
    previous: "M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1zm3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07c-.57.4-.57 1.24 0 1.64z",
    next: "M7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82zM16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1z",
    popout: "M18 19H6c-.55 0-1-.45-1-1V6c0-.55.45-1 1-1h5c.55 0 1-.45 1-1s-.45-1-1-1H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-6c0-.55-.45-1-1-1s-1 .45-1 1v5c0 .55-.45 1-1 1zM14 4c0 .55.45 1 1 1h2.59l-9.13 9.13c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0L19 6.41V9c0 .55.45 1 1 1s1-.45 1-1V4c0-.55-.45-1-1-1h-5c-.55 0-1 .45-1 1z",
    note: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h3c1.1 0 2-.9 2-2s-.9-2-2-2h-5z",
    fullscreen: "M6 14c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1h3c.55 0 1-.45 1-1s-.45-1-1-1H7v-2c0-.55-.45-1-1-1zm0-4c.55 0 1-.45 1-1V7h2c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1zm11 7h-2c-.55 0-1 .45-1 1s.45 1 1 1h3c.55 0 1-.45 1-1v-3c0-.55-.45-1-1-1s-1 .45-1 1v2zM14 6c0 .55.45 1 1 1h2v2c0 .55.45 1 1 1s1-.45 1-1V6c0-.55-.45-1-1-1h-3c-.55 0-1 .45-1 1z",
    exitFullscreen: "M6 16h2v2c0 .55.45 1 1 1s1-.45 1-1v-3c0-.55-.45-1-1-1H6c-.55 0-1 .45-1 1s.45 1 1 1zm2-8H6c-.55 0-1 .45-1 1s.45 1 1 1h3c.55 0 1-.45 1-1V6c0-.55-.45-1-1-1s-1 .45-1 1v2zm7 11c.55 0 1-.45 1-1v-2h2c.55 0 1-.45 1-1s-.45-1-1-1h-3c-.55 0-1 .45-1 1v3c0 .55.45 1 1 1zm1-11V6c0-.55-.45-1-1-1s-1 .45-1 1v3c0 .55.45 1 1 1h3c.55 0 1-.45 1-1s-.45-1-1-1h-2z"
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

/**
 * The player itself: the shared media element (or the cover art for audio-only
 * files) with the transport controls laid over it.
 *
 * It renders into a portal rather than into the account panel, because a panel that
 * can be dragged wider than the sidebar would otherwise be clipped by it. A spacer
 * stays behind in the sidebar to reserve the height, and the portal is pinned to
 * that spacer's rect.
 */
function MediaPanel() {
    const player = usePlayer();
    const spacerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [anchor, setAnchor] = useState<AnchorRect | null>(null);
    const [isFullscreen, setFullscreen] = useState(false);

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

    function toggleFullscreen() {
        const panel = panelRef.current;
        if (!panel) return;

        if (document.fullscreenElement === panel) document.exitFullscreen();
        else panel.requestFullscreen().catch(() => { });
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
        const spacer = spacerRef.current;
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startHeight = store.videoHeight;
        const startWidth = rect.width;
        // stop it being dragged off the right of the window and out of reach
        const maxWidth = Math.min(MAX_VIDEO_WIDTH, window.innerWidth - rect.left - 8);

        // a purely vertical drag must leave the width alone, including when it is
        // still 0 — the "just fill the sidebar" default
        let width = store.videoWidth;
        let height = startHeight;

        handle.setPointerCapture(e.pointerId);

        // written straight to the elements while dragging — committing to the store on
        // every pointermove would re-render the whole panel 60 times a second
        const move = (ev: PointerEvent) => {
            if (edge !== "e") {
                height = clamp(startHeight + startY - ev.clientY, MIN_VIDEO_HEIGHT, MAX_VIDEO_HEIGHT);
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

    const panel = anchor && (
        <div
            className={cl("video")}
            ref={panelRef}
            style={{
                left: anchor.left,
                bottom: anchor.bottom,
                width: player.videoWidth || anchor.width,
                height: player.videoHeight
            }}
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

            <div className={cl("video-surface")} ref={attachSurface} />

            {/* audio-only files get the cover art in the same frame, so the panel
                never changes shape between a song and a music video */}
            {!player.hasVideo && (
                <div className={cl("video-art")}>
                    {art
                        ? <img src={art} alt="" />
                        : <Icon path={PATHS.note} label="" size={48} />}
                </div>
            )}

            <div className={cl("video-title")}>
                <div className={cl("title")} title={player.displayTitle}>{player.displayTitle}</div>
                {player.displayArtist && (
                    <div className={cl("artist")} title={player.displayArtist}>{player.displayArtist}</div>
                )}
            </div>

            <div className={cl("video-overlay")} onClick={e => e.stopPropagation()}>
                <ControlButton label="Previous" onClick={() => player.previous()}>
                    <Icon path={PATHS.previous} label="previous" size={18} />
                </ControlButton>

                <ControlButton
                    label={player.isPlaying ? "Pause" : "Play"}
                    onClick={() => player.togglePlay()}
                >
                    <Icon path={player.isPlaying ? PATHS.pause : PATHS.play} label="play/pause" size={20} />
                </ControlButton>

                <ControlButton label="Next" onClick={() => player.next()}>
                    <Icon path={PATHS.next} label="next" size={18} />
                </ControlButton>

                <ProgressBar className={cl("video-progress")} />

                <ControlButton
                    label="Open library"
                    onClick={() => openModal(props => <LibraryModal modalProps={props} />)}
                >
                    <Icon path={PATHS.popout} label="library" size={16} />
                </ControlButton>

                <ControlButton
                    label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    onClick={toggleFullscreen}
                >
                    <Icon
                        path={isFullscreen ? PATHS.exitFullscreen : PATHS.fullscreen}
                        label="fullscreen"
                        size={18}
                    />
                </ControlButton>
            </div>
        </div>
    );

    return (
        <>
            <div className={cl("spacer")} ref={spacerRef} style={{ height: player.videoHeight }} />
            {panel && ReactDOM.createPortal(panel, document.body)}
        </>
    );
}

function ProgressBar({ className }: { className?: string; }) {
    const position = usePlayerPosition();
    const { duration } = store;

    const percent = duration > 0 ? (position / duration) * 100 : 0;

    return (
        <div
            className={cl("progress") + (className ? ` ${className}` : "")}
            onClick={e => {
                if (!duration) return;
                const { left, width } = e.currentTarget.getBoundingClientRect();
                store.seek(((e.clientX - left) / width) * duration);
            }}
        >
            <div className={cl("progress-fill")} style={{ width: `${percent}%` }} />
        </div>
    );
}

export function MiniPlayer() {
    const player = usePlayer();

    const hasTrack = player.currentIndex !== -1;

    return (
        <div className={cl("player")}>
            {player.videoDocked && <MediaPanel />}

            {player.error && (
                <div className={cl("error")} onClick={() => player.dismissError()}>
                    {player.error}
                </div>
            )}

            {hasTrack && <ProgressBar />}
        </div>
    );
}
