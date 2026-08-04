/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

/**
 * The deployed PrivateCord room. Ergo 2.19 behind nginx on an Oracle Cloud VPS;
 * see `outputs/irc-server-deployment.md` and the server-side HANDOFF for the
 * operational details.
 *
 * The host is a bare IP because there is no domain yet, which means the TLS
 * certificate is an IP-address cert on Let's Encrypt's `shortlived` profile —
 * ~6.7 day lifetime. If connections start failing before the socket ever opens,
 * suspect the certificate first.
 */
export const DEFAULT_SERVER_URL = "wss://150.136.150.196/webirc";
export const DEFAULT_CHANNEL = "#privatecord";

export const settings = definePluginSettings({
    serverUrl: {
        type: OptionType.STRING,
        description: "IRC websocket URL (ws:// or wss://)",
        default: DEFAULT_SERVER_URL,
        placeholder: DEFAULT_SERVER_URL,
        restartNeeded: false,
        isValid(value: string) {
            if (!value) return "A server URL is required";
            try {
                const { protocol } = new URL(value);
                if (protocol !== "ws:" && protocol !== "wss:") {
                    return "URL must start with ws:// or wss://";
                }
            } catch {
                return "Not a valid URL";
            }
            return true;
        }
    },
    channel: {
        type: OptionType.STRING,
        description: "Channel to join",
        default: DEFAULT_CHANNEL,
        placeholder: "#privatecord",
        restartNeeded: false,
        isValid: (value: string) =>
            /^[#&][^\s,\x07]+$/.test(value) || "Channel must start with # and contain no spaces"
    },
    channelKey: {
        type: OptionType.STRING,
        description: "Channel key (only if the room is +k)",
        default: "",
        restartNeeded: false
    },
    nick: {
        type: OptionType.STRING,
        description: "Nickname — leave blank to derive one from your Discord username",
        default: "",
        placeholder: "(auto)",
        restartNeeded: false
    },
    autoConnect: {
        type: OptionType.BOOLEAN,
        description: "Connect automatically when Discord starts",
        default: false,
        restartNeeded: false
    },
    serverPassword: {
        type: OptionType.STRING,
        description: "Server password, if the server requires one. Stored in plain text in your Vencord settings.",
        default: "",
        restartNeeded: false
    },
    saslUsername: {
        type: OptionType.STRING,
        description:
            "SASL account name. The default channel is registered-users-only, so you need an " +
            "account to join it. If you don't have one, connect and run /register <password>.",
        default: "",
        restartNeeded: false
    },
    saslPassword: {
        type: OptionType.STRING,
        description: "SASL password. Stored in plain text in your Vencord settings — use an account password you don't reuse.",
        default: "",
        restartNeeded: false
    },
    showJoinLeave: {
        type: OptionType.BOOLEAN,
        description: "Show join / part / quit lines in the chat log",
        default: true,
        restartNeeded: false
    },
    highlightMentions: {
        type: OptionType.BOOLEAN,
        description: "Highlight messages containing your nickname",
        default: true,
        restartNeeded: false
    }
});
