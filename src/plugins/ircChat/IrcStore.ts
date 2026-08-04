/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useEffect, useReducer, UserStore } from "@webpack/common";

import { ensureCspAllows, logger } from "./csp";
import { ConnectionStatus, IrcConfig, IrcConnection } from "./irc/connection";
import {
    compareMembers,
    formatCtcp,
    formatMessage,
    IrcMessage,
    parseCtcp,
    ParsedMember,
    parseMember,
    sanitizeNick,
    stripFormatting
} from "./irc/protocol";
import { settings } from "./settings";

/**
 * All IRC state lives here, outside React. The panel is portaled and gets
 * unmounted whenever the user closes it — if the connection lived in a
 * component, closing the panel would drop the socket and everyone else in the
 * channel would see a spurious quit.
 */

export type EntryKind =
    | "message"
    | "action"
    | "notice"
    | "private"
    | "system"
    | "join"
    | "part"
    | "error";

export interface ChatEntry {
    id: string;
    kind: EntryKind;
    nick: string;
    text: string;
    timestamp: number;
    self: boolean;
    mention: boolean;
}

/** Bounded so a long-running client can't grow without limit. */
const MAX_ENTRIES = 500;

/** Entry kinds that represent an actual conversation line, as opposed to
 *  system/join/part/notice noise — only these should light up the unread dot. */
const UNREAD_KINDS: ReadonlySet<EntryKind> = new Set(["message", "action", "private"]);

interface IrcState {
    status: ConnectionStatus;
    statusDetail: string;
    entries: ChatEntry[];
    members: ParsedMember[];
    nick: string;
    topic: string;
    channel: string;
    lastError: string;
    /**
     * Registered with the server AND actually in the channel. These are separate
     * states: on a +R channel you connect fine and the JOIN is what fails, so
     * "connected" alone is not enough to let someone type.
     */
    joined: boolean;
    /** A message arrived while the panel was closed and hasn't been seen yet. */
    unread: boolean;
}

const EMPTY_STATE: IrcState = {
    status: "disconnected",
    statusDetail: "",
    entries: [],
    members: [],
    nick: "",
    topic: "",
    channel: "",
    lastError: "",
    joined: false,
    unread: false
};

let state: IrcState = { ...EMPTY_STATE };

const listeners = new Set<() => void>();
let connection: IrcConnection | null = null;

/** Mirrors whether the panel is currently open, kept in sync via setPanelVisible
 *  so addEntry knows whether an incoming message should light up the unread dot. */
let panelVisible = false;

/** Called by the plugin whenever the panel opens or closes. Opening it clears
 *  any pending unread state — everything up to that point counts as seen. */
export function setPanelVisible(open: boolean): void {
    panelVisible = open;
    if (open && state.unread) update({ unread: false });
}

/** Nicks currently in the channel, keyed lowercase for case-insensitive ops. */
let memberMap = new Map<string, ParsedMember>();
/** NAMES arrives in batches; we stage it and swap on ENDOFNAMES to avoid flicker. */
let pendingNames: ParsedMember[] | null = null;

let entrySeq = 0;

/**
 * Set when registration completes; cleared once we see ourselves join. Some
 * join rejections are silent (or use a numeric we don't recognise), so rather
 * than enumerate every server's error codes we just notice that the join never
 * landed and say something useful about it.
 */
/**
 * Credentials from an in-flight /register, held until the server confirms the
 * account exists. Only then are they worth persisting.
 */
let pendingRegistration: { account: string; password: string; } | null = null;

let joinWatchdog: ReturnType<typeof setTimeout> | null = null;
const JOIN_TIMEOUT_MS = 8000;

function clearJoinWatchdog(): void {
    if (joinWatchdog) {
        clearTimeout(joinWatchdog);
        joinWatchdog = null;
    }
}

/** Advice for the most likely reason a join failed, given how the room is set up. */
function explainJoinFailure(detail?: string): void {
    addSystem(
        detail
            ? `Could not join ${state.channel}: ${detail}`
            : `Could not join ${state.channel}.`,
        "error"
    );

    if (!settings.store.saslUsername || !settings.store.saslPassword) {
        addSystem(
            "This channel likely requires a registered account. To create one, send: " +
            "/register <password>  — then put the same name and password in the plugin's " +
            "SASL settings and reconnect.",
            "error"
        );
    } else {
        addSystem(
            "You have SASL credentials set but the join still failed. Check they are " +
            "correct, or ask an operator whether you have been banned.",
            "error"
        );
    }
}

