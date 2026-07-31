/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { cl, ControlButton, Icon, PATHS } from "@plugins/localMusic.desktop/MiniPlayer";
import { copyWithToast } from "@utils/discord";
import { classes } from "@utils/misc";
import { React, TextInput, useMemo, useState } from "@webpack/common";

import { MemberPerms, SessionMember, SessionTrack } from "./protocol";
import { sessionStore, useSession } from "./SessionStore";

/**
 * Lazy on purpose: this module sits in an import cycle with MiniPlayer
 * (SessionUI → MiniPlayer → LibraryModal → SessionUI), so touching PATHS at
 * module scope would read a const that hasn't initialized yet and take the
 * whole plugins bundle down with a TDZ ReferenceError.
 */
const permLabels = (): { key: keyof MemberPerms; label: string; icon: string; }[] => [
    { key: "playback", label: "Playback control (slider, play/pause, skip)", icon: PATHS.play },
    { key: "addToQueue", label: "Add to the queue", icon: PATHS.queueAdd },
    { key: "reorderQueue", label: "Reorder & remove queued tracks", icon: PATHS.drag }
];

function MemberRow({ member }: { member: SessionMember; }) {
    return (
        <div className={classes(cl("row"), cl("session-member"), !member.connected && cl("session-member-away"))}>
            <div className={cl("row-text")}>
                <span className={cl("row-title")}>{member.username}</span>
                <span className={cl("row-subtitle")}>
                    {member.connected
                        ? member.syncing ? "Syncing…" : "Listening"
                        : "Reconnecting…"}
                </span>
            </div>

            <div className={cl("row-actions")}>
                {permLabels().map(({ key, label, icon }) => (
                    <ControlButton
                        key={key}
                        label={`${label} — ${member.perms[key] ? "allowed" : "not allowed"}`}
                        className={classes(
                            cl("row-action"),
                            cl("session-perm"),
                            member.perms[key] && cl("button-active")
                        )}
                        onClick={() => sessionStore.setMemberPerms(member.userId, {
                            ...member.perms,
                            [key]: !member.perms[key]
                        })}
                    >
                        <Icon path={icon} label={label} size={16} />
                    </ControlButton>
                ))}

                <ControlButton
                    label="Remove from the session"
                    className={cl("row-action")}
                    onClick={() => sessionStore.kick(member.userId)}
                >
                    <Icon path={PATHS.close} label="kick" size={16} />
                </ControlButton>
            </div>
        </div>
    );
}

function HostView() {
    const session = useSession();

    return (
        <div className={cl("session-panel")}>
            <Heading tag="h5">You're hosting a listening session</Heading>

            <Span size="sm">
                Anyone you hand this key to can join and hear your music. Treat it like an invite.
            </Span>

            <div className={cl("session-key-row")}>
                <code className={cl("session-key")}>{session.groupKey}</code>
                <Button size="small" onClick={() => copyWithToast(session.groupKey!, "Group key copied")}>
                    Copy key
                </Button>
            </div>

            <Heading tag="h5">Listeners</Heading>
            {session.members.length
                ? session.members.map(m => <MemberRow key={m.userId} member={m} />)
                : <Span size="sm">Nobody yet — the session is live, share the key.</Span>}

            <div className={cl("session-footer")}>
                <Button variant="dangerPrimary" size="small" onClick={() => sessionStore.endSession()}>
                    End session
                </Button>
            </div>
        </div>
    );
}

function ListenerView() {
    const session = useSession();

    const state = session.connection === "connected"
        ? `Connected — ${Math.max(0, Math.round(session.rtt))}ms`
        : session.connection === "reconnecting" ? "Reconnecting…" : "Connecting…";

    return (
        <div className={cl("session-panel")}>
            <Heading tag="h5">Listening along with {session.hostUsername}</Heading>
            <Span size="sm">{state}</Span>

            <div className={cl("session-perms-summary")}>
                {permLabels().map(({ key, label, icon }) => (
                    <span
                        key={key}
                        className={classes(cl("session-perm-chip"), session.myPerms[key] && cl("session-perm-chip-on"))}
                        title={`${label}: ${session.myPerms[key] ? "allowed" : "not allowed"}`}
                    >
                        <Icon path={icon} label="" size={14} />
                        {session.myPerms[key] ? "✓" : "✕"}
                    </span>
                ))}
            </div>

            <div className={cl("session-footer")}>
                <Button variant="dangerPrimary" size="small" onClick={() => sessionStore.leave()}>
                    Leave session
                </Button>
            </div>
        </div>
    );
}

