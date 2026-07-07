import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { DeleteIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalRoot,
    ModalSize,
    openModal
} from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findComponentByCodeLazy } from "@webpack";
import {
    ChannelStore,
    Forms,
    MessageActions,
    React,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    Text,
    TextInput,
    useEffect,
    useRef,
    useState,
    UserStore
} from "@webpack/common";
import type { PropsWithChildren } from "react";

import managedStyle from "./style.css?managed";

const logger = new Logger("MassDeleter");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

const settings = definePluginSettings({
    defaultSearchDelay: {
        description: "Delay between search requests (ms)",
        type: OptionType.NUMBER,
        default: 30000
    },
    defaultDeleteDelay: {
        description: "Delay between each deletion (ms)",
        type: OptionType.NUMBER,
        default: 1000
    }
});

interface DeleterOptions {
    authorId: string;
    guildId: string;
    channelId: string;
    searchQuery: string;
    includePinned: boolean;
    searchDelay: number;
    deleteDelay: number;
}

// Singleton that persists across modal open/close so deletion continues in the background.
const MassDeleterManager = {
    running: false,
    finished: false,
    progress: { current: 0, total: 0 },
    logs: [] as string[],
    listeners: new Set<() => void>(),

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    },

    notify() {
        this.listeners.forEach(l => l());
    },

    addLog(msg: string) {
        this.logs = [...this.logs.slice(-100), `${new Date().toLocaleTimeString()}: ${msg}`];
        this.notify();
    },

    clearLogs() {
        this.logs = [];
        this.notify();
    },

    stop() {
        this.running = false;
    },

    async start(options: DeleterOptions) {
        if (this.running) return;

        this.running = true;
        this.finished = false;
        this.logs = [];
        this.progress = { current: 0, total: 0 };
        this.notify();
        this.addLog("Starting...");

        const isDM = options.guildId === "@me";
        const searchUrl = isDM
            ? `/channels/${options.channelId}/messages/search`
            : `/guilds/${options.guildId}/messages/search`;

        let offset = 0;
        let delCount = 0;
        let failCount = 0;

        while (this.running) {
            this.addLog(`Searching (offset: ${offset})...`);

            try {
                const res = await RestAPI.get({
                    url: searchUrl,
                    query: {
                        author_id: options.authorId || undefined,
                        // For guild searches, channel_id narrows to a specific channel.
                        // For DM searches the channel is already in the URL.
                        channel_id: !isDM ? (options.channelId || undefined) : undefined,
                        content: options.searchQuery || undefined,
                        include_pinned: options.includePinned,
                        offset,
                        sort_by: "timestamp",
                        sort_order: "desc"
                    }
                });

                if (res.status === 202) {
                    const wait = (res.body?.retry_after ?? 5) * 1000;
                    this.addLog(`Index not ready, retrying in ${wait}ms`);
                    await sleep(wait);
                    continue;
                }

                if (res.status === 429) {
                    const wait = (res.body?.retry_after ?? 5) * 1000;
                    this.addLog(`Search rate limited. Waiting ${wait}ms`);
                    await sleep(wait);
                    continue;
                }

                if (!res.ok) {
                    this.addLog(`Search error: HTTP ${res.status}`);
                    break;
                }

                const grandTotal: number = res.body?.total_results ?? 0;
                const messages: any[] = (res.body?.messages ?? [])
                    .map((group: any[]) => group.find((m: any) => m.hit))
                    .filter(Boolean);

                if (messages.length === 0) {
                    this.addLog("No more messages found.");
                    break;
                }

                this.progress = { current: delCount + failCount, total: grandTotal };
                this.addLog(`Found ${messages.length} messages (${grandTotal} total)`);
                this.notify();

                let batchDeleted = 0;

                for (const msg of messages) {
                    if (!this.running) break;

                    try {
                        await MessageActions.deleteMessage(msg.channel_id, msg.id);
                        delCount++;
                        batchDeleted++;
                        this.addLog(`Deleted ${msg.id}`);
                    } catch (e: any) {
                        if (e?.status === 429) {
                            const wait = (e.body?.retry_after ?? 5) * 1000;
                            this.addLog(`Delete rate limited. Waiting ${wait}ms`);
                            await sleep(wait);
                            // Single retry after rate limit
                            try {
                                await MessageActions.deleteMessage(msg.channel_id, msg.id);
                                delCount++;
                                batchDeleted++;
                                this.addLog(`Deleted ${msg.id} (retry)`);
                            } catch {
                                failCount++;
                                this.addLog(`Failed ${msg.id}`);
                            }
                        } else {
                            failCount++;
                            this.addLog(`Skipped ${msg.id} (${e?.status ?? "error"})`);
                        }
                    }

                    this.progress = { current: delCount + failCount, total: grandTotal };
                    this.notify();
                    await sleep(options.deleteDelay);
                }

                if (!this.running) break;

                // If nothing was deleted this batch (all messages un-deletable), advance
                // offset so we don't loop forever on messages we can't touch.
                if (batchDeleted === 0) {
                    offset += messages.length;
                } else {
                    offset = 0;
                }

                this.addLog(`Waiting ${options.searchDelay}ms before next search...`);
                await sleep(options.searchDelay);

            } catch (e) {
                this.addLog(`Unexpected error: ${e}`);
                break;
            }
        }

        const wasRunning = this.running;
        this.running = false;
        this.finished = wasRunning;
        this.addLog(wasRunning
            ? `Done. Deleted: ${delCount}, Failed: ${failCount}`
            : `Stopped. Deleted: ${delCount}, Failed: ${failCount}`
        );
        this.notify();
    }
};

function sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms));
}

function useManager() {
    const [, forceUpdate] = useState({});
    useEffect(() => MassDeleterManager.subscribe(() => forceUpdate({})), []);
    return MassDeleterManager;
}

function getChannelContext() {
    const channelId = SelectedChannelStore?.getChannelId() ?? "";
    const channel = channelId ? ChannelStore?.getChannel(channelId) : null;
    // Treat both 1:1 DMs and Group DMs as private channels
    const isDM = channel?.type === ChannelType.DM || channel?.type === ChannelType.GROUP_DM;
    const guildId = isDM ? "@me" : (SelectedGuildStore?.getGuildId() ?? "@me");
    return { channelId, guildId };
}

function MassDeleterUI({ transitionState, onClose }: { transitionState: any; onClose(): void; }) {
    const manager = useManager();

    const [form, setForm] = useState<DeleterOptions>(() => {
        const { channelId, guildId } = getChannelContext();
        return {
            authorId: UserStore?.getCurrentUser()?.id ?? "",
            guildId,
            channelId,
            searchQuery: "",
            includePinned: false,
            searchDelay: settings.store.defaultSearchDelay,
            deleteDelay: settings.store.defaultDeleteDelay
        };
    });

    const logsEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [manager.logs]);

    return (
        <ModalRoot transitionState={transitionState} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Flex flexDirection="row" alignItems="center" justifyContent="space-between" style={{ width: "100%" }}>
                    <Text variant="heading-lg/semibold">Mass Deleter</Text>
                    <ModalCloseButton onClick={onClose} />
                </Flex>
            </ModalHeader>

            <ModalContent style={{ padding: "20px" }}>
                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Author ID</Forms.FormTitle>
                    <Flex flexDirection="row" alignItems="center">
                        <TextInput
                            value={form.authorId}
                            onChange={(v: string) => setForm(f => ({ ...f, authorId: v }))}
                            placeholder="User ID whose messages to delete"
                        />
                        <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => setForm(f => ({ ...f, authorId: UserStore?.getCurrentUser()?.id ?? "" }))}
                            style={{ marginLeft: "10px", flexShrink: 0 }}
                        >me</Button>
                    </Flex>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Server ID</Forms.FormTitle>
                    <Flex flexDirection="row" alignItems="center">
                        <TextInput
                            value={form.guildId}
                            onChange={(v: string) => setForm(f => ({ ...f, guildId: v }))}
                            placeholder='Guild ID, or "@me" for DMs'
                        />
                        <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => setForm(f => ({ ...f, guildId: SelectedGuildStore?.getGuildId() ?? "@me" }))}
                            style={{ marginLeft: "10px", flexShrink: 0 }}
                        >current</Button>
                    </Flex>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Channel ID</Forms.FormTitle>
                    <Flex flexDirection="row" alignItems="center">
                        <TextInput
                            value={form.channelId}
                            onChange={(v: string) => setForm(f => ({ ...f, channelId: v }))}
                            placeholder="Channel ID (leave blank to search all channels in a server)"
                        />
                        <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => {
                                const { channelId, guildId } = getChannelContext();
                                setForm(f => ({ ...f, channelId, guildId }));
                            }}
                            style={{ marginLeft: "10px", flexShrink: 0 }}
                        >current</Button>
                    </Flex>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Search Filter</Forms.FormTitle>
                    <TextInput
                        value={form.searchQuery}
                        onChange={(v: string) => setForm(f => ({ ...f, searchQuery: v }))}
                        placeholder="Filter by text content (optional)"
                    />
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <FormSwitch
                        title="Include Pinned Messages"
                        value={form.includePinned}
                        onChange={(v: boolean) => setForm(f => ({ ...f, includePinned: v }))}
                        hideBorder
                    />
                </div>

                <Flex flexDirection="row" style={{ marginBottom: "15px" }}>
                    <div style={{ flex: 1, marginRight: "10px" }}>
                        <Forms.FormTitle tag="h5">Search Delay (ms)</Forms.FormTitle>
                        <TextInput
                            type="number"
                            value={form.searchDelay.toString()}
                            onChange={(v: string) => setForm(f => ({ ...f, searchDelay: parseInt(v) || 0 }))}
                        />
                    </div>
                    <div style={{ flex: 1 }}>
                        <Forms.FormTitle tag="h5">Delete Delay (ms)</Forms.FormTitle>
                        <TextInput
                            type="number"
                            value={form.deleteDelay.toString()}
                            onChange={(v: string) => setForm(f => ({ ...f, deleteDelay: parseInt(v) || 0 }))}
                        />
                    </div>
                </Flex>

                <div style={{
                    backgroundColor: "var(--background-secondary-alt)",
                    padding: "10px",
                    borderRadius: "5px",
                    height: "150px",
                    overflowY: "auto",
                    fontFamily: "monospace",
                    fontSize: "12px",
                    whiteSpace: "pre-wrap"
                }}>
                    {manager.logs.map((log, i) => <div key={i}>{log}</div>)}
                    <div ref={logsEndRef} />
                </div>

                {manager.progress.total > 0 && (
                    <div style={{ marginTop: "10px" }}>
                        <Text variant="text-sm/normal">
                            Progress: {manager.progress.current} / {manager.progress.total}
                        </Text>
                        <div style={{
                            width: "100%",
                            height: "4px",
                            backgroundColor: "var(--background-modifier-accent)",
                            borderRadius: "2px",
                            marginTop: "5px"
                        }}>
                            <div style={{
                                width: `${Math.min((manager.progress.current / manager.progress.total) * 100, 100)}%`,
                                height: "100%",
                                backgroundColor: "var(--brand-experiment)",
                                borderRadius: "2px",
                                transition: "width 0.3s ease"
                            }} />
                        </div>
                    </div>
                )}
            </ModalContent>

            <ModalFooter>
                <Flex flexDirection="row" justifyContent="space-between" style={{ width: "100%" }}>
                    {!manager.running ? (
                        <Button
                            variant="dangerPrimary"
                            disabled={!form.channelId}
                            onClick={() => { manager.start(form); }}
                        >Start Deleting</Button>
                    ) : (
                        <Button
                            variant="secondary"
                            onClick={() => manager.stop()}
                        >Stop</Button>
                    )}
                    <Button
                        variant="none"
                        onClick={() => manager.clearLogs()}
                    >Clear Log</Button>
                </Flex>
            </ModalFooter>
        </ModalRoot>
    );
}