function emit(): void {
    listeners.forEach(l => l());
}

function update(patch: Partial<IrcState>): void {
    state = { ...state, ...patch };
    emit();
}

export function getState(): IrcState {
    return state;
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

/** Subscribe a component to the whole store. */
export function useIrc(): IrcState {
    const [, forceUpdate] = useReducer(x => x + 1, 0);
    useEffect(() => subscribe(forceUpdate), []);
    return state;
}

// ── Entry helpers ────────────────────────────────────────────────────────

function mentionsUs(text: string): boolean {
    if (!settings.store.highlightMentions) return false;
    const { nick } = state;
    if (!nick) return false;

    // Word-boundary match so "bob" doesn't light up on "bobsled". IRC nicks can
    // contain regex metacharacters ([]\^{|}), so the nick must be escaped.
    const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, "i").test(text);
}

function addEntry(entry: Omit<ChatEntry, "id" | "mention"> & { mention?: boolean; }): void {
    const full: ChatEntry = {
        id: `${entry.timestamp}-${entrySeq++}`,
        mention: entry.mention ?? (!entry.self && mentionsUs(entry.text)),
        ...entry
    };

    const entries = state.entries.length >= MAX_ENTRIES
        ? [...state.entries.slice(state.entries.length - MAX_ENTRIES + 1), full]
        : [...state.entries, full];

    const unread = state.unread || (!panelVisible && !full.self && UNREAD_KINDS.has(full.kind));

    update({ entries, unread });
}

function addSystem(text: string, kind: EntryKind = "system"): void {
    addEntry({ kind, nick: "", text, timestamp: Date.now(), self: false, mention: false });
}

