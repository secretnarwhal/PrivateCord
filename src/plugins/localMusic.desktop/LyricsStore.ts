/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { PluginNative } from "@utils/types";
import { useEffect, useReducer } from "@webpack/common";

import { store } from "./PlayerStore";
import { settings } from "./settings";
import type { LyricLine, Lyrics, LyricsCandidate, LyricsRequest, LyricWord } from "./types";

const Native = VencordNative.pluginHelpers.LocalMusic as PluginNative<typeof import("./native")>;

const OVERRIDES_KEY = "LocalMusic_lyricsOverrides";

export type LyricsStatus = "idle" | "loading" | "ready" | "missing";

/**
 * Track path -> the lyrics the user picked for it by hand. Loaded once at start
 * and kept in memory so `describe()` stays synchronous.
 */
let overrides: Record<string, LyricsCandidate> = {};

/** Called from the plugin's start(); until it resolves nothing is overridden. */
export async function loadLyricsOverrides() {
    overrides = (await DataStore.get<Record<string, LyricsCandidate>>(OVERRIDES_KEY)) ?? {};
}

const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(l => l());
}

/**
 * Holds the lyrics for whatever is playing. Kept out of the view so that toggling
 * the panel between the visualizer and the lyrics doesn't throw the lookup away
 * and fetch it again. Nothing drives it while the lyrics are hidden — the view is
 * what asks — so turning them on is what triggers the first lookup.
 */
class LyricsStore {
    status: LyricsStatus = "idle";
    lyrics: Lyrics | null = null;

    /** identity of the track the current state describes */
    private key = "";
    /** guards against a slow lookup landing after the track already moved on */
    private seq = 0;

    /**
     * Describes what is playing, for both a solo player (which has a file on disk
     * to look beside) and a listen-along listener (which only has the tags the
     * host broadcast).
     */
    private describe(): LyricsRequest | null {
        const track = store.currentTrack;
        if (!track && !store.sessionNowPlaying) return null;

        const title = store.displayTitle;
        const artist = store.displayArtist;
        const { duration } = store;

        // metadata arrives with the element, so a duration of 0 just means the
        // track has not loaded yet — looking up now would only cache a bad match
        if (!duration || (!title && !artist)) return null;

        const album = (track ? store.metadata[track.path]?.album : store.sessionNowPlaying?.album) ?? "";

        return {
            path: track?.path ?? null,
            title,
            artist,
            album,
            duration,
            allowNetwork: settings.store.lyricsOnline,
            wordLevel: settings.store.lyricsOnline && settings.store.lyricsWordLevel,
            ...(track && overrides[track.path] && { override: overrides[track.path] })
        };
    }

    /** What the "Fix lyrics…" box should start out searching for. */
    get suggestedQuery() {
        return [store.displayArtist, store.displayTitle].filter(Boolean).join(" ").trim();
    }

    /** Whether the current track is showing hand-picked lyrics. */
    get hasOverride() {
        const path = store.currentTrack?.path;
        return !!path && !!overrides[path];
    }

    searchCandidates(query: string): Promise<LyricsCandidate[]> {
        return Native.searchLyrics(query, Math.round(store.duration));
    }

    /** Pins a hand-picked result to the playing track, and remembers it. */
    async applyOverride(candidate: LyricsCandidate | null) {
        const path = store.currentTrack?.path;
        if (!path) return;

        if (candidate) overrides[path] = candidate;
        else delete overrides[path];

        await DataStore.set(OVERRIDES_KEY, overrides);
        this.refresh();
    }

    /** Called from an effect, so it is safe for it to publish state. */
    sync() {
        const request = this.describe();

        if (!request) {
            if (this.status !== "idle") {
                this.key = "";
                this.seq++;
                this.status = "idle";
                this.lyrics = null;
                notify();
            }
            return;
        }

        // allowNetwork is part of the identity so that turning online lookup on
        // retries a track that only came up empty because it was off
        const key = [
            request.path, request.title, request.artist,
            Math.round(request.duration), request.allowNetwork
        ].join(" ");
        if (key === this.key) return;

        this.key = key;
        this.status = "loading";
        this.lyrics = null;
        notify();

        const seq = ++this.seq;
        Native.getLyrics(request).then(lyrics => {
            if (seq !== this.seq) return;

            this.lyrics = lyrics;
            this.status = lyrics ? "ready" : "missing";
            notify();
        }).catch(e => {
            if (seq !== this.seq) return;

            console.error("[LocalMusic] lyrics lookup failed:", e);
            this.status = "missing";
            notify();
        });
    }

