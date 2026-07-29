/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";

import ButtonRow from "./ButtonRow";
import { settings } from "./settings";

export default definePlugin({
    name: "ChatBarTray",
    description: "Rearrange the chat bar buttons and tuck the ones you rarely use into a tray, like the Windows notification area. Works with Discord's own buttons and every plugin that adds one.",
    authors: [{ name: "ryan", id: 0n }],
    tags: ["Customisation", "Utility"],

    settings,

    settingsAboutComponent: () => (
        <>
            <HeadingSecondary>How to use</HeadingSecondary>
            <Paragraph>
                Click the caret next to the chat bar buttons to open the tray. While it's open every
                button — Discord's and every plugin's — can be dragged: drop one into the tray to hide
                it, drag it back down onto the chat bar to bring it out again, or drop it between two
                others to reorder them. Dropping a button straight onto the caret sends it to the tray.
            </Paragraph>
            <Paragraph>
                Clicking still just uses the button, tray open or not — a press only becomes a drag
                once you move it a little.
            </Paragraph>
            <Paragraph>
                Buttons in the tray are still fully alive and one click away; they just aren't taking
                up room. Buttons that only appear in some channels keep their position for the
                channels where they do appear.
            </Paragraph>
        </>
    ),

    patches: [
        {
            // The row that holds gift/GIF/sticker/emoji/apps/send, and everything Vencord's
            // ChatInputButtonAPI adds. Swapping only the "div" tag for our own component keeps
            // `children:<array>` intact, which that API's patch matches on — so the two are
            // order-independent.
            find: '"ChannelTextAreaButtons")',
            replacement: {
                match: /(0===(\i)\.length\).{0,40}?\(0,\i\.jsxs?\)\()"div"(?=,\{className:\i\.\i,children:\2\})/,
                replace: "$1$self.R"
            }
        }
    ],

    R: ButtonRow
});
