/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonMap, ChatBarProps } from "@api/ChatButtons";
import { useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { React, ReactDOM, useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from "react";

import { CaretIcon } from "./icons";
import { mergeOrder, place } from "./ordering";
import { settings } from "./settings";
import { cl, clamp, logger } from "./utils";

/** The key ChatButtons.tsx gives the element holding *all* plugin buttons. */
const VENCORD_BUTTONS_KEY = "vencord-chat-buttons";

/** Sentinel drop target: the caret itself, which means "put this in the tray" like Windows does. */
const CARET_TARGET = "\0caret";

/** How each button announces its id to the drop-target hit test. */
const ITEM_ATTR = "data-vc-cbt-id";

/**
 * How far the pointer has to travel before a press counts as a drag rather than a click.
 *
 * This is the whole reason the plugin doesn't use HTML5 drag & drop: `draggable` elements hand
 * the gesture to the browser after ~3px of movement and then *no click event is ever fired*, so
 * every slightly-imprecise click on a button would silently do nothing.
 */
const DRAG_THRESHOLD = 5;

/**
 * How far above and below the row still counts as "put this back on the bar".
 *
 * The row is only as wide as whatever is still in it, so once buttons are hidden it stops being
 * something you can reasonably aim at — see `barZone`.
 */
const BAR_ZONE_PAD = 16;

/** Slack around the panel and the caret, so grazing their edge still counts as hitting them. */
const EDGE_SLACK = 4;

type Zone = "bar" | "tray";

interface Entry {
    id: string;
    node: ReactNode;
}

interface DropHint {
    zone: Zone;
    overId?: string;
    side?: "before" | "after";
}

interface DropTarget {
    zone: Zone;
    /** The button this one should end up directly after; undefined means "first in the zone". */
    afterId?: string;
    hint: DropHint | null;
    /** The pointer is over the button's own slot, so dropping here would change nothing. */
    keep?: boolean;
}

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface Gesture {
    id: string;
    el: HTMLElement;
    doc: Document;
    pointerId: number;
    startX: number;
    startY: number;
    /** Where inside the button the pointer grabbed it, so the preview doesn't jump on pickup. */
    grabX: number;
    grabY: number;
    /** False until the pointer has moved past DRAG_THRESHOLD — until then this is still a click. */
    active: boolean;
    preview: HTMLElement | null;
    detach(): void;
}

type ChatBarButtonSettings = Record<string, { enabled?: boolean; } | undefined>;

/**
 * Vencord renders every plugin's button inside a single element, which would make all of them
 * one indivisible blob here. Rebuild that element's contents ourselves so each plugin button can
 * be moved on its own — this is also what makes the plugin work with plugins that don't exist yet,
 * since it reads the live registry rather than a hardcoded list.
 */
function expandVencordButtons(el: ReactElement, chatBarButtons: ChatBarButtonSettings): Entry[] | null {
    try {
        const chatProps = el.props as ChatBarProps;
        const analyticsName = chatProps?.type?.analyticsName;
        if (analyticsName == null) return null;

        const isMainChat = analyticsName === "normal";
        const isAnyChat = isMainChat || analyticsName === "sidebar";

        return Array.from(ChatBarButtonMap)
            .filter(([key]) => chatBarButtons[key]?.enabled !== false)
            .map(([key, { render: Button }]) => ({
                id: `vc:${key}`,
                node: (
                    <ErrorBoundary noop key={key} onError={e => logger.error(`Failed to render ${key}`, e.error)}>
                        <Button {...chatProps} isMainChat={isMainChat} isAnyChat={isAnyChat} />
                    </ErrorBoundary>
                )
            }));
    } catch (e) {
        // Better to leave the plugin buttons grouped than to lose them entirely
        logger.error("Could not split Vencord's chat bar buttons, leaving them as one item", e);
        return null;
    }
}

/**
 * Turns whatever Discord (and any other mod patching this row) put in the children array into
 * a list of individually addressable buttons. Discord keys its own buttons "gift", "gif",
 * "sticker", "emoji", "expression", "appLauncher" and "submit", which is what makes the saved
 * layout stable across restarts.
 */
function collect(children: ReactNode[], chatBarButtons: ChatBarButtonSettings): Entry[] {
    const entries: Entry[] = [];
    const seen = new Map<string, number>();

    const add = (rawId: string, node: ReactNode) => {
        const n = seen.get(rawId) ?? 0;
        seen.set(rawId, n + 1);
        entries.push({ id: n === 0 ? rawId : `${rawId}~${n}`, node });
    };

    children.forEach((child, i) => {
        if (child == null || typeof child === "boolean") return;

        if (!React.isValidElement(child)) {
            add(`el:?${i}`, child);
            return;
        }

        if (child.key === VENCORD_BUTTONS_KEY) {
            const expanded = expandVencordButtons(child, chatBarButtons);
            if (expanded) {
                expanded.forEach(e => add(e.id, e.node));
                return;
            }
        }

        if (child.key != null) {
            add(`el:${child.key}`, child);
            return;
        }

        // Unkeyed elements only turn up if another mod injects one; fall back to whatever
        // identity we can scrape off the component so it at least survives a reload.
        const type = child.type as any;
        const name = typeof type === "string" ? type : type?.displayName || type?.name;
        add(`el:?${name ?? "anonymous"}`, child);
    });

    return entries;
}

const within = (box: Box, x: number, y: number, pad = 0) =>
    x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad;

/** Squared distance from a point to a box, 0 when the point is inside it. */
function distanceTo(box: Box, x: number, y: number) {
    const dx = Math.max(box.left - x, 0, x - box.right);
    const dy = Math.max(box.top - y, 0, y - box.bottom);
    return dx * dx + dy * dy;
}

/**
 * Every button laid out inside `container`, in render order.
 *
 * Hit testing goes through these rather than `elementFromPoint` so that whatever Discord happens
 * to float over the chat bar mid-drag — a tooltip, an upload overlay — can't swallow the drop.
 */
function itemsIn(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>(`[${ITEM_ATTR}]`))
        .map(el => ({ id: el.getAttribute(ITEM_ATTR)!, rect: el.getBoundingClientRect() }))
        .filter(item => item.rect.width > 0 || item.rect.height > 0);
}

/**
 * The strip you drop a button on to put it back on the bar.
 *
 * The row is only as wide as the buttons still in it, so hiding a few leaves a sliver sitting under
 * one edge of the tray — dragging a button straight back down would land on the message box and do
 * nothing. Anything at the row's height counts instead, which keeps "out" as easy to hit as "in".
 */
function barZone(row: HTMLElement): Box {
    const rect = row.getBoundingClientRect();
    const view = row.ownerDocument.defaultView ?? window;

    return { left: 0, right: view.innerWidth, top: rect.top - BAR_ZONE_PAD, bottom: rect.bottom + BAR_ZONE_PAD };
}

export interface ButtonRowProps {
    className?: string;
    children: ReactNode[];
}

function ButtonRow({ className, children }: ButtonRowProps) {
    const { chatBarButtons } = useSettings(["uiElements.chatBarButtons.*"]).uiElements;
    const store = settings.use(["barOrder", "trayOrder", "caretPosition", "closeOnClick", "trayColumns"]);

    const [open, setOpen] = useState(false);
    const [dragId, setDragId] = useState<string | null>(null);
    const [dropHint, setDropHint] = useState<DropHint | null>(null);

    const rowRef = useRef<HTMLDivElement>(null);
    const caretRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const gestureRef = useRef<Gesture | null>(null);

    // The chat bar also renders inside popped-out channel windows, which have their own document —
    // portalling to the main window's body would put the tray in the wrong window entirely.
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
        setPortalTarget(rowRef.current?.ownerDocument.body ?? null);
    }, []);

    const entries = collect(Array.isArray(children) ? children : [children], chatBarButtons);
    const nodes = new Map(entries.map(e => [e.id, e.node]));
    const present = new Set(entries.map(e => e.id));

    // Ids that aren't rendered right now are still kept in both lists, so a button that only
    // exists in some channels (gift, sticker, submit…) doesn't lose its spot when you're elsewhere.
    const trayed = new Set<string>(store.trayOrder);
    const fullOrder = mergeOrder(entries.map(e => e.id), store.barOrder);
    const barIds = fullOrder.filter(id => present.has(id) && !trayed.has(id));
    const trayIds = store.trayOrder.filter(id => present.has(id));

    const columns = store.trayColumns;

    // A drag outlives the render it started in, so its handlers read the layout from here rather
    // than from their own closure.
    const latest = useRef({ trayIds, fullOrder });
    useLayoutEffect(() => {
        latest.current = { trayIds, fullOrder };
    });

    useLayoutEffect(() => {
        if (!open) return;

        const reposition = () => {
            const caret = caretRef.current;
            const panel = panelRef.current;
            if (!caret || !panel) return;

            const view = panel.ownerDocument.defaultView ?? window;
            const anchor = caret.getBoundingClientRect();
            const { offsetWidth: w, offsetHeight: h } = panel;

            const left = clamp(anchor.left + anchor.width / 2 - w / 2, 8, Math.max(8, view.innerWidth - w - 8));
            let top = anchor.top - h - 8;
            if (top < 8) top = Math.min(anchor.bottom + 8, Math.max(8, view.innerHeight - h - 8));

            panel.style.left = `${Math.round(left)}px`;
            panel.style.top = `${Math.round(top)}px`;
        };

        reposition();

        const view = panelRef.current?.ownerDocument.defaultView ?? window;
        const observer = new view.ResizeObserver(reposition);
        if (panelRef.current) observer.observe(panelRef.current);
        view.addEventListener("resize", reposition);

        return () => {
            observer.disconnect();
            view.removeEventListener("resize", reposition);
        };
    }, [open, portalTarget, trayIds.length, columns]);

    function moveTo(id: string, to: Zone, afterId: string | undefined) {
        if (to === "tray") {
            settings.store.trayOrder = place(settings.store.trayOrder, id, afterId);
        } else {
            settings.store.trayOrder = settings.store.trayOrder.filter(x => x !== id);
            settings.store.barOrder = place(latest.current.fullOrder, id, afterId);
        }
    }

    /** Where would the button land if it were dropped at this point? Resolved off the live DOM. */
    function resolveTarget(g: Gesture, x: number, y: number): DropTarget | null {
        const { trayIds } = latest.current;
        const panel = panelRef.current;
        const row = rowRef.current;

        // The tray floats over everything, so it wins wherever it overlaps the row underneath it
        const inTray = open && panel != null && within(panel.getBoundingClientRect(), x, y, EDGE_SLACK);
        const container = inTray ? panel : row != null && within(barZone(row), x, y) ? row : null;
        if (container == null) return null;

        const zone: Zone = inTray ? "tray" : "bar";

        // Dropping straight onto the caret is the Windows gesture for "hide this". A button that is
        // already hidden gets the opposite reading: the caret is the one thing always left in an
        // emptied row, so treating it as "hide" there would make taking anything back out impossible.
        if (zone === "bar" && !trayIds.includes(g.id) && caretRef.current != null
            && within(caretRef.current.getBoundingClientRect(), x, y, EDGE_SLACK)) {
            const rest = trayIds.filter(id => id !== g.id);
            return { zone: "tray", afterId: rest[rest.length - 1], hint: { zone: "tray", overId: CARET_TARGET } };
        }

        const items = itemsIn(container);
        if (items.length === 0) return { zone, hint: { zone } };

        let nearest = items[0];
        let best = distanceTo(nearest.rect, x, y);
        for (const item of items) {
            const d = distanceTo(item.rect, x, y);
            if (d < best) {
                best = d;
                nearest = item;
            }
        }

        // Hovering the button's own resting place means "leave it where it was"
        if (nearest.id === g.id) return { zone, hint: null, keep: true };

        const { rect } = nearest;
        // The tray is a grid, so there "before" can also mean "on the row above" rather than "left of"
        const before = zone === "tray" && (y < rect.top || y > rect.bottom)
            ? y < rect.top
            : x < rect.left + rect.width / 2;

        const ids = items.map(i => i.id).filter(id => id !== g.id);
        const at = ids.indexOf(nearest.id);

        return {
            zone,
            afterId: before ? ids[at - 1] : nearest.id,
            hint: { zone, overId: nearest.id, side: before ? "before" : "after" }
        };
    }

    function createPreview(g: Gesture) {
        try {
            const rect = g.el.getBoundingClientRect();
            const clone = g.el.cloneNode(true) as HTMLElement;

            clone.removeAttribute(ITEM_ATTR);
            clone.classList.remove(cl("editable"), cl("dragging"), cl("drop-before"), cl("drop-after"));
            clone.classList.add(cl("preview"));
            clone.style.width = `${rect.width}px`;
            clone.style.height = `${rect.height}px`;
            clone.style.transform = `translate(${rect.left}px, ${rect.top}px)`;

            g.doc.body.appendChild(clone);
            return clone;
        } catch (e) {
            // A missing preview is cosmetic; the drag itself still works
            logger.error("Could not build the drag preview", e);
            return null;
        }
    }

    /**
     * A finished drag is followed by a click on whatever the pointer ended up over. Eat exactly
     * that one, so letting go of a button never also presses it.
     */
    function swallowNextClick(doc: Document) {
        const swallow = (e: Event) => {
            e.stopPropagation();
            e.preventDefault();
            doc.removeEventListener("click", swallow, true);
        };

        doc.addEventListener("click", swallow, true);
        // If the drop happens somewhere that produces no click at all, don't leave the trap armed
        doc.defaultView?.setTimeout(() => doc.removeEventListener("click", swallow, true), 0);
    }

    function finishGesture(g: Gesture, target: DropTarget | null) {
        g.detach();
        gestureRef.current = null;

        if (g.active) {
            g.preview?.remove();
            g.doc.body.classList.remove(cl("body-dragging"));
            swallowNextClick(g.doc);
            if (target && !target.keep) moveTo(g.id, target.zone, target.afterId);
        }

        setDragId(null);
        setDropHint(null);
    }

    function onItemPointerDown(e: ReactPointerEvent<HTMLDivElement>, id: string) {
        // Not while closed: outside of arrange mode the buttons behave exactly as Discord ships them
        if (!open || !e.isPrimary || e.button !== 0 || gestureRef.current) return;

        const el = e.currentTarget;
        const doc = el.ownerDocument;
        const rect = el.getBoundingClientRect();

        const onMove = (ev: PointerEvent) => {
            const g = gestureRef.current;
            if (!g || ev.pointerId !== g.pointerId) return;

            if (!g.active) {
                const far = Math.abs(ev.clientX - g.startX) >= DRAG_THRESHOLD
                    || Math.abs(ev.clientY - g.startY) >= DRAG_THRESHOLD;
                if (!far) return;

                g.active = true;
                g.preview = createPreview(g);
                g.doc.body.classList.add(cl("body-dragging"));
                setDragId(g.id);
            }

            g.preview?.style.setProperty("transform", `translate(${ev.clientX - g.grabX}px, ${ev.clientY - g.grabY}px)`);
            setDropHint(resolveTarget(g, ev.clientX, ev.clientY)?.hint ?? null);
        };

        const onUp = (ev: PointerEvent) => {
            const g = gestureRef.current;
            if (!g || ev.pointerId !== g.pointerId) return;
            finishGesture(g, g.active ? resolveTarget(g, ev.clientX, ev.clientY) : null);
        };

        const onCancel = (ev: PointerEvent) => {
            const g = gestureRef.current;
            if (!g || ev.pointerId !== g.pointerId) return;
            finishGesture(g, null);
        };

        // dragging a button across the page must not smear a text selection over everything it passes
        const onSelectStart = (ev: Event) => ev.preventDefault();

        doc.addEventListener("pointermove", onMove);
        doc.addEventListener("pointerup", onUp);
        doc.addEventListener("pointercancel", onCancel);
        doc.addEventListener("selectstart", onSelectStart);

        gestureRef.current = {
            id,
            el,
            doc,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            grabX: e.clientX - rect.left,
            grabY: e.clientY - rect.top,
            active: false,
            preview: null,
            detach() {
                doc.removeEventListener("pointermove", onMove);
                doc.removeEventListener("pointerup", onUp);
                doc.removeEventListener("pointercancel", onCancel);
                doc.removeEventListener("selectstart", onSelectStart);
            }
        };
    }

    useEffect(() => {
        if (!open) return;

        const doc = portalTarget?.ownerDocument ?? document;

        // Clicking a button is using it, not dismissing the tray, so the row counts as "inside"
        const onMouseDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (panelRef.current?.contains(target) || rowRef.current?.contains(target)) return;
            setOpen(false);
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;

            const g = gestureRef.current;
            if (g?.active) {
                finishGesture(g, null);
                return;
            }
            setOpen(false);
        };

        doc.addEventListener("mousedown", onMouseDown, true);
        doc.addEventListener("keydown", onKeyDown);

        return () => {
            doc.removeEventListener("mousedown", onMouseDown, true);
            doc.removeEventListener("keydown", onKeyDown);
        };
    }, [open, portalTarget]);

    // Unmounting mid-drag (channel switch, popout close) must not leave listeners or a preview behind
    useEffect(() => () => {
        const g = gestureRef.current;
        if (!g) return;

        g.detach();
        g.preview?.remove();
        g.doc.body.classList.remove(cl("body-dragging"));
        gestureRef.current = null;
    }, []);

    function onZoneClick(e: ReactMouseEvent<HTMLDivElement>) {
        if (!store.closeOnClick) return;

        const target = e.target as HTMLElement;
        // the caret has its own toggle; closing here too would fight it
        if (caretRef.current?.contains(target)) return;
        if (target.closest(`[${ITEM_ATTR}]`)) setOpen(false);
    }

    function renderItem(id: string) {
        const hint = dropHint?.overId === id ? dropHint.side : undefined;

        return (
            <div
                key={id}
                data-vc-cbt-id={id}
                className={cl("item", {
                    editable: open,
                    dragging: dragId === id,
                    "drop-before": hint === "before",
                    "drop-after": hint === "after"
                })}
                onPointerDown={e => onItemPointerDown(e, id)}
                // an <img> inside a button would otherwise start a native drag and fight this one
                onDragStart={e => { if (open) e.preventDefault(); }}
            >
                {nodes.get(id)}
            </div>
        );
    }

    const caret = (
        <div
            key="vc-cbt-caret"
            ref={caretRef}
            className={cl("item", "caret", { "caret-target": dropHint?.overId === CARET_TARGET })}
        >
            <ChatBarButton
                tooltip={open ? "Close tray" : trayIds.length ? `Tray (${trayIds.length})` : "Tray"}
                onClick={() => setOpen(o => !o)}
            >
                <CaretIcon open={open} />
            </ChatBarButton>
        </div>
    );

    const panel = portalTarget && ReactDOM.createPortal(
        <div
            ref={panelRef}
            className={cl("panel", {
                "panel-open": open,
                "panel-drop": dropHint?.zone === "tray"
            })}
            style={{ "--vc-cbt-columns": columns } as CSSProperties}
            onClick={onZoneClick}
        >
            {trayIds.length > 0
                ? <div className={cl("panel-grid")}>{trayIds.map(id => renderItem(id))}</div>
                : <div className={cl("panel-empty")}>Drag buttons here to tuck them away</div>}
            <div className={cl("panel-hint")}>Click to use · drag back to the chat bar to restore</div>
        </div>,
        portalTarget
    );

    return (
        <div
            ref={rowRef}
            className={classes(className, cl("row", { "row-drop": dragId != null && dropHint?.zone === "bar" }))}
            onClick={onZoneClick}
        >
            {store.caretPosition === "start" && caret}
            {barIds.map(id => renderItem(id))}
            {store.caretPosition === "end" && caret}
            {panel}
        </div>
    );
}

export default ErrorBoundary.wrap(ButtonRow, {
    displayName: "ChatBarTray",
    // Never take the whole chat bar down with us — fall back to Discord's plain row
    fallback: ({ wrappedProps }) => <div className={wrappedProps.className}>{wrappedProps.children}</div>
});
