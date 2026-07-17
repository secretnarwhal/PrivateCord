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
import { OptionType } from "@utils/types";

import { openEncryptDMsModal } from "./EncryptDMsModal";

export const settings = definePluginSettings({
    autoDecodeReceived: {
        type: OptionType.BOOLEAN,
        description: "Automatically decrypt encrypted incoming messages using your shared secret or per-user keys",
        default: false,
    },
    autoEncodeOutgoing: {
        type: OptionType.BOOLEAN,
        description: "Automatically encrypt your messages before sending. Shift+click or right-click the chat bar button to toggle",
        default: false,
    },
    encryptAttachments: {
        type: OptionType.BOOLEAN,
        description: "Also encrypt file attachments when a message is encrypted. Recipients with this plugin and the matching key see them decrypted in-line; everyone else sees an opaque .vcenc file.",
        default: true,
    },
    aesSecret: {
        type: OptionType.STRING,
        description: "Shared AES-256-GCM secret key — both users must use the same value. Stored in your Vencord settings (synced to cloud if you have settings sync enabled).",
        default: "",
        hidden: true,
    },
    linkPreviews: {
        type: OptionType.BOOLEAN,
        description: "Show a click-to-load preview button for links in decrypted messages (desktop only). Nothing is fetched until you click — and clicking reveals your IP to that link's server, which is why it isn't automatic.",
        default: true,
    },
    manageSettings: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button onClick={openEncryptDMsModal}>
                Manage encryption settings
            </Button>
        ),
    },
    // userKeys is stored in DataStore (./userKeys.ts) — settings sync uploads to a cloud backend.
});
