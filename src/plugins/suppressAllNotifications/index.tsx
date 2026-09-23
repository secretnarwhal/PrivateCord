/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Guild } from "@vencord/discord-types";
import { ActiveJoinedThreadsStore, ChannelStore, FluxDispatcher, GuildChannelStore, GuildStore, Menu, ReadStateStore, UserStore } from "@webpack/common";

const logger = new Logger("SuppressAllNotifications");

/** Ack context that makes Discord flush the ack to the server instead of only marking it read locally */
const ACK_CONTEXT = "APP";
const ACK_DEBOUNCE_MS = 1500;
/** ReadStateType.CHANNEL */
const READ_STATE_CHANNEL = 0;

interface AckChannel {
    channelId: string;
    messageId: string | null;
    readStateType: number;
}

const settings = definePluginSettings({
    markAsRead: {
        type: OptionType.BOOLEAN,
        description: "Mark messages from suppressed servers as read as soon as they arrive, so unread badges clear themselves and the server stops considering them unread",
        default: true
    },
    suppressedGuilds: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, boolean>
    },
    suppressedChannels: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, boolean>
    },
    suppressedGuildList: {
        type: OptionType.COMPONENT,
        component: () => <SuppressedList />
    }
});

function isSuppressed(guildId: string | null | undefined): boolean {
    return guildId != null && settings.store.suppressedGuilds[guildId] === true;
}

function isSuppressedChannel(channelId: string | null | undefined): boolean {
    return channelId != null && settings.store.suppressedChannels[channelId] === true;
}

function setSuppressed(guildId: string, value: boolean) {
    const { [guildId]: _, ...rest } = settings.store.suppressedGuilds;
    // replace the whole record so change listeners (settings.use) fire
    settings.store.suppressedGuilds = value ? { ...rest, [guildId]: true } : rest;

    if (value && settings.store.markAsRead) ackGuild(guildId);
}

function setSuppressedChannel(channelId: string, value: boolean) {
    const { [channelId]: _, ...rest } = settings.store.suppressedChannels;
    // replace the whole record so change listeners (settings.use) fire
    settings.store.suppressedChannels = value ? { ...rest, [channelId]: true } : rest;

    if (value && settings.store.markAsRead) ackChannel(channelId);
}

function getGuildIdForMessage(message: any, channelId: string) {
    return ChannelStore.getChannel(channelId)?.getGuildId() ?? message?.guild_id ?? null;
}

/** Display name & type label for a DM or group DM channel, for the settings list */
function getDMChannelInfo(channelId: string): { name: string; description: string; } {
    const channel: Channel | undefined = ChannelStore.getChannel(channelId);
    if (channel == null) return { name: `Unknown Conversation (${channelId})`, description: "Direct Message" };

    if (channel.isMultiUserDM()) {
        const name = channel.name || channel.recipients
            .map(id => UserStore.getUser(id))
            .filter(user => user != null)
            .map(user => user.globalName || user.username)
            .join(", ") || `Group DM (${channelId})`;
        return { name, description: "Group DM" };
    }

    const recipientId = channel.getRecipientId();
    const user = recipientId ? UserStore.getUser(recipientId) : undefined;
    return {
        name: user ? (user.globalName || user.username) : `Unknown User (${channelId})`,
        description: "Direct Message"
    };
}

// #region marking as read

const pendingAcks = new Map<string, string | null>();
let ackTimeout: ReturnType<typeof setTimeout> | null = null;

function bulkAck(channels: AckChannel[]) {
    if (channels.length === 0) return;

    FluxDispatcher.dispatch({
        type: "BULK_ACK",
        context: ACK_CONTEXT,
        channels
    });
}

function flushAcks() {
    ackTimeout = null;

    const channels = Array.from(pendingAcks, ([channelId, messageId]) => ({
        channelId,
        messageId,
        readStateType: READ_STATE_CHANNEL
    }));
    pendingAcks.clear();

    bulkAck(channels);
}

function queueAck(channelId: string, messageId: string | null) {
    pendingAcks.set(channelId, messageId);
    ackTimeout ??= setTimeout(flushAcks, ACK_DEBOUNCE_MS);
}

/** Marks every unread channel & joined thread of a guild as read */
function ackGuild(guildId: string) {
    try {
        // during startup the stores are still empty, in which case there is nothing to ack yet
        const guildChannels = GuildChannelStore.getChannels(guildId);
        if (guildChannels?.SELECTABLE == null) return;

        const channels = [...guildChannels.SELECTABLE, ...(guildChannels.VOCAL ?? [])]
            .concat(
                Object.values(ActiveJoinedThreadsStore.getActiveJoinedThreadsForGuild(guildId) ?? {})
                    .flatMap(threads => Object.values(threads))
            )
            .filter(({ channel }) => ReadStateStore.hasUnread(channel.id))
            .map(({ channel }) => ({
                channelId: channel.id,
                messageId: ReadStateStore.lastMessageId(channel.id),
                readStateType: READ_STATE_CHANNEL
            }));

        bulkAck(channels);
    } catch (err) {
        logger.error(`Failed to mark guild ${guildId} as read`, err);
    }
}

