/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";
import { createRoot } from "@webpack/common";

import { Explorer, ExplorerToolbar } from "./components/Explorer";
import { PopoutHost } from "./components/Popout";
import { settings } from "./settings";
import { cl } from "./utils";
import { FavGif, pickerExplorer, preloadVault, setPopoutOpen, togglePopout } from "./vault";

interface PickerInstance {
    state?: { resultType?: string; };
    props: { contentClassName?: string; };
    handleSelectGIF?: (gif: FavGif) => void;
}

let popoutContainer: HTMLDivElement | null = null;
let popoutRoot: ReturnType<typeof createRoot> | null = null;

export default definePlugin({
    name: "GifVault",
    description: "Turns your favorite GIFs into a file explorer: nested folders, drag & drop, search, sorting, names & tags, and a resizable popout window. Fully replaces the Favorites section of the GIF picker.",
    authors: [{ name: "ryan", id: 0n }],
    tags: ["Media", "Organisation", "Customisation"],

    settings,

    settingsAboutComponent: () => (
        <>
            <HeadingSecondary>How to use</HeadingSecondary>
            <Paragraph>
                Open the GIF picker → Favorites. Click folders to open them, drag GIFs onto folders
                (or breadcrumbs) to organize, and drag folders into folders to nest them. Hovering a
                folder while dragging opens it, like a real file explorer. Backspace goes up one level.
            </Paragraph>
            <Paragraph>
                Right-click GIFs, folders or the background for actions: rename, tags, colors,
                move-to, delete, unfavorite. Drag a GIF into the chat box to insert its link.
                The ↗ toolbar button opens a resizable, movable popout window that works anywhere
                — even with the picker closed.
            </Paragraph>
        </>
    ),

    patches: [
        {
            find: "renderHeaderContent(){",
            replacement: [
                {
                    // Take over the content area of the Favorites view with the GifVault explorer
                    match: /renderContent\(\)\{/,
                    replace: "$&if($self.shouldHijack(this))return $self.renderPickerContent(this);"
                },
                {
                    // Replace the "Favorites" heading with the GifVault toolbar (search/sort/new folder/popout)
                    match: /renderHeaderContent\(\)\{/,
                    replace: "$&if($self.shouldHijack(this))return $self.renderPickerHeader(this);"
                }
            ]
        }
    ],

    shouldHijack(instance: PickerInstance) {
        return settings.store.hijackFavorites && instance?.state?.resultType === "Favorites";
    },

    renderPickerHeader(_instance: PickerInstance) {
        return (
            <ErrorBoundary noop>
                <ExplorerToolbar store={pickerExplorer} variant="picker" />
            </ErrorBoundary>
        );
    },

    renderPickerContent(instance: PickerInstance) {
        return (
            <ErrorBoundary>
                <Explorer
                    store={pickerExplorer}
                    variant="picker"
                    className={cl("picker-root")}
                    onSelectGif={gif => instance.handleSelectGIF?.(gif)}
                />
            </ErrorBoundary>
        );
    },

    toolboxActions: {
        "Toggle GIF Vault window": () => togglePopout()
    },

    start() {
        preloadVault();

        popoutContainer = document.createElement("div");
        popoutContainer.id = "vc-gifvault-popout-root";
        (document.getElementById("app-mount") ?? document.body).appendChild(popoutContainer);
        popoutRoot = createRoot(popoutContainer);
        popoutRoot.render(
            <ErrorBoundary noop>
                <PopoutHost />
            </ErrorBoundary>
        );
    },

    stop() {
        setPopoutOpen(false);
        popoutRoot?.unmount();
        popoutRoot = null;
        popoutContainer?.remove();
        popoutContainer = null;
    }
});
