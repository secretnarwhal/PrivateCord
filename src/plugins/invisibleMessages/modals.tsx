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
import { sendMessage } from "@utils/discord";
import { Margins } from "@utils/margins";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, SelectedChannelStore, showToast, useRef } from "@webpack/common";

import { setForcedReveal } from "./revealState";
import { decrypt, encrypt } from "./stegcloak";
import { getLastUsedPassword, getPermanentPassword, setLastUsedPassword, setPermanentPassword } from "./store";
import { cl, getPassword, getRevealPassword, logger } from "./utils";

// ─── Compose an invisible message ─────────────────────────────────────────────

function ComposeModal({ modalProps, channelId }: { modalProps: RenderModalProps; channelId?: string; }) {
    const coverRef = useRef<HTMLInputElement>(null);
    const hiddenRef = useRef<HTMLTextAreaElement>(null);
    const passwordRef = useRef<HTMLInputElement>(null);

    const send = async () => {
        const targetChannelId = channelId || SelectedChannelStore.getChannelId();
        if (!targetChannelId) {
            showToast({ text: "Open a chat first", variant: "critical" });
            return;
        }

        const cover = (coverRef.current?.value ?? "").trim();
        const hidden = hiddenRef.current?.value ?? "";
        const passwordInput = (passwordRef.current?.value ?? "").trim();

        if (cover.split(" ").length < 2) {
            showToast({ text: "The visible message must contain at least 2 words", variant: "critical" });
            return;
        }
        if (!hidden) {
            showToast({ text: "Enter a hidden message", variant: "critical" });
            return;
        }

        const password = passwordInput || getPassword(targetChannelId);
        try {
            const encoded = await encrypt(password, hidden, cover);
            await sendMessage(targetChannelId, { content: encoded });
            modalProps.onClose();
        } catch (e) {
            logger.error("Failed to compose invisible message", e);
            showToast({ text: "Failed to create invisible message", variant: "critical" });
        }
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Compose Invisible Message"
            actions={[
                { text: "Send", variant: "primary", onClick: () => void send() },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
            ]}
        >
            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>Visible message</Heading>
                <Paragraph className={Margins.bottom8}>
                    What everyone sees. Must contain at least two words — the secret is woven into it.
                </Paragraph>
                <input
                    ref={coverRef}
                    type="text"
                    className={cl("input")}
                    placeholder="This is a normal message"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                />
            </section>

            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>Hidden message</Heading>
                <Paragraph className={Margins.bottom8}>
                    The secret. Only people with the password can reveal it.
                </Paragraph>
                <textarea
                    ref={hiddenRef}
                    className={cl("input", "hidden-input")}
                    placeholder="The secret message"
                    autoComplete="off"
                    spellCheck={false}
                    rows={3}
                />
            </section>

            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>Password (optional)</Heading>
                <Paragraph className={Margins.bottom8}>
                    Leave empty to use this channel's password (or the default password).
                </Paragraph>
                <input
                    ref={passwordRef}
                    type="text"
                    className={cl("input")}
                    placeholder="Channel / default password"
                    autoComplete="off"
                    spellCheck={false}
                />
            </section>
        </Modal>
    );
}

export function openComposeModal(channelId?: string) {
    openModal(props => <ComposeModal modalProps={props} channelId={channelId} />);
}

// ─── Set the permanent reveal-mode password ───────────────────────────────────

function SetPasswordModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const inputRef = useRef<HTMLInputElement>(null);

    const save = async () => {
        const value = (inputRef.current?.value ?? "").trim();
        await setPermanentPassword(value);
        showToast({
            text: value ? "Password saved" : "Password cleared — using channel / default password",
            variant: "success"
        });
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Invisible Messages Password"
            actions={[
                { text: "Save", variant: "primary", onClick: () => void save() },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
            ]}
        >
            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>Permanent password</Heading>
                <Paragraph className={Margins.bottom8}>
                    Reveal Mode auto-decrypts messages with this password, and secrets typed in
                    the reveal-mode chatbar are encrypted with it. Leave empty to fall back to the
                    channel or default password. Tip: right-click the chat-bar button to toggle Reveal Mode.
                </Paragraph>
                <input
                    ref={inputRef}
                    type="text"
                    className={cl("input")}
                    defaultValue={getPermanentPassword()}
                    placeholder="Channel / default password"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    onKeyDown={e => { if (e.key === "Enter") void save(); }}
                />
            </section>
        </Modal>
    );
}

export function openSetPasswordModal() {
    openModal(props => <SetPasswordModal modalProps={props} />);
}

// ─── Prompt for a password to reveal a hidden message ─────────────────────────

function RevealPasswordModal({ modalProps, defaultPassword, onResult }: {
    modalProps: RenderModalProps;
    defaultPassword: string;
    onResult: (value: string | null) => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);

    const submit = () => {
        const value = (inputRef.current?.value ?? "").trim();
        onResult(value || defaultPassword);
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Reveal Invisible Message"
            actions={[
                { text: "Reveal", variant: "primary", onClick: submit },
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
            ]}
        >
            <section className={Margins.bottom16}>
                <Heading className={Margins.bottom8}>Password</Heading>
                <Paragraph className={Margins.bottom8}>
                    Enter the password to decrypt this message. Leave it as-is to use the last-used or channel password.
                </Paragraph>
                <input
                    ref={inputRef}
                    type="text"
                    className={cl("input")}
                    defaultValue={defaultPassword}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    onKeyDown={e => { if (e.key === "Enter") submit(); }}
                />
            </section>
        </Modal>
    );
}

/**
 * Opens the reveal-password modal. Resolves with the entered password (or the
 * default password if the field is left empty), or null if the modal is
 * dismissed without confirming.
 */
export function openRevealPasswordModal(defaultPassword: string): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        openModal(
            props => (
                <RevealPasswordModal
                    modalProps={props}
                    defaultPassword={defaultPassword}
                    onResult={settle}
                />
            ),
            { onCloseCallback: () => settle(null) }
        );
    });
}

/**
 * Full reveal flow used by the message context menu: prompt for a password
 * (defaulting to the last-used or channel/default password), decrypt, and show
 * the result inline right next to the message (not via a Clyde bot message). On
 * success, remember the password.
 */
export async function revealInvisibleMessage(message: Message) {
    const channelId = message.channel_id;
    const defaultPassword = getLastUsedPassword() ?? getRevealPassword(channelId);

    const password = await openRevealPasswordModal(defaultPassword);
    if (password == null) return;

    try {
        const text = await decrypt(message.content, password);
        await setLastUsedPassword(password);
        setForcedReveal(message.id, text);
    } catch (e) {
        logger.error("Failed to decrypt invisible message", e);
        showToast({ text: "Could not decrypt — wrong password?", variant: "critical" });
    }
}
