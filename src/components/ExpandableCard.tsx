/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ExpandableCard.css";

import { classes } from "@utils/misc";
import { Clickable, useState } from "@webpack/common";
import { PropsWithChildren, ReactNode } from "react";

import { Card } from "./Card";
import { DownArrow, RightArrow } from "./Icons";

export type ExpandableSectionProps = PropsWithChildren<{
    renderContent: () => React.ReactNode;
    className?: string;
    initialExpanded?: boolean;
}>;

/**
 * A card component that can expand and collapse to show/hide content. The header (props.children) is always visible, and the content (props.renderContent) is only visible when expanded.
 */
export function ExpandableSection({ children, renderContent, className, initialExpanded = false }: ExpandableSectionProps) {
    const [expanded, setExpanded] = useState(initialExpanded);

    const Icon = expanded ? DownArrow : RightArrow;

    return (
        <Card data-expanded={expanded} className={classes("vc-expandable-card", className)}>
            <Clickable className="vc-expandable-card-header" onClick={() => setExpanded(c => !c)} >
                {children}
                <Icon className="vc-expandable-card-icon" />
            </Clickable>

            {expanded
                ? <div className="vc-expandable-card-content">
                    <ExpandableContent render={renderContent} />
                </div>
                : null
            }
        </Card>
    );
}

/**
 * renderContent is nearly always an inline arrow, so using it directly as an
 * element type would give the content a brand new component type on every
 * render, remounting the whole subtree and throwing away input focus and local
 * state along with it. Going through one stable type keeps the subtree mounted,
 * while still giving renderContent a hook scope of its own.
 */
function ExpandableContent({ render }: { render: () => ReactNode; }) {
    return <>{render()}</>;
}