/** Prefer the server's own timestamp when the server-time cap is active. */
function timestampOf(msg: IrcMessage): number {
    const tag = msg.tags.time;
    if (tag) {
        const parsed = Date.parse(tag);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return Date.now();
}

// ── Member bookkeeping ───────────────────────────────────────────────────

function syncMembers(): void {
    update({ members: [...memberMap.values()].sort(compareMembers) });
}

function addMember(nick: string, prefix = ""): void {
    memberMap.set(nick.toLowerCase(), { nick, prefix });
    syncMembers();
}

function removeMember(nick: string): void {
    memberMap.delete(nick.toLowerCase());
    syncMembers();
}

function renameMember(from: string, to: string): void {
    const existing = memberMap.get(from.toLowerCase());
    memberMap.delete(from.toLowerCase());
    memberMap.set(to.toLowerCase(), { nick: to, prefix: existing?.prefix ?? "" });
    syncMembers();
}

function isOurChannel(target: string): boolean {
    return target.toLowerCase() === state.channel.toLowerCase();
}

/**
 * Re-attempt the JOIN. On a +R channel the first attempt (right after 001) is
 * rejected, and logging in afterwards makes it succeed — so there is nothing to
 * do but ask again.
 */
function rejoin(explicit = false): void {
    if (!connection || !isConnected()) {
        return addSystem("Not connected.", "error");
    }
    if (state.joined) {
        if (explicit) addSystem(`Already in ${state.channel}.`);
        return;
    }

    clearJoinWatchdog();
    connection.joinChannel();

    // Only re-arm the "it never landed" watchdog for automatic retries; an
    // explicit /join should report its own failure numeric and stop there.
    if (!explicit) {
        joinWatchdog = setTimeout(() => {
            joinWatchdog = null;
            if (!state.joined) explainJoinFailure();
        }, JOIN_TIMEOUT_MS);
    }
}

/**
 * Called once the server confirms we are logged into an account. Persists the
 * credentials from a preceding /register and retries the join, so registering
 * is genuinely one step rather than "register, then go copy two values into
 * settings, then reconnect".
 */
function onLoggedIn(account: string): void {
    if (pendingRegistration) {
        const { password } = pendingRegistration;
        // Prefer the account name the server reports — it may differ in case
        // from the nick we registered under.
        settings.store.saslUsername = account || pendingRegistration.account;
        settings.store.saslPassword = password;
        pendingRegistration = null;

        addSystem(
            `Account "${account}" saved to plugin settings — you'll be logged in ` +
            "automatically from now on."
        );
    }

    // On a normal SASL connect, 900 arrives *before* 001 — there is no session
    // to join with yet, and the handshake will issue the JOIN itself.
    if (isConnected() && !state.joined) rejoin();
}

// ── Config ───────────────────────────────────────────────────────────────

function deriveNick(): string {
    const configured = sanitizeNick(settings.store.nick ?? "");
    if (configured) return configured;

    const user = UserStore?.getCurrentUser?.();
    const fromDiscord = sanitizeNick(user?.username ?? "");
    if (fromDiscord) return fromDiscord;

    return `user${Math.floor(Math.random() * 10000)}`;
}

function buildConfig(): IrcConfig {
    const nick = deriveNick();
    return {
        url: settings.store.serverUrl,
        nick,
        // Ident is cosmetic here; keep it stable and legal rather than echoing
        // the nick, which may contain characters some servers reject in USER.
        username: "vencord",
        realname: "Vencord IrcChat",
        channel: settings.store.channel,
        channelKey: settings.store.channelKey || undefined,
        serverPassword: settings.store.serverPassword || undefined,
        saslUsername: settings.store.saslUsername || undefined,
        saslPassword: settings.store.saslPassword || undefined
    };
}

// ── Connection control ───────────────────────────────────────────────────

export async function connect(): Promise<void> {
    if (connection && state.status !== "disconnected") return;

    const config = buildConfig();

    const allowed = await ensureCspAllows(config.url);
    if (!allowed.ok) {
        update({ status: "disconnected", lastError: allowed.reason });
        addSystem(allowed.reason, "error");
        return;
    }

    memberMap = new Map();
    pendingNames = null;

    clearJoinWatchdog();
    update({
        nick: config.nick,
        channel: config.channel,
        members: [],
        topic: "",
        lastError: "",
        joined: false
    });

    if (connection) {
        connection.reconfigure(config);
    } else {
        connection = new IrcConnection(config, {
            onStatus(status, detail) {
                update({ status, statusDetail: detail ?? "" });
                if (detail) addSystem(detail);

                if (status === "connected") {
                    // Registration succeeded and the JOIN has been queued. If we
                    // never see ourselves in the channel, say why.
                    clearJoinWatchdog();
                    joinWatchdog = setTimeout(() => {
                        joinWatchdog = null;
                        if (!state.joined) explainJoinFailure();
                    }, JOIN_TIMEOUT_MS);
                } else {
                    clearJoinWatchdog();
                    if (state.joined) update({ joined: false });
                }
            },
            onMessage(msg) {
                try {
                    handleMessage(msg);
                } catch (e) {
                    // One malformed line must never break the whole event loop.
                    logger.error("Failed to handle IRC message", msg.raw, e);
                }
            },
            onError(text, fatal) {
                update({ lastError: text });
                addSystem(text, "error");
                if (fatal) update({ status: "disconnected" });
            },
            onNick(nick) {
                update({ nick });
            }
        });
    }

    connection.connect();
}

export function disconnect(): void {
    connection?.disconnect();
    clearJoinWatchdog();
    memberMap = new Map();
    update({ members: [], status: "disconnected", statusDetail: "", joined: false });
}

export function isConnected(): boolean {
    return state.status === "connected";
}

/** Tear everything down — called from the plugin's stop(). */
export function shutdown(): void {
    connection?.disconnect("Plugin disabled");
    connection = null;
    clearJoinWatchdog();
    memberMap = new Map();
    pendingNames = null;
    state = { ...EMPTY_STATE };
    emit();
}

/** Re-read settings and reconnect if the server details actually changed. */
export function applySettings(): void {
    if (!connection) return;
    connection.reconfigure(buildConfig());
}

// ── Sending ──────────────────────────────────────────────────────────────

function echoLocally(kind: EntryKind, text: string): void {
    // With echo-message the server sends our own line back and we'd render it
    // twice, so only echo locally when the cap isn't active.
    if (connection?.hasCap("echo-message")) return;

    addEntry({
        kind,
        nick: state.nick,
        text,
        timestamp: Date.now(),
        self: true,
        mention: false
    });
}

export function sendChat(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
        runCommand(trimmed);
        return;
    }

    if (!connection || !isConnected()) {
        addSystem("Not connected.", "error");
        return;
    }

    if (!state.joined) {
        // Without this the message is queued, silently rejected by the server,
        // and — because echo-message suppresses the local copy — simply vanishes.
        addSystem(`You are not in ${state.channel}, so that was not sent.`, "error");
        return;
    }

    const chunks = connection.sendPrivmsg(state.channel, trimmed);
    for (const chunk of chunks) echoLocally("message", chunk);
}

