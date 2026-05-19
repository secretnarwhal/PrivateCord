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

import { classNameFactory } from "@utils/css";

export const cl = classNameFactory("vc-baseconv-");

export type EncodingType = "auto" | "binary" | "octal" | "decimal" | "hex" | "base32" | "base64" | "utf8" | "aes";
export type EncodeTarget = Exclude<EncodingType, "auto">;

export interface ConversionResult {
    text: string;
    encoding: string;
}

export const ENCODING_LABELS: Record<EncodingType, string> = {
    auto: "Auto-Detect",
    binary: "Binary (Base 2)",
    octal: "Octal (Base 8)",
    decimal: "Decimal (Base 10)",
    hex: "Hexadecimal (Base 16)",
    base32: "Base 32",
    base64: "Base 64",
    utf8: "UTF-8 Bytes",
    aes: "AES-256-GCM Encrypted",
};

const DECODE_ENCODING_ORDER: EncodingType[] = ["auto", "binary", "octal", "decimal", "hex", "base32", "base64", "utf8", "aes"];
const ENCODE_ENCODING_ORDER: EncodeTarget[] = ["binary", "octal", "decimal", "hex", "base32", "base64", "utf8", "aes"];

export const DECODE_OPTIONS = DECODE_ENCODING_ORDER.map((v, i) => ({
    label: ENCODING_LABELS[v],
    value: v,
    ...(i === 0 ? { default: true } : {}),
}));

