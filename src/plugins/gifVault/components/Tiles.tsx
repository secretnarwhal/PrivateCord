/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "@plugins/gifVault/settings";
import { cl, isVideo, prettyGifName } from "@plugins/gifVault/utils";
import {
    canDropInto, clearActiveDrag, FavGif, getFolder, getGifFolderId, getGifMeta,
    performDrop, removeFavorite, setActiveDrag, VaultFolder
} from "@plugins/gifVault/vault";
import { copyWithToast } from "@utils/discord";
import { Tooltip, useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, DragEvent, MouseEvent } from "react";

import { CopyIcon, FolderIcon, SendIcon, UnstarIcon } from "./icons";

/** ms hovering a drop target before it "spring loads" (auto-navigates) like an OS file explorer */
const SPRING_LOAD_DELAY = 650;

export function QuickAction({ tooltip, onClick, children, danger }: {
    tooltip: string;
    onClick: (e: MouseEvent) => void;
    children: React.ReactNode;
    danger?: boolean;
}) {
    return (
        <Tooltip text={tooltip}>
            {props => (
                <button
                    {...props}
                    className={cl("qa-btn", { "qa-danger": danger })}
                    onClick={e => {
                        e.stopPropagation();
                        onClick(e);
                    }}
                >
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

function LazyMedia({ gif, shouldPlay }: { gif: FavGif; shouldPlay: boolean; }) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    setVisible(true);
                    observer.disconnect();
                }
            }
        }, { rootMargin: "250px" });
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (shouldPlay) video.play().catch(() => { });
        else {
            video.pause();
            video.currentTime = 0;
        }
    }, [shouldPlay, visible]);

    return (
        <div ref={wrapRef} className={cl("media")}>
            {!visible
                ? <div className={cl("media-placeholder")} />
                : isVideo(gif)
                    ? (
                        <video
                            ref={videoRef}
                            className={cl("media-el")}
                            src={gif.src}
                            muted
                            loop
                            playsInline
                            autoPlay={shouldPlay}
                            preload="metadata"
                            draggable={false}
                        />
                    )
                    : <img className={cl("media-el")} src={gif.src} alt="" loading="lazy" draggable={false} />}
        </div>
    );
}

export interface GifTileProps {
    gif: FavGif;
    index: number;
    /** show which folder the gif lives in (used in search results) */
    showFolderChip?: boolean;
    onActivate(gif: FavGif): void;
    onSend(gif: FavGif): void;
    onNavigate(folderId: string | null): void;
    onContextMenu(e: MouseEvent, gif: FavGif): void;
}

export function GifTile({ gif, index, showFolderChip, onActivate, onSend, onNavigate, onContextMenu }: GifTileProps) {
    const [hovered, setHovered] = useState(false);
    const [dragging, setDragging] = useState(false);

    const meta = getGifMeta(gif.url);
    const name = prettyGifName(gif, meta);
    const folder = showFolderChip ? getFolder(getGifFolderId(gif.url)) : undefined;
    const tags = meta?.tags ?? [];

    const onDragStart = (e: DragEvent) => {
        setActiveDrag({ kind: "gif", url: gif.url });
        setDragging(true);
        e.dataTransfer.effectAllowed = "copyMove";
        // plain text + uri-list so dropping onto Discord's chat box inserts the link
        e.dataTransfer.setData("text/plain", gif.url);
        e.dataTransfer.setData("text/uri-list", gif.url);
    };

    const onDragEnd = () => {
        clearActiveDrag();
        setDragging(false);
    };

    const playAll = !settings.store.playOnHoverOnly;

    return (
        <div
            className={cl("gif-tile", { "tile-dragging": dragging })}
            style={{ "--vc-gv-delay": `${Math.min(index, 24) * 16}ms` } as CSSProperties}
            role="button"
            tabIndex={-1}
            aria-label={name}
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={() => onActivate(gif)}
            onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, gif);
            }}
        >
            <LazyMedia gif={gif} shouldPlay={playAll || hovered} />

            <div className={cl("tile-overlay")}>
                <div className={cl("tile-name")}>{name}</div>
                {(folder || tags.length > 0) && (
                    <div className={cl("tile-chips")}>
                        {folder && (
                            <button
                                className={cl("chip", "chip-folder")}
                                onClick={e => {
                                    e.stopPropagation();
                                    onNavigate(folder.id);
                                }}
                            >
                                <FolderIcon size={10} style={{ color: folder.color ?? "var(--vc-gv-accent)" }} />
                                {folder.name}
                            </button>
                        )}
                        {tags.slice(0, 2).map(tag => (
                            <span key={tag} className={cl("chip")}>#{tag}</span>
                        ))}
                    </div>
                )}
            </div>

            <div className={cl("tile-actions")}>
                <QuickAction tooltip="Send now" onClick={() => onSend(gif)}>
                    <SendIcon size={13} />
                </QuickAction>
                <QuickAction tooltip="Copy link" onClick={() => copyWithToast(gif.url, "Link copied!")}>
                    <CopyIcon size={13} />
                </QuickAction>
                <QuickAction danger tooltip="Remove from favorites" onClick={() => removeFavorite(gif.url)}>
                    <UnstarIcon size={13} />
                </QuickAction>
            </div>
        </div>
    );
}

