/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, SelectedChannelStore } from "@webpack/common";

export interface Target {
    id: string;
    label: string;
    /**
     * Discord's class names are hashed per build, but the readable prefix in
     * front of the hash is stable, so match on that rather than the whole name.
     */
    selector: string;
    /** Whether this target is on screen and worth mirroring right now */
    isRelevant(): boolean;
}

function viewingDm() {
    const id = SelectedChannelStore?.getChannelId?.();
    if (!id) return false;

    const type = ChannelStore?.getChannel?.(id)?.type;
    return type === ChannelType.DM || type === ChannelType.GROUP_DM;
}

export const TARGETS: Target[] = [
    {
        id: "dmList",
        label: "DM list",
        selector: '[class*="privateChannels_"]',
        // The sidebar only exists on the @me route, so its presence is the check
        isRelevant: () => true
    },
    {
        id: "dmChat",
        label: "DM conversation",
        // Covers the header, message list and composer in one subtree
        selector: '[class*="chatContent_"], [class*="chat_"]',
        isRelevant: viewingDm
    }
];

export function findTargetElement(target: Target): HTMLElement | null {
    for (const selector of target.selector.split(",")) {
        const el = document.querySelector<HTMLElement>(selector.trim());
        if (el) return el;
    }
    return null;
}
