/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Message } from "@vencord/discord-types";
import { Parser, useEffect, useState } from "@webpack/common";

import { settings } from "./settings";
import { TranslateIcon } from "./TranslateIcon";
import { cl, getLanguages, getMessageContent, translate, TranslationValue } from "./utils";

interface TranslationSetter {
    messageId: string;
    handleTranslation(v: TranslationValue): void;
}

const TranslationSetters = new Set<TranslationSetter>();

export function handleTranslate(messageId: string, data: TranslationValue) {
    for (const setter of TranslationSetters) {
        if (setter.messageId === messageId) {
            setter.handleTranslation(data);
        }
    }
}

function Dismiss({ onDismiss }: { onDismiss: () => void; }) {
    return (
        <button
            onClick={onDismiss}
            className={cl("dismiss")}
        >
            Dismiss
        </button>
    );
}

export function TranslationAccessory({ message }: { message: Message; }) {
    const [translation, setTranslation] = useState<TranslationValue>();
    const { autoTranslateReceived } = settings.use(["autoTranslateReceived"]);

    useEffect(() => {
        // Ignore MessageLinkEmbeds messages
        if ((message as any).vencordEmbeddedBy) return;

        const setter: TranslationSetter = {
            messageId: message.id,
            handleTranslation: setTranslation
        };

        TranslationSetters.add(setter);
        return () => void TranslationSetters.delete(setter);
    }, []);

    // keyed on the setting so turning it on also translates the messages already on screen
    useEffect(() => {
        if (!autoTranslateReceived || (message as any).vencordEmbeddedBy) return;

        const content = getMessageContent(message);
        if (!content) return;

        let cancelled = false;
        translate("received", content).then(result => {
            if (cancelled) return;
            const targetLangName = getLanguages()[settings.store.receivedOutput];
            if (result.sourceLanguage !== targetLangName) {
                setTranslation(result);
            }
        }).catch(() => {});

        return () => void (cancelled = true);
    }, [autoTranslateReceived]);

    if (!translation) return null;

    return (
        <span className={cl("accessory")}>
            <TranslateIcon width={16} height={16} className={cl("accessory-icon")} />
            {Parser.parse(translation.text)}
            <br />
            (translated from {translation.sourceLanguage} - <Dismiss onDismiss={() => setTranslation(undefined)} />)
        </span>
    );
}
