/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { ExpandableSection } from "@components/ExpandableCard";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingSecondary } from "@components/Heading";
import { DeleteIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Span } from "@components/Span";
import { RenderModalProps } from "@vencord/discord-types";
import {
    ChannelStore,
    Modal,
    openModal,
    SelectedChannelStore,
    showToast,
    TextArea,
    TextInput,
    Toasts,
    useEffect,
    UserStore,
    useState } from "@webpack/common";

import { isGhostMode, pendingDeletionCount, setGhostMode, subscribeDeletionQueue, subscribeGhostMode } from "./ghost";
import {
    getJob,
    getJobs,
    RepeatJob,
    startRepeat,
    stopAllRepeats,
    stopRepeat,
    subscribeRepeats
} from "./repeater";
import { settings } from "./settings";
import { GhostPreset, makeEmptyPreset, MIN_INTERVAL_MS } from "./types";

export function openGhostPanelModal() {
    openModal(modalProps => <GhostPanel modalProps={modalProps} />);
}

/**
 * Plain deep copy, not the settings proxy. Editing writes whole arrays back, so
 * handing out proxies would store proxies-inside-the-store on the next write.
 */
function readPresets(): GhostPreset[] {
    const stored = (settings.store.presets ?? []) as GhostPreset[];
    return stored.map(p => ({ ...p, messages: [...(p.messages ?? [])] }));
}

export function channelLabel(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return `Channel ${channelId}`;
    if (channel.name) return `#${channel.name}`;

    const names = (channel.recipients ?? [])
        .map(id => UserStore.getUser(id)?.username)
        .filter(Boolean);

    return names.length ? `@${names.join(", ")}` : `Channel ${channelId}`;
}

/** Rerenders whenever anything the panel displays changes, including the ticking countdowns. */
function usePanelState() {
    const [, forceUpdate] = useState({});
    const rerender = () => forceUpdate({});

    useEffect(() => subscribeRepeats(rerender), []);
    useEffect(() => subscribeGhostMode(rerender), []);
    useEffect(() => subscribeDeletionQueue(rerender), []);

    // only the "next send in Ns" countdowns need a clock
    const hasJobs = getJobs().length > 0;
    useEffect(() => {
        if (!hasJobs) return;

        const id = setInterval(rerender, 1000);
        return () => clearInterval(id);
    }, [hasJobs]);
}

/**
 * A number field you can actually clear and retype in — the committed value
 * only moves when what's typed parses.
 */
function NumberInput({ value, onChange, min = 0, placeholder }: {
    value: number;
    onChange(value: number): void;
    min?: number;
    placeholder?: string;
}) {
    const [text, setText] = useState(() => String(value));

    return (
        <TextInput
            value={text}
            placeholder={placeholder}
            onChange={(v: string) => {
                setText(v);
                const n = Number(v);
                if (v.trim() !== "" && Number.isFinite(n)) onChange(Math.max(min, Math.floor(n)));
            }}
            onBlur={() => setText(String(value))}
        />
    );
}

interface PresetEditProps {
    preset: GhostPreset;
    onPatch(patch: Partial<GhostPreset>): void;
}

function MessageList({ preset, onPatch }: PresetEditProps) {
    return (
        <Flex flexDirection="column" gap={8}>
            {preset.messages.map((message, i) => (
                <Flex key={i} flexDirection="row" alignItems="flex-start" gap={8}>
                    <div style={{ flexGrow: 1 }}>
                        <TextArea
                            value={message}
                            placeholder="What to send"
                            autosize
                            onChange={(v: string) => onPatch({
                                messages: preset.messages.map((m, j) => j === i ? v : m)
                            })}
                        />
                    </div>
                    <Button
                        variant="dangerSecondary"
                        size="iconOnly"
                        aria-label="Remove message"
                        disabled={preset.messages.length === 1}
                        onClick={() => onPatch({
                            messages: preset.messages.filter((_, j) => j !== i)
                        })}
                    >
                        <DeleteIcon width={16} height={16} />
                    </Button>
                </Flex>
            ))}

            <div>
                <Button
                    variant="secondary"
                    size="small"
                    onClick={() => onPatch({ messages: [...preset.messages, ""] })}
                >
                    Add message
                </Button>
            </div>
        </Flex>
    );
}