export interface FolderTileProps {
    folder: VaultFolder;
    /** gif count including subfolders */
    count: number;
    index: number;
    renaming: boolean;
    onOpen(id: string): void;
    onRenameCommit(id: string, name: string): void;
    onRenameCancel(): void;
    onContextMenu(e: MouseEvent, folder: VaultFolder): void;
}

export function FolderTile({ folder, count, index, renaming, onOpen, onRenameCommit, onRenameCancel, onContextMenu }: FolderTileProps) {
    const [dragOver, setDragOver] = useState(0);
    const [dragging, setDragging] = useState(false);
    const springTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const clearSpring = () => {
        clearTimeout(springTimer.current);
        springTimer.current = undefined;
    };

    useEffect(() => clearSpring, []);

    const onDragStart = (e: DragEvent) => {
        if (renaming) {
            e.preventDefault();
            return;
        }
        setActiveDrag({ kind: "folder", folderId: folder.id });
        setDragging(true);
        // chromium refuses to start a drag without any payload
        e.dataTransfer.setData("application/x-gifvault-folder", folder.id);
        e.dataTransfer.effectAllowed = "move";
    };

    const onDragEnd = () => {
        clearActiveDrag();
        setDragging(false);
        clearSpring();
    };

    const onDragEnter = (e: DragEvent) => {
        if (!canDropInto(folder.id)) return;
        e.preventDefault();
        setDragOver(c => c + 1);
        // hovering a folder while dragging opens it after a moment, like OS explorers
        if (!springTimer.current) {
            springTimer.current = setTimeout(() => onOpen(folder.id), SPRING_LOAD_DELAY);
        }
    };

    const onDragOver = (e: DragEvent) => {
        if (!canDropInto(folder.id)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
    };

    const onDragLeave = () => {
        setDragOver(c => Math.max(0, c - 1));
        clearSpring();
    };

    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(0);
        clearSpring();
        performDrop(folder.id);
        clearActiveDrag();
    };

    return (
        <div
            className={cl("folder-card", {
                "drop-ok": dragOver > 0,
                "tile-dragging": dragging
            })}
            style={{
                "--vc-gv-folder-c": folder.color ?? "var(--vc-gv-accent)",
                "--vc-gv-delay": `${Math.min(index, 24) * 16}ms`
            } as CSSProperties}
            role="button"
            tabIndex={-1}
            aria-label={`Folder: ${folder.name}`}
            draggable={!renaming}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => !renaming && onOpen(folder.id)}
            onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, folder);
            }}
        >
            <div className={cl("folder-glyph")}>
                {count > 0 && <span className={cl("folder-count")}>{count > 999 ? "999+" : count}</span>}
            </div>
            {renaming
                ? (
                    <input
                        className={cl("folder-rename")}
                        defaultValue={folder.name}
                        autoFocus
                        onFocus={e => e.currentTarget.select()}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                            e.stopPropagation();
                            if (e.key === "Enter") onRenameCommit(folder.id, e.currentTarget.value);
                            else if (e.key === "Escape") onRenameCancel();
                        }}
                        onBlur={e => onRenameCommit(folder.id, e.currentTarget.value)}
                    />
                )
                : <div className={cl("folder-name")}>{folder.name}</div>}
        </div>
    );
}
