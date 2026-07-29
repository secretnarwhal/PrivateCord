/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    hijackFavorites: {
        type: OptionType.BOOLEAN,
        description: "Take over the GIF picker's Favorites section with the GifVault explorer",
        default: true
    },
    clickAction: {
        type: OptionType.SELECT,
        description: "What clicking a GIF does",
        options: [
            { label: "Send it immediately (Discord default)", value: "send", default: true },
            { label: "Insert the link into the chat box", value: "insert" }
        ]
    },
    closeOnSelect: {
        type: OptionType.BOOLEAN,
        description: "Close the GIF picker after inserting a GIF link into the chat box",
        default: true
    },
    playOnHoverOnly: {
        type: OptionType.BOOLEAN,
        description: "Only animate GIFs while hovering them (easier on the CPU with big collections)",
        default: false
    },
    tileSize: {
        type: OptionType.SLIDER,
        description: "Minimum GIF tile size in the explorer (px)",
        markers: [90, 115, 140, 165, 190, 215, 240],
        default: 140,
        stickToMarkers: false
    },
    showStatusBar: {
        type: OptionType.BOOLEAN,
        description: "Show the status bar (item counts + sort mode) at the bottom of the explorer",
        default: true
    },
    sortMode: {
        type: OptionType.SELECT,
        description: "Sort order for GIFs (also changeable from the explorer toolbar)",
        options: [
            { label: "Newest starred first", value: "recent", default: true },
            { label: "Oldest starred first", value: "oldest" },
            { label: "Name (A–Z)", value: "name-az" },
            { label: "Name (Z–A)", value: "name-za" },
            { label: "Shuffled", value: "shuffle" }
        ]
    },
    syncedVaultData: {
        type: OptionType.STRING,
        description: "Internal synced data for GifVault (do not edit)",
        default: "",
        hidden: true
    }
});
