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
import { MessageObject, SendMessageProps } from "@api/MessageEvents";
import definePlugin from "@utils/types";
import { Channel, CloudUpload, Message, User } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast } from "@webpack/common";

import { EncryptDMsAccessory, handleDecode } from "./EncryptDMsAccessory";
import { EncryptDMsChatBarIcon, EncryptDMsIcon, scheduleAutoEncodeTooltipHide, setAutoEncodeTooltip } from "./EncryptDMsIcon";
import { encryptFile, isEncryptedAttachmentName } from "./encryptedAttachment";
import { openChannelKeyModal, openUserKeyModal } from "./KeyModal";
import { channelKeys, hasOwnKey, isChannelEncrypted, resolveReceiveKey, resolveSendKey, toggleChannelEncryption } from "./keys";
import { settings } from "./settings";
import { decryptMessage, encrypt } from "./utils";

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
    const { key } = resolveReceiveKey(message, ChannelStore.getChannel(message.channel_id));
    const result = await decryptMessage(content, key);
    if (result) {
        handleDecode(message.id, result);
    } else {
        showToast({ text: "Could not decrypt this message. Check your shared secret, channel key or per-user key.", variant: "critical" });
    }
}

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, (
        <Menu.MenuItem
            id="vc-encryptdms"
            label="Decrypt Message"
            icon={EncryptDMsIcon}
            action={() => triggerManualDecode(message)}
        />
    ));
};

// Only channels with their own key get a toggle; the rest follow the global chat bar button.
function renderChannelToggle(channel: Channel | undefined) {
    if (!channel || !hasOwnKey(channel)) return null;
    return (
        <Menu.MenuCheckboxItem
            key="vc-encryptdms-toggle-channel"
            id="vc-encryptdms-toggle-channel"
            label="Encrypt With Secret Key"
            checked={isChannelEncrypted(channel)}
            action={() => toggleChannelEncryption(channel.id)}
        />
    );
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    const dmChannelId = ChannelStore.getDMFromUserId(user.id);
    const items = [
        <Menu.MenuItem
            key="vc-encryptdms-set-user-key"
            id="vc-encryptdms-set-user-key"
            label="Set AES Secret Key"
            icon={EncryptDMsIcon}
            action={() => openUserKeyModal(user.id, user.username)}
        />,
        renderChannelToggle(dmChannelId ? ChannelStore.getChannel(dmChannelId) : undefined),
    ];

    // In DM sidebar: insert before "Close DM" so the items are in the visible section.
    const dmGroup = findGroupChildrenByChildId("close-dm", children);
    if (dmGroup) {
        const idx = dmGroup.findIndex(c => c?.props?.id === "close-dm");
        dmGroup.splice(idx, 0, ...items);
        return;
    }

    // In server / other contexts: place just above the devmode copy-id item
    // when present; otherwise append.
    const devGroup = findGroupChildrenByChildId(`devmode-copy-id-${user.id}`, children);
    if (devGroup) devGroup.splice(-1, 0, ...items);
    else children.push(...items);
};

// Text/voice channels, threads and group DMs.
const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-encryptdms-set-channel-key"
                label={channelKeys.get(channel.id) ? "Edit AES Secret Key" : "Set AES Secret Key"}
                icon={EncryptDMsIcon}
                action={() => openChannelKeyModal(channel.id)}
            />
            {renderChannelToggle(channel)}
        </Menu.MenuGroup>
    );
};

let tooltipTimeout: ReturnType<typeof setTimeout> | undefined;

const attachmentWarnSeen = new Set<string>();

type EncodeOutcome =
    | { kind: "encoded"; content: string; }
    | { kind: "skip"; }
    | { kind: "refuse"; }
    | { kind: "warn-attachment-only"; };

async function computeOutgoingEncoding(channelId: string, content: string): Promise<EncodeOutcome> {
    const channel = ChannelStore.getChannel(channelId);
    if (!isChannelEncrypted(channel)) return { kind: "skip" };

    // Encryption is on for this channel, so never fall back to sending plaintext.
    const { key } = resolveSendKey(channel);
    if (!key) {
        showToast({
            text: "Message not sent: auto-encrypt is on but no shared secret is set. Set one in EncryptDMs settings, set a key for this channel, or turn auto-encrypt off.",
            variant: "critical"
        });
        return { kind: "refuse" };
    }

    if (!content) return { kind: "warn-attachment-only" };

    setAutoEncodeTooltip(true);
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    const t = scheduleAutoEncodeTooltipHide(2000);
    if (t) tooltipTimeout = t;

    return { kind: "encoded", content: await encrypt(content, key) };
}

