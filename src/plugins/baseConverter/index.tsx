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
import { Channel, Message, User } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast, Toasts, UserStore } from "@webpack/common";

import { handleDecode, BaseConverterAccessory, resolveAesKey } from "./BaseConverterAccessory";
import { BaseConverterChatBarIcon, BaseConverterIcon, scheduleAutoEncodeTooltipHide, setAutoEncodeTooltip } from "./BaseConverterIcon";
import { settings } from "./settings";
import { getAllUserKeys, getUserKey } from "./userKeys";
import { openUserKeyModal } from "./UserKeyModal";
import { decode, encode, EncodingType, EncodeTarget } from "./utils";

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
    const channel = ChannelStore.getChannel(message.channel_id);
    const { key: aesKey } = resolveAesKey(
        message,
        channel,
        settings.store.aesSecret,
        getAllUserKeys(),
        UserStore.getCurrentUser()?.id,
    );
    const result = await decode(content, settings.store.receiveEncoding as EncodingType, aesKey);
    if (result) {
        handleDecode(message.id, result);
    } else {
        showToast("Could not decode this message. Check the encoding setting and (for AES) your shared secret.", Toasts.Type.FAILURE);
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

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    const item = (
        <Menu.MenuItem
            id="vc-baseconv-set-user-key"
            label="Set AES Secret Key"
            icon={BaseConverterIcon}
            action={() => openUserKeyModal(user.id, user.username)}
        />
    );

    // In DM sidebar: insert before "Close DM" so the item is in the visible section.
    const dmGroup = findGroupChildrenByChildId("close-dm", children);
    if (dmGroup) {
        const idx = dmGroup.findIndex(c => c?.props?.id === "close-dm");
        dmGroup.splice(idx, 0, item);
        return;
    }

    // In server / other contexts: place just above the devmode copy-id item
    // when present; otherwise append.
    const devGroup = findGroupChildrenByChildId(`devmode-copy-id-${user.id}`, children);
    if (devGroup) devGroup.splice(-1, 0, item);
    else children.push(item);
};

let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;

const attachmentWarnSeen = new Set<string>();

function resolveSendAesKey(channel: Channel | undefined | null, aesSecret: string): { key: string; hasUserKey: boolean; recipients: string[]; } {
    const recipients = channel?.recipients ?? [];
    if (recipients.length === 1) {
        const partnerKey = getUserKey(recipients[0]);
        if (partnerKey) return { key: partnerKey, hasUserKey: true, recipients };
    }
    return { key: aesSecret, hasUserKey: false, recipients };
}

type EncodeOutcome =
    | { kind: "encoded"; content: string; }
    | { kind: "skip"; }
    | { kind: "warn-attachment-only"; };

async function computeOutgoingEncoding(channelId: string, content: string): Promise<EncodeOutcome> {
    const channel = ChannelStore.getChannel(channelId);
    const aesSecretSetting = settings.store.aesSecret;
    const { key: aesKey, hasUserKey, recipients } = resolveSendAesKey(channel, aesSecretSetting);

    const isPrivate = !!channel?.isPrivate?.();
    const isOneOnOne = isPrivate && recipients.length === 1;

    // Ambiguity: in group DMs or guilds, per-user keys can't apply. If the user
    // has any per-user key matching ANY recipient (or any per-user key at all
    // for guild channels) and has expressed encryption intent, refuse rather
    // than silently sending plaintext.
    if (settings.store.autoEncodeOutgoing && !aesSecretSetting && !isOneOnOne) {
        const allKeys = getAllUserKeys();
        const hasMatchingKey = recipients.some(id => allKeys[id]);
        if (hasMatchingKey || (!isPrivate && Object.keys(allKeys).length > 0)) {
            showToast(
                "Per-user AES keys don't apply in group DMs or servers. Set a global shared secret in Base Converter settings or disable auto-encode.",
                Toasts.Type.FAILURE
            );
            return { kind: "skip" };
        }
    }

    if (!content) {
        if (hasUserKey || (settings.store.autoEncodeOutgoing && aesSecretSetting)) {
            return { kind: "warn-attachment-only" };
        }
        return { kind: "skip" };
    }

    // A per-user key bypasses the autoEncodeOutgoing toggle and always AES-encodes.
    if (!hasUserKey && !settings.store.autoEncodeOutgoing) return { kind: "skip" };

    const sendEncoding: EncodeTarget = hasUserKey ? "aes" : settings.store.sendEncoding as EncodeTarget;

    if (sendEncoding === "aes" && !aesKey) {
        showToast("Set a shared AES secret in the Base Converter settings before sending.", Toasts.Type.FAILURE);
        return { kind: "skip" };
    }

    setAutoEncodeTooltip(true);
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    const t = scheduleAutoEncodeTooltipHide(2000);
    if (t) tooltipTimeout = t;

    const encoded = await encode(content, sendEncoding, aesKey);
    return { kind: "encoded", content: encoded };
}

async function handleBeforeSend(channelId: string, message: MessageObject) {
    const outcome = await computeOutgoingEncoding(channelId, message.content);
    if (outcome.kind === "encoded") {
        message.content = outcome.content;
    } else if (outcome.kind === "warn-attachment-only") {
        if (!attachmentWarnSeen.has(channelId)) {
            attachmentWarnSeen.add(channelId);
            showToast("Attachments are not encrypted — only message text. Add some text to encrypt your message.", Toasts.Type.MESSAGE);
        }
    }
}

async function handleBeforeEdit(channelId: string, message: MessageObject) {
    if (!message.content) return;
    const outcome = await computeOutgoingEncoding(channelId, message.content);
    if (outcome.kind === "encoded") {
        message.content = outcome.content;
    }
}

export default definePlugin({
    name: "BaseConverter",
    description: "Decode and encode messages between binary, octal, decimal, hex, base32, base64, UTF-8, and AES-256-GCM — directly in chat.",
    tags: ["Chat", "Utility", "Privacy"],
    // TODO: replace with your contributor entry from @utils/constants Devs before upstreaming
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
                onClick: () => triggerManualDecode(message),
            };
        },
    },

    async onBeforeMessageSend(channelId, message, _options) {
        await handleBeforeSend(channelId, message);
    },

    async onBeforeMessageEdit(channelId, _messageId, message) {
        await handleBeforeEdit(channelId, message);
    },
});
