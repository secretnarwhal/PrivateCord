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

import { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, useEffect, useRef, useState, UserStore } from "@webpack/common";

import { BaseConverterIcon } from "./BaseConverterIcon";
import { settings } from "./settings";
import { useUserKeys } from "./userKeys";
import { cl, ConversionResult, decode, EncodingType } from "./utils";

export function resolveAesKey(
    message: Message,
    channel: Channel | undefined | null,
    aesSecret: string,
    userKeys: Record<string, string>,
    currentUserId: string | undefined,
): { key: string; hasUserKey: boolean } {
    const authorId = message.author?.id;
    const recipients = channel?.recipients ?? [];
    if (authorId === currentUserId && recipients.length === 1) {
        const partnerId = recipients[0];
        const partnerKey = partnerId ? userKeys[partnerId] : undefined;
        if (partnerKey) return { key: partnerKey, hasUserKey: true };
        return { key: aesSecret, hasUserKey: false };
    }
    const k = authorId ? userKeys[authorId] : undefined;
    if (k) return { key: k, hasUserKey: true };
    return { key: aesSecret, hasUserKey: false };
}

function neutralizeMentions(text: string): string {
    // Zero-width space breaks Discord's mention parser while remaining invisible.
    return text
        .replace(/@everyone/g, "@​everyone")
        .replace(/@here/g, "@​here")
        .replace(/<@!?(\d+)>/g, "<@​$1>")
        .replace(/<@&(\d+)>/g, "<@&​$1>");
}

const ConversionSetters = new Map<string, Set<(v: ConversionResult) => void>>();
const DecodedMessages = new Map<string, ConversionResult>();
const ReplyListeners = new Map<string, Set<(v: ConversionResult) => void>>();

const DECODED_CACHE_MAX = 100;

function notifyDecode(messageId: string, data: ConversionResult) {
    DecodedMessages.set(messageId, data);
    if (DecodedMessages.size > DECODED_CACHE_MAX)
        DecodedMessages.delete(DecodedMessages.keys().next().value!);
    ReplyListeners.get(messageId)?.forEach(fn => fn(data));
}

export function handleDecode(messageId: string, data: ConversionResult) {
    notifyDecode(messageId, data);
    ConversionSetters.get(messageId)?.forEach(fn => fn(data));
}

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

export function BaseConverterAccessory({ message }: { message: Message; }) {
    const { autoDecodeReceived, receiveEncoding, aesSecret } = settings.use(["autoDecodeReceived", "receiveEncoding", "aesSecret"]);
    const userKeys = useUserKeys();
    const currentUserId = UserStore.getCurrentUser()?.id;
    const channel = ChannelStore.getChannel(message.channel_id);

    const { key: effectiveKey, hasUserKey } = resolveAesKey(message, channel, aesSecret, userKeys, currentUserId);

    const [result, setResult] = useState<ConversionResult | undefined>();
    const [showOriginal, setShowOriginal] = useState(false);
    const containerRef = useRef<HTMLSpanElement>(null);

    const referencedMessageId = message.messageReference?.message_id;

    const [referenceResult, setReferenceResult] = useState<ConversionResult | undefined>(
        () => referencedMessageId ? DecodedMessages.get(referencedMessageId) : undefined
    );

    useEffect(() => {
        if (!referencedMessageId) return;
        const set = ReplyListeners.get(referencedMessageId) ?? new Set();
        set.add(setReferenceResult);
        ReplyListeners.set(referencedMessageId, set);
        return () => {
            set.delete(setReferenceResult);
            if (!set.size) ReplyListeners.delete(referencedMessageId);
        };
    }, [referencedMessageId]);

    useEffect(() => {
        // vencordEmbeddedBy is runtime-injected by another Vencord plugin (e.g. quotePreview).
        if ((message as Message & { vencordEmbeddedBy?: unknown }).vencordEmbeddedBy) return;

        const set = ConversionSetters.get(message.id) ?? new Set();
        set.add(setResult);
        ConversionSetters.set(message.id, set);

        // A per-user key forces AES auto-decode regardless of the autoDecodeReceived toggle.
        if ((autoDecodeReceived || hasUserKey) && message.content) {
            const encoding: EncodingType = hasUserKey ? "aes" : receiveEncoding as EncodingType;
            decode(message.content, encoding, effectiveKey)
                .then(decoded => {
                    if (decoded) {
                        setResult(decoded);
                        notifyDecode(message.id, decoded);
                    }
                })
                .catch(() => { /* silent — auto-decode is best-effort */ });
        }

        return () => {
            set.delete(setResult);
            if (!set.size) ConversionSetters.delete(message.id);
        };
    }, [message.id, message.content, autoDecodeReceived, hasUserKey, receiveEncoding, effectiveKey]);

    // Hide the original encrypted message content when decoded; show when toggled
    useEffect(() => {
        if (!result || showOriginal) return;

        const ac = new AbortController();
        let mc: HTMLElement | null = null;

        findMessageContentElAsync(message.id, ac.signal).then(el => {
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
    }, [result, showOriginal, message.id]);

    // Hide the reply bar's encoded reference text and show the decoded version
    useEffect(() => {
        if (!referenceResult) return;

        const listItem = document.querySelector<HTMLElement>(
            `li[id$="${message.id}"], [data-list-item-id$="${message.id}"]`
        );
        if (!listItem) return;

        const replyContent = listItem.querySelector<HTMLElement>(
            "[class*='repliedMessage'] [class*='messageContent']"
        );
        if (!replyContent || !replyContent.parentElement) return;

        listItem.querySelectorAll(`[data-vc-baseconv="1"]`).forEach(n => n.remove());

        replyContent.style.display = "none";
        const decoded = document.createElement("span");
        decoded.setAttribute("data-vc-baseconv", "1");
        decoded.textContent = referenceResult.text;
        replyContent.parentElement.insertBefore(decoded, replyContent);

        return () => {
            replyContent.style.display = "";
            decoded.remove();
        };
    }, [referenceResult, message.id]);

    // Match decoded text color to the actual message content color
    useEffect(() => {
        if (!result || !containerRef.current) return;
        const ac = new AbortController();
        findMessageContentElAsync(message.id, ac.signal).then(mc => {
            if (!mc || !containerRef.current || ac.signal.aborted) return;
            const color = window.getComputedStyle(mc).color;
            containerRef.current.style.color = color;
        });
        return () => {
            ac.abort();
            if (containerRef.current) containerRef.current.style.color = "";
        };
    }, [result, message.id]);

    if (!result) return null;

    return (
        <span ref={containerRef} className={cl("accessory")}>
            <BaseConverterIcon width={16} height={16} className={cl("accessory-icon")} />
            <span className={cl("decoded-text")}>{neutralizeMentions(result.text)}</span>
            <br />
            <span className={cl("meta")}>
                <span className={cl("encoding-label")}>{result.encoding}</span>
                {" — "}
                <button type="button" className={cl("toggle-original")} onClick={() => setShowOriginal(v => !v)}>
                    {showOriginal ? "Hide original" : "Show original"}
                </button>
                {" — "}
                <button type="button" className={cl("dismiss")} onClick={() => { setResult(undefined); setShowOriginal(false); }}>
                    Dismiss
                </button>
            </span>
        </span>
    );
}
