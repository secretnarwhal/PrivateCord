/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Span } from "@components/Span";
import { classes } from "@utils/misc";
import {
    Alerts, ContextMenuApi, Menu, React, useCallback, useEffect, useMemo, useRef, useState
} from "@webpack/common";

import { cl, ControlButton, Icon, PATHS } from "./MiniPlayer";
import { compareAlbumOrder, isUnder, store, usePlayer } from "./PlayerStore";
import type { FileOpResult, FolderDir, FolderFile, FolderListing } from "./types";

/**
 * The library browser is a real file manager pointed at the music folder: every
 * folder it draws is a folder on disk, and renaming one here renames it there.
 *
 * What makes it a *music* browser rather than a generic one is that it expects
 * the usual shape — Artist / Album / Songs — and names each level accordingly.
 * Nothing enforces that shape (a folder of loose files browses perfectly well);
 * it only decides what the tiles say, and gives "File by artist / album" a
 * meaning when the user asks for it.
 */
const LEVEL_NAMES = ["Artist", "Album", "Disc"];

/** What the folders *inside* a folder at this depth are, 0 being the music folder. */
function levelName(depth: number) {
    return LEVEL_NAMES[depth] ?? "Folder";
}

function plural(count: number, one: string) {
    return `${count} ${one}${count === 1 ? "" : "s"}`;
}

function nameOf(path: string) {
    return path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
}

function parentOf(path: string) {
    return path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")));
}

/** A file name without its extension — what a track is called when it has no tags. */
function stem(name: string) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

function formatSize(bytes: number) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function message(e: unknown) {
    return e instanceof Error ? e.message : String(e);
}

function failuresOf(result: unknown) {
    const failed = (result as FileOpResult | undefined)?.failed;
    return Array.isArray(failed) ? failed : [];
}

/**
 * What a drag is carrying. dataTransfer can only be read on drop, never during
 * dragover, so the payload lives here too — which is what lets a folder refuse a
 * drop of itself before the user has let go of it.
 */
let dragging: string[] = [];

/** Where the browser was left, per music folder, so reopening it comes back. */
const lastVisited = new Map<string, string>();

/** Whether these entries can be dropped into that folder. */
function canDrop(paths: string[], target: string) {
    if (!paths.length) return false;

    // nothing can be dropped into itself or into anything it contains, and a drop
    // that would move everything to where it already is isn't worth offering
    return paths.every(path => path !== target && !isUnder(target, path))
        && paths.some(path => parentOf(path) !== target);
}

const menuIcon = (path: string) => () => <Icon path={path} label="" size={18} />;

interface BrowserActions {
    open(path: string): void;
    /** @returns true when the click was about selecting rather than opening */
    select(e: React.MouseEvent, path: string): boolean;
    menu(e: React.MouseEvent, path: string, isDir: boolean): void;
    play(path: string): void;
    queue(path: string, next: boolean): void;
    rename(path: string, name: string): void;
    cancelRename(): void;
    drag: {
        start(e: React.DragEvent, path: string): void;
        end(): void;
        over(e: React.DragEvent, path: string): void;
        leave(path: string): void;
        drop(e: React.DragEvent, path: string): void;
    };
}

/** The inline editor behind every rename, and behind naming a new folder. */
function NameInput({ value: initial, onCommit, onCancel }: {
    value: string;
    onCommit(name: string): void;
    onCancel(): void;
}) {
    const [value, setValue] = useState(initial);
    // committing and cancelling both blur, and that blur must not commit again
    const settled = useRef(false);

    function finish(commit: boolean) {
        if (settled.current) return;
        settled.current = true;

        if (commit && value.trim()) onCommit(value);
        else onCancel();
    }

    return (
        <input
            className={cl("name-input")}
            autoFocus
            spellCheck={false}
            value={value}
            onChange={e => setValue(e.currentTarget.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
                // the modal listens for keys of its own, and this is typing, not shortcuts
                e.stopPropagation();
                if (e.key === "Enter") finish(true);
                else if (e.key === "Escape") finish(false);
            }}
            onBlur={() => finish(true)}
            onFocus={e => {
                // select the name but not the extension — renaming a song is
                // almost never about the ".mp3"
                const dot = initial.lastIndexOf(".");
                e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
            }}
        />
    );
}