function PresetCard({ preset, onPatch, onDuplicate, onDelete }: PresetEditProps & {
    onDuplicate(): void;
    onDelete(): void;
}) {
    const channelId = SelectedChannelStore.getChannelId() ?? "";
    const runningHere = channelId ? getJob(preset.id, channelId) : undefined;

    return (
        <ExpandableSection
            renderContent={() => (
                <Flex flexDirection="column" gap={12}>
                    <section>
                        <HeadingSecondary>Name</HeadingSecondary>
                        <TextInput
                            value={preset.name}
                            placeholder="Preset name"
                            onChange={(v: string) => onPatch({ name: v })}
                        />
                    </section>

                    <section>
                        <HeadingSecondary>Messages</HeadingSecondary>
                        <Paragraph>
                            {preset.messages.filter(m => m.trim() !== "").length > 1
                                ? "Each send picks the next one, so a repeat won't send the same text twice in a row."
                                : "Add more than one to cycle through them."}
                        </Paragraph>
                        <MessageList preset={preset} onPatch={onPatch} />
                    </section>

                    <Flex flexDirection="row" gap={12}>
                        <section style={{ flexGrow: 1 }}>
                            <HeadingSecondary>Every (seconds)</HeadingSecondary>
                            <NumberInput
                                value={Math.round(preset.intervalMs / 1000)}
                                min={Math.ceil(MIN_INTERVAL_MS / 1000)}
                                onChange={n => onPatch({ intervalMs: n * 1000 })}
                            />
                        </section>
                        <section style={{ flexGrow: 1 }}>
                            <HeadingSecondary>Stop after (0 = never)</HeadingSecondary>
                            <NumberInput
                                value={preset.maxSends}
                                onChange={n => onPatch({ maxSends: n })}
                            />
                        </section>
                    </Flex>

                    <div>
                        <FormSwitch
                            title="Ghost these messages"
                            description="Delete every message this preset sends, right after it sends."
                            value={preset.ghost}
                            onChange={v => onPatch({ ghost: v })}
                        />
                        <FormSwitch
                            title="Shuffle"
                            description="Pick a random message each time instead of going in order."
                            value={preset.shuffle}
                            onChange={v => onPatch({ shuffle: v })}
                            hideBorder
                        />
                    </div>

                    <Flex flexDirection="row" gap={8}>
                        {runningHere
                            ? (
                                <Button variant="dangerPrimary" size="small" onClick={() => stopRepeat(runningHere.key)}>
                                    Stop here
                                </Button>
                            )
                            : (
                                <Button
                                    size="small"
                                    disabled={!channelId}
                                    onClick={() => {
                                        const error = startRepeat(preset, channelId);
                                        if (error) showToast(error, Toasts.Type.FAILURE);
                                    }}
                                >
                                    Start in {channelId ? channelLabel(channelId) : "this channel"}
                                </Button>
                            )}

                        <Button
                            variant="secondary"
                            size="small"
                            onClick={onDuplicate}
                        >
                            Duplicate
                        </Button>

                        <Button
                            variant="dangerSecondary"
                            size="small"
                            onClick={onDelete}
                        >
                            Delete preset
                        </Button>
                    </Flex>
                </Flex>
            )}
        >
            <Flex alignItems="center" gap={8}>
                <Span weight="medium">{preset.name || "Unnamed preset"}</Span>
                <Span size="sm" style={{ color: "var(--text-muted)" }}>
                    {preset.messages.filter(m => m.trim() !== "").length} message(s)
                    {" · every "}{Math.round(Math.max(MIN_INTERVAL_MS, preset.intervalMs) / 1000)}s
                    {preset.ghost ? " · ghosted" : ""}
                </Span>
            </Flex>
        </ExpandableSection>
    );
}

