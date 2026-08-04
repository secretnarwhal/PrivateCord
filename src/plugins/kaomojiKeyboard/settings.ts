/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    closeOnSelect: {
        type: OptionType.BOOLEAN,
        description: "Close the keyboard after picking a kaomoji (shift-click always keeps it open)",
        default: true
    },
    trailingSpace: {
        type: OptionType.BOOLEAN,
        description: "Put a space after the kaomoji so you can keep typing straight away",
        default: true
    },
    escapeMarkdown: {
        type: OptionType.BOOLEAN,
        description: "Escape *, _, ~, ` and | too, so faces like (¬_¬) can never be eaten by markdown. Makes the text in the chat box look messier — backslashes are always escaped regardless, which is what ¯\\_(ツ)_/¯ needs",
        default: false
    },
    recentCount: {
        type: OptionType.SLIDER,
        description: "How many recently used kaomoji to keep at the top",
        markers: [0, 8, 16, 24, 32, 40],
        default: 16,
        stickToMarkers: true
    },
    storedData: {
        type: OptionType.STRING,
        description: "Internal storage for your custom kaomoji (do not edit)",
        default: "",
        hidden: true
    }
});
