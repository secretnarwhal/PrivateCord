/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { OptionType } from "@utils/types";

import { openGhostPanel } from "./panel";
import { GhostPreset } from "./types";

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => (
            <section>
                <Paragraph>
                    Presets and running repeats live in the Ghost Panel. You can also open it by
                    right clicking the ghost button in the chat bar, or with <code>/ghostpanel</code>.
                </Paragraph>
                <Button style={{ marginTop: 8 }} onClick={openGhostPanel}>Open Ghost Panel</Button>
            </section>
        )
    },
    deleteDelay: {
        type: OptionType.NUMBER,
        description: "How long to wait after a ghost message arrives before deleting it (ms)",
        default: 1000
    },
    deleteSpacing: {
        type: OptionType.NUMBER,
        description: "Minimum gap between two deletions (ms). Raise this if you get rate limited",
        default: 1000
    },
    autoDisableGhostMode: {
        type: OptionType.BOOLEAN,
        description: "Turn ghost mode back off after sending one message",
        default: false
    },
    ghostPrefix: {
        type: OptionType.STRING,
        description: "Messages starting with this are ghosted even when ghost mode is off, and the prefix is stripped. Leave empty to disable",
        default: ""
    },
    presets: {
        type: OptionType.CUSTOM,
        default: [] as GhostPreset[]
    }
});
