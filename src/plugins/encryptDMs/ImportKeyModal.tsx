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

import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Forms, Modal, openModal, showToast, Toasts, useRef } from "@webpack/common";

import { importPublicKeyB64, KEY_PREFIX } from "./crypto";
import { setUserKey } from "./keys";
import { cl } from "./utils";

function ImportKeyModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const userIdRef = useRef<HTMLInputElement>(null);
    const keyRef = useRef<HTMLTextAreaElement>(null);

    const save = async () => {
        const userId = (userIdRef.current?.value ?? "").trim();
        let key = (keyRef.current?.value ?? "").trim();
        if (key.startsWith(KEY_PREFIX)) key = key.slice(KEY_PREFIX.length).trim();

        if (!/^\d{15,21}$/.test(userId)) {
            showToast("Enter a valid Discord user ID (a number)", Toasts.Type.FAILURE);
            return;
        }

        try {
            await importPublicKeyB64(key);
        } catch {
            showToast("Invalid encryption key", Toasts.Type.FAILURE);
            return;
        }

        await setUserKey(userId, key);
        showToast("Encryption key imported", Toasts.Type.SUCCESS);
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Import EncryptDMs Public Key"
            actions={[
                { text: "Import", variant: "primary", onClick: () => void save() },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
            ]}
        >
            <section className={Margins.bottom16}>
                <Forms.FormTitle tag="h3">User ID</Forms.FormTitle>
                <Forms.FormText className={Margins.bottom8}>
                    The Discord user ID this public key belongs to.
                </Forms.FormText>
                <input
                    ref={userIdRef}
                    type="text"
                    className={cl("input")}
                    placeholder="e.g. 343383572805058560"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                />
            </section>

            <section className={Margins.bottom16}>
                <Forms.FormTitle tag="h3">Public Key</Forms.FormTitle>
                <Forms.FormText className={Margins.bottom8}>
                    Paste their key — either the raw base64 or a full <code>{KEY_PREFIX}</code> message.
                </Forms.FormText>
                <textarea
                    ref={keyRef}
                    className={cl("input", "key-input")}
                    placeholder={`${KEY_PREFIX}MIIBIjANBgkq…`}
                    autoComplete="off"
                    spellCheck={false}
                    rows={4}
                />
            </section>
        </Modal>
    );
}

export function openImportKeyModal() {
    openModal(props => <ImportKeyModal modalProps={props} />);
}
