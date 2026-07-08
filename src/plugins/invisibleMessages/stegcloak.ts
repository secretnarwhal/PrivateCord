/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Pure StegCloak core — byte-for-byte wire-compatible with both the Aliucord
// InvisibleMessages plugin (InvChatAPI.java) and the reference `stegcloak` npm
// package (hsp/stegcloak). It hides an AES-256-CTR-encrypted secret inside a
// visible "cover" message using zero-width Unicode characters (ZWC).
//
// This file has NO Vencord imports and uses only WebCrypto (crypto.subtle) plus
// standard JS, so the standalone interop test can import it directly under
// Node's native TypeScript type-stripping.
//
// Protocol (must match both references):
//   - ZWC alphabet of 6 chars maps 2 bits each (indices 0..3), with a leading
//     flag char and a Huffman run-length compression flag.
//   - Payload = salt(8) ++ [hmac(32) if integrity] ++ AES-256-CTR(secret).
//   - Key material = PBKDF2-SHA512(password, salt, 10000, 48) split into
//     iv = derived[0:16] and key = derived[16:48].
//   - The secret bytes are UTF-8 (identity "compress" on encode; full LZUTF8
//     decompress on decode) and bitwise-complemented before/after crypto.

// 200c, 200d, 2061, 2062, 2063, 2064 — where the magic happens.
export const ZWC: string[] = ["‌", "‍", "⁡", "⁢", "⁣", "⁤"];

const HUFFMAN_TABLE: string[] = [
    ZWC[0] + ZWC[1],
    ZWC[0] + ZWC[2],
    ZWC[0] + ZWC[3],
    ZWC[1] + ZWC[2],
    ZWC[1] + ZWC[3],
    ZWC[2] + ZWC[3],
];

interface ConcealedData {
    data: Uint8Array;
    encrypt: boolean;
    integrity: boolean;
}

interface KeyMaterial {
    iv: Uint8Array;
    key: Uint8Array;
}

// ─── Encoding-agnostic helpers ────────────────────────────────────────────────

const utf8Encode = (input: string): Uint8Array => new TextEncoder().encode(input);
const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function zwcIndex(character: string): number {
    return ZWC.indexOf(character);
}

/** Bitwise NOT of each byte, kept unsigned — matches Java `(byte) ~x` / stegcloak `~x` truncated. */
function complement(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = (~data[i]) & 0xff;
    return out;
}

function concat(arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/** Crypto-random int in [0, bound). Placement only — not security-critical. */
function randomInt(bound: number): number {
    const buf = crypto.getRandomValues(new Uint32Array(1));
    return buf[0] % bound;
}

/** Replace ALL occurrences of `target` (Java String.replace / stegcloak /g regex). */
function replaceAllOccurrences(input: string, target: string, replacement: string): string {
    return input.split(target).join(replacement);
}

// ─── WebCrypto primitives ─────────────────────────────────────────────────────

// PBKDF2-SHA512(password_utf8, salt, 10000, 48) → iv[0:16], key[16:48] (AES-256).
async function createKeyMaterial(password: string, salt: Uint8Array): Promise<KeyMaterial> {
    const baseKey = await crypto.subtle.importKey(
        "raw",
        utf8Encode(password) as BufferSource,
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt as BufferSource, iterations: 10000, hash: "SHA-512" },
        baseKey,
        48 * 8
    );
    const derived = new Uint8Array(bits);
    return { iv: derived.slice(0, 16), key: derived.slice(16, 48) };
}

// AES-256-CTR with a full 128-bit counter (matches OpenSSL aes-256-ctr / JCE
// AES/CTR/NoPadding). CTR is its own inverse, so the encrypt op serves both
// directions.
async function aesCtr(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key as BufferSource,
        { name: "AES-CTR" },
        false,
        ["encrypt", "decrypt"]
    );
    const result = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: iv as BufferSource, length: 128 },
        cryptoKey,
        data as BufferSource
    );
    return new Uint8Array(result);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, data as BufferSource);
    return new Uint8Array(sig);
}

// ─── Payload (crypto) layer ───────────────────────────────────────────────────

async function encryptPayload(password: string, secret: Uint8Array, integrity: boolean): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(8));
    const { iv, key } = await createKeyMaterial(password, salt);
    const encrypted = await aesCtr(secret, key, iv);

    const parts: Uint8Array[] = [salt];
    // HMAC is over the PLAINTEXT secret bytes, keyed with the 32-byte AES key.
    if (integrity) parts.push(await hmacSha256(key, secret));
    parts.push(encrypted);
    return concat(parts);
}

