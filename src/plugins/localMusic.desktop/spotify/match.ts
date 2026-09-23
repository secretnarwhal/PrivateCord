/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Track, TrackMetadata } from "@plugins/localMusic.desktop/types";

import type { SpotifySnapshot } from "./presence";

/**
 * Finding the file behind a Spotify card.
 *
 * The two sides never agree on spelling: Spotify says "Song (feat. X) - 2011
 * Remaster" where the file says "Song", one writes "&" and the other "and", and
 * a rip may have no tags at all beyond its name. So nothing here compares raw
 * strings — both sides are reduced to a plain form first, and a match has to
 * clear a bar on the title *and* the artist before it counts.
 */

/** Parentheticals worth dropping: the ones that are about the release, not the song. */
const NOISE = /\b(remaster(ed)?|remastered version|deluxe|expanded|anniversary|mono|stereo|radio edit|album version|single version|extended version|original mix|bonus track|explicit|clean|feat\.?|featuring|with)\b/;
/** "Song - 2011 Remaster", "Song - Radio Edit": the same noise, hung off a dash. */
const DASH_SUFFIX = /\s-\s[^-]*$/;
const BRACKETS = /[([{]([^)\]}]*)[)\]}]/g;
const ARTIST_SPLIT = /\s*(?:;|,|&|\/|\sx\s|\sand\s|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bvs\.?\b)\s*/i;

/**
 * Lowercase, unaccented, punctuation-free. Everything that isn't a letter or a
 * digit becomes a space, so "Don't" and "Dont" land in the same place.
 */
export function plain(text: string) {
    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * A title with the release chatter taken off. A bracketed part only goes if it
 * reads as chatter — "(Interlude)" and "(Reprise)" are part of the song's name
 * and taking them off would merge two different tracks into one.
 */
export function plainTitle(text: string) {
    const withoutBrackets = text.replace(BRACKETS, (whole, inner: string) =>
        NOISE.test(inner.toLowerCase()) ? " " : whole);

    const withoutSuffix = NOISE.test(withoutBrackets.toLowerCase().replace(/^.*\s-\s/, ""))
        ? withoutBrackets.replace(DASH_SUFFIX, "")
        : withoutBrackets;

    return plain(withoutSuffix);
}

export function splitArtists(text: string) {
    return text
        .split(ARTIST_SPLIT)
        .map(plain)
        .filter(Boolean);
}

/** 1 for the same thing, down to 0 for two unrelated strings. */
function similarity(a: string, b: string) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    // one being the whole of the other is the usual shape of a stripped suffix
    if (a.startsWith(b) || b.startsWith(a)) return 0.9;
    if (a.includes(b) || b.includes(a)) return 0.8;

    const words = new Set(b.split(" "));
    const shared = a.split(" ").filter(word => words.has(word)).length;
    const ratio = shared / Math.max(a.split(" ").length, words.size);

    // most of the words in common, but not in order — worth considering, not trusting
    return ratio >= 0.8 ? 0.7 : 0;
}

/** The best any of their artists scores against any of ours. */
function artistScore(wanted: string[], theirs: string[]) {
    let best = 0;

    for (const a of wanted) {
        for (const b of theirs) {
            best = Math.max(best, similarity(a, b));
            if (best === 1) return 1;
        }
    }

    return best;
}

/**
 * "Artist - Title.flac" and friends. Used only when a file has no tags, which is
 * exactly when the name is the only thing left to go on.
 */
function fromFileName(fileName: string) {
    const dash = fileName.indexOf(" - ");
    return dash === -1
        ? { title: fileName, artist: "" }
        : { artist: fileName.slice(0, dash), title: fileName.slice(dash + 3) };
}

export interface Match {
    path: string;
    /** 0-1; how sure we are this is the same recording */
    score: number;
}

/** Below this we'd rather download the track than play something that isn't it. */
export const MATCH_THRESHOLD = 0.75;

/**
 * The file in `tracks` most likely to be the track on the card, or null when
 * nothing clears the bar. Tags are preferred; a file without them falls back to
 * its own name, which is how most of a downloaded library is labelled anyway.
 */
export function findMatch(
    snapshot: SpotifySnapshot,
    tracks: Track[],
    metadata: Record<string, TrackMetadata>
): Match | null {
    const wantedTitle = plainTitle(snapshot.title);
    const wantedArtists = splitArtists(snapshot.artist);
    const wantedAlbum = plainTitle(snapshot.album);
    if (!wantedTitle) return null;

    let best: Match | null = null;

    for (const track of tracks) {
        const meta = metadata[track.path];
        const named = fromFileName(track.fileName);

        const title = plainTitle(meta?.title || named.title);
        const titleScore = similarity(wantedTitle, title);
        if (!titleScore) continue;

        const theirArtists = splitArtists(meta?.artist || named.artist);
        // an untagged file whose name carries no artist can still match on title
        // alone, but only barely — it has told us nothing to agree with
        const artists = theirArtists.length ? artistScore(wantedArtists, theirArtists) : 0.35;

        let score = titleScore * 0.65 + artists * 0.35;

        // the right album is a strong hint, and the deciding one between an album
        // cut and the single that shares its name
        if (wantedAlbum && meta?.album && similarity(wantedAlbum, plainTitle(meta.album)) > 0.8)
            score = Math.min(1, score + 0.08);

        if (!best || score > best.score) best = { path: track.path, score };
    }

    return best && best.score >= MATCH_THRESHOLD ? best : null;
}
