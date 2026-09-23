/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Span } from "@components/Span";
import { cl, ControlButton, Icon, PATHS } from "@plugins/localMusic.desktop/MiniPlayer";
import { usePlayer } from "@plugins/localMusic.desktop/PlayerStore";
import { classes } from "@utils/misc";
import { formatDuration } from "@utils/text";
import type { User } from "@vencord/discord-types";
import { Menu, useEffect, useReducer, useState } from "@webpack/common";

import { followStore, useFollow } from "./FollowStore";
import { listSpotifyListeners, nameOf, positionOf, readSpotify, SpotifySnapshot } from "./presence";

/** Presence changes constantly; the list only needs to look live, not be instant. */
const LIST_REFRESH_MS = 3_000;

function useSpotifyListeners() {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        const timer = window.setInterval(forceUpdate, LIST_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, []);

    return listSpotifyListeners();
}

/** Their position, redrawn on its own so the rest of the panel isn't re-rendered at 1Hz. */
function RemoteProgress({ snapshot }: { snapshot: SpotifySnapshot; }) {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        const timer = window.setInterval(forceUpdate, 1_000);
        return () => window.clearInterval(timer);
    }, []);

    if (!snapshot.duration) return null;

    const position = positionOf(snapshot);
    const fraction = Math.min(1, position / snapshot.duration);

    return (
        <div className={cl("spotify-progress")}>
            <div className={cl("spotify-progress-fill")} style={{ width: `${fraction * 100}%` }} />
            <span className={cl("spotify-progress-time")}>
                {formatDuration(position * 1000)} / {formatDuration(snapshot.duration * 1000)}
            </span>
        </div>
    );
}

function statusLine(follow: typeof followStore) {
    switch (follow.status) {
        case "waiting":
            return `${follow.username} isn't listening to anything right now`;
        case "paused":
            return `${follow.username} paused`;
        case "searching":
            return "Looking through your library…";
        case "downloading":
            return follow.downloadPercent >= 0
                ? `Downloading — ${Math.round(follow.downloadPercent)}%`
                : "Downloading…";
        case "playing":
            return Math.abs(follow.drift) > 1
                ? `In sync — catching up ${follow.drift > 0 ? "" : "-"}${Math.abs(follow.drift).toFixed(1)}s`
                : "In sync";
        case "missing":
            return "Not in your library";
        case "error":
            return "Something went wrong";
        default:
            return "";
    }
}

function FollowingCard() {
    const follow = useFollow();
    const { snapshot } = follow;

    return (
        <div className={cl("spotify-card")}>
            <div className={cl("spotify-card-head")}>
                {snapshot?.artUrl
                    ? <img className={cl("spotify-art")} src={snapshot.artUrl} alt="" />
                    : <div className={classes(cl("spotify-art"), cl("spotify-art-empty"))}>
                        <Icon path={PATHS.note} label="" size={22} />
                    </div>}

                <div className={cl("spotify-card-text")}>
                    <span className={cl("row-title")}>{snapshot?.title ?? "Nothing playing"}</span>
                    <span className={cl("row-subtitle")}>
                        {snapshot ? [snapshot.artist, snapshot.album].filter(Boolean).join(" — ") : ""}
                    </span>
                    <span className={cl("spotify-status")}>
                        Following {follow.username} · {statusLine(follow)}
                    </span>
                </div>

                <ControlButton
                    label="Stop following"
                    className={cl("row-action")}
                    onClick={() => follow.stop()}
                >
                    <Icon path={PATHS.close} label="stop" size={16} />
                </ControlButton>
            </div>

            {snapshot && !snapshot.paused && <RemoteProgress snapshot={snapshot} />}

            {follow.message && <Span size="sm" className={cl("spotify-message")}>{follow.message}</Span>}

            {follow.lengthWarning && (
                <Span size="sm" className={cl("spotify-warning")}>
                    Your copy is a very different length from theirs — it's probably a different
                    edit, so the sync will look right and sound wrong.
                </Span>
            )}

            {follow.status === "playing" && follow.matchScore > 0 && follow.matchScore < 0.85 && (
                <Span size="sm" className={cl("spotify-warning")}>
                    This was a loose match against your library — it may not be the same recording.
                </Span>
            )}

            <div className={cl("session-actions")}>
                {follow.status === "playing" && (
                    <Button size="small" variant="secondary" onClick={() => follow.resyncNow()}>
                        Resync
                    </Button>
                )}

                {(follow.status === "missing" || follow.status === "error") && follow.downloader && (
                    <Button size="small" onClick={() => follow.fetchNow()}>
                        Download it
                    </Button>
                )}
            </div>
        </div>
    );
}

