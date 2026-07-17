/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { cl, isVideo, prettyGifName } from "@plugins/gifVault/utils";
import { FavGif, getGifMeta, setGifDetails } from "@plugins/gifVault/vault";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, TextInput, useState } from "@webpack/common";

function EditGifModal({ modalProps, gif }: { modalProps: RenderModalProps; gif: FavGif; }) {
    const meta = getGifMeta(gif.url);
    const [title, setTitle] = useState(meta?.title ?? "");
    const [tags, setTags] = useState((meta?.tags ?? []).join(", "));

    const save = () => {
        setGifDetails(gif.url, {
            title: title.trim() || undefined,
            tags: tags.split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean)
        });
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Edit GIF details"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Save", variant: "primary", onClick: save }
            ]}
        >
            <div className={cl("modal-preview")}>
                {isVideo(gif)
                    ? <video src={gif.src} muted loop autoPlay playsInline />
                    : <img src={gif.src} alt="" />}
            </div>
            <HeadingTertiary>Display name</HeadingTertiary>
            <TextInput
                value={title}
                onChange={setTitle}
                placeholder={prettyGifName(gif, undefined)}
                autoFocus
            />
            <HeadingTertiary className={cl("modal-tags-title")}>Tags</HeadingTertiary>
            <TextInput
                value={tags}
                onChange={setTags}
                placeholder="reaction, cat, dance"
            />
            <Paragraph className={cl("modal-hint")}>
                Comma separated. The name, tags and URL are all searchable in the explorer.
            </Paragraph>
        </Modal>
    );
}

export function openEditGifModal(gif: FavGif) {
    openModal(props => <EditGifModal modalProps={props} gif={gif} />);
}
