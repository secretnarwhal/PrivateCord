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

import { Message } from "@vencord/discord-types";
import { useEffect, UserStore, useState } from "@webpack/common";

import { DECRYPT_FALLBACKS, decryptPayload, DecryptResult, ENC_PREFIX, KEY_PREFIX } from "./crypto";
import { EncryptDMsIcon } from "./EncryptDMsIcon";
import { getIdentity, getUserKey, useEncryptDMsState } from "./keys";
import { acceptKeyAndSendMine, cl } from "./utils";

function neutralizeMentions(text: string): string {
    // Zero-width space breaks Discord's mention parser while remaining invisible.
    return text
        .replace(/@everyone/g, "@​everyone")
        .replace(/@here/g, "@​here")
        .replace(/<@!?(\d+)>/g, "<@​$1>")
        .replace(/<@&(\d+)>/g, "<@&​$1>");
}

// ─── Hiding the raw base64 blob (same approach as baseConverter) ──────────────

function findMessageContentEl(messageId: string): HTMLElement | null {
    return document.getElementById(`message-content-${messageId}`);
}

function findMessageContentElAsync(messageId: string, signal: AbortSignal): Promise<HTMLElement | null> {
    return new Promise(resolve => {
        const immediate = findMessageContentEl(messageId);
        if (immediate) return resolve(immediate);
        if (signal.aborted) return resolve(null);

        const root = document.querySelector("main") ?? document.body;
        const observer = new MutationObserver(() => {
            const el = findMessageContentEl(messageId);
            if (el) {
                cleanup();
                resolve(el);
            }
        });

        const timeout = setTimeout(() => {
            cleanup();
            resolve(null);
        }, 5000);

        const onAbort = () => {
            cleanup();
            resolve(null);
        };

        const cleanup = () => {
            observer.disconnect();
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
        };

        signal.addEventListener("abort", onAbort);
        observer.observe(root, { childList: true, subtree: true });
    });
}

const hideRefcounts = new WeakMap<HTMLElement, number>();

function useHideOriginalContent(messageId: string, hide: boolean) {
    useEffect(() => {
        if (!hide) return;

        const ac = new AbortController();
        let mc: HTMLElement | null = null;

        findMessageContentElAsync(messageId, ac.signal).then(el => {
            if (!el || ac.signal.aborted) return;
            mc = el;
            hideRefcounts.set(el, (hideRefcounts.get(el) ?? 0) + 1);
            el.style.display = "none";
        });

        return () => {
            ac.abort();
            if (!mc) return;
            const n = (hideRefcounts.get(mc) ?? 1) - 1;
            if (n <= 0) {
                mc.style.display = "";
                hideRefcounts.delete(mc);
            } else {
                hideRefcounts.set(mc, n);
            }
        };
    }, [messageId, hide]);
}

// ─── Encrypted message accessory ──────────────────────────────────────────────

function DecryptedMessageAccessory({ message }: { message: Message; }) {
    useEncryptDMsState();
    const [result, setResult] = useState<DecryptResult | undefined>();
    const [showOriginal, setShowOriginal] = useState(false);

    const { content } = message;
    const myId = UserStore.getCurrentUser()?.id;
    const privateKey = getIdentity()?.privateKey;

    useEffect(() => {
        let cancelled = false;

        if (!privateKey || !myId) {
            setResult({ ok: false, reason: "missing-private-key" });
            return;
        }

        decryptPayload(content, privateKey, myId)
            .then(res => { if (!cancelled) setResult(res); })
            .catch(() => { if (!cancelled) setResult({ ok: false, reason: "failed" }); });

        return () => { cancelled = true; };
    }, [message.id, content, privateKey, myId]);

    useHideOriginalContent(message.id, !!result && !showOriginal);

    if (!result) return null;

    return (
        <span className={cl("accessory")}>
            <EncryptDMsIcon width={16} height={16} className={cl("accessory-icon")} />
            {result.ok
                ? <span className={cl("decrypted-text")}>{neutralizeMentions(result.text)}</span>
                : <span className={cl("fallback-text")}>{DECRYPT_FALLBACKS[result.reason]}</span>
            }
            <br />
            <span className={cl("meta")}>
                <span className={cl("label")}>{result.ok ? "Encrypted" : "Encrypted (unreadable)"}</span>
                {" — "}
                <button type="button" className={cl("meta-btn")} onClick={() => setShowOriginal(v => !v)}>
                    {showOriginal ? "Hide original" : "Show original"}
                </button>
            </span>
        </span>
    );
}

// ─── Key share accessory ──────────────────────────────────────────────────────

function KeyShareAccessory({ message }: { message: Message; }) {
    useEncryptDMsState();

    const myId = UserStore.getCurrentUser()?.id;
    const authorId = message.author?.id;
    const keyB64 = message.content.slice(KEY_PREFIX.length).trim();

    if (authorId === myId) {
        return (
            <span className={cl("accessory", "key-share")}>
                <EncryptDMsIcon width={16} height={16} className={cl("accessory-icon")} />
                <span className={cl("meta")}>This is your EncryptDMs public key.</span>
            </span>
        );
    }

    const alreadyAccepted = !!authorId && getUserKey(authorId) === keyB64;

    return (
        <span className={cl("accessory", "key-share")}>
            <EncryptDMsIcon width={16} height={16} className={cl("accessory-icon")} />
            <span className={cl("meta")}>
                {alreadyAccepted
                    ? "Encryption key accepted for this user."
                    : "This user sent you their EncryptDMs public key."}
            </span>
            {!alreadyAccepted && (
                <button
                    type="button"
                    className={cl("accept-btn")}
                    onClick={() => { if (authorId) acceptKeyAndSendMine(message.channel_id, authorId, keyB64); }}
                >
                    Accept Encryption Key &amp; Send Mine
                </button>
            )}
        </span>
    );
}

export function EncryptDMsAccessory({ message }: { message: Message; }) {
    const content = message?.content;
    if (!content) return null;

    // vencordEmbeddedBy is runtime-injected by other Vencord plugins that re-render
    // messages (e.g. quote previews); skip those to avoid duplicate accessories.
    if ((message as Message & { vencordEmbeddedBy?: unknown; }).vencordEmbeddedBy) return null;

    if (content.startsWith(ENC_PREFIX)) return <DecryptedMessageAccessory message={message} />;
    if (content.startsWith(KEY_PREFIX)) return <KeyShareAccessory message={message} />;
    return null;
}
