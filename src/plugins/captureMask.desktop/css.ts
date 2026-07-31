/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CMASK_CLASS_PREFIX } from "./mirror";
import type { HarvestedCss } from "./types";

/**
 * Rewrites relative and root-relative `url()` targets to absolute ones, against
 * the stylesheet's own address. Once the text is lifted out of its sheet there
 * is nothing left for `/assets/…` to resolve against.
 */
function absolutiseUrls(css: string, base: string) {
    return css.replace(
        /url\((\s*['"]?)(?!['"]?(?:data:|blob:|https?:|\/\/|#))([^)'"]+)(['"]?\s*)\)/g,
        (match, open: string, url: string, close: string) => {
            try {
                return `url(${open}${new URL(url.trim(), base).href}${close})`;
            } catch {
                return match;
            }
        }
    );
}

/** Our own mask rules must never reach the overlay — they would blank the clone. */
function isOwnStyleSheet(node: Element) {
    const id = node.id ?? "";
    return id.includes("captureMask") || id.startsWith(CMASK_CLASS_PREFIX);
}

/** Enough parallelism to be quick, not enough to stall the renderer. */
const CONCURRENCY = 12;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (let i = cursor++; i < items.length; i = cursor++) {
            results[i] = await fn(items[i]);
        }
    }));

    return results;
}

/**
 * Reads every stylesheet Discord has loaded, as text.
 *
 * This runs in Discord's own renderer, which is same-origin with discord.com,
 * so these fetches cannot be refused — unlike loading the same URLs from the
 * overlay, whose data: URL origin is opaque and gets turned away by CORP, CORS
 * and origin checks before the bytes ever arrive. Sheets that fail are counted
 * and skipped rather than failing the harvest: a missing sheet costs looks, not
 * correctness.
 */
export async function harvestCss(): Promise<HarvestedCss> {
    const links: HTMLLinkElement[] = [];
    const inline: string[] = [];

    for (const node of document.querySelectorAll<HTMLElement>("link[rel~=stylesheet], style")) {
        if (isOwnStyleSheet(node)) continue;

        if (node instanceof HTMLLinkElement) {
            if (node.href) links.push(node);
        } else if (node.textContent) {
            inline.push(absolutiseUrls(node.textContent, location.href));
        }
    }

    let failed = 0;

    const fetched = await mapLimit(links, CONCURRENCY, async link => {
        try {
            // Already in the HTTP cache, so this does not hit the network
            const res = await fetch(link.href, { credentials: "same-origin" });
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

            return absolutiseUrls(await res.text(), link.href);
        } catch (err) {
            failed++;
            console.warn("[CaptureMask] skipping stylesheet", link.href, err);
            return "";
        }
    });

    const css = [...fetched, ...inline].filter(Boolean).join("\n");

    return { css, sheets: links.length, failed };
}
