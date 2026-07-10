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
import { useEffect, useState } from "@webpack/common";

import { ElbowIcon } from "./InvisibleMessagesIcon";
import { useForcedReveal, useRevealMode } from "./revealState";
import { containsInvisibleMessage, decrypt } from "./stegcloak";
import { useInvisibleMessagesState } from "./store";
import { cl, getRevealPassword } from "./utils";

function HiddenMessageAccessory({ message }: { message: Message; }) {
    useInvisibleMessagesState();
    const revealMode = useRevealMode();
    // Text revealed manually via the message context menu ("Decrypt Invisible
    // Message") is stored globally so it shows inline right next to the message.
    const forcedText = useForcedReveal(message.id);
    const [autoText, setAutoText] = useState<string | null>(null);

    // While reveal mode is on, auto-decrypt with the permanent/channel password.
    useEffect(() => {
        if (!revealMode) {
            setAutoText(null);
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                const decrypted = await decrypt(message.content, getRevealPassword(message.channel_id));
                if (!cancelled) setAutoText(decrypted);
            } catch {
                if (!cancelled) setAutoText(null);
            }
        })();
        return () => { cancelled = true; };
    }, [revealMode, message.content, message.channel_id]);

    // Prefer the reveal-mode auto-decrypt, but always fall back to a message the
    // user explicitly decrypted via the context menu.
    const text = (revealMode ? autoText : null) ?? forcedText ?? null;

    // No placeholder, no "Reveal" button, no error text — a hidden message stays
    // invisible until it's actually decrypted. Nothing to draw until then.
    if (text == null) return null;

    return (
        <span className={cl("accessory")}>
            <ElbowIcon width={16} height={16} className={cl("accessory-icon")} />
            <span className={cl("revealed-text")}>{text}</span>
        </span>
    );
}

export function InvisibleMessagesAccessory({ message }: { message: Message; }) {
    // Hooks must run before any early return, and must react to reveal-mode /
    // forced-reveal changes so a message can appear the moment it's decrypted.
    const revealMode = useRevealMode();
    const forcedText = useForcedReveal(message?.id ?? "");

    const content = message?.content;
    if (!content) return null;

    // vencordEmbeddedBy is runtime-injected by other Vencord plugins that re-render
    // messages (e.g. quote previews); skip those to avoid duplicate accessories.
    if ((message as Message & { vencordEmbeddedBy?: unknown; }).vencordEmbeddedBy) return null;

    if (!containsInvisibleMessage(content)) return null;

    // The only ways to decrypt are reveal mode (the right-click chat-bar toggle) or
    // the "Decrypt Invisible Message" context-menu item. Outside those, an invisible
    // message is left completely untouched — no chip ever pops up under it.
    if (!revealMode && forcedText == null) return null;

    return <HiddenMessageAccessory message={message} />;
}
