/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cl, FOLDER_COLORS, SORT_LABELS, SORT_MODES } from "@plugins/gifVault/utils";
import {
    createFolder, deleteFolder, ExplorerStore, FavGif, getChildFolders,
    getGifFolderId, moveFolder, removeFavorite, setFolderColor, setGifFolder,
    setPopoutOpen, VaultFolder
} from "@plugins/gifVault/vault";
import { copyWithToast } from "@utils/discord";
import { Alerts, ContextMenuApi, Menu } from "@webpack/common";
import type { MouseEvent, ReactNode } from "react";

import { openEditGifModal } from "./EditGifModal";
import {
    CopyIcon, FolderIcon, FolderOpenIcon, LinkIcon, NewFolderIcon, PencilIcon,
    PopoutIcon, SendIcon, SortIcon, TrashIcon, UnstarIcon
} from "./icons";

function ColorDot({ color }: { color: string | null; }) {
    return <span className={cl("color-dot")} style={{ background: color ?? "var(--vc-gv-accent, #5865f2)" }} />;
}

/** Recursive folder tree as submenu items; used by "Move to" */
function moveTargetItems(opts: {
    idPrefix: string;
    currentId: string | null;
    excludeSubtreeOf?: string;
    onMove(target: string | null): void;
}): ReactNode[] {
    const renderLevel = (parentId: string | null): ReactNode[] =>
        getChildFolders(parentId)
            .filter(f => f.id !== opts.excludeSubtreeOf)
            .map(f => {
                const children = renderLevel(f.id);
                return (
                    <Menu.MenuItem
                        key={f.id}
                        id={`${opts.idPrefix}-${f.id}`}
                        label={f.name}
                        disabled={f.id === opts.currentId}
                        icon={() => <ColorDot color={f.color} />}
                        action={() => opts.onMove(f.id)}
                    >
                        {children.length > 0 ? children : null}
                    </Menu.MenuItem>
                );
            });

    return [
        <Menu.MenuItem
            key="root"
            id={`${opts.idPrefix}-root`}
            label="Home (top level)"
            disabled={opts.currentId === null}
            icon={FolderOpenIcon}
            action={() => opts.onMove(null)}
        />,
        <Menu.MenuSeparator key="sep" />,
        ...renderLevel(null)
    ];
}

function sortItems(store: ExplorerStore) {
    const { sort } = store.get();
    return SORT_MODES.map(mode => (
        <Menu.MenuRadioItem
            key={mode}
            id={`vc-gifvault-sort-${mode}`}
            group="vc-gifvault-sort"
            label={SORT_LABELS[mode]}
            checked={sort === mode}
            action={() => store.patch({ sort: mode, shuffleSeed: Date.now() })}
        />
    ));
}

export function openSortMenu(e: MouseEvent, store: ExplorerStore) {
    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu navId="vc-gifvault-sort-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Sort GIFs">
            {sortItems(store)}
        </Menu.Menu>
    ));
}

export interface GifMenuCtx {
    send(gif: FavGif): void;
    insert(gif: FavGif): void;
}

export function openGifMenu(e: MouseEvent, gif: FavGif, ctx: GifMenuCtx) {
    const currentFolderId = getGifFolderId(gif.url);

    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu navId="vc-gifvault-gif-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="GIF actions">
            <Menu.MenuItem id="vc-gifvault-send" label="Send now" icon={SendIcon} action={() => ctx.send(gif)} />
            <Menu.MenuItem id="vc-gifvault-insert" label="Insert into chat box" icon={PencilIcon} action={() => ctx.insert(gif)} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-gifvault-move" label="Move to" icon={FolderIcon}>
                {moveTargetItems({
                    idPrefix: "vc-gifvault-move",
                    currentId: currentFolderId,
                    onMove: target => setGifFolder(gif.url, target)
                })}
            </Menu.MenuItem>
            <Menu.MenuItem id="vc-gifvault-edit" label="Edit name & tags" icon={PencilIcon} action={() => openEditGifModal(gif)} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-gifvault-copy" label="Copy link" icon={CopyIcon} action={() => copyWithToast(gif.url, "Link copied!")} />
            <Menu.MenuItem id="vc-gifvault-open" label="Open in browser" icon={LinkIcon} action={() => window.open(gif.url, "_blank")} />
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-gifvault-unfav"
                label="Remove from favorites"
                color="danger"
                icon={UnstarIcon}
                action={() => Alerts.show({
                    title: "Remove from favorites?",
                    body: "This unstars the GIF in Discord itself. Its GifVault name, tags and folder are forgotten too.",
                    confirmText: "Remove",
                    cancelText: "Cancel",
                    onConfirm: () => removeFavorite(gif.url)
                })}
            />
        </Menu.Menu>
    ));
}

