/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { PluginNative } from "@utils/types";

import { settings } from "./settings";

export const cl = classNameFactory("vc-openclaw-");

const IS_DESKTOP = typeof VencordNative !== "undefined";

const Native = IS_DESKTOP
    ? (VencordNative.pluginHelpers.OpenClawPanel as PluginNative<typeof import("./native")> | undefined)
    : null;

/** One entry from `GET /api/sessions`. All fields treated as optional for resilience. */
export interface OpenClawSession {
    key: string;
    sessionId?: string;
    derivedTitle?: string;
    lastMessagePreview?: string;
    updatedAt?: number | string;
    model?: string;
    totalTokens?: number;
    contextTokens?: number;
}

/** One message from `GET /api/sessions/messages` (`sessions.get`). */
export interface OpenClawMessage {
    role: string;
    content: unknown;
    timestamp?: number;
}

/** Shape of `GET /api/status`. Field names are guessed defensively across variants. */
export interface OpenClawStatus {
    model?: string;
    sessionId?: string;
    key?: string;
    sessionKey?: string;
    totalTokens?: number;
    contextTokens?: number;
    usedTokens?: number;
    tokens?: number;
    maxTokens?: number;
    contextWindow?: number;
    maxContextTokens?: number;
}

/** One rolling quota window from `GET /api/usage`, e.g. the "5h" or "Week" limit. */
export interface OpenClawUsageWindow {
    label: string;
    usedPercent?: number;
    resetAt?: number;
}

/** Per-provider usage block. Multiple providers may be present (Claude, etc.). */
export interface OpenClawUsageProvider {
    provider: string;
    displayName?: string;
    windows?: OpenClawUsageWindow[];
}

/** Shape of `GET /api/usage` (OpenClaw `status --usage`). */
export interface OpenClawUsage {
    updatedAt?: number;
    providers?: OpenClawUsageProvider[];
}

const REQUEST_TIMEOUT_MS = 8000;

/** Normalized base URL with any trailing slashes stripped. */
function baseUrl(): string {
    const raw = settings.store.gatewayUrl || "http://127.0.0.1:18789";
    return raw.replace(/\/+$/, "");
}

