/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 secretnarwhal
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, User } from "@vencord/discord-types";
import { ChannelStore, Menu, PopoutActions, PopoutWindowStore, React } from "@webpack/common";

import managedStyle from "./style.css?managed";

const logger = new Logger("BetterChatView");

// The key doubles as the Electron window's frameName. Both Vesktop and Discord's
// own desktop client only open an *in-app* popout when the frameName starts with
// "DISCORD_" and the opened URL is the blank /popout shell. Any other frameName is
// treated as an external link and dumped into the system browser — that was the
// cause of every "it opens my browser" symptom.
const POPOUT_KEY_PREFIX = "DISCORD_VC_BCV_POPOUT_";

const COLLAPSED_CLASS = "vc-bcv-collapsed";
const KEEP_SERVERS_CLASS = "vc-bcv-keep-servers";

const settings = definePluginSettings({
    autoCollapsePopout: {
        type: OptionType.BOOLEAN,
        description: "Automatically collapse the sidebar in popped-out chat windows, so they only show the chat",
        default: true
    },
    hideServerList: {
        type: OptionType.BOOLEAN,
        description: "Also hide the server list when collapsing (off = only collapse the channel/DM list)",
        default: true
    },
    showHandle: {
        type: OptionType.BOOLEAN,
        description: "Show a handle on the left edge to collapse/expand the sidebar",
        default: true,
        restartNeeded: true
    }
});

function isPopoutWindow() {
    // window.open(url, key) sets the new window's name to the frameName, and that
    // survives the same-origin navigation to the channel — so a popout can tell
    // it's a popout without any cross-window messaging.
    return window.name?.startsWith(POPOUT_KEY_PREFIX) ?? false;
}

// Source of truth for the collapse state. We deliberately do NOT read it back off
// the DOM: Discord owns <html>'s className and reassigns it wholesale on many
// events (window focus/blur, theme / reduced-motion re-eval, resize), which
// transiently strips our class. The variable stays correct even when the DOM
// briefly isn't — see classGuard.
let collapsed = false;
let handle: HTMLButtonElement | null = null;
let classGuard: MutationObserver | null = null;

function syncClasses() {
    const { classList } = document.documentElement;
    classList.toggle(COLLAPSED_CLASS, collapsed);
    classList.toggle(KEEP_SERVERS_CLASS, collapsed && !settings.store.hideServerList);
    handle?.setAttribute("aria-pressed", String(collapsed));
}

function applyCollapse(next: boolean) {
    collapsed = next;
    syncClasses();
    if (collapsed) startClassGuard();
    else stopClassGuard();
}

function toggleCollapse() {
    applyCollapse(!collapsed);
    // Drop focus so a stray Space/Enter can't re-fire the synthetic click. See
    // preventHandleFocus below.
    handle?.blur();
}

