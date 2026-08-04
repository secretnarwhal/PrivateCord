/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ParsedMember } from "@plugins/ircChat/irc/protocol";
import { cl, nickColor } from "@plugins/ircChat/utils";

const PREFIX_TITLES: Record<string, string> = {
    "~": "Owner",
    "&": "Admin",
    "@": "Operator",
    "%": "Half-operator",
    "+": "Voiced"
};

export function MemberList({ members, self }: { members: ParsedMember[]; self: string; }) {
    return (
        <div className={cl("members")}>
            <div className={cl("members-header")}>
                {members.length} {members.length === 1 ? "user" : "users"}
            </div>
            <div className={cl("members-list")}>
                {members.map(member => (
                    <div
                        key={member.nick}
                        className={cl(
                            "member",
                            member.nick.toLowerCase() === self.toLowerCase() && "member-self"
                        )}
                        title={member.prefix ? PREFIX_TITLES[member.prefix] : undefined}
                    >
                        <span className={cl("member-prefix")}>{member.prefix}</span>
                        <span className={cl("member-nick")} style={{ color: nickColor(member.nick) }}>
                            {member.nick}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
