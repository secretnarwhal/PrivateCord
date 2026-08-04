/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { ConnectionStatus } from "@plugins/ircChat/irc/connection";
import { connect, disconnect, sendChat, useIrc } from "@plugins/ircChat/IrcStore";
import { settings } from "@plugins/ircChat/settings";
import { cl } from "@plugins/ircChat/utils";
import { useEffect } from "@webpack/common";

import { Composer } from "./Composer";
import { MemberList } from "./MemberList";
import { MessageList } from "./MessageList";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting…",
    registering: "Registering…",
    connected: "Connected",
    reconnecting: "Reconnecting…"
};

function StatusDot({ status }: { status: ConnectionStatus; }) {
    return <span className={cl("status-dot", `status-${status}`)} aria-hidden="true" />;
}

export function IrcPanel({ onClose }: { onClose(): void; }) {
    const state = useIrc();
    const connected = state.status === "connected";
    const busy = state.status === "connecting" || state.status === "registering";

    // Escape closes the panel. Bound on the panel's own lifetime so it doesn't
    // linger after the portal unmounts.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className={cl("panel")} onClick={e => e.stopPropagation()}>
            <header className={cl("header")}>
                <div className={cl("header-main")}>
                    <StatusDot status={state.status} />
                    <span className={cl("header-channel")}>
                        {state.channel || settings.store.channel}
                    </span>
                    <span className={cl("header-status")}>
                        {STATUS_LABEL[state.status]}
                        {state.nick && connected && ` as ${state.nick}`}
                        {connected && !state.joined && " — not in channel"}
                    </span>
                </div>

                <div className={cl("header-actions")}>
                    {connected || busy ? (
                        <Button size="small" variant="secondary" onClick={disconnect}>
                            Disconnect
                        </Button>
                    ) : (
                        <Button size="small" variant="primary" onClick={() => connect()}>
                            Connect
                        </Button>
                    )}
                    <button className={cl("close")} onClick={onClose} aria-label="Close" title="Close">
                        ×
                    </button>
                </div>
            </header>

            {state.topic && (
                <div className={cl("topic")} title={state.topic}>
                    {state.topic}
                </div>
            )}

            <div className={cl("body")}>
                <MessageList entries={state.entries} />
                <MemberList members={state.members} self={state.nick} />
            </div>

            <Composer
                members={state.members}
                // Stays enabled when connected-but-not-joined: that is exactly
                // the state a new user is in on a registered-only channel, and
                // they need the input to run /register.
                disabled={!connected}
                placeholder={
                    !connected
                        ? "Connect to start chatting"
                        : state.joined
                            ? `Message ${state.channel} — this does not go to Discord`
                            : "Not in the channel — run /register <password> to make an account"
                }
                onSend={sendChat}
            />
        </div>
    );
}
