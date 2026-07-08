/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { exec } from "node:child_process";

import { IpcMainInvokeEvent } from "electron";

// We execute commands against openclaw using the absolute node path
const OPENCLAW_CLI_CMD = "/home/linuxbrew/.linuxbrew/opt/node/bin/node /home/ryan/.npm-global/lib/node_modules/openclaw/dist/index.js";

// Chat history can return large transcripts, so bump the buffer.
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

function runCliCommand(subCommand: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(`${OPENCLAW_CLI_CMD} ${subCommand}`, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || stdout || error.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

export async function request(
    _: IpcMainInvokeEvent,
    path: string,
    options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        gatewayUrl?: string;
    }
): Promise<any> {
    try {
        if (path === "/api/sessions") {
            const resText = await runCliCommand("gateway call sessions.list --params '{\"includeDerivedTitles\":true,\"includeLastMessage\":true}' --json");
            const result = JSON.parse(resText);
            return result.sessions || [];
        }

        if (path === "/api/status") {
            const resText = await runCliCommand("gateway call sessions.list --params '{\"includeDerivedTitles\":true,\"includeLastMessage\":true}' --json");
            const result = JSON.parse(resText);
            const sessions = result.sessions || [];
            const latestSession = sessions[0];
            if (!latestSession) {
                return null;
            }

            return {
                model: latestSession.model,
                sessionId: latestSession.sessionId,
                key: latestSession.key,
                sessionKey: latestSession.key,
                usedTokens: latestSession.totalTokens || 0,
                totalTokens: latestSession.totalTokens || 0,
                tokens: latestSession.totalTokens || 0,
                maxTokens: latestSession.contextTokens || 0,
                contextWindow: latestSession.contextTokens || 0,
                maxContextTokens: latestSession.contextTokens || 0,
                contextTokens: undefined
            };
        }

        if (path === "/api/usage") {
            // `status --usage` returns the provider quota snapshot OpenClaw keeps
            // refreshed on its heartbeat — i.e. the same numbers as Claude's `/usage`
            // (5h session window + weekly limit), already normalized per provider.
            const resText = await runCliCommand("status --usage --json");
            const result = JSON.parse(resText);
            return result.usage ?? null;
        }

        if (path === "/api/sessions/messages") {
            // Full transcript for one session, by its key. `sessions.get` returns
            // { messages: [{ role, content, timestamp }] } — user content is a string,
            // assistant content is Claude-style [{ type:"text", text }] blocks.
            let key: string | undefined;
            try {
                key = options?.body ? JSON.parse(options.body).key : undefined;
            } catch {
                key = undefined;
            }
            if (!key) return [];

            const safeParams = JSON.stringify({ key }).replace(/'/g, "'\\''");
            const resText = await runCliCommand(`gateway call sessions.get --params '${safeParams}' --json`);
            const result = JSON.parse(resText);
            return result.messages || [];
        }

        if (path === "/api/sessions/current/reset") {
            // Reset a specific session if the caller passed a key; otherwise fall back
            // to the most-recently-updated session.
            let keyToReset: string | undefined;
            try {
                keyToReset = options?.body ? JSON.parse(options.body).key : undefined;
            } catch {
                keyToReset = undefined;
            }
            if (!keyToReset) {
                const listText = await runCliCommand("gateway call sessions.list --json");
                const listResult = JSON.parse(listText);
                keyToReset = listResult.sessions?.[0]?.key || "agent:elevated:main";
            }

            const paramsJson = JSON.stringify({ key: keyToReset, reason: "reset" });
            const safeParams = paramsJson.replace(/'/g, "'\\''");

            const resText = await runCliCommand(`gateway call sessions.reset --params '${safeParams}' --json`);
            return JSON.parse(resText);
        }

        // ── Chat API ──────────────────────────────────────────────────────
        // Display-normalized transcript via gateway call chat.history.
        if (path === "/api/chat/history") {
            let sessionKey: string | undefined;
            try {
                sessionKey = options?.body ? JSON.parse(options.body).sessionKey : undefined;
            } catch {
                sessionKey = undefined;
            }
            if (!sessionKey) return { messages: [] };

            const safeParams = JSON.stringify({ sessionKey }).replace(/'/g, "'\\''");
            const resText = await runCliCommand(`gateway call chat.history --params '${safeParams}' --json --timeout 15000`);
            return JSON.parse(resText);
        }

        // Non-blocking send: fires the message and returns { runId, status }.
        if (path === "/api/chat/send") {
            let sessionKey: string | undefined;
            let message: string | undefined;
            try {
                const body = options?.body ? JSON.parse(options.body) : {};
                sessionKey = body.sessionKey;
                message = body.message;
            } catch {
                sessionKey = undefined;
                message = undefined;
            }
            if (!sessionKey || !message) throw new Error("sessionKey and message are required");

            const idempotencyKey = `vencord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const safeParams = JSON.stringify({ sessionKey, message, idempotencyKey }).replace(/'/g, "'\\''");
            const resText = await runCliCommand(`gateway call chat.send --params '${safeParams}' --json --timeout 15000`);
            return JSON.parse(resText);
        }

        // Abort all active runs for a session.
        if (path === "/api/chat/abort") {
            let sessionKey: string | undefined;
            try {
                sessionKey = options?.body ? JSON.parse(options.body).sessionKey : undefined;
            } catch {
                sessionKey = undefined;
            }
            if (!sessionKey) throw new Error("sessionKey is required");

            const safeParams = JSON.stringify({ sessionKey }).replace(/'/g, "'\\''");
            const resText = await runCliCommand(`gateway call chat.abort --params '${safeParams}' --json --timeout 10000`);
            return JSON.parse(resText);
        }

        if (path === "/api/models/list") {
            const resText = await runCliCommand("gateway call models.list --params '{}' --json");
            return JSON.parse(resText);
        }

        if (path === "/api/sessions/patch") {
            let key: string | undefined;
            let model: string | undefined;
            try {
                const body = options?.body ? JSON.parse(options.body) : {};
                key = body.key;
                model = body.model;
            } catch {
                key = undefined;
                model = undefined;
            }
            if (!key || !model) throw new Error("key and model are required");

            const safeParams = JSON.stringify({ key, model }).replace(/'/g, "'\\\''");
            const resText = await runCliCommand(`gateway call sessions.patch --params '${safeParams}' --json`);
            return JSON.parse(resText);
        }

        // Generic proxy fetch fallback
        const gatewayUrl = options?.gatewayUrl || "http://127.0.0.1:18789";
        const targetUrl = path.startsWith("http") ? path : `${gatewayUrl}${path}`;
        const res = await fetch(targetUrl, {
            method: options?.method || "GET",
            headers: options?.headers,
            body: options?.body
        });
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    } catch (err: any) {
        throw new Error(err.message || String(err));
    }
}
