/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IconComponent } from "@utils/types";

/** The literal `(•ω•)` kaomoji, set as text — the chat bar button and the plugin's mark. */
export const KaomojiIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        aria-hidden="true"
    >
        <text
            x="12"
            y="15.3"
            textAnchor="middle"
            textLength="19"
            lengthAdjust="spacingAndGlyphs"
            fontSize="10.5"
            fontFamily="'Segoe UI Symbol', 'Segoe UI Emoji', sans-serif"
            fill="currentColor"
        >
            (•ω•)
        </text>
    </svg>
);

export const ClipboardIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M9 3.5h6a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
        <path d="M16 5h2.5A1.5 1.5 0 0 1 20 6.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-13A1.5 1.5 0 0 1 5.5 5H8" />
        <path d="M8.5 11.5h7M8.5 15.5h4.5" />
    </svg>
);

export const PlusIcon: IconComponent = ({ width = 16, height = 16, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        aria-hidden="true"
    >
        <path d="M12 5.5v13M5.5 12h13" />
    </svg>
);

export const CloseIcon: IconComponent = ({ width = 12, height = 12, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        aria-hidden="true"
    >
        <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </svg>
);

export const SearchIcon: IconComponent = ({ width = 16, height = 16, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        aria-hidden="true"
    >
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m15 15 4.5 4.5" />
    </svg>
);
