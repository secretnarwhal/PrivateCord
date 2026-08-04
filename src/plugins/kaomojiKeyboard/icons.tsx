/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IconComponent } from "@utils/types";

/** A `(^ ^)` face, drawn — the chat bar button and the plugin's mark. */
export const KaomojiIcon: IconComponent = ({ width = 24, height = 24, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        <path d="M7.6 4.8C4.9 7.4 4.9 16.6 7.6 19.2" />
        <path d="M16.4 4.8c2.7 2.6 2.7 11.8 0 14.4" />
        <path d="M8.6 12.4 10.2 10.2 11.8 12.4" />
        <path d="M12.2 12.4 13.8 10.2 15.4 12.4" />
        <path d="M10 15.4c1.3 1.1 2.7 1.1 4 0" />
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