function IdleView() {
    const session = useSession();
    const [key, setKey] = useState("");

    return (
        <div className={cl("session-panel")}>
            <Heading tag="h5">Listen along</Heading>
            <Span size="sm">
                Host a session and share the key, or paste a key someone gave you. Music and controls
                flow directly between you — no servers involved.
            </Span>

            <div className={cl("session-actions")}>
                <Button size="small" onClick={() => sessionStore.startHosting()}>
                    Start hosting
                </Button>
            </div>

            <div className={cl("session-join-row")}>
                <TextInput
                    value={key}
                    onChange={setKey}
                    placeholder="Paste a group key (LMS1.…)"
                />
                <Button
                    size="small"
                    variant="secondary"
                    disabled={!key.trim()}
                    onClick={() => sessionStore.join(key)}
                >
                    Join
                </Button>
            </div>

            {session.error && <div className={cl("session-error")}>{session.error}</div>}
        </div>
    );
}

/** The whole session surface; lives in the library modal's "Listen along" tab. */
export function SessionPanel() {
    const session = useSession();

    if (session.role === "host") return <HostView />;
    if (session.role === "listener") return <ListenerView />;
    return <IdleView />;
}

// #region listener library & queue

function SessionTrackRow({ track }: { track: SessionTrack; }) {
    const session = useSession();
    const subtitle = [track.artist, track.album].filter(Boolean).join(" — ");
    const canPlay = session.myPerms.playback;
    const canQueue = session.myPerms.addToQueue;

    return (
        <div
            className={classes(cl("row"), !canPlay && cl("row-disabled"))}
            onClick={() => canPlay && sessionStore.request("play-track", { trackId: track.id })}
            role="button"
            tabIndex={0}
            onKeyDown={e => {
                if ((e.key === "Enter" || e.key === " ") && canPlay)
                    sessionStore.request("play-track", { trackId: track.id });
            }}
        >
            <div className={cl("row-text")}>
                <span className={cl("row-title")}>{track.title}</span>
                {subtitle && <span className={cl("row-subtitle")}>{subtitle}</span>}
            </div>

            {track.isVideo && <span className={cl("row-badge")}>VIDEO</span>}

            <div className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                <ControlButton
                    label={canQueue ? "Play next" : "The host hasn't allowed queueing"}
                    className={classes(cl("row-action"), !canQueue && cl("row-action-disabled"))}
                    onClick={() => canQueue && sessionStore.request("queue-add", { trackId: track.id, front: true })}
                >
                    <Icon path={PATHS.playNext} label="play next" size={16} />
                </ControlButton>

                <ControlButton
                    label={canQueue ? "Add to queue" : "The host hasn't allowed queueing"}
                    className={classes(cl("row-action"), !canQueue && cl("row-action-disabled"))}
                    onClick={() => canQueue && sessionStore.request("queue-add", { trackId: track.id })}
                >
                    <Icon path={PATHS.queueAdd} label="add to queue" size={16} />
                </ControlButton>
            </div>
        </div>
    );
}

/** The host's library as a listener sees it: manifest rows, searched client-side. */
export function SessionLibraryList() {
    const session = useSession();
    const [query, setQuery] = useState("");

    const tracks = useMemo(() => {
        const all = [...session.manifest.values()];
        const needle = query.trim().toLowerCase();
        if (!needle) return all;

        return all.filter(t =>
            t.title.toLowerCase().includes(needle)
            || t.artist.toLowerCase().includes(needle)
            || t.album.toLowerCase().includes(needle));
    }, [query, session.manifest.size]);

    const MAX_ROWS = 300;
    const visible = tracks.slice(0, MAX_ROWS);

    return (
        <>
            <TextInput
                value={query}
                onChange={setQuery}
                placeholder={`Search ${session.hostUsername}'s library…`}
            />

            <div className={cl("list")}>
                {!tracks.length && (
                    <Span size="sm">
                        {session.manifest.size ? "Nothing matches." : "Waiting for the host's library…"}
                    </Span>
                )}

                {visible.map(track => <SessionTrackRow key={track.id} track={track} />)}
            </div>

            {tracks.length > MAX_ROWS && (
                <Span size="sm">
                    Showing {MAX_ROWS} of {tracks.length} tracks — search to narrow it down.
                </Span>
            )}
        </>
    );
}

