/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import { Span } from "@components/Span";
import { classes } from "@utils/misc";
import { React, TextInput, useEffect, useRef, useState } from "@webpack/common";

import { cl } from "./MiniPlayer";
import { onToolOutput, store, usePlayer } from "./PlayerStore";
import type { CustomTool, ToolLine, ToolRun } from "./types";

/** A tool the user is part-way through describing; the same shape, minus the id. */
type ToolDraft = Omit<CustomTool, "id"> & { id: string | null; };

const EMPTY_DRAFT: ToolDraft = {
    id: null,
    name: "",
    cwd: "",
    command: "",
    args: "",
    shell: false
};

/** Matches the scrollback the main process keeps, so neither side outgrows the other. */
const MAX_CONSOLE_LINES = 3000;

function newId() {
    return Math.random().toString(36).slice(2, 10);
}

function elapsed(run: ToolRun) {
    const seconds = Math.floor((Date.now() - run.startedAt) / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// #region editor

function ToolEditor({ draft, onChange, onSave, onCancel, onDelete }: {
    draft: ToolDraft;
    onChange: (draft: ToolDraft) => void;
    onSave: () => void;
    onCancel: () => void;
    onDelete: (() => void) | null;
}) {
    const set = <K extends keyof ToolDraft>(key: K, value: ToolDraft[K]) =>
        onChange({ ...draft, [key]: value });

    async function browseFolder() {
        const folder = await store.pickToolFolder();
        if (folder) set("cwd", folder);
    }

    async function browseCommand() {
        const picked = await store.pickToolCommand();
        if (!picked) return;

        // picking a script hands back its interpreter plus the script itself, which
        // has to go in front of whatever arguments are already written down
        onChange({
            ...draft,
            command: picked.command,
            args: picked.args ? `${picked.args} ${draft.args}`.trim() : draft.args
        });
    }

    return (
        <div className={cl("tool-editor")}>
            <label className={cl("tool-field")}>
                <Span size="sm">Name</Span>
                <TextInput
                    value={draft.name}
                    onChange={(value: string) => set("name", value)}
                    placeholder="SpotiFLAC"
                />
            </label>

            <label className={cl("tool-field")}>
                <Span size="sm">Folder to run in</Span>
                <div className={cl("tool-field-row")}>
                    <TextInput
                        value={draft.cwd}
                        onChange={(value: string) => set("cwd", value)}
                        placeholder="Leave empty to run wherever Discord started"
                    />
                    <Button size="small" variant="secondary" onClick={browseFolder}>Browse…</Button>
                </div>
            </label>

            <label className={cl("tool-field")}>
                <Span size="sm">Command</Span>
                <div className={cl("tool-field-row")}>
                    <TextInput
                        value={draft.command}
                        onChange={(value: string) => set("command", value)}
                        placeholder="python"
                    />
                    <Button size="small" variant="secondary" onClick={browseCommand}>Browse…</Button>
                </div>
            </label>

            <label className={cl("tool-field")}>
                <Span size="sm">Arguments</Span>
                <TextInput
                    value={draft.args}
                    onChange={(value: string) => set("args", value)}
                    placeholder="spotiflac_cli.py {url} --out {folder}"
                />
            </label>

            <Span size="sm" className={cl("tool-hint")}>
                <b>{"{url}"}</b> and <b>{"{query}"}</b> become whatever is in the search box above,
                <b> {"{folder}"}</b> your music folder, <b>{"{tool}"}</b> this tool's name. Quotes are
                honoured, and a value with spaces in it stays one argument.
            </Span>

            <FormSwitch
                hideBorder
                title="Run through a shell"
                description="Needed only for pipes, redirection and &&. Off runs the command directly, which is safer"
                value={draft.shell}
                onChange={(value: boolean) => set("shell", value)}
            />

            <div className={cl("tool-editor-actions")}>
                <Button size="small" disabled={!draft.name.trim() || !draft.command.trim()} onClick={onSave}>
                    Save
                </Button>
                <Button size="small" variant="secondary" onClick={onCancel}>Cancel</Button>

                {onDelete && (
                    <Button size="small" variant="dangerSecondary" onClick={onDelete}>Delete</Button>
                )}
            </div>
        </div>
    );
}

// #endregion

// #region console

/**
 * The scrollback for one run. The run itself lives in the main process, so this
 * is only ever a view: it asks for everything it doesn't have on mount and then
 * follows the live stream, which is what lets it be closed and reopened freely.
 */
function ToolConsole({ runId, onClose }: { runId: string; onClose: () => void; }) {
    const player = usePlayer();
    const run = player.toolRuns.find(r => r.id === runId);

    const [lines, setLines] = useState<ToolLine[]>([]);
    const [input, setInput] = useState("");
    /** absolute index of the next line we expect — how a gap is noticed */
    const next = useRef(0);
    const scroller = useRef<HTMLDivElement>(null);
    /** false once the user scrolls up, so following output doesn't yank them back */
    const pinned = useRef(true);
    /** a catch-up fetch is out; a second one would append the same lines twice */
    const catchingUp = useRef(true);

    useEffect(() => {
        let live = true;
        catchingUp.current = true;

        /** Appends, keeping only as much scrollback as the main process itself does. */
        const append = (fresh: ToolLine[]) => setLines(current => {
            const all = [...current, ...fresh];
            return all.length > MAX_CONSOLE_LINES ? all.slice(all.length - MAX_CONSOLE_LINES) : all;
        });

        // whatever survived the ring buffer, however long this console was closed
        store.toolOutput(runId, 0).then(output => {
            if (!live || !output) return;

            next.current = output.from + output.lines.length;
            setLines(output.lines);
        }).finally(() => { catchingUp.current = false; });

        const unsubscribe = onToolOutput(output => {
            if (output.runId !== runId) return;

            if (output.from > next.current) {
                // a batch that starts past where we are means we missed something —
                // ask for the missing span rather than rendering a silent gap.
                // Batches that land mid-flight are ignored: the fetch already covers
                // them, and anything it doesn't will gap again and be caught then
                if (catchingUp.current) return;
                catchingUp.current = true;

                store.toolOutput(runId, next.current).then(fresh => {
                    if (!live || !fresh) return;

                    // ...which main can only partly answer if the ring buffer has
                    // since dropped it, so say so instead of splicing over the hole
                    const dropped = fresh.from - next.current;
                    next.current = fresh.from + fresh.lines.length;

                    append(dropped > 0
                        ? [{ stream: "meta", text: `… ${dropped} earlier lines dropped` }, ...fresh.lines]
                        : fresh.lines);
                }).finally(() => { catchingUp.current = false; });
                return;
            }

            // an overlap means we already hold the head of this batch
            const fresh = output.lines.slice(next.current - output.from);
            if (!fresh.length) return;

            next.current += fresh.length;
            append(fresh);
        });

        return () => {
            live = false;
            unsubscribe();
        };
    }, [runId]);

    useEffect(() => {
        const element = scroller.current;
        if (element && pinned.current) element.scrollTop = element.scrollHeight;
    }, [lines]);

    if (!run) return null;

    const running = run.status === "running";

    function send() {
        // an empty line is a real answer to a "press enter to continue" prompt,
        // so there is nothing here worth refusing to send
        store.sendToolInput(runId, input);
        setInput("");
    }

    return (
        // clicking the backdrop closes the console; the run carries on regardless
        <div className={cl("tool-console-backdrop")} onClick={onClose}>
            <div className={cl("tool-console")} onClick={e => e.stopPropagation()}>
                <div className={cl("tool-console-head")}>
                    <div className={cl("tool-console-title")}>
                        <span className={cl("row-title")}>{run.toolName}</span>
                        <span className={cl("row-subtitle")} title={run.commandLine}>{run.commandLine}</span>
                    </div>

                    {running
                        ? (
                            <Button size="small" variant="dangerSecondary" onClick={() => store.cancelToolRun(runId)}>
                                Stop
                            </Button>
                        )
                        : <span className={cl("row-badge")}>{run.status.toUpperCase()}</span>}

                    <button className={cl("dl-dismiss")} aria-label="Close the console" onClick={onClose}>✕</button>
                </div>

                <div
                    className={cl("tool-scrollback")}
                    ref={scroller}
                    onScroll={e => {
                        const el = e.currentTarget;
                        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                >
                    {lines.map((line, index) => (
                        <div key={index} className={classes(cl("tool-line"), cl(`tool-line-${line.stream}`))}>
                            {line.text || " "}
                        </div>
                    ))}

                    {!lines.length && <div className={cl("tool-line")}>No output yet.</div>}
                </div>

                <div className={cl("tool-console-input")}>
                    <TextInput
                        value={input}
                        onChange={setInput}
                        disabled={!running}
                        placeholder={running ? "Type here to answer the tool, then press Enter" : "The tool has stopped"}
                        onKeyDown={(e: React.KeyboardEvent) => {
                            if (e.key === "Enter") send();
                        }}
                    />
                    <Button size="small" variant="secondary" disabled={!running} onClick={send}>Send</Button>
                </div>

                <Span size="sm" className={cl("tool-hint")}>
                    Closing this leaves the tool running — reopen it from the list below.
                </Span>
            </div>
        </div>
    );
}

// #endregion

function RunRow({ run, onOpen }: { run: ToolRun; onOpen: () => void; }) {
    const running = run.status === "running";

    return (
        <div className={cl("dl-job")}>
            <div className={cl("dl-job-text")}>
                <span className={cl("row-title")} title={run.commandLine}>
                    {run.toolName} — {elapsed(run)}
                </span>
                <span className={classes(cl("row-subtitle"), run.status === "error" && cl("dl-error"))}>
                    {run.message}
                </span>
            </div>

            {running && (
                <div className={cl("dl-progress")}>
                    {/* a tool that reports no progress still gets the indeterminate bar */}
                    <div
                        className={classes(cl("dl-progress-fill"), run.percent < 0 && cl("dl-progress-idle"))}
                        style={{ width: run.percent < 0 ? "100%" : `${run.percent}%` }}
                    />
                </div>
            )}

            <Button size="small" variant="secondary" onClick={onOpen}>Console</Button>

            {running
                ? (
                    <Button size="small" variant="dangerSecondary" onClick={() => store.cancelToolRun(run.id)}>
                        Stop
                    </Button>
                )
                : <span className={cl("row-badge")}>{run.status.toUpperCase()}</span>}

            <button
                className={cl("dl-dismiss")}
                aria-label="Remove from the list"
                title="Remove from the list"
                onClick={() => store.removeToolRun(run.id)}
            >
                ✕
            </button>
        </div>
    );
}

/**
 * The custom-downloader half of the Download window: the tools the user has
 * described, the runs those tools produced, and a console onto any of them.
 *
 * Nothing here owns a process. Every run is started, held and killed in the main
 * process, so this section can be unmounted — by closing the window, or by
 * reloading Discord — without a download noticing.
 */
export function ToolRunner({ query }: { query: string; }) {
    const player = usePlayer();

    const [draft, setDraft] = useState<ToolDraft | null>(null);
    const [openRun, setOpenRun] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const active = player.toolRuns.filter(r => r.status === "running").length;
    const finished = player.toolRuns.length - active;

    // the elapsed time in each row is derived from the clock, so nothing else
    // would ever make it tick. Keyed on the count rather than the array, which is
    // replaced wholesale by every event the run stream delivers
    const [, tick] = useState(0);
    useEffect(() => {
        if (!active) return;

        const interval = window.setInterval(() => tick(n => n + 1), 1000);
        return () => window.clearInterval(interval);
    }, [active]);

    async function save() {
        if (!draft) return;

        await store.saveTool({ ...draft, id: draft.id ?? newId() });
        setDraft(null);
    }

    async function remove() {
        if (draft?.id) await store.deleteTool(draft.id);
        setDraft(null);
    }

    async function run(tool: CustomTool) {
        setError(null);

        try {
            const started = await store.runTool(tool.id, { url: query.trim(), query: query.trim() });
            setOpenRun(started.id);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    return (
        <div className={cl("tool-section")}>
            <div className={cl("dl-heading")}>
                <Span size="sm">
                    Your own downloaders{active ? ` — ${active} running` : ""}
                </Span>

                <Button
                    size="small"
                    variant="secondary"
                    onClick={() => setDraft(draft ? null : { ...EMPTY_DRAFT })}
                >
                    {draft ? "Close" : "Add a tool"}
                </Button>
            </div>

            {!player.tools.length && !draft && (
                <Span size="sm">
                    Point the plugin at a folder and a command — a python script, a shell line,
                    another downloader — and it runs right here, with its output in a console you
                    can close and come back to.
                </Span>
            )}

            {!!player.tools.length && (
                <div className={cl("tool-chips")}>
                    {player.tools.map(tool => (
                        <div key={tool.id} className={cl("tool-chip")}>
                            <Button size="small" onClick={() => run(tool)} title={`${tool.command} ${tool.args}`}>
                                {tool.name}
                            </Button>
                            <button
                                className={cl("tool-edit")}
                                aria-label={`Edit ${tool.name}`}
                                title={`Edit ${tool.name}`}
                                onClick={() => setDraft({ ...tool })}
                            >
                                ✎
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {draft && (
                <ToolEditor
                    draft={draft}
                    onChange={setDraft}
                    onSave={save}
                    onCancel={() => setDraft(null)}
                    onDelete={draft.id ? remove : null}
                />
            )}

            {error && <Span size="sm" className={cl("dl-error")}>{error}</Span>}

            {!!player.toolRuns.length && (
                <>
                    <div className={cl("dl-heading")}>
                        <Span size="sm">Runs</Span>
                        <Button
                            size="small"
                            variant="secondary"
                            disabled={!finished}
                            onClick={() => store.clearFinishedToolRuns()}
                        >
                            Clear finished
                        </Button>
                    </div>

                    <div className={cl("dl-jobs")}>
                        {player.toolRuns.map(item => (
                            <RunRow key={item.id} run={item} onOpen={() => setOpenRun(item.id)} />
                        ))}
                    </div>
                </>
            )}

            {openRun && <ToolConsole runId={openRun} onClose={() => setOpenRun(null)} />}
        </div>
    );
}
