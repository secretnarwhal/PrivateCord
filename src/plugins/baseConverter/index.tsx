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
import definePlugin from "@utils/types";
import { Message, User } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast, Toasts } from "@webpack/common";

import { handleDecode, BaseConverterAccessory } from "./BaseConverterAccessory";
import { BaseConverterChatBarIcon, BaseConverterIcon, setShouldShowAutoEncodeTooltip } from "./BaseConverterIcon";
import { settings } from "./settings";
import { openUserKeyModal } from "./UserKeyModal";
import { decode, encode, EncodingType, EncodeTarget } from "./utils";

function getMessageContent(message: Message): string {
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(e => e.type === "auto_moderation_message")?.rawDescription
        || "";
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
            action={async () => {
                const authorId: string | undefined = (message as any).author?.id;
                const aesKey = (authorId && settings.store.userKeys?.[authorId])
                    ? settings.store.userKeys[authorId]
                    : settings.store.aesSecret;
                const result = await decode(
                    content,
                    settings.store.receiveEncoding as EncodingType,
                    aesKey
                );
                if (result) {
                    handleDecode(message.id, result);
                } else {
                    showToast("Could not decode this message. Check the encoding setting and (for AES) your shared secret.", Toasts.Type.FAILURE);
                }
            }}
        />
    ));
};

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;
    children.push(
        <Menu.MenuItem
            id="vc-baseconv-set-user-key"
            label="Set AES Secret Key"
            icon={BaseConverterIcon}
            action={() => openUserKeyModal(user.id, user.username)}
        />
    );
};

let tooltipTimeout: ReturnType<typeof setTimeout>;

export default definePlugin({
    name: "BaseConverter",
    description: "Decode and encode messages between binary, octal, decimal, hex, base32, base64, UTF-8, and AES-256-GCM — directly in chat.",
    tags: ["Chat", "Utility"],
    authors: [{ name: "YourName", id: 0n }],

    settings,

    contextMenus: {
        "message": messageCtxPatch,
        "user-context": userContextPatch,
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
                onClick: async () => {
                    const authorId: string | undefined = (message as any).author?.id;
                    const aesKey = (authorId && settings.store.userKeys?.[authorId])
                        ? settings.store.userKeys[authorId]
                        : settings.store.aesSecret;
                    const result = await decode(
                        content,
                        settings.store.receiveEncoding as EncodingType,
                        aesKey
                    );
                    if (result) {
                        handleDecode(message.id, result);
                    } else {
                        showToast("Could not decode this message. Check the encoding setting and (for AES) your shared secret.", Toasts.Type.FAILURE);
                    }
                },
            };
        },
    },

    async onBeforeMessageSend(channelId, message) {
        if (!settings.store.autoEncodeOutgoing) return;
        if (!message.content) return;

        // For DMs, prefer the per-user key for the recipient over the global secret.
        let aesKey = settings.store.aesSecret;
        const channel = ChannelStore.getChannel(channelId);
        if (channel?.type === 1) {
            const recipientId = (channel as any).recipients?.[0];
            if (typeof recipientId === "string") {
                const userKey = settings.store.userKeys?.[recipientId];
                if (userKey) aesKey = userKey;
            }
        }

        if (settings.store.sendEncoding === "aes" && !aesKey) {
            showToast("Set a shared AES secret in the Base Converter settings before sending.", Toasts.Type.FAILURE);
            return;
        }

        setShouldShowAutoEncodeTooltip?.(true);
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => setShouldShowAutoEncodeTooltip?.(false), 2000);

        message.content = await encode(
            message.content,
            settings.store.sendEncoding as EncodeTarget,
            aesKey
        );
    },
});
