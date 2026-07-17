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

import { BaseText } from "@components/BaseText";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Margins } from "@utils/margins";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import { Forms, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { settings } from "./settings";
import { openUserKeyModal } from "./UserKeyModal";
import { removeUserKey, useUserKeys } from "./userKeys";
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
            <Forms.FormTitle tag="h3">Shared AES-256-GCM Secret Key</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                Both users must enter the <strong>exact same key</strong> to encrypt and decrypt each other's messages.
                Encryption and decryption happen locally on your device.
                Stored in plain text in your Vencord settings — if you have settings sync enabled, this key will be included in that sync.
            </Forms.FormText>
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
            description="Automatically encrypt your messages before sending using your shared secret"
            value={value}
            onChange={v => (settings.store.autoEncodeOutgoing = v)}
            hideBorder
        />
    );
}

function UserKeysSection() {
    const userKeys = useUserKeys();
    const entries = Object.entries(userKeys);

    if (entries.length === 0) return null;

    return (
        <>
            <Divider className={Margins.bottom16} />
            <section className={Margins.bottom16}>
                <Forms.FormTitle tag="h3">Per-User AES Keys</Forms.FormTitle>
                <Forms.FormText className={Margins.bottom8}>
                    These keys override the global secret for specific users. Right-click a user to add or update a key.
                </Forms.FormText>
                {entries.map(([userId]) => {
                    const username = UserStore.getUser(userId)?.username ?? userId;
                    return (
                        <div key={userId} className={cl("user-key-row")}>
                            <span className={cl("user-key-name")}>@{username}</span>
                            <button
                                className={cl("user-key-btn", "user-key-edit")}
                                onClick={() => openUserKeyModal(userId, username)}
                                type="button"
                            >
                                Edit
                            </button>
                            <button
                                className={cl("user-key-btn", "user-key-clear")}
                                onClick={() => removeUserKey(userId)}
                                type="button"
                            >
                                Remove
                            </button>
                        </div>
                    );
                })}
            </section>
        </>
    );
}

function EncryptDMsModal({ rootProps }: { rootProps: ModalProps; }) {
    return (
        <ModalRoot {...rootProps}>
            <ModalHeader className={cl("modal-header")}>
                <BaseText tag="h2" size="lg" weight="semibold" className={cl("modal-title")}>
                    EncryptDMs
                </BaseText>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("modal-content")}>
                <AesSecretInput />

                <Divider className={Margins.bottom16} />

                <AutoDecodeToggle />
                <AutoEncodeToggle />

                <UserKeysSection />
            </ModalContent>
        </ModalRoot>
    );
}

export function openEncryptDMsModal() {
    openModal(props => <EncryptDMsModal rootProps={props} />);
}
