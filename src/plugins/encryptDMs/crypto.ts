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

// Wire-compatible port of Aliucord EncryptDMs' RSA.java / EncryptDMs.java protocol.
// This file is PURE WebCrypto — no Vencord imports — so the standalone interop
// test can import it directly under Node's native TypeScript type-stripping.
//
// Protocol (must match the Java plugin byte-for-byte):
// - Identity: RSA-2048 OAEP SHA-256 (MGF1-SHA256, no label) — public key SPKI,
//   private key PKCS#8, both as standard base64 WITH padding, no line wraps
//   (Java Base64.NO_WRAP).
// - Per message: fresh AES-256 key, AES-GCM with 12-byte random IV, 128-bit tag
//   appended to the ciphertext, no AAD.
// - The raw 32-byte AES key is RSA-OAEP-encrypted per recipient.
// - Wire format: "<edm:v1:enc>:" + b64(utf8(JSON {v, keys, iv, cipher})) and
//   "<edm:v1:key>:" + b64(SPKI) for key shares.

export const KEY_PREFIX = "<edm:v1:key>:";
export const ENC_PREFIX = "<edm:v1:enc>:";

/** Max encoded message length; anything longer is treated as an encryption failure (matches Java). */
export const MAX_ENCODED_LENGTH = 1900;

/** JSON payload inside an "<edm:v1:enc>:" message. Field names are fixed by Gson on the Java side. */
export interface EncryptedPayload {
    v: number;
    keys: Record<string, string>;
    iv: string;
    cipher: string;
}

export interface Identity {
    /** b64(SPKI) */
    publicKey: string;
    /** b64(PKCS#8) */
    privateKey: string;
}

export type DecryptFailureReason = "bad-payload" | "missing-private-key" | "no-key" | "failed";

export type DecryptResult =
    | { ok: true; text: string; }
    | { ok: false; reason: DecryptFailureReason; };

const RSA_PARAMS: RsaHashedKeyGenParams = {
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
};

const RSA_IMPORT_PARAMS: RsaHashedImportParams = { name: "RSA-OAEP", hash: "SHA-256" };

// ─── Base64 helpers (standard alphabet, WITH padding — Java Base64.NO_WRAP) ──

export function b64Encode(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function b64Decode(data: string): Uint8Array {
    // Be lenient on input: strip whitespace and re-pad (Android's decoder
    // accepts unpadded input; ours should too).
    let normalized = data.replace(/\s+/g, "");
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

// ─── Identity ────────────────────────────────────────────────────────────────

export async function generateIdentity(): Promise<Identity> {
    const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ["encrypt", "decrypt"]);
    return {
        publicKey: await exportPublicKeyB64(pair.publicKey),
        privateKey: b64Encode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    };
}

export async function exportPublicKeyB64(key: CryptoKey): Promise<string> {
    return b64Encode(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}

/** Throws if the key is not a valid b64 SPKI RSA public key. */
export function importPublicKeyB64(b64: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("spki", b64Decode(b64) as BufferSource, RSA_IMPORT_PARAMS, false, ["encrypt"]);
}

/** Throws if the key is not a valid b64 PKCS#8 RSA private key. */
export function importPrivateKeyB64(b64: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("pkcs8", b64Decode(b64) as BufferSource, RSA_IMPORT_PARAMS, false, ["decrypt"]);
}

// ─── Encryption ──────────────────────────────────────────────────────────────

/**
 * Encrypt plainText for every recipient in recipientPublicKeys
 * (userId -> b64 SPKI; the caller must include the sender's own entry).
 *
 * Returns the full "<edm:v1:enc>:..." message, or null when encryption is not
 * possible: fewer than 2 wrapped keys (only self / no valid recipient keys) or
 * an encoded length above MAX_ENCODED_LENGTH — the same failure conditions as
 * the Java plugin's encryptForChannel.
 */
export async function encryptForRecipients(
    plainText: string,
    recipientPublicKeys: Record<string, string>
): Promise<string | null> {
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const rawAesKey = new Uint8Array(await crypto.subtle.exportKey("raw", aesKey));

    const keys: Record<string, string> = {};
    for (const [userId, publicKeyB64] of Object.entries(recipientPublicKeys)) {
        try {
            const publicKey = await importPublicKeyB64(publicKeyB64);
            const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey as BufferSource);
            keys[userId] = b64Encode(new Uint8Array(wrapped));
        } catch {
            // Skip invalid keys, like the Java plugin does (loadPublicKey == null → continue).
        }
    }
    if (Object.keys(keys).length <= 1) return null;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        aesKey,
        new TextEncoder().encode(plainText) as BufferSource
    );

    const payload: EncryptedPayload = {
        v: 1,
        keys,
        iv: b64Encode(iv),
        cipher: b64Encode(new Uint8Array(cipher)),
    };

    const encoded = ENC_PREFIX + b64Encode(new TextEncoder().encode(JSON.stringify(payload)));
    return encoded.length > MAX_ENCODED_LENGTH ? null : encoded;
}

// ─── Decryption ──────────────────────────────────────────────────────────────

async function tryUnwrapAndDecrypt(
    wrappedKeyB64: string,
    privateKey: CryptoKey,
    ivB64: string,
    cipherB64: string
): Promise<string | null> {
    try {
        const rawKey = await crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            privateKey,
            b64Decode(wrappedKeyB64) as BufferSource
        );
        const aesKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
        const plain = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: b64Decode(ivB64) as BufferSource },
            aesKey,
            b64Decode(cipherB64) as BufferSource
        );
        return new TextDecoder().decode(plain);
    } catch {
        return null;
    }
}

/**
 * Decrypt an "<edm:v1:enc>:..." message. Tries keys[myUserId] first, then
 * falls back to brute-forcing every entry (same as the Java plugin).
 */
export async function decryptPayload(
    content: string,
    privateKeyB64: string,
    myUserId: string
): Promise<DecryptResult> {
    if (!content.startsWith(ENC_PREFIX)) return { ok: false, reason: "failed" };

    let payload: EncryptedPayload | null;
    try {
        const json = new TextDecoder().decode(b64Decode(content.slice(ENC_PREFIX.length)));
        payload = JSON.parse(json);
    } catch {
        return { ok: false, reason: "failed" };
    }
    if (!payload || typeof payload !== "object" || !payload.keys) return { ok: false, reason: "bad-payload" };

    let privateKey: CryptoKey;
    try {
        privateKey = await importPrivateKeyB64(privateKeyB64);
    } catch {
        return { ok: false, reason: "missing-private-key" };
    }

    const myKey = payload.keys[myUserId];
    if (myKey != null) {
        const text = await tryUnwrapAndDecrypt(myKey, privateKey, payload.iv, payload.cipher);
        if (text != null) return { ok: true, text };
    }

    for (const wrapped of Object.values(payload.keys)) {
        if (wrapped === myKey) continue;
        const text = await tryUnwrapAndDecrypt(wrapped, privateKey, payload.iv, payload.cipher);
        if (text != null) return { ok: true, text };
    }

    return { ok: false, reason: "no-key" };
}

/** The user-visible fallback strings, verbatim from EncryptDMs.java. */
export const DECRYPT_FALLBACKS: Record<DecryptFailureReason, string> = {
    "bad-payload": "[EncryptDMs] Encrypted message",
    "missing-private-key": "[EncryptDMs] Missing private key",
    "no-key": "[EncryptDMs] Encrypted message (no key)",
    "failed": "[EncryptDMs] Encrypted message (decrypt failed)",
};

export function isControlMessage(content: string): boolean {
    return content.startsWith(KEY_PREFIX) || content.startsWith(ENC_PREFIX);
}
