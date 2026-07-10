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

import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";

import { settings } from "./settings";
import { getChannelPassword, getPermanentPassword } from "./store";

export const cl = classNameFactory("vc-invismsg-");

export const logger = new Logger("InvisibleMessages");

/**
 * The password to use for a channel: the channel-specific password if one is set,
 * otherwise the default password from settings (defaults to "Password"). Mirrors
 * InvisibleMessages.java getPassword().
 */
export function getPassword(channelId: string): string {
    return getChannelPassword(channelId) ?? settings.store.defaultPassword;
}

/**
 * The password reveal mode uses: the permanent password set from the chat-bar
 * button's left-click menu if one is set, otherwise the channel/default password.
 * Used both to auto-decrypt messages and to encrypt secrets typed in the
 * reveal-mode second chatbar.
 */
export function getRevealPassword(channelId: string): string {
    return getPermanentPassword() || getPassword(channelId);
}
