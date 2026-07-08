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
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { ChannelStore, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

import { importPublicKeyB64, KEY_PREFIX } from "./crypto";
import { getIdentity, setChannelEnabled, storeAcceptedKey } from "./keys";

export const cl = classNameFactory("vc-encryptdms-");

export const logger = new Logger("EncryptDMs");

/** Verbatim from EncryptDMs.java: shown instead of plaintext when encryption fails in an enabled channel. */
export const ENCRYPT_FAILED_PLACEHOLDER =
    "[EncryptDMs] Could not encrypt this message. Check that this chat has accepted public keys.";

export function getChannelRecipientIds(channelId: string): string[] {
    return ChannelStore.getChannel(channelId)?.recipients ?? [];
}

/** Sends "<edm:v1:key>:<my spki b64>" to the given channel (or the currently selected one). */
export async function sendMyKey(channelId?: string): Promise<void> {
    const targetChannelId = channelId || SelectedChannelStore.getChannelId();
    if (!targetChannelId) {
        showToast("Open a chat before sending your key", Toasts.Type.FAILURE);
        return;
    }

    const identity = getIdentity();
    if (!identity) {
        showToast("EncryptDMs identity is not ready yet", Toasts.Type.FAILURE);
        return;
    }

    try {
        await sendMessage(targetChannelId, { content: KEY_PREFIX + identity.publicKey });
        showToast("Encryption key sent", Toasts.Type.SUCCESS);
    } catch (e) {
        logger.error("Failed to send encryption key", e);
        showToast("Failed to send encryption key", Toasts.Type.FAILURE);
    }
}

/**
 * The accept-key flow from EncryptDMs.java: validate the key, store it in
 * userKeys + channelKeys, enable encryption for the channel, then send my own
 * key share back.
 */
export async function acceptKeyAndSendMine(channelId: string, userId: string, publicKeyB64: string): Promise<void> {
    try {
        await importPublicKeyB64(publicKeyB64);
    } catch {
        showToast("Invalid encryption key", Toasts.Type.FAILURE);
        return;
    }

    await storeAcceptedKey(channelId, userId, publicKeyB64);
    await setChannelEnabled(channelId, true);
    showToast("Encryption key accepted", Toasts.Type.SUCCESS);

    await sendMyKey(channelId);
}
