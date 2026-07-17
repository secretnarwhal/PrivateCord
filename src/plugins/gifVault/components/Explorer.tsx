/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@plugins/gifVault/settings";
import {
    buildDeepCounts, buildFolderIndex, cl, collectSubtreeIds, gifHaystack,
    matchesQuery, SORT_LABELS, sortGifs
} from "@plugins/gifVault/utils";
import {
    canDropInto, clearActiveDrag, createFolder, ExplorerStore, FavGif, getChildFolders,
    getFolder, getFolderPath, getGifFolderId, performDrop, pruneVault, renameFolder,
    setPopoutOpen, useExplorerState, useFavoriteGifs, useVault
} from "@plugins/gifVault/vault";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import {
    ExpressionPickerStore, React, SelectedChannelStore, Toasts, Tooltip,
    useCallback, useEffect, useMemo, useRef, useState
} from "@webpack/common";
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";

import {
    ChevronIcon, CloseIcon, FolderOpenIcon, HomeIcon, NewFolderIcon, PopoutIcon,
    SearchIcon, SortIcon, StarIcon, UpIcon
} from "./icons";
import { openBackgroundMenu, openFolderMenu, openGifMenu, openSortMenu } from "./menus";
import { FolderTile, GifTile } from "./Tiles";

const SPRING_LOAD_DELAY = 650;

