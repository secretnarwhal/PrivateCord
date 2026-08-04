/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ReactDOM, useEffect, useReducer } from "@webpack/common";

import { IrcPanel } from "./components/IrcPanel";
import { connect, setPanelVisible, shutdown, useIrc } from "./IrcStore";
import { setPanelOpener } from "./panel";
import { settings } from "./settings";
import { cl } from "./utils";

// Discord's titlebar header icon component (the same one VencordToolbox uses).
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ── Panel open/closed state ──────────────────────────────────────────────
// Kept outside React so the header button and the portaled panel share it
// without prop-drilling through Discord's component tree.

let panelOpen = false;
const openListeners = new Set<() => void>();

function setPanelOpen(next: boolean): void {
    if (panelOpen === next) return;
    panelOpen = next;
    setPanelVisible(next);
    openListeners.forEach(l => l());
}

function togglePanel(force?: boolean): void {
    setPanelOpen(force ?? !panelOpen);
}

function usePanelOpen(): boolean {
    const [, forceUpdate] = useReducer(x => x + 1, 0);
    useEffect(() => {
        openListeners.add(forceUpdate);
        return () => void openListeners.delete(forceUpdate);
    }, []);
    return panelOpen;
}

// ── UI ───────────────────────────────────────────────────────────────────

function IrcIcon() {
    return (
        <svg className={cl("icon")} width={20} height={20} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
                opacity={0.25}
            />
            <path
                fill="currentColor"
                d="M9.6 6.5 8.2 14h1.6l1.4-7.5H9.6Zm3.9 0L12.1 14h1.6l1.4-7.5h-1.6ZM6.5 8.6h9.8l.3-1.5H6.8l-.3 1.5Zm-.5 3h9.8l.3-1.5H6.3l-.3 1.5Z"
            />
        </svg>
    );
}

function PanelPortalRoot({ onClose }: { onClose(): void; }) {
    return (
        <div
            className={cl("backdrop")}
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <IrcPanel onClose={onClose} />
        </div>
    );
}

function IrcHeaderEntry() {
    const open = usePanelOpen();
    const { unread } = useIrc();

    return (
        <>
            <div className={cl("btn-wrap")}>
                <HeaderBarIcon
                    className={cl("btn")}
                    onClick={() => togglePanel()}
                    tooltip="IRC Chat"
                    icon={IrcIcon}
                    selected={open}
                />
                {unread && <span className={cl("unread-dot")} aria-hidden="true" />}
            </div>
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
    name: "IrcChat",
    description:
        "Join a shared IRC channel from inside Discord. Messages go to the IRC server, never to Discord.",
    authors: [{ name: "Ryan", id: 0n }],
    tags: ["Chat", "Utility"],

    settings,

    settingsAboutComponent: () => (
        <>
            <Paragraph>
                Everyone running this plugin and pointed at the same server and channel lands in the
                same room. The chat lives entirely on the IRC server — nothing is sent through
                Discord, and nothing appears in any Discord channel.
            </Paragraph>
            <Paragraph>
                <b>You need an account to join.</b> The default channel is registered-users-only,
                which is what makes nicknames actually mean something. If you don't have one yet:
                press Connect, then type <code>/register your-password</code> in the chat box. Put
                your nickname and that password into the SASL fields below, then reconnect.
            </Paragraph>
            <Paragraph>
                <b>The room is only as private as the server.</b> Message content is not logged
                server-side, but connection events and IP addresses are, and history is kept in
                memory for up to 7 days. Treat it as private-ish, not confidential.
            </Paragraph>
        </>
    ),

    start() {
        setPanelOpener(togglePanel);

        if (settings.store.autoConnect) {
            // Deliberately not awaited — a failed connection must not block
            // plugin startup, and the store surfaces errors in the panel.
            connect();
        }
    },

    stop() {
        setPanelOpener(null);
        setPanelOpen(false);
        openListeners.clear();
        shutdown();
    },

    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                // Anchored on `{children:[` rather than the trailing `\i.Fragment,`
                // token that VencordToolbox/MassDeleter/OpenClawPanel all replace —
                // Vencord applies patches as sequential single-replacements, so only
                // the first plugin to claim Fragment wins and the rest silently no-op.
                //
                // `[^}]*?` rather than a fixed budget: userplugins are bundled last,
                // so by the time this runs the gap between `trailing:` and `{children:[`
                // may already contain a long `Vencord.Plugins.plugins["…"].Wrapper,`
                // expansion. The `}` boundary keeps the match from wandering off into
                // an unrelated element.
                match: /(trailing:[^}]*?\{children:\[)/,
                replace: "$1$self.renderButton(),"
            }
        }
    ],

    renderButton() {
        return (
            <ErrorBoundary key="vc-irc" noop>
                <IrcHeaderEntry />
            </ErrorBoundary>
        );
    }
});
