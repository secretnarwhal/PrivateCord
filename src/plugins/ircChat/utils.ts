/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

export const cl = classNameFactory("vc-irc-");

/**
 * Deterministic colour per nick, matching the convention every IRC client uses.
 * Hues are spread across the wheel and kept at a fixed saturation/lightness so
 * they stay legible against Discord's dark and light themes alike.
 */
const NICK_HUES = [0, 25, 50, 90, 140, 175, 200, 220, 260, 290, 320, 340];

export function nickColor(nick: string): string {
    let hash = 0;
    for (let i = 0; i < nick.length; i++) {
        hash = (hash * 31 + nick.charCodeAt(i)) | 0;
    }
    const hue = NICK_HUES[Math.abs(hash) % NICK_HUES.length];
    return `hsl(${hue}, 65%, 65%)`;
}

export function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

export type TextSegment =
    | { type: "text"; value: string; }
    | { type: "link"; value: string; };

/**
 * Split text into plain and link runs. We render IRC content as plain text
 * rather than feeding it to Discord's markdown parser — the string is fully
 * attacker-controlled by anyone on the server, and the parser will happily
 * build embeds, mentions and invite previews out of it.
 */
export function segmentText(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(URL_PATTERN)) {
        const index = match.index ?? 0;
        if (index > lastIndex) {
            segments.push({ type: "text", value: text.slice(lastIndex, index) });
        }
        segments.push({ type: "link", value: match[0] });
        lastIndex = index + match[0].length;
    }

    if (lastIndex < text.length) {
        segments.push({ type: "text", value: text.slice(lastIndex) });
    }

    return segments;
}
