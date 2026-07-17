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
import { MessageObject, MessageOptions } from "@api/MessageEvents";
import definePlugin from "@utils/types";
import { Channel, CloudUpload, Message, User } from "@vencord/discord-types";
import { ChannelStore, Menu, showToast, Toasts, UserStore } from "@webpack/common";

import { encryptFile, isEncryptedAttachmentName } from "./encryptedAttachment";
import { EncryptDMsAccessory, handleDecode, resolveAesKey } from "./EncryptDMsAccessory";
import { EncryptDMsChatBarIcon, EncryptDMsIcon, scheduleAutoEncodeTooltipHide, setAutoEncodeTooltip } from "./EncryptDMsIcon";
import { settings } from "./settings";
import { openUserKeyModal } from "./UserKeyModal";
import { getAllUserKeys, getUserKey } from "./userKeys";
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
    const channel = ChannelStore.getChannel(message.channel_id);
    const { key: aesKey } = resolveAesKey(
        message,
        channel,
        settings.store.aesSecret,
        getAllUserKeys(),
        UserStore.getCurrentUser()?.id,
    );
    const result = await decryptMessage(content, aesKey);
    if (result) {
        handleDecode(message.id, result);
    } else {
        showToast("Could not decrypt this message. Check your shared secret or per-user key.", Toasts.Type.FAILURE);
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

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    const item = (
        <Menu.MenuItem
            id="vc-encryptdms-set-user-key"
            label="Set AES Secret Key"
            icon={EncryptDMsIcon}
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
    | { kind: "refuse"; }
    | { kind: "warn-attachment-only"; };

async function computeOutgoingEncoding(channelId: string, content: string): Promise<EncodeOutcome> {
    const channel = ChannelStore.getChannel(channelId);
    const aesSecretSetting = settings.store.aesSecret;
    const { key: aesKey, hasUserKey, recipients } = resolveSendAesKey(channel, aesSecretSetting);

    const isPrivate = !!channel?.isPrivate?.();
    const isOneOnOne = isPrivate && recipients.length === 1;

    // Ambiguity: in group DMs or guilds, per-user keys can't apply. If the user
    // has any per-user key matching ANY recipient (or any per-user key at all
    // for guild channels) and has expressed encryption intent, refuse — the send
    // is cancelled rather than silently going out in plaintext.
    if (settings.store.autoEncodeOutgoing && !aesSecretSetting && !isOneOnOne) {
        const allKeys = getAllUserKeys();
        const hasMatchingKey = recipients.some(id => allKeys[id]);
        if (hasMatchingKey || (!isPrivate && Object.keys(allKeys).length > 0)) {
            showToast(
                "Message not sent: per-user AES keys don't apply in group DMs or servers. Set a global shared secret in EncryptDMs settings or disable auto-encrypt.",
                Toasts.Type.FAILURE
            );
            return { kind: "refuse" };
        }
    }

    if (!content) {
        if (hasUserKey || (settings.store.autoEncodeOutgoing && aesSecretSetting)) {
            return { kind: "warn-attachment-only" };
        }
        return { kind: "skip" };
    }

    // A per-user key bypasses the autoEncodeOutgoing toggle and always AES-encrypts.
    if (!hasUserKey && !settings.store.autoEncodeOutgoing) return { kind: "skip" };

    if (!aesKey) {
        showToast("Set a shared AES secret in the EncryptDMs settings before sending.", Toasts.Type.FAILURE);
        return { kind: "skip" };
    }

    setAutoEncodeTooltip(true);
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    const t = scheduleAutoEncodeTooltipHide(2000);
    if (t) tooltipTimeout = t;

    const encoded = await encrypt(content, aesKey);
    return { kind: "encoded", content: encoded };
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

async function handleBeforeSend(channelId: string, message: MessageObject, options?: MessageOptions) {
    const outcome = await computeOutgoingEncoding(channelId, message.content);
    if (outcome.kind === "refuse") return { cancel: true };
    if (outcome.kind === "encoded") message.content = outcome.content;

    // "encoded" and "warn-attachment-only" are the two outcomes where the user has
    // encryption intent AND a usable key — the same gate applies to attachments.
    const encryptionIntent = outcome.kind === "encoded" || outcome.kind === "warn-attachment-only";
    const allUploads = options?.uploads ?? [];
    if (!encryptionIntent || allUploads.length === 0) return;

    const uploads = getEncryptableUploads(allUploads);
    if (settings.store.encryptAttachments && uploads.length > 0) {
        const channel = ChannelStore.getChannel(channelId);
        const { key: aesKey } = resolveSendAesKey(channel, settings.store.aesSecret);
        try {
            await encryptUploads(uploads, aesKey);
        } catch {
            // Never let a failed encryption fall through to a plaintext upload.
            showToast("Failed to encrypt attachments — message not sent.", Toasts.Type.FAILURE);
            return { cancel: true };
        }
    } else if (!settings.store.encryptAttachments && !attachmentWarnSeen.has(channelId)) {
        attachmentWarnSeen.add(channelId);
        showToast("Attachments are not encrypted — only message text. Enable 'Encrypt attachments' in EncryptDMs settings.", Toasts.Type.MESSAGE);
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
    description: "End-to-end encrypt DMs with AES-256-GCM — text and attachments, shared-secret or per-user keys, directly in chat.",
    tags: ["Chat", "Utility", "Privacy"],
    // TODO: replace with your contributor entry from @utils/constants Devs before upstreaming
    authors: [{ name: "YourName", id: 0n }],

    settings,

    contextMenus: {
        "message": messageCtxPatch,
        "user-context": userContextPatch,
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

    async onBeforeMessageSend(channelId, message, options) {
        return await handleBeforeSend(channelId, message, options);
    },

    async onBeforeMessageEdit(channelId, _messageId, message) {
        return await handleBeforeEdit(channelId, message);
    },
});
