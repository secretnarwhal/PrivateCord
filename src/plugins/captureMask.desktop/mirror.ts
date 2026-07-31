/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findTargetElement, type Target } from "./targets";
import type { Chrome, Frame, Rect, ScrollUpdate } from "./types";

export const CMASK_CLASS_PREFIX = "vc-cmask";

/**
 * Discord gives every scroll container a hashed class with this readable
 * prefix. The overlay repeats this selector verbatim so the offsets we send
 * line up index-for-index with the elements it applies them to.
 */
export const SCROLLER_SELECTOR = '[class*="scroller"]';

/** Marks the mirrored subtree root inside the overlay's ancestor scaffolding. */
export const ROOT_ATTR = "data-vc-cmask-root";

/** Marks the rebuilt ancestors, which the overlay collapses out of layout. */
export const CHAIN_ATTR = "data-vc-cmask-chain";

const FRAME_INTERVAL_MS = 150;

function escapeAttr(value: string) {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Serialises an element's start tag, dropping our own mask classes so the
 * overlay's copy of Discord's CSS cannot blank the clone out.
 */
function openTag(el: Element, opts: { rootId?: string; chain?: boolean; } = {}) {
    let out = `<${el.localName}`;

    for (const { name, value } of Array.from(el.attributes)) {
        let v = value;
        if (name === "class") {
            v = value.split(/\s+/).filter(c => c && !c.startsWith(CMASK_CLASS_PREFIX)).join(" ");
            if (!v) continue;
        }
        out += ` ${name}="${escapeAttr(v)}"`;
    }

    if (opts.rootId) out += ` ${ROOT_ATTR}="${escapeAttr(opts.rootId)}"`;
    if (opts.chain) out += ` ${CHAIN_ATTR}=""`;

    return out + ">";
}

/**
 * Discord leans on descendant selectors rooted at layout wrappers, so a bare
 * subtree clone loses most of its styling. Rebuilding the chain of ancestors —
 * tags and attributes only, no siblings — makes those selectors match again.
 */
function serialize(el: HTMLElement, id: string) {
    const chain: Element[] = [];
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        chain.unshift(node);
    }

    const open = chain.map(node => openTag(node, { chain: true })).join("");
    const close = chain.map(node => `</${node.localName}>`).reverse().join("");

    // innerHTML rather than a deep clone: one serialisation pass, and it lets us
    // rewrite the root's own attributes without touching the live DOM. Toggling
    // classes on the real element to read it back would flash the unmasked
    // content into whatever is recording the screen.
    return `${open}${openTag(el, { rootId: id })}${el.innerHTML}</${el.localName}>${close}`;
}

function readScroll(el: HTMLElement): number[] {
    return Array.from(el.querySelectorAll(SCROLLER_SELECTOR)).map(n => n.scrollTop);
}

function readRect(el: HTMLElement): Rect {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
}

export function readChrome(): Chrome {
    return {
        htmlClass: document.documentElement.className,
        htmlStyle: document.documentElement.getAttribute("style") ?? "",
        bodyClass: document.body.className,
        bodyStyle: document.body.getAttribute("style") ?? ""
    };
}

function sameRect(a: Rect, b: Rect) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Watches one target and emits repaints. Markup is throttled and de-duplicated
 * because Discord mutates its tree constantly, while scrolling gets its own
 * cheap path so dragging the DM list does not reserialise it every frame.
 */
export class TargetMirror {
    private observer?: MutationObserver;
    private resizeObserver?: ResizeObserver;
    private element?: HTMLElement;

    private frameTimer?: number;
    private scrollFrame?: number;
    private lastHtml = "";
    private lastRect?: Rect;

    constructor(
        private readonly target: Target,
        private readonly onFrame: (frame: Frame) => void,
        private readonly onScroll: (update: ScrollUpdate) => void
    ) { }

    get id() {
        return this.target.id;
    }

    attach(el: HTMLElement) {
        if (this.element === el) return;
        this.detach();

        this.element = el;
        this.lastHtml = "";
        this.lastRect = undefined;

        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(el, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });

        this.resizeObserver = new ResizeObserver(() => this.schedule());
        this.resizeObserver.observe(el);

        el.addEventListener("scroll", this.handleScroll, true);

        this.flush();
    }

    detach() {
        this.observer?.disconnect();
        this.observer = undefined;
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;

        this.element?.removeEventListener("scroll", this.handleScroll, true);
        this.element = undefined;

        if (this.frameTimer !== undefined) clearTimeout(this.frameTimer);
        this.frameTimer = undefined;

        if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame);
        this.scrollFrame = undefined;
    }

    /** Re-resolves the target element, detaching if it has left the DOM. */
    sync() {
        if (!this.target.isRelevant()) {
            this.detach();
            return undefined;
        }

        const el = findTargetElement(this.target);
        if (!el) {
            this.detach();
            return undefined;
        }

        this.attach(el);
        return el;
    }

    private readonly handleScroll = () => {
        if (this.scrollFrame !== undefined) return;

        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = undefined;
            if (!this.element) return;

            this.onScroll({ id: this.target.id, scroll: readScroll(this.element) });
        });
    };

    private schedule() {
        if (this.frameTimer !== undefined) return;

        this.frameTimer = window.setTimeout(() => {
            this.frameTimer = undefined;
            this.flush();
        }, FRAME_INTERVAL_MS);
    }

    private flush() {
        const el = this.element;
        if (!el?.isConnected) return;

        const html = serialize(el, this.target.id);
        const rect = readRect(el);

        // Discord churns its tree on timers even when nothing visible changed
        if (html === this.lastHtml && this.lastRect && sameRect(rect, this.lastRect)) return;

        this.lastHtml = html;
        this.lastRect = rect;

        this.onFrame({ id: this.target.id, rect, html, scroll: readScroll(el) });
    }
}
