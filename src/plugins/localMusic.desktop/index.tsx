/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin from "@utils/types";

import { MiniPlayer } from "./MiniPlayer";
import { store } from "./PlayerStore";
import { sessionStore } from "./session/SessionStore";
import { handleIncomingSignal } from "./session/signaling";
import { applyGoLiveVisibility, setMediaKeysListener, settings } from "./settings";

export default definePlugin({
    name: "LocalMusic",
    description: "A music player for your local files, docked above the account panel — with serverless listen-along sessions",
    tags: ["Media", "Activity"],
    authors: [{ name: "Ryan", id: 0n }],
    settings,

    patches: [
        {
            // same account panel Discord renders the game tile and voice panel into
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                // Matches the raw AccountPanel identifier, or a wrapper another plugin
                // (SpotifyControls) already substituted in — the latter looks like
                // Vencord.Plugins.plugins["SpotifyControls"].PanelWrapper, hence the
                // bracket alternative. Lazy so it stops at the first matching `,{`.
                match: /(?<=\i\.jsxs?\)\()((?:[\w$.]|\[[^\]]*\])+?),\{(?=[^}]*?userTag:\i,occluded:)/,
                // a distinct prop name means we nest with other panel plugins instead of
                // fighting them over `VencordOriginal`
                replace: "$self.MusicPanelWrapper,{vcLocalMusicOriginal:$1,"
            }
        }
    ],

    flux: {
        // listen-along handshakes ride over DMs; anything not signal-shaped is
        // rejected on a string prefix check before any real work happens
        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic: boolean; }) {
            if (!optimistic) handleIncomingSignal(message);
        }
    },

    start() {
        applyGoLiveVisibility(settings.store.hideGoLiveTile);
        setMediaKeysListener(() => void store.applyMediaKeyMode());
        store.init().catch(e => console.error("[LocalMusic] failed to restore library:", e));
    },

    stop() {
        applyGoLiveVisibility(false);
        setMediaKeysListener(undefined);
        // end/leave any session first — it says goodbye over channels the
        // player teardown is about to close
        sessionStore.destroy();
        store.destroy();
    },

    MusicPanelWrapper({ vcLocalMusicOriginal: Original, ...props }) {
        return (
            <>
                <ErrorBoundary
                    fallback={() => (
                        <div className="vc-lm-error">Music player failed to render — check the console</div>
                    )}
                >
                    <MiniPlayer />
                </ErrorBoundary>

                <Original {...props} />
            </>
        );
    }
});
