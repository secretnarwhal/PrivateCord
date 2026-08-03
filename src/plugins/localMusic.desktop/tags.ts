/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Minimal tag readers for the formats Chromium can actually play. Deliberately
// dependency free: we only need title/artist/album and the embedded cover, and
// pulling a full metadata library into the main process for that is overkill.

import { open } from "fs/promises";

export interface ParsedTags {
    title?: string;
    artist?: string;
    album?: string;
    /** 1 based position on the album, when the tags carry one */
    track?: number;
    /** which disc of a set, when the tags carry one */
    disc?: number;
    picture?: { mime: string; data: Buffer; };
    /**
     * Embedded lyrics as text. Usually plain, but tag editors habitually paste
     * whole LRC files in here, so the caller parses rather than assumes.
     */
    lyrics?: string;
    /** ID3 SYLT: genuinely timed lyrics, already decoded to ms + text */
    syncedLyrics?: { time: number; text: string; }[];
}

async function readBytes(path: string, length: number, position = 0) {
    const handle = await open(path, "r");
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, position);
        return buf.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function decodeText(encoding: number, buf: Buffer) {
    switch (encoding) {
        case 0: return buf.toString("latin1");
        case 1: {
            // UTF-16 with BOM. Node only decodes LE, so byteswap BE ourselves.
            if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
                return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
            if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
                return buf.subarray(2).toString("utf16le");
            return buf.toString("utf16le");
        }
        case 2: return Buffer.from(buf).swap16().toString("utf16le");
        default: return buf.toString("utf8");
    }
}

/**
 * A track or disc number as tags actually write it: "5", "05", or "5/12" — the
 * total after the slash is not something we have any use for. Undefined for
 * anything that isn't a plausible position, so a junk tag can't reorder a folder.
 */
function parsePosition(value: string) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 && n < 100000 ? n : undefined;
}

/** strips the trailing NUL(s) that ID3 text frames are padded with */
function trimNul(s: string) {
    return s.replace(/\0+$/, "").trim();
}

/** finds the terminator of a NUL-terminated string in the given encoding */
function findTerminator(buf: Buffer, start: number, encoding: number) {
    const wide = encoding === 1 || encoding === 2;
    if (!wide) {
        const idx = buf.indexOf(0, start);
        return idx === -1 ? { end: buf.length, next: buf.length } : { end: idx, next: idx + 1 };
    }

    for (let i = start; i + 1 < buf.length; i += 2) {
        if (buf[i] === 0 && buf[i + 1] === 0) return { end: i, next: i + 2 };
    }
    return { end: buf.length, next: buf.length };
}

function readSynchsafe(buf: Buffer, offset: number) {
    return (buf[offset] << 21) | (buf[offset + 1] << 14) | (buf[offset + 2] << 7) | buf[offset + 3];
}

