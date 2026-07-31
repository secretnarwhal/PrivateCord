/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CMASK_CLASS_PREFIX } from "./mirror";

/**
 * Rewrites relative and root-relative `url()` targets to absolute ones.
 *
 * The overlay renders from a data: URL, so it has an opaque origin and no
 * usable base — `/assets/gg-sans.woff2` would resolve to nothing there. Every
 * reference has to be absolute before the CSS leaves this window.
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

/**
 * Our own mask rules must never reach the overlay — they would blank the clone.
 * Vencord's managed styles are <style> nodes whose id is the source path, so
 * that is what identifies ours.
 */
function isOwnStyleSheet(sheet: CSSStyleSheet) {
    const node = sheet.ownerNode as HTMLElement | null;
    if (!node) return false;

    return node.id?.includes("captureMask") === true
        || node.id?.startsWith(CMASK_CLASS_PREFIX) === true;
}

async function readSheet(sheet: CSSStyleSheet): Promise<string> {
    if (sheet.href) {
        // The stylesheet is already in the HTTP cache, so this does not hit the
        // network in practice. Reading .cssRules would work too but serialising
        // Discord's rule tree costs hundreds of milliseconds.
        const res = await fetch(sheet.href, { credentials: "omit" });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        return absolutiseUrls(await res.text(), sheet.href);
    }

    const text = sheet.ownerNode?.textContent ?? "";
    return absolutiseUrls(text, location.href);
}

/**
 * Collects every stylesheet Discord has loaded into one blob for the overlay.
 * Sheets that cannot be read are skipped rather than failing the whole harvest;
 * a missing sheet degrades the mirror's looks, not its correctness.
 */
export async function harvestCss(): Promise<string> {
    const sheets = Array.from(document.styleSheets)
        .filter((sheet): sheet is CSSStyleSheet => !isOwnStyleSheet(sheet as CSSStyleSheet));

    const parts = await Promise.all(sheets.map(sheet =>
        readSheet(sheet).catch(err => {
            console.warn("[CaptureMask] skipping stylesheet", sheet.href ?? "(inline)", err);
            return "";
        })
    ));

    return parts.filter(Boolean).join("\n");
}
