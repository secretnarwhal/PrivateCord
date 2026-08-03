/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { classes } from "@utils/misc";
import { formatDuration } from "@utils/text";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, TextInput, useMemo, useState } from "@webpack/common";

import { Downloader } from "./Downloader";
import { FolderBrowser } from "./FolderBrowser";
import { cl, ControlButton, Icon, PATHS, useArtAccent } from "./MiniPlayer";
import { store, usePlayer, usePlayerPosition } from "./PlayerStore";
import { useSession } from "./session/SessionStore";
import { SessionLibraryList, SessionPanel, SessionQueueList } from "./session/SessionUI";
import type { QueueItem, Track } from "./types";

/** Rendering every row of a 20k track library would lock the UI, so cap it. */
const MAX_ROWS = 300;

export type LibraryTab = "library" | "queue" | "session";

/** Opens the library, optionally straight onto the queue. */
export function openLibrary(tab: LibraryTab = "library") {
    openModal(props => <LibraryModal modalProps={props} initialTab={tab} />);
}

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

            {/* the row itself plays the track, so the actions must not bubble into it */}
            <div className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                <ControlButton
                    label="Play next"
                    className={cl("row-action")}
                    onClick={() => store.playNext(index)}
                >
                    <Icon path={PATHS.playNext} label="play next" size={16} />
                </ControlButton>

                <ControlButton
                    label="Add to queue"
                    className={cl("row-action")}
                    onClick={() => store.addToQueue(index)}
                >
                    <Icon path={PATHS.queueAdd} label="add to queue" size={16} />
                </ControlButton>
            </div>
        </div>
    );
}

/**
 * Where a dragged row would land: the id it would sit in front of, or null for the
 * end of the queue — the same shape moveInQueue takes, so the line the user sees is
 * literally the move that gets committed.
 */
type DropTarget = { beforeId: string | null; };

function QueueRow({ entry, position, nextId, drag }: {
    entry: { item: QueueItem; track: Track; };
    position: number;
    /** the row below this one, which is what "drop below me" lands in front of */
    nextId: string | null;
    drag: {
        draggingId: string | null;
        target: DropTarget | null;
        onStart: (id: string) => void;
        onOver: (e: React.DragEvent, beforeId: string | null) => void;
        onEnd: () => void;
    };
}) {
    const { item, track } = entry;
    const { title, subtitle } = trackLabel(track);

    return (
        <div
            className={classes(
                cl("row"),
                cl("queue-row"),
                drag.draggingId === item.id && cl("queue-row-dragging"),
                drag.target?.beforeId === item.id && cl("queue-row-drop")
            )}
            draggable
            onDragStart={e => {
                // Chromium refuses to start a drag that carries no payload
                e.dataTransfer.setData("text/plain", item.id);
                e.dataTransfer.effectAllowed = "move";
                drag.onStart(item.id);
            }}
            onDragOver={e => {
                const { top, height } = e.currentTarget.getBoundingClientRect();
                // the top half drops in front of this row, the bottom half behind it
                drag.onOver(e, e.clientY - top < height / 2 ? item.id : nextId);
            }}
            onDragEnd={drag.onEnd}
            onClick={() => store.playQueued(item.id)}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") store.playQueued(item.id);
            }}
        >
            <span className={cl("queue-grip")} aria-hidden>
                <Icon path={PATHS.drag} label="" size={16} />
            </span>

            <span className={cl("queue-position")}>{position}</span>

            <div className={cl("row-text")}>
                <span className={cl("row-title")}>{title}</span>
                {subtitle && <span className={cl("row-subtitle")}>{subtitle}</span>}
            </div>

            {track.isVideo && <span className={cl("row-badge")}>VIDEO</span>}

            <div className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                <ControlButton
                    label="Remove from queue"
                    className={cl("row-action")}
                    onClick={() => store.removeFromQueue(item.id)}
                >
                    <Icon path={PATHS.close} label="remove" size={16} />
                </ControlButton>
            </div>
        </div>
    );
}

