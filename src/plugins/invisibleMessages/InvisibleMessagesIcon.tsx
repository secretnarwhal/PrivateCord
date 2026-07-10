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

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { ContextMenuApi, DraftStore, DraftType, Menu, React, ReactDOM, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";

import { openComposeModal, openSetPasswordModal } from "./modals";
import { getSecretDraft, setSecretDraft, toggleRevealMode, useRevealMode, useSecretDraft } from "./revealState";
import { encrypt } from "./stegcloak";
import { cl, getRevealPassword, logger } from "./utils";

/** Eye icon, mirroring the Android plugin's avd_show_password "hidden message" indicator. */
export const InvisibleMessagesIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        viewBox="0 0 24 24"
        height={height}
        width={width}
        fill="currentColor"
        className={classes(cl("icon"), className)}
    >
        <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5Zm0 12a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-7.2a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z" />
    </svg>
);

/**
 * A thin "elbow pipe" / reply-connector (└) that reads better than the eye on the
 * grey second-chatbar and next to a revealed secret — it visually ties the hidden
 * text to the message it's woven into, like Discord's own reply spine.
 */
export const ElbowIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        viewBox="0 0 24 24"
        height={height}
        width={width}
        fill="none"
        className={classes(cl("icon"), className)}
    >
        <path
            d="M8 5v7a4 4 0 0 0 4 4h6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

/**
 * A full-width secret input that floats just above the real chat bar while reveal
 * mode is on. Whatever you type here is hidden (with the permanent password)
 * inside your next normal message — the visible message acts as the cover text.
 *
 * It's rendered via a portal into <body> and positioned over the chat form so it
 * tracks the form's width/height without needing a fragile webpack patch. Because
 * the bar floats over everything, we also pad the message scroller by the bar's
 * height so it never clips the last messages above the chat input.
 */
