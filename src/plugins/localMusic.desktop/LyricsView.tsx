/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { React, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { activeLineAt, lyricsStore, timedWords, useLyrics } from "./LyricsStore";
import { cl } from "./MiniPlayer";
import { store } from "./PlayerStore";
import { settings } from "./settings";
import type { LyricsCandidate } from "./types";

/** How long auto-scroll stays out of the way after the user scrolls themselves. */
const MANUAL_SCROLL_GRACE = 4000;

const SOURCE_LABELS = {
    sidecar: "from a .lrc file",
    embedded: "from the file's tags",
    netease: "word-by-word · NetEase",
    lrclib: "from LRCLIB"
} as const;

function formatLength(seconds: number) {
    if (!seconds) return "";
    return `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, "0")}`;
}

/**
 * The escape hatch for everything automatic matching gets wrong: search both
 * providers by hand and pin the result to this track. Auto-matching deliberately
 * shows nothing rather than guessing, so this is what covers the gap.
 */
function LyricsPicker({ onClose }: { onClose: () => void; }) {
    const [query, setQuery] = useState(() => lyricsStore.suggestedQuery);
    const [results, setResults] = useState<LyricsCandidate[] | null>(null);
    const [searching, setSearching] = useState(false);

    async function run() {
        if (!query.trim() || searching) return;

        setSearching(true);
        try {
            setResults(await lyricsStore.searchCandidates(query));
        } catch (e) {
            console.error("[LocalMusic] lyrics search failed:", e);
            setResults([]);
        } finally {
            setSearching(false);
        }
    }

    return (
        <div
            className={cl("lyrics-picker")}
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
        >
            <div className={cl("lyrics-picker-row")}>
                <input
                    className={cl("lyrics-picker-input")}
                    value={query}
                    onChange={e => setQuery(e.currentTarget.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") run();
                        if (e.key === "Escape") onClose();
                    }}
                    placeholder="Artist and title"
                    aria-label="Search lyrics for"
                    autoFocus
                />
                <button className={cl("lyrics-picker-go")} onClick={run} disabled={searching}>
                    {searching ? "…" : "Search"}
                </button>
                <button className={cl("lyrics-picker-go")} onClick={onClose}>Close</button>
            </div>

            {lyricsStore.hasOverride && (
                <button
                    className={cl("lyrics-picker-clear")}
                    onClick={() => { lyricsStore.applyOverride(null); onClose(); }}
                >
                    Clear the saved choice for this track
                </button>
            )}

            {results && !results.length && !searching && (
                <div className={cl("lyrics-picker-empty")}>Nothing found for that</div>
            )}

            {!!results?.length && (
                <div className={cl("lyrics-picker-list")}>
                    {results.map(candidate => (
                        <button
                            key={`${candidate.provider}:${candidate.id}`}
                            className={cl("lyrics-picker-item")}
                            onClick={() => { lyricsStore.applyOverride(candidate); onClose(); }}
                        >
                            <span className={cl("lyrics-picker-title")}>
                                {candidate.title || "Untitled"}
                                {candidate.wordLevel && (
                                    <span className={cl("lyrics-picker-tag")}>word-by-word</span>
                                )}
                            </span>
                            <span className={cl("lyrics-picker-meta")}>
                                {[candidate.artist, candidate.album, formatLength(candidate.duration)]
                                    .filter(Boolean).join(" · ")}
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * The lyrics pane. Timing comes straight off the media element rather than the
 * store's 4Hz position updates, so the sweep is exact — and it is written to the
 * DOM as a CSS variable per word, which keeps a 60fps effect from re-rendering
 * the list. React only hears about it when the active *line* changes.
 */
export function LyricsView() {
    const lyrics = useLyrics();
    const [active, setActive] = useState(-1);
    const [picking, setPicking] = useState(false);

    const scrollRef = useRef<HTMLDivElement>(null);
    const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
    const scrolledAt = useRef(0);

    const current = lyrics.lyrics;
    const synced = !!current?.synced;

    // real word timings when the source had them, otherwise a timing by word
    // length — which is what makes both look like the same effect
    const words = useMemo(() => current ? timedWords(current) : [], [current]);

    const wordClass = cl("lyric-word");

    useEffect(() => {
        if (!current || !synced) {
            setActive(-1);
            return;
        }

        const media = store.getMediaElement();
        const { lines } = current;

        let frame = 0;
        let index = -1;
        let paintedIndex = -1;
        let painted: HTMLElement[] = [];

        const release = () => {
            for (const span of painted) span.style.removeProperty("--vc-lm-word-p");
        };

        const tick = () => {
            frame = requestAnimationFrame(tick);

            const time = media.currentTime + (settings.store.lyricsOffset || 0) / 1000;
            const next = activeLineAt(lines, time);

            if (next !== index) {
                index = next;
                setActive(next);
            }

            // the spans of the line we just left go back to being styled by CSS
            if (next !== paintedIndex) {
                release();
                paintedIndex = next;
                painted = next >= 0
                    ? Array.from(lineRefs.current[next]?.querySelectorAll<HTMLElement>(`.${wordClass}`) ?? [])
                    : [];
            }

            const timing = words[next];
            if (!timing) return;

            for (let i = 0; i < painted.length; i++) {
                const word = timing[i];
                const progress = word
                    ? Math.max(0, Math.min(1, (time - word.start) / (word.end - word.start)))
                    : 0;

                painted[i].style.setProperty("--vc-lm-word-p", progress.toFixed(3));
            }
        };

        frame = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(frame);
            release();
        };
    }, [current, synced, words, wordClass]);

    // keep the active line centred, unless the user is reading somewhere else
    useEffect(() => {
        if (active < 0 || Date.now() - scrolledAt.current < MANUAL_SCROLL_GRACE) return;

        const line = lineRefs.current[active];
        const container = scrollRef.current;
        if (!line || !container) return;

        container.scrollTo({
            top: line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2,
            behavior: "smooth"
        });
    }, [active]);

    if (picking) return <LyricsPicker onClose={() => setPicking(false)} />;

    if (lyrics.status === "loading") {
        return <div className={cl("lyrics-note")}>Looking for lyrics…</div>;
    }

    const fixButton = (
        <button className={cl("lyrics-fix")} onClick={e => { e.stopPropagation(); setPicking(true); }}>
            Fix lyrics…
        </button>
    );

    if (!current || current.instrumental) {
        return (
            <div className={classes(cl("lyrics-note"), cl("lyrics-note-actionable"))}>
                {current?.instrumental ? "Instrumental" : "No lyrics found"}
                {!settings.store.lyricsOnline && (
                    <span className={cl("lyrics-hint")}>Online lookup is off</span>
                )}
                {fixButton}
            </div>
        );
    }

    return (
        <div
            className={classes(cl("lyrics"), !synced && cl("lyrics-plain"))}
            ref={scrollRef}
            onWheel={() => { scrolledAt.current = Date.now(); }}
            onPointerDown={() => { scrolledAt.current = Date.now(); }}
            // the panel behind this plays/pauses on click
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
        >
            <div className={cl("lyrics-lines")}>
                {current.lines.map((line, i) => (
                    <div
                        key={i}
                        ref={el => { lineRefs.current[i] = el; }}
                        className={classes(
                            cl("lyric-line"),
                            i === active && cl("lyric-line-active"),
                            i < active && cl("lyric-line-past")
                        )}
                        // a synced line knows where it starts, so it doubles as a seek
                        onClick={synced ? () => store.seek(line.start) : undefined}
                        title={synced ? "Jump to this line" : undefined}
                    >
                        {synced
                            ? words[i]?.map((word, w) => (
                                <span className={wordClass} key={w}>{word.text}</span>
                            ))
                            : line.text}
                    </div>
                ))}
            </div>

            <div className={cl("lyrics-source")}>
                {SOURCE_LABELS[current.source]}
                {!synced && " · not synced"}
                {lyrics.hasOverride && " · picked by you"}
                {fixButton}
            </div>
        </div>
    );
}