function runCommand(input: string): void {
    const sp = input.indexOf(" ");
    const command = (sp === -1 ? input.slice(1) : input.slice(1, sp)).toLowerCase();
    const rest = sp === -1 ? "" : input.slice(sp + 1).trim();

    if (!connection || !isConnected()) {
        // /connect and /disconnect are the two that make sense while down.
        if (command === "connect") {
            connect();
            return;
        }
        addSystem("Not connected.", "error");
        return;
    }

    switch (command) {
        case "me":
            if (!rest) return;
            if (!state.joined) {
                return addSystem(`You are not in ${state.channel}.`, "error");
            }
            connection.sendPrivmsg(state.channel, formatCtcp("ACTION", rest));
            echoLocally("action", rest);
            break;

        // Convenience wrapper so the account-creation step is discoverable —
        // the channel requires a registered account, and typing the NickServ
        // incantation from memory is not a reasonable thing to expect.
        case "register": {
            if (!rest) {
                return addSystem(
                    "Usage: /register <password>  — registers your current nick " +
                    `(${state.nick}) as an account and saves it for future connections.`
                );
            }
            // Held until the server confirms, then written to settings so the
            // user never has to copy credentials around by hand.
            pendingRegistration = { account: state.nick, password: rest };
            connection.sendPrivmsg("NickServ", `REGISTER ${rest}`);
            addSystem(`Registering "${state.nick}"…`);
            break;
        }

        case "join":
            rejoin(true);
            break;

        case "nick":
            if (!rest) return addSystem("Usage: /nick <newnick>");
            connection.sendRaw(formatMessage("NICK", sanitizeNick(rest)));
            break;

        case "topic":
            connection.sendRaw(
                rest
                    ? formatMessage("TOPIC", state.channel, rest)
                    : formatMessage("TOPIC", state.channel)
            );
            break;

        case "msg": {
            const targetSp = rest.indexOf(" ");
            if (targetSp === -1) return addSystem("Usage: /msg <nick> <message>");
            const target = rest.slice(0, targetSp);
            const body = rest.slice(targetSp + 1);
            connection.sendPrivmsg(target, body);
            addEntry({
                kind: "private",
                nick: `→ ${target}`,
                text: body,
                timestamp: Date.now(),
                self: true,
                mention: false
            });
            break;
        }

        case "away":
            connection.sendRaw(rest ? formatMessage("AWAY", rest) : formatMessage("AWAY"));
            break;

        case "names":
            connection.sendRaw(formatMessage("NAMES", state.channel));
            break;

        case "raw":
            if (!rest) return addSystem("Usage: /raw <IRC command>");
            connection.sendRaw(rest);
            break;

        case "disconnect":
            disconnect();
            break;

        case "clear":
            update({ entries: [] });
            break;

        default:
            addSystem(`Unknown command: /${command}`);
    }
}

// ── Inbound dispatch ─────────────────────────────────────────────────────