function ListenerRow({ snapshot }: { snapshot: SpotifySnapshot; }) {
    const follow = useFollow();
    const active = follow.userId === snapshot.userId;

    return (
        <div className={classes(cl("row"), active && cl("row-active"))}>
            <div className={cl("row-text")}>
                <span className={cl("row-title")}>{nameOf(snapshot.userId)}</span>
                <span className={cl("row-subtitle")}>
                    {snapshot.title}{snapshot.artist && ` — ${snapshot.artist}`}
                </span>
            </div>

            {snapshot.paused && <span className={cl("row-badge")}>PAUSED</span>}

            <div className={cl("row-actions")}>
                <Button
                    size="small"
                    variant={active ? "secondary" : "primary"}
                    onClick={() => active ? follow.stop() : follow.follow(snapshot.userId)}
                >
                    {active ? "Stop" : "Listen along"}
                </Button>
            </div>
        </div>
    );
}

/** The whole Spotify surface; lives in the library modal's "Spotify" tab. */
export function SpotifyPanel() {
    const follow = useFollow();
    const player = usePlayer();
    const people = useSpotifyListeners();
    const [showAll, setShowAll] = useState(false);

    const MAX_ROWS = 8;
    const visible = showAll ? people : people.slice(0, MAX_ROWS);

    return (
        <div className={cl("session-panel")}>
            <Heading tag="h5">Listen along on Spotify</Heading>

            <Span size="sm">
                Follow anyone whose "Listening to Spotify" status you can see. Your own copy of the
                track plays, at the point they're at — no Spotify account, no premium, and nothing
                is sent to them. You'll only see people Discord tells us about: friends, and members
                of servers this client has loaded.
            </Span>

            {follow.following && <FollowingCard />}

            <Heading tag="h5">Listening right now</Heading>

            {people.length
                ? visible.map(snapshot => <ListenerRow key={snapshot.userId} snapshot={snapshot} />)
                : <Span size="sm">Nobody you can see is listening to Spotify at the moment.</Span>}

            {people.length > MAX_ROWS && !showAll && (
                <Button size="small" variant="secondary" onClick={() => setShowAll(true)}>
                    Show all {people.length}
                </Button>
            )}

            <Span size="sm" className={cl("spotify-footnote")}>
                {follow.downloader
                    ? <>Tracks you don't own are fetched with <b>{follow.downloader.name}</b>, set up
                        under Download → Tools.</>
                    : <>Tracks you don't own are skipped until you mark one of your tools as the
                        Spotify downloader, under Download → Tools.</>}
                {!player.folder && " Choose your music folder first."}
            </Span>
        </div>
    );
}

interface UserContextProps {
    user?: User;
}

/**
 * The entry point that matches where you'd look for it: the same right-click
 * menu as everything else you can do to a person. It only appears when they
 * actually have a Spotify card, which is also the only time it would work.
 */
export const userContextPatch: NavContextMenuPatchCallback = (children, { user }: UserContextProps) => {
    if (!user || !readSpotify(user.id)) return;

    const following = followStore.userId === user.id;

    children.push(
        <Menu.MenuItem
            id="vc-lm-spotify-follow"
            label={following ? "Stop listening along" : "Listen along (LocalMusic)"}
            action={() => following ? followStore.stop() : followStore.follow(user.id)}
        />
    );
};
