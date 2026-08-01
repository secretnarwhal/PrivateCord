/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Lyrics lookup for whatever is playing. This lives in the main process on
// purpose: a fetch from the renderer would need the CSP widened for every
// provider host, and would carry the Discord client's own headers to a third
// party. Nothing here ever sees a Discord credential.
//
// Providers are tried cheapest-first — a sidecar .lrc, then the file's own tags,
// then the network — so a library that already ships its lyrics never makes a
// request at all.

import { createHash } from "crypto";
import { app } from "electron";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, dirname, extname, join } from "path";

import { readTags } from "./tags";
import type {
    LyricLine, Lyrics, LyricsCandidate, LyricsRequest, LyricsSource, LyricWord
} from "./types";

/** How long the last line lingers when nothing says where it ends. */
const TRAILING_LINE_SECONDS = 4;

// #region LRC parsing

/** `[mm:ss]`, `[mm:ss.xx]` or `[mm:ss.xxx]` at the head of a line. */
const LINE_TAG = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
/** `<mm:ss.xx>` before a word — the "enhanced LRC" (A2) extension. */
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/**
 * A fractional part is written as tenths, centiseconds or milliseconds
 * depending on how many digits it has, so pad rather than divide by a guess.
 */
function toSeconds(minutes: string, seconds: string, fraction?: string) {
    const ms = fraction ? Number(fraction.padEnd(3, "0")) : 0;
    return Number(minutes) * 60 + Number(seconds) + ms / 1000;
}

/**
 * Splits the body of a line on its `<mm:ss.xx>` word tags. Word text keeps its
 * original spacing — the renderer concatenates the words back together, so
 * joining on a space would insert one into scripts that don't use them.
 */
function parseWords(body: string, lineStart: number): { text: string; words?: LyricWord[]; } {
    WORD_TAG.lastIndex = 0;

    const marks: { time: number; index: number; length: number; }[] = [];
    for (let m = WORD_TAG.exec(body); m; m = WORD_TAG.exec(body))
        marks.push({ time: toSeconds(m[1], m[2], m[3]), index: m.index, length: m[0].length });

    if (!marks.length) return { text: body.trim() };

    const words: LyricWord[] = [];

    // text sitting before the first tag is still part of the line
    const lead = body.slice(0, marks[0].index);
    if (lead.trim()) words.push({ start: lineStart, end: marks[0].time, text: lead });

    for (let i = 0; i < marks.length; i++) {
        const from = marks[i].index + marks[i].length;
        const to = i + 1 < marks.length ? marks[i + 1].index : body.length;
        const text = body.slice(from, to);

        // a tag with nothing after it closes the previous word rather than
        // opening one of its own, and its time is picked up as that word's end
        if (!text) continue;

        words.push({ start: marks[i].time, end: marks[i + 1]?.time ?? 0, text });
    }

    if (!words.length) return { text: body.replace(WORD_TAG, "").trim() };

    return { text: words.map(w => w.text).join("").trim(), words };
}

/**
 * Parses an LRC document. Returns null when the text carries no timestamps at
 * all, so the caller can fall back to treating it as a plain block.
 *
 * @param duration track length in seconds, used to end the final line; 0 if unknown
 */
