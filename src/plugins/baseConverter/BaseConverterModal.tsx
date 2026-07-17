/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
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

import { BaseText } from "@components/BaseText";
import { Divider } from "@components/Divider";
import { FormSwitch } from "@components/FormSwitch";
import { Margins } from "@utils/margins";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, openModal } from "@utils/modal";
import { Forms, SearchableSelect } from "@webpack/common";

import { settings } from "./settings";
import { cl, DECODE_OPTIONS, ENCODE_OPTIONS } from "./utils";

function EncodingSelect({
    label,
    settingsKey,
    options,
}: {
    label: string;
    settingsKey: "receiveEncoding" | "sendEncoding";
    options: typeof DECODE_OPTIONS | typeof ENCODE_OPTIONS;
}) {
    const currentValue = settings.use([settingsKey])[settingsKey];

    return (
        <section className={Margins.bottom16}>
            <Forms.FormTitle tag="h3">{label}</Forms.FormTitle>
            <SearchableSelect
                options={options}
                value={currentValue}
                placeholder="Select an encoding"
                maxVisibleItems={9}
                closeOnSelect={true}
                onChange={v => (settings.store[settingsKey] = v)}
            />
        </section>
    );
}

function AutoDecodeToggle() {
    const value = settings.use(["autoDecodeReceived"]).autoDecodeReceived;
    return (
        <FormSwitch
            title="Auto-Decode Received Messages"
            description="Automatically decode incoming messages using the receive encoding above"
            value={value}
            onChange={v => (settings.store.autoDecodeReceived = v)}
            hideBorder
        />
    );
}

function AutoEncodeToggle() {
    const value = settings.use(["autoEncodeOutgoing"]).autoEncodeOutgoing;
    return (
        <FormSwitch
            title="Auto-Encode Outgoing Messages"
            description="Automatically encode your messages before sending using the send encoding above"
            value={value}
            onChange={v => (settings.store.autoEncodeOutgoing = v)}
            hideBorder
        />
    );
}

function BaseConverterModal({ rootProps }: { rootProps: ModalProps; }) {
    return (
        <ModalRoot {...rootProps}>
            <ModalHeader className={cl("modal-header")}>
                <BaseText tag="h2" size="lg" weight="semibold" className={cl("modal-title")}>
                    Base Converter
                </BaseText>
                <ModalCloseButton onClick={rootProps.onClose} />
            </ModalHeader>

            <ModalContent className={cl("modal-content")}>
                <EncodingSelect
                    label="Decode received messages from"
                    settingsKey="receiveEncoding"
                    options={DECODE_OPTIONS}
                />

                <EncodingSelect
                    label="Encode sent messages to"
                    settingsKey="sendEncoding"
                    options={ENCODE_OPTIONS}
                />

                <Divider className={Margins.bottom16} />

                <AutoDecodeToggle />
                <AutoEncodeToggle />
            </ModalContent>
        </ModalRoot>
    );
}

export function openBaseConverterModal() {
    openModal(props => <BaseConverterModal rootProps={props} />);
}
