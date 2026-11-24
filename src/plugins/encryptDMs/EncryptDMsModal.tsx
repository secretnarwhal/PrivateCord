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

import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { openChannelKeyModal, openUserKeyModal } from "./KeyModal";
import { channelKeys, disabledChannels, getChannelLabel, userKeys } from "./keys";
import { settings } from "./settings";
import { cl } from "./utils";

function AesSecretInput() {
    const { aesSecret } = settings.use(["aesSecret"]);
    const [visible, setVisible] = useState(false);
    // Uncontrolled defaultValue prevents React from setting the DOM `value` attribute — partial mitigation against other plugins reading via querySelector; full mitigation needs an isolated iframe.
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current && inputRef.current.value !== aesSecret) {
            inputRef.current.value = aesSecret;
        }
    }, [aesSecret]);

    return (
        <section className={Margins.bottom16}>
            <Heading className={Margins.bottom8}>Shared AES-256-GCM Secret Key</Heading>
            <Paragraph className={Margins.bottom8}>
                Both users must enter the <strong>exact same key</strong> to encrypt and decrypt each other's messages.
                Encryption and decryption happen locally on your device.
                Stored in plain text in your Vencord settings — if you have settings sync enabled, this key will be included in that sync.
            </Paragraph>
            <div className={cl("secret-row")}>
                <input
                    ref={inputRef}
                    type={visible ? "text" : "password"}
                    className={cl("secret-input")}
                    defaultValue={aesSecret}
                    placeholder="Enter shared secret…"
                    autoComplete="off"
                    spellCheck={false}
                />
                <button
                    className={cl("secret-toggle")}
                    onClick={() => { if (inputRef.current) settings.store.aesSecret = inputRef.current.value; }}
                    type="button"
                >
                    Save
                </button>
                <button
                    className={cl("secret-toggle")}
                    onClick={() => setVisible(v => !v)}
                    type="button"
                    aria-label={visible ? "Hide secret" : "Show secret"}
                >
                    {visible ? "Hide" : "Show"}
                </button>
            </div>
        </section>
    );
}

function AutoDecodeToggle() {
    const value = settings.use(["autoDecodeReceived"]).autoDecodeReceived;
    return (
        <FormSwitch
            title="Auto-Decrypt Received Messages"
            description="Automatically decrypt incoming messages using your shared secret or per-user keys"
            value={value}
            onChange={v => (settings.store.autoDecodeReceived = v)}
            hideBorder
        />
    );
}

function AutoEncodeToggle() {
    const value = settings.use(["autoEncodeOutgoing"]).autoEncodeOutgoing;
    return (
        <FormSwitch
            title="Auto-Encrypt Outgoing Messages"
            description="Encrypt your messages with the shared secret in channels that don't have their own key. Channels and DMs with their own key are toggled individually from their right-click menu."
            value={value}
            onChange={v => (settings.store.autoEncodeOutgoing = v)}
            hideBorder
        />
    );
}

interface KeyListProps {
    heading: string;
    description: string;
    entries: { id: string; label: string; }[];
    onEdit(id: string, label: string): void;
    onRemove(id: string): void;
}

function KeyList({ heading, description, entries, onEdit, onRemove }: KeyListProps) {
    if (entries.length === 0) return null;

    return (
        <>
            <Divider className={Margins.bottom16} />
            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>{heading}</Heading>
                <Paragraph className={Margins.bottom8}>{description}</Paragraph>
                {entries.map(({ id, label }) => (
                    <div key={id} className={cl("user-key-row")}>
                        <span className={cl("user-key-name")}>{label}</span>
                        <button
                            className={cl("user-key-btn", "user-key-edit")}
                            onClick={() => onEdit(id, label)}
                            type="button"
                        >
                            Edit
                        </button>
                        <button
                            className={cl("user-key-btn", "user-key-clear")}
                            onClick={() => onRemove(id)}
                            type="button"
                        >
                            Remove
                        </button>
                    </div>
                ))}
            </section>
        </>
    );
}

function ChannelKeysSection() {
    const keys = channelKeys.use();
    disabledChannels.use();

    return (
        <KeyList
            heading="Per-Channel AES Keys"
            description="These keys override per-user keys and the global secret in specific channels and group DMs. Right-click a channel or group DM to add a key or toggle encryption."
            entries={Object.keys(keys).map(id => ({
                id,
                label: getChannelLabel(id) + (disabledChannels.get(id) ? " (off)" : ""),
            }))}
            onEdit={id => openChannelKeyModal(id)}
            onRemove={id => channelKeys.remove(id)}
        />
    );
}

function UserKeysSection() {
    const keys = userKeys.use();

    return (
        <KeyList
            heading="Per-User AES Keys"
            description="These keys override the global secret for specific users. Right-click a user to add or update a key, or to toggle encryption in your DM with them."
            entries={Object.keys(keys).map(id => ({ id, label: `@${UserStore.getUser(id)?.username ?? id}` }))}
            onEdit={(id, label) => openUserKeyModal(id, label.slice(1))}
            onRemove={id => userKeys.remove(id)}
        />
    );
}

function EncryptDMsModal({ rootProps }: { rootProps: RenderModalProps; }) {
    return (
        <Modal {...rootProps} title="EncryptDMs">
            <AesSecretInput />

            <Divider className={Margins.bottom16} />

            <AutoDecodeToggle />
            <AutoEncodeToggle />

            <ChannelKeysSection />
            <UserKeysSection />
        </Modal>
    );
}

export function openEncryptDMsModal() {
    openModal(props => <EncryptDMsModal rootProps={props} />);
}