// Voice-message/clip uploads carry metadata Discord needs in cleartext (waveform,
// duration); encrypting them would just produce a broken voice message, so they
// are skipped. Thumbnails piggyback on their parent upload and are skipped too.
function getEncryptableUploads(uploads: CloudUpload[]): CloudUpload[] {
    return uploads.filter(u =>
        u.item?.file instanceof File
        && u.waveform == null
        && !u.isThumbnail
        && !isEncryptedAttachmentName(u.filename)
    );
}

async function encryptUploads(uploads: CloudUpload[], key: string): Promise<void> {
    for (const upload of uploads) {
        const spoiler = upload.spoiler || /^SPOILER_/.test(upload.filename);
        const encrypted = await encryptFile(upload.item.file, key);
        // Spoiler status lives in the filename prefix, which must stay readable —
        // the original filename is sealed inside the ciphertext either way.
        const filename = spoiler ? `SPOILER_${encrypted.name}` : encrypted.name;

        // The upload machinery reads the bytes from item.file and the metadata from
        // the fields below; stale isImage/isVideo would make Discord try to preview
        // or transcode ciphertext.
        upload.item.file = new File([encrypted], filename, { type: encrypted.type });
        upload.filename = filename;
        upload.mimeType = encrypted.type;
        upload.isImage = false;
        upload.isVideo = false;
    }
}

async function handleBeforeSend(channelId: string, message: MessageObject, props: SendMessageProps) {
    const outcome = await computeOutgoingEncoding(channelId, message.content);
    if (outcome.kind === "refuse") return { cancel: true };
    if (outcome.kind === "encoded") message.content = outcome.content;

    // "encoded" and "warn-attachment-only" are the two outcomes where the user has
    // encryption intent AND a usable key — the same gate applies to attachments.
    const encryptionIntent = outcome.kind === "encoded" || outcome.kind === "warn-attachment-only";
    if (!encryptionIntent || !props.hasAttachments) return;

    if (settings.store.encryptAttachments) {
        // The send hook no longer receives the upload list, so refuse rather than upload plaintext.
        showToast({ text: "Message not sent: attachments can't be encrypted right now. Remove them or disable 'Encrypt attachments'.", variant: "critical" });
        return { cancel: true };
    } else if (!attachmentWarnSeen.has(channelId)) {
        attachmentWarnSeen.add(channelId);
        showToast({ text: "Attachments are not encrypted — only message text. Enable 'Encrypt attachments' in EncryptDMs settings." });
    }
}

async function handleBeforeEdit(channelId: string, message: MessageObject) {
    if (!message.content) return;
    const outcome = await computeOutgoingEncoding(channelId, message.content);
    if (outcome.kind === "refuse") return { cancel: true };
    if (outcome.kind === "encoded") {
        message.content = outcome.content;
    }
}

export default definePlugin({
    name: "EncryptDMs",
    description: "End-to-end encrypt DMs, group DMs and channels with AES-256-GCM — text and attachments, with shared, per-user or per-channel keys and per-channel toggles.",
    tags: ["Chat", "Utility", "Privacy"],
    // TODO: replace with your contributor entry from @utils/constants Devs before upstreaming
    authors: [{ name: "YourName", id: 0n }],

    settings,

    contextMenus: {
        "message": messageCtxPatch,
        "user-context": userContextPatch,
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch,
        "gdm-context": channelContextPatch,
    },

    renderMessageAccessory: props => <EncryptDMsAccessory message={props.message} />,

    chatBarButton: {
        icon: EncryptDMsIcon,
        render: EncryptDMsChatBarIcon,
    },

    messagePopoverButton: {
        icon: EncryptDMsIcon,
        render(message: Message) {
            const content = getMessageContent(message);
            if (!content) return null;

            return {
                label: "Decrypt Message",
                icon: EncryptDMsIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => triggerManualDecode(message),
            };
        },
    },

    async onBeforeMessageSend(channelId, message, _options, props) {
        return await handleBeforeSend(channelId, message, props);
    },

    async onBeforeMessageEdit(channelId, _messageId, message) {
        return await handleBeforeEdit(channelId, message);
    },
});