export const ENCODE_OPTIONS = ENCODE_ENCODING_ORDER.map((v, i) => ({
    label: ENCODING_LABELS[v],
    value: v,
    ...(i === 0 ? { default: true } : {}),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
    let normalized = base64
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .replace(/\s+/g, "");
    if (normalized.length % 4 !== 0) {
        normalized += "=".repeat(4 - (normalized.length % 4));
    }
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ─── AES Key Derivation (cached per secret) ───────────────────────────────────

// Derive the key once per secret value and reuse it. PBKDF2 with 100k iterations
// is intentionally slow for brute-force resistance; caching amortizes that cost
// to the first encode/decode after the secret changes.
const KEY_CACHE_MAX = 50;
const keyCache = new Map<string, CryptoKey>();

async function getAesKey(secret: string): Promise<CryptoKey> {
    if (keyCache.has(secret)) {
        const hit = keyCache.get(secret)!;
        keyCache.delete(secret);
        keyCache.set(secret, hit);
        return hit;
    }

    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    const key = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            // Fixed salt means a precomputed dictionary attack on the shared password is
            // possible across all users of this plugin. The per-message IV provides
            // ciphertext semantic security but does not protect against offline
            // password brute-force. Acceptable for casual obfuscation; not for high-value secrets.
            salt: new TextEncoder().encode("vencord-baseconv-v1"),
            iterations: 100_000,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );

    if (keyCache.size >= KEY_CACHE_MAX)
        keyCache.delete(keyCache.keys().next().value!);
    keyCache.set(secret, key);
    return key;
}

// ─── Decoders ────────────────────────────────────────────────────────────────

function decodeBinary(text: string): string {
    const parts = text.trim().split(/\s+/);
    if (!parts.every(p => /^[01]{8}$/.test(p))) throw new Error("Invalid binary");
    return new TextDecoder().decode(new Uint8Array(parts.map(b => parseInt(b, 2))));
}

function decodeOctal(text: string): string {
    const parts = text.trim().split(/\s+/);
    if (!parts.every(p => /^[0-7]+$/.test(p))) throw new Error("Invalid octal");
    const bytes = parts.map(o => parseInt(o, 8));
    if (!bytes.every(b => b <= 255)) throw new Error("Octal value out of byte range (0–377)");
    return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeDecimal(text: string): string {
    const parts = text.trim().split(/\s+/);
    if (!parts.every(p => /^\d+$/.test(p))) throw new Error("Invalid decimal");
    const bytes = parts.map(Number);
    if (!bytes.every(b => b <= 255)) throw new Error("Decimal value out of byte range (0–255)");
    return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeHex(text: string): string {
    const stripped = text.trim().replace(/(^|\s)0x/gi, "$1");
    const cleaned = /\s/.test(stripped)
        ? stripped.split(/\s+/).map(s => s.padStart(2, "0")).join("")
        : stripped;
    if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0)
        throw new Error("Invalid hex");
    return new TextDecoder().decode(new Uint8Array(cleaned.match(/.{2}/g)!.map(h => parseInt(h, 16))));
}

function decodeBase32(text: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const trimmed = text.trim().toUpperCase();
    const paddingMatch = trimmed.match(/=+$/);
    const padding = paddingMatch ? paddingMatch[0].length : 0;
    const input = trimmed.replace(/=+$/, "");
    if (padding > 6) throw new Error("Invalid base32 padding");
    if (padding > 0 && (input.length + padding) % 8 !== 0) throw new Error("Invalid base32 padding");
    if ([1, 3, 6].includes(input.length % 8)) throw new Error("Invalid base32 length");
    if (!/^[A-Z2-7]*$/.test(input)) throw new Error("Invalid base32");
    const bytes: number[] = [];
    let bits = 0, value = 0;
    for (const ch of input) {
        const idx = alphabet.indexOf(ch);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64(text: string): string {
    return new TextDecoder().decode(base64ToUint8(text.trim()));
}

// Interpret space-separated hex pairs as raw UTF-8 bytes.
function decodeUtf8(text: string): string {
    const stripped = text.trim().replace(/(^|\s)0x/gi, "$1");
    const cleaned = /\s/.test(stripped)
        ? stripped.split(/\s+/).map(s => s.padStart(2, "0")).join("")
        : stripped;
    if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0)
        throw new Error("Invalid UTF-8 hex string");
    const bytes = new Uint8Array(cleaned.match(/.{2}/g)!.map(h => parseInt(h, 16)));
    return new TextDecoder().decode(bytes);
}

// Format: base64( iv[12 bytes] + ciphertext + AES-GCM auth tag[16 bytes] )
async function decodeAes(text: string, secret: string): Promise<string> {
    if (!secret) throw new Error("AES secret is not set");

    const raw = base64ToUint8(text.trim());
    if (raw.length < 28) throw new Error("Ciphertext too short");

    const iv = raw.slice(0, 12);
    const ciphertext = raw.slice(12);
    const key = await getAesKey(secret);

    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
    );

    // fatal:true so wrong-key/wrong-protocol decrypts that yield invalid UTF-8 throw
    // instead of producing U+FFFD garbage that looks like a successful decode.
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}

// ─── Encoders ────────────────────────────────────────────────────────────────

function encodeBinary(text: string): string {
    return Array.from(new TextEncoder().encode(text)).map(b => b.toString(2).padStart(8, "0")).join(" ");
}

function encodeOctal(text: string): string {
    return Array.from(new TextEncoder().encode(text)).map(b => b.toString(8)).join(" ");
}

function encodeDecimal(text: string): string {
    return Array.from(new TextEncoder().encode(text)).map(b => String(b)).join(" ");
}

function encodeHex(text: string): string {
    return Array.from(new TextEncoder().encode(text)).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

function encodeBase32(text: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const input = new TextEncoder().encode(text);
    let bits = 0, value = 0, output = "";
    for (const b of input) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    while (output.length % 8 !== 0) output += "=";
    return output;
}

function encodeBase64(text: string): string {
    return uint8ToBase64(new TextEncoder().encode(text));
}

// Encode text as its raw UTF-8 bytes expressed as space-separated hex pairs.
// "Hello" → "48 65 6c 6c 6f"
// "é" → "c3 a9"  (two bytes — distinct from Latin-1 hex encode)
function encodeUtf8(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

// Format: base64( iv[12 bytes] + ciphertext + AES-GCM auth tag[16 bytes] )
// Pipeline: text → UTF-8 bytes → AES-256-GCM encrypt → base64
async function encodeAes(text: string, secret: string): Promise<string> {
    if (!secret) throw new Error("AES secret is not set. Please add a shared secret in the plugin settings.");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getAesKey(secret);
    const plaintext = new TextEncoder().encode(text);

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        plaintext
    );

    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), 12);

    return uint8ToBase64(combined);
}

// ─── Auto-Detection ───────────────────────────────────────────────────────────
// AES output is intentionally indistinguishable from random base64, so we
// never attempt to auto-detect it — users must explicitly select "AES".

export function autoDetectEncoding(text: string): Exclude<EncodeTarget, "aes"> | null {
    const t = text.trim();

    if (/^[01]{8}( [01]{8})*$/.test(t)) return "binary";

    if (/^0x[0-9a-fA-F]{2}( 0x[0-9a-fA-F]{2})+$/.test(t)) return "hex";

    if (/^[0-9a-fA-F]{2}( [0-9a-fA-F]{2})+$/.test(t) && /[a-fA-F]/.test(t)) return "hex";

    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0 && t.length >= 4 && /[a-fA-F]/.test(t) && /[0-9]/.test(t)) return "hex";

    if (/^[A-Z2-7]+=*$/.test(t) && t.length >= 8 && t.length % 8 === 0) return "base32";

    const hasPadding = /=$/.test(t);
    const hasMixedCaseAndExtra = /[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9+/]/.test(t);
    if (/^[A-Za-z0-9+/]+=*$/.test(t) && t.length >= 8 && t.length % 4 === 0 && (hasPadding || hasMixedCaseAndExtra)) return "base64";

    if (/^\d+( \d+)+$/.test(t)) {
        const codes = t.split(/\s+/).map(Number);
        // Digits 8–9 cannot appear in octal, so their presence is an unambiguous decimal signal.
        if (codes.length >= 3 && codes.every(n => n >= 32 && n <= 126) && /[89]/.test(t)) return "decimal";
    }

    if (/^[0-7]{1,4}( [0-7]{1,4})+$/.test(t)) {
        const codes = t.split(/\s+/).map(o => parseInt(o, 8));
        if (codes.every(n => n >= 32 && n <= 126)) return "octal";
    }

    // Fallback: octal-digit sequences whose decoded values aren't printable ASCII
    // are more likely decimal byte codes.
    if (/^\d+( \d+)+$/.test(t)) {
        const codes = t.split(/\s+/).map(Number);
        if (codes.length >= 3 && codes.every(n => n >= 32 && n <= 126)) return "decimal";
    }

    return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type DecodeError = "invalid-format" | "wrong-key" | "too-short" | "no-detection";
export type DecodeResult = { ok: true; result: ConversionResult } | { ok: false; error: DecodeError };

function classifyError(err: unknown): DecodeError {
    if (err instanceof Error) {
        if (err.name === "OperationError") return "wrong-key";
        if (err.message.toLowerCase().includes("too short")) return "too-short";
    }
    return "invalid-format";
}

export async function decodeWithError(
    text: string,
    encoding: EncodingType,
    aesSecret?: string
): Promise<DecodeResult> {
    try {
        let target: EncodeTarget;

        if (encoding === "auto") {
            // AES output is valid base64, so try AES first when a secret is set
            // to avoid misidentifying encrypted messages as regular base64.
            if (aesSecret) {
                try {
                    const aesResult = await decodeAes(text, aesSecret);
                    if (aesResult !== "" && aesResult != null) {
                        return { ok: true, result: { text: aesResult, encoding: ENCODING_LABELS["aes"] } };
                    }
                } catch {
                    // AES failed — fall through to normal auto-detect
                }
            }
            const detected = autoDetectEncoding(text);
            if (!detected) return { ok: false, error: "no-detection" };
            target = detected;
        } else {
            target = encoding;
        }

        let result: string;
        try {
            switch (target) {
                case "binary":  result = decodeBinary(text);  break;
                case "octal":   result = decodeOctal(text);   break;
                case "decimal": result = decodeDecimal(text); break;
                case "hex":     result = decodeHex(text);     break;
                case "base32":  result = decodeBase32(text);  break;
                case "base64":  result = decodeBase64(text);  break;
                case "utf8":    result = decodeUtf8(text);    break;
                case "aes":     result = await decodeAes(text, aesSecret ?? ""); break;
            }
        } catch (err) {
            return { ok: false, error: classifyError(err) };
        }

        if (result === "") return { ok: false, error: "invalid-format" };

        return { ok: true, result: { text: result, encoding: ENCODING_LABELS[target] } };
    } catch (err) {
        return { ok: false, error: classifyError(err) };
    }
}

export async function decode(
    text: string,
    encoding: EncodingType,
    aesSecret?: string
): Promise<ConversionResult | null> {
    const res = await decodeWithError(text, encoding, aesSecret);
    return res.ok ? res.result : null;
}

export async function encode(
    text: string,
    encoding: EncodeTarget,
    aesSecret?: string
): Promise<string> {
    switch (encoding) {
        case "binary":  return encodeBinary(text);
        case "octal":   return encodeOctal(text);
        case "decimal": return encodeDecimal(text);
        case "hex":     return encodeHex(text);
        case "base32":  return encodeBase32(text);
        case "base64":  return encodeBase64(text);
        case "utf8":    return encodeUtf8(text);
        case "aes":     return encodeAes(text, aesSecret ?? "");
    }
}
