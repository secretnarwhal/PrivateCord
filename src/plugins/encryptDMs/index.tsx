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

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MessageObject } from "@api/MessageEvents";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { ChannelStore, Menu, UserStore } from "@webpack/common";

import { encryptForRecipients, isControlMessage, KEY_PREFIX } from "./crypto";
import { EncryptDMsAccessory } from "./EncryptDMsAccessory";
import { EncryptDMsChatBarIcon, EncryptDMsIcon } from "./EncryptDMsIcon";
import { getIdentity, getKnownKeysForChannel, initEncryptDMsState, isChannelEnabled } from "./keys";
import { settings } from "./settings";
import { acceptKeyAndSendMine, ENCRYPT_FAILED_PLACEHOLDER, getChannelRecipientIds, logger } from "./utils";

/**
 * Outgoing send/edit transform, mirroring the Java plugin's
 * updateOutgoingMessage + encryptForChannel:
 * - only in enabled channels,
 * - skip empty/whitespace content and control messages,
 * - always wrap the AES key for myself too,
 * - on any failure (no accepted peer keys, > 1900 chars, crypto error) replace
 *   the content with a placeholder — never silently send plaintext.
 */
async function handleOutgoing(channelId: string, message: MessageObject) {
    const { content } = message;
    if (!content || !content.trim() || isControlMessage(content)) return;

    // PluginManager registers this listener without awaiting start(), so the
    // DataStore state may still be loading when the first message is sent.
    // Never consult isChannelEnabled before the state is actually loaded —
    // an enabled channel would read as disabled and leak plaintext.
    try {
        await initEncryptDMsState();
    } catch (e) {
        logger.error("Could not load EncryptDMs state before sending", e);
        // State is unknowable: fail closed in DMs/group DMs (and unknown
        // channels) rather than risk sending plaintext where encryption was
        // enabled. Guild messages pass through untouched.
        const channel = ChannelStore.getChannel(channelId);
        if (!channel || channel.isPrivate?.()) {
            message.content = ENCRYPT_FAILED_PLACEHOLDER;
        }
        return;
    }

    if (!isChannelEnabled(channelId)) return;

    let encrypted: string | null = null;
    try {
        const me = UserStore.getCurrentUser()?.id;
        const identity = getIdentity();
        if (me && identity) {
            const recipientKeys = getKnownKeysForChannel(channelId, getChannelRecipientIds(channelId));
            const hasPeer = Object.keys(recipientKeys).some(id => id !== me);
            if (hasPeer) {
                encrypted = await encryptForRecipients(content, {
                    ...recipientKeys,
                    [me]: identity.publicKey,
                });
            }
        }
    } catch (e) {
        logger.error("Failed to encrypt outgoing message", e);
    }

    message.content = encrypted ?? ENCRYPT_FAILED_PLACEHOLDER;
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = message?.content;
    if (!content?.startsWith(KEY_PREFIX)) return;

    const authorId = message.author?.id;
    if (!authorId || authorId === UserStore.getCurrentUser()?.id) return;

    const group = findGroupChildrenByChildId("copy-text", children) ?? children;
    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-encryptdms-accept-key"
            label="Accept Encryption Key & Send Mine"
            icon={EncryptDMsIcon}
            action={() => acceptKeyAndSendMine(message.channel_id, authorId, content.slice(KEY_PREFIX.length).trim())}
        />
    ));
};

export default definePlugin({
    name: "EncryptDMs",
    description: "End-to-end encrypt DMs with RSA-2048 + AES-256-GCM. Wire-compatible with the Aliucord EncryptDMs plugin.",
    tags: ["Chat", "Utility", "Privacy"],
    // TODO: replace with your contributor entry from @utils/constants Devs before upstreaming
    authors: [{ name: "YourName", id: 0n }],

    settings,

    async start() {
        await initEncryptDMsState();
    },

    contextMenus: {
        "message": messageCtxPatch,
    },

    commands: [{
        name: "encryptkey",
        description: "Sends your EncryptDMs public key to this chat",
        inputType: ApplicationCommandInputType.BUILT_IN_TEXT,
        execute: (_, ctx) => {
            const identity = getIdentity();
            if (!identity) {
                sendBotMessage(ctx.channel.id, { content: "EncryptDMs identity is not ready yet. Try again in a moment." });
                return;
            }
            return { content: KEY_PREFIX + identity.publicKey };
        },
    }],

    renderMessageAccessory: props => <EncryptDMsAccessory message={props.message} />,

    chatBarButton: {
        icon: EncryptDMsIcon,
        render: EncryptDMsChatBarIcon,
    },

    async onBeforeMessageSend(channelId, message, _options) {
        await handleOutgoing(channelId, message);
    },

    async onBeforeMessageEdit(channelId, _messageId, message) {
        await handleOutgoing(channelId, message);
    },
});
