/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Pure IRC wire-format helpers — RFC 1459/2812 plus the IRCv3 message-tags
 * extension. Deliberately free of I/O so the parsing rules can be reasoned
 * about (and tested) without a socket anywhere near them.
 */

export interface IrcPrefix {
    /** Nick for user prefixes, or the whole thing for server prefixes. */
    nick: string;
    user?: string;
    host?: string;
    /** True when the prefix had no `!user@host`, i.e. it came from the server itself. */
    isServer: boolean;
}

export interface IrcMessage {
    tags: Record<string, string>;
    prefix?: IrcPrefix;
    /** Always upper-cased. Numerics stay as their three-digit string, e.g. "001". */
    command: string;
    params: string[];
    /** The original line, minus the CRLF. Handy for debugging. */
    raw: string;
}

// ── Tag escaping (IRCv3 message-tags §Escaping) ──────────────────────────

const TAG_UNESCAPE: Record<string, string> = {
    ":": ";",
    s: " ",
    "\\": "\\",
    r: "\r",
    n: "\n"
};

function unescapeTagValue(value: string): string {
    let out = "";
    for (let i = 0; i < value.length; i++) {
        if (value[i] !== "\\") {
            out += value[i];
            continue;
        }
        const next = value[++i];
        // A trailing lone backslash is dropped, and an unrecognised escape
        // yields the character itself — both per spec.
        if (next === undefined) break;
        out += TAG_UNESCAPE[next] ?? next;
    }
    return out;
}

function parseTags(segment: string): Record<string, string> {
    const tags: Record<string, string> = {};
    for (const pair of segment.split(";")) {
        if (!pair) continue;
        const eq = pair.indexOf("=");
        if (eq === -1) tags[pair] = "";
        else tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
    }
    return tags;
}

function parsePrefix(segment: string): IrcPrefix {
    const bang = segment.indexOf("!");
    const at = segment.indexOf("@");

    if (bang === -1 && at === -1) {
        return { nick: segment, isServer: true };
    }
    if (bang === -1) {
        return { nick: segment.slice(0, at), host: segment.slice(at + 1), isServer: false };
    }
    return {
        nick: segment.slice(0, bang),
        user: segment.slice(bang + 1, at === -1 ? undefined : at),
        host: at === -1 ? undefined : segment.slice(at + 1),
        isServer: false
    };
}

/**
 * Parse a single IRC line (without its CRLF). Returns null for blank lines,
 * which servers do occasionally emit as filler.
 */
export function parseMessage(line: string): IrcMessage | null {
    const raw = line;
    let rest = line;

    if (!rest.trim()) return null;

    let tags: Record<string, string> = {};
    if (rest.startsWith("@")) {
        const sp = rest.indexOf(" ");
        if (sp === -1) return null;
        tags = parseTags(rest.slice(1, sp));
        rest = rest.slice(sp + 1).replace(/^ +/, "");
    }

    let prefix: IrcPrefix | undefined;
    if (rest.startsWith(":")) {
        const sp = rest.indexOf(" ");
        if (sp === -1) return null;
        prefix = parsePrefix(rest.slice(1, sp));
        rest = rest.slice(sp + 1).replace(/^ +/, "");
    }

    // Everything after " :" is a single trailing param that may contain spaces.
    const params: string[] = [];
    while (rest.length) {
        if (rest.startsWith(":")) {
            params.push(rest.slice(1));
            break;
        }
        const sp = rest.indexOf(" ");
        if (sp === -1) {
            params.push(rest);
            break;
        }
        params.push(rest.slice(0, sp));
        rest = rest.slice(sp + 1).replace(/^ +/, "");
    }

    const command = params.shift();
    if (!command) return null;

    return { tags, prefix, command: command.toUpperCase(), params, raw };
}

/**
 * Build a wire line from a command and params. The final param is sent as a
 * trailing (`:`-prefixed) param when it is empty, contains a space, or starts
 * with a colon — otherwise the server would mis-split it.
 */
export function formatMessage(command: string, ...params: string[]): string {
    const parts = [command];

    params.forEach((param, i) => {
        const isLast = i === params.length - 1;
        if (isLast && (param === "" || param.includes(" ") || param.startsWith(":"))) {
            parts.push(":" + param);
        } else {
            parts.push(param);
        }
    });

    return parts.join(" ");
}

// ── Length limits ────────────────────────────────────────────────────────

/** Classic IRC line budget, including the trailing CRLF. */
export const MAX_LINE_BYTES = 512;

const encoder = new TextEncoder();

export function byteLength(text: string): number {
    return encoder.encode(text).length;
}

/**
 * Split `text` so that each `PRIVMSG <target> :<chunk>` line fits the byte
 * budget. Servers silently truncate over-long lines, which corrupts the tail
 * of a message rather than rejecting it — so we have to do this ourselves.
 *
 * `overheadBytes` accounts for the parts of the line we don't control: the
 * command, the target, and the server re-broadcasting it with our own
 * `:nick!user@host ` prefix attached.
 */
