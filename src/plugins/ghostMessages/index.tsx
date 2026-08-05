/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import {
    ApplicationCommandInputType,
    ApplicationCommandOptionType,
    findOption,
    sendBotMessage
} from "@api/Commands";
import definePlugin from "@utils/types";
import { useEffect, UserStore,useState } from "@webpack/common";

import {
    armGhost,
    claimGhost,
    consumeRepeaterSend,
    disarmAll,
    isGhostMode,
    queueGhostDeletion,
    setGhostMode,
    subscribeGhostMode
} from "./ghost";
import { channelLabel, openGhostPanelModal } from "./GhostPanel";
import { GhostDisabledIcon, GhostIcon } from "./icons";
import { setPanelOpener } from "./panel";
import { getJobs, startRepeat, stopAllRepeats, stopRepeatsInChannel } from "./repeater";
import { settings } from "./settings";
import { GhostPreset } from "./types";

const GhostToggle: ChatBarButtonFactory = ({ isMainChat }) => {
    const [enabled, setEnabled] = useState(isGhostMode());

    useEffect(() => subscribeGhostMode(() => setEnabled(isGhostMode())), []);

    if (!isMainChat) return null;

    return (
        <ChatBarButton
            tooltip={enabled
                ? "Ghost mode on — your messages delete themselves (left click for presets)"
                : "Ghost mode off (left click for presets)"}
            onClick={() => openGhostPanelModal()}
            onContextMenu={e => {
                e.preventDefault();
                setGhostMode(!enabled);
            }}
        >
            {enabled ? <GhostIcon /> : <GhostDisabledIcon />}
        </ChatBarButton>
    );
};

function findPreset(name: string) {
    const presets = (settings.store.presets ?? []) as GhostPreset[];
    const query = name.trim().toLowerCase();
    return presets.find(p => p.name.trim().toLowerCase() === query)
        ?? presets.find(p => p.name.trim().toLowerCase().includes(query));
}

export default definePlugin({
    name: "GhostMessages",
    description: "Send messages that delete themselves the moment they land, and repeat saved messages on a timer.",
    authors: [{ name: "Ryan", id: 0n }],
    tags: ["Chat", "Utility"],
    settings,

    chatBarButton: {
        icon: GhostIcon,
        render: GhostToggle
    },

    onBeforeMessageSend(channelId, msg) {
        // a repeat already decided for itself whether this one gets ghosted
        if (consumeRepeaterSend(channelId, msg.content)) return;

        let ghost = isGhostMode();

        const prefix = settings.store.ghostPrefix?.trim();
        if (prefix && msg.content.startsWith(prefix)) {
            const stripped = msg.content.slice(prefix.length).trimStart();
            // stripping everything would just make Discord reject the send
            if (stripped) {
                msg.content = stripped;
                ghost = true;
            }
        }

        if (!ghost) return;

        armGhost(channelId, msg.content);
        if (settings.store.autoDisableGhostMode) setGhostMode(false);
    },

    flux: {
        // The real id of a message we just sent only exists on the echo the
        // gateway sends back, so that is what arms the deletion.
        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (optimistic) return;
            if (!message?.id || !message.channel_id) return;

            const me = UserStore.getCurrentUser()?.id;
            if (!me || message.author?.id !== me) return;

            if (!claimGhost(message.channel_id, message.content ?? "")) return;
            queueGhostDeletion(message.channel_id, message.id);
        }
    },

    commands: [
        {
            name: "ghost",
            description: "Send a message that deletes itself right after it sends",
            inputType: ApplicationCommandInputType.BUILT_IN_TEXT,
            options: [
                {
                    name: "message",
                    description: "What to send",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute: (opts, ctx) => {
                const content = findOption<string>(opts, "message", "");
                // with ghost mode on the pre-send listener arms this already
                if (!isGhostMode()) armGhost(ctx.channel.id, content);
                return { content };
            }
        },
        {
            name: "ghostpanel",
            description: "Open the Ghost Messages panel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => void openGhostPanelModal()
        },
        {
            name: "repeat",
            description: "Start repeating one of your presets in this channel",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "preset",
                    description: "Name of the preset to repeat",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute: (opts, ctx) => {
                const name = findOption<string>(opts, "preset", "");
                const preset = findPreset(name);

                if (!preset) {
                    sendBotMessage(ctx.channel.id, { content: `No preset matching \`${name}\`. Open the Ghost Panel with \`/ghostpanel\` to make one.` });
                    return;
                }

                const error = startRepeat(preset, ctx.channel.id);
                sendBotMessage(ctx.channel.id, {
                    content: error
                        ?? `Repeating **${preset.name}** in ${channelLabel(ctx.channel.id)} every ${Math.round(preset.intervalMs / 1000)}s.`
                });
            }
        },
        {
            name: "repeatstop",
            description: "Stop repeats in this channel, or everywhere",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "everywhere",
                    description: "Stop every running repeat instead of just this channel's",
                    type: ApplicationCommandOptionType.BOOLEAN,
                    required: false
                }
            ],
            execute: (opts, ctx) => {
                const everywhere = findOption<boolean>(opts, "everywhere", false);
                const stopped = everywhere ? stopAllRepeats() : stopRepeatsInChannel(ctx.channel.id);

                sendBotMessage(ctx.channel.id, {
                    content: stopped
                        ? `Stopped ${stopped} repeat(s).`
                        : `Nothing was repeating ${everywhere ? "anywhere" : "here"}. ${getJobs().length} repeat(s) running elsewhere.`
                });
            }
        }
    ],

    start() {
        setPanelOpener(openGhostPanelModal);
    },

    stop() {
        setPanelOpener(null);
        stopAllRepeats();
        setGhostMode(false);
        disarmAll();
        // queued deletions are deliberately left to drain — stopping the plugin
        // shouldn't strand ghost messages in chat
    }
});