function ackAllSuppressedGuilds() {
    for (const guildId of Object.keys(settings.store.suppressedGuilds)) {
        if (isSuppressed(guildId)) ackGuild(guildId);
    }
}

/** Marks a single DM/group DM channel as read, if it has anything unread */
function ackChannel(channelId: string) {
    try {
        if (!ReadStateStore.hasUnread(channelId)) return;

        bulkAck([{
            channelId,
            messageId: ReadStateStore.lastMessageId(channelId),
            readStateType: READ_STATE_CHANNEL
        }]);
    } catch (err) {
        logger.error(`Failed to mark channel ${channelId} as read`, err);
    }
}

function ackAllSuppressedChannels() {
    for (const channelId of Object.keys(settings.store.suppressedChannels)) {
        if (isSuppressedChannel(channelId)) ackChannel(channelId);
    }
}

// #endregion

// #region ui

const SuppressAllSetting = ErrorBoundary.wrap(({ guildId }: { guildId: string; }) => {
    const { suppressedGuilds } = settings.use(["suppressedGuilds"]);

    return (
        <>
            <Divider />
            <FormSwitch
                title="Suppress absolutely all notifications"
                description="Never notify for this server, whatever the settings above say: no desktop notifications, no notification sounds. Incoming messages are marked as read right away, so unread badges clear too."
                value={suppressedGuilds[guildId] === true}
                onChange={value => setSuppressed(guildId, value)}
                hideBorder
            />
        </>
    );
}, { noop: true });

function SuppressedList() {
    const { suppressedGuilds, suppressedChannels } = settings.use(["suppressedGuilds", "suppressedChannels"]);
    const guildIds = Object.keys(suppressedGuilds).filter(id => suppressedGuilds[id] === true);
    const channelIds = Object.keys(suppressedChannels).filter(id => suppressedChannels[id] === true);

    if (guildIds.length === 0 && channelIds.length === 0) {
        return (
            <Paragraph>
                Nothing is suppressed yet. Turn this on per server via <b>Notification Settings</b> (or by right
                clicking the server), and per DM by right clicking a conversation in the DM list.
            </Paragraph>
        );
    }

    return (
        <>
            <Paragraph>
                Servers and conversations that never notify you. Mobile push notifications are decided by Discord's
                servers, so turn off <b>Mobile Push Notifications</b> separately if you use the mobile app.
            </Paragraph>
            {guildIds.map(guildId => (
                <FormSwitch
                    key={guildId}
                    title={GuildStore.getGuild(guildId)?.name ?? `Unknown Server (${guildId})`}
                    value={true}
                    onChange={() => setSuppressed(guildId, false)}
                />
            ))}
            {channelIds.map(channelId => {
                const { name, description } = getDMChannelInfo(channelId);
                return (
                    <FormSwitch
                        key={channelId}
                        title={name}
                        description={description}
                        value={true}
                        onChange={() => setSuppressedChannel(channelId, false)}
                    />
                );
            })}
        </>
    );
}

const guildContextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (guild == null) return;

    // the notification settings submenu, right below Discord's own "Mobile Push Notifications" toggle
    const group = findGroupChildrenByChildId("mobile-push", children)
        ?? findGroupChildrenByChildId("guild-notifications", children);
    if (group == null) return;

    group.push(
        <Menu.MenuCheckboxItem
            id="vc-suppress-all-notifications"
            label="Suppress All Notifications"
            checked={isSuppressed(guild.id)}
            action={() => setSuppressed(guild.id, !isSuppressed(guild.id))}
        />
    );
};

const dmContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (channel == null) return;

    // DMs/group DMs don't have a full Notification Settings modal like servers do, so anchor
    // next to the mute toggle in the sidebar's right click menu instead, falling back to
    // "close-dm"/"leave-channel" if the mute toggle isn't present in this menu
    const group = findGroupChildrenByChildId(["mute-channel", "unmute-channel"], children)
        ?? findGroupChildrenByChildId(["close-dm", "leave-channel"], children);
    if (group == null) return;

    group.push(
        <Menu.MenuCheckboxItem
            id="vc-suppress-all-notifications"
            label="Suppress All Notifications"
            checked={isSuppressedChannel(channel.id)}
            action={() => setSuppressedChannel(channel.id, !isSuppressedChannel(channel.id))}
        />
    );
};

