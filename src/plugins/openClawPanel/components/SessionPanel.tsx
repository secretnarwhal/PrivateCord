/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { useCallback, useEffect, useState } from "@webpack/common";

import { getCurrentSession, loadSessions, loadUsage, setFocusedKey, useOpenClawData } from "../dataStore";
import {
    cl,
    fetchModels,
    formatResetIn,
    formatTimestamp,
    formatTokens,
    getLifetimeTokens,
    getMaxTokens,
    getSessionId,
    getUsedTokens,
    ModelEntry,
    OpenClawSession,
    OpenClawStatus,
    OpenClawUsage,
    OpenClawUsageWindow,
    patchSessionModel,
    resetSession,
    sessionToStatus
} from "../utils";
import { ChatView } from "./ChatView";

// ── Reusable pieces ──────────────────────────────────────────────────────

function StatRow({ label, value }: { label: string; value: string; }) {
    return (
        <div className={cl("stat-row")}>
            <span className={cl("stat-label")}>{label}</span>
            <span className={cl("stat-value")} title={value}>{value}</span>
        </div>
    );
}

function CurrentSessionCard({ status, focused, onClearFocus }: {
    status: OpenClawStatus | null;
    focused: boolean;
    onClearFocus: () => void;
}) {
    const used = getUsedTokens(status);
    const max = getMaxTokens(status);
    const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;

    return (
        <div className={cl("card")}>
            <div className={cl("card-title-row")}>
                <span className={cl("card-title")}>Current Session</span>
                {focused && (
                    <button className={cl("clear-focus")} onClick={onClearFocus} title="Track the latest session instead">
                        focused · use latest
                    </button>
                )}
            </div>

            <StatRow label="Model" value={status?.model ?? "—"} />
            <StatRow label="Session ID" value={getSessionId(status)} />
            <StatRow
                label="Tokens"
                value={max > 0 ? `${formatTokens(used)} / ${formatTokens(max)}` : formatTokens(used)}
            />

            {max > 0 && (
                <div className={cl("token-bar")}>
                    <div
                        className={cl("token-bar-fill")}
                        style={{ width: `${pct}%` }}
                        data-high={pct >= 85 ? "true" : undefined}
                    />
                </div>
            )}
        </div>
    );
}

function LimitBar({ window: w }: { window: OpenClawUsageWindow; }) {
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent ?? 0)));
    const resetIn = formatResetIn(w.resetAt);

    return (
        <div className={cl("limit-row")}>
            <div className={cl("limit-top")}>
                <span className={cl("limit-label")}>{w.label}</span>
                <span className={cl("limit-meta")}>
                    {pct}%{resetIn ? ` · resets in ${resetIn}` : ""}
                </span>
            </div>
            <div className={cl("token-bar")}>
                <div
                    className={cl("token-bar-fill")}
                    style={{ width: `${pct}%` }}
                    data-high={pct >= 85 ? "true" : undefined}
                />
            </div>
        </div>
    );
}

function LimitsCard({ usage, loading, filterProvider }: {
    usage: OpenClawUsage | null;
    loading: boolean;
    filterProvider?: string | null;
}) {
    const allProviders = (usage?.providers ?? []).filter(p => p.windows?.length);

    // Try to show only the selected provider's limits. If that provider has no
    // usage data (e.g. agy-cli models that proxy through anthropic), fall back
    // to showing all available providers so the user still sees something useful.
    let providers = allProviders;
    let showingFallback = false;
    if (filterProvider) {
        const filtered = allProviders.filter(p => p.provider === filterProvider);
        if (filtered.length) {
            providers = filtered;
        } else if (allProviders.length) {
            showingFallback = true;
        }
    }

    if (!providers.length) {
        return (
            <div className={cl("usage")}>
                <div className={cl("section-title", "usage-title")}>Limits</div>
                <div className={cl("muted")}>
                    {loading ? "Loading limits\u2026" : "No limits available"}
                </div>
            </div>
        );
    }

    return (
        <div className={cl("usage")}>
            <div className={cl("section-title", "usage-title")}>
                Limits
                {showingFallback && (
                    <span className={cl("muted")} style={{ fontWeight: 400, textTransform: "none", marginLeft: 6 }}>
                        (from {providers[0]?.displayName ?? providers[0]?.provider})
                    </span>
                )}
            </div>
            {providers.map(p => (
                <div key={p.provider} className={cl("limit-provider")}>
                    {providers.length > 1 && (
                        <div className={cl("limit-provider-name")}>{p.displayName ?? p.provider}</div>
                    )}
                    {p.windows!.map(w => <LimitBar key={w.label} window={w} />)}
                </div>
            ))}
        </div>
    );
}