export interface FolderMenuCtx {
    navigate(folderId: string | null): void;
    beginRename(folderId: string): void;
}

export function openFolderMenu(e: MouseEvent, folder: VaultFolder, ctx: FolderMenuCtx) {
    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu navId="vc-gifvault-folder-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Folder actions">
            <Menu.MenuItem id="vc-gifvault-open-folder" label="Open" icon={FolderOpenIcon} action={() => ctx.navigate(folder.id)} />
            <Menu.MenuItem
                id="vc-gifvault-new-sub"
                label="New subfolder"
                icon={NewFolderIcon}
                action={() => {
                    const sub = createFolder(folder.id);
                    ctx.navigate(folder.id);
                    ctx.beginRename(sub.id);
                }}
            />
            <Menu.MenuItem id="vc-gifvault-rename" label="Rename" icon={PencilIcon} action={() => ctx.beginRename(folder.id)} />
            <Menu.MenuItem id="vc-gifvault-color" label="Color" icon={() => <ColorDot color={folder.color} />}>
                {FOLDER_COLORS.map(({ label, value }) => (
                    <Menu.MenuRadioItem
                        key={label}
                        id={`vc-gifvault-color-${label}`}
                        group="vc-gifvault-folder-color"
                        label={label}
                        checked={folder.color === value}
                        icon={() => <ColorDot color={value} />}
                        action={() => setFolderColor(folder.id, value)}
                    />
                ))}
            </Menu.MenuItem>
            <Menu.MenuItem id="vc-gifvault-move-folder" label="Move to" icon={FolderIcon}>
                {moveTargetItems({
                    idPrefix: "vc-gifvault-move-folder",
                    currentId: folder.parentId,
                    excludeSubtreeOf: folder.id,
                    onMove: target => moveFolder(folder.id, target)
                })}
            </Menu.MenuItem>
            <Menu.MenuSeparator />
            <Menu.MenuItem
                id="vc-gifvault-delete"
                label="Delete folder"
                color="danger"
                icon={TrashIcon}
                action={() => Alerts.show({
                    title: `Delete “${folder.name}”?`,
                    body: "Everything inside (GIFs and subfolders) moves up one level. Your GIFs stay favorited.",
                    confirmText: "Delete",
                    cancelText: "Cancel",
                    onConfirm: () => deleteFolder(folder.id)
                })}
            />
        </Menu.Menu>
    ));
}

export function openBackgroundMenu(e: MouseEvent, store: ExplorerStore, opts: { showPopoutItem: boolean; }) {
    ContextMenuApi.openContextMenu(e, () => (
        <Menu.Menu navId="vc-gifvault-bg-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Explorer actions">
            <Menu.MenuItem
                id="vc-gifvault-bg-new-folder"
                label="New folder"
                icon={NewFolderIcon}
                action={() => {
                    const folder = createFolder(store.get().folderId);
                    store.patch({ renamingId: folder.id, query: "" });
                }}
            />
            <Menu.MenuItem id="vc-gifvault-bg-sort" label="Sort by" icon={SortIcon}>
                {sortItems(store)}
            </Menu.MenuItem>
            {opts.showPopoutItem && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem
                        id="vc-gifvault-bg-popout"
                        label="Open popout window"
                        icon={PopoutIcon}
                        action={() => setPopoutOpen(true)}
                    />
                </>
            )}
        </Menu.Menu>
    ));
}
