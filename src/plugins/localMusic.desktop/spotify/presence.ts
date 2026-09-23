/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Activity } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { PresenceStore, RelationshipStore, UserStore } from "@webpack/common";

/**
 * What we can learn about someone's Spotify playback from their presence alone.
 *
 * Everything here comes out of the activity Discord already gives us for anyone
 * whose "Listening to Spotify" card we can see — no Spotify account, no API key
 * and no premium on either side. The catch is that presence is all we get: there
 * is no queue, no "what's next", and nothing arrives until they have already
 * started playing it.
 */
export interface SpotifySnapshot {
    userId: string;
    /** the Spotify track id — `sync_id` on the activity, and what a downloader wants */
    trackId: string;
    title: string;
    /** artists, as Spotify formats them: "A; B" or "A, B" depending on the client */
    artist: string;
    album: string;
    artUrl: string | null;
    /**
     * Epoch ms at which the track (notionally) started, by *their* clock. Their
     * position is `now - start`, and it is re-sent on every seek, pause and
     * resume, which is what makes following them drift-free rather than a guess.
     */
    start: number;
    /** epoch ms the track is due to end; `end - start` is its real length */
    end: number;
    /** seconds */
    duration: number;
    /**
     * Spotify drops the timestamps when playback is paused (the client stops
     * drawing a progress bar) but keeps the activity for a while, so a card with
     * no timestamps means "stopped here", not "just started".
     */
    paused: boolean;
}

/** i.scdn.co is where `spotify:<id>` image keys actually live. */
const SPOTIFY_IMAGE = "https://i.scdn.co/image/";

function isSpotify(activity: Activity) {
    return activity.name === "Spotify" && activity.type === ActivityType.LISTENING;
}

function artOf(activity: Activity) {
    const key = activity.assets?.large_image ?? activity.assets?.small_image;
    if (!key) return null;

    // "spotify:ab67616d00001e02…" is the only form Spotify's integration sends
    return key.startsWith("spotify:") ? SPOTIFY_IMAGE + key.slice("spotify:".length) : null;
}

function toSnapshot(userId: string, activity: Activity): SpotifySnapshot | null {
    // a track we can't name is a card we can't match or download, so it is no use
    if (!activity.sync_id || !activity.details) return null;

    const start = activity.timestamps?.start ?? 0;
    const end = activity.timestamps?.end ?? 0;

    return {
        userId,
        trackId: activity.sync_id,
        title: activity.details,
        artist: activity.state ?? "",
        album: activity.assets?.large_text ?? "",
        artUrl: artOf(activity),
        start,
        end,
        duration: end > start ? (end - start) / 1000 : 0,
        paused: !start
    };
}

/** Their Spotify card as it stands right now, or null when there isn't one. */
export function readSpotify(userId: string): SpotifySnapshot | null {
    const activity = PresenceStore.findActivity(userId, isSpotify);
    return activity ? toSnapshot(userId, activity) : null;
}

/**
 * Everyone we can currently see listening to Spotify.
 *
 * This reads the presence table Discord already keeps, so it holds exactly the
 * people whose presence the gateway is sending us: friends, and members of the
 * guilds whose lists this client has subscribed to. Someone you can't see here
 * is someone Discord isn't telling us about, not someone who isn't listening.
 */
export function listSpotifyListeners(): SpotifySnapshot[] {
    const { activities } = PresenceStore.getState();
    const found: SpotifySnapshot[] = [];

    for (const userId of Object.keys(activities)) {
        const activity = activities[userId]?.find(isSpotify);
        if (!activity) continue;

        const snapshot = toSnapshot(userId, activity);
        if (snapshot) found.push(snapshot);
    }

    // friends first, then whoever we have a name for, then the rest
    return found.sort((a, b) => {
        const friends = Number(RelationshipStore.isFriend(b.userId)) - Number(RelationshipStore.isFriend(a.userId));
        if (friends) return friends;

        return nameOf(a.userId).localeCompare(nameOf(b.userId));
    });
}

/** Their display name, falling back to the id for someone not in the user cache. */
export function nameOf(userId: string) {
    const user = UserStore.getUser(userId);
    return user?.globalName || user?.username || userId;
}

/**
 * Runs `listener` whenever any presence changes. That is a busy event — every
 * status change in every guild lands here — so callers are expected to re-read
 * the one presence they care about and compare, rather than act on the call.
 */
export function onPresenceChange(listener: () => void) {
    PresenceStore.addChangeListener(listener);
    return () => PresenceStore.removeChangeListener(listener);
}

/** Changes exactly when something worth reacting to has changed. */
export function fingerprint(snapshot: SpotifySnapshot | null) {
    return snapshot ? `${snapshot.trackId}:${snapshot.start}:${snapshot.end}` : "";
}

export function spotifyUrl(trackId: string) {
    return `https://open.spotify.com/track/${trackId}`;
}

/** Where in the track they are right now, in seconds. */
export function positionOf(snapshot: SpotifySnapshot, offsetMs = 0) {
    if (snapshot.paused) return 0;

    const seconds = (Date.now() - snapshot.start + offsetMs) / 1000;
    return Math.max(0, snapshot.duration ? Math.min(seconds, snapshot.duration) : seconds);
}
