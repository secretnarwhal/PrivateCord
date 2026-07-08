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
import { UserStore, useState } from "@webpack/common";

import { InvisibleMessagesIcon } from "./InvisibleMessagesIcon";
import { openRevealPasswordModal } from "./modals";
import { containsInvisibleMessage, decrypt } from "./stegcloak";
import { getLastUsedPassword, setLastUsedPassword, useInvisibleMessagesState } from "./store";
import { cl, getPassword, logger } from "./utils";

function HiddenMessageAccessory({ message }: { message: Message; }) {
    useInvisibleMessagesState();
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState(false);

    const reveal = async () => {
        setError(false);

        const defaultPassword = getLastUsedPassword() ?? getPassword(message.channel_id);
        const password = await openRevealPasswordModal(defaultPassword);
        if (password == null) return;

        try {
            const decrypted = await decrypt(message.content, password);
            await setLastUsedPassword(password);
            setText(decrypted);
        } catch (e) {
            logger.error("Failed to decrypt invisible message", e);
            setText(null);
            setError(true);
        }
    };

    return (
        <span className={cl("accessory")}>
            <InvisibleMessagesIcon width={16} height={16} className={cl("accessory-icon")} />
            {text != null
                ? <span className={cl("revealed-text")}>{text}</span>
                : (
                    <span className={cl("meta")}>
                        <span className={cl("label")}>Hidden message</span>
                        {error && <span className={cl("error-text")}> — wrong password?</span>}
                    </span>
                )
            }
            {" "}
            <button type="button" className={cl("reveal-btn")} onClick={() => void reveal()}>
                {text != null ? "Reveal again" : error ? "Try again" : "Reveal"}
            </button>
        </span>
    );
}

export function InvisibleMessagesAccessory({ message }: { message: Message; }) {
    const content = message?.content;
    if (!content) return null;

    // vencordEmbeddedBy is runtime-injected by other Vencord plugins that re-render
    // messages (e.g. quote previews); skip those to avoid duplicate accessories.
    if ((message as Message & { vencordEmbeddedBy?: unknown; }).vencordEmbeddedBy) return null;

    if (!containsInvisibleMessage(content)) return null;

    // Don't show a redundant reveal chip on your own messages — you authored the secret.
    if (message.author?.id === UserStore.getCurrentUser()?.id) return null;

    return <HiddenMessageAccessory message={message} />;
}