async function parseId3(path: string): Promise<ParsedTags | null> {
    const header = await readBytes(path, 10);
    if (header.length < 10 || header.toString("latin1", 0, 3) !== "ID3") return null;

    // byte 3 is the major version, byte 4 the revision. Reading the revision here
    // makes every tag look like v2.2, so 4 byte frame ids get read as 3 ("TIT2"
    // as "TIT") and the size that follows is garbage — which silently cost every
    // v2.3/v2.4 mp3 its tags.
    const major = header[3];
    const tagSize = readSynchsafe(header, 6);
    if (tagSize <= 0 || tagSize > 32 * 1024 * 1024) return null;

    const body = await readBytes(path, tagSize, 10);
    const tags: ParsedTags = {};

    // v2.2 uses 3 byte frame ids and 3 byte sizes, v2.3/v2.4 use 4 of each
    const idLen = major <= 2 ? 3 : 4;
    const headerLen = major <= 2 ? 6 : 10;

    let offset = 0;
    while (offset + headerLen <= body.length) {
        const id = body.toString("latin1", offset, offset + idLen);
        if (!/^[A-Z0-9]+$/.test(id)) break; // hit padding

        let size: number;
        if (major <= 2) {
            size = (body[offset + 3] << 16) | (body[offset + 4] << 8) | body[offset + 5];
        } else if (major >= 4) {
            size = readSynchsafe(body, offset + 4);
        } else {
            size = body.readUInt32BE(offset + 4);
        }

        if (size <= 0 || offset + headerLen + size > body.length) break;

        const frame = body.subarray(offset + headerLen, offset + headerLen + size);
        offset += headerLen + size;

        switch (id) {
            case "TIT2": case "TT2":
                tags.title ||= trimNul(decodeText(frame[0], frame.subarray(1)));
                break;
            case "TPE1": case "TP1":
                tags.artist ||= trimNul(decodeText(frame[0], frame.subarray(1)));
                break;
            case "TALB": case "TAL":
                tags.album ||= trimNul(decodeText(frame[0], frame.subarray(1)));
                break;
            case "TRCK": case "TRK":
                tags.track ??= parsePosition(trimNul(decodeText(frame[0], frame.subarray(1))));
                break;
            case "TPOS": case "TPA":
                tags.disc ??= parsePosition(trimNul(decodeText(frame[0], frame.subarray(1))));
                break;
            case "USLT": case "ULT": {
                if (tags.lyrics) break;

                const encoding = frame[0];
                // encoding byte, then a 3 byte language code, then a description
                const { next } = findTerminator(frame, 4, encoding);
                const text = trimNul(decodeText(encoding, frame.subarray(next)));
                if (text) tags.lyrics = text;
                break;
            }
            case "SYLT": case "SLT": {
                if (tags.syncedLyrics) break;

                const parsed = parseSylt(frame);
                if (parsed?.length) tags.syncedLyrics = parsed;
                break;
            }
            case "APIC": case "PIC": {
                if (tags.picture) break;

                const encoding = frame[0];
                let mime: string;
                let cursor: number;

                if (id === "PIC") {
                    // v2.2 stores a 3 character image format instead of a mime type
                    const format = frame.toString("latin1", 1, 4).toLowerCase();
                    mime = format === "png" ? "image/png" : "image/jpeg";
                    cursor = 4;
                } else {
                    const { end, next } = findTerminator(frame, 1, 0);
                    mime = frame.toString("latin1", 1, end) || "image/jpeg";
                    cursor = next;
                }

                cursor += 1; // picture type byte
                const { next: afterDescription } = findTerminator(frame, cursor, encoding);
                const data = frame.subarray(afterDescription);
                if (data.length) tags.picture = { mime, data: Buffer.from(data) };
                break;
            }
        }
    }

    return tags;
}

/**
 * ID3 SYLT: encoding, 3 byte language, timestamp format, content type, then a
 * NUL-terminated descriptor, then pairs of NUL-terminated text and a 4 byte
 * timestamp. Only the millisecond timestamp format (2) is decodable — format 1
 * counts MPEG frames, which needs the frame rate we never parsed.
 */
function parseSylt(frame: Buffer): { time: number; text: string; }[] | null {
    if (frame.length < 7) return null;

    const encoding = frame[0];
    if (frame[4] !== 2) return null;

    const { next } = findTerminator(frame, 6, encoding);
    const entries: { time: number; text: string; }[] = [];

    let cursor = next;
    while (cursor + 4 <= frame.length) {
        const { end, next: afterText } = findTerminator(frame, cursor, encoding);
        if (afterText + 4 > frame.length) break;

        const text = decodeText(encoding, frame.subarray(cursor, end));
        const time = frame.readUInt32BE(afterText);
        cursor = afterText + 4;

        // SYLT carries the newlines that separate lines inside the text itself
        const clean = text.replace(/^[\r\n]+/, "").trim();
        if (clean) entries.push({ time, text: clean });
    }

    return entries;
}

