/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { OptionType } from "@utils/types";

function ResetButton() {
    return (
        <>
            <Paragraph>
                Forget every customisation and put all chat bar buttons back where Discord and your
                plugins originally put them.
            </Paragraph>
            <Button
                variant="dangerSecondary"
                size="small"
                onClick={() => {
                    settings.store.barOrder = [];
                    settings.store.trayOrder = [];
                }}
            >
                Reset layout
            </Button>
        </>
    );
}

export const settings = definePluginSettings({
    caretPosition: {
        type: OptionType.SELECT,
        description: "Where the tray caret sits",
        options: [
            { label: "Before the buttons (closest to the message box)", value: "start", default: true },
            { label: "After the buttons", value: "end" }
        ]
    },
    closeOnClick: {
        type: OptionType.BOOLEAN,
        description: "Close the tray once you actually use one of the buttons",
        default: true
    },
    trayColumns: {
        type: OptionType.SLIDER,
        description: "How many buttons fit on one row of the tray",
        markers: [3, 4, 5, 6, 7, 8, 9, 10, 12],
        default: 6,
        stickToMarkers: true
    },
    /** Preferred order of every button that has ever been seen in the chat bar. */
    barOrder: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    },
    /** Ids that live in the tray, in tray order. Membership here is what "hidden" means. */
    trayOrder: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    },
    reset: {
        type: OptionType.COMPONENT,
        component: ResetButton
    }
});