export function splitForSend(text: string, overheadBytes: number): string[] {
    const budget = Math.max(64, MAX_LINE_BYTES - overheadBytes);
    if (byteLength(text) <= budget) return [text];

    const chunks: string[] = [];
    let current = "";

    // Split on word boundaries where possible; fall back to per-character for
    // a single word longer than the budget (URLs, pasted base64, CJK runs).
    for (const word of text.split(" ")) {
        const candidate = current ? current + " " + word : word;

        if (byteLength(candidate) <= budget) {
            current = candidate;
            continue;
        }

        if (current) {
            chunks.push(current);
            current = "";
        }

        if (byteLength(word) <= budget) {
            current = word;
            continue;
        }

        // Character-wise so we never split a multi-byte codepoint in half.
        let piece = "";
        for (const ch of word) {
            if (byteLength(piece + ch) > budget) {
                chunks.push(piece);
                piece = ch;
            } else {
                piece += ch;
            }
        }
        current = piece;
    }

    if (current) chunks.push(current);
    return chunks;
}

// ── Nicks ────────────────────────────────────────────────────────────────

// RFC 2812: letter / digit / special, where special is "[]\`_^{|}". A nick may
// not begin with a digit or a hyphen.
const NICK_ILLEGAL = /[^A-Za-z0-9[\]\\`_^{|}-]/g;
const NICK_BAD_FIRST = /^[^A-Za-z[\]\\`_^{|}]+/;

/** Matches the deployed server's `limits.nicklen`. */
export const DEFAULT_NICK_MAX = 32;

/**
 * Coerce arbitrary text (typically a Discord username) into something the
 * server will accept. Returns "" when nothing usable survives, so callers can
 * fall back to a generated name.
 */
export function sanitizeNick(input: string, maxLength = DEFAULT_NICK_MAX): string {
    return input
        .normalize("NFKD")
        .replace(/\s+/g, "_")
        .replace(NICK_ILLEGAL, "")
        .replace(NICK_BAD_FIRST, "")
        .slice(0, maxLength);
}

/**
 * Derive the next nick to try after ERR_NICKNAMEINUSE. Appends an underscore
 * until we run out of room, then switches to a random numeric suffix so we
 * don't loop forever against a truncating server.
 */
export function bumpNick(nick: string, attempt: number, maxLength = DEFAULT_NICK_MAX): string {
    if (attempt < 3 && nick.length < maxLength) return nick + "_";

    const suffix = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const stem = nick.replace(/[_\d]+$/, "") || "user";
    return stem.slice(0, Math.max(1, maxLength - suffix.length)) + suffix;
}

// ── Display helpers ──────────────────────────────────────────────────────

/**
 * Strip mIRC formatting control codes. We render IRC text as plain text, so
 * these would otherwise show up as invisible garbage or stray digits from
 * colour codes.
 */
export function stripFormatting(text: string): string {
    return text
        // Colour: \x03[fg[,bg]] with 1-2 digits each
        .replace(/\x03\d{0,2}(,\d{1,2})?/g, "")
        // Hex colour: \x04RRGGBB
        .replace(/\x04[0-9A-Fa-f]{6}/g, "")
        // Bold, italic, underline, strikethrough, monospace, reverse, reset
        .replace(/[\x02\x0F\x11\x16\x1D\x1E\x1F]/g, "");
}

export const CTCP = "\x01";

export interface CtcpMessage {
    command: string;
    args: string;
}

/** Detect a CTCP payload (`\x01COMMAND args\x01`), e.g. ACTION for `/me`. */
export function parseCtcp(text: string): CtcpMessage | null {
    if (!text.startsWith(CTCP)) return null;

    const body = text.slice(1).replace(/\x01$/, "");
    const sp = body.indexOf(" ");

    if (sp === -1) return { command: body.toUpperCase(), args: "" };
    return { command: body.slice(0, sp).toUpperCase(), args: body.slice(sp + 1) };
}

export function formatCtcp(command: string, args = ""): string {
    return CTCP + (args ? `${command} ${args}` : command) + CTCP;
}

// ── Channel membership prefixes ──────────────────────────────────────────

/** Status prefixes from RPL_NAMREPLY, highest rank first. */
export const NICK_PREFIXES = "~&@%+";

export interface ParsedMember {
    nick: string;
    /** The single highest-ranking prefix char, or "" for a regular user. */
    prefix: string;
}

export function parseMember(entry: string): ParsedMember {
    let i = 0;
    while (i < entry.length && NICK_PREFIXES.includes(entry[i])) i++;
    return { nick: entry.slice(i), prefix: i > 0 ? entry[0] : "" };
}

/** Sort by channel rank (ops first), then case-insensitively by nick. */
export function compareMembers(a: ParsedMember, b: ParsedMember): number {
    const rankA = a.prefix ? NICK_PREFIXES.indexOf(a.prefix) : NICK_PREFIXES.length;
    const rankB = b.prefix ? NICK_PREFIXES.indexOf(b.prefix) : NICK_PREFIXES.length;
    if (rankA !== rankB) return rankA - rankB;
    return a.nick.toLowerCase().localeCompare(b.nick.toLowerCase());
}

// ── Line buffering ───────────────────────────────────────────────────────

/**
 * Split one WebSocket frame into the IRC lines it carries.
 *
 * Critically, **a frame boundary is a message boundary** on this transport: the
 * IRCv3 WebSocket spec has servers send one complete message per frame with no
 * trailing CRLF. That rules out the usual TCP-style approach of buffering until
 * a terminator arrives — with no terminator to wait for, such a buffer holds
 * every line forever and emits nothing.
 *
 * Splitting on CRLF anyway costs nothing and keeps us working against gateways
 * that coalesce several messages into one frame, or that append the terminator
 * despite the spec. Empty pieces are dropped, so both variants land in the same
 * place.
 */
export function splitFrame(frame: string): string[] {
    return frame.split(/\r\n|\r|\n/).filter(line => line.length > 0);
}
