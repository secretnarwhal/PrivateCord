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

export const cl = classNameFactory("vc-encryptdms-");

export const AES_LABEL = "AES-256-GCM Encrypted";

export interface ConversionResult {
    text: string;
    encoding: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function uint8ToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
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
// to the first encrypt/decrypt after the secret changes.
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
            //
            // NOTE: this salt string is part of the wire protocol — it is mixed into
            // the derived AES key, so both peers must use the identical value or the
            // same secret yields different keys and nothing decrypts. It is intentionally
            // kept as "vencord-baseconv-v1" (not "encryptdms") so this plugin stays
            // byte-compatible with the original BaseConverter AES format. Do not change it.
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

// ─── Byte-level primitives ────────────────────────────────────────────────────
// Format: iv[12 bytes] || AES-256-GCM ciphertext (with trailing 16-byte auth tag).

export async function aesEncryptBytes(bytes: Uint8Array, secret: string): Promise<Uint8Array> {
    if (!secret) throw new Error("AES secret is not set");

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getAesKey(secret);

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        bytes as BufferSource
    );

    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), 12);
    return combined;
}

export async function aesDecryptBytes(sealed: Uint8Array, secret: string): Promise<Uint8Array> {
    if (!secret) throw new Error("AES secret is not set");
    if (sealed.length < 28) throw new Error("Ciphertext too short");

    const iv = sealed.slice(0, 12);
    const ciphertext = sealed.slice(12);
    const key = await getAesKey(secret);

    const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext as BufferSource
    );
    return new Uint8Array(plaintext);
}

// ─── String encrypt / decrypt ─────────────────────────────────────────────────

// Format: base64( iv[12 bytes] + ciphertext + AES-GCM auth tag[16 bytes] )
// Pipeline: text → UTF-8 bytes → AES-256-GCM encrypt → base64
export async function encrypt(text: string, secret: string): Promise<string> {
    if (!secret) throw new Error("AES secret is not set. Please add a shared secret in the plugin settings.");

    const sealed = await aesEncryptBytes(new TextEncoder().encode(text), secret);
    return uint8ToBase64(sealed);
}

// Returns the decrypted string, or null on any failure (missing secret, malformed
// input, wrong key). Never throws — callers treat null as "not decryptable".
export async function decrypt(text: string, secret: string): Promise<string | null> {
    if (!secret) return null;

    try {
        const sealed = base64ToUint8(text.trim());
        const plaintext = await aesDecryptBytes(sealed, secret);
        // fatal:true so wrong-key/wrong-protocol decrypts that yield invalid UTF-8 throw
        // instead of producing U+FFFD garbage that looks like a successful decrypt.
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
        return null;
    }
}

// Convenience wrapper returning a labelled result for the accessory/cache layer.
export async function decryptMessage(text: string, secret: string): Promise<ConversionResult | null> {
    const plain = await decrypt(text, secret);
    return plain == null ? null : { text: plain, encoding: AES_LABEL };
}
