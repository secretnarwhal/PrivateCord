/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    bumpNick,
    byteLength,
    formatMessage,
    IrcMessage,
    parseMessage,
    splitForSend,
    splitFrame } from "./protocol";

/**
 * IRC over WebSocket. Deliberately takes its whole configuration as an
 * argument rather than importing the plugin settings, both to keep it out of
 * the settings import cycle and so the handshake logic stays testable.
 */

export type ConnectionStatus =
    | "disconnected"
    | "connecting"
    | "registering"
    | "connected"
    | "reconnecting";

export interface IrcConfig {
    /** Full ws:// or wss:// URL of the IRC websocket listener. */
    url: string;
    nick: string;
    username: string;
    realname: string;
    channel: string;
    channelKey?: string;
    serverPassword?: string;
    saslUsername?: string;
    saslPassword?: string;
    /**
     * WebSocket subprotocol. Ergo and UnrealIRCd negotiate "text.ircv3.net";
     * if the first connection never opens we retry once without it, since a
     * plain websocket gateway will reject an unknown subprotocol outright.
     */
    subprotocol?: string;
}

export interface IrcHandlers {
    onStatus(status: ConnectionStatus, detail?: string): void;
    onMessage(msg: IrcMessage): void;
    /** Fatal or user-visible problems. `fatal` means we gave up reconnecting. */
    onError(text: string, fatal: boolean): void;
    /** Our nick changed (initial registration, collision fallback, or /nick). */
    onNick(nick: string): void;
}

const DEFAULT_SUBPROTOCOL = "text.ircv3.net";

/** Capabilities worth having if the server offers them. */
const WANTED_CAPS = [
    "server-time",
    "message-tags",
    "multi-prefix",
    "account-notify",
    "extended-join",
    "away-notify",
    "chghost",
    "echo-message"
];

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

// Outbound token bucket. Servers throttle or disconnect on burst, so we allow a
// short burst for natural typing and then settle into a steady drip.
const BUCKET_CAPACITY = 5;
const BUCKET_REFILL_MS = 1200;

// If the server goes silent for this long we assume the socket is a zombie —
// TCP can keep a dead connection "open" indefinitely behind a NAT.
const LIVENESS_TIMEOUT_MS = 240_000;
const LIVENESS_CHECK_MS = 30_000;

/**
 * Strip CR/LF before a line goes on the wire.
 *
 * The IRCv3 WebSocket spec is explicit that a frame "MUST consist of a single
 * IRC line, except that servers and clients MUST NOT include trailing \r or \n
 * characters" — Ergo enforces this by closing the connection outright.
 *
 * This is also the guard against command injection: over a raw TCP transport an
 * embedded newline would end the current command and start a new one, so any
 * user-controlled text reaching /raw or a multi-line paste could smuggle
 * arbitrary IRC commands.
 */
function sanitizeLine(line: string): string {
    return line.replace(/[\r\n]+/g, " ");
}

