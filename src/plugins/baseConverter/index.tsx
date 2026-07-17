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

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MessageObject } from "@api/MessageEvents";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast, Toasts } from "@webpack/common";

import { BaseConverterAccessory, handleDecode } from "./BaseConverterAccessory";
import { BaseConverterChatBarIcon, BaseConverterIcon, scheduleAutoEncodeTooltipHide, setAutoEncodeTooltip } from "./BaseConverterIcon";
import { settings } from "./settings";
import { decode, encode, EncodeTarget, EncodingType } from "./utils";

function getMessageContent(message: Message): string {
    // When the auto_moderation_message branch fires, the content is what AutoMod
    // intercepted, not what the user typed — same value, but it surfaces a
    // message that Discord blocked.
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(e => e.type === "auto_moderation_message")?.rawDescription
        || "";
}

async function triggerManualDecode(message: Message) {
    const content = getMessageContent(message);
    const result = await decode(content, settings.store.receiveEncoding as EncodingType);
    if (result) {
        handleDecode(message.id, result);
    } else {
        showToast("Could not decode this message. Check the encoding setting.", Toasts.Type.FAILURE);
    }
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-baseconv"
            label="Decode Message"
            icon={BaseConverterIcon}
            action={() => triggerManualDecode(message)}
        />
    ));
};

let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;

async function computeOutgoingEncoding(content: string): Promise<string | null> {
    if (!settings.store.autoEncodeOutgoing || !content) return null;

    setAutoEncodeTooltip(true);
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    const t = scheduleAutoEncodeTooltipHide(2000);
    if (t) tooltipTimeout = t;

    return encode(content, settings.store.sendEncoding as EncodeTarget);
}

async function handleBeforeSend(message: MessageObject) {
    const encoded = await computeOutgoingEncoding(message.content);
    if (encoded != null) message.content = encoded;
}

export default definePlugin({
    name: "BaseConverter",
    description: "Decode and encode messages between binary, octal, decimal, hex, base32, base64, and UTF-8 — directly in chat.",
    tags: ["Chat", "Utility"],
    // TODO: replace with your contributor entry from @utils/constants Devs before upstreaming
    authors: [{ name: "YourName", id: 0n }],

    settings,

    contextMenus: {
        "message": messageCtxPatch,
    },

    renderMessageAccessory: props => <BaseConverterAccessory message={props.message} />,

    chatBarButton: {
        icon: BaseConverterIcon,
        render: BaseConverterChatBarIcon,
    },

    messagePopoverButton: {
        icon: BaseConverterIcon,
        render(message: Message) {
            const content = getMessageContent(message);
            if (!content) return null;

            return {
                label: "Decode Message",
                icon: BaseConverterIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => triggerManualDecode(message),
            };
        },
    },

    async onBeforeMessageSend(_channelId, message, _options) {
        await handleBeforeSend(message);
    },

    async onBeforeMessageEdit(_channelId, _messageId, message) {
        await handleBeforeSend(message);
    },
});
