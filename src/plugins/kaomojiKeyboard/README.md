# KaomojiKeyboard

A kaomoji picker in the chat bar. Click a face, it lands in the message box — typed out and
ready, but not sent.

## Using it

Hit the `(^ ^)` button next to the emoji and GIF buttons. The keyboard opens above it with
~120 built-in kaomoji across eight categories, plus **Recent** and **Yours**.

- **Click** a kaomoji to insert it and close the keyboard.
- **Shift-click** to insert it and keep the keyboard open, so you can stack a few.
- **Search** by name — "shrug", "bear", "table flip" — since searching for `ʕ•ᴥ•ʔ` by typing
  `ʕ•ᴥ•ʔ` would be a bit of a chicken-and-egg problem. Enter inserts the first result.
- **Category pills** scroll the list; they track whatever you've scrolled into.

## Your own kaomoji

Click the blue **Add kaomoji** button. The keyboard dims behind a sheet asking for
<kbd>Ctrl</kbd> + <kbd>V</kbd> — paste, and whatever was on your clipboard becomes yours.

A multi-line paste adds one kaomoji per line, so you can grab a whole list off a website in
one go. Duplicates are ignored. The sheet stays open and shows what it took, so you can keep
pasting; **Done** or <kbd>Esc</kbd> closes it.

Your kaomoji live in the **Yours** section — hover one and hit the × to delete it. They're
stored in plugin settings, so they ride along with your settings sync.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Close on select | on | Whether picking closes the keyboard (shift-click overrides either way) |
| Trailing space | on | Puts a space after the kaomoji so you can keep typing |
| Escape markdown | off | Also escapes `*`, `_`, `~`, `` ` `` and `\|`, so a face like `(¬_¬)` can never pair up with another one into italics. Makes the chat box text messier, which is why it's off |
| Recent count | 16 | How many recently used kaomoji sit at the top |

Backslashes are always escaped regardless of that last setting — Discord reads `\_` as an
escaped underscore, which is exactly why the shrug has to go out as `¯\\_(ツ)_/¯` to survive
the trip.