async function decryptPayload(password: string, payload: Uint8Array, integrity: boolean): Promise<Uint8Array> {
    const hmacLength = integrity ? 32 : 0;
    if (payload.length < 8 + hmacLength) throw new Error("Invalid StegCloak payload");

    const salt = payload.slice(0, 8);
    const expectedHmac = integrity ? payload.slice(8, 40) : null;
    const encrypted = payload.slice(8 + hmacLength);
    const { iv, key } = await createKeyMaterial(password, salt);
    const decrypted = await aesCtr(encrypted, key, iv);

    if (integrity && expectedHmac) {
        const actual = await hmacSha256(key, decrypted);
        if (!constantTimeEqual(expectedHmac, actual)) {
            throw new Error("Wrong password or invalid payload");
        }
    }

    return decrypted;
}

// ─── ZWC concealment layer ────────────────────────────────────────────────────

// Each byte becomes 4 ZWC chars (2 bits each, MSB-first), preceded by a flag char.
function toConceal(payload: Uint8Array, encrypt: boolean, integrity: boolean): string {
    let result = integrity && encrypt ? ZWC[0] : encrypt ? ZWC[1] : ZWC[2];
    for (const value of payload) {
        const unsigned = value & 0xff;
        for (let shift = 6; shift >= 0; shift -= 2) {
            result += ZWC[(unsigned >>> shift) & 3];
        }
    }
    return result;
}

function concealToData(stream: string): ConcealedData {
    if (!stream || stream.length < 2) throw new Error("Invalid invisible stream");

    const flag = zwcIndex(stream[0]);
    let encrypt: boolean;
    let integrity: boolean;
    if (flag === 0) {
        encrypt = true;
        integrity = true;
    } else if (flag === 1) {
        encrypt = true;
        integrity = false;
    } else if (flag === 2) {
        encrypt = false;
        integrity = false;
    } else {
        throw new Error("Unknown StegCloak payload flag");
    }

    const bytes: number[] = [];
    let current = 0;
    let bitCount = 0;
    for (let i = 1; i < stream.length; i++) {
        const value = zwcIndex(stream[i]);
        if (value < 0 || value > 3) throw new Error("Invalid payload character");
        current = (current << 2) | value;
        bitCount += 2;
        if (bitCount === 8) {
            bytes.push(current);
            current = 0;
            bitCount = 0;
        }
    }

    return { data: Uint8Array.from(bytes), encrypt, integrity };
}

// ─── Huffman run-length compression of the ZWC stream ─────────────────────────