function SecondaryChatBar({ channelId }: { channelId: string; }) {
    const draft = useSecretDraft(channelId);
    const anchorRef = useRef<HTMLSpanElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    // Discord's "X is typing…" indicator, lifted above the floating bar so the bar
    // never covers it. Tracked so we can undo the shift when it's replaced or the
    // bar goes away.
    const typingRef = useRef<HTMLElement | null>(null);
    const [pos, setPos] = useState<{ left: number; width: number; bottom: number; } | null>(null);
    const lastPos = useRef<typeof pos>(null);

    useEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;

        // Anchor the bar's *vertical* position to the chat input <form> — a stable,
        // semantic element. Pinning to the form's top edge guarantees the bar always
        // clears the entire chat input (the buttons, the rounded box, and any
        // reply/upload preview) and can never land on top of the real chatbox, no
        // matter how Discord renames its inner class names. Measuring an inner
        // element (channelTextArea) instead is what let the bar overlap the box.
        const form = anchor.closest("form") as HTMLElement | null;
        if (!form) return;

        // The rounded input box is used only to align the bar's left edge and width
        // (the form is wider — it includes outer padding — which made the bar overhang
        // left/right). If Discord renames it we fall back to the form's own metrics.
        const innerBox = form.querySelector('[class*="channelTextArea"]') as HTMLElement | null;

        // The scrollable message list, so we can reserve room for the floating bar.
        const scrollerHost = form.closest('[class*="chatContent"]') ?? form.parentElement;
        const scroller = scrollerHost?.querySelector('[class*="scroller"]') as HTMLElement | null;

        // If the user is pinned to the newest messages, keep them pinned once we
        // reserve space for the bar — otherwise the bar pops up over the last message
        // and they'd have to scroll down by hand to see it.
        const wasAtBottom = scroller
            ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8
            : false;
        let repin = wasAtBottom;

        const update = () => {
            const barHeight = barRef.current?.offsetHeight ?? 40;

            // Push the messages up by however tall the bar currently is (+ gap) so
            // the floating bar never covers the bottom-most messages.
            if (scroller) {
                scroller.style.paddingBottom = `${barHeight + 16}px`;
                if (repin) {
                    scroller.scrollTop = scroller.scrollHeight;
                    // Stop force-pinning once we've re-pinned with the real bar height.
                    if (barRef.current) repin = false;
                }
            }

            // The typing indicator sits at the top edge of the chat form — exactly
            // where the bar floats — so lift it up above the bar instead of letting
            // the bar hide it. It gets recreated as people start/stop typing, so
            // re-find it each tick and reset the previous node when it changes.
            const typing = scrollerHost?.querySelector('[class*="typing"]') as HTMLElement | null;
            if (typing !== typingRef.current) {
                if (typingRef.current) typingRef.current.style.transform = "";
                typingRef.current = typing;
            }
            if (typing) typing.style.transform = `translateY(-${barHeight + 16}px)`;

            const formRect = form.getBoundingClientRect();
            const hRect = (innerBox ?? form).getBoundingClientRect();
            const next = {
                left: Math.round(hRect.left),
                width: Math.round(hRect.width),
                // Pin the bar's bottom edge to the *top* of the whole chat form so it
                // always floats clearly above the input and never overlaps the chatbox.
                bottom: Math.round(window.innerHeight - formRect.top),
            };
            const prev = lastPos.current;
            if (prev && prev.left === next.left && prev.width === next.width && prev.bottom === next.bottom) return;
            lastPos.current = next;
            setPos(next);
        };

        update();
        const observer = new ResizeObserver(update);
        observer.observe(form);
        if (innerBox) observer.observe(innerBox);
        window.addEventListener("resize", update);
        // Layout shifts (opening a reply bar, member list, etc.) don't always fire
        // the above; a slow poll keeps the bar glued to the chat form cheaply.
        const interval = window.setInterval(update, 400);

        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
            window.clearInterval(interval);
            if (scroller) scroller.style.paddingBottom = "";
            if (typingRef.current) {
                typingRef.current.style.transform = "";
                typingRef.current = null;
            }
        };
    }, [channelId]);

    // Pressing Enter in the secret bar sends just like the main chat bar: whatever
    // is currently typed in the real chat box is the visible cover, and the secret
    // is woven into it (same path the compose modal uses, so the pre-send listener
    // doesn't run again and double-encrypt).
    const submitSecret = async () => {
        const form = (anchorRef.current?.closest("form")
            ?? anchorRef.current?.closest('[class*="channelTextArea"]')) as HTMLElement | null;
        const editable = form?.querySelector<HTMLElement>('[role="textbox"]') ?? null;

        const secret = getSecretDraft(channelId).trim();
        if (!secret) return;

        // Use Discord's serialized draft for the cover — mentions (<@id>), custom
        // emoji (<:name:id>), and GIF/links are kept as real markup so they still
        // ping / render / embed once sent. The visible text (which flattens all that
        // to "@name"/":name:") is only a fallback if the draft hasn't saved yet.
        const markup = (DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? "").trim();
        const cover = markup || (editable?.textContent ?? "").trim();
        if (cover.split(" ").filter(Boolean).length < 2) {
            showToast("Type a normal message (2+ words) in the chat box below — it becomes the visible cover your secret hides inside", Toasts.Type.FAILURE);
            // Drop the cursor into the real chatbox so they can write that cover
            // immediately, instead of feeling stuck typing into a bar that won't send.
            editable?.focus();
            return;
        }

        try {
            const encoded = await encrypt(getRevealPassword(channelId), secret, cover);
            await sendMessage(channelId, { content: encoded });
            setSecretDraft(channelId, "");
            // Clear the cover out of the real chat box, exactly like a normal send.
            if (editable) {
                editable.focus();
                document.execCommand("selectAll", false);
                document.execCommand("delete", false);
            }
        } catch (e) {
            logger.error("Failed to hide secret from the reveal-mode chatbar", e);
            showToast("Failed to hide the secret message", Toasts.Type.FAILURE);
        }
    };

    const bar = pos && ReactDOM.createPortal(
        <div
            ref={barRef}
            className={cl("secondbar")}
            style={{ left: pos.left, width: pos.width, bottom: pos.bottom + 8 }}
        >
            <InvisibleMessagesIcon width={18} height={18} className={cl("secondbar-icon")} />
            <span className={cl("secondbar-label")}>Secret</span>
            <input
                type="text"
                className={cl("secondbar-input")}
                placeholder="Hidden secret — then send a normal message below as its cover"
                value={draft}
                onChange={e => setSecretDraft(channelId, e.currentTarget.value)}
                onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void submitSecret();
                    }
                }}
                spellCheck={false}
                autoComplete="off"
            />
        </div>,
        document.body
    );

    return <span ref={anchorRef} className={cl("secondbar-anchor")}>{bar}</span>;
}

export const InvisibleMessagesChatBarIcon: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    const revealMode = useRevealMode();
    if (!isMainChat) return null;

    const channelId = channel?.id;

    const openMenu = (event: React.MouseEvent) => {
        ContextMenuApi.openContextMenu(event, () => (
            <Menu.Menu
                navId="vc-invismsg-menu"
                onClose={ContextMenuApi.closeContextMenu}
                aria-label="Invisible Messages"
            >
                <Menu.MenuItem
                    id="vc-invismsg-set-password"
                    label="Set Password…"
                    action={() => openSetPasswordModal()}
                />
                <Menu.MenuItem
                    id="vc-invismsg-compose"
                    label="Compose Message…"
                    action={() => openComposeModal(channelId)}
                />
                <Menu.MenuSeparator />
                <Menu.MenuCheckboxItem
                    id="vc-invismsg-reveal-mode"
                    label="Reveal Mode"
                    checked={revealMode}
                    action={toggleRevealMode}
                />
            </Menu.Menu>
        ));
    };

    return (
        <>
            {revealMode && channelId && <SecondaryChatBar channelId={channelId} />}
            <ChatBarButton
                tooltip={revealMode ? "Reveal Mode is ON — right-click to turn off" : "Send Invisible Message"}
                onClick={openMenu}
                onContextMenu={e => { e.preventDefault(); toggleRevealMode(); }}
                buttonProps={{ "aria-pressed": revealMode }}
            >
                <InvisibleMessagesIcon className={classes(cl("chat-button"), revealMode && cl("chat-button-active"))} />
            </ChatBarButton>
        </>
    );
};