function UsageCard({ status, sessions }: { status: OpenClawStatus | null; sessions: OpenClawSession[]; }) {
    const used = getUsedTokens(status);
    const max = getMaxTokens(status);
    const lifetime = getLifetimeTokens(sessions);

    return (
        <div className={cl("usage")}>
            <div className={cl("section-title", "usage-title")}>Usage</div>
            <StatRow
                label="Session tokens used"
                value={max > 0 ? `${formatTokens(used)} / ${formatTokens(max)}` : formatTokens(used)}
            />
            <StatRow
                label="Lifetime tokens (all sessions)"
                value={formatTokens(lifetime)}
            />
        </div>
    );
}

function SessionRow({ session, current, onSelect }: {
    session: OpenClawSession;
    current: boolean;
    onSelect: () => void;
}) {
    const title = session.derivedTitle?.trim() || session.key || "Untitled session";
    const preview = session.lastMessagePreview?.trim();

    return (
        <div
            className={cl("session-row", current && "session-row-current")}
            onClick={onSelect}
            title="Click to switch session"
        >
            <div className={cl("session-row-top")}>
                <span className={cl("session-title")} title={title}>
                    {current && <span className={cl("current-dot")} aria-hidden="true" />}
                    {title}
                </span>
                <span className={cl("session-time")}>{formatTimestamp(session.updatedAt)}</span>
            </div>

            {preview && <div className={cl("session-preview")}>{preview}</div>}

            <div className={cl("session-meta")}>
                {session.model && <span className={cl("badge")}>{session.model}</span>}
                {session.totalTokens != null && (
                    <span className={cl("badge")}>{formatTokens(session.totalTokens)} tok</span>
                )}
            </div>
        </div>
    );
}

function CloseIcon() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                fill="currentColor"
                d="M18.4 4 12 10.4 5.6 4 4 5.6 10.4 12 4 18.4 5.6 20 12 13.6 18.4 20 20 18.4 13.6 12 20 5.6 18.4 4Z"
            />
        </svg>
    );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean; }) {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {collapsed ? (
                <path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41Z" />
            ) : (
                <path fill="currentColor" d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41Z" />
            )}
        </svg>
    );
}

// ── Main panel ───────────────────────────────────────────────────────────

