/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { insertTextIntoChatInputBox } from "@utils/discord";
import { classes } from "@utils/misc";
import { useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import { CATEGORIES, type Kaomoji } from "./data";
import { ClipboardIcon, CloseIcon, PlusIcon, SearchIcon } from "./icons";
import { settings } from "./settings";
import { addCustom, clearRecent, getAllRecent, getCustom, getRecent, noteUsed, removeCustom, useKaomojiStore } from "./store";
import { cl } from "./utils";

/** Lets Recent show the same names the built-ins have, since it only stores text. */
const NAME_BY_TEXT = new Map<string, string>(
    CATEGORIES.flatMap(c => c.items.map(item => [item.text, item.name] as const))
);

interface Section {
    id: string;
    label: string;
    items: Kaomoji[];
    /** custom kaomoji get a delete affordance; built-ins obviously don't */
    removable?: boolean;
}

/**
 * Prepares a kaomoji for the chat box.
 *
 * Backslashes are always doubled: Discord reads `\_` as an escaped underscore, which is
 * exactly why the shrug has to be typed as `¯\\_(ツ)_/¯` to survive. `\\` renders as a
 * single backslash, so this is correct for every kaomoji, not just that one.
 */
function toChatText(text: string) {
    let out = text.replaceAll("\\", "\\\\");
    if (settings.store.escapeMarkdown) out = out.replace(/([*_~`|])/g, "\\$1");

    return settings.store.trailingSpace ? `${out} ` : out;
}

function Tile({ item, removable, onPick }: {
    item: Kaomoji;
    removable?: boolean;
    onPick: (text: string, keepOpen: boolean) => void;
}) {
    return (
        <div className={classes(cl("tile"), removable && cl("tile-custom"))}>
            <button
                type="button"
                className={cl("tile-face")}
                title={item.name || item.text}
                onClick={e => onPick(item.text, e.shiftKey)}
            >
                {item.text}
            </button>

            {removable && (
                <button
                    type="button"
                    className={cl("tile-remove")}
                    aria-label={`Remove ${item.text}`}
                    title="Remove"
                    onClick={e => {
                        e.stopPropagation();
                        removeCustom(item.text);
                    }}
                >
                    <CloseIcon />
                </button>
            )}
        </div>
    );
}

/**
 * The "paste one in" state: a translucent sheet over the whole keyboard with a
 * focused, invisible input behind it catching the paste. The input has to exist and
 * hold focus — without it Ctrl+V goes to whatever Discord thinks is focused, which
 * is the message box.
 */
function PasteOverlay({ onClose }: { onClose(): void; }) {
    const catcherRef = useRef<HTMLInputElement>(null);
    const [added, setAdded] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        catcherRef.current?.focus();
    }, []);

    function onPaste(e: ReactClipboardEvent<HTMLInputElement>) {
        // the catcher must stay empty — it's a listening post, not a text field
        e.preventDefault();

        const raw = e.clipboardData.getData("text");
        if (!raw?.trim()) {
            setError("There's no text on your clipboard.");
            return;
        }

        const fresh = addCustom(raw);
        if (!fresh.length) {
            setError("You've already got that one.");
            return;
        }

        setError(null);
        setAdded(prev => [...fresh, ...prev].slice(0, 10));
    }

    return (
        <div
            className={cl("overlay")}
            // any click inside the sheet has to hand focus straight back to the catcher,
            // or the next Ctrl+V silently lands in the chat box
            onMouseDown={e => {
                e.preventDefault();
                catcherRef.current?.focus();
            }}
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <input
                ref={catcherRef}
                className={cl("catcher")}
                aria-label="Paste a kaomoji"
                onPaste={onPaste}
                onKeyDown={e => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        onClose();
                    }
                }}
            />

            <div className={cl("overlay-card")}>
                <div className={cl("overlay-badge")}>
                    <ClipboardIcon width={30} height={30} />
                </div>

                <div className={cl("overlay-cue")}>
                    <kbd className={cl("key")}>Ctrl</kbd>
                    <span className={cl("overlay-plus")}>+</span>
                    <kbd className={cl("key")}>V</kbd>
                </div>

                <div className={cl("overlay-sub")}>
                    Paste a kaomoji to add it to your collection.
                    <br />
                    One per line adds several at once.
                </div>

                {error && <div className={cl("overlay-error")}>{error}</div>}

                {added.length > 0 && (
                    <div className={cl("overlay-added")}>
                        {added.map(text => (
                            <span key={text} className={cl("overlay-chip")}>{text}</span>
                        ))}
                    </div>
                )}

                <button type="button" className={cl("overlay-done")} onClick={onClose}>
                    {added.length ? `Done — added ${added.length}` : "Cancel"}
                </button>
            </div>
        </div>
    );
}

export function KaomojiPicker({ close }: { close(): void; }) {
    // a counter, bumped whenever the custom or recent lists change — the one dep the
    // section list needs beyond the query
    const storeVersion = useKaomojiStore();

    const [query, setQuery] = useState("");
    const [activeId, setActiveId] = useState<string>("");
    const [adding, setAdding] = useState(false);

    const bodyRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

    // Recent is snapshotted when the keyboard opens. Letting it re-sort live would slide
    // every other section down mid-click, right as you're aiming at the next face — so
    // what you used this session shows up the next time you open it, not immediately.
    const recentOnOpen = useRef<string[] | null>(null);
    recentOnOpen.current ??= getRecent();

    const sections = useMemo<Section[]>(() => {
        const named = (text: string) => ({ text, name: NAME_BY_TEXT.get(text) ?? "" });
        const customItems = getCustom().map(named);
        const needle = query.trim().toLowerCase();

        if (needle) {
            // one flat result list, matched on the name rather than the face — nobody
            // searches for a bear by typing "ʕ•ᴥ•ʔ"
            const seen = new Set<string>();
            const hits: Kaomoji[] = [];

            const consider = (item: Kaomoji, haystack: string) => {
                if (seen.has(item.text) || !haystack.includes(needle)) return;
                seen.add(item.text);
                hits.push(item);
            };

            for (const item of customItems) consider(item, `${item.text} ${item.name} yours custom`.toLowerCase());
            for (const category of CATEGORIES)
                for (const item of category.items)
                    consider(item, `${item.name} ${category.label} ${item.text}`.toLowerCase());

            return hits.length ? [{ id: "results", label: `Results for "${query.trim()}"`, items: hits }] : [];
        }

        // the snapshot still has to drop anything deleted or cleared out from under it
        const stillThere = new Set(getAllRecent());
        const recentItems = (recentOnOpen.current ?? []).filter(text => stillThere.has(text)).map(named);

        return [
            ...(recentItems.length ? [{ id: "recent", label: "Recent", items: recentItems }] : []),
            ...(customItems.length ? [{ id: "custom", label: "Yours", items: customItems, removable: true }] : []),
            ...CATEGORIES
        ];
    }, [query, storeVersion]);

    // opening straight onto Recent, or Joy on a fresh install
    useEffect(() => {
        if (!sections.some(s => s.id === activeId)) setActiveId(sections[0]?.id ?? "");
    }, [sections]);

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    function pick(text: string, keepOpen: boolean) {
        noteUsed(text);
        insertTextIntoChatInputBox(toChatText(text));
        if (!keepOpen && settings.store.closeOnSelect) close();
    }

    function scrollToSection(id: string) {
        const body = bodyRef.current;
        const el = sectionRefs.current[id];
        if (!body || !el) return;

        setActiveId(id);
        body.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: "smooth" });
    }

    /** Keeps the pill row in sync with what's actually under the header. */
    function onScroll() {
        const body = bodyRef.current;
        if (!body) return;

        const line = body.scrollTop + 16;
        let current = sections[0]?.id;
        for (const section of sections) {
            const el = sectionRefs.current[section.id];
            if (el && el.offsetTop <= line) current = section.id;
        }

        if (current && current !== activeId) setActiveId(current);
    }

    function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter") {
            const first = sections[0]?.items[0];
            if (first) {
                e.preventDefault();
                pick(first.text, e.shiftKey);
            }
        } else if (e.key === "Escape" && query) {
            // first Escape clears the search, a second one closes the keyboard
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
        }
    }

    return (
        <div className={cl("picker")}>
            <div className={cl("search")}>
                <SearchIcon className={cl("search-icon")} />
                <input
                    ref={searchRef}
                    className={cl("search-input")}
                    value={query}
                    placeholder="Search kaomoji…"
                    onChange={e => setQuery(e.currentTarget.value)}
                    onKeyDown={onSearchKeyDown}
                />
                {query && (
                    <button
                        type="button"
                        className={cl("search-clear")}
                        aria-label="Clear search"
                        onClick={() => {
                            setQuery("");
                            searchRef.current?.focus();
                        }}
                    >
                        <CloseIcon />
                    </button>
                )}
            </div>

            {!query.trim() && (
                <div className={cl("cats")}>
                    {sections.map(section => (
                        <button
                            type="button"
                            key={section.id}
                            className={classes(cl("cat"), activeId === section.id && cl("cat-active"))}
                            onClick={() => scrollToSection(section.id)}
                        >
                            {section.label}
                        </button>
                    ))}
                </div>
            )}

            <div className={cl("body")} ref={bodyRef} onScroll={onScroll}>
                {sections.map(section => (
                    <div
                        key={section.id}
                        className={cl("section")}
                        ref={el => void (sectionRefs.current[section.id] = el)}
                    >
                        <div className={cl("section-head")}>
                            <span className={cl("section-title")}>{section.label}</span>
                            <span className={cl("section-count")}>{section.items.length}</span>

                            {section.id === "recent" && (
                                <button type="button" className={cl("section-action")} onClick={() => clearRecent()}>
                                    Clear
                                </button>
                            )}
                        </div>

                        <div className={cl("grid")}>
                            {section.items.map(item => (
                                <Tile
                                    key={item.text}
                                    item={item}
                                    removable={section.removable}
                                    onPick={pick}
                                />
                            ))}
                        </div>
                    </div>
                ))}

                {!sections.length && (
                    <div className={cl("empty")}>
                        <span className={cl("empty-face")}>(・_・?)</span>
                        <span>Nothing matches that.</span>
                        <span className={cl("empty-hint")}>Paste it in with <strong>Add kaomoji</strong> and it's yours forever.</span>
                    </div>
                )}
            </div>

            <div className={cl("footer")}>
                <button type="button" className={cl("add")} onClick={() => setAdding(true)}>
                    <PlusIcon />
                    Add kaomoji
                </button>
                <span className={cl("footer-hint")}>Shift-click to keep this open</span>
            </div>

            {adding && (
                <PasteOverlay
                    onClose={() => {
                        setAdding(false);
                        searchRef.current?.focus();
                    }}
                />
            )}
        </div>
    );
}