function FolderTile({ dir, art, songs, childLevel, selected, dropping, renaming, actions }: {
    dir: FolderDir;
    art: string | null;
    /** playable files anywhere underneath, counted from the library scan */
    songs: number;
    /** what the folders inside this one are called */
    childLevel: string;
    selected: boolean;
    dropping: boolean;
    renaming: boolean;
    actions: BrowserActions;
}) {
    const [broken, setBroken] = useState(false);
    useEffect(() => setBroken(false), [art]);

    const parts: string[] = [];
    if (dir.folderCount > 0) parts.push(plural(dir.folderCount, childLevel.toLowerCase()));
    if (songs > 0) parts.push(plural(songs, "song"));
    if (!parts.length && dir.trackCount === 0 && dir.folderCount === 0) parts.push("empty");

    return (
        <div
            className={classes(
                cl("tile"),
                selected && cl("tile-selected"),
                dropping && cl("tile-drop")
            )}
            role="button"
            tabIndex={0}
            title={dir.name}
            draggable={!renaming}
            onDragStart={e => actions.drag.start(e, dir.path)}
            onDragEnd={actions.drag.end}
            onDragOver={e => actions.drag.over(e, dir.path)}
            onDragLeave={() => actions.drag.leave(dir.path)}
            onDrop={e => actions.drag.drop(e, dir.path)}
            onClick={e => {
                if (!actions.select(e, dir.path)) actions.open(dir.path);
            }}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") actions.open(dir.path);
            }}
            onContextMenu={e => actions.menu(e, dir.path, true)}
        >
            <div className={cl("tile-art")}>
                {art && !broken
                    ? <img src={art} alt="" loading="lazy" onError={() => setBroken(true)} />
                    : <Icon path={PATHS.folder} label="" size={28} />}

                <button
                    className={cl("tile-play")}
                    aria-label={`Play ${dir.name}`}
                    onClick={e => {
                        e.stopPropagation();
                        actions.play(dir.path);
                    }}
                >
                    <Icon path={PATHS.play} label="" size={20} />
                </button>
            </div>

            <div className={cl("tile-text")}>
                {renaming
                    ? (
                        <NameInput
                            value={dir.name}
                            onCommit={name => actions.rename(dir.path, name)}
                            onCancel={actions.cancelRename}
                        />
                    )
                    : <span className={cl("tile-name")}>{dir.name}</span>}

                <span className={cl("tile-sub")}>{parts.join(" · ")}</span>
            </div>
        </div>
    );
}

function fileIcon(file: FolderFile) {
    if (file.playable) return file.isVideo ? PATHS.video : PATHS.note;
    if (file.ext === ".lrc" || file.ext === ".txt") return PATHS.lyrics;
    return PATHS.library;
}

