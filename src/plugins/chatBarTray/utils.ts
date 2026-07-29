/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Logger } from "@utils/Logger";

export const cl = classNameFactory("vc-cbt-");
export const logger = new Logger("ChatBarTray");

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
