/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import { ConfirmModal, openModal } from "@webpack/common";

export const logger = new Logger("IrcChat", "#2ecc71");

/**
 * Loopback is already covered by the "127.0.0.1:*" / "localhost:*" entries in
 * CspPolicies (they map to ImageAndCssSrc, which transitively includes
 * connect-src). Those are wildcard keys though, and isDomainAllowed does an
 * exact `CspPolicies[host]` lookup — so we have to recognise them ourselves or
 * we'd prompt for a permission the user already has.
 */
function isLoopback(host: string): boolean {
    const hostname = host.replace(/:\d+$/, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export type CspCheck =
    | { ok: true; }
    | { ok: false; reason: string; needsRestart: boolean; };

/**
 * Ensure the renderer is allowed to open a WebSocket to `url`.
 *
 * The static CspPolicies map lives in the main process and is baked in at
 * build time, so it can't cover a server URL the user typed into settings.
 * Vencord's runtime override flow handles exactly this: it shows a native
 * trust dialog and, if accepted, persists a connect-src rule that takes effect
 * after a restart. Mirrors checkCloudUrlCsp in @api/SettingsSync/cloudSetup.
 */
export async function ensureCspAllows(url: string): Promise<CspCheck> {
    // The browser build isn't subject to the Electron CSP patch.
    if (IS_WEB || typeof VencordNative === "undefined") return { ok: true };

    let host: string;
    try {
        host = new URL(url).host;
    } catch {
        return { ok: false, reason: `"${url}" is not a valid URL`, needsRestart: false };
    }

    if (isLoopback(host)) return { ok: true };

    if (await VencordNative.csp.isDomainAllowed(url, ["connect-src"])) {
        return { ok: true };
    }

    const result = await VencordNative.csp.requestAddOverride(url, ["connect-src"], "IrcChat");

    if (result === "ok") {
        openModal(props => (
            <ConfirmModal
                {...props}
                title="IRC server allowed"
                subtitle={`${host} has been whitelisted. Restart the app for the change to take effect.`}
                confirmText="Restart now"
                cancelText="Later"
                variant="primary"
                onConfirm={relaunch}
            />
        ));
        return { ok: false, reason: `${host} was whitelisted — restart to connect`, needsRestart: true };
    }

    // "conflict" means a rule already exists but doesn't grant connect-src;
    // the user has to clear it from Vencord's settings themselves.
    const reason = {
        cancelled: `Connection to ${host} was denied`,
        unchecked: `Connection to ${host} was not confirmed`,
        invalid: `${host} is not a valid host to whitelist`,
        conflict: `${host} already has a conflicting host-permission rule — remove it in Vencord settings first`
    }[result] ?? `Could not whitelist ${host}`;

    return { ok: false, reason, needsRestart: false };
}
