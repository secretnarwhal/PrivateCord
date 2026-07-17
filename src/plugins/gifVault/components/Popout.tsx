/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { cl, clamp } from "@plugins/gifVault/utils";
import { popoutExplorer, popoutGeometry, savePopoutGeometry, setPopoutOpen, usePopoutOpen } from "@plugins/gifVault/vault";
import { Tooltip, useCallback, useEffect, useMemo, useRef } from "@webpack/common";
import type { PointerEvent } from "react";

import { Explorer } from "./Explorer";
import { CloseIcon, FolderIcon } from "./icons";

function PopoutWindow() {
    const rootRef = useRef<HTMLDivElement>(null);

    const geometry = useMemo(() => {
        const stored = popoutGeometry;
        const w = clamp(stored?.w ?? 520, 360, window.innerWidth - 24);
        const h = clamp(stored?.h ?? 640, 320, window.innerHeight - 24);
        const x = clamp(stored?.x ?? window.innerWidth - w - 40, 80 - w, window.innerWidth - 80);
        const y = clamp(stored?.y ?? 56, 0, window.innerHeight - 56);
        return { x, y, w, h };
    }, []);

    const persistGeometry = useCallback(() => {
        const el = rootRef.current;
        if (!el) return;
        savePopoutGeometry({
            x: el.offsetLeft,
            y: el.offsetTop,
            w: el.offsetWidth,
            h: el.offsetHeight
        });
    }, []);

    // the window is resized via native CSS `resize`; persist the size when it settles
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        let timer: ReturnType<typeof setTimeout>;
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(persistGeometry, 500);
        });
        observer.observe(el);
        return () => {
            clearTimeout(timer);
            observer.disconnect();
        };
    }, [persistGeometry]);

    const onTitlebarPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const el = rootRef.current;
        if (!el) return;
        if ((e.target as HTMLElement).closest("button, input")) return;
        e.preventDefault();

        const offsetX = e.clientX - el.offsetLeft;
        const offsetY = e.clientY - el.offsetTop;

        const onMove = (ev: globalThis.PointerEvent) => {
            el.style.left = clamp(ev.clientX - offsetX, 80 - el.offsetWidth, window.innerWidth - 80) + "px";
            el.style.top = clamp(ev.clientY - offsetY, 0, window.innerHeight - 40) + "px";
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            persistGeometry();
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp, { once: true });
    };

    return (
        <div
            ref={rootRef}
            className={cl("popout")}
            style={{ left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h }}
            role="dialog"
            aria-label="GIF Vault"
        >
            <div className={cl("popout-titlebar")} onPointerDown={onTitlebarPointerDown}>
                <div className={cl("popout-badge")}>
                    <FolderIcon size={13} />
                </div>
                <span className={cl("popout-title")}>GIF Vault</span>
                <span className={cl("popout-subtitle")}>drag GIFs into chat</span>
                <div className={cl("popout-spacer")} />
                <Tooltip text="Close">
                    {props => (
                        <button {...props} className={cl("icon-btn")} onClick={() => setPopoutOpen(false)}>
                            <CloseIcon size={15} />
                        </button>
                    )}
                </Tooltip>
            </div>
            <Explorer store={popoutExplorer} variant="popout" />
        </div>
    );
}

export function PopoutHost() {
    const open = usePopoutOpen();
    if (!open) return null;
    return <PopoutWindow />;
}
