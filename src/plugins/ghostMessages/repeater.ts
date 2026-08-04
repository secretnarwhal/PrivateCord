/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { showToast, Toasts } from "@webpack/common";

import { armGhost, consumeRepeaterSend, disarmGhost, markRepeaterSend } from "./ghost";
import { GhostPreset, MIN_INTERVAL_MS } from "./types";

const logger = new Logger("GhostMessages");

/** Sends that fail in a row before the job gives up (no perms, channel gone, ...). */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface RepeatJob {
    /** `presetId:channelId` — one preset can repeat in several channels at once. */
    key: string;
    presetId: string;
    presetName: string;
    channelId: string;

    messages: string[];
    intervalMs: number;
    ghost: boolean;
    shuffle: boolean;
    maxSends: number;

    index: number;
    sent: number;
    failures: number;
    nextAt: number;
    timer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, RepeatJob>();
const listeners = new Set<() => void>();

function notify() {
    listeners.forEach(l => l());
}

export function subscribeRepeats(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export function jobKey(presetId: string, channelId: string) {
    return `${presetId}:${channelId}`;
}

export function getJobs() {
    return [...jobs.values()];
}

export function getJob(presetId: string, channelId: string) {
    return jobs.get(jobKey(presetId, channelId));
}

/** Returns an error message, or null if the job started. */
export function startRepeat(preset: GhostPreset, channelId: string): string | null {
    if (!channelId) return "No channel to send to.";

    const messages = preset.messages.filter(m => m.trim() !== "");
    if (!messages.length) return `"${preset.name}" has no messages to send.`;

    const key = jobKey(preset.id, channelId);
    if (jobs.has(key)) return `"${preset.name}" is already repeating in that channel.`;

    const job: RepeatJob = {
        key,
        presetId: preset.id,
        presetName: preset.name,
        channelId,
        messages,
        intervalMs: Math.max(MIN_INTERVAL_MS, preset.intervalMs),
        ghost: preset.ghost,
        shuffle: preset.shuffle,
        maxSends: Math.max(0, Math.floor(preset.maxSends) || 0),
        index: 0,
        sent: 0,
        failures: 0,
        nextAt: Date.now(),
        timer: null
    };

    jobs.set(key, job);
    notify();

    void tick(job);
    return null;
}

export function stopRepeat(key: string) {
    const job = jobs.get(key);
    if (!job) return;

    if (job.timer != null) clearTimeout(job.timer);
    jobs.delete(key);
    notify();
}

export function stopRepeatsInChannel(channelId: string) {
    const keys = getJobs().filter(j => j.channelId === channelId).map(j => j.key);
    keys.forEach(stopRepeat);
    return keys.length;
}

export function stopAllRepeats() {
    const count = jobs.size;
    [...jobs.keys()].forEach(stopRepeat);
    return count;
}

function nextContent(job: RepeatJob) {
    if (job.shuffle) return job.messages[Math.floor(Math.random() * job.messages.length)];

    const content = job.messages[job.index % job.messages.length];
    job.index++;
    return content;
}

async function tick(job: RepeatJob) {
    // the job can be stopped while we're waiting out an interval
    if (jobs.get(job.key) !== job) return;

    const content = nextContent(job);

    try {
        if (job.ghost) armGhost(job.channelId, content);
        markRepeaterSend(job.channelId, content);

        const res: any = await sendMessage(job.channelId, { content });
        if (res?.ok === false) throw new Error(`Send failed with status ${res.status}`);

        job.sent++;
        job.failures = 0;
    } catch (e) {
        if (job.ghost) disarmGhost(job.channelId, content);
        // the pre-send listener never ran if the send blew up before it
        consumeRepeaterSend(job.channelId, content);

        job.failures++;
        logger.warn(`Repeat "${job.presetName}" failed to send`, e);

        if (job.failures >= MAX_CONSECUTIVE_FAILURES) {
            stopRepeat(job.key);
            showToast(`Stopped repeating "${job.presetName}" after ${MAX_CONSECUTIVE_FAILURES} failed sends.`, Toasts.Type.FAILURE);
            return;
        }
    }

    // stopped while the send was in flight
    if (jobs.get(job.key) !== job) return;

    if (job.maxSends > 0 && job.sent >= job.maxSends) {
        stopRepeat(job.key);
        showToast(`Finished repeating "${job.presetName}".`, Toasts.Type.SUCCESS);
        return;
    }

    job.nextAt = Date.now() + job.intervalMs;
    job.timer = setTimeout(() => void tick(job), job.intervalMs);
    notify();
}
