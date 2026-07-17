/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { TooltipContainer } from "@components/TooltipContainer";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { openEncryptDMsModal } from "./EncryptDMsModal";
import { settings } from "./settings";
import { cl } from "./utils";

/** Padlock icon, mirroring the Android plugin's ic_channel_text_locked indicator. */
export const EncryptDMsIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        viewBox="0 0 24 24"
        height={height}
        width={width}
        fill="currentColor"
        className={classes(cl("icon"), className)}
    >
        <path d="M12 1.5a5.5 5.5 0 0 0-5.5 5.5v2.5H6A2.5 2.5 0 0 0 3.5 12v7.5A2.5 2.5 0 0 0 6 22h12a2.5 2.5 0 0 0 2.5-2.5V12A2.5 2.5 0 0 0 18 9.5h-.5V7A5.5 5.5 0 0 0 12 1.5Zm3.5 8h-7V7a3.5 3.5 0 1 1 7 0v2.5ZM12 14a1.75 1.75 0 0 1 1 3.19V19a1 1 0 1 1-2 0v-1.81A1.75 1.75 0 0 1 12 14Z" />
    </svg>
);

let _setter: ((show: boolean) => void) | undefined;

export function setAutoEncodeTooltip(show: boolean) {
    _setter?.(show);
}

// If the icon unmounts before the timeout fires, the captured setter becomes
// the previous mount's no-op setState; the new mount is untouched.
export function scheduleAutoEncodeTooltipHide(ms: number) {
    const captured = _setter;
    if (!captured) return;
    return setTimeout(() => captured(false), ms);
}

export const EncryptDMsChatBarIcon: ChatBarButtonFactory = ({ isMainChat }) => {
    const { autoEncodeOutgoing } = settings.use(["autoEncodeOutgoing"]);

    const [shouldShowTooltip, setter] = useState(false);
    useEffect(() => {
        _setter = setter;
        return () => { if (_setter === setter) _setter = undefined; };
    }, []);

    if (!isMainChat) return null;

    const toggle = () => {
        settings.store.autoEncodeOutgoing = !autoEncodeOutgoing;
    };

    const button = (
        <ChatBarButton
            tooltip={autoEncodeOutgoing ? "Auto-Encrypt Enabled — click to open settings" : "Open EncryptDMs"}
            onClick={e => {
                if (e.shiftKey) return toggle();
                openEncryptDMsModal();
            }}
            onContextMenu={toggle}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <EncryptDMsIcon className={cl({ "auto-encode": autoEncodeOutgoing, "chat-button": true })} />
        </ChatBarButton>
    );

    if (shouldShowTooltip && autoEncodeOutgoing)
        return (
            <TooltipContainer text="Auto-Encrypt Enabled" forceOpen>
                {button}
            </TooltipContainer>
        );

    return button;
};
