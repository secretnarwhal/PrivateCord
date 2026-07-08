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

import "./styles.css";

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { InvisibleMessagesAccessory } from "./InvisibleMessagesAccessory";
import { InvisibleMessagesChatBarIcon, InvisibleMessagesIcon } from "./InvisibleMessagesIcon";
import { revealInvisibleMessage } from "./modals";
import { settings } from "./settings";
import { containsInvisibleMessage, encrypt } from "./stegcloak";
import { initInvisibleMessagesState } from "./store";
import { getPassword, logger } from "./utils";

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!containsInvisibleMessage(message?.content)) return;

    const group = findGroupChildrenByChildId("copy-text", children) ?? children;
    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-invismsg-decrypt"
            label="Decrypt Invisible Message"
            icon={InvisibleMessagesIcon}
            action={() => revealInvisibleMessage(message)}
        />
    ));
};

export default definePlugin({
    name: "InvisibleMessages",
    description: "Hide an encrypted secret inside a normal message using zero-width characters (StegCloak). Wire-compatible with the Aliucord InvisibleMessages plugin and the stegcloak npm library.",
    tags: ["Chat", "Utility", "Privacy"],
    // TODO: replace with your contributor entry from @utils/constants Devs before upstreaming
    authors: [{ name: "YourName", id: 0n }],

    settings,

    async start() {
        await initInvisibleMessagesState();
    },

    contextMenus: {
        "message": messageCtxPatch,
    },

    commands: [{
        name: "invis",
        description: "Send an invisible message hidden inside a normal-looking cover message",
        inputType: ApplicationCommandInputType.BUILT_IN_TEXT,
        options: [
            {
                name: "message",
                description: "The visible cover message (what normal people see — must be at least 2 words)",
                type: ApplicationCommandOptionType.STRING,
                required: true,
            },
            {
                name: "hiddenMessage",
                description: "The hidden message — only people with the password can reveal this",
                type: ApplicationCommandOptionType.STRING,
                required: true,
            },
            {
                name: "password",
                description: "Password to encrypt with. If omitted, the channel or default password is used",
                type: ApplicationCommandOptionType.STRING,
                required: false,
            },
        ],
        execute: async (opts, ctx) => {
            const cover = findOption<string>(opts, "message", "");
            const hidden = findOption<string>(opts, "hiddenMessage", "");
            const passwordInput = findOption<string>(opts, "password", "");

            // Same rule as the Java plugin: the cover needs more than one word.
            if (cover.split(" ").length < 2) {
                sendBotMessage(ctx.channel.id, { content: "Message must contain more than 1 word" });
                return;
            }

            const password = passwordInput || getPassword(ctx.channel.id);
            try {
                const encoded = await encrypt(password, hidden, cover);
                return { content: encoded };
            } catch (e) {
                logger.error("Failed to encode invisible message", e);
                sendBotMessage(ctx.channel.id, { content: "An error occurred while creating the invisible message" });
                return;
            }
        },
    }],

    renderMessageAccessory: props => <InvisibleMessagesAccessory message={props.message} />,

    chatBarButton: {
        icon: InvisibleMessagesIcon,
        render: InvisibleMessagesChatBarIcon,
    },
});