function parseLrc(text: string, duration: number): LyricLine[] | null {
    const parsed: LyricLine[] = [];
    let offset = 0;

    for (const physical of text.split(/\r?\n/)) {
        const meta = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i.exec(physical);
        if (meta) {
            // by convention a positive offset means the lyrics run early, so it
            // is subtracted from every timestamp rather than added
            offset = Number(meta[1]) / 1000;
            continue;
        }

        // one line of text can carry several timestamps — a chorus tagged once
        const stamps: number[] = [];
        let rest = physical;
        for (let m = LINE_TAG.exec(rest); m; m = LINE_TAG.exec(rest)) {
            stamps.push(toSeconds(m[1], m[2], m[3]));
            rest = rest.slice(m[0].length);
        }
        if (!stamps.length) continue;

        const { text: lineText, words } = parseWords(rest, stamps[0]);

        for (const start of stamps) {
            // word times were written against the first stamp, so a repeat of
            // the same line has to carry them forward by the gap between them
            const shift = start - stamps[0];
            parsed.push({
                start,
                end: 0,
                text: lineText,
                ...(words && {
                    words: words.map(w => ({
                        start: w.start + shift,
                        end: w.end ? w.end + shift : 0,
                        text: w.text
                    }))
                })
            });
        }
    }

    if (!parsed.length) return null;

    for (const line of parsed) {
        line.start = Math.max(0, line.start - offset);
        if (line.words) for (const word of line.words) {
            word.start = Math.max(0, word.start - offset);
            if (word.end) word.end = Math.max(0, word.end - offset);
        }
    }

    parsed.sort((a, b) => a.start - b.start);

    // a stamp with no text is a marker for where the line before it stops, so
    // ends are filled in before the blanks are dropped
    for (let i = 0; i < parsed.length; i++) {
        const next = parsed[i + 1];
        parsed[i].end = next
            ? next.start
            : duration > parsed[i].start
                ? duration
                : parsed[i].start + TRAILING_LINE_SECONDS;
    }

    const lines = parsed.filter(line => line.text);
    if (!lines.length) return null;

    for (const line of lines) fillWordEnds(line);
    return lines;
}

/** Words only ever know where the next one starts; the last one ends with the line. */
function fillWordEnds(line: LyricLine) {
    const { words } = line;
    if (!words) return;

    for (let i = 0; i < words.length; i++) {
        if (!words[i].end) words[i].end = words[i + 1]?.start ?? line.end;
        // a zero-length word would divide by zero in the sweep
        if (words[i].end <= words[i].start) words[i].end = words[i].start + 0.25;
    }
}

/**
 * NetEase's word-level format:
 *
 *     [lineStartMs,lineDurationMs](wordStartMs,wordDurationMs,0)word...
 *
 * Real per-word durations, so nothing here has to be estimated. The document
 * opens with a few JSON metadata blobs, which fail the `[digits,` test and are
 * skipped.
 */
function parseYrc(text: string): LyricLine[] | null {
    const lines: LyricLine[] = [];

    for (const raw of text.split(/\r?\n/)) {
        const head = /^\[(\d+),(\d+)\]/.exec(raw);
        if (!head) continue;

        const start = Number(head[1]) / 1000;
        const span = Number(head[2]) / 1000;
        const words: LyricWord[] = [];

        for (const match of raw.slice(head[0].length).matchAll(/\((\d+),(\d+),-?\d+\)([^(]*)/g)) {
            const wordStart = Number(match[1]) / 1000;
            const wordSpan = Number(match[2]) / 1000;
            if (!match[3]) continue;

            // trailing punctuation is often given a zero duration of its own
            words.push({ start: wordStart, end: wordStart + Math.max(wordSpan, 0.08), text: match[3] });
        }

        if (!words.length) continue;

        lines.push({
            start,
            // the sung end, not the next line's start — the pane keeps the line
            // lit through the gap either way, and this is the honest number
            end: Math.max(start + span, words[words.length - 1].end),
            text: words.map(w => w.text).join("").trim(),
            words
        });
    }

    if (!lines.length) return null;

    lines.sort((a, b) => a.start - b.start);
    const kept = lines.filter(line => line.text);
    return kept.length ? kept : null;
}

/** An untimed block of text: still worth showing, just without the sweep. */
function parsePlain(text: string): LyricLine[] {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => ({ start: 0, end: 0, text: line }));
}

/** Builds lyrics from whichever of the two shapes a provider handed back. */
function toLyrics(
    text: string | null,
    source: LyricsSource,
    duration: number,
    instrumental = false
): Lyrics | null {
    if (!text?.trim()) return null;

    const timed = parseLrc(text, duration);
    const lines = timed ?? parsePlain(text);
    if (!lines.length) return null;

    return {
        lines,
        synced: !!timed,
        wordLevel: lines.some(line => !!line.words?.length),
        source,
        instrumental
    };
}

// #endregion

// #region local providers

const SIDECAR_EXTS = [".lrc", ".txt"];

/** A `.lrc` (or `.txt`) sitting next to the audio file wins over everything. */
async function readSidecar(path: string, duration: number): Promise<Lyrics | null> {
    const stem = join(dirname(path), basename(path, extname(path)));

    for (const ext of SIDECAR_EXTS) {
        try {
            const text = await readFile(stem + ext, "utf8");
            const lyrics = toLyrics(text, "sidecar", duration);
            if (lyrics) return lyrics;
        } catch {
            // no sidecar of this kind, try the next
        }
    }

    return null;
}