function FileRow({ file, playing, selected, renaming, actions }: {
    file: FolderFile;
    playing: boolean;
    selected: boolean;
    renaming: boolean;
    actions: BrowserActions;
}) {
    const meta = store.metadata[file.path];
    const title = meta?.title || stem(file.name);
    const subtitle = [meta?.artist, meta?.album].filter(Boolean).join(" — ") || formatSize(file.size);

    return (
        <div
            className={classes(
                cl("row"),
                playing && cl("row-active"),
                selected && cl("row-selected"),
                !file.playable && cl("row-muted")
            )}
            role="button"
            tabIndex={0}
            draggable={!renaming}
            onDragStart={e => actions.drag.start(e, file.path)}
            onDragEnd={actions.drag.end}
            onClick={e => {
                if (!actions.select(e, file.path) && file.playable) actions.play(file.path);
            }}
            onKeyDown={e => {
                if ((e.key === "Enter" || e.key === " ") && file.playable) actions.play(file.path);
            }}
            onContextMenu={e => actions.menu(e, file.path, false)}
        >
            <span className={cl("row-icon")} aria-hidden>
                <Icon path={fileIcon(file)} label="" size={16} />
            </span>

            <div className={cl("row-text")}>
                {renaming
                    ? (
                        <NameInput
                            value={file.name}
                            onCommit={name => actions.rename(file.path, name)}
                            onCancel={actions.cancelRename}
                        />
                    )
                    : <span className={cl("row-title")}>{title}</span>}

                <span className={cl("row-subtitle")}>{subtitle}</span>
            </div>

            {file.isVideo && <span className={cl("row-badge")}>VIDEO</span>}

            {file.playable && (
                <div className={cl("row-actions")} onClick={e => e.stopPropagation()}>
                    <ControlButton
                        label="Play next"
                        className={cl("row-action")}
                        onClick={() => actions.queue(file.path, true)}
                    >
                        <Icon path={PATHS.playNext} label="play next" size={16} />
                    </ControlButton>

                    <ControlButton
                        label="Add to queue"
                        className={cl("row-action")}
                        onClick={() => actions.queue(file.path, false)}
                    >
                        <Icon path={PATHS.queueAdd} label="add to queue" size={16} />
                    </ControlButton>
                </div>
            )}
        </div>
    );
}