function handleMessage(msg: IrcMessage): void {
    const from = msg.prefix?.nick ?? "";
    const self = from.toLowerCase() === state.nick.toLowerCase();
    const timestamp = timestampOf(msg);

    switch (msg.command) {
        case "PRIVMSG": {
            const [target, body = ""] = msg.params;
            const ctcp = parseCtcp(body);

            if (ctcp) {
                if (ctcp.command === "ACTION") {
                    addEntry({
                        kind: "action",
                        nick: from,
                        text: stripFormatting(ctcp.args),
                        timestamp,
                        self
                    });
                }
                // Other CTCP (VERSION, PING, …) is deliberately ignored — replying
                // leaks client details to anyone who asks.
                return;
            }

            const text = stripFormatting(body);

            if (isOurChannel(target)) {
                addEntry({ kind: "message", nick: from, text, timestamp, self });
            } else if (target.toLowerCase() === state.nick.toLowerCase()) {
                addEntry({ kind: "private", nick: from, text, timestamp, self, mention: true });
            }
            return;
        }

        case "NOTICE": {
            const body = msg.params[1] ?? "";
            // Skip CTCP replies for the same reason we don't answer CTCP.
            if (parseCtcp(body)) return;
            addEntry({
                kind: "notice",
                nick: from || "server",
                text: stripFormatting(body),
                timestamp,
                self
            });

            // Fallback for servers that confirm a NickServ login by notice
            // without also sending RPL_LOGGEDIN. onLoggedIn is idempotent, so
            // it costs nothing when 900 does arrive.
            if (
                pendingRegistration &&
                from.toLowerCase() === "nickserv" &&
                /logged in as|account created|successfully registered/i.test(body)
            ) {
                onLoggedIn(pendingRegistration.account);
            }
            return;
        }

        // RPL_LOGGEDIN — params: [nick, nick!user@host, account, message]
        case "900":
            onLoggedIn(msg.params[2] ?? state.nick);
            return;

        case "JOIN": {
            // With extended-join the params are [channel, account, realname].
            const channel = msg.params[0] ?? "";
            if (!isOurChannel(channel)) return;

            addMember(from);
            if (self) {
                clearJoinWatchdog();
                update({ joined: true });
                addSystem(`Joined ${channel} as ${state.nick}`);
            } else if (settings.store.showJoinLeave) {
                addEntry({ kind: "join", nick: from, text: "joined", timestamp, self: false, mention: false });
            }
            return;
        }

        case "PART": {
            if (!isOurChannel(msg.params[0] ?? "")) return;
            removeMember(from);
            if (self) update({ joined: false });
            if (!self && settings.store.showJoinLeave) {
                addEntry({ kind: "part", nick: from, text: "left", timestamp, self: false, mention: false });
            }
            return;
        }

        case "QUIT": {
            if (!memberMap.has(from.toLowerCase())) return;
            removeMember(from);
            if (settings.store.showJoinLeave) {
                const reason = msg.params[0];
                addEntry({
                    kind: "part",
                    nick: from,
                    text: reason ? `quit (${stripFormatting(reason)})` : "quit",
                    timestamp,
                    self: false,
                    mention: false
                });
            }
            return;
        }

        case "KICK": {
            const [channel, victim, reason] = msg.params;
            if (!isOurChannel(channel)) return;
            removeMember(victim);
            if (victim.toLowerCase() === state.nick.toLowerCase()) {
                update({ joined: false });
            }
            addSystem(
                `${victim} was kicked by ${from}${reason ? ` (${stripFormatting(reason)})` : ""}`
            );
            return;
        }

        // Join rejections. The channel is +R (registered users only), so this is
        // the expected path for anyone without an account — explain it rather
        // than printing a bare numeric.
        case "471": // +l full
        case "473": // +i invite only
        case "474": // +b banned
        case "475": // +k bad key
        case "477": // ERR_NEEDREGGEDNICK — account required
            if (!isOurChannel(msg.params[1] ?? "")) return;
            clearJoinWatchdog();
            update({ joined: false });
            explainJoinFailure(msg.params[msg.params.length - 1]);
            return;

        // ERR_CANNOTSENDTOCHAN / ERR_NOTONCHANNEL. Without these a rejected
        // message disappears without a trace, because echo-message means we
        // never rendered a local copy in the first place.
        case "404":
        case "442":
            if (!isOurChannel(msg.params[1] ?? "")) return;
            update({ joined: false });
            addSystem(
                `Message not delivered: ${msg.params[msg.params.length - 1] ?? "cannot send to channel"}`,
                "error"
            );
            return;

        case "NICK": {
            const next = msg.params[0] ?? "";
            if (!memberMap.has(from.toLowerCase())) return;
            renameMember(from, next);
            addSystem(`${from} is now known as ${next}`);
            return;
        }

        case "MODE":
            // Prefixes (+o/+v) are cheaper to resync than to model, and MODE
            // grammar varies by server. Ask the server for the truth instead.
            if (isOurChannel(msg.params[0] ?? "")) {
                connection?.sendRaw(formatMessage("NAMES", state.channel));
            }
            return;

        case "TOPIC":
            if (!isOurChannel(msg.params[0] ?? "")) return;
            update({ topic: stripFormatting(msg.params[1] ?? "") });
            addSystem(`${from} changed the topic`);
            return;

        // RPL_TOPIC on join
        case "332":
            if (!isOurChannel(msg.params[1] ?? "")) return;
            update({ topic: stripFormatting(msg.params[2] ?? "") });
            return;

        // RPL_NAMREPLY — params: [ourNick, symbol, channel, "nick nick nick"]
        case "353": {
            if (!isOurChannel(msg.params[2] ?? "")) return;
            pendingNames ??= [];
            for (const entry of (msg.params[3] ?? "").split(" ")) {
                if (entry) pendingNames.push(parseMember(entry));
            }
            return;
        }

        // RPL_ENDOFNAMES — swap the staged list in atomically.
        case "366": {
            if (!isOurChannel(msg.params[1] ?? "") || !pendingNames) return;
            memberMap = new Map(pendingNames.map(m => [m.nick.toLowerCase(), m]));
            pendingNames = null;
            syncMembers();
            return;
        }
    }
}