/** ID3 SYLT / USLT and the FLAC lyrics comments. */
async function readEmbedded(path: string, duration: number): Promise<Lyrics | null> {
    let tags: Awaited<ReturnType<typeof readTags>>;
    try {
        tags = await readTags(path);
    } catch {
        return null;
    }

    if (tags.syncedLyrics?.length) {
        const lines: LyricLine[] = tags.syncedLyrics.map(entry => ({
            start: entry.time / 1000,
            end: 0,
            text: entry.text
        }));

        lines.sort((a, b) => a.start - b.start);
        for (let i = 0; i < lines.length; i++) {
            const next = lines[i + 1];
            lines[i].end = next
                ? next.start
                : duration > lines[i].start
                    ? duration
                    : lines[i].start + TRAILING_LINE_SECONDS;
        }

        return { lines, synced: true, wordLevel: false, source: "embedded", instrumental: false };
    }

    // taggers habitually paste a whole LRC document into the plain lyrics field,
    // so this goes through the same parser rather than straight to plain text
    return toLyrics(tags.lyrics ?? null, "embedded", duration);
}

// #endregion

// #region matching

/**
 * Fold away everything two spellings of the same title are likely to disagree
 * about: case, accents, apostrophes and punctuation. CJK is kept as-is.
 */
function normalize(text: string) {
    return text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/['’`´]/g, "")
        .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
        .trim();
}

/**
 * Dice coefficient over character bigrams. No dependency, tolerant of the
 * "(feat. …)" / "- Remastered" noise real tags are full of, and — unlike a bare
 * substring test — it will not call "Sicko Mode (feat. K.K. Slider)" a match
 * for "K.".
 */
function similarity(a: string, b: string) {
    const x = normalize(a);
    const y = normalize(b);

    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return 0;

    const bigrams = new Map<string, number>();
    for (let i = 0; i < x.length - 1; i++) {
        const gram = x.slice(i, i + 2);
        bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
    }

    let hits = 0;
    for (let i = 0; i < y.length - 1; i++) {
        const gram = y.slice(i, i + 2);
        const left = bigrams.get(gram) ?? 0;
        if (left > 0) {
            bigrams.set(gram, left - 1);
            hits++;
        }
    }

    return (2 * hits) / (x.length + y.length - 2);
}

const TITLE_MATCH = 0.6;
const ARTIST_MATCH = 0.5;
/** seconds a search result may differ by and still be the same recording */
const DURATION_TOLERANCE = 5;
/**
 * Below this many normalised characters a title is not distinctive enough to
 * search on its own. "K." reduces to one character, which is how it once matched
 * an instrumental "Sicko Mode (feat. K.K. Slider)" that happened to be the right
 * length. With no artist to pin it down, no lyrics beats wrong lyrics.
 */
const MIN_BLIND_TITLE = 4;

/** Whether a search result is close enough to the playing track to be trusted. */
function accepts(
    want: { title: string; artist: string; duration: number; },
    got: { title: string; artist: string; duration: number; }
) {
    if (want.duration > 0 && got.duration > 0
        && Math.abs(got.duration - want.duration) > DURATION_TOLERANCE) return false;

    if (similarity(want.title, got.title) < TITLE_MATCH) return false;
    // with no artist of our own there is nothing to compare, so the title check
    // plus the length is all the confidence there is
    if (want.artist && similarity(want.artist, got.artist) < ARTIST_MATCH) return false;

    return true;
}

// #endregion

// #region network

const LRCLIB = "https://lrclib.net/api";
// LRCLIB asks clients to say what they are rather than pose as a browser
const USER_AGENT = "LocalMusic (Vencord plugin)";
const FETCH_TIMEOUT = 12_000;

const NETEASE = "https://music.163.com/api";
const NETEASE_HEADERS = {
    // this one does want to look like a browser, and 403s without its own referer
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    Referer: "https://music.163.com/"
};

async function getJson(url: string, headers?: Record<string, string>): Promise<any | null> {
    try {
        const res = await fetch(url, {
            headers: headers ?? { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT)
        });

        // 404 is how LRCLIB says "no match", which is not an error worth logging
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

interface NeteaseSong {
    id: number;
    name?: string;
    artists?: { name?: string; }[];
    album?: { name?: string; };
    /** milliseconds */
    duration?: number;
}

function neteaseArtist(song: NeteaseSong) {
    return (song.artists ?? []).map(a => a.name).filter(Boolean).join(", ");
}

/**
 * Note the endpoint: `/search/get/web` returns an encrypted blob, `/search/get`
 * returns plain JSON.
 */
async function neteaseSearch(query: string, limit = 10): Promise<NeteaseSong[]> {
    const data = await getJson(
        `${NETEASE}/search/get?type=1&limit=${limit}&s=${encodeURIComponent(query)}`,
        NETEASE_HEADERS
    );

    const songs = data?.result?.songs;
    return Array.isArray(songs) ? songs : [];
}

async function neteaseLyrics(id: string | number): Promise<{ yrc?: string; lrc?: string; } | null> {
    const data = await getJson(
        `${NETEASE}/song/lyric/v1?id=${encodeURIComponent(String(id))}&lv=1&yv=1&tv=1`,
        NETEASE_HEADERS
    );

    if (!data) return null;
    return { yrc: data.yrc?.lyric, lrc: data.lrc?.lyric };
}

function neteaseToLyrics(lyric: { yrc?: string; lrc?: string; }, duration: number): Lyrics | null {
    if (lyric.yrc) {
        const lines = parseYrc(lyric.yrc);
        if (lines?.length) {
            return { lines, synced: true, wordLevel: true, source: "netease", instrumental: false };
        }
    }

    return toLyrics(lyric.lrc ?? null, "netease", duration);
}

/**
 * Consulted only for what LRCLIB cannot give: genuine per-word timing. When
 * NetEase has nothing better than line timing we return null and let LRCLIB
 * answer, since its text is the better curated of the two for Western music.
 */
async function fromNetease(req: LyricsRequest, title: string, artist: string): Promise<Lyrics | null> {
    const query = [artist, title].filter(Boolean).join(" ");
    if (!query) return null;

    const songs = await neteaseSearch(query);
    const song = songs.find(candidate => accepts(
        { title, artist, duration: req.duration },
        {
            title: candidate.name ?? "",
            artist: neteaseArtist(candidate),
            duration: Math.round((candidate.duration ?? 0) / 1000)
        }
    ));
    if (!song) return null;

    const lyric = await neteaseLyrics(song.id);
    if (!lyric?.yrc) return null;

    const lines = parseYrc(lyric.yrc);
    if (!lines?.length) return null;

    return { lines, synced: true, wordLevel: true, source: "netease", instrumental: false };
}

/** Strips the decoration yt-dlp filenames and upload titles come caked in. */
function cleanTitle(title: string) {
    return title
        .replace(/\[[^\]]*\]/g, " ")
        .replace(/\((?:official\s+)?(?:music\s+)?(?:video|audio|lyrics?|visualizer|hd|hq|4k|mv)\)/gi, " ")
        .replace(/\s*[-–—]\s*(?:official\s+)?(?:music\s+)?video\s*$/i, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * A file with no artist tag is usually still named "Artist - Title", which is
 * enough to look up. Only used when the tags themselves gave us nothing.
 */
function splitFileName(name: string): { artist: string; title: string; } | null {
    const match = /^(.{1,80}?)\s+[-–—]\s+(.+)$/.exec(cleanTitle(name));
    if (!match) return null;
    return { artist: match[1].trim(), title: match[2].trim() };
}

/**
 * @param trustInstrumental only an exact four-field lookup is confident enough
 *   for "this track has no words" to mean anything. From a search it is just a
 *   record with empty lyrics, and treating it as an answer is how a wrong track
 *   ends up displayed as "Instrumental".
 */
function record(entry: any, duration: number, trustInstrumental: boolean): Lyrics | null {
    if (!entry) return null;

    if (entry.instrumental) {
        return trustInstrumental
            ? { lines: [], synced: false, wordLevel: false, source: "lrclib", instrumental: true }
            : null;
    }

    return toLyrics(entry.syncedLyrics || entry.plainLyrics || null, "lrclib", duration);
}

async function fromLrclib(req: LyricsRequest, title: string, artist: string): Promise<Lyrics | null> {
    const { album, duration } = req;

    const query = (params: Record<string, string>) =>
        new URLSearchParams(params).toString();

    // the signature lookup: an exact match on all four fields, which is the only
    // way LRCLIB will hand back a record it is confident about
    if (artist && duration > 0) {
        const exact = await getJson(`${LRCLIB}/get?${query({
            artist_name: artist,
            track_name: title,
            album_name: album || "",
            duration: String(Math.round(duration))
        })}`);

        const lyrics = record(exact, duration, true);
        if (lyrics) return lyrics;
    }

    // ... then the same thing without the album, which is the field most likely
    // to be tagged differently from however LRCLIB has it
    if (artist && duration > 0) {
        const noAlbum = await getJson(`${LRCLIB}/get?${query({
            artist_name: artist,
            track_name: title,
            duration: String(Math.round(duration))
        })}`);

        const lyrics = record(noAlbum, duration, true);
        if (lyrics) return lyrics;
    }

    const results = await getJson(`${LRCLIB}/search?${query(
        artist ? { track_name: title, artist_name: artist } : { q: title }
    )}`);

    if (!Array.isArray(results) || !results.length) return null;

    const best = results
        .filter(entry => accepts(
            { title, artist, duration },
            {
                title: entry.trackName ?? "",
                artist: entry.artistName ?? "",
                duration: entry.duration ?? 0
            }
        ))
        .sort((a, b) => {
            // a synced result is worth more than a closer-matching plain one
            const synced = Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics);
            if (synced) return synced;
            if (duration <= 0) return 0;
            return Math.abs((a.duration ?? 0) - duration) - Math.abs((b.duration ?? 0) - duration);
        })[0];

    return record(best, duration, false);
}

// #endregion

// #region cache

/**
 * Only network results are cached. Sidecars and tags are already a local read,
 * and not caching them means editing a .lrc shows up on the next track change
 * rather than never.
 */
interface CacheRecord {
    savedAt: number;
    lyrics: Lyrics | null;
}

/** A miss is cached too, so a track with no lyrics isn't looked up every play. */
const MISS_TTL = 7 * 24 * 60 * 60 * 1000;

// resolved lazily: plugin natives are imported during Discord's bootstrap,
// which is before app paths are necessarily usable
const cacheDir = () => join(app.getPath("userData"), "vc-localmusic-lyrics");

const memoryCache = new Map<string, CacheRecord>();

function hashKey(parts: (string | number | boolean)[]) {
    return createHash("sha256").update(parts.join(" ").toLowerCase()).digest("hex").slice(0, 32);
}

function cacheKey(req: LyricsRequest) {
    // wordLevel is part of the identity: turning it on has to be able to replace
    // a line-level result that is already cached
    return hashKey([req.artist, req.title, req.album, Math.round(req.duration), req.wordLevel]);
}

function isFresh(entry: CacheRecord) {
    return entry.lyrics !== null || Date.now() - entry.savedAt < MISS_TTL;
}

async function readCache(key: string): Promise<CacheRecord | null> {
    const memory = memoryCache.get(key);
    if (memory) return isFresh(memory) ? memory : null;

    try {
        const entry = JSON.parse(await readFile(join(cacheDir(), `${key}.json`), "utf8")) as CacheRecord;
        if (!entry || typeof entry.savedAt !== "number") return null;

        memoryCache.set(key, entry);
        return isFresh(entry) ? entry : null;
    } catch {
        return null;
    }
}

async function writeCache(key: string, lyrics: Lyrics | null) {
    const entry: CacheRecord = { savedAt: Date.now(), lyrics };
    memoryCache.set(key, entry);

    try {
        const dir = cacheDir();
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${key}.json`), JSON.stringify(entry), "utf8");
    } catch {
        // the memory cache still holds it for this session
    }
}

// #endregion

/**
 * Works out what to actually search for. Tags are trusted when present; a file
 * with none is usually still named "Artist - Title", which is the next best
 * thing. Returns null when there is not enough to search on without guessing.
 */
function resolveQuery(req: LyricsRequest): { title: string; artist: string; } | null {
    let { artist, title } = req;

    if (!artist) {
        const guess = splitFileName(title);
        if (guess) ({ artist, title } = guess);
    }

    title = cleanTitle(title);
    artist = artist.trim();
    if (!title) return null;

    // no artist and nothing distinctive to go on — see MIN_BLIND_TITLE
    if (!artist && normalize(title).length < MIN_BLIND_TITLE) return null;

    return { title, artist };
}

/** Re-fetches exactly the lyrics behind a candidate the user picked by hand. */
async function fetchCandidate(candidate: LyricsCandidate, duration: number): Promise<Lyrics | null> {
    if (candidate.provider === "netease") {
        const lyric = await neteaseLyrics(candidate.id);
        return lyric ? neteaseToLyrics(lyric, duration) : null;
    }

    const entry = await getJson(`${LRCLIB}/get/${encodeURIComponent(candidate.id)}`);
    // the user chose this one deliberately, so an instrumental record is an answer
    return record(entry, duration, true);
}

/**
 * Candidates for the manual override, from both providers at once. NetEase's
 * search does not say whether a song has word-level timing, so the top few are
 * opened to find out — this only ever runs for a deliberate user action.
 */
export async function searchLyricCandidates(query: string, duration: number): Promise<LyricsCandidate[]> {
    if (!query.trim()) return [];

    const [lrclib, netease] = await Promise.all([
        getJson(`${LRCLIB}/search?${new URLSearchParams({ q: query })}`),
        neteaseSearch(query, 8)
    ]);

    const candidates: LyricsCandidate[] = [];

    for (const entry of Array.isArray(lrclib) ? lrclib.slice(0, 12) : []) {
        if (!entry?.id) continue;
        candidates.push({
            provider: "lrclib",
            id: String(entry.id),
            title: entry.trackName ?? "",
            artist: entry.artistName ?? "",
            album: entry.albumName ?? "",
            duration: Math.round(entry.duration ?? 0),
            wordLevel: false,
            synced: !!entry.syncedLyrics
        });
    }

    const probed = await Promise.all(
        netease.slice(0, 6).map(async song => ({ song, lyric: await neteaseLyrics(song.id) }))
    );

    for (const { song, lyric } of probed) {
        // a song NetEase has no lyrics for is not worth offering
        if (!lyric?.yrc && !lyric?.lrc) continue;

        candidates.push({
            provider: "netease",
            id: String(song.id),
            title: song.name ?? "",
            artist: neteaseArtist(song),
            album: song.album?.name ?? "",
            duration: Math.round((song.duration ?? 0) / 1000),
            wordLevel: !!lyric.yrc,
            synced: true
        });
    }

    return candidates.sort((a, b) => {
        // closest length first, then word-level ahead of line-level
        if (duration > 0 && a.duration && b.duration) {
            const gap = Math.abs(a.duration - duration) - Math.abs(b.duration - duration);
            if (Math.abs(gap) > 2) return gap;
        }
        return Number(b.wordLevel) - Number(a.wordLevel);
    });
}

/**
 * @param pathAllowed whether the caller verified req.path is inside a folder the
 *                    user opened — a listener in a session has no path at all
 */
export async function lookupLyrics(req: LyricsRequest, pathAllowed: boolean): Promise<Lyrics | null> {
    // a hand-picked choice outranks everything, including the local files
    if (req.override) {
        const key = hashKey([req.override.provider, req.override.id, Math.round(req.duration)]);
        const cached = await readCache(key);
        if (cached) return cached.lyrics;

        const picked = await fetchCandidate(req.override, req.duration);
        await writeCache(key, picked);
        return picked;
    }

    if (req.path && pathAllowed) {
        const sidecar = await readSidecar(req.path, req.duration);
        if (sidecar) return sidecar;

        const embedded = await readEmbedded(req.path, req.duration);
        if (embedded) return embedded;
    }

    if (!req.allowNetwork) return null;

    const resolved = resolveQuery(req);
    if (!resolved) return null;

    const key = cacheKey(req);
    const cached = await readCache(key);
    if (cached) return cached.lyrics;

    // NetEase first, but only for what LRCLIB cannot do — see fromNetease
    let lyrics = req.wordLevel
        ? await fromNetease(req, resolved.title, resolved.artist)
        : null;

    lyrics ??= await fromLrclib(req, resolved.title, resolved.artist);

    await writeCache(key, lyrics);
    return lyrics;
}