async function parseFlac(path: string): Promise<ParsedTags | null> {
    const magic = await readBytes(path, 4);
    if (magic.toString("latin1") !== "fLaC") return null;

    const tags: ParsedTags = {};
    let position = 4;

    // FLAC metadata blocks: 1 byte (last-block flag + type), 3 byte big endian length
    for (let i = 0; i < 64; i++) {
        const blockHeader = await readBytes(path, 4, position);
        if (blockHeader.length < 4) break;

        const isLast = (blockHeader[0] & 0x80) !== 0;
        const type = blockHeader[0] & 0x7F;
        const length = (blockHeader[1] << 16) | (blockHeader[2] << 8) | blockHeader[3];
        position += 4;

        if (length > 0 && length <= 32 * 1024 * 1024) {
            if (type === 4) {
                const block = await readBytes(path, length, position);
                parseVorbisComment(block, tags);
            } else if (type === 6 && !tags.picture) {
                const block = await readBytes(path, length, position);
                parseFlacPicture(block, tags);
            }
        }

        position += length;
        if (isLast) break;
    }

    return tags;
}

function parseVorbisComment(block: Buffer, tags: ParsedTags) {
    if (block.length < 8) return;

    let cursor = 4 + block.readUInt32LE(0); // skip vendor string
    if (cursor + 4 > block.length) return;

    const count = block.readUInt32LE(cursor);
    cursor += 4;

    for (let i = 0; i < count && cursor + 4 <= block.length; i++) {
        const length = block.readUInt32LE(cursor);
        cursor += 4;
        if (cursor + length > block.length) break;

        const entry = block.toString("utf8", cursor, cursor + length);
        cursor += length;

        const eq = entry.indexOf("=");
        if (eq === -1) continue;

        const key = entry.slice(0, eq).toUpperCase();
        const value = entry.slice(eq + 1).trim();
        if (!value) continue;

        if (key === "TITLE") tags.title ||= value;
        else if (key === "ARTIST") tags.artist ||= value;
        else if (key === "ALBUM") tags.album ||= value;
        // TRACKNUMBER is the standard spelling; TRACK is what several taggers write
        else if (key === "TRACKNUMBER" || key === "TRACK") tags.track ??= parsePosition(value);
        else if (key === "DISCNUMBER" || key === "DISC") tags.disc ??= parsePosition(value);
        // no standard key for these; every tagger picked its own
        else if (key === "LYRICS" || key === "SYNCEDLYRICS" || key === "UNSYNCEDLYRICS") tags.lyrics ||= value;
        // how Ogg and Opus carry cover art: a FLAC picture block in base64, which
        // is the same structure the FLAC reader already decodes
        else if (key === "METADATA_BLOCK_PICTURE" && !tags.picture) {
            try {
                parseFlacPicture(Buffer.from(value, "base64"), tags);
            } catch {
                // a truncated or bogus block just means no cover
            }
        }
    }
}

function parseFlacPicture(block: Buffer, tags: ParsedTags) {
    if (block.length < 8) return;

    let cursor = 4; // picture type
    const mimeLength = block.readUInt32BE(cursor);
    cursor += 4;
    if (cursor + mimeLength > block.length) return;

    const mime = block.toString("latin1", cursor, cursor + mimeLength);
    cursor += mimeLength;
    if (cursor + 4 > block.length) return;

    const descriptionLength = block.readUInt32BE(cursor);
    cursor += 4 + descriptionLength;
    cursor += 16; // width, height, depth, colour count
    if (cursor + 4 > block.length) return;

    const dataLength = block.readUInt32BE(cursor);
    cursor += 4;
    if (dataLength <= 0 || cursor + dataLength > block.length) return;

    tags.picture = { mime: mime || "image/jpeg", data: Buffer.from(block.subarray(cursor, cursor + dataLength)) };
}

// #region MP4 / M4A

/** A `moov` bigger than this is not carrying tags we want badly enough. */
const MAX_MOOV = 64 * 1024 * 1024;

interface Atom {
    type: string;
    /** first byte of the payload, past the header */
    start: number;
    /** one past the last byte of the atom */
    end: number;
}

