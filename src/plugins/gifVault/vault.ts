/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { get as dsGet, set as dsSet } from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { Toasts, useEffect, useMemo, UserSettingsActionCreators, UserSettingsProtoStore, useState, useStateFromStores } from "@webpack/common";

import { settings } from "./settings";

const logger = new Logger("GifVault");

const VAULT_KEY = "GifVault_vault";
const GEOMETRY_KEY = "GifVault_popoutGeometry";

// #region Types

export interface VaultFolder {
    id: string;
    name: string;
    /** null = default accent color */
    color: string | null;
    /** null = lives at the root */
    parentId: string | null;
    createdAt: number;
}

export interface GifMeta {
    /** null/undefined = root */
    folderId?: string | null;
    /** custom display name, searchable */
    title?: string;
    /** custom tags, searchable */
    tags?: string[];
}

/** A favorited gif, straight out of Discord's frecency user settings proto */
export interface FavGif {
    url: string;
    src: string;
    /** 1 = image, 2 = video */
    format: number;
    width: number;
    height: number;
    /** star order; higher = more recently favorited */
    order: number;
}

export interface PopoutGeometry {
    x: number;
    y: number;
    w: number;
    h: number;
}

interface VaultData {
    version: 1;
    folders: VaultFolder[];
    gifs: Record<string, GifMeta>;
}

// #endregion

// #region Vault storage (folders + gif metadata)

let data: VaultData = { version: 1, folders: [], gifs: {} };
let vaultLoaded = false;
let version = 0;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
    version++;
    for (const l of listeners) l();
}

function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(
        () => dsSet(VAULT_KEY, data).catch(e => logger.error("Failed to save vault", e)),
        400
    );
}

function mutated() {
    emit();
    persist();
}

export async function preloadVault() {
    try {
        const stored = await dsGet<VaultData>(VAULT_KEY);
        if (stored?.folders) {
            data = { version: 1, folders: stored.folders, gifs: stored.gifs ?? {} };
        }
        popoutGeometry = await dsGet<PopoutGeometry>(GEOMETRY_KEY) ?? null;
    } catch (e) {
        logger.error("Failed to load vault", e);
    }
    vaultLoaded = true;
    emit();
}

/** Re-renders the caller whenever folders or gif metadata change. Returns a change counter. */
export function useVault(): number {
    const [v, setV] = useState(version);
    useEffect(() => {
        const l = () => setV(version);
        listeners.add(l);
        l();
        return () => void listeners.delete(l);
    }, []);
    return v;
}

// #endregion

// #region Folder accessors

export function getFolder(id: string | null | undefined): VaultFolder | undefined {
    if (id == null) return undefined;
    return data.folders.find(f => f.id === id);
}

