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

import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, useRef, useState } from "@webpack/common";

import { channelKeys, getChannelLabel, KeyedStore, userKeys } from "./keys";
import { cl } from "./utils";

interface KeyModalProps {
    rootProps: RenderModalProps;
    store: KeyedStore<string>;
    id: string;
    title: string;
    heading: string;
    description: React.ReactNode;
}

function KeyModal({ rootProps, store, id, title, heading, description }: KeyModalProps) {
    const existingKey = store.get(id) ?? "";
    // Uncontrolled defaultValue prevents React from setting the DOM `value` attribute — partial mitigation against other plugins reading via querySelector; full mitigation needs an isolated iframe.
    const inputRef = useRef<HTMLInputElement>(null);
    const [visible, setVisible] = useState(false);
    const [hasContent, setHasContent] = useState(existingKey.trim().length > 0);

    const save = async () => {
        const trimmed = (inputRef.current?.value ?? "").trim();
        if (!trimmed) return;
        await store.set(id, trimmed);
        rootProps.onClose();
    };

    const clear = async () => {
        await store.remove(id);
        rootProps.onClose();
    };

    return (
        <Modal {...rootProps} title={title}>
            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>{heading}</Heading>
                <Paragraph className={Margins.bottom8}>
                    {description} Both sides must enter the exact same key. Stored locally on this device only.
                </Paragraph>
                <div className={cl("secret-row")}>
                    <input
                        ref={inputRef}
                        type={visible ? "text" : "password"}
                        className={cl("secret-input")}
                        defaultValue={existingKey}
                        onInput={e => setHasContent(e.currentTarget.value.trim().length > 0)}
                        onKeyDown={e => { if (e.key === "Enter") save(); }}
                        placeholder="Enter shared secret…"
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                    />
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

            <div className={cl("user-key-actions")}>
                <button
                    className={cl("user-key-btn", "user-key-save")}
                    onClick={save}
                    disabled={!hasContent}
                    type="button"
                >
                    Save
                </button>
                {existingKey && (
                    <button
                        className={cl("user-key-btn", "user-key-clear")}
                        onClick={clear}
                        type="button"
                    >
                        Remove Key
                    </button>
                )}
                <button
                    className={cl("user-key-btn", "user-key-cancel")}
                    onClick={rootProps.onClose}
                    type="button"
                >
                    Cancel
                </button>
            </div>
        </Modal>
    );
}

export function openUserKeyModal(userId: string, username: string) {
    openModal(props => (
        <KeyModal
            rootProps={props}
            store={userKeys}
            id={userId}
            title={`AES Key — @${username}`}
            heading="Per-User AES-256-GCM Secret Key"
            description={<>Used when sending to or auto-decrypting messages from <strong>@{username}</strong>, unless the channel has its own key.</>}
        />
    ));
}

export function openChannelKeyModal(channelId: string) {
    const label = getChannelLabel(channelId);
    openModal(props => (
        <KeyModal
            rootProps={props}
            store={channelKeys}
            id={channelId}
            title={`AES Key — ${label}`}
            heading="Per-Channel AES-256-GCM Secret Key"
            description={<>Used for every message sent or auto-decrypted in <strong>{label}</strong>. Overrides per-user keys and the shared secret.</>}
        />
    ));
}