// Discord reassigns <html>'s className wholesale on window focus/blur, theme
// re-eval, resize, etc. That drops our collapse class and pops the sidebar back
// open on almost any interaction (clicking into DevTools, typing, resizing...).
// Re-assert our classes the instant that happens so "collapsed" stays collapsed.
function startClassGuard() {
    if (classGuard) return;
    classGuard = new MutationObserver(() => {
        if (collapsed && !document.documentElement.classList.contains(COLLAPSED_CLASS)) syncClasses();
    });
    classGuard.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function stopClassGuard() {
    classGuard?.disconnect();
    classGuard = null;
}

// Prevent the button from grabbing focus on click: a focused <button> fires a
// synthetic click on Space/Enter, so without this the next time the user typed a
// space/enter in the message box it would re-trigger toggleCollapse. Stopping the
// default mousedown behaviour keeps focus on Discord's input while still letting
// the click event fire normally.
function preventHandleFocus(e: MouseEvent) {
    e.preventDefault();
}

function createHandle() {
    if (handle || !settings.store.showHandle) return;

    // start() can fire before <body> exists; retry on the next frame instead of
    // relying on DOMContentLoaded (which may have already passed).
    if (!document.body) {
        requestAnimationFrame(createHandle);
        return;
    }

    handle = document.createElement("button");
    handle.className = "vc-bcv-handle";
    handle.setAttribute("aria-label", "Toggle sidebar");
    handle.setAttribute("aria-pressed", String(collapsed));
    handle.addEventListener("mousedown", preventHandleFocus);
    handle.addEventListener("click", toggleCollapse);
    document.body.appendChild(handle);
}

function removeHandle() {
    handle?.removeEventListener("mousedown", preventHandleFocus);
    handle?.removeEventListener("click", toggleCollapse);
    handle?.remove();
    handle = null;
}

function openDMPopout(channelId: string) {
    const key = `${POPOUT_KEY_PREFIX}${channelId}`;

    // If already open, focus the existing window rather than opening a duplicate.
    if (PopoutWindowStore.getWindowOpen(key)) {
        PopoutWindowStore.getWindow(key)?.focus();
        return;
    }

    PopoutActions.open(key, () => null, { defaultWidth: 850, defaultHeight: 650 });

    // The popout opens on Discord's blank /popout shell, which has no router, so the
    // null render function leaves it empty. Navigate it to the DM instead: Vesktop does
    // not intercept navigation that happens *inside* an already-open popout, so this
    // loads a full Discord client pointed at the channel rather than escaping to the
    // browser. That fresh client runs its own Vencord instance, which auto-collapses on
    // start (see isPopoutWindow), leaving a chat-only window. Poll until Discord has
    // actually created the window, then navigate.
    const interval = setInterval(() => {
        const win = PopoutWindowStore.getWindow(key);
        if (!win) return;
        clearInterval(interval);
        win.location.replace(`${location.origin}/channels/@me/${channelId}`);
        if (settings.store.autoCollapsePopout) assertCollapsed(win);
    }, 50);
    setTimeout(() => clearInterval(interval), 10_000);
}

// Belt-and-suspenders: push the collapsed state straight into the popout's
// document. The popout's own Vencord instance also auto-collapses via
// isPopoutWindow(), but if window.name isn't carried across (varies by client),
// this still does it — the popout supplies the CSS through its managed style, we
// just keep re-asserting the class for a few seconds while the page settles.
function assertCollapsed(win: Window) {
    const deadline = Date.now() + 8000;
    const id = setInterval(() => {
        try {
            const root = win.document?.documentElement;
            if (root) {
                root.classList.add(COLLAPSED_CLASS);
                root.classList.toggle(KEEP_SERVERS_CLASS, !settings.store.hideServerList);
            }
        } catch {
            // Transient cross-origin/about:blank phase during navigation; retry.
        }
        if (win.closed || Date.now() > deadline) clearInterval(id);
    }, 200);
}

// Right-click on a DM user in the DM list sidebar
const userContextPatch: NavContextMenuPatchCallback = (children, props: { user?: User; }) => {
    // "close-dm" is only present in the DM list sidebar, not server member lists.
    const container = findGroupChildrenByChildId("close-dm", children);
    if (!container) return;

    const { user } = props;
    if (!user) return;

    const channelId = ChannelStore.getDMFromUserId(user.id);
    if (!channelId) return;

    const idx = container.findIndex(c => c?.props?.id === "close-dm");
    container.splice(idx, 0,
        <Menu.MenuItem
            id="vc-popout-dm"
            label="Pop Out Chat"
            action={() => openDMPopout(channelId)}
        />
    );
};

// Right-click on a group DM in the DM list
const gdmContextPatch: NavContextMenuPatchCallback = (children, props: { channel?: Channel; }) => {
    const container = findGroupChildrenByChildId("leave-channel", children);
    if (!container) return;

    const { channel } = props;
    if (!channel) return;

    container.unshift(
        <Menu.MenuItem
            id="vc-popout-gdm"
            label="Pop Out Chat"
            action={() => openDMPopout(channel.id)}
        />
    );
};

export default definePlugin({
    name: "BetterChatView",
    description: "Collapse the server/channel sidebar for a chat-only view, and pop DMs out into their own chat-only window.",
    authors: [],
    tags: ["Utility"],
    settings,
    managedStyle,
    contextMenus: {
        "user-context": userContextPatch,
        "gdm-context": gdmContextPatch,
    },

    start() {
        const popout = settings.store.autoCollapsePopout && isPopoutWindow();
        if (popout) applyCollapse(true);
        createHandle();
        logger.info(`started (popout window: ${popout}, handle: ${!!handle}, showHandle: ${settings.store.showHandle})`);
    },

    stop() {
        removeHandle();
        applyCollapse(false);
    }
});
