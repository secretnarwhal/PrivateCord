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

import { MessageAttachment } from "@vencord/discord-types";
import { useEffect, useMemo, useState } from "@webpack/common";

import { decryptAttachmentBytes, isEncryptedAttachmentName } from "./encryptedAttachment";
import { cl } from "./utils";

interface DecryptedItem {
    id: string;
    filename: string;
    mimeType: string;
    objectUrl: string;
}

interface FailedItem {
    id: string;
    error: string;
}

type Item = DecryptedItem | FailedItem;

function isFailed(i: Item): i is FailedItem {
    return (i as FailedItem).error != null;
}

function classifyMime(mime: string): "image" | "video" | "audio" | "other" {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "other";
}

export function EncryptedAttachments({
    attachments,
    secret,
    enabled,
}: {
    attachments: MessageAttachment[] | undefined;
    secret: string;
    enabled: boolean;
}) {
    const encrypted = useMemo(
        () => (attachments ?? []).filter(a => isEncryptedAttachmentName(a.filename)),
        [attachments]
    );

    const [items, setItems] = useState<Item[]>([]);

    // Discord's CDN URLs are time-signed. We refetch whenever the URL list changes;
    // a stale URL just produces a one-shot error item, which is fine.
    const urlsKey = encrypted.map(a => a.url).join("|");

    useEffect(() => {
        if (!enabled || !secret || encrypted.length === 0) {
            setItems([]);
            return;
        }

        let cancelled = false;
        const createdUrls: string[] = [];

        (async () => {
            const out: Item[] = [];
            for (const att of encrypted) {
                try {
                    const resp = await fetch(att.url);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const bytes = new Uint8Array(await resp.arrayBuffer());
                    const dec = await decryptAttachmentBytes(bytes, secret);
                    const blob = new Blob([dec.bytes as BlobPart], { type: dec.mimeType });
                    const objectUrl = URL.createObjectURL(blob);
                    createdUrls.push(objectUrl);
                    out.push({
                        id: att.id,
                        filename: dec.filename,
                        mimeType: dec.mimeType,
                        objectUrl,
                    });
                } catch (err) {
                    const isWrongKey = err instanceof Error && err.name === "OperationError";
                    out.push({
                        id: att.id,
                        error: isWrongKey
                            ? "Wrong key — couldn't decrypt this attachment."
                            : "Failed to decrypt attachment.",
                    });
                }
            }
            if (cancelled) {
                createdUrls.forEach(URL.revokeObjectURL);
                return;
            }
            setItems(out);
        })();

        return () => {
            cancelled = true;
            createdUrls.forEach(URL.revokeObjectURL);
        };
    }, [urlsKey, secret, enabled]);

    if (encrypted.length === 0 || items.length === 0) return null;

    return (
        <div className={cl("encrypted-attachments")}>
            {items.map(item => {
                if (isFailed(item)) {
                    return (
                        <div key={item.id} className={cl("attachment-error")}>
                            {item.error}
                        </div>
                    );
                }
                const kind = classifyMime(item.mimeType);
                if (kind === "image") {
                    return (
                        <a key={item.id} href={item.objectUrl} target="_blank" rel="noreferrer" download={item.filename}>
                            <img
                                src={item.objectUrl}
                                alt={item.filename}
                                className={cl("attachment-image")}
                            />
                        </a>
                    );
                }
                if (kind === "video") {
                    return (
                        <video
                            key={item.id}
                            src={item.objectUrl}
                            controls
                            className={cl("attachment-video")}
                        />
                    );
                }
                if (kind === "audio") {
                    return (
                        <audio
                            key={item.id}
                            src={item.objectUrl}
                            controls
                            className={cl("attachment-audio")}
                        />
                    );
                }
                return (
                    <a
                        key={item.id}
                        href={item.objectUrl}
                        download={item.filename}
                        className={cl("attachment-download")}
                    >
                        Download {item.filename}
                    </a>
                );
            })}
        </div>
    );
}
