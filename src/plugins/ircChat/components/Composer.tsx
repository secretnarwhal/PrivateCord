/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ParsedMember } from "@plugins/ircChat/irc/protocol";
import { cl } from "@plugins/ircChat/utils";
import { useCallback, useRef, useState } from "@webpack/common";

const MAX_HISTORY = 50;
const MAX_TEXTAREA_HEIGHT = 140;

interface CompletionState {
    /** The partial word that started this completion run. */
    stem: string;
    matches: string[];
    index: number;
    start: number;
}

export function Composer({
    members,
    disabled,
    placeholder,
    onSend
}: {
    members: ParsedMember[];
    disabled: boolean;
    placeholder: string;
    onSend(text: string): void;
}) {
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const history = useRef<string[]>([]);
    // -1 means "composing a new line" rather than browsing history.
    const historyIndex = useRef(-1);
    const completion = useRef<CompletionState | null>(null);

    const resize = useCallback(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
    }, []);

    const setInput = useCallback((next: string) => {
        setValue(next);
        // Height depends on the new content, so defer past this render.
        requestAnimationFrame(resize);
    }, [resize]);

    const submit = useCallback(() => {
        const text = value.trim();
        if (!text) return;

        onSend(text);

        history.current = [text, ...history.current.filter(h => h !== text)].slice(0, MAX_HISTORY);
        historyIndex.current = -1;
        completion.current = null;
        setInput("");
    }, [value, onSend, setInput]);

    /** Cycle nick completion for the word immediately before the cursor. */
    const complete = useCallback(() => {
        const el = inputRef.current;
        if (!el) return;

        const cursor = el.selectionStart ?? value.length;

        // A run already in progress: advance to the next candidate.
        if (completion.current) {
            const state = completion.current;
            state.index = (state.index + 1) % state.matches.length;

            const replacement = state.matches[state.index];
            const suffix = state.start === 0 ? ": " : " ";
            const next = value.slice(0, state.start) + replacement + suffix + value.slice(cursor);

            setInput(next);
            const caret = state.start + replacement.length + suffix.length;
            requestAnimationFrame(() => el.setSelectionRange(caret, caret));
            return;
        }

        const before = value.slice(0, cursor);
        const start = before.lastIndexOf(" ") + 1;
        const stem = before.slice(start);
        if (!stem) return;

        const matches = members
            .map(m => m.nick)
            .filter(nick => nick.toLowerCase().startsWith(stem.toLowerCase()));

        if (!matches.length) return;

        completion.current = { stem, matches, index: 0, start };

        const replacement = matches[0];
        const suffix = start === 0 ? ": " : " ";
        const next = value.slice(0, start) + replacement + suffix + value.slice(cursor);

        setInput(next);
        const caret = start + replacement.length + suffix.length;
        requestAnimationFrame(() => el.setSelectionRange(caret, caret));
    }, [value, members, setInput]);

    const browseHistory = useCallback((direction: 1 | -1) => {
        if (!history.current.length) return;

        const next = historyIndex.current + direction;
        if (next < 0) {
            historyIndex.current = -1;
            setInput("");
            return;
        }
        if (next >= history.current.length) return;

        historyIndex.current = next;
        setInput(history.current[next]);
    }, [setInput]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Tab") {
            e.preventDefault();
            complete();
            return;
        }

        // Any other key ends the completion run, so the next Tab starts fresh.
        if (e.key !== "Shift") completion.current = null;

        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
            return;
        }

        // Only browse history from an un-wrapped single-line input, otherwise
        // arrow keys would fight with normal multi-line cursor movement.
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !value.includes("\n")) {
            e.preventDefault();
            browseHistory(e.key === "ArrowUp" ? 1 : -1);
        }
    }, [complete, submit, browseHistory, value]);

    return (
        <div className={cl("composer")}>
            <textarea
                ref={inputRef}
                className={cl("composer-input")}
                value={value}
                rows={1}
                disabled={disabled}
                placeholder={placeholder}
                onChange={e => {
                    setValue(e.target.value);
                    resize();
                }}
                onKeyDown={handleKeyDown}
            />
            <button
                className={cl("composer-send")}
                onClick={submit}
                disabled={disabled || !value.trim()}
                aria-label="Send"
                title="Send"
            >
                <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
            </button>
        </div>
    );
}
