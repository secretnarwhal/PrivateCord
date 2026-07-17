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

import { aesDecryptBytes, aesEncryptBytes } from "./utils";

// 8-byte magic: "VCENC" + version(1) + reserved(0,0). Present in cleartext so
// receivers can recognize the format without attempting to decrypt every
// unknown attachment.
const MAGIC = new Uint8Array([0x56, 0x43, 0x45, 0x4e, 0x43, 0x01, 0x00, 0x00]);

export const ENCRYPTED_FILE_EXTENSION = ".vcenc";

const MIME_FALLBACK = "application/octet-stream";

interface FileMeta {
    filename: string;
    mimeType: string;
}

function packMeta(m: FileMeta): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(m));
    if (json.length > 0xffff) throw new Error("Attachment metadata too large");
    const out = new Uint8Array(2 + json.length);
    out[0] = (json.length >> 8) & 0xff;
    out[1] = json.length & 0xff;
    out.set(json, 2);
    return out;
}

function unpackMeta(bytes: Uint8Array): { meta: FileMeta; payload: Uint8Array; } {
    if (bytes.length < 2) throw new Error("Invalid encrypted payload");
    const len = (bytes[0] << 8) | bytes[1];
    if (bytes.length < 2 + len) throw new Error("Invalid encrypted payload");
    const meta = JSON.parse(new TextDecoder().decode(bytes.slice(2, 2 + len))) as FileMeta;
    return { meta, payload: bytes.slice(2 + len) };
}

export function hasMagic(bytes: Uint8Array): boolean {
    if (bytes.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i++) {
        if (bytes[i] !== MAGIC[i]) return false;
    }
    return true;
}

export function isEncryptedAttachmentName(filename: string | undefined): boolean {
    return !!filename && filename.toLowerCase().endsWith(ENCRYPTED_FILE_EXTENSION);
}

function randomFileBase(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Encrypt a File for sending. Returns a new File whose bytes are
 * MAGIC || iv[12] || AES-256-GCM(metadata-prefixed payload).
 * Original filename and mime type are sealed inside the ciphertext so Discord
 * never sees them.
 */
export async function encryptFile(file: File, secret: string): Promise<File> {
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const meta = packMeta({
        filename: file.name,
        mimeType: file.type || MIME_FALLBACK,
    });

    const plaintext = new Uint8Array(meta.length + fileBytes.length);
    plaintext.set(meta, 0);
    plaintext.set(fileBytes, meta.length);

    const sealed = await aesEncryptBytes(plaintext, secret);
    const out = new Uint8Array(MAGIC.length + sealed.length);
    out.set(MAGIC, 0);
    out.set(sealed, MAGIC.length);

    const encryptedName = `${randomFileBase()}${ENCRYPTED_FILE_EXTENSION}`;
    return new File([out], encryptedName, { type: MIME_FALLBACK });
}

export interface DecryptedAttachment {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
}

export async function decryptAttachmentBytes(bytes: Uint8Array, secret: string): Promise<DecryptedAttachment> {
    if (!hasMagic(bytes)) throw new Error("Not an encrypted attachment");
    const sealed = bytes.slice(MAGIC.length);
    const plaintext = await aesDecryptBytes(sealed, secret);
    const { meta, payload } = unpackMeta(plaintext);
    return { bytes: payload, filename: meta.filename, mimeType: meta.mimeType };
}
