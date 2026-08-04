/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IconComponent } from "@utils/types";

const GHOST_PATH = "M12 2a8 8 0 0 0-8 8v10.4a1 1 0 0 0 1.6.8L8 19.4l2.4 1.8a1 1 0 0 0 1.2 0l2.4-1.8 2.4 1.8a1 1 0 0 0 1.6-.8V10a8 8 0 0 0-8-8Zm-2.6 8.6a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Zm5.2 0a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Z";

export const GhostIcon: IconComponent = ({ height = 20, width = 20, className, children }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        className={className}
    >
        <path
            fill="currentColor"
            fillRule="evenodd"
            // only the disabled variant passes children, and they are the mask this cuts out
            mask={children ? "url(#vc-ghost-msg-mask)" : undefined}
            d={GHOST_PATH}
        />
        {children}
    </svg>
);

export const GhostDisabledIcon: IconComponent = props => (
    <GhostIcon {...props}>
        <mask id="vc-ghost-msg-mask">
            <path fill="#fff" d="M0 0h24v24H0Z" />
            <path stroke="#000" strokeWidth="5.99068" d="M0 24 24 0" />
        </mask>
        <path fill="var(--status-danger)" d="m21.178 1.70703 1.414 1.414L4.12103 21.593l-1.414-1.415L21.178 1.70703Z" />
    </GhostIcon>
);
