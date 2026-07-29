# LocalMusic

A music player for your local files, docked into the bottom-left panel where
Discord normally shows the game activity / "Go Live" tile.

## How it works

Playback is entirely ours — no VLC, no external player. A single `<video>`
element in the renderer plays every file (it handles audio-only files fine), so
play/pause, seeking, volume and gapless track changes are all native browser
behaviour rather than IPC round trips to another app.

Files reach the renderer over a loopback HTTP server started in the main
process:

- binds to `127.0.0.1` on an OS-assigned port, so nothing off-machine can reach it
- every request needs a random per-session token
- paths are rejected unless they resolve inside a folder the user explicitly
  opened through the folder picker
- `Range` requests are supported, which is what makes seeking and large video work

`native.ts` widens Vencord's CSP for `http://127.0.0.1:*` to cover `media-src`
and `img-src` — the stock entry only allows CSS and images.

## Layout

```
┌────────────────────────────┐
│      video (optional)      │  <- only for video files, toggleable
├────────────────────────────┤
│ [art]  ⏮ ⏯ ⏭          ⧉ │  <- mini player
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │  <- click to seek
├────────────────────────────┤
│ 🔊 Voice Connected          │  <- untouched
│ username                    │  <- untouched
└────────────────────────────┘
```

The ⧉ button opens the library panel: folder picker, search, track list,
shuffle/repeat, volume, and the video dock toggle.

## Supported formats

Only what Chromium can actually decode: `mp3`, `flac`, `m4a`, `aac`, `ogg`,
`oga`, `opus`, `wav`, `weba`, `mp4`, `m4v`, `webm`, `mov`.

`mkv`, `avi`, `wmv` and `wma` are deliberately excluded — including them would
put files in the library that silently refuse to play.

Tags are read for ID3v2 (mp3) and FLAC, including embedded cover art. MP4/M4A
atom parsing is not implemented, so those fall back to the file name.

## The one selector that may need adjusting

`hideGoLiveTile` (on by default) hides Discord's game tile so the player takes
its slot. It relies on substring class selectors in `styles.css`:

```css
.vc-lm-hide-golive [class*="gameActivityPanel_"],
.vc-lm-hide-golive [class*="goLiveButton_"],
.vc-lm-hide-golive [class*="goLivePanel_"]
```

Discord's minified class names keep a readable prefix before the hash, so these
are more durable than a hashed class — but the prefix itself does change across
Discord redesigns. If the tile is still visible after enabling the plugin,
inspect it in devtools and add its `class*=` prefix to that rule. Turning the
setting off restores the tile.