function base64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export class IrcConnection {
    private ws: WebSocket | null = null;

    private status: ConnectionStatus = "disconnected";
    private registered = false;

    /** Set by disconnect() so socket teardown doesn't schedule a reconnect. */
    private intentionalClose = false;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** True once a socket has reached onopen at least once for this config. */
    private everOpened = false;
    private useSubprotocol = true;

    private nickAttempt = 0;
    private currentNick: string;

    private availableCaps = new Set<string>();
    private pendingCaps = 0;
    private capNegotiating = false;
    private saslInProgress = false;

    private sendQueue: string[] = [];
    private tokens = BUCKET_CAPACITY;
    private lastRefill = Date.now();
    private drainTimer: ReturnType<typeof setTimeout> | null = null;

    private lastInboundAt = 0;
    private livenessTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private config: IrcConfig,
        private readonly handlers: IrcHandlers
    ) {
        this.currentNick = config.nick;
    }

    // ── Public API ───────────────────────────────────────────────────────

    getStatus(): ConnectionStatus {
        return this.status;
    }

    getNick(): string {
        return this.currentNick;
    }

    isRegistered(): boolean {
        return this.registered;
    }

    connect(): void {
        if (this.ws) return;

        this.intentionalClose = false;
        this.clearReconnectTimer();
        this.openSocket();
    }

    disconnect(reason = "Leaving"): void {
        this.intentionalClose = true;
        this.clearReconnectTimer();
        this.stopLivenessCheck();

        if (this.ws?.readyState === WebSocket.OPEN) {
            // Best-effort QUIT so other clients see a clean part rather than a
            // ping timeout a couple of minutes later.
            try {
                this.ws.send(sanitizeLine(formatMessage("QUIT", reason)));
            } catch {
                // Socket died mid-write; the close below still cleans up.
            }
        }

        this.teardownSocket();
        this.setStatus("disconnected");
    }

    /** Replace the config. Reconnects if we were connected. */
    reconfigure(config: IrcConfig): void {
        const wasActive = this.ws !== null;

        this.config = config;
        this.currentNick = config.nick;
        this.nickAttempt = 0;
        this.everOpened = false;
        this.useSubprotocol = true;

        if (wasActive) {
            this.disconnect("Reconnecting");
            this.connect();
        }
    }

    /** Queue a raw line (no CRLF). */
    sendRaw(line: string): void {
        this.sendQueue.push(line);
        this.scheduleDrain();
    }

    /**
     * Send chat text to a target, splitting to fit the line budget. Returns the
     * chunks actually sent so the caller can render them locally when the
     * server doesn't support echo-message.
     */
    sendPrivmsg(target: string, text: string): string[] {
        // The server rebroadcasts our line with ":nick!user@host " prepended,
        // which counts against the recipient's 512 bytes — so budget for it.
        const prefixOverhead = byteLength(`:${this.currentNick}!${this.config.username}@`) + 64;
        const commandOverhead = byteLength(`PRIVMSG ${target} :`) + 2;

        // IRC has no multi-line message, so a Shift+Enter paste becomes one
        // PRIVMSG per line. Splitting here rather than letting sanitizeLine
        // flatten it to spaces preserves what the user actually typed.
        const chunks = text
            .split(/\r\n|\r|\n/)
            .filter(line => line.length > 0)
            .flatMap(line => splitForSend(line, prefixOverhead + commandOverhead));

        for (const chunk of chunks) {
            this.sendRaw(formatMessage("PRIVMSG", target, chunk));
        }
        return chunks;
    }

    hasCap(cap: string): boolean {
        return this.availableCaps.has(cap);
    }

    // ── Socket lifecycle ─────────────────────────────────────────────────

    private openSocket(): void {
        this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
        this.registered = false;
        this.availableCaps.clear();
        this.saslInProgress = false;
        this.sendQueue = [];

        let ws: WebSocket;
        try {
            ws = this.useSubprotocol
                ? new WebSocket(this.config.url, this.config.subprotocol ?? DEFAULT_SUBPROTOCOL)
                : new WebSocket(this.config.url);
        } catch (e) {
            // Malformed URL, or CSP rejected the connection outright.
            this.handlers.onError(
                `Could not open ${this.config.url}: ${e instanceof Error ? e.message : String(e)}`,
                true
            );
            this.setStatus("disconnected");
            return;
        }

        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws) return;
            this.everOpened = true;
            this.reconnectAttempt = 0;
            this.lastInboundAt = Date.now();
            this.startLivenessCheck();
            this.beginRegistration();
        };

        ws.onmessage = event => {
            if (this.ws !== ws) return;
            this.lastInboundAt = Date.now();

            const data = typeof event.data === "string" ? event.data : "";
            for (const line of splitFrame(data)) {
                const msg = parseMessage(line);
                if (msg) this.handleMessage(msg);
            }
        };

        ws.onerror = () => {
            // The error event carries no useful detail in browsers; onclose
            // follows immediately and is where we actually react.
        };

        ws.onclose = event => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.stopLivenessCheck();

            if (this.intentionalClose) return;

            // A socket that never opened while using a subprotocol usually
            // means the server rejected the subprotocol during the handshake.
            if (!this.everOpened && this.useSubprotocol) {
                this.useSubprotocol = false;
                this.openSocket();
                return;
            }

            this.setStatus("reconnecting");
            this.scheduleReconnect(event.reason || `connection closed (${event.code})`);
        };
    }

    private teardownSocket(): void {
        const { ws } = this;
        this.ws = null;

        if (!ws) return;

        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;

        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            try {
                ws.close();
            } catch {
                // Already closing.
            }
        }

        if (this.drainTimer) {
            clearTimeout(this.drainTimer);
            this.drainTimer = null;
        }
        this.sendQueue = [];
    }

    private scheduleReconnect(reason: string): void {
        this.clearReconnectTimer();

        const backoff = Math.min(
            RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
            RECONNECT_MAX_MS
        );
        // Jitter so every client on the server doesn't retry in lockstep after
        // a restart and immediately re-flood it.
        const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));

        this.reconnectAttempt++;
        this.handlers.onStatus("reconnecting", `${reason} — retrying in ${Math.round(delay / 1000)}s`);

        // A socket that has never once opened is a different problem from one
        // that dropped. Browsers deliberately give JS no detail about a failed
        // TLS handshake — an expired certificate looks identical to the host
        // being down (close code 1006, empty reason) — so say so explicitly
        // rather than letting the user watch it retry forever.
        if (!this.everOpened && this.reconnectAttempt === 3) {
            this.handlers.onError(
                `Could not reach ${this.config.url}. The server may be down, or its TLS ` +
                "certificate may have expired — the browser does not tell us which. " +
                "Check the server before changing any settings here.",
                false
            );
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.intentionalClose) this.openSocket();
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private startLivenessCheck(): void {
        this.stopLivenessCheck();
        this.livenessTimer = setInterval(() => {
            const silence = Date.now() - this.lastInboundAt;
            if (silence < LIVENESS_TIMEOUT_MS) return;

            // Force the close path rather than waiting on the OS: a NAT that
            // dropped the mapping leaves readyState OPEN forever.
            this.stopLivenessCheck();
            const { ws } = this;
            this.ws = null;
            try {
                ws?.close();
            } catch {
                // Ignore.
            }
            this.setStatus("reconnecting");
            this.scheduleReconnect("no response from server");
        }, LIVENESS_CHECK_MS);
    }

    private stopLivenessCheck(): void {
        if (this.livenessTimer) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = null;
        }
    }

    // ── Outbound queue ───────────────────────────────────────────────────

    private scheduleDrain(): void {
        if (this.drainTimer || !this.sendQueue.length) return;
        this.drainTimer = setTimeout(() => {
            this.drainTimer = null;
            this.drain();
        }, 0);
    }

    private drain(): void {
        const now = Date.now();
        const refilled = Math.floor((now - this.lastRefill) / BUCKET_REFILL_MS);
        if (refilled > 0) {
            this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + refilled);
            this.lastRefill = now;
        }

        while (this.sendQueue.length && this.tokens > 0) {
            if (this.ws?.readyState !== WebSocket.OPEN) return;

            const line = this.sendQueue.shift()!;
            this.tokens--;
            try {
                this.ws.send(sanitizeLine(line));
            } catch {
                // Put it back; the reconnect path will retry once we're up.
                this.sendQueue.unshift(line);
                return;
            }
        }

        if (this.sendQueue.length) {
            this.drainTimer = setTimeout(() => {
                this.drainTimer = null;
                this.drain();
            }, BUCKET_REFILL_MS);
        }
    }

    /** Bypass the queue — for handshake traffic, which must not be delayed. */
    private sendImmediate(line: string): void {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(sanitizeLine(line));
        } catch {
            // The close handler will pick this up.
        }
    }

    private setStatus(status: ConnectionStatus, detail?: string): void {
        if (this.status === status && !detail) return;
        this.status = status;
        this.handlers.onStatus(status, detail);
    }

    // ── Registration ─────────────────────────────────────────────────────

    private beginRegistration(): void {
        this.setStatus("registering");
        this.capNegotiating = true;

        // CAP first so the server holds registration open while we negotiate.
        this.sendImmediate(formatMessage("CAP", "LS", "302"));

        // PASS must precede NICK/USER or the server ignores it.
        if (this.config.serverPassword) {
            this.sendImmediate(formatMessage("PASS", this.config.serverPassword));
        }

        this.sendImmediate(formatMessage("NICK", this.currentNick));
        this.sendImmediate(formatMessage("USER", this.config.username, "0", "*", this.config.realname));
    }

    private handleCapLs(msg: IrcMessage): void {
        // :server CAP * LS [*] :cap1 cap2 ...
        // The optional "*" third param marks a continuation line.
        const isMultiline = msg.params[2] === "*";
        const capList = msg.params[isMultiline ? 3 : 2] ?? "";

        for (const entry of capList.split(" ")) {
            if (!entry) continue;
            // Caps may carry values, e.g. "sasl=PLAIN,EXTERNAL".
            this.availableCaps.add(entry.split("=")[0]);
        }

        if (isMultiline) return;

        const wanted = WANTED_CAPS.filter(cap => this.availableCaps.has(cap));

        const useSasl =
            this.availableCaps.has("sasl") &&
            !!this.config.saslUsername &&
            !!this.config.saslPassword;

        if (useSasl) wanted.push("sasl");

        if (!wanted.length) {
            this.endCapNegotiation();
            return;
        }

        this.pendingCaps = 1;
        this.sendImmediate(formatMessage("CAP", "REQ", wanted.join(" ")));
    }

    private handleCapAck(msg: IrcMessage): void {
        const acked = (msg.params[2] ?? "").split(" ").filter(Boolean);

        // Narrow availableCaps to what was actually granted, so hasCap()
        // reflects reality rather than what the server merely advertised.
        const ackedSet = new Set(acked);
        for (const cap of this.availableCaps) {
            if (!ackedSet.has(cap)) this.availableCaps.delete(cap);
        }

        this.pendingCaps = 0;

        if (ackedSet.has("sasl") && this.config.saslUsername && this.config.saslPassword) {
            this.saslInProgress = true;
            this.sendImmediate(formatMessage("AUTHENTICATE", "PLAIN"));
            return;
        }

        this.endCapNegotiation();
    }

    private handleAuthenticate(msg: IrcMessage): void {
        if (msg.params[0] !== "+") return;

        const { saslUsername = "", saslPassword = "" } = this.config;
        const payload = base64(`${saslUsername}\0${saslUsername}\0${saslPassword}`);

        // SASL payloads are sent in 400-char chunks; anything shorter than 400
        // signals the end, so an exact multiple needs a trailing "+".
        for (let i = 0; i < payload.length; i += 400) {
            this.sendImmediate(formatMessage("AUTHENTICATE", payload.slice(i, i + 400)));
        }
        if (payload.length % 400 === 0) {
            this.sendImmediate(formatMessage("AUTHENTICATE", "+"));
        }
    }

    private endCapNegotiation(): void {
        if (!this.capNegotiating) return;
        this.capNegotiating = false;
        this.saslInProgress = false;
        this.sendImmediate(formatMessage("CAP", "END"));
    }

    // ── Inbound dispatch ─────────────────────────────────────────────────

    private handleMessage(msg: IrcMessage): void {
        switch (msg.command) {
            case "PING":
                // Must be immediate and must bypass the queue, or the server
                // kills us on ping timeout while we're waiting for a token.
                this.sendImmediate(formatMessage("PONG", msg.params[0] ?? ""));
                break;

            case "CAP": {
                const sub = (msg.params[1] ?? "").toUpperCase();
                if (sub === "LS") this.handleCapLs(msg);
                else if (sub === "ACK") this.handleCapAck(msg);
                else if (sub === "NAK") this.endCapNegotiation();
                break;
            }

            case "AUTHENTICATE":
                this.handleAuthenticate(msg);
                break;

            // RPL_SASLSUCCESS / already-authenticated
            case "903":
            case "907":
                this.endCapNegotiation();
                break;

            // SASL failure modes — continue unauthenticated rather than hang.
            case "902":
            case "904":
            case "905":
            case "906":
                this.handlers.onError(
                    `SASL authentication failed: ${msg.params[msg.params.length - 1] ?? "unknown error"}`,
                    false
                );
                this.endCapNegotiation();
                break;

            // RPL_WELCOME — registration complete, and the only safe point to JOIN.
            case "001":
                this.registered = true;
                this.nickAttempt = 0;
                // The server has the final say on our nick (it may truncate).
                this.currentNick = msg.params[0] ?? this.currentNick;
                this.handlers.onNick(this.currentNick);
                this.setStatus("connected");
                this.joinChannel();
                break;

            // ERR_NICKNAMEINUSE / ERR_ERRONEUSNICKNAME / ERR_NICKCOLLISION
            case "432":
            case "433":
            case "436":
                this.handleNickInUse();
                break;

            case "NICK":
                if (msg.prefix?.nick === this.currentNick) {
                    this.currentNick = msg.params[0] ?? this.currentNick;
                    this.handlers.onNick(this.currentNick);
                }
                break;

            // Join failures (471/473/474/475/477) are handled by the store,
            // which knows enough about the channel's setup to give actionable
            // advice instead of echoing a bare numeric.

            case "ERROR":
                this.handlers.onError(msg.params[0] ?? "Server closed the connection", false);
                break;
        }

        this.handlers.onMessage(msg);
    }

    private handleNickInUse(): void {
        // After registration a rejected nick is just a failed /nick, not a
        // reason to start cycling nicks.
        if (this.registered) {
            this.handlers.onError(`Nick ${this.currentNick} is unavailable`, false);
            return;
        }

        this.nickAttempt++;
        if (this.nickAttempt > 6) {
            this.handlers.onError("Could not find an available nickname", true);
            this.disconnect("No available nick");
            return;
        }

        this.currentNick = bumpNick(this.config.nick, this.nickAttempt);
        this.handlers.onNick(this.currentNick);
        this.sendImmediate(formatMessage("NICK", this.currentNick));
    }

    /**
     * Public so the store can retry after a mid-session account login: on a +R
     * channel the initial JOIN is rejected, and authenticating afterwards makes
     * it succeed without needing a reconnect.
     */
    joinChannel(): void {
        const { channel, channelKey } = this.config;
        if (!channel) return;

        this.sendRaw(
            channelKey
                ? formatMessage("JOIN", channel, channelKey)
                : formatMessage("JOIN", channel)
        );
    }
}
