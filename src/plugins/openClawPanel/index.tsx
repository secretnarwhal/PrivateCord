/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ReactDOM } from "@webpack/common";

import { DockPanel } from "./components/SessionPanel";
import { preload } from "./dataStore";
import { setPanelOpen, togglePanel, usePanelOpen } from "./panelStore";
import { settings } from "./settings";
import { cl } from "./utils";

// Discord's titlebar header icon component (same one VencordToolbox hooks into).
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

function OpenClawIcon() {
    return (
        <svg
            className="vc-openclaw-icon"
            width={20}
            height={20}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            {/* Chat bubble */}
            <path
                fill="currentColor"
                d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
                opacity={0.25}
            />
            {/* Claw / spark mark */}
            <path
                fill="currentColor"
                d="M8 8.5 6 7l1 2.4L4.7 10l2.3.7L6 13l2-1.5L10 13l-.7-2.3L11.6 10 9.3 9.4 10 7 8 8.5Zm7.5 1.5-1.2-.9.6 1.4-1.3.4 1.3.4-.6 1.4 1.2-.9 1.2.9-.4-1.4 1.3-.4-1.3-.4.4-1.4-1.2.9Z"
            />
        </svg>
    );
}

/** Wraps DockPanel in a themed backdrop so CSS variables resolve correctly
 *  even though we're portaled outside #app-mount's .theme-dark scope. */
function PanelPortalRoot({ onClose }: { onClose: () => void; }) {
    return (
        <div
            className={cl("backdrop")}
            onClick={e => {
                // Close if the user clicks the backdrop itself (not the modal)
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <DockPanel onClose={onClose} />
        </div>
    );
}

// Rendered as the first child of the titlebar's trailing toolbar (next to the
// pin/profile/search cluster). Clicking toggles the full-window panel; while
// open we portal the panel onto <body> so it floats over the chat content area.
function OpenClawHeaderEntry() {
    const open = usePanelOpen();

    return (
        <>
            <HeaderBarIcon
                className="vc-openclaw-btn"
                onClick={() => togglePanel()}
                tooltip="OpenClaw Panel"
                icon={OpenClawIcon}
                selected={open}
            />
            {open && ReactDOM.createPortal(
                <ErrorBoundary>
                    <PanelPortalRoot onClose={() => setPanelOpen(false)} />
                </ErrorBoundary>,
                document.body
            )}
        </>
    );
}

export default definePlugin({
    name: "OpenClawPanel",
    description: "Full-window OpenClaw chat panel with session management, usage limits, and direct AI conversation — no Discord message sending required.",
    authors: [{ name: "ryan", id: 0n }],
    tags: ["Utility"],

    settings,

    // Warm the session/usage caches at startup so the panel is fully populated the
    // instant it's first opened, rather than fetching on click.
    start() {
        preload();
    },

    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                // VencordToolbox/MassDeleter/Experiments all REPLACE the trailing
                // `\i.Fragment,` token with their own wrapper component. Because Vencord
                // applies patches as sequential single-replacements (see patchWebpack.ts),
                // only the first such plugin wins and every later identical patch no-ops
                // ("had no effect"). To coexist we don't touch the Fragment — we insert our
                // button as the first child of its `children` array, anchoring on
                // `{children:[` (which every wrapper preserves) instead of `Fragment,`.
                //
                // IMPORTANT: userplugins are bundled LAST (see globPlugins order in
                // scripts/build/common.mjs), so this patch ALWAYS runs after those plugins
                // have already swapped `\i.Fragment,` for a long
                // `Vencord.Plugins.plugins["…"].Wrapper,` reference. A fixed `.{0,80}?`
                // budget between `trailing:` and `{children:[` overflows once that
                // expansion is in place, so the replace silently has no effect and the
                // button vanishes. `[^}]*?` instead spans the brace-free jsxs call +
                // component reference no matter how long it grows, and the `}` boundary
                // keeps it from wandering into an unrelated element.
                match: /(trailing:[^}]*?\{children:\[)/,
                replace: "$1$self.renderButton(),"
            }
        }
    ],

    renderButton() {
        return (
            <ErrorBoundary key="vc-openclaw" noop>
                <OpenClawHeaderEntry />
            </ErrorBoundary>
        );
    }
});
