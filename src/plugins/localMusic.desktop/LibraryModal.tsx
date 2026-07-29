/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { classes } from "@utils/misc";
import { formatDuration } from "@utils/text";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, TextInput, useMemo, useState } from "@webpack/common";

import { Downloader } from "./Downloader";
import { cl } from "./MiniPlayer";
import { store, usePlayer, usePlayerPosition } from "./PlayerStore";
import type { Track } from "./types";

/** Rendering every row of a 20k track library would lock the UI, so cap it. */
const MAX_ROWS = 300;

function trackLabel(track: Track) {
    const meta = store.metadata[track.path];
    return {
        title: meta?.title || track.fileName,
        subtitle: [meta?.artist, meta?.album].filter(Boolean).join(" — ")
    };
}

function TrackRow({ track, index, isCurrent }: { track: Track; index: number; isCurrent: boolean; }) {
    const { title, subtitle } = trackLabel(track);

    return (
        <div
            className={classes(cl("row"), isCurrent && cl("row-active"))}
            onClick={() => store.load(index)}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") store.load(index);
            }}
        >
            <div className={cl("row-text")}>
                <span className={cl("row-title")}>{title}</span>
                {subtitle && <span className={cl("row-subtitle")}>{subtitle}</span>}
            </div>
            {track.isVideo && <span className={cl("row-badge")}>VIDEO</span>}
        </div>
    );
}

function NowPlaying() {
    const player = usePlayer();
    const position = usePlayerPosition();

    const track = player.currentTrack;
    if (!track) return null;

    const art = player.artUrl(track);

    return (
        <div className={cl("now-playing")}>
            {art
                ? <img className={cl("now-playing-art")} src={art} alt="" />
                : <div className={classes(cl("now-playing-art"), cl("art-placeholder"))} />}

            <div className={cl("now-playing-text")}>
                <Heading tag="h5">{player.displayTitle}</Heading>
                <Span size="sm">{player.displayArtist || track.fileName}</Span>
                <Span size="sm">
                    {formatDuration(position * 1000)} / {player.duration ? formatDuration(player.duration * 1000) : "--:--"}
                </Span>
            </div>
        </div>
    );
}

export function LibraryModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const player = usePlayer();
    const [query, setQuery] = useState("");

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();

        const withIndex = player.tracks.map((track, index) => ({ track, index }));
        if (!needle) return withIndex;

        return withIndex.filter(({ track }) => {
            const meta = player.metadata[track.path];
            return track.fileName.toLowerCase().includes(needle)
                || meta?.title?.toLowerCase().includes(needle)
                || meta?.artist?.toLowerCase().includes(needle)
                || meta?.album?.toLowerCase().includes(needle);
        });
        // metadata streams in during the background scan, so it has to be a dep
    }, [query, player.tracks, player.metadata]);

    const visible = filtered.slice(0, MAX_ROWS);

    return (
        <Modal {...modalProps} title="Music Library" size="lg">
            <div className={cl("modal")}>
                <NowPlaying />

                <div className={cl("folder-row")}>
                    <div className={cl("folder-path")} title={player.folder ?? undefined}>
                        {player.folder ?? "No folder selected"}
                    </div>
                    <Button size="small" onClick={() => player.pickFolder()}>
                        {player.folder ? "Change" : "Choose folder"}
                    </Button>
                    <Button
                        size="small"
                        variant="secondary"
                        disabled={!player.folder || player.isScanning}
                        onClick={() => player.rescan()}
                    >
                        {player.isScanning ? "Scanning…" : "Rescan"}
                    </Button>
                    <Button
                        size="small"
                        variant="secondary"
                        onClick={() => openModal(props => <Downloader modalProps={props} />)}
                    >
                        Download…
                    </Button>
                </div>

                <div className={cl("toggles")}>
                    <FormSwitch
                        hideBorder
                        title="Shuffle"
                        value={player.shuffle}
                        onChange={() => player.toggleShuffle()}
                    />
                    <FormSwitch
                        hideBorder
                        title="Show the player panel"
                        description="The video (or cover art) and its controls, docked above the account panel"
                        value={player.videoDocked}
                        onChange={() => player.toggleVideoDock()}
                    />
                </div>

                <div className={cl("inline-row")}>
                    <Span size="sm">Repeat</Span>
                    <Button size="small" variant="secondary" onClick={() => player.cycleRepeat()}>
                        {player.repeat === "off" ? "Off" : player.repeat === "all" ? "All" : "One"}
                    </Button>

                    <Span size="sm">Volume</Span>
                    <input
                        className={cl("volume")}
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={player.volume}
                        onChange={e => player.setVolume(Number(e.currentTarget.value))}
                    />
                </div>

                <TextInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search your library…"
                />

                <div className={cl("list")}>
                    {!player.tracks.length && (
                        <Span size="sm">
                            {player.isScanning
                                ? "Scanning…"
                                : player.folder
                                    ? "No playable files found in this folder."
                                    : "Choose a folder to get started."}
                        </Span>
                    )}

                    {visible.map(({ track, index }) => (
                        <TrackRow
                            key={track.path}
                            track={track}
                            index={index}
                            isCurrent={index === player.currentIndex}
                        />
                    ))}
                </div>

                {filtered.length > MAX_ROWS && (
                    <Span size="sm">
                        Showing {MAX_ROWS} of {filtered.length} tracks — search to narrow it down.
                    </Span>
                )}
            </div>
        </Modal>
    );
}
