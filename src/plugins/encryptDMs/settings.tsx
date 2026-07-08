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

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { copyWithToast } from "@utils/discord";
import { OptionType } from "@utils/types";
import { Alerts, showToast, Toasts } from "@webpack/common";

import { KEY_PREFIX } from "./crypto";
import { openImportKeyModal } from "./ImportKeyModal";
import { getIdentity, regenerateIdentity } from "./keys";

function copyMyKey() {
    const identity = getIdentity();
    if (!identity) {
        showToast("EncryptDMs identity is not ready yet", Toasts.Type.FAILURE);
        return;
    }
    copyWithToast(KEY_PREFIX + identity.publicKey, "Public key copied to clipboard!");
}

function confirmRegenerate() {
    Alerts.show({
        title: "Regenerate EncryptDMs Identity?",
        body: "This creates a brand-new RSA keypair. You will no longer be able to decrypt any previously received messages, and every peer must accept your new key before encrypted chat works again.",
        confirmText: "Regenerate",
        cancelText: "Cancel",
        onConfirm() {
            regenerateIdentity()
                .then(() => showToast("New identity generated. Send your new key to your chats.", Toasts.Type.SUCCESS))
                .catch(() => showToast("Failed to regenerate identity", Toasts.Type.FAILURE));
        },
    });
}

export const settings = definePluginSettings({
    manageKeys: {
        type: OptionType.COMPONENT,
        description: "Manage your EncryptDMs keys",
        component: () => (
            <Flex>
                <Button onClick={copyMyKey}>
                    Copy My Public Key
                </Button>
                <Button variant="secondary" onClick={openImportKeyModal}>
                    Import a Peer's Public Key
                </Button>
                <Button variant="dangerPrimary" onClick={confirmRegenerate}>
                    Regenerate Identity…
                </Button>
            </Flex>
        ),
    },
    // The RSA identity, accepted peer keys, and per-channel state live in
    // DataStore (./keys.ts) — never in settings, which may be cloud-synced.
});
