/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, useState } from "@webpack/common";

import {
    abortChat,
    ChatMessage,
    cl,
    fetchChatHistory,
    messageText,
    sendChatMessage
} from "../utils";

// ── Icons ────────────────────────────────────────────────────────────────

function SendIcon() {
    return (
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                fill="currentColor"
                d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"
            />
        </svg>
    );
}

function StopIcon() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </svg>
    );
}

function SpinnerDots() {
    return (
        <div className={cl("chat-typing")}>
            <span className={cl("chat-typing-dot")} />
            <span className={cl("chat-typing-dot")} />
            <span className={cl("chat-typing-dot")} />
        </div>
    );
}

// ── Message bubble ───────────────────────────────────────────────────────

function ChatBubble({ msg }: { msg: ChatMessage; }) {
    const role = msg.role || "user";
    const text = messageText(msg.content);
    const isUser = role === "user";

    // Skip empty / thinking-only messages
    if (!text && !msg.isThinking) return null;

    return (
        <div className={cl("chat-bubble", isUser ? "chat-bubble-user" : "chat-bubble-assistant")}>
            <div className={cl("chat-bubble-role")}>
                {isUser ? "You" : "OpenClaw"}
            </div>
            <div className={cl("chat-bubble-text")}>
                {text || <span className={cl("muted")}>[no text content]</span>}
            </div>
        </div>
    );
}

// ── Main ChatView ────────────────────────────────────────────────────────

export function ChatView({ sessionKey }: { sessionKey: string | null; }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [input, setInput] = useState("");

    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const sendingRef = useRef(false);

    // Keep sendingRef in sync
    sendingRef.current = sending;

    // Auto-scroll to bottom when messages change
    const scrollToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (el) {
            // Use requestAnimationFrame so the DOM has rendered the new content
            requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight;
            });
        }
    }, []);

    // Load chat history
    const loadHistory = useCallback(async (silent = false) => {
        if (!sessionKey) return;
        if (!silent) setLoading(true);
        try {
            const res = await fetchChatHistory(sessionKey);
            const msgs = res.messages ?? [];
            setMessages(msgs);
            setError(null);
            // If we were sending and assistant responded, stop polling
            if (sendingRef.current && msgs.length > 0) {
                const lastMsg = msgs[msgs.length - 1];
                if (lastMsg.role === "assistant") {
                    setSending(false);
                    stopPolling();
                }
            }
        } catch (e) {
            if (!silent) setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (!silent) setLoading(false);
        }
    }, [sessionKey]);

    // Polling helpers
    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const startPolling = useCallback(() => {
        stopPolling();
        pollRef.current = setInterval(() => {
            loadHistory(true);
        }, 2000);
    }, [loadHistory, stopPolling]);

    // Load history on session change
    useEffect(() => {
        if (sessionKey) {
            loadHistory();
        } else {
            setMessages([]);
        }
        return stopPolling;
    }, [sessionKey]);

    // Scroll to bottom when messages change
    useEffect(() => {
        scrollToBottom();
    }, [messages, scrollToBottom]);

    // Focus input on mount
    useEffect(() => {
        inputRef.current?.focus();
    }, [sessionKey]);

    // Send message handler
    const handleSend = useCallback(async () => {
        const text = input.trim();
        if (!text || !sessionKey || sending) return;

        setInput("");
        setSending(true);
        setError(null);

        // Optimistic: add user message locally
        const optimisticMsg: ChatMessage = {
            role: "user",
            content: text,
            timestamp: Date.now() / 1000
        };
        setMessages(prev => [...prev, optimisticMsg]);

        try {
            await sendChatMessage(sessionKey, text);
            // Start polling for the assistant response
            startPolling();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setSending(false);
        }
    }, [input, sessionKey, sending, startPolling]);

    // Abort handler
    const handleAbort = useCallback(async () => {
        if (!sessionKey) return;
        try {
            await abortChat(sessionKey);
        } catch {
            // Best-effort
        }
        setSending(false);
        stopPolling();
        // Reload to get the final state
        loadHistory(true);
    }, [sessionKey, stopPolling, loadHistory]);

    // Key handler for textarea
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    // Auto-resize textarea
    const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        const el = e.target;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }, []);

    if (!sessionKey) {
        return (
            <div className={cl("chat-empty")}>
                <div className={cl("chat-empty-icon")}>💬</div>
                <div className={cl("chat-empty-text")}>Select a session to start chatting</div>
            </div>
        );
    }

    return (
        <div className={cl("chat-container")}>
            {/* Message list */}
            <div className={cl("chat-messages")} ref={scrollRef}>
                {loading && messages.length === 0 ? (
                    <div className={cl("chat-loading")}>Loading conversation...</div>
                ) : messages.length === 0 ? (
                    <div className={cl("chat-empty-conversation")}>
                        <div className={cl("chat-empty-sparkle")}>✦</div>
                        <div className={cl("chat-empty-heading")}>Start a conversation</div>
                        <div className={cl("chat-empty-sub")}>Messages are sent directly through OpenClaw — not Discord.</div>
                    </div>
                ) : (
                    messages.map((msg, i) => (
                        <ChatBubble key={`${msg.messageId ?? msg.timestamp ?? "x"}-${i}`} msg={msg} />
                    ))
                )}
                {sending && <SpinnerDots />}
            </div>

            {/* Error banner */}
            {error && (
                <div className={cl("chat-error")}>
                    {error}
                    <button className={cl("chat-error-dismiss")} onClick={() => setError(null)}>×</button>
                </div>
            )}

            {/* Input area */}
            <div className={cl("chat-input-area")}>
                <textarea
                    ref={inputRef}
                    className={cl("chat-input")}
                    value={input}
                    onChange={handleInput}
                    onKeyDown={handleKeyDown}
                    placeholder="Message OpenClaw..."
                    rows={1}
                    disabled={sending}
                />
                {sending ? (
                    <button
                        className={cl("chat-send-btn", "chat-stop-btn")}
                        onClick={handleAbort}
                        aria-label="Stop"
                        title="Stop generation"
                    >
                        <StopIcon />
                    </button>
                ) : (
                    <button
                        className={cl("chat-send-btn")}
                        onClick={handleSend}
                        disabled={!input.trim()}
                        aria-label="Send"
                        title="Send message"
                    >
                        <SendIcon />
                    </button>
                )}
            </div>
        </div>
    );
}
