/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { GROUP_KEY_PREFIX } from "./protocol";

const HKDF_SALT = "vc-lm-listen-along";

function toBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
    try {
        const padded = text.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

/**
 * Mints the shareable group key: the host's user id (so joiners know whom to
 * DM) plus a fresh secret (so only people who were handed the key can).
 */
export function generateGroupKey(hostUserId: string): { key: string; secret: Uint8Array<ArrayBuffer>; } {
    const secret = crypto.getRandomValues(new Uint8Array(16));
    const body = JSON.stringify({ v: 1, h: hostUserId, s: toBase64Url(secret) });
    return { key: GROUP_KEY_PREFIX + toBase64Url(new TextEncoder().encode(body)), secret };
}

export function parseGroupKey(key: string): { hostUserId: string; secret: Uint8Array<ArrayBuffer>; } | null {
    if (!key.startsWith(GROUP_KEY_PREFIX)) return null;

    const raw = fromBase64Url(key.slice(GROUP_KEY_PREFIX.length));
    if (!raw) return null;

    try {
        const { v, h, s } = JSON.parse(new TextDecoder().decode(raw));
        if (v !== 1 || typeof h !== "string" || typeof s !== "string") return null;

        const secret = fromBase64Url(s);
        if (!secret?.length) return null;

        return { hostUserId: h, secret };
    } catch {
        return null;
    }
}

/** HKDF the shared secret into the AES key that seals every signaling message. */
export async function deriveAesKey(secret: Uint8Array<ArrayBuffer>, hostUserId: string): Promise<CryptoKey> {
    // copy into a fresh buffer so the key data is a plain ArrayBuffer
    const raw = new Uint8Array(secret.length);
    raw.set(secret);
    const material = await crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);

    return crypto.subtle.deriveKey(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new TextEncoder().encode(HKDF_SALT),
            info: new TextEncoder().encode(hostUserId)
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

/**
 * AES-GCM with the sender and per-message sequence as AAD, so a message can't
 * be replayed as someone else's or reflected back at its author.
 */
export async function sealSignal(key: CryptoKey, senderId: string, seq: string, obj: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${senderId}:${seq}`) },
        key,
        new TextEncoder().encode(JSON.stringify(obj))
    );

    const out = new Uint8Array(iv.length + ciphertext.byteLength);
    out.set(iv);
    out.set(new Uint8Array(ciphertext), iv.length);
    return toBase64Url(out);
}

/** Returns null on any failure — garbage and wrong-key messages are silently ignored. */
export async function openSignal(key: CryptoKey, senderId: string, seq: string, text: string): Promise<any | null> {
    const raw = fromBase64Url(text);
    if (!raw || raw.length <= 12) return null;

    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: new TextEncoder().encode(`${senderId}:${seq}`) },
            key,
            raw.subarray(12)
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
        return null;
    }
}

/** Used by the host to mint session-scoped track ids from its file paths. */
export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
    return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}
