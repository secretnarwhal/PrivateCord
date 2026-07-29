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
    picture?: { mime: string; data: Buffer; };
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

    const major = header[4];
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

/**
 * Reads tags for a single file. Returns an empty object rather than throwing so
 * a single malformed file can never take out a whole library scan.
 *
 * MP4/M4A atoms are not parsed, those fall back to the file name.
 */
export async function readTags(path: string): Promise<ParsedTags> {
    try {
        return (await parseId3(path)) ?? (await parseFlac(path)) ?? {};
    } catch {
        return {};
    }
}