export function DockPanel({ onClose }: { onClose: () => void; }) {
    const { sessions, usage, focusedKey, coreLoading, usageLoading, error } = useOpenClawData();
    const [busy, setBusy] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [models, setModels] = useState<ModelEntry[]>([]);
    const [chatVersion, setChatVersion] = useState(0);

    const current = getCurrentSession();
    const status = sessionToStatus(current);

    // Refresh data on open and poll while open
    useEffect(() => {
        loadSessions(true);
        loadUsage(true);
        fetchModels().then(setModels).catch(() => {});
        const core = setInterval(() => loadSessions(true), 60_000);
        const quota = setInterval(() => loadUsage(true), 300_000);
        return () => {
            clearInterval(core);
            clearInterval(quota);
        };
    }, []);

    const onModelChange = useCallback(async (modelId: string) => {
        if (!current?.key) return;
        try {
            await patchSessionModel(current.key, modelId);
            await loadSessions(true);
        } catch (e) {
            console.error("[OpenClawPanel] model patch failed:", e);
        }
    }, [current?.key]);

    const onNewSession = useCallback(async () => {
        setBusy(true);
        try {
            await resetSession(current?.key);
            await loadSessions();
            // Bump the version to force ChatView to remount and reload history
            setChatVersion(v => v + 1);
        } finally {
            setBusy(false);
        }
    }, [current?.key]);

    const onSelectSession = useCallback((key: string) => {
        setFocusedKey(key);
    }, []);

    return (
        <div className={cl("dock")} role="complementary" aria-label="OpenClaw Panel">
            {/* ── Header ── */}
            <div className={cl("dock-header")}>
                <BaseText tag="h2" size="md" weight="semibold">OpenClaw</BaseText>
                <div className={cl("dock-header-session")}>
                    <span className={cl("dock-header-key")} title={current?.key}>
                        {current?.derivedTitle?.trim() || current?.key || "No session"}
                    </span>
                    <select
                        className={cl("model-select")}
                        value={current?.model ?? ""}
                        onChange={e => onModelChange(e.target.value)}
                        title="Change model"
                    >
                        {current?.model && !models.some(m => m.id === current.model) && (
                            <option value={current.model}>{current.model}</option>
                        )}
                        {models.map(m => (
                            <option key={m.id} value={m.id}>
                                {m.label || m.id}
                            </option>
                        ))}
                    </select>
                </div>
                <div className={cl("dock-header-actions")}>
                    <button
                        className={cl("dock-close")}
                        onClick={() => setSidebarCollapsed(c => !c)}
                        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                    >
                        <SidebarToggleIcon collapsed={sidebarCollapsed} />
                    </button>
                    <button
                        className={cl("dock-close")}
                        onClick={onClose}
                        aria-label="Close OpenClaw panel"
                    >
                        <CloseIcon />
                    </button>
                </div>
            </div>

            {/* ── Two-pane body ── */}
            <div className={cl("dock-body")}>
                {/* Chat pane (main) */}
                <div className={cl("chat-pane")}>
                    <ChatView key={`chat-${current?.key ?? "none"}-${chatVersion}`} sessionKey={current?.key ?? null} />
                </div>

                {/* Info sidebar (collapsible) */}
                {!sidebarCollapsed && (
                    <div className={cl("info-sidebar")}>
                        <div className={cl("info-sidebar-scroll")}>
                            <CurrentSessionCard
                                status={status}
                                focused={!!focusedKey}
                                onClearFocus={() => setFocusedKey(null)}
                            />

                            <div className={cl("actions")}>
                                <Button
                                    variant="primary"
                                    size="small"
                                    onClick={onNewSession}
                                    disabled={busy}
                                >
                                    {busy ? "Resetting…" : "New Session"}
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="small"
                                    onClick={() => { loadSessions(); loadUsage(); }}
                                    disabled={coreLoading}
                                >
                                    Refresh
                                </Button>
                            </div>

                            {error && <div className={cl("error")}>Gateway error: {error}</div>}

                            <LimitsCard
                                usage={usage}
                                loading={usageLoading}
                                filterProvider={models.find(m => m.id === current?.model)?.provider ?? null}
                            />

                            <div className={cl("section-title", "mt")}>Recent Sessions</div>

                            <div className={cl("session-list")}>
                                {coreLoading && !sessions.length
                                    ? <div className={cl("muted")}>Loading sessions…</div>
                                    : sessions.length === 0
                                        ? <div className={cl("muted")}>No sessions found.</div>
                                        : sessions.map(s => (
                                            <SessionRow
                                                key={s.key}
                                                session={s}
                                                current={current?.key === s.key}
                                                onSelect={() => onSelectSession(s.key)}
                                            />
                                        ))}
                            </div>

                            <UsageCard status={status} sessions={sessions} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