function findOptimal(secret: string): string[] {
    // Only zwc[0..3] carry data (the flag is always one of zwc[0..2]).
    const dict = new Map<string, Map<number, number>>();
    for (let i = 0; i < 4; i++) dict.set(ZWC[i], new Map());

    for (let j = 0; j < secret.length; j++) {
        let count = 1;
        while (j < secret.length - 1 && secret[j] === secret[j + 1]) {
            count++;
            j++;
        }
        const ch = secret[j];
        const stats = dict.get(ch);
        if (count >= 2 && stats) {
            for (let itr = count; itr >= 2; itr--) {
                const value = (stats.get(itr) ?? 0) + Math.floor(count / itr) * (itr - 1);
                stats.set(itr, value);
            }
        }
    }

    // Rank by the run-length-2 score, descending. Iterate zwc[0..3] in index
    // order so ties break the same way the reference stegcloak does (its `for..in`
    // over an insertion-ordered dict). See report note re: Java HashMap order.
    const ranked: { character: string; score: number; }[] = [];
    for (let i = 0; i < 4; i++) {
        const ch = ZWC[i];
        const score = dict.get(ch)!.get(2);
        if (score !== undefined) ranked.push({ character: ch, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    const required: string[] = [];
    for (const repeat of ranked) {
        if (required.length === 2) break;
        required.push(repeat.character);
    }
    for (let i = 0; i < 4 && required.length < 2; i++) {
        if (!required.includes(ZWC[i])) required.push(ZWC[i]);
    }

    // Sort the pair ascending by code unit (Java Arrays.sort(char[]) / JS .sort()).
    const result = [required[0], required[1]];
    result.sort();
    return result;
}

function getCompressFlag(zwc1: string, zwc2: string): string {
    const value = zwc1 + zwc2;
    const index = HUFFMAN_TABLE.indexOf(value);
    if (index < 0) throw new Error("Invalid compression flags");
    return ZWC[index];
}

function extractCompressFlag(flag: string): string[] {
    const index = zwcIndex(flag);
    if (index < 0 || index >= HUFFMAN_TABLE.length) throw new Error("Invalid compression flag");
    return HUFFMAN_TABLE[index].split("");
}

function shrink(secret: string): string {
    const repeatChars = findOptimal(secret);
    // Order matters: collapse the higher char's double first (zwc[5]), then the
    // lower char's double (zwc[4]) — matches Java shrink() and stegcloak's
    // recursiveReplace (last-to-first).
    let invisibleStream = replaceAllOccurrences(secret, repeatChars[1] + repeatChars[1], ZWC[5]);
    invisibleStream = replaceAllOccurrences(invisibleStream, repeatChars[0] + repeatChars[0], ZWC[4]);
    return getCompressFlag(repeatChars[0], repeatChars[1]) + invisibleStream;
}

function expand(secret: string): string {
    if (!secret) throw new Error("Invalid invisible stream");
    const repeatChars = extractCompressFlag(secret[0]);
    let invisibleStream = secret.slice(1);
    // Reverse of shrink: expand zwc[5] first, then zwc[4].
    invisibleStream = replaceAllOccurrences(invisibleStream, ZWC[5], repeatChars[1] + repeatChars[1]);
    return replaceAllOccurrences(invisibleStream, ZWC[4], repeatChars[0] + repeatChars[0]);
}

// ─── Cover-text embedding / detaching ─────────────────────────────────────────

function embed(cover: string, secret: string): string {
    const words = cover.split(" ");
    const targetIndex = randomInt(Math.max(1, Math.floor(words.length / 2)));
    words[targetIndex + 1] = secret + words[targetIndex + 1];
    return words.join(" ");
}

function detach(message: string): string {
    const words = message.split(" ");
    let detached = "";
    for (const word of words) {
        let limit = -1;
        for (let i = 0; i < word.length; i++) {
            if (zwcIndex(word[i]) < 0) {
                limit = i;
                break;
            }
        }
        if (limit > 0) detached = word.slice(0, limit);
    }

    if (!detached) throw new Error("Invisible stream not detected");
    return detached;
}

// ─── LZUTF8 decompression (decode side only) ──────────────────────────────────
// Direct transcription of InvChatAPI.java decompress(); expands LZUTF8
// back-references so we can read secrets produced by the real stegcloak tool.
// Reads from the live output buffer so overlapping/self-referential matches copy
// freshly-written bytes (standard LZ behaviour; matches the Java re-snapshotting).
function decompress(input: Uint8Array): string {
    const output: number[] = [];

    for (let readPosition = 0; readPosition < input.length; readPosition++) {
        const inputValue = input[readPosition] & 0xff;
        if (inputValue >>> 6 !== 3) {
            output.push(inputValue);
            continue;
        }

        const sequenceLengthIdentifier = inputValue >>> 5; // 6 or 7
        if (readPosition === input.length - 1 || (readPosition === input.length - 2 && sequenceLengthIdentifier === 7)) {
            output.push(inputValue);
            continue;
        }

        const next = input[readPosition + 1] & 0xff;
        if (next >>> 7 === 1) {
            // UTF-8 continuation byte → treat as a literal, not a back-reference.
            output.push(inputValue);
            continue;
        }

        const matchLength = inputValue & 31;
        let matchDistance: number;
        if (sequenceLengthIdentifier === 6) {
            matchDistance = next;
            readPosition += 1;
        } else {
            matchDistance = (next << 8) | (input[readPosition + 2] & 0xff);
            readPosition += 2;
        }

        const matchPosition = output.length - matchDistance;
        if (matchPosition < 0) throw new Error("Invalid LZUTF8 back-reference");
        for (let offset = 0; offset < matchLength; offset++) {
            output.push(output[matchPosition + offset]);
        }
    }

    return utf8Decode(Uint8Array.from(output));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** True if the message contains any of the 6 ZWC characters. */
export function containsInvisibleMessage(message: string | null | undefined): boolean {
    if (!message) return false;
    return ZWC.some(zwc => message.includes(zwc));
}

/**
 * Hide `secret` (encrypted with `password`) inside the visible `cover` text.
 * Always encrypts with integrity disabled — the same mode the Aliucord plugin
 * uses — producing a stream both references can decode.
 */
export async function encrypt(password: string, secret: string, cover: string): Promise<string> {
    if (cover == null || cover.split(" ").length < 2) {
        throw new Error("Minimum two words required");
    }

    const compressed = utf8Encode(secret); // identity "compress" (matches Java compress())
    const payload = await encryptPayload(password, complement(compressed), false);
    const invisibleStream = shrink(toConceal(payload, true, false));
    return embed(cover, invisibleStream);
}

/** Extract and decrypt the invisible stream hidden in `message` using `password`. */
export async function decrypt(message: string, password: string): Promise<string> {
    const expanded = expand(detach(message));
    const { data, encrypt: isEncrypted, integrity } = concealToData(expanded);
    const decrypted = isEncrypted ? await decryptPayload(password, data, integrity) : data;
    return decompress(complement(decrypted));
}
