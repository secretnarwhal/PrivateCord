/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cl } from "./utils";

export function CaretIcon({ open }: { open: boolean; }) {
    return (
        <svg
            className={cl("caret-icon", open && "caret-icon-open")}
            width={20}
            height={20}
            viewBox="0 0 24 24"
            aria-hidden="true"
        >
            <path
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 14.5 12 9l6 5.5"
            />
        </svg>
    );
}