    /** Drops the memo so the next sync looks the track up again. */
    refresh() {
        this.key = "";
        this.sync();
    }

    destroy() {
        this.seq++;
        this.key = "";
        this.status = "idle";
        this.lyrics = null;
        listeners.clear();
    }
}

export const lyricsStore = new LyricsStore();

/** Subscribes a component to lyrics state, and keeps the lookup following the track. */
export function useLyrics() {
    const [, forceUpdate] = useReducer(x => x + 1, 0);

    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    // the player notifies on its own schedule, so the check rides along with every
    // render of the view rather than trying to hook into its listener set
    useEffect(() => {
        lyricsStore.sync();
    });

    return lyricsStore;
}

/**
 * Splits a line into tokens whose whitespace stays attached to the word before
 * it, so concatenating them back together reproduces the line exactly — which
 * matters for scripts that don't put spaces between words.
 */
function tokenize(text: string): string[] {
    return text.match(/\S+\s*/g) ?? [];
}

function inkLength(line: LyricLine) {
    return tokenize(line.text).reduce((sum, token) => sum + token.trim().length, 0);
}

/** Nothing sensible can be estimated below this; the line just gets a short sweep. */
const MIN_LINE_SPAN = 0.4;
/** Falls back to roughly a syllable every third of a second when calibration fails. */
const DEFAULT_SECONDS_PER_CHAR = 0.1;

/**
 * Works out how fast this particular song is sung, in seconds per character.
 *
 * A line's slot — the gap to the line after it — is *not* how long it is sung
 * for: anything followed by an instrumental break owns that break too. Measured
 * against real word-level data, spreading words across the slot stretches them
 * by around 1.4x on a mid-tempo track and far more around a break, which is
 * exactly the drift where the highlight falls behind the vocal.
 *
 * Lines butted up against the next one have almost no gap, so the *low* end of
 * the slot-per-character distribution is close to the true singing rate. Taking
 * a low percentile of it calibrates per song and per singer with no constant to
 * tune.
 */
function secondsPerChar(lines: LyricLine[]): number {
    const rates: number[] = [];

    for (const line of lines) {
        const chars = inkLength(line);
        const slot = line.end - line.start;
        if (chars > 0 && slot > 0) rates.push(slot / chars);
    }

    if (rates.length < 4) return DEFAULT_SECONDS_PER_CHAR;

    rates.sort((a, b) => a - b);
    return rates[Math.floor(rates.length * 0.25)] || DEFAULT_SECONDS_PER_CHAR;
}

/**
 * Spreads a line's *singing* time across its words by length, which is what lets
 * a plain line-synced source render with the same per-word sweep as one that
 * carried real timing. Capped by the slot so a word can never outlive its line,
 * and a source with real timings never reaches this at all.
 */
function synthesize(line: LyricLine, rate: number): LyricWord[] {
    const tokens = tokenize(line.text);
    if (!tokens.length) return [];

    const total = tokens.reduce((sum, token) => sum + token.trim().length, 0) || tokens.length;
    const slot = Math.max(MIN_LINE_SPAN, line.end - line.start);
    // the estimate is what the words get; the slot is only ever a ceiling, so the
    // last word settles and holds rather than crawling on through the gap
    const span = Math.min(slot, Math.max(MIN_LINE_SPAN, total * rate));

    let at = line.start;
    return tokens.map(text => {
        const share = (text.trim().length / total) * span;
        const word = { start: at, end: at + share, text };
        at += share;
        return word;
    });
}

/** The words each line is drawn from: what the source gave, or a timing by length. */
export function timedWords(lyrics: Lyrics): LyricWord[][] {
    // measured once for the whole song. Worth computing even for a word-level
    // source, since a stray line without timings still has to be filled in.
    const rate = secondsPerChar(lyrics.lines);
    return lyrics.lines.map(line => line.words?.length ? line.words : synthesize(line, rate));
}

/** The last line that has started by `time`, or -1 while the intro is still playing. */
export function activeLineAt(lines: LyricLine[], time: number): number {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (time >= lines[i].start) return i;
    }
    return -1;
}
