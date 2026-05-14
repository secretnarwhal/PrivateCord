import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { 
    MessageActions, 
    SelectedChannelStore, 
    SelectedGuildStore, 
    UserStore, 
    RestAPI, 
    React,
    useState,
    useEffect,
    useRef,
    TextInput,
    Text,
    Button,
    Forms,
    Switch
} from "@webpack/common";
import { Flex } from "@components/Flex";
import { DeleteIcon } from "@components/Icons";
import { openModal, ModalRoot, ModalHeader, ModalContent, ModalFooter, ModalCloseButton, ModalSize } from "@utils/modal";
import { Logger } from "@utils/Logger";
import { findComponentByCodeLazy } from "@webpack";
import ErrorBoundary from "@components/ErrorBoundary";

const logger = new Logger("MassDeleter");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

const settings = definePluginSettings({
    defaultSearchDelay: {
        description: "Default search delay (ms)",
        type: OptionType.NUMBER,
        default: 30000
    },
    defaultDeleteDelay: {
        description: "Default delete delay (ms)",
        type: OptionType.NUMBER,
        default: 1000
    }
});

// Centralized state manager for background execution
const MassDeleterManager = {
    running: false,
    finished: false,
    progress: { current: 0, total: 0 },
    logs: [] as string[],
    listeners: new Set<() => void>(),

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    },

    notify() {
        this.listeners.forEach(l => l());
    },

    addLog(msg: string) {
        this.logs = [...this.logs.slice(-100), `${new Date().toLocaleTimeString()}: ${msg}`];
        this.notify();
    },

    stop() {
        this.running = false;
        this.finished = false;
        this.addLog("Stopped.");
    },

    async start(options: { authorId: string, guildId: string, channelId: string, searchQuery: string, includePinned: boolean, searchDelay: number, deleteDelay: number }) {
        if (this.running) return;
        
        this.running = true;
        this.finished = false;
        this.logs = [];
        this.progress = { current: 0, total: 0 };
        this.notify();
        this.addLog("Starting background deletion...");

        let offset = 0;
        let delCount = 0;
        let failCount = 0;

        while (this.running) {
            this.addLog(`Fetching messages (offset: ${offset})...`);
            
            const url = options.guildId === "@me" 
                ? `/channels/${options.channelId}/messages/search` 
                : `/guilds/${options.guildId}/messages/search`;

            try {
                const res = await RestAPI.get({
                    url,
                    query: {
                        author_id: options.authorId || undefined,
                        channel_id: (options.guildId !== "@me" ? options.channelId : undefined) || undefined,
                        content: options.searchQuery || undefined,
                        include_pinned: options.includePinned,
                        offset: offset,
                        sort_by: "timestamp",
                        sort_order: "desc"
                    }
                });

                if (res.status === 202) {
                    const waitTime = (res.body?.retry_after || 5) * 1000;
                    this.addLog(`API indexing... waiting ${waitTime}ms`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }

                if (!res.ok) {
                    if (res.status === 429) {
                        const waitTime = (res.body?.retry_after || 5) * 1000;
                        this.addLog(`Rate limited! Waiting ${waitTime}ms`);
                        await new Promise(r => setTimeout(r, waitTime));
                        continue;
                    }
                    this.addLog(`API Error: ${res.status}`);
                    break;
                }

                const data = res.body;
                const grandTotal = data.total_results;
                const messages = data.messages.map((m: any) => m.find((msg: any) => msg.hit));
                
                if (messages.length === 0) {
                    this.addLog("No more messages found.");
                    break;
                }

                this.progress = { current: delCount + failCount, total: grandTotal };
                this.addLog(`Found ${messages.length} messages. Total results: ${grandTotal}`);

                for (const msg of messages) {
                    if (!this.running) break;
                    
                    try {
                        await MessageActions.deleteMessage(msg.channel_id, msg.id);
                        delCount++;
                        this.addLog(`Deleted: ${msg.id}`);
                    } catch (e) {
                        logger.error("Failed to delete", e);
                        failCount++;
                        if ((e as any)?.status === 429) {
                            const waitTime = ((e as any).body?.retry_after || 5) * 1000;
                            this.addLog(`Delete rate limit! Waiting ${waitTime}ms`);
                            await new Promise(r => setTimeout(r, waitTime));
                        }
                    }
                    this.progress = { current: delCount + failCount, total: grandTotal };
                    this.notify();
                    await new Promise(r => setTimeout(r, options.deleteDelay));
                }

                if (!this.running) break;

                this.addLog(`Waiting ${options.searchDelay}ms before next search...`);
                await new Promise(r => setTimeout(r, options.searchDelay));
            } catch (e) {
                this.addLog(`Error: ${e}`);
                break;
            }
        }

        const wasRunning = this.running;
        this.running = false;
        this.finished = wasRunning; // Set finished only if it wasn't manual stop
        this.addLog(`Finished. Deleted: ${delCount}, Failed: ${failCount}`);
        this.notify();
    }
};

function useManager() {
    const [, forceUpdate] = useState({});
    useEffect(() => MassDeleterManager.subscribe(() => forceUpdate({})), []);
    return MassDeleterManager;
}

