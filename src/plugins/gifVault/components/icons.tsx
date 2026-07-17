/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
    size?: number;
}

function Icon({ size = 18, children, ...props }: IconProps) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...props}
        >
            {children}
        </svg>
    );
}

export const SearchIcon = (p: IconProps) => (
    <Icon {...p}><circle cx={11} cy={11} r={7} /><path d="m20.5 20.5-4-4" /></Icon>
);

export const CloseIcon = (p: IconProps) => (
    <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>
);

export const SortIcon = (p: IconProps) => (
    <Icon {...p}><path d="M4 6h9M4 12h6M4 18h4" /><path d="m15 9 3.5-3.5L22 9" /><path d="M18.5 5.5V18" /></Icon>
);

export const NewFolderIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        <path d="M12 10.5v5M9.5 13h5" />
    </Icon>
);

export const PopoutIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M14 4h6v6" />
        <path d="M20 4 11 13" />
        <path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </Icon>
);

export const UpIcon = (p: IconProps) => (
    <Icon {...p}><path d="M12 19V6" /><path d="m6 11 6-5.5L18 11" /></Icon>
);

export const HomeIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="m3.5 11 8.5-7.5L20.5 11" />
        <path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.5" />
    </Icon>
);

export const ChevronIcon = (p: IconProps) => (
    <Icon {...p}><path d="m9 5.5 6.5 6.5L9 18.5" /></Icon>
);

export const FolderIcon = (p: IconProps) => (
    <Icon fill="currentColor" stroke="none" {...p}>
        <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L12 7h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </Icon>
);

export const FolderOpenIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1" />
        <path d="M3.4 19h13.9a2 2 0 0 0 1.9-1.4l1.7-5A1.5 1.5 0 0 0 19.5 10H7.1a2 2 0 0 0-1.9 1.4L3 18V7" />
    </Icon>
);

export const SendIcon = (p: IconProps) => (
    <Icon {...p}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" /></Icon>
);

export const CopyIcon = (p: IconProps) => (
    <Icon {...p}>
        <rect x={9} y={9} width={12} height={12} rx={2} />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
);

export const PencilIcon = (p: IconProps) => (
    <Icon {...p}><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></Icon>
);

export const TrashIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M3 6h18" />
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="m6 6 1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </Icon>
);

export const StarIcon = (p: IconProps) => (
    <Icon {...p}><path d="m12 3 2.7 5.4 6 .9-4.3 4.3 1 6L12 16.8 6.6 19.6l1-6L3.3 9.3l6-.9Z" /></Icon>
);

export const UnstarIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="m12 3 2.7 5.4 6 .9-4.3 4.3 1 6L12 16.8 6.6 19.6l1-6L3.3 9.3l6-.9Z" />
        <path d="M4 3.5 20.5 20" />
    </Icon>
);

export const LinkIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11.5 5.4" />
        <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.47" />
    </Icon>
);

export const TagIcon = (p: IconProps) => (
    <Icon {...p}>
        <path d="M12.6 2.6H3.5a1 1 0 0 0-1 1v9.1a1 1 0 0 0 .3.7l8.6 8.6a1 1 0 0 0 1.4 0l9.1-9.1a1 1 0 0 0 0-1.4L13.3 2.9a1 1 0 0 0-.7-.3Z" />
        <circle cx={7.5} cy={7.5} r={1.6} />
    </Icon>
);
