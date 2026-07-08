/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    gatewayUrl: {
        type: OptionType.STRING,
        description: "Base URL of the OpenClaw gateway",
        default: "http://127.0.0.1:18789",
        restartNeeded: false
    },
    sessionLimit: {
        type: OptionType.NUMBER,
        description: "Maximum number of recent sessions to display in the browser",
        default: 25,
        restartNeeded: false
    }
});
