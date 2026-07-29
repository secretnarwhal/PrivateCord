/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { openModal, React, Tooltip, useEffect, useRef } from "@webpack/common";

import { LibraryModal } from "./LibraryModal";
import { store, usePlayer, usePlayerPosition } from "./PlayerStore";

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
    note: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h3c1.1 0 2-.9 2-2s-.9-2-2-2h-5z"
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

/** Adopts the shared media element so video renders above the player. */
function VideoDock() {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = ref.current;
        if (!host) return;

        const element = store.getMediaElement();
        host.appendChild(element);
        element.classList.add("vc-lm-video-visible");

        return () => {
            element.classList.remove("vc-lm-video-visible");
            // hand it back to the offscreen host rather than destroying it,
            // so audio keeps playing when the dock unmounts
            document.querySelector(".vc-lm-media-host")?.appendChild(element);
        };
    }, []);

    return <div className={cl("video")} ref={ref} />;
}

function ProgressBar() {
    const position = usePlayerPosition();
    const { duration } = store;

    const percent = duration > 0 ? (position / duration) * 100 : 0;

    return (
        <div
            className={cl("progress")}
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

function AlbumArt() {
    const player = usePlayer();
    const track = player.currentTrack;
    const art = track && player.artUrl(track);

    if (art) return <img className={cl("art")} src={art} alt="" />;

    return (
        <div className={cl("art", "art-placeholder")}>
            <Icon path={PATHS.note} label="" size={16} />
        </div>
    );
}

export function MiniPlayer() {
    const player = usePlayer();

    const hasTrack = player.currentIndex !== -1;
    const showVideo = player.videoDocked && player.hasVideo;

    return (
        <div className={cl("player")}>
            {showVideo && <VideoDock />}

            {player.error && (
                <div className={cl("error")} onClick={() => player.dismissError()}>
                    {player.error}
                </div>
            )}

            <div className={cl("bar")}>
                <AlbumArt />

                <div className={cl("info")}>
                    <div className={cl("title")} title={player.displayTitle}>{player.displayTitle}</div>
                    {player.displayArtist && (
                        <div className={cl("artist")} title={player.displayArtist}>{player.displayArtist}</div>
                    )}
                </div>

                <div className={cl("controls")}>
                    <ControlButton label="Previous" onClick={() => player.previous()}>
                        <Icon path={PATHS.previous} label="previous" />
                    </ControlButton>

                    <ControlButton
                        label={player.isPlaying ? "Pause" : "Play"}
                        onClick={() => player.togglePlay()}
                    >
                        <Icon path={player.isPlaying ? PATHS.pause : PATHS.play} label="play/pause" size={22} />
                    </ControlButton>

                    <ControlButton label="Next" onClick={() => player.next()}>
                        <Icon path={PATHS.next} label="next" />
                    </ControlButton>

                    <ControlButton
                        label="Open library"
                        onClick={() => openModal(props => <LibraryModal modalProps={props} />)}
                    >
                        <Icon path={PATHS.popout} label="library" size={16} />
                    </ControlButton>
                </div>
            </div>

            {hasTrack && <ProgressBar />}
        </div>
    );
}