export function FolderBrowser() {
    const player = usePlayer();
    const root = player.folder;

    const [path, setPath] = useState<string | null>(() => (root && lastVisited.get(root)) ?? root);
    const [listing, setListing] = useState<FolderListing | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** bumped to re-read the folder from disk after something changed it */
    const [revision, setRevision] = useState(0);
    const [selected, setSelected] = useState<string[]>([]);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const [showOther, setShowOther] = useState(false);
    /** where a shift-click measures its range from */
    const anchor = useRef<string | null>(null);

    // the browser follows the library: a different music folder starts it at the top
    useEffect(() => {
        setPath(current => current && root && (current === root || isUnder(current, root)) ? current : root);
    }, [root]);

    useEffect(() => {
        if (root && path) lastVisited.set(root, path);
    }, [root, path]);

    // player.tracks is in the deps so a finished download (which rescans) shows up
    useEffect(() => {
        if (!path) {
            setListing(null);
            return;
        }

        let cancelled = false;

        store.listFolder(path).then(
            result => {
                if (cancelled) return;
                setListing(result);
                setError(null);
            },
            e => {
                if (cancelled) return;

                // the folder was renamed or deleted out from under us (from a real
                // file manager, say) — step back up rather than stranding the user
                // on an error they can do nothing about
                if (root && path !== root && isUnder(path, root)) {
                    setPath(parentOf(path));
                    return;
                }

                setListing(null);
                setError(message(e));
            }
        );

        return () => { cancelled = true; };
    }, [path, root, revision, player.tracks]);

    const reload = useCallback(() => setRevision(current => current + 1), []);

    /**
     * Runs one change against the disk. Failures are reported per entry rather
     * than thrown, so a batch that half worked says which half — and the folder
     * is re-read either way, because the truth is on disk and not in this state.
     */
    const run = useCallback(async (work: () => Promise<unknown>) => {
        setBusy(true);
        try {
            const failed = failuresOf(await work());
            setError(failed.length ? failed.map(entry => entry.error).join(" · ") : null);
        } catch (e) {
            setError(message(e));
        } finally {
            setBusy(false);
            // whatever was selected has just been renamed, moved or deleted, so the
            // paths held here point at nothing any more
            setSelected([]);
            reload();
        }
    }, [reload]);

    const depth = listing ? listing.crumbs.length - 1 : 0;
    const childLevel = levelName(depth);

    const files = listing?.files ?? [];

    // metadata is filled in place during the background tag pass, so its identity
    // never changes — the count is what tells this memo that more has arrived
    const metaCount = Object.keys(player.metadata).length;

    /**
     * Songs in album order rather than file name order: a folder of tagged
     * tracks reads the way the album does, and one whose tags say nothing about
     * track numbers stays in name order. Re-sorted as tags arrive.
     */
    const playable = useMemo(
        () => files.filter(file => file.playable)
            .sort((a, b) => compareAlbumOrder(player.metadata, a.path, b.path)),
        [files, metaCount]
    );
    const others = useMemo(() => files.filter(file => !file.playable), [files]);

    /**
     * What the library knows about the folders on screen: how many songs each one
     * holds all the way down, and a track inside it whose tags carry cover art.
     * One pass over the library rather than one per tile.
     */
    const stats = useMemo(() => {
        const songs = new Map<string, number>();
        const art = new Map<string, string>();
        if (!listing) return { songs, art };

        const known = new Set(listing.dirs.map(dir => dir.path));
        // past the separator — unless the folder is a drive root, which is one
        const last = listing.path[listing.path.length - 1];
        const base = listing.path.length + (last === "\\" || last === "/" ? 0 : 1);

        for (const track of player.tracks) {
            if (!isUnder(track.path, listing.path)) continue;

            const cut = track.path.slice(base).search(/[\\/]/);
            if (cut < 0) continue; // sitting in this folder itself, not in a child

            const dir = track.path.slice(0, base + cut);
            if (!known.has(dir)) continue;

            songs.set(dir, (songs.get(dir) ?? 0) + 1);
            if (!art.has(dir) && player.metadata[track.path]?.hasArt) art.set(dir, track.path);
        }

        return { songs, art };
    }, [listing, player.tracks, metaCount]);

    const dirArt = (dir: FolderDir) => {
        if (dir.cover) return store.imageUrl(dir.cover);

        const track = stats.art.get(dir.path);
        return track ? store.trackArtUrl(track) : null;
    };

    /** Selection ranges are measured against what is on screen, in reading order. */
    const order = useMemo(
        () => listing
            ? [
                ...listing.dirs.map(dir => dir.path),
                ...playable.map(file => file.path),
                ...others.map(file => file.path)
            ]
            : [],
        [listing, playable, others]
    );

    /** Everything playable in this folder and below it — what "play all" plays. */
    const folderTracks = useMemo(
        () => listing ? store.tracksUnder(listing.path) : [],
        [listing, player.tracks]
    );

    function navigate(next: string) {
        setPath(next);
        setSelected([]);
        setRenaming(null);
        setCreating(false);
        setShowOther(false);
        setError(null);
    }

    function select(e: React.MouseEvent, target: string) {
        if (e.shiftKey) {
            const from = anchor.current && order.includes(anchor.current) ? anchor.current : order[0];
            const a = order.indexOf(from);
            const b = order.indexOf(target);

            setSelected(a < 0 || b < 0 ? [target] : order.slice(Math.min(a, b), Math.max(a, b) + 1));
            return true;
        }

        if (e.ctrlKey || e.metaKey) {
            anchor.current = target;
            setSelected(current => current.includes(target)
                ? current.filter(path => path !== target)
                : [...current, target]);
            return true;
        }

        anchor.current = target;
        // a plain click on one thing is about that thing, so it also clears the rest
        if (selected.length) setSelected([]);
        return false;
    }

    /** An action on an entry inside the selection acts on the whole selection. */
    const targetsFor = (target: string) =>
        selected.length > 1 && selected.includes(target) ? selected : [target];

    /** Every library track a set of entries covers, folders expanded, in library order. */
    function tracksOf(paths: string[]) {
        const out: string[] = [];

        for (const path of paths) {
            if (store.indexOfPath(path) !== undefined) out.push(path);
            else out.push(...store.tracksUnder(path));
        }

        return [...new Set(out)];
    }

    function confirmDelete(targets: string[]) {
        const what = targets.length === 1 ? `“${nameOf(targets[0])}”` : plural(targets.length, "item");

        Alerts.show({
            title: `Delete ${what}?`,
            body: (
                <Span size="sm">
                    {what} goes to your system's recycle bin — a folder takes everything
                    inside it along. You can put it back from there.
                </Span>
            ),
            confirmText: "Delete",
            cancelText: "Cancel",
            onConfirm: () => void run(() => store.trashEntries(targets))
        });
    }

    /** Files tracks into Artist / Album, after showing what that would do. */
    function tidy(paths: string[]) {
        const tracks = paths.filter(track => store.indexOfPath(track) !== undefined);
        if (!tracks.length) {
            setError("There are no library tracks in there to file");
            return;
        }

        const plan = tracks.map(track => ({
            name: nameOf(track),
            artist: player.metadata[track]?.artist?.trim() || "Unknown Artist",
            album: player.metadata[track]?.album?.trim() || "Unknown Album"
        }));

        Alerts.show({
            title: `File ${plural(tracks.length, "track")} by tag?`,
            body: (
                <div className={cl("tidy-plan")}>
                    <Span size="sm">
                        Each track moves into its own <strong>artist / album</strong> folder under
                        your music folder, taking its lyrics file with it:
                    </Span>

                    <ul>
                        {plan.slice(0, 6).map((item, i) => (
                            <li key={i}>
                                <strong>{item.name}</strong> → {item.artist} / {item.album}
                            </li>
                        ))}
                        {plan.length > 6 && <li>…and {plan.length - 6} more</li>}
                    </ul>
                </div>
            ),
            confirmText: "File them",
            cancelText: "Cancel",
            onConfirm: () => void run(() => store.organiseTracks(tracks))
        });
    }

    function openMenu(e: React.MouseEvent, target: string, isDir: boolean) {
        e.preventDefault();
        e.stopPropagation();

        // right-clicking outside the selection is about what was clicked, not it
        if (selected.length && !selected.includes(target)) setSelected([]);

        const targets = targetsFor(target);
        const many = targets.length > 1;
        const parent = listing?.parent;

        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu
                navId="vc-lm-entry-menu"
                onClose={ContextMenuApi.closeContextMenu}
                aria-label="Library entry"
            >
                <Menu.MenuItem
                    id="vc-lm-play"
                    label={isDir && !many ? "Play folder" : "Play"}
                    icon={menuIcon(PATHS.play)}
                    action={() => void store.playPaths(tracksOf(targets))}
                />
                <Menu.MenuItem
                    id="vc-lm-play-next"
                    label="Play next"
                    icon={menuIcon(PATHS.playNext)}
                    action={() => store.queuePaths(tracksOf(targets), true)}
                />
                <Menu.MenuItem
                    id="vc-lm-queue"
                    label="Add to queue"
                    icon={menuIcon(PATHS.queueAdd)}
                    action={() => store.queuePaths(tracksOf(targets))}
                />

                <Menu.MenuSeparator />

                {!many && (
                    <Menu.MenuItem
                        id="vc-lm-rename"
                        label="Rename…"
                        icon={menuIcon(PATHS.edit)}
                        action={() => setRenaming(target)}
                    />
                )}
                {parent && (
                    <Menu.MenuItem
                        id="vc-lm-move-up"
                        label="Move up a level"
                        icon={menuIcon(PATHS.up)}
                        action={() => void run(() => store.moveEntries(targets, parent))}
                    />
                )}
                <Menu.MenuItem
                    id="vc-lm-tidy"
                    label="File by artist / album"
                    icon={menuIcon(PATHS.folderMove)}
                    action={() => tidy(tracksOf(targets))}
                />
                {!many && (
                    <Menu.MenuItem
                        id="vc-lm-reveal"
                        label="Show in file manager"
                        icon={menuIcon(PATHS.popOut)}
                        action={() => void store.revealEntry(target).catch(e => setError(message(e)))}
                    />
                )}

                <Menu.MenuSeparator />

                <Menu.MenuItem
                    id="vc-lm-delete"
                    color="danger"
                    label={many ? `Delete ${plural(targets.length, "item")}` : "Delete"}
                    icon={menuIcon(PATHS.trash)}
                    action={() => confirmDelete(targets)}
                />
            </Menu.Menu>
        ));
    }

    const drag = {
        start(e: React.DragEvent, target: string) {
            dragging = targetsFor(target);
            // Chromium refuses a drag that carries nothing at all
            e.dataTransfer.setData("text/plain", dragging.join("\n"));
            e.dataTransfer.effectAllowed = "move";
        },
        end() {
            dragging = [];
            setDropTarget(null);
        },
        over(e: React.DragEvent, target: string) {
            if (!canDrop(dragging, target)) return;

            // without both of these the browser rejects the drop outright
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";

            if (dropTarget !== target) setDropTarget(target);
        },
        leave(target: string) {
            setDropTarget(current => current === target ? null : current);
        },
        drop(e: React.DragEvent, target: string) {
            e.preventDefault();
            e.stopPropagation();

            const paths = dragging;
            drag.end();

            if (canDrop(paths, target)) void run(() => store.moveEntries(paths, target));
        }
    };

    const actions: BrowserActions = {
        open: navigate,
        select,
        menu: openMenu,
        play: target => void store.playPaths(tracksOf([target])),
        queue: (target, next) => store.queuePaths(tracksOf([target]), next),
        rename: (target, name) => {
            setRenaming(null);
            if (name !== nameOf(target)) void run(() => store.renameEntry(target, name));
        },
        cancelRename: () => setRenaming(null),
        drag
    };

    if (!root) return null;

    const crumbs = listing?.crumbs ?? [];
    const parent = listing?.parent ?? null;

    return (
        <div className={classes(cl("browser"), busy && cl("browser-busy"))}>
            <div className={cl("crumbs")}>
                {parent && (
                    <button
                        className={classes(cl("crumb-up"), dropTarget === parent && cl("crumb-drop"))}
                        aria-label="Up one folder"
                        title="Up one folder"
                        onClick={() => navigate(parent)}
                        onDragOver={e => drag.over(e, parent)}
                        onDragLeave={() => drag.leave(parent)}
                        onDrop={e => drag.drop(e, parent)}
                    >
                        <Icon path={PATHS.up} label="up" size={16} />
                    </button>
                )}

                <div className={cl("crumb-trail")}>
                    {crumbs.map((crumb, i) => (
                        <React.Fragment key={crumb.path}>
                            {i > 0 && <span className={cl("crumb-sep")} aria-hidden>/</span>}
                            <button
                                className={classes(
                                    cl("crumb"),
                                    i === crumbs.length - 1 && cl("crumb-current"),
                                    dropTarget === crumb.path && cl("crumb-drop")
                                )}
                                title={crumb.path}
                                onClick={() => navigate(crumb.path)}
                                onDragOver={e => drag.over(e, crumb.path)}
                                onDragLeave={() => drag.leave(crumb.path)}
                                onDrop={e => drag.drop(e, crumb.path)}
                            >
                                {i === 0 && <Icon path={PATHS.library} label="" size={13} />}
                                {crumb.name}
                            </button>
                        </React.Fragment>
                    ))}
                </div>

                {/* nothing here can act on a folder that failed to list */}
                <div className={cl("crumb-actions")}>
                    {folderTracks.length > 0 && (
                        <ControlButton
                            label={`Play everything here (${folderTracks.length})`}
                            className={cl("row-action")}
                            onClick={() => void store.playPaths(folderTracks)}
                        >
                            <Icon path={PATHS.play} label="play folder" size={16} />
                        </ControlButton>
                    )}

                    {!!listing && (
                        <ControlButton
                            label={`New ${childLevel.toLowerCase()} folder`}
                            className={cl("row-action")}
                            onClick={() => {
                                setCreating(true);
                                setRenaming(null);
                            }}
                        >
                            <Icon path={PATHS.folderAdd} label="new folder" size={16} />
                        </ControlButton>
                    )}

                    {!!path && (
                        <ControlButton
                            label="Show this folder in your file manager"
                            className={cl("row-action")}
                            onClick={() => void store.revealEntry(path).catch(e => setError(message(e)))}
                        >
                            <Icon path={PATHS.popOut} label="show in file manager" size={16} />
                        </ControlButton>
                    )}
                </div>
            </div>

            {error && (
                <div className={cl("browser-error")} onClick={() => setError(null)} role="button" tabIndex={0}>
                    {error}
                </div>
            )}

            <div className={cl("list")}>
                {listing && !listing.dirs.length && !listing.files.length && !creating && (
                    <div className={cl("browser-empty")}>
                        <Icon path={PATHS.folder} label="" size={28} />
                        <Span size="sm">
                            This folder is empty. Songs and folders you move into it —
                            or make in it — show up here.
                        </Span>
                    </div>
                )}

                {(!!listing?.dirs.length || creating) && (
                    <div className={cl("section")}>
                        {creating && !listing?.dirs.length
                            ? `New ${childLevel.toLowerCase()}`
                            : plural(listing?.dirs.length ?? 0, childLevel.toLowerCase())}
                    </div>
                )}

                {(!!listing?.dirs.length || creating) && (
                    <div className={cl("tiles")}>
                        {creating && (
                            <div className={classes(cl("tile"), cl("tile-new"))}>
                                <div className={cl("tile-art")}>
                                    <Icon path={PATHS.folderAdd} label="" size={28} />
                                </div>
                                <div className={cl("tile-text")}>
                                    <NameInput
                                        value={`New ${childLevel.toLowerCase()}`}
                                        onCommit={name => {
                                            setCreating(false);
                                            if (listing) void run(() => store.createFolder(listing.path, name));
                                        }}
                                        onCancel={() => setCreating(false)}
                                    />
                                </div>
                            </div>
                        )}

                        {listing?.dirs.map(dir => (
                            <FolderTile
                                key={dir.path}
                                dir={dir}
                                art={dirArt(dir)}
                                songs={stats.songs.get(dir.path) ?? dir.trackCount}
                                childLevel={levelName(depth + 1)}
                                selected={selected.includes(dir.path)}
                                dropping={dropTarget === dir.path}
                                renaming={renaming === dir.path}
                                actions={actions}
                            />
                        ))}
                    </div>
                )}

                {!!playable.length && (
                    <div className={cl("section")}>
                        {plural(playable.length, "song")}
                        {depth === 0 && (
                            <button className={cl("section-action")} onClick={() => tidy(playable.map(f => f.path))}>
                                File them by artist / album
                            </button>
                        )}
                    </div>
                )}

                {playable.map(file => (
                    <FileRow
                        key={file.path}
                        file={file}
                        playing={player.currentTrack?.path === file.path}
                        selected={selected.includes(file.path)}
                        renaming={renaming === file.path}
                        actions={actions}
                    />
                ))}

                {!!others.length && (
                    <button className={cl("section-toggle")} onClick={() => setShowOther(current => !current)}>
                        {showOther ? "Hide" : "Show"} {plural(others.length, "other file")}
                    </button>
                )}

                {showOther && others.map(file => (
                    <FileRow
                        key={file.path}
                        file={file}
                        playing={false}
                        selected={selected.includes(file.path)}
                        renaming={renaming === file.path}
                        actions={actions}
                    />
                ))}
            </div>

            {selected.length > 0 && (
                <div className={cl("selection-bar")}>
                    <span className={cl("selection-count")}>{plural(selected.length, "item")} selected</span>

                    <Button size="small" onClick={() => void store.playPaths(tracksOf(selected))}>
                        Play
                    </Button>
                    <Button size="small" variant="secondary" onClick={() => store.queuePaths(tracksOf(selected))}>
                        Queue
                    </Button>
                    {parent && (
                        <Button
                            size="small"
                            variant="secondary"
                            onClick={() => void run(() => store.moveEntries(selected, parent))}
                        >
                            Move up
                        </Button>
                    )}
                    <Button size="small" variant="secondary" onClick={() => tidy(tracksOf(selected))}>
                        File by tag
                    </Button>
                    <Button size="small" variant="dangerSecondary" onClick={() => confirmDelete(selected)}>
                        Delete
                    </Button>
                    <Button size="small" variant="secondary" onClick={() => setSelected([])}>
                        Clear
                    </Button>
                </div>
            )}
        </div>
    );
}
