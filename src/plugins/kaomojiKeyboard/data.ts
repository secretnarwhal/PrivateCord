/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface Kaomoji {
    /** the literal text that gets typed into the chat box */
    text: string;
    /**
     * What it's called. Searching the kaomoji itself is useless — nobody types
     * "ʕ•ᴥ•ʔ" to find a bear — so every built-in carries a name to match on.
     */
    name: string;
}

export interface KaomojiCategory {
    id: string;
    label: string;
    items: Kaomoji[];
}

const k = (text: string, name: string): Kaomoji => ({ text, name });

export const CATEGORIES: KaomojiCategory[] = [
    {
        id: "joy",
        label: "Joy",
        items: [
            k("(◕‿◕)", "happy"),
            k("(´∀｀)", "grin"),
            k("(＾▽＾)", "cheerful"),
            k("(・∀・)", "pleased"),
            k("ヽ(´▽`)/", "cheer"),
            k("\\(^o^)/", "hooray"),
            k("٩(◕‿◕)۶", "excited"),
            k("(≧◡≦)", "delighted"),
            k("(☆▽☆)", "starry eyes"),
            k("(⌒▽⌒)", "beaming"),
            k("o(〃＾▽＾〃)o", "giddy"),
            k("(๑˃ᴗ˂)ﻭ", "fired up"),
            k("(´｡• ᵕ •｡`)", "content"),
            k("ヽ(・∀・)ﾉ", "celebrate"),
            k("(＾ｖ＾)", "smug"),
            k("( ˘▾˘ )", "satisfied"),
            k("＼(￣▽￣)／", "triumphant"),
            k("(=^▽^=)", "glee")
        ]
    },
    {
        id: "love",
        label: "Love",
        items: [
            k("(♡°▽°♡)", "in love"),
            k("(´,,•ω•,,)♡", "adore"),
            k("♡(◡‿◡✿)", "sweet"),
            k("(づ￣ ³￣)づ", "kiss"),
            k("(｡♥‿♥｡)", "smitten"),
            k("( ˘⌣˘)♡", "fond"),
            k("(◍•ᴗ•◍)❤", "affection"),
            k("(*♡∀♡)", "crush"),
            k("♥(ˆ⌣ˆԅ)", "flirt"),
            k("(♡˙︶˙♡)", "happy love"),
            k("ヽ(♡‿♡)ノ", "swoon"),
            k("(─‿‿─)♡", "dreamy"),
            k("(´• ω •`) ♡", "please"),
            k("(,,>﹏<,,)♡", "bashful"),
            k("( ˘ ³˘)♥", "heart kiss")
        ]
    },
    {
        id: "cute",
        label: "Cute",
        items: [
            k("(｡･ω･｡)", "cute"),
            k("(´･ω･`)", "meek"),
            k("( ˊᵕˋ )", "soft smile"),
            k("(｡•ᴗ-)✧", "wink"),
            k("(๑>◡<๑)", "giggle"),
            k("(・◡・)", "gentle"),
            k("(´꒳`)", "innocent"),
            k("( ˶ˆ ᗜ ˆ˵ )", "bright"),
            k("(⁄ ⁄•⁄ω⁄•⁄ ⁄)", "blush"),
            k("(*/ω＼*)", "shy"),
            k("(๑˘︶˘๑)", "cozy"),
            k("(◡ ω ◡)", "peaceful"),
            k("(*^▽^*)", "bubbly"),
            k("(灬º‿º灬)", "flustered"),
            k("( ᐛ )", "derp")
        ]
    },
    {
        id: "sad",
        label: "Sad",
        items: [
            k("(╥﹏╥)", "crying"),
            k("(｡•́︿•̀｡)", "upset"),
            k("(ಥ﹏ಥ)", "sobbing"),
            k("(っ˘̩╭╮˘̩)っ", "heartbroken"),
            k("( ˃̣̣̥⌓˂̣̣̥ )", "tearful"),
            k("(•́︵•̀)", "downcast"),
            k("(っ- ‸ - ς)", "pouting"),
            k("(ᗒᗣᗕ)՞", "distraught"),
            k("｡ﾟ(ﾟ´ω`ﾟ)ﾟ｡", "wailing"),
            k("(╯︵╰,)", "miserable"),
            k("(´；ω；`)", "teary"),
            k("(⌣́_⌣̀)", "disappointed"),
            k("( ˘︹˘ )", "glum"),
            k("(´-ω-`)", "tired")
        ]
    },
    {
        id: "angry",
        label: "Angry",
        items: [
            k("(╬ Ò﹏Ó)", "furious"),
            k("(ﾉಥ益ಥ)ﾉ", "rage"),
            k("ヽ(ｏ`皿′ｏ)ﾉ", "shouting"),
            k("(＃`Д´)", "mad"),
            k("(҂ `з´ )", "annoyed"),
            k("(¬､¬)", "side eye"),
            k("(>_<)", "frustrated"),
            k("(っ °Д °;)っ", "outburst"),
            k("ᕦ(ò_óˇ)ᕤ", "flex"),
            k("(＃￣ω￣)", "irritated"),
            k("(҂◡_◡)", "done with it"),
            k("(ㆆ_ㆆ)", "glare")
        ]
    },
    {
        id: "surprise",
        label: "Surprise",
        items: [
            k("(・_・;)", "nervous"),
            k("(°ロ°)", "shocked"),
            k("(⊙_⊙)", "wide eyed"),
            k("(￣▽￣;)", "awkward"),
            k("(・・？)", "confused"),
            k("Σ(￣□￣;)", "startled"),
            k("(ﾟдﾟ)", "astonished"),
            k("(◎_◎;)", "alarmed"),
            k("(・∀・)?", "puzzled"),
            k("(¬_¬)", "suspicious"),
            k("( ゜ρ゜ )", "dazed"),
            k("(°ロ°)☝", "eureka"),
            k("(⊙_☉)", "bewildered"),
            k("(・_・?)", "what")
        ]
    },
    {
        id: "animals",
        label: "Animals",
        items: [
            k("ʕ•ᴥ•ʔ", "bear"),
            k("ʕ￫ᴥ￩ʔ", "bear hug"),
            k("ʕ·ᴥ·ʔ", "small bear"),
            k("ʕっ•ᴥ•ʔっ", "bear reach"),
            k("(=^･ω･^=)", "cat"),
            k("(=ↀωↀ=)", "cat eyes"),
            k("ฅ^•ﻌ•^ฅ", "cat paws"),
            k("/ᐠ｡ꞈ｡ᐟ\\", "kitten"),
            k("ᓚᘏᗢ", "lazy cat"),
            k("(･ｪ-)", "wink cat"),
            k("^•ﻌ•^", "puppy"),
            k("ʚ(ᵕᴗᵕ)ɞ", "angel"),
            k("＜（＾－＾）＞", "penguin"),
            k("(・×・)", "piggy")
        ]
    },
    {
        id: "actions",
        label: "Actions",
        items: [
            k("¯\\_(ツ)_/¯", "shrug"),
            k("(╯°□°）╯︵ ┻━┻", "table flip"),
            k("┬─┬ ノ( ゜-゜ノ)", "put the table back"),
            k("(づ｡◕‿‿◕｡)づ", "hug"),
            k("(☞ﾟヮﾟ)☞", "point right"),
            k("☜(ﾟヮﾟ☜)", "point left"),
            k("ᕕ( ᐛ )ᕗ", "running"),
            k("┌(・。・)┘♪", "dancing"),
            k("ヾ(⌐■_■)ノ♪", "party"),
            k("(ノ^_^)ノ", "throw"),
            k("( ͡° ͜ʖ ͡°)", "lenny"),
            k("(-_-) zzZ", "sleeping"),
            k("(￣o￣) zzZ", "snoring"),
            k("ヽ(＾Д＾)ﾉ", "hype"),
            k("(*・ω・)ﾉ", "wave"),
            k("(´･ω･)っ由", "offering"),
            k("＿φ( °-°)", "writing"),
            k("(๑•̀ㅂ•́)و✧", "determined")
        ]
    }
];