export function getChildFolders(parentId: string | null): VaultFolder[] {
    return data.folders
        .filter(f => f.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Path from the root down to (and including) the given folder */
export function getFolderPath(id: string | null): VaultFolder[] {
    const path: VaultFolder[] = [];
    let cur = getFolder(id);
    let guard = 0;
    while (cur && guard++ < 100) {
        path.unshift(cur);
        cur = getFolder(cur.parentId);
    }
    return path;
}

/** Is `folderId` equal to `rootId` or somewhere inside its subtree? */
export function isInSubtree(folderId: string, rootId: string): boolean {
    let cur: VaultFolder | undefined = getFolder(folderId);
    let guard = 0;
    while (cur && guard++ < 100) {
        if (cur.id === rootId) return true;
        cur = getFolder(cur.parentId);
    }
    return false;
}

export function getGifMeta(url: string): GifMeta | undefined {
    return data.gifs[url];
}

/** The folder a gif lives in, resolving deleted folders back to the root */
export function getGifFolderId(url: string): string | null {
    const id = data.gifs[url]?.folderId ?? null;
    return id != null && getFolder(id) ? id : null;
}

// #endregion

// #region Mutations

function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uniqueFolderName(base: string, parentId: string | null): string {
    const siblings = new Set(getChildFolders(parentId).map(f => f.name.toLowerCase()));
    if (!siblings.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
        const name = `${base} (${i})`;
        if (!siblings.has(name.toLowerCase())) return name;
    }
}

export function createFolder(parentId: string | null, name = "New Folder"): VaultFolder {
    const folder: VaultFolder = {
        id: newId(),
        name: uniqueFolderName(name.trim() || "New Folder", parentId),
        color: null,
        parentId: parentId != null && getFolder(parentId) ? parentId : null,
        createdAt: Date.now()
    };
    data.folders.push(folder);
    mutated();
    return folder;
}

export function renameFolder(id: string, name: string) {
    const folder = getFolder(id);
    const trimmed = name.trim();
    if (!folder || !trimmed || folder.name === trimmed) return;
    folder.name = trimmed;
    mutated();
}

export function setFolderColor(id: string, color: string | null) {
    const folder = getFolder(id);
    if (!folder) return;
    folder.color = color;
    mutated();
}

/** Move a folder into another folder (or the root). Refuses cycles. */
export function moveFolder(id: string, newParentId: string | null): boolean {
    const folder = getFolder(id);
    if (!folder) return false;
    if (newParentId === folder.parentId) return false;
    if (newParentId != null) {
        if (!getFolder(newParentId)) return false;
        // dropping a folder into itself or its own subtree would orphan the whole branch
        if (isInSubtree(newParentId, id)) return false;
    }
    folder.parentId = newParentId;
    folder.name = uniqueFolderName(folder.name, newParentId);
    mutated();
    return true;
}

/** Delete a folder; its subfolders and gifs are moved up into its parent. */
export function deleteFolder(id: string) {
    const folder = getFolder(id);
    if (!folder) return;
    const { parentId } = folder;
    for (const f of data.folders) {
        if (f.parentId === id) f.parentId = parentId;
    }
    for (const meta of Object.values(data.gifs)) {
        if (meta.folderId === id) meta.folderId = parentId;
    }
    data.folders = data.folders.filter(f => f.id !== id);
    mutated();
}

export function setGifFolder(url: string, folderId: string | null) {
    const meta = data.gifs[url] ?? {};
    meta.folderId = folderId ?? undefined;
    if (folderId == null) delete meta.folderId;
    if (Object.keys(meta).length === 0) delete data.gifs[url];
    else data.gifs[url] = meta;
    mutated();
}

export function setGifDetails(url: string, details: { title?: string; tags?: string[]; }) {
    const meta = data.gifs[url] ?? {};
    if (details.title) meta.title = details.title;
    else delete meta.title;
    if (details.tags?.length) meta.tags = details.tags;
    else delete meta.tags;
    if (Object.keys(meta).length === 0) delete data.gifs[url];
    else data.gifs[url] = meta;
    mutated();
}

/** Drop metadata for gifs that are no longer favorited */
export function pruneVault(existingUrls: Set<string>) {
    if (!vaultLoaded || existingUrls.size === 0) return;
    let changed = false;
    for (const url of Object.keys(data.gifs)) {
        if (!existingUrls.has(url)) {
            delete data.gifs[url];
            changed = true;
        }
    }
    if (changed) mutated();
}

// #endregion

// #region Discord favorites bridge

function readRawFavorites(): Record<string, any> | null {
    try {
        return (UserSettingsProtoStore as any)?.frecencyWithoutFetchingLatest?.favoriteGifs?.gifs ?? null;
    } catch {
        return null;
    }
}

function toFavList(raw: Record<string, any> | null): FavGif[] {
    if (!raw) return [];
    return Object.entries(raw).map(([url, gif]: [string, any]) => ({
        url,
        src: gif?.src ?? url,
        format: gif?.format ?? 1,
        width: gif?.width ?? 0,
        height: gif?.height ?? 0,
        order: gif?.order ?? 0
    }));
}

export function getFavoriteGifs(): FavGif[] {
    return toFavList(readRawFavorites());
}

export function useFavoriteGifs(): FavGif[] {
    const raw = useStateFromStores([UserSettingsProtoStore as any], () => readRawFavorites());
    return useMemo(() => toFavList(raw), [raw]);
}

export function removeFavorite(url: string) {
    try {
        const creators = (UserSettingsActionCreators as any)?.FrecencyUserSettingsActionCreators;
        if (typeof creators?.updateAsync !== "function") throw new Error("FrecencyUserSettingsActionCreators unavailable");
        creators.updateAsync("favoriteGifs", (favoriteGifs: any) => {
            if (favoriteGifs?.gifs?.[url] != null) delete favoriteGifs.gifs[url];
        }, 0);
        Toasts.show({ message: "Removed from favorites", type: Toasts.Type.SUCCESS, id: Toasts.genId() });
    } catch (e) {
        logger.error("Failed to remove favorite", e);
        Toasts.show({ message: "Failed to remove favorite", type: Toasts.Type.FAILURE, id: Toasts.genId() });
    }
}

// #endregion

// #region Drag state

export type DragPayload =
    | { kind: "gif"; url: string; }
    | { kind: "folder"; folderId: string; };

export let activeDrag: DragPayload | null = null;

export function setActiveDrag(payload: DragPayload) {
    activeDrag = payload;
}

export function clearActiveDrag() {
    activeDrag = null;
}

/** Would dropping the currently dragged item into `target` do anything sensible? */
export function canDropInto(target: string | null): boolean {
    const drag = activeDrag;
    if (!drag) return false;
    if (drag.kind === "gif") return getGifFolderId(drag.url) !== target;

    if (drag.folderId === target) return false;
    const folder = getFolder(drag.folderId);
    if (!folder) return false;
    if (folder.parentId === target) return false;
    if (target != null && isInSubtree(target, drag.folderId)) return false;
    return true;
}

export function performDrop(target: string | null) {
    const drag = activeDrag;
    if (!drag || !canDropInto(target)) return;
    if (drag.kind === "gif") setGifFolder(drag.url, target);
    else moveFolder(drag.folderId, target);
}

// #endregion

// #region Explorer UI state (shared between the picker header + content trees)

export type SortMode = "recent" | "oldest" | "name-az" | "name-za" | "shuffle";

export interface ExplorerState {
    folderId: string | null;
    query: string;
    sort: SortMode;
    renamingId: string | null;
    shuffleSeed: number;
}

export interface ExplorerStore {
    get(): ExplorerState;
    patch(partial: Partial<ExplorerState>): void;
    subscribe(cb: () => void): () => void;
}

function createExplorerStore(): ExplorerStore {
    let state: ExplorerState | null = null;
    const subs = new Set<() => void>();

    // settings.store cannot be touched at module init (plugin not started yet), so
    // the initial state is materialized on first access instead
    const init = (): ExplorerState => {
        let sort: SortMode = "recent";
        try {
            sort = settings.store.sortMode as SortMode;
        } catch { }
        return { folderId: null, query: "", sort, renamingId: null, shuffleSeed: Date.now() };
    };

    return {
        get: () => (state ??= init()),
        patch(partial) {
            state = { ...this.get(), ...partial };
            if (partial.sort) {
                try {
                    settings.store.sortMode = partial.sort;
                } catch { }
            }
            for (const cb of subs) cb();
        },
        subscribe(cb) {
            subs.add(cb);
            return () => void subs.delete(cb);
        }
    };
}

/** navigation state of the explorer embedded in Discord's gif picker */
export const pickerExplorer = createExplorerStore();
/** navigation state of the floating popout window (independent of the picker) */
export const popoutExplorer = createExplorerStore();

export function useExplorerState(store: ExplorerStore): ExplorerState {
    const [s, setS] = useState(store.get);
    useEffect(() => {
        setS(store.get());
        return store.subscribe(() => setS(store.get()));
    }, [store]);
    return s;
}

// #endregion

// #region Popout window state

export let popoutGeometry: PopoutGeometry | null = null;

export function savePopoutGeometry(geometry: PopoutGeometry) {
    popoutGeometry = geometry;
    dsSet(GEOMETRY_KEY, geometry).catch(e => logger.error("Failed to save popout geometry", e));
}

let popoutOpen = false;
const popoutSubs = new Set<() => void>();

export function setPopoutOpen(open: boolean) {
    if (popoutOpen === open) return;
    popoutOpen = open;
    for (const cb of popoutSubs) cb();
}

export function togglePopout() {
    setPopoutOpen(!popoutOpen);
}

export function usePopoutOpen(): boolean {
    const [open, setOpen] = useState(popoutOpen);
    useEffect(() => {
        setOpen(popoutOpen);
        const cb = () => setOpen(popoutOpen);
        popoutSubs.add(cb);
        return () => void popoutSubs.delete(cb);
    }, []);
    return open;
}

// #endregion