function QueueList() {
    const player = usePlayer();
    const entries = player.queueEntries;

    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [target, setTarget] = useState<DropTarget | null>(null);

    function onOver(e: React.DragEvent, beforeId: string | null) {
        if (!draggingId) return;

        // without both of these the browser rejects the drop outright
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        // dropping a row onto its own leading edge moves nothing
        setTarget(beforeId === draggingId ? null : { beforeId });
    }

    function onEnd() {
        setDraggingId(null);
        setTarget(null);
    }

    function onDrop(e: React.DragEvent) {
        e.preventDefault();
        if (draggingId && target) store.moveInQueue(draggingId, target.beforeId);
        onEnd();
    }

    const drag = { draggingId, target, onStart: setDraggingId, onOver, onEnd };

    if (!entries.length) {
        return (
            <div className={cl("queue-empty")}>
                <Icon path={PATHS.queue} label="" size={28} />
                <Span size="sm">
                    Nothing queued. Use <strong>Play next</strong> or <strong>Add to queue</strong> on a
                    track in your library and it will show up here.
                </Span>
            </div>
        );
    }

    return (
        <div
            className={classes(cl("list"), cl("queue-list"))}
            // releasing in the 2px between two rows should still drop where the line
            // says it will, so the whole list accepts what the rows have already aimed
            onDragOver={e => { if (draggingId) e.preventDefault(); }}
            onDrop={onDrop}
            // a drag that ends outside any row still has to be cleaned up
            onDragEnd={onEnd}
        >
            {entries.map((entry, i) => (
                <QueueRow
                    key={entry.item.id}
                    entry={entry}
                    position={i + 1}
                    nextId={entries[i + 1]?.item.id ?? null}
                    drag={drag}
                />
            ))}

            {/* the tail catches drops past the last row, so a track can reach the end */}
            <div
                className={classes(cl("queue-tail"), target?.beforeId === null && cl("queue-tail-drop"))}
                onDragOver={e => onOver(e, null)}
            />
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
            {art && (
                <div
                    className={classes(cl("backdrop"), cl("now-playing-backdrop"))}
                    style={{ backgroundImage: `url(${art})` }}
                />
            )}

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

export function LibraryModal({ modalProps, initialTab = "library" }: {
    modalProps: RenderModalProps;
    initialTab?: LibraryTab;
}) {
    const player = usePlayer();
    const session = useSession();
    const [tab, setTab] = useState<LibraryTab>(initialTab);
    const [query, setQuery] = useState("");

    // a listener browses the host's library and the shared queue, not their own
    const isListener = session.role === "listener";

    const { currentTrack } = player;
    const accent = useArtAccent(currentTrack ? player.artUrl(currentTrack) : null);
    const queued = isListener ? session.sessionQueue.length : player.queueEntries.length;

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
            <div
                className={cl("modal")}
                // tint the whole modal to whatever's playing, like the panel
                style={accent ? { "--vc-lm-accent": accent } as React.CSSProperties : undefined}
            >
                <NowPlaying />

                <div className={cl("tabs")}>
                    <button
                        className={classes(cl("tab"), tab === "library" && cl("tab-active"))}
                        onClick={() => setTab("library")}
                    >
                        Library
                    </button>
                    <button
                        className={classes(cl("tab"), tab === "queue" && cl("tab-active"))}
                        onClick={() => setTab("queue")}
                    >
                        Up next
                        {queued > 0 && <span className={cl("tab-count")}>{queued}</span>}
                    </button>
                    <button
                        className={classes(cl("tab"), tab === "session" && cl("tab-active"))}
                        onClick={() => setTab("session")}
                    >
                        Listen along
                        {session.memberCount > 1 && <span className={cl("tab-count")}>{session.memberCount}</span>}
                    </button>

                    {tab === "queue" && queued > 0 && !isListener && (
                        <Button
                            className={cl("tabs-action")}
                            size="small"
                            variant="secondary"
                            onClick={() => player.clearQueue()}
                        >
                            Clear
                        </Button>
                    )}
                </div>

                {tab === "session" ? <SessionPanel /> : tab === "queue"
                    ? (isListener ? <SessionQueueList /> : <QueueList />)
                    : isListener ? <SessionLibraryList /> : (
                        <>
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
                                {/* downloads and custom tools keep going with this closed, so the
                                    count is the only sign anything is still happening */}
                                {(() => {
                                    const busy = player.downloads.filter(j => j.status === "running").length
                                        + player.toolRuns.filter(r => r.status === "running").length;
                                    return busy ? `Download… (${busy})` : "Download…";
                                })()}
                            </Button>
                        </div>

                        <TextInput
                            value={query}
                            onChange={setQuery}
                            placeholder="Search your library…"
                        />

                        {/* searching is a flat view of the whole library on purpose —
                            a search that only looked in the folder you happen to be
                            standing in would be the least useful kind */}
                        {query.trim() ? (
                            <>
                                <div className={cl("list")}>
                                    {visible.length ? visible.map(({ track, index }) => (
                                        <TrackRow
                                            key={track.path}
                                            track={track}
                                            index={index}
                                            isCurrent={index === player.currentIndex}
                                        />
                                    )) : (
                                        <Span size="sm">
                                            {player.isScanning ? "Scanning…" : "Nothing in your library matches that."}
                                        </Span>
                                    )}
                                </div>

                                {filtered.length > MAX_ROWS && (
                                    <Span size="sm">
                                        Showing {MAX_ROWS} of {filtered.length} tracks — narrow the search down.
                                    </Span>
                                )}
                            </>
                        ) : player.folder ? (
                            <FolderBrowser />
                        ) : (
                            <div className={cl("list")}>
                                <Span size="sm">Choose a folder to get started.</Span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}
