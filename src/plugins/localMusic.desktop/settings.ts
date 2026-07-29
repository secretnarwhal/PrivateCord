/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import type { YtDlpOptions } from "./types";

const HIDE_GO_LIVE_CLASS = "vc-lm-hide-golive";

export function applyGoLiveVisibility(hide: boolean) {
    document.body.classList.toggle(HIDE_GO_LIVE_CLASS, hide);
}

/** Set by the plugin's start(), so settings changes can reach the running player. */
let onMediaKeysChange: (() => void) | undefined;
export function setMediaKeysListener(listener: (() => void) | undefined) {
    onMediaKeysChange = listener;
}

export const settings = definePluginSettings({
    hideGoLiveTile: {
        type: OptionType.BOOLEAN,
        description: "Hide Discord's game activity / \"Go Live\" tile so the music player takes its place",
        default: true,
        onChange: applyGoLiveVisibility
    },
    mediaKeys: {
        type: OptionType.SELECT,
        description: "How the play/pause, next and previous keys on your keyboard reach the player",
        options: [
            {
                label: "Desktop media controls (recommended)",
                value: "session",
                default: true
            },
            {
                label: "Grab the media keys globally — use if the above does nothing",
                value: "global"
            },
            {
                label: "Off",
                value: "off"
            }
        ],
        onChange: () => onMediaKeysChange?.()
    },
    ytDlpPath: {
        type: OptionType.STRING,
        description: "Path to yt-dlp. Leave empty to use ./yt-dlp in your music folder, then whatever is on your PATH",
        default: "",
        placeholder: "/usr/bin/yt-dlp"
    },
    ytDlpArgs: {
        type: OptionType.STRING,
        description: "Flags passed to yt-dlp on every download",
        default: "-x --audio-format mp3 --embed-metadata --embed-thumbnail",
        placeholder: "-x --audio-format mp3"
    },
    cookiesFromBrowser: {
        type: OptionType.SELECT,
        description: "Read cookies from this browser, so your own playlists and Liked Music are reachable",
        options: [
            { label: "Don't use cookies", value: "", default: true },
            { label: "Firefox", value: "firefox" },
            { label: "Chrome", value: "chrome" },
            { label: "Chromium", value: "chromium" },
            { label: "Brave", value: "brave" },
            { label: "Edge", value: "edge" },
            { label: "Opera", value: "opera" },
            { label: "Vivaldi", value: "vivaldi" },
            { label: "Safari", value: "safari" }
        ]
    }
});

/** Bundles the yt-dlp settings with the folder for the native side. */
export function ytDlpOptions(folder: string): YtDlpOptions {
    return {
        folder,
        binary: settings.store.ytDlpPath,
        extraArgs: settings.store.ytDlpArgs,
        cookiesFromBrowser: settings.store.cookiesFromBrowser
    };
}
