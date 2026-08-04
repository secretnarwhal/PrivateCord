/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatEntry } from "@plugins/ircChat/IrcStore";
import { cl, formatTime, nickColor, segmentText } from "@plugins/ircChat/utils";
import { useCallback, useEffect, useLayoutEffect, useRef } from "@webpack/common";

/** How close to the bottom still counts as "following the conversation". */
const STICK_THRESHOLD_PX = 80;

function EntryText({ text }: { text: string; }) {
    return (
        <>
            {segmentText(text).map((segment, i) =>
                segment.type === "link" ? (
                    <a
                        key={i}
                        className={cl("link")}
                        href={segment.value}
                        target="_blank"
                        rel="noreferrer noopener"
                    >
                        {segment.value}
                    </a>
                ) : (
                    <span key={i}>{segment.value}</span>
                )
            )}
        </>
    );
}

function Entry({ entry }: { entry: ChatEntry; }) {
    const time = formatTime(entry.timestamp);

    if (entry.kind === "system" || entry.kind === "error") {
        return (
            <div className={cl("entry", "entry-system", entry.kind === "error" && "entry-error")}>
                <span className={cl("time")}>{time}</span>
                <span className={cl("system-text")}>{entry.text}</span>
            </div>
        );
    }

    if (entry.kind === "join" || entry.kind === "part") {
        return (
            <div className={cl("entry", "entry-presence")}>
                <span className={cl("time")}>{time}</span>
                <span className={cl("presence-marker")}>{entry.kind === "join" ? "→" : "←"}</span>
                <span className={cl("presence-text")}>
                    <b>{entry.nick}</b> {entry.text}
                </span>
            </div>
        );
    }

    if (entry.kind === "action") {
        return (
            <div className={cl("entry", "entry-action")}>
                <span className={cl("time")}>{time}</span>
                <span className={cl("action-text")}>
                    <b style={{ color: nickColor(entry.nick) }}>{entry.nick}</b>{" "}
                    <EntryText text={entry.text} />
                </span>
            </div>
        );
    }

    return (
        <div
            className={cl(
                "entry",
                "entry-message",
                entry.mention && "entry-mention",
                entry.kind === "notice" && "entry-notice",
                entry.kind === "private" && "entry-private"
            )}
        >
            <span className={cl("time")}>{time}</span>
            <span className={cl("nick")} style={{ color: nickColor(entry.nick) }}>
                {entry.kind === "notice" ? `-${entry.nick}-` : entry.nick}
            </span>
            <span className={cl("text")}>
                <EntryText text={entry.text} />
            </span>
        </div>
    );
}

export function MessageList({ entries }: { entries: ChatEntry[]; }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // Whether we should keep pinning to the bottom. Starts true and only turns
    // off when the user deliberately scrolls up to read backlog.
    const stickRef = useRef(true);

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickRef.current = distanceFromBottom <= STICK_THRESHOLD_PX;
    }, []);

    // useLayoutEffect so the scroll happens in the same frame the new entry
    // paints — with useEffect you get a visible jump on every message.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    }, [entries]);

    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, []);

    if (!entries.length) {
        return (
            <div className={cl("messages", "messages-empty")} ref={scrollRef}>
                <div className={cl("empty")}>
                    <div className={cl("empty-icon")}>#</div>
                    <div className={cl("empty-heading")}>Nothing here yet</div>
                    <div className={cl("empty-sub")}>
                        Messages go to the IRC server, not to Discord.
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("messages")} ref={scrollRef} onScroll={handleScroll}>
            {entries.map(entry => (
                <Entry key={entry.id} entry={entry} />
            ))}
        </div>
    );
}
