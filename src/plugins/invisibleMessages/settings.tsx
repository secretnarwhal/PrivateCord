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
import { OptionType } from "@utils/types";
import { ChannelStore, Forms } from "@webpack/common";

import {
    clearChannelPasswords,
    getAllChannelPasswords,
    removeChannelPassword,
    useInvisibleMessagesState,
} from "./store";

// NOTE: the default password is safe to keep in settings because it is not a
// secret in the usual sense (it defaults to the literal "Password" and is the
// shared fallback). Per-channel passwords and the last-used password are the
// real secrets and live in DataStore (./store.ts), never here — settings may be
// cloud-synced.

function channelLabel(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    const name = channel?.name;
    return name ? `#${name} (${channelId})` : channelId;
}

function ChannelPasswordManager() {
    useInvisibleMessagesState();

    const entries = Object.keys(getAllChannelPasswords());

    if (entries.length === 0) {
        return (
            <Forms.FormText>
                No channels have a custom password. Messages use the default password above.
            </Forms.FormText>
        );
    }

    return (
        <Flex flexDirection="column" gap="0.5em">
            {entries.map(channelId => (
                <Flex key={channelId} alignItems="center" gap="0.5em">
                    <Forms.FormText style={{ flex: 1 }}>{channelLabel(channelId)}</Forms.FormText>
                    <Button
                        size="small"
                        variant="dangerPrimary"
                        onClick={() => removeChannelPassword(channelId)}
                    >
                        Remove
                    </Button>
                </Flex>
            ))}
            <div>
                <Button
                    size="small"
                    variant="dangerPrimary"
                    onClick={() => clearChannelPasswords()}
                >
                    Clear all channel passwords
                </Button>
            </div>
        </Flex>
    );
}

export const settings = definePluginSettings({
    defaultPassword: {
        type: OptionType.STRING,
        description: "Default password used to encrypt/decrypt when a channel has no password set",
        default: "Password",
    },
    channelPasswords: {
        type: OptionType.COMPONENT,
        description: "Per-channel passwords",
        component: () => <ChannelPasswordManager />,
    },
});