/**
 * Walks the atoms sitting directly inside `[start, end)`. MP4 is a tree of
 * length-prefixed boxes: 4 byte big endian size, 4 byte type, payload — with
 * size 1 meaning a 64 bit size follows, and 0 meaning "to the end".
 */
function* atoms(buf: Buffer, start: number, end: number): Generator<Atom> {
    let cursor = start;

    while (cursor + 8 <= end) {
        let size = buf.readUInt32BE(cursor);
        const type = buf.toString("latin1", cursor + 4, cursor + 8);
        let header = 8;

        if (size === 1) {
            if (cursor + 16 > end) return;
            // the high word is always 0 for anything that fits in a Buffer
            if (buf.readUInt32BE(cursor + 8) !== 0) return;
            size = buf.readUInt32BE(cursor + 12);
            header = 16;
        } else if (size === 0) {
            size = end - cursor;
        }

        if (size < header || cursor + size > end) return;

        yield { type, start: cursor + header, end: cursor + size };
        cursor += size;
    }
}

function findAtom(buf: Buffer, start: number, end: number, type: string): Atom | null {
    for (const atom of atoms(buf, start, end)) {
        if (atom.type === type) return atom;
    }
    return null;
}

/** Finds `moov` among the top level atoms and reads it in. It can sit at either end. */
async function readMoov(path: string): Promise<Buffer | null> {
    let position = 0;

    for (let i = 0; i < 64; i++) {
        const header = await readBytes(path, 16, position);
        if (header.length < 8) return null;

        let size = header.readUInt32BE(0);
        const type = header.toString("latin1", 4, 8);
        let headerLen = 8;

        if (size === 1) {
            if (header.length < 16 || header.readUInt32BE(8) !== 0) return null;
            size = header.readUInt32BE(12);
            headerLen = 16;
        }

        if (size < headerLen) return null;

        if (type === "moov") {
            const length = size - headerLen;
            if (length <= 0 || length > MAX_MOOV) return null;
            return readBytes(path, length, position + headerLen);
        }

        position += size;
    }

    return null;
}

// iTunes-style keys. The © is a literal 0xA9 byte, which latin1 decodes to U+00A9.
const MP4_TITLE = "\u00A9nam";
const MP4_ARTIST = "\u00A9ART";
const MP4_ALBUM_ARTIST = "aART";
const MP4_ALBUM = "\u00A9alb";
const MP4_LYRICS = "\u00A9lyr";
// these two are binary rather than text: a pair of 16 bit numbers, position then total
const MP4_TRACK = "trkn";
const MP4_DISC = "disk";

/**
 * MP4 / M4A / M4V / MOV all share the same box layout, so one parser covers the
 * lot: `moov > udta > meta > ilst`, with each item holding a `data` box.
 */