/** The unified queue as a listener sees it, with the same drag grammar as the host's. */
export function SessionQueueList() {
    const session = useSession();
    const canReorder = session.myPerms.reorderQueue;
    const canPlay = session.myPerms.playback;

    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [target, setTarget] = useState<{ beforeId: string | null; } | null>(null);

    const entries = session.sessionQueue
        .map(item => ({ item, track: session.manifest.get(item.trackId) }))
        .filter((e): e is { item: typeof e.item; track: SessionTrack; } => !!e.track);

    function onOver(e: React.DragEvent, beforeId: string | null) {
        if (!draggingId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setTarget(beforeId === draggingId ? null : { beforeId });
    }

    function onEnd() {
        setDraggingId(null);
        setTarget(null);
    }

    function onDrop(e: React.DragEvent) {
        e.preventDefault();
        if (draggingId && target)
            sessionStore.request("queue-move", { qid: draggingId, beforeQid: target.beforeId });
        onEnd();
    }

    if (!entries.length) {
        return (
            <div className={cl("queue-empty")}>
                <Icon path={PATHS.queue} label="" size={28} />
                <Span size="sm">The shared queue is empty.</Span>
            </div>
        );
    }

    return (
        <div
            className={classes(cl("list"), cl("queue-list"))}
            onDragOver={e => { if (draggingId) e.preventDefault(); }}
            onDrop={onDrop}
            onDragEnd={onEnd}
        >
            {entries.map(({ item, track }, i) => {
                const subtitle = [track.artist, track.album].filter(Boolean).join(" — ");
                const nextId = entries[i + 1]?.item.qid ?? null;

                return (
                    <div
                        key={item.qid}
                        className={classes(
                            cl("row"),
                            cl("queue-row"),
                            draggingId === item.qid && cl("queue-row-dragging"),
                            target?.beforeId === item.qid && cl("queue-row-drop")
                        )}
                        draggable={canReorder}
                        onDragStart={e => {
                            e.dataTransfer.setData("text/plain", item.qid);
                            e.dataTransfer.effectAllowed = "move";
                            setDraggingId(item.qid);
                        }}
                        onDragOver={e => {
                            const { top, height } = e.currentTarget.getBoundingClientRect();
                            onOver(e, e.clientY - top < height / 2 ? item.qid : nextId);
                        }}
                        onDragEnd={onEnd}
                        onClick={() => canPlay && sessionStore.request("queue-play", { qid: item.qid })}
                        role="button"
                        tabIndex={0}
                    >
                        {canReorder && (
                            <span className={cl("queue-grip")} aria-hidden>
                                <Icon path={PATHS.drag} label="" size={16} />
                            </span>
                        )}

                        <span className={cl("queue-position")}>{i + 1}</span>

                        <div className={cl("row-text")}>
                            <span className={cl("row-title")}>{track.title}</span>
                            {subtitle && <span className={cl("row-subtitle")}>{subtitle}</span>}
                        </div>

                        {canReorder && (
                            <div className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                                <ControlButton
                                    label="Remove from queue"
                                    className={cl("row-action")}
                                    onClick={() => sessionStore.request("queue-remove", { qid: item.qid })}
                                >
                                    <Icon path={PATHS.close} label="remove" size={16} />
                                </ControlButton>
                            </div>
                        )}
                    </div>
                );
            })}

            {canReorder && (
                <div
                    className={classes(cl("queue-tail"), target?.beforeId === null && cl("queue-tail-drop"))}
                    onDragOver={e => onOver(e, null)}
                />
            )}
        </div>
    );
}

// #endregion

/** Overlay strip while the current track is still transferring (or reconnecting). */
export function SyncingBanner() {
    const session = useSession();

    if (session.connection === "reconnecting") {
        return <div className={cl("syncing-banner")}>Reconnecting to {session.hostUsername}…</div>;
    }

    if (!session.syncing) return null;

    const percent = Math.round(session.syncing.progress * 100);
    return (
        <div className={cl("syncing-banner")}>
            Syncing with {session.hostUsername}… {percent}%
            <div className={cl("syncing-track")}>
                <div className={cl("syncing-fill")} style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}
