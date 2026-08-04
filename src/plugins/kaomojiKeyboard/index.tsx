/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import definePlugin from "@utils/types";
import { Popout, useRef, useState } from "@webpack/common";

import { KaomojiIcon } from "./icons";
import { KaomojiPicker } from "./Picker";
import { settings } from "./settings";
import { loadStore } from "./store";
import { cl } from "./utils";

const KaomojiChatBarButton: ChatBarButtonFactory = ({ isMainChat }) => {
    const buttonRef = useRef<HTMLDivElement>(null);
    const [show, setShow] = useState(false);

    if (!isMainChat) return null;

    return (
        <Popout
            position="top"
            align="right"
            spacing={10}
            animation={Popout.Animation.SCALE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            // closing through our own state rather than the popout's `closePopout`, so
            // `show` can never drift out of sync with what's on screen
            renderPopout={() => (
                <ErrorBoundary
                    fallback={() => <div className={cl("crash")}>The kaomoji keyboard failed to render — check the console</div>}
                >
                    <KaomojiPicker close={() => setShow(false)} />
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <div className={classes(cl("anchor"), isShown && cl("anchor-open"))} ref={buttonRef}>
                    <ChatBarButton
                        tooltip="Kaomoji"
                        onClick={() => setShow(v => !v)}
                        buttonProps={{ "aria-haspopup": "dialog", "aria-expanded": isShown }}
                    >
                        <KaomojiIcon width={22} height={22} className={cl("icon")} />
                    </ChatBarButton>
                </div>
            )}
        </Popout>
    );
};

export default definePlugin({
    name: "KaomojiKeyboard",
    description: "A kaomoji picker in the chat bar — click a face to drop it into your message, and paste in your own to keep forever ( ˶ˆ ᗜ ˆ˵ )",
    tags: ["Chat", "Customisation"],
    authors: [{ name: "Ryan", id: 0n }],
    settings,

    chatBarButton: {
        icon: KaomojiIcon,
        render: KaomojiChatBarButton
    },

    start() {
        loadStore();
    }
});