function RunningJobRow({ job }: { job: RepeatJob; }) {
    const secondsLeft = Math.max(0, Math.ceil((job.nextAt - Date.now()) / 1000));

    return (
        <Flex flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
            <div>
                <Span weight="medium">{job.presetName}</Span>
                <br />
                <Span size="sm" style={{ color: "var(--text-muted)" }}>
                    {channelLabel(job.channelId)} · sent {job.sent}
                    {job.maxSends > 0 ? `/${job.maxSends}` : ""} · next in {secondsLeft}s
                    {job.ghost ? " · ghosted" : ""}
                </Span>
            </div>
            <Button variant="dangerSecondary" size="small" onClick={() => stopRepeat(job.key)}>Stop</Button>
        </Flex>
    );
}

function GhostPanel({ modalProps }: { modalProps: RenderModalProps; }) {
    usePanelState();

    // The panel edits its own copy and writes through to settings, so what you
    // type is on screen immediately instead of depending on a round trip back
    // out of the settings store.
    const [presets, setPresetsState] = useState<GhostPreset[]>(readPresets);

    function commitPresets(next: GhostPreset[]) {
        setPresetsState(next);
        settings.store.presets = next;
    }

    function patchPreset(id: string, patch: Partial<GhostPreset>) {
        commitPresets(presets.map(p => p.id === id ? { ...p, ...patch } : p));
    }

    const jobs = getJobs();
    const pending = pendingDeletionCount();

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Ghost Messages"
            subtitle="Self-deleting messages and timed repeats."
            actions={[
                {
                    text: "New preset",
                    variant: "primary",
                    onClick: () => commitPresets([...presets, makeEmptyPreset()])
                },
                {
                    text: "Close",
                    variant: "secondary",
                    onClick: modalProps.onClose
                }
            ]}
        >
            <Flex flexDirection="column" gap={16}>
                <section>
                    <FormSwitch
                        title="Ghost mode"
                        description={
                            `Every message you send is deleted ${Math.round((settings.store.deleteDelay || 0) / 100) / 10}s after it lands.` +
                            (pending ? ` ${pending} deletion(s) queued.` : "")
                        }
                        value={isGhostMode()}
                        onChange={setGhostMode}
                        hideBorder
                    />
                </section>

                {jobs.length > 0 && (
                    <section>
                        <Flex alignItems="center" justifyContent="space-between">
                            <HeadingSecondary>Running repeats</HeadingSecondary>
                            <Button variant="dangerSecondary" size="small" onClick={() => stopAllRepeats()}>Stop all</Button>
                        </Flex>
                        <Flex flexDirection="column" gap={8} style={{ marginTop: 8 }}>
                            {jobs.map(job => <RunningJobRow key={job.key} job={job} />)}
                        </Flex>
                    </section>
                )}

                <section>
                    <HeadingSecondary>Presets</HeadingSecondary>
                    {presets.length === 0
                        ? <Paragraph>No presets yet. Use <b>New preset</b> below to make one.</Paragraph>
                        : (
                            <Flex flexDirection="column" gap={8} style={{ marginTop: 8 }}>
                                {presets.map(preset => (
                                    <PresetCard
                                        key={preset.id}
                                        preset={preset}
                                        onPatch={patch => patchPreset(preset.id, patch)}
                                        onDuplicate={() => commitPresets([...presets, {
                                            ...preset,
                                            messages: [...preset.messages],
                                            id: crypto.randomUUID(),
                                            name: `${preset.name} (copy)`
                                        }])}
                                        onDelete={() => {
                                            getJobs()
                                                .filter(j => j.presetId === preset.id)
                                                .forEach(j => stopRepeat(j.key));
                                            commitPresets(presets.filter(p => p.id !== preset.id));
                                        }}
                                    />
                                ))}
                            </Flex>
                        )}
                </section>
            </Flex>
        </Modal>
    );
}