async function request<T = any>(path: string, init?: RequestInit): Promise<T | null> {
    if (Native) {
        try {
            const body = init?.body ? String(init.body) : undefined;
            const headers = init?.headers ? (init.headers as Record<string, string>) : undefined;
            const res = await Native.request(path, {
                method: init?.method,
                headers,
                body,
                gatewayUrl: baseUrl()
            });
            return res as T;
        } catch (e) {
            console.error("[OpenClawPanel] native request error:", e);
            throw e;
        }
    }

    // On desktop the native helper is the ONLY thing that can talk to the gateway:
    // it shells out to the openclaw CLI from the main process. The renderer-side fetch
    // below can't substitute for it — Discord's CSP blocks requests to 127.0.0.1, and
    // the gateway speaks WebSocket, not HTTP REST, so the fetch always dies as the
    // generic "Failed to fetch". If we're on desktop but the helper is missing, the
    // main process is stale: native modules are wired up once at startup (preload/main),
    // and a renderer reload (Ctrl+R) doesn't re-run them. Say so instead of masking it.
    if (IS_DESKTOP) {
        throw new Error(
            "OpenClaw native bridge unavailable. Fully quit and reopen Discord — a reload (Ctrl+R) re-runs the UI but not the plugin's native module."
        );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(baseUrl() + path, {
            ...init,
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                ...(init?.headers ?? {})
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const text = await res.text();
        return text ? (JSON.parse(text) as T) : null;
    } finally {
        clearTimeout(timer);
    }
}

/** Fetch the recent-session list. Tolerates either a bare array or `{ sessions: [] }`. */
export async function fetchSessions(): Promise<OpenClawSession[]> {
    const data = await request<any>("/api/sessions");
    const list: OpenClawSession[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.sessions)
            ? data.sessions
            : [];

    const limit = Number(settings.store.sessionLimit) || 25;
    return list.slice(0, limit);
}

/** Fetch current session status (model, tokens, id). */
export function fetchStatus(): Promise<OpenClawStatus | null> {
    return request<OpenClawStatus>("/api/status");
}

/** Reset a session (start fresh). Targets `key` if given, else the latest session. */
export async function resetSession(key?: string): Promise<void> {
    await request("/api/sessions/current/reset", {
        method: "POST",
        body: key ? JSON.stringify({ key }) : undefined
    });
}

/** Fetch provider usage/quota snapshots (5h + weekly windows). */
export function fetchUsage(): Promise<OpenClawUsage | null> {
    return request<OpenClawUsage>("/api/usage");
}

/** Fetch the full transcript for one session by key. */
export async function fetchSessionMessages(key: string): Promise<OpenClawMessage[]> {
    const data = await request<any>("/api/sessions/messages", {
        method: "POST",
        body: JSON.stringify({ key })
    });
    return Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
}

/** Flatten a message's content (string, or Claude-style block array) to text. */
export function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map(b => {
                if (typeof b === "string") return b;
                if (b && typeof b === "object") {
                    const block = b as { type?: string; text?: string; };
                    if (typeof block.text === "string") return block.text;
                    if (block.type) return `[${block.type}]`;
                }
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }
    return content == null ? "" : String(content);
}

/** Build a status-shaped view from a session entry (for the Current Session card). */
export function sessionToStatus(session: OpenClawSession | null): OpenClawStatus | null {
    if (!session) return null;
    return {
        model: session.model,
        sessionId: session.sessionId,
        key: session.key,
        usedTokens: session.totalTokens,
        totalTokens: session.totalTokens,
        maxTokens: session.contextTokens,
        contextTokens: undefined
    };
}

export function getSessionId(status: OpenClawStatus | null): string {
    if (!status) return "—";
    return status.sessionId ?? status.key ?? status.sessionKey ?? "—";
}

export function getUsedTokens(status: OpenClawStatus | null): number {
    if (!status) return 0;
    return status.contextTokens ?? status.usedTokens ?? status.tokens ?? status.totalTokens ?? 0;
}

export function getMaxTokens(status: OpenClawStatus | null): number {
    if (!status) return 0;
    return status.maxTokens ?? status.contextWindow ?? status.maxContextTokens ?? 0;
}

/** Lifetime token usage: sum of `totalTokens` across every known session. */
export function getLifetimeTokens(sessions: OpenClawSession[]): number {
    return sessions.reduce((sum, s) => {
        const t = typeof s.totalTokens === "number" && !Number.isNaN(s.totalTokens) ? s.totalTokens : 0;
        return sum + t;
    }, 0);
}

/** Compact token count, e.g. 12345 -> "12.3k". */
export function formatTokens(n: number | undefined | null): string {
    if (n == null || Number.isNaN(n)) return "0";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Coerce a numeric timestamp to milliseconds (values below 1e12 are seconds). */
function toMs(value: number): number {
    return value < 1e12 ? value * 1000 : value;
}

/** Time remaining until a reset timestamp, e.g. "2h 18m", "43m", "now". */
export function formatResetIn(value: number | undefined | null): string {
    if (value == null || Number.isNaN(value)) return "";

    const diff = toMs(value) - Date.now();
    if (diff <= 0) return "now";

    const min = Math.floor(diff / 60_000);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    if (hr < 24) return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
    const day = Math.floor(hr / 24);
    const remHr = hr % 24;
    return remHr ? `${day}d ${remHr}h` : `${day}d`;
}

/** Human-friendly relative timestamp with a locale-string fallback. */
export function formatTimestamp(value: number | string | undefined | null): string {
    if (value == null) return "";

    let ms: number;
    if (typeof value === "number") {
        // Heuristic: values below 1e12 are almost certainly seconds, not ms.
        ms = value < 1e12 ? value * 1000 : value;
    } else {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) return String(value);
        ms = parsed;
    }

    const diff = Date.now() - ms;
    if (diff < 0) return "just now";

    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;

    return new Date(ms).toLocaleDateString();
}

// ── Chat API types & functions ──────────────────────────────────────────

/** One message from the display-normalized `chat.history` transcript. */
export interface ChatMessage {
    id?: string;
    messageId?: string;
    role: string;
    content: unknown;
    timestamp?: number;
    isThinking?: boolean;
}

/** Response shape from `gateway call chat.history`. */
export interface ChatHistoryResponse {
    sessionKey?: string;
    sessionId?: string;
    messages?: ChatMessage[];
    defaults?: {
        model?: string;
        modelProvider?: string;
        contextTokens?: number;
        thinkingDefault?: string;
    };
    sessionInfo?: Record<string, unknown>;
}

/** Response from `gateway call chat.send`. */
export interface ChatSendResponse {
    runId?: string;
    status?: string;
}

/** Fetch the display-normalized chat transcript for a session. */
export async function fetchChatHistory(sessionKey: string): Promise<ChatHistoryResponse> {
    const data = await request<ChatHistoryResponse>("/api/chat/history", {
        method: "POST",
        body: JSON.stringify({ sessionKey })
    });
    return data ?? { messages: [] };
}

/** Send a user message to a session (non-blocking). Returns { runId, status }. */
export async function sendChatMessage(sessionKey: string, message: string): Promise<ChatSendResponse> {
    const data = await request<ChatSendResponse>("/api/chat/send", {
        method: "POST",
        body: JSON.stringify({ sessionKey, message })
    });
    return data ?? {};
}

/** Abort active runs for a session. */
export async function abortChat(sessionKey: string): Promise<void> {
    await request("/api/chat/abort", {
        method: "POST",
        body: JSON.stringify({ sessionKey })
    });
}


// ── Model selection types & functions ───────────────────────────────────

/** One entry from `gateway call models.list`. */
export interface ModelEntry {
    id: string;
    label?: string;
    provider?: string;
}

/** Fetch the list of available models. */
export async function fetchModels(): Promise<ModelEntry[]> {
    const data = await request<any>("/api/models/list");
    return Array.isArray(data?.models) ? data.models : [];
}

/** Patch a session's model selection. */
export async function patchSessionModel(key: string, model: string): Promise<void> {
    await request("/api/sessions/patch", {
        method: "POST",
        body: JSON.stringify({ key, model })
    });
}