function IconBtn({ tooltip, onClick, disabled, children }: {
    tooltip: string;
    onClick(e: MouseEvent): void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <Tooltip text={tooltip}>
            {props => (
                <button {...props} className={cl("icon-btn")} disabled={disabled} onClick={onClick}>
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

/** Shared drag & drop plumbing for anything gifs/folders can be dropped onto */
function useDropTarget(targetId: string | null, springNavigate?: () => void) {
    const [over, setOver] = useState(0);
    const springTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const clearSpring = () => {
        clearTimeout(springTimer.current);
        springTimer.current = undefined;
    };

    useEffect(() => clearSpring, []);

    const props = {
        onDragEnter: (e: DragEvent) => {
            if (!canDropInto(targetId)) return;
            e.preventDefault();
            setOver(c => c + 1);
            if (springNavigate && !springTimer.current) {
                springTimer.current = setTimeout(springNavigate, SPRING_LOAD_DELAY);
            }
        },
        onDragOver: (e: DragEvent) => {
            if (!canDropInto(targetId)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
        },
        onDragLeave: () => {
            setOver(c => Math.max(0, c - 1));
            clearSpring();
        },
        onDrop: (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(0);
            clearSpring();
            performDrop(targetId);
            clearActiveDrag();
        }
    };

    return { over: over > 0, props };
}

export function ExplorerToolbar({ store, variant }: { store: ExplorerStore; variant: "picker" | "popout"; }) {
    const state = useExplorerState(store);

    return (
        <div className={cl("toolbar", `toolbar-${variant}`)}>
            <div className={cl("search")}>
                <SearchIcon size={14} className={cl("search-icon")} />
                <input
                    className={cl("search-input")}
                    value={state.query}
                    placeholder="Search names, #tags, urls…"
                    onChange={e => store.patch({ query: e.currentTarget.value })}
                    onKeyDown={e => {
                        if (e.key === "Escape" && state.query) {
                            e.preventDefault();
                            e.stopPropagation();
                            store.patch({ query: "" });
                        }
                    }}
                />
                {state.query && (
                    <button className={cl("search-clear")} onClick={() => store.patch({ query: "" })}>
                        <CloseIcon size={12} />
                    </button>
                )}
            </div>
            <IconBtn tooltip={`Sort: ${SORT_LABELS[state.sort]}`} onClick={e => openSortMenu(e, store)}>
                <SortIcon size={16} />
            </IconBtn>
            <IconBtn
                tooltip="New folder"
                onClick={() => {
                    const folder = createFolder(store.get().folderId);
                    store.patch({ renamingId: folder.id, query: "" });
                }}
            >
                <NewFolderIcon size={16} />
            </IconBtn>
            {variant === "picker" && (
                <IconBtn tooltip="Open popout window" onClick={() => setPopoutOpen(true)}>
                    <PopoutIcon size={16} />
                </IconBtn>
            )}
        </div>
    );
}

function Crumb({ targetId, active, label, isHome, onNavigate }: {
    targetId: string | null;
    active: boolean;
    label: string;
    isHome?: boolean;
    onNavigate(id: string | null): void;
}) {
    const drop = useDropTarget(targetId, () => onNavigate(targetId));

    return (
        <button
            {...drop.props}
            className={cl("crumb", { "crumb-active": active, "drop-ok": drop.over })}
            onClick={() => onNavigate(targetId)}
        >
            {isHome && <HomeIcon size={12} />}
            <span className={cl("crumb-label")}>{label}</span>
        </button>
    );
}

function Breadcrumbs({ store }: { store: ExplorerStore; }) {
    const state = useExplorerState(store);
    useVault();

    const path = getFolderPath(state.folderId);
    const parentId = path.length > 0 ? path[path.length - 1].parentId : null;
    const atRoot = state.folderId == null;

    const navigate = (folderId: string | null) => store.patch({ folderId, renamingId: null, query: "" });
    const up = useDropTarget(parentId, () => !atRoot && navigate(parentId));

    return (
        <div className={cl("crumbs")}>
            <Tooltip text="Up one level">
                {props => (
                    <button
                        {...props}
                        {...up.props}
                        className={cl("up-btn", { "drop-ok": up.over })}
                        disabled={atRoot}
                        onClick={() => !atRoot && navigate(parentId)}
                    >
                        <UpIcon size={14} />
                    </button>
                )}
            </Tooltip>
            <div className={cl("crumb-list")}>
                <Crumb targetId={null} active={atRoot} onNavigate={navigate} label="Home" isHome />
                {path.map(folder => (
                    <React.Fragment key={folder.id}>
                        <ChevronIcon size={11} className={cl("crumb-sep")} />
                        <Crumb
                            targetId={folder.id}
                            active={folder.id === state.folderId}
                            onNavigate={navigate}
                            label={folder.name}
                        />
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string; }) {
    return (
        <div className={cl("empty")}>
            <div className={cl("empty-icon")}>{icon}</div>
            <div className={cl("empty-title")}>{title}</div>
            {hint && <div className={cl("empty-hint")}>{hint}</div>}
        </div>
    );
}

export interface ExplorerProps {
    store: ExplorerStore;
    variant: "picker" | "popout";
    /** native gif select handler of Discord's picker; used for click-to-send */
    onSelectGif?: (gif: FavGif) => void;
    className?: string;
}

export function Explorer({ store, variant, onSelectGif, className }: ExplorerProps) {
    const favorites = useFavoriteGifs();
    const vaultVersion = useVault();
    const state = useExplorerState(store);
    const { tileSize, showStatusBar } = settings.use(["tileSize", "showStatusBar"]);

    // if the current folder was deleted (possibly from the other explorer), fall back home
    useEffect(() => {
        if (state.folderId != null && !getFolder(state.folderId)) {
            store.patch({ folderId: null });
        }
    }, [state.folderId, vaultVersion]);

    // forget metadata of gifs that are no longer favorited
    useEffect(() => {
        if (favorites.length > 0) pruneVault(new Set(favorites.map(g => g.url)));
    }, [favorites]);

    const query = state.query.trim();
    const searching = query.length > 0;

    const index = useMemo(() => buildFolderIndex(favorites), [favorites, vaultVersion]);
    const deepCounts = useMemo(() => buildDeepCounts(index), [index, vaultVersion]);
    const folders = searching ? [] : getChildFolders(state.folderId);

    const gifs = useMemo(() => {
        let list: FavGif[];
        if (searching) {
            const scope = collectSubtreeIds(state.folderId);
            list = favorites.filter(g => scope.has(getGifFolderId(g.url)) && matchesQuery(gifHaystack(g), query));
        } else {
            list = index.get(state.folderId) ?? [];
        }
        return sortGifs(list, state.sort, state.shuffleSeed);
    }, [favorites, index, state.folderId, state.sort, state.shuffleSeed, query, searching, vaultVersion]);

    const sendGif = useCallback((gif: FavGif) => {
        if (onSelectGif) {
            onSelectGif(gif);
            return;
        }
        const channelId = SelectedChannelStore.getChannelId();
        if (!channelId) {
            Toasts.show({ message: "Open a channel first!", type: Toasts.Type.FAILURE, id: Toasts.genId() });
            return;
        }
        sendMessage(channelId, { content: gif.url }, false);
    }, [onSelectGif]);

    const insertGif = useCallback((gif: FavGif) => {
        insertTextIntoChatInputBox(gif.url + " ");
        if (variant === "picker" && settings.store.closeOnSelect) {
            ExpressionPickerStore.closeExpressionPicker();
        }
    }, [variant]);

    const activateGif = useCallback((gif: FavGif) => {
        if (settings.store.clickAction === "send") sendGif(gif);
        else insertGif(gif);
    }, [sendGif, insertGif]);

    const navigate = useCallback((folderId: string | null) => {
        store.patch({ folderId, renamingId: null, query: "" });
    }, [store]);

    const backgroundDrop = useDropTarget(state.folderId);

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Backspace" && !(e.target as HTMLElement).matches("input, textarea")) {
            e.stopPropagation();
            if (state.folderId != null) {
                navigate(getFolder(state.folderId)?.parentId ?? null);
            }
        }
    };

    const showEmptyVault = !searching && state.folderId == null && favorites.length === 0 && folders.length === 0;

    return (
        <div className={classes(cl("explorer", `explorer-${variant}`), className)} onKeyDown={onKeyDown}>
            {variant === "popout" && <ExplorerToolbar store={store} variant="popout" />}
            <Breadcrumbs store={store} />

            <div
                {...backgroundDrop.props}
                className={cl("scroller", { "drop-ok": backgroundDrop.over })}
                style={{ "--vc-gifvault-tile": `${tileSize}px` } as CSSProperties}
                onContextMenu={e => {
                    e.preventDefault();
                    openBackgroundMenu(e, store, { showPopoutItem: variant === "picker" });
                }}
            >
                {folders.length > 0 && (
                    <>
                        <div className={cl("section-label")}>Folders · {folders.length}</div>
                        <div className={cl("folder-grid")}>
                            {folders.map((folder, i) => (
                                <FolderTile
                                    key={folder.id}
                                    folder={folder}
                                    index={i}
                                    count={deepCounts.get(folder.id) ?? 0}
                                    renaming={state.renamingId === folder.id}
                                    onOpen={navigate}
                                    onRenameCommit={(id, name) => {
                                        renameFolder(id, name);
                                        store.patch({ renamingId: null });
                                    }}
                                    onRenameCancel={() => store.patch({ renamingId: null })}
                                    onContextMenu={(e, f) => openFolderMenu(e, f, {
                                        navigate,
                                        beginRename: id => store.patch({ renamingId: id })
                                    })}
                                />
                            ))}
                        </div>
                    </>
                )}

                {gifs.length > 0 && (
                    <>
                        <div className={cl("section-label")}>
                            {searching ? `Results · ${gifs.length}` : `GIFs · ${gifs.length}`}
                        </div>
                        <div className={cl("gif-grid")}>
                            {gifs.map((gif, i) => (
                                <GifTile
                                    key={gif.url}
                                    gif={gif}
                                    index={i}
                                    showFolderChip={searching}
                                    onActivate={activateGif}
                                    onSend={sendGif}
                                    onNavigate={navigate}
                                    onContextMenu={(e, g) => openGifMenu(e, g, { send: sendGif, insert: insertGif })}
                                />
                            ))}
                        </div>
                    </>
                )}

                {showEmptyVault
                    ? (
                        <EmptyState
                            icon={<StarIcon size={44} />}
                            title="No favorite GIFs yet"
                            hint="Star some GIFs in Discord's GIF picker and they'll show up here, ready to organize."
                        />
                    )
                    : searching && gifs.length === 0
                        ? (
                            <EmptyState
                                icon={<SearchIcon size={44} />}
                                title={`No results for “${query}”`}
                                hint="Search covers names, #tags and URLs in this folder and all of its subfolders."
                            />
                        )
                        : !searching && folders.length === 0 && gifs.length === 0
                            ? (
                                <EmptyState
                                    icon={<FolderOpenIcon size={44} />}
                                    title="This folder is empty"
                                    hint="Drag GIFs or folders in, or right-click for options."
                                />
                            )
                            : null}
            </div>

            {showStatusBar && (
                <div className={cl("statusbar")}>
                    <span className={cl("statusbar-info")}>
                        {searching
                            ? `${gifs.length} result${gifs.length === 1 ? "" : "s"} for “${query}”`
                            : `${folders.length} folder${folders.length === 1 ? "" : "s"} · ${gifs.length} GIF${gifs.length === 1 ? "" : "s"}`}
                    </span>
                    <button className={cl("statusbar-sort")} onClick={e => openSortMenu(e, store)}>
                        <SortIcon size={11} />
                        {SORT_LABELS[state.sort]}
                    </button>
                </div>
            )}
        </div>
    );
}
