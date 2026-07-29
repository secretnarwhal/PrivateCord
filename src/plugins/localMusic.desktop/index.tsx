/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";

import { MiniPlayer } from "./MiniPlayer";
import { store } from "./PlayerStore";

const HIDE_GO_LIVE_CLASS = "vc-lm-hide-golive";

function applyGoLiveVisibility(hide: boolean) {
    document.body.classList.toggle(HIDE_GO_LIVE_CLASS, hide);
}

const settings = definePluginSettings({
    hideGoLiveTile: {
        type: OptionType.BOOLEAN,
        description: "Hide Discord's game activity / \"Go Live\" tile so the music player takes its place",
        default: true,
        onChange: applyGoLiveVisibility
    }
});

export default definePlugin({
    name: "LocalMusic",
    description: "A music player for your local files, docked above the account panel",
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

    start() {
        applyGoLiveVisibility(settings.store.hideGoLiveTile);
        store.init().catch(e => console.error("[LocalMusic] failed to restore library:", e));
    },

    stop() {
        applyGoLiveVisibility(false);
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
