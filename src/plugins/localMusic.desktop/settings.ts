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
    showVideo: {
        type: OptionType.BOOLEAN,
        description: "Show the picture for video files. When off, videos get the audio visualizer too. Also toggleable from the player itself",
        default: true
    },
    showLyrics: {
        type: OptionType.BOOLEAN,
        description: "Show live lyrics in the player instead of the visualizer. Also toggleable from the player itself",
        default: false
    },
    lyricsOnline: {
        type: OptionType.BOOLEAN,
        description: "Look lyrics up on LRCLIB when the file has none of its own. Only the track, artist, album and length are sent",
        default: true
    },
    lyricsWordLevel: {
        type: OptionType.BOOLEAN,
        description: "Look up word-by-word timing (via NetEase) so the highlight follows the singer instead of being estimated. Falls back to LRCLIB when a track has none",
        default: true
    },
    lyricsOffset: {
        type: OptionType.SLIDER,
        description: "Nudge the lyrics timing, in milliseconds. Positive shows them earlier",
        default: 0,
        markers: [-2000, -1000, -500, 0, 500, 1000, 2000],
        stickToMarkers: false
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
    listenAlongAllowPlayback: {
        type: OptionType.BOOLEAN,
        description: "Listen along: let newly joined listeners control playback (slider, play/pause, skip) by default",
        default: true
    },
    listenAlongAllowAddToQueue: {
        type: OptionType.BOOLEAN,
        description: "Listen along: let newly joined listeners add tracks to the queue by default",
        default: true
    },
    listenAlongAllowReorderQueue: {
        type: OptionType.BOOLEAN,
        description: "Listen along: let newly joined listeners reorder and remove queued tracks by default",
        default: false
    },
    listenAlongCacheLimit: {
        type: OptionType.SELECT,
        description: "Listen along: how much disk space received tracks may take up before the oldest are evicted",
        options: [
            { label: "512 MB", value: 512 * 1024 * 1024 },
            { label: "2 GB", value: 2 * 1024 * 1024 * 1024, default: true },
            { label: "8 GB", value: 8 * 1024 * 1024 * 1024 },
            { label: "Unlimited", value: 0 }
        ]
    },
    cookiesFromBrowser: {
        type: OptionType.SELECT,
        description: "Read cookies from this browser instead of the Browse… window's own sign-in. Only needed if you'd rather not sign in there",
        options: [
            { label: "Use the Browse… window's sign-in (default)", value: "", default: true },
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