function HeaderIndicator() {
    const manager = useManager();

    return (
        <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <DeleteIcon />
            {manager.running && <div className="vc-mass-deleter-badge vc-mass-deleter-badge-running" />}
            {manager.finished && !manager.running && <div className="vc-mass-deleter-badge vc-mass-deleter-badge-done" />}
        </div>
    );
}

export default definePlugin({
    name: "MassDeleter",
    description: "Delete your messages in bulk from any channel or DM.",
    authors: [],
    tags: ["Utility"],
    settings,
    managedStyle,

    stop() {
        MassDeleterManager.stop();
    },

    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,50}?)\i\.Fragment,(?=\{children:\[)/,
                replace: "$1$self.HeaderWrapper,"
            }
        }
    ],

    HeaderWrapper({ children }: PropsWithChildren) {
        return (
            <>
                {children}
                <ErrorBoundary key="vc-mass-deleter-header" noop>
                    <HeaderBarIcon
                        className="vc-mass-deleter-btn"
                        onClick={() => {
                            try {
                                openModal(modalProps => <MassDeleterUI {...modalProps} />);
                            } catch (e) {
                                logger.error("Failed to open modal", e);
                            }
                        }}
                        tooltip="Mass Deleter"
                        icon={() => <HeaderIndicator />}
                    />
                </ErrorBoundary>
            </>
        );
    }
});
