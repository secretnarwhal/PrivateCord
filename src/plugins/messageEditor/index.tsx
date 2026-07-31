/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 secretnarwhal
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { get as dsGet, set as dsSet } from "@api/DataStore";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { PencilIcon, RestartIcon } from "@components/Icons";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { ChannelStore, Menu, MessageActions, MessageStore, MessageTypeSets } from "@webpack/common";

const DATA_KEY = "MessageEditor_edits";

interface LocalEdit {
    /** What we show instead of what the author actually wrote. */
    content: string;
    /** The real content, kept so "Restore Original" has something to put back. */
    original: string;
}

/** channelId -> messageId -> edit */
type EditsByChannel = Record<string, Record<string, LocalEdit>>;

let edits: EditsByChannel = {};

/**
 * channelId -> messageId, for the edits *we* started. Discord only ever edits
 * one message per channel at a time, so this mirrors EditMessageStore's shape.
 * Anything not in here is a genuine edit of your own message and must be left
 * alone so it still reaches Discord.
 */
const ourEditSessions = new Map<string, string>();

function getEdit(channelId: string, messageId: string) {
    return edits[channelId]?.[messageId];
}

function countEdits() {
    return Object.values(edits).reduce((total, byMessage) => total + Object.keys(byMessage).length, 0);
}

let saveTimeout: ReturnType<typeof setTimeout> | undefined;

function flush() {
    clearTimeout(saveTimeout);
    void dsSet(DATA_KEY, settings.store.persistEdits ? edits : {});
}

function persist() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(flush, 500);
}

/** Swap the content of a cached message, if it is cached and not already showing it. */
function render(channelId: string, messageId: string, content: string) {
    if (MessageStore.getMessage(channelId, messageId)?.content === content) return;
    updateMessage(channelId, messageId, { content });
}

function applyChannel(channelId: string) {
    const byMessage = edits[channelId];
    if (!byMessage) return;

    for (const messageId in byMessage) render(channelId, messageId, byMessage[messageId].content);
}

function canEdit(message: Message) {
    // Components V2 messages render their `components`, not `content`, so
    // rewriting the content would change nothing on screen.
    return MessageTypeSets.USER_MESSAGE.has(message.type)
        && message.state === "SENT"
        && !message.hasFlag(MessageFlags.IS_COMPONENTS_V2);
}

function startEdit(channelId: string, messageId: string) {
    const message = MessageStore.getMessage(channelId, messageId);
    if (!message) return;

    // MESSAGE_START_EDIT is pure store state with no author check, so Discord's
    // own editor opens on anyone's message. We just have to catch the save.
    ourEditSessions.set(channelId, messageId);
    MessageActions.startEditMessage(channelId, messageId, message.content);
}

function commitEdit(channelId: string, messageId: string, content: string) {
    // Once edited, the cached message holds *our* text, so the stored original
    // is the only remaining record of what the author wrote.
    const original = getEdit(channelId, messageId)?.original
        ?? MessageStore.getMessage(channelId, messageId)?.content
        ?? "";

    if (content === original) {
        restoreOriginal(channelId, messageId);
        return;
    }

    (edits[channelId] ??= {})[messageId] = { content, original };
    persist();
    render(channelId, messageId, content);
}

function restoreOriginal(channelId: string, messageId: string) {
    const edit = getEdit(channelId, messageId);
    if (!edit) return;

    delete edits[channelId][messageId];
    if (Object.keys(edits[channelId]).length === 0) delete edits[channelId];

    persist();
    render(channelId, messageId, edit.original);
}

function restoreEvery() {
    for (const channelId in edits)
        for (const messageId in edits[channelId])
            render(channelId, messageId, edits[channelId][messageId].original);
}

const settings = definePluginSettings({
    persistEdits: {
        type: OptionType.BOOLEAN,
        description: "Keep local edits after a restart. Turn this off to have them last only until you reload Discord.",
        default: true,
        onChange: persist
    },
    restoreAll: {
        type: OptionType.COMPONENT,
        component: () => {
            const forceUpdate = useForceUpdater();
            const count = countEdits();

            return (
                <Button
                    variant="dangerSecondary"
                    size="small"
                    disabled={count === 0}
                    onClick={() => {
                        restoreEvery();
                        edits = {};
                        persist();
                        forceUpdate();
                    }}
                >
                    Restore all locally edited messages ({count})
                </Button>
            );
        }
    }
});

const messageContextPatch: NavContextMenuPatchCallback = (children, props: { message?: Message; channel?: Channel; }) => {
    const { message, channel } = props;
    if (!message || !channel || !canEdit(message)) return;

    const isEdited = getEdit(channel.id, message.id) != null;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-edit-message-locally"
                label="Edit Locally"
                icon={PencilIcon}
                action={() => startEdit(channel.id, message.id)}
            />
            {isEdited && (
                <Menu.MenuItem
                    id="vc-restore-message-locally"
                    label="Restore Original"
                    icon={RestartIcon}
                    color="danger"
                    action={() => restoreOriginal(channel.id, message.id)}
                />
            )}
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "MessageEditor",
    description: "Edit the text of any message, including other people's. The edit is local only — nobody else ever sees it.",
    authors: [],
    tags: ["Chat", "Fun", "Utility"],
    settings,

    contextMenus: {
        "message": messageContextPatch
    },

    messagePopoverButton: {
        icon: PencilIcon,
        render(message) {
            if (!canEdit(message)) return null;

            const isEdited = getEdit(message.channel_id, message.id) != null;

            return {
                label: isEdited ? "Edit Locally (Right Click to Restore)" : "Edit Locally",
                icon: PencilIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => startEdit(message.channel_id, message.id),
                onContextMenu: e => {
                    if (!isEdited) return;

                    e.preventDefault();
                    e.stopPropagation();
                    restoreOriginal(message.channel_id, message.id);
                }
            };
        }
    },

    /**
     * Discord's edit box submits through the same path for every message, so this
     * fires for real edits too. Only swallow the ones we opened ourselves.
     */
    onBeforeMessageEdit(channelId, messageId, messageObj) {
        if (ourEditSessions.get(channelId) !== messageId) return;

        ourEditSessions.delete(channelId);
        commitEdit(channelId, messageId, messageObj.content);
        MessageActions.endEditMessage(channelId);

        return { cancel: true };
    },

    flux: {
        // Freshly fetched messages arrive with the author's real content, so put
        // ours back. Plugin flux handlers run after the stores have processed the
        // action, and emitChange is batched, so this is safe mid-dispatch.
        LOAD_MESSAGES_SUCCESS({ channelId }: { channelId: string; }) {
            applyChannel(channelId);
        },

        CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            if (channelId != null) applyChannel(channelId);
        },

        MESSAGE_UPDATE({ message }: { message: { id: string; channel_id: string; content?: string; }; }) {
            const edit = getEdit(message.channel_id, message.id);
            if (!edit) return;

            // The author really did edit it. Track the new truth so a restore
            // puts back what the message says now, not what it used to say.
            if (typeof message.content === "string" && message.content !== edit.original) {
                edit.original = message.content;
                persist();
            }

            render(message.channel_id, message.id, edit.content);
        },

        MESSAGE_END_EDIT({ channelId }: { channelId: string; }) {
            ourEditSessions.delete(channelId);
        }
    },

    async start() {
        edits = await dsGet<EditsByChannel>(DATA_KEY) ?? {};
        for (const channelId in edits) applyChannel(channelId);
    },

    stop() {
        ourEditSessions.clear();
        // Leave `edits` populated so re-enabling brings them back.
        flush();
        restoreEvery();
    }
});