// #endregion

export default definePlugin({
    name: "SuppressAllNotifications",
    description: "Adds a per server/DM \"Suppress absolutely all notifications\" toggle that actually silences everything: no desktop notifications, no sounds, and new messages are marked as read instantly",
    tags: ["Notifications", "Servers", "Chat"],
    searchTerms: ["mute", "suppress", "silence", "ignore server", "ignore dm"],
    authors: [],
    settings,

    contextMenus: {
        "guild-context": guildContextMenuPatch,
        "guild-header-popout": guildContextMenuPatch,
        "user-context": dmContextMenuPatch,
        "gdm-context": dmContextMenuPatch
    },

    patches: [
        {
            // Discord's notification gate, used for desktop notifications & notification sounds
            find: ".SUPPRESS_NOTIFICATIONS))return!1",
            replacement: [
                {
                    // shouldNotify(message, channelId, ...)
                    match: /(\.SUPPRESS_NOTIFICATIONS\)\)return!1;)/,
                    replace: "$1if($self.isSuppressedMessage(arguments[0],arguments[1]))return!1;"
                },
                {
                    // shouldNotifyForSelectedChannel(message, channelId)
                    match: /function \i\((\i),(\i)\)\{if\(\i\.\i\.getChannelId\(\i\.\i\.getGuildId\(\)\)!==\i\)return!1;/,
                    replace: "$&if($self.isSuppressedMessage($1,$2))return!1;"
                },
                {
                    // the gate shared by message, forum thread, reaction & stage start notifications
                    match: /(let (\i)=\i\.getGuildId\(\);)(?=return!\()/,
                    replace: "$1if($self.isSuppressedGuildId($2))return!1;"
                }
            ]
        },
        {
            // The per server Notification Settings modal
            find: '"NotificationSettingsModal"',
            replacement: [
                {
                    // keep the guild id of the toggle section around for our own toggle
                    match: /let\{suppressEveryone:.{0,150}?guildId:(\i)\}=\i;/,
                    replace: "$&const vcSuppressAllGuildId=$1;"
                },
                {
                    // append our toggle after "Mobile Push Notifications"
                    match: /(onChange:\i=>\i\("mobile_push",\i,\i\.\i\.mobilePush\(\i\)\)\}\))(\]\})/,
                    replace: "$1,$self.renderSuppressAllSetting(vcSuppressAllGuildId)$2"
                },
                {
                    // same, for the redesigned modal
                    match: /(onChange:\i=>\i\((\i),\{mobile_push:\i\},\i\.\i\.mobilePush\(\i\)\)\}\))(\]\})/,
                    replace: "$1,$self.renderSuppressAllSetting($2)$3"
                }
            ]
        }
    ],

    isSuppressedMessage(message: any, channelId: string) {
        try {
            const guildId = getGuildIdForMessage(message, channelId);
            // guildId is null for DMs & group DMs, fall back to checking the channel itself
            return guildId != null ? isSuppressed(guildId) : isSuppressedChannel(channelId);
        } catch (err) {
            logger.error("Failed to check whether a message is suppressed", err);
            return false;
        }
    },

    isSuppressedGuildId(guildId: string | null | undefined) {
        try {
            return isSuppressed(guildId);
        } catch (err) {
            logger.error("Failed to check whether a server is suppressed", err);
            return false;
        }
    },

    renderSuppressAllSetting(guildId: string) {
        return <SuppressAllSetting guildId={guildId} />;
    },

    flux: {
        MESSAGE_CREATE({ channelId, message, optimistic }: { channelId: string; message: any; optimistic?: boolean; }) {
            if (optimistic || !settings.store.markAsRead) return;

            const guildId = getGuildIdForMessage(message, channelId);
            const suppressed = guildId != null ? isSuppressed(guildId) : isSuppressedChannel(channelId);
            if (!suppressed) return;

            queueAck(channelId, message?.id ?? null);
        },

        CONNECTION_OPEN() {
            if (!settings.store.markAsRead) return;
            // read states arrive with READY, give them a moment to settle
            setTimeout(() => {
                ackAllSuppressedGuilds();
                ackAllSuppressedChannels();
            }, 5000);
        }
    },

    start() {
        if (settings.store.markAsRead) {
            ackAllSuppressedGuilds();
            ackAllSuppressedChannels();
        }
    },

    stop() {
        if (ackTimeout != null) {
            clearTimeout(ackTimeout);
            ackTimeout = null;
        }
        pendingAcks.clear();
    }
});