async function parseMp4(path: string): Promise<ParsedTags | null> {
    const header = await readBytes(path, 12);
    // every file in the family opens with an ftyp box
    if (header.length < 12 || header.toString("latin1", 4, 8) !== "ftyp") return null;

    const moov = await readMoov(path);
    // it is an MP4, just not one we can read tags out of — claim it either way so
    // the caller doesn't go on to misparse it as something else
    if (!moov) return {};

    const tags: ParsedTags = {};

    const udta = findAtom(moov, 0, moov.length, "udta");
    // `meta` usually hangs off udta, but some writers put it straight under moov
    const meta = udta
        ? findAtom(moov, udta.start, udta.end, "meta") ?? findAtom(moov, 0, moov.length, "meta")
        : findAtom(moov, 0, moov.length, "meta");
    if (!meta) return tags;

    // meta is a full box: 4 bytes of version and flags come before its children
    const ilst = findAtom(moov, meta.start + 4, meta.end, "ilst");
    if (!ilst) return tags;

    for (const item of atoms(moov, ilst.start, ilst.end)) {
        const data = findAtom(moov, item.start, item.end, "data");
        if (!data || data.end - data.start < 8) continue;

        // payload: 1 reserved byte + 3 byte well-known type, 4 byte locale, value
        const kind = moov.readUInt32BE(data.start) & 0xFFFFFF;
        const value = moov.subarray(data.start + 8, data.end);
        if (!value.length) continue;

        const text = () => value.toString("utf8").replace(/\0+$/, "").trim();

        switch (item.type) {
            case MP4_TITLE: tags.title ||= text(); break;
            case MP4_ARTIST: tags.artist ||= text(); break;
            // only a fallback: the track artist is the better answer when both exist
            case MP4_ALBUM_ARTIST: tags.artist ||= text(); break;
            case MP4_ALBUM: tags.album ||= text(); break;
            case MP4_LYRICS: tags.lyrics ||= text(); break;
            case MP4_TRACK: case MP4_DISC: {
                // two reserved bytes, then the position, then the total
                if (value.length < 4) break;

                const position = value.readUInt16BE(2);
                if (position <= 0) break;

                if (item.type === MP4_TRACK) tags.track ??= position;
                else tags.disc ??= position;
                break;
            }
            case "covr":
                if (!tags.picture) {
                    tags.picture = {
                        mime: kind === 14 ? "image/png" : "image/jpeg",
                        data: Buffer.from(value)
                    };
                }
                break;
        }
    }

    return tags;
}

// #endregion

// #region Ogg / Opus

/** Enough for the comment header, including a modest embedded cover. */
const OGG_SCAN_BYTES = 1024 * 1024;

/**
 * Concatenates the payloads of the leading Ogg pages. The comment header is the
 * second packet and can straddle a page boundary, so the pages are stitched back
 * together before anything is looked for inside them.
 */
function joinOggPages(buf: Buffer): Buffer {
    const parts: Buffer[] = [];
    let cursor = 0;

    while (cursor + 27 <= buf.length) {
        if (buf.toString("latin1", cursor, cursor + 4) !== "OggS") break;

        const segments = buf[cursor + 26];
        const tableEnd = cursor + 27 + segments;
        if (tableEnd > buf.length) break;

        let payload = 0;
        for (let i = 0; i < segments; i++) payload += buf[cursor + 27 + i];

        const payloadEnd = tableEnd + payload;
        if (payloadEnd > buf.length) {
            parts.push(buf.subarray(tableEnd));
            break;
        }

        parts.push(buf.subarray(tableEnd, payloadEnd));
        cursor = payloadEnd;
    }

    return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

/**
 * Vorbis and Opus in an Ogg container. Both carry the same comment structure the
 * FLAC reader already understands, behind a different marker.
 */
async function parseOgg(path: string): Promise<ParsedTags | null> {
    const head = await readBytes(path, 4);
    if (head.toString("latin1") !== "OggS") return null;

    const tags: ParsedTags = {};
    const packets = joinOggPages(await readBytes(path, OGG_SCAN_BYTES));
    if (!packets.length) return tags;

    // \x03vorbis introduces the Vorbis comment header; Opus uses OpusTags
    let start = packets.indexOf(Buffer.from("\x03vorbis", "latin1"));
    if (start !== -1) start += 7;
    else {
        start = packets.indexOf(Buffer.from("OpusTags", "latin1"));
        if (start !== -1) start += 8;
    }

    if (start === -1 || start >= packets.length) return tags;

    parseVorbisComment(packets.subarray(start), tags);
    return tags;
}

// #endregion

/**
 * Reads tags for a single file. Returns an empty object rather than throwing so
 * a single malformed file can never take out a whole library scan.
 *
 * Each parser identifies its own format by magic and returns null when the file
 * is not its business, so the chain falls through to the next one.
 */
export async function readTags(path: string): Promise<ParsedTags> {
    try {
        return (await parseId3(path))
            ?? (await parseFlac(path))
            ?? (await parseMp4(path))
            ?? (await parseOgg(path))
            ?? {};
    } catch {
        return {};
    }
}