function MassDeleterUI(props) {
    const { transitionState, onClose } = props;
    const manager = useManager();
    
    // Initial form state (populated once)
    const [form, setForm] = useState({
        authorId: "",
        guildId: SelectedGuildStore?.getGuildId() || "@me",
        channelId: SelectedChannelStore?.getChannelId() || "",
        searchQuery: "",
        includePinned: false,
        searchDelay: settings.store.defaultSearchDelay,
        deleteDelay: settings.store.defaultDeleteDelay
    });

    const logsEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [manager.logs]);

    return (
        <ModalRoot transitionState={transitionState} onClose={onClose} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Flex flexDirection="row" alignItems="center" justifyContent="space-between" style={{ width: "100%" }}>
                    <Text variant="heading-lg/semibold">Undiscord Vencord Port</Text>
                    <ModalCloseButton onClick={onClose} />
                </Flex>
            </ModalHeader>
            <ModalContent style={{ padding: "20px" }}>
                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Author ID</Forms.FormTitle>
                    <Flex flexDirection="row" alignItems="center">
                        <TextInput 
                            value={form.authorId} 
                            onChange={(v) => setForm(f => ({ ...f, authorId: v }))} 
                            placeholder="Me or other User ID"
                        />
                        <Button 
                            variant="secondary"
                            size="small"
                            onClick={() => setForm(f => ({ ...f, authorId: UserStore?.getCurrentUser()?.id || "" }))}
                            style={{ marginLeft: "10px" }}
                        >me</Button>
                    </Flex>
                </div>
                
                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Server ID</Forms.FormTitle>
                    <Flex flexDirection="row" alignItems="center">
                        <TextInput 
                            value={form.guildId} 
                            onChange={(v) => setForm(f => ({ ...f, guildId: v }))} 
                            placeholder="Guild ID or @me"
                        />
                        <Button 
                            variant="secondary"
                            size="small"
                            onClick={() => setForm(f => ({ ...f, guildId: SelectedGuildStore?.getGuildId() || "@me" }))}
                            style={{ marginLeft: "10px" }}
                        >current</Button>
                    </Flex>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Channel ID</Forms.FormTitle>
                    <Flex flexDirection="row" alignItems="center">
                        <TextInput 
                            value={form.channelId} 
                            onChange={(v) => setForm(f => ({ ...f, channelId: v }))} 
                            placeholder="Current or specific Channel ID"
                        />
                        <Button 
                            variant="secondary"
                            size="small"
                            onClick={() => setForm(f => ({ 
                                ...f, 
                                channelId: SelectedChannelStore?.getChannelId() || "",
                                guildId: SelectedGuildStore?.getGuildId() || "@me"
                            }))}
                            style={{ marginLeft: "10px" }}
                        >current</Button>
                    </Flex>
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <Forms.FormTitle tag="h5">Search Filter</Forms.FormTitle>
                    <TextInput 
                        value={form.searchQuery} 
                        onChange={(v) => setForm(f => ({ ...f, searchQuery: v }))} 
                        placeholder="Text content filter"
                    />
                </div>

                <div style={{ marginBottom: "15px" }}>
                    <Switch 
                        checked={form.includePinned} 
                        onChange={(v) => setForm(f => ({ ...f, includePinned: v }))}
                    >Include Pinned Messages</Switch>
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
                    whiteSpace: "pre-wrap",
                    color: "var(--text-normal)"
                }}>
                    {manager.logs.map((log, i) => <div key={i}>{log}</div>)}
                    <div ref={logsEndRef} />
                </div>
                
                {manager.progress.total > 0 && (
                    <div style={{ marginTop: "10px" }}>
                        <Text color="header-secondary">Progress: {manager.progress.current} / {manager.progress.total}</Text>
                        <div style={{ 
                            width: "100%", 
                            height: "5px", 
                            backgroundColor: "var(--background-modifier-accent)",
                            marginTop: "5px"
                        }}>
                            <div style={{ 
                                width: `${(manager.progress.current / manager.progress.total) * 100}%`, 
                                height: "100%", 
                                backgroundColor: "var(--brand-experiment)" 
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
                            onClick={() => manager.start(form)}
                        >Start Deleting</Button>
                    ) : (
                        <Button 
                            variant="secondary"
                            onClick={() => manager.stop()}
                        >Stop</Button>
                    )}
                    <Button 
                        variant="link"
                        onClick={() => { manager.logs = []; manager.notify(); }}
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
            {manager.running && (
                <div style={{
                    position: "absolute",
                    top: "-2px",
                    right: "-2px",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: "var(--status-warning)",
                    border: "2px solid var(--background-tertiary)",
                    animation: "vc-mass-deleter-pulse 1s infinite alternate"
                }} />
            )}
            {manager.finished && !manager.running && (
                <div style={{
                    position: "absolute",
                    top: "-2px",
                    right: "-2px",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: "var(--status-positive)",
                    border: "2px solid var(--background-tertiary)"
                }} />
            )}
        </div>
    );
}

export default definePlugin({
    name: "MassDeleter",
    description: "Undiscord ported as a Vencord plugin.",
    authors: [],
    tags: ["Utility"],
    settings,
    
    start() {
        Vencord.Api.Styles.addStyle("vc-mass-deleter-styles", `
            @keyframes vc-mass-deleter-pulse {
                from { opacity: 0.5; transform: scale(0.8); }
                to { opacity: 1; transform: scale(1.2); }
            }
        `);
    },

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

    HeaderWrapper({ children }) {
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
                        tooltip="Open Mass Deleter"
                        icon={() => <HeaderIndicator />}
                    />
                </ErrorBoundary>
            </>
        );
    }
});
