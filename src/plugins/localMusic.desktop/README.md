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
- `/events` is a Server-Sent Events stream. Plugin natives are invoke-only, so
  this is how the main process pushes media key presses and download progress
  back to the renderer without the renderer polling for them

`native.ts` widens Vencord's CSP for `http://127.0.0.1:*` to cover `media-src`
and `img-src` — the stock entry only allows CSS and images — and adds
`i.ytimg.com` / `lh3.googleusercontent.com` as image sources for the search
result thumbnails.

## Layout

```
┌────────────────────────────┐◹
│ track — artist             │  <- on hover
│    video, or cover art     │
│ ⏮ ⏯ ⏭ ▁▁▁▁▁▁▁▁ ⧉ ⛶ │  <- overlay, on hover
├────────────────────────────┤
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │  <- click to seek
├────────────────────────────┤
│ 🔊 Voice Connected          │  <- untouched
│ username                    │  <- untouched
└────────────────────────────┘
```

There is no separate control bar: everything lives on the panel itself. Click to
play/pause, double click (or ⛶) for fullscreen, and ⧉ opens the library modal —
folder picker, search, track list, shuffle/repeat, volume, the panel toggle, and
**Download…**.

Audio-only files get the same panel with the embedded cover art in place of the
picture, so the layout never changes shape between a song and a music video.

### Resizing

Three grab edges, all persisted:

| edge | drags |
| --- | --- |
| top | height — the panel is pinned to the account panel, so it grows upwards |
| right | width |
| top-right corner | both at once |

Double click the right edge or the corner to go back to "just fill the sidebar".

Because a panel dragged wider than the sidebar would be clipped by it, the panel
is rendered into a portal on `document.body` and pinned, `position: fixed`, over
a spacer that stays behind in the sidebar to reserve its height. Widening it
therefore spills out over the chat rather than being cut off.

## Media keys

Two mechanisms, picked with the `mediaKeys` setting.

**`session` (default)** — `navigator.mediaSession`. The track, artist and
embedded cover art are handed to the OS, along with handlers for
play/pause/next/previous/seek. This is the good path: the desktop routes the
keys, other players keep working normally, and you get a proper "now playing"
widget for free.

- Windows: the SMTC overlay, on by default in Electron
- macOS: the Now Playing widget, on by default in Electron
- Linux: MPRIS, which is what KDE, GNOME and the various Wayland compositors
  bind the media keys to. Chromium only publishes an MPRIS interface when
  `MediaSessionService` is enabled, and Electron leaves it off on Linux, so
  `native.ts` appends `--enable-features=MediaSessionService,HardwareMediaKeyHandling`
  at import time.

  Chromium only reads feature switches before the app is ready, so this only
  works if Vencord's main process code loads early enough. It does under
  Discord's own client; if the host app (Vesktop, say) loads us after
  `app.whenReady`, `native.ts` logs a warning and you'll need to pass the flag
  yourself:

  ```bash
  vesktop --enable-features=MediaSessionService,HardwareMediaKeyHandling
  ```

  Check it worked with `playerctl -l`, or look for the player in your desktop's
  media widget.

**`global`** — registers `MediaPlayPause`, `MediaNextTrack`,
`MediaPreviousTrack` and `MediaStop` through Electron's `globalShortcut`. This
takes the keys away from every other player on the machine, so it's opt-in, and
it does nothing at all on Wayland (Electron cannot take global shortcuts there).
It exists for X11 and Windows setups where the media session route doesn't
happen.

Either way, Chromium won't treat the player as media-session eligible until it
is actually playing audio longer than about five seconds.

## Downloading with yt-dlp

**Download…** in the library modal opens a downloader that shells out to
`yt-dlp`. Nothing is bundled — you supply the binary.

Where it looks, in order:

1. the `ytDlpPath` setting, if you set one
2. `yt-dlp` (or `yt-dlp.exe`) sitting in your music folder — the `./yt-dlp URL`
   setup, which is what most people already have
3. whatever is on `PATH`

Downloads go to your music folder via `--paths`, and the library rescans itself
when one finishes. `ytDlpArgs` is passed on every download and defaults to
`-x --audio-format mp3 --embed-metadata --embed-thumbnail`, which needs ffmpeg
and gives you files whose tags and cover art this plugin can then read. Switch
it to something else if you'd rather keep video, or the original audio codec.

Progress is parsed out of `--newline` output and pushed over the SSE stream. The
downloader also reconciles against the main process on open and every few
seconds while it is open — the stream is the fast path, but a stream that
dropped would otherwise strand a finished (or failed) job as a row that still
claims to be running. Any row can be dismissed individually with ✕, whatever
state it ended in.

### The browse window

**Browse…** opens YouTube in its own Electron window with one behaviour changed:
following a link to a track queues it for download instead of playing it.
Everything else navigates normally, so searching, playlists and channels all
still browse. A bar along the bottom carries back/forward/reload and **Queue
this page**, for when you are already looking at the thing you want.

The window gets its own `persist:vc-localmusic` session, so signing in there
never touches Discord's cookies — and it is a plain sandboxed window: no
preload, no node integration. It talks back by navigating to an unresolvable
`https://vc-localmusic.invalid/` sentinel that `will-navigate` reads and
cancels, which works no matter what the page's own CSP allows.

The playlist toggle applies to what the window queues, and follows it live.

### Searching from the modal

The search box runs yt-dlp's own extractors, so no API key, no quota, and
anything listed is by definition downloadable:

- **YouTube** — `ytsearch25:your query`
- **Music** — `https://music.youtube.com/search?q=…#songs`
- any URL you paste is handed straight to yt-dlp, so playlists, albums and
  channels work too

Set `cookiesFromBrowser` to reach things that need you signed in — yt-dlp reads
the cookie jar out of your existing browser profile, so no separate login and no
credentials pass through Discord. Your own library is then just a URL to paste:

| what | url |
| --- | --- |
| Liked Music | `https://music.youtube.com/playlist?list=LM` |
| Watch later | `https://www.youtube.com/playlist?list=WL` |
| Uploads/subs/playlists | paste the page URL |

Note that Chrome-family browsers on Linux encrypt cookies against the desktop
keyring, and Chrome ≥ 127 on Windows locks its cookie DB while running; Firefox
is the path of least resistance.

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
