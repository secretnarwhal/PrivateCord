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
- `/media` streams a file, `/art` serves the cover art out of its tags, and
  `/image` serves a cover image file sitting beside the music (`cover.jpg` and
  friends) — all three behind the same token and path checks
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
│ ▣ track — artist 🎞♪☰👥⧉⇱⛶ │  <- track strip (art thumb · video/lyrics/queue/listen along/library/pop out/fullscreen)
│      video, or             │
│   ▂▄▆█▆▄▂ visualizer ▂▄▆█▆ │
│ ▬▬▬▬▬▬▬▬●▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬ │  <- seek bar, click or drag
│ 🔀 ⏮ ⏯ ⏭ 🔁 🅐 1:23/4:56 🔊 │  <- transport (shuffle/repeat/autoplay)
├────────────────────────────┤
│ 🔊 Voice Connected          │  <- untouched
│ username                    │  <- untouched
└────────────────────────────┘
```

There is no separate control bar: everything lives on the panel itself. Click to
play/pause, double click (or ⛶) for fullscreen, ⇱ pops the panel out of the
sidebar to float over the client, ⧉ opens the library modal — folder picker,
search, the folder browser, and **Download…** — and ☰ opens the same
modal on the queue, with a badge showing how many tracks are waiting. Shuffle and
repeat sit right in the transport row (repeat cycles off → all → one).

🅐 is **autoplay**, sitting at the end of the transport buttons. On — which is how
it starts — a track running out rolls on into the next one, the way it always did.
Struck through, playback stops instead of wandering off into the rest of the
library on its own. What you queued yourself still plays: autoplay only governs
what happens once there is nothing left waiting, so *Play next* / *Add to queue*
mean the same thing either way, and so does pressing ⏭ yourself. The setting is
saved with the rest of the player's prefs.

Volume works like YouTube's: the 🔊 icon mutes on click, and hovering it pops up
a small vertical slider to drag (the scroll wheel over it nudges the volume too).

### Browsing your library

The **Library** tab is a file manager pointed at your music folder. Every tile is
a real directory and every row is a real file, so what you see is what a file
explorer would show you — and what you do here happens on disk: renaming a folder
renames it, dragging an album onto another artist moves those files, and deleting
sends the real thing to the recycle bin.

It expects the usual shape — **Artist / Album / Songs** — and names each level
after it, so the folders at the top read as *artists*, the folders inside one as
*albums*, and anything deeper as plain folders. Nothing is enforced: a folder of
loose files browses perfectly well, the convention only decides what the labels
say and what **File by artist / album** means.

```
┌──────────────────────────────────────────────┐
│ ↑  ▤ Music / Boards of Canada / Geogaddi  ▶ ⊞⧉│  <- crumbs (drop targets) + folder actions
├──────────────────────────────────────────────┤
│ 2 ALBUMS                                     │
│ ┌────────┐ ┌────────┐                        │
│ │ cover ▶│ │ cover ▶│    <- tiles: cover art, "12 songs", drag to move
│ └────────┘ └────────┘                        │
│ 23 SONGS                                     │
│ ♪ Music Is Math — Boards of Canada    ⏭ ＋    │
│ ♪ Beware the Friendly Stranger        ⏭ ＋    │
│ Show 3 other items                           │  <- what you hid, plus the junk
└──────────────────────────────────────────────┘
```

- **Opening things** — click a folder to go into it, click a song to play it. The
  breadcrumbs and ↑ go back up; the browser remembers where you were.
- **Playing a folder** — ▶ on a tile plays everything inside it, subfolders
  included, and lines the rest up in the queue. ▶ in the toolbar does the same
  for the folder you are standing in.
- **Album order** — songs are listed by their disc and track numbers rather than
  by file name, so an album reads the way it plays. The tags are what say so, and
  a folder whose files carry no track numbers stays in name order. The library
  itself is re-sorted the same way once the background tag pass has been over it,
  which is what makes ⏭ walk an album in order rather than alphabetically.
- **Selecting** — ctrl-click picks several, shift-click picks a range. A bar
  appears with Play, Queue, Move up, File by tag, Hide and Delete for the lot.
- **Moving** — drag any tile or row onto a folder tile, onto a breadcrumb, or
  onto ↑. The drop target lights up, and a drag that started on a selection
  carries the whole selection.
- **Renaming** — right click → *Rename…* edits the name in place. A file keeps
  its extension unless you type one yourself, so a song can't be renamed into
  something unplayable by accident.
- **New folders** — ⊞ makes one where you are, named inline before it exists.
- **File by artist / album** — files tracks into `<music folder>/<artist>/<album>/`
  using the tags already read for the library, after showing you exactly what it
  would move. Loose songs sitting at the top level get a shortcut for it.
- **Cover art** — a `cover.jpg` (or `folder`/`front`/`album`/`artwork`) in the
  folder, falling back to the embedded art of a track inside it.
- **Other files** — anything the player can't decode is listed behind *Show N
  other files*: still yours to rename, move or delete, just not to play.
- **Hiding** — right click → *Hide* puts a folder or a file down in that same
  collapsed section, and *Show again* brings it back. Nothing moves on disk and
  nothing leaves the library; what goes away is the room it took up and the
  chance of stumbling into it. A hidden folder takes everything under it along.

  Hidden entries are stepped over by everything that picks a track *for* you:
  autoplay, shuffle, ⏭ and ⏮, ▶ on the folder above them, and the flat search
  list. They are not stepped over when you point straight at them — playing a
  hidden folder from its own tile or right-click menu plays exactly what is in
  it. Folder song counts leave them out for the same reason.

  What is hidden is remembered per path, and follows an entry that is renamed or
  moved; deleting one forgets it. A `__pycache__` next to your music, a folder of
  stems, that one album you never want shuffled into — this is for those.
- **Searching** switches back to the flat list of the whole library, because a
  search that only looked in the folder you happen to be standing in would be the
  least useful kind.

A track's `.lrc` / `.txt` lyrics sidecar follows it when it moves or is renamed
and goes to the recycle bin with it, the queue keeps pointing at whatever it
pointed at before, and a track that moves while it is playing keeps playing.

Nothing outside the folder you opened can be listed, moved or deleted, the folder
itself can't be renamed away from under the library, names are checked against
what the filesystem will actually accept, and nothing is ever overwritten — a
collision is reported rather than resolved. Deletes go to the recycle bin, never
to `unlink`.

### The queue

The modal has three tabs: **Library**, **Up next** and **Listen along**.

Clicking a track in the library plays it immediately, as it always did. Hovering
a row also reveals two buttons that put it in the queue instead:

- **Play next** — jumps it to the front, so it plays the moment this track ends
- **Add to queue** — appends it to the end

The **Up next** tab lists what is waiting, in order. Rows drag to rearrange —
grab one anywhere and an accent line shows where it will land, including past the
last row. Clicking a queued row plays it now and takes it out of the queue; ✕
removes it without playing it, and **Clear** empties the whole thing.

The queue outranks both the library order and shuffle: whenever a track ends,
whatever is at the front of the queue plays next and is consumed. The one
exception is repeat-one, which means "do not move on" and keeps the queue intact
until it is switched off. When the queue runs dry, playback falls back to
shuffle / the library order as before — or stops there, if autoplay is off.

The queue is saved with the rest of the player's prefs, so it survives a restart.
Entries whose file has since disappeared are dropped on the next rescan.

### The visualizer

Audio-only files get a live spectrum — frequency bars mirrored around the
centre line, drawn over the blurred cover art (or an accent-tinted wash when the
file embeds none). Video files show their picture instead, unless the `showVideo`
setting is off — the 🎞 button on the panel toggles it — in which case they get
the visualizer too.

For video files the track strip and the transport only appear on hover, keeping
the picture clean; in visualizer mode they stay up, since the panel is then a
now-playing card rather than a viewport.

The analysis runs on a Web Audio `AnalyserNode` tapped into the shared media
element. That is also why the loopback server sends
`Access-Control-Allow-Origin: *` and the element uses `crossorigin="anonymous"`:
a media element without clean CORS still plays, but analyses as pure silence.
(The token query parameter is what actually gates access to the server.)

### Live lyrics

The ♪ button on the track strip swaps the visualizer (or the video) for a lyrics
pane, where the line being sung lights up word by word — a gradient edge travels
through each word as it lands.

Timing is read straight off the media element's `currentTime` in a
`requestAnimationFrame` loop rather than from the player's 4Hz position updates,
so the sweep is frame-exact. React only re-renders when the active *line*
changes; the per-word progress is written to the DOM as a CSS custom property,
which is what keeps a 60fps effect away from the reconciler entirely.

Clicking a line seeks to it. Scrolling by hand parks the auto-scroll for a few
seconds so you can read ahead without it yanking you back.

#### Where lyrics come from

Cheapest first, stopping at the first hit:

1. **A hand-picked choice**, if this track has one — see *Fixing a bad match*.
2. **A `.lrc` (or `.txt`) next to the audio file** — same name, different
   extension. Nothing is fetched when one exists.
3. **The file's own tags** — ID3 `SYLT` (genuinely timed) and `USLT`, the MP4
   `©lyr` atom, and the FLAC/Ogg `LYRICS` / `SYNCEDLYRICS` / `UNSYNCEDLYRICS`
   comments. Taggers habitually paste a whole LRC document into the plain lyrics
   field, so those go through the LRC parser too rather than being assumed flat.
4. **[NetEase](https://music.163.com)**, but *only* for what nothing else has:
   genuine per-word timing. When it has nothing better than line timing we move
   on, since LRCLIB's text is the better curated of the two for Western music.
5. **[LRCLIB](https://lrclib.net)** — free, no key, no account. It is asked for
   an exact match on artist/title/album/length, then the same without the album
   (the field most likely to be tagged differently), then a search.

Lookups run in the main process. That is why neither host needs a CSP entry, and
why the requests carry nothing of Discord's — only the track, artist, album and
length are ever sent. Network results are cached under `vc-localmusic-lyrics` in
the user data directory, including misses for a week, so a track is looked up
once and not again. Sidecars and tags are deliberately *not* cached, so editing a
`.lrc` shows up on the next track change.

A file with no artist tag falls back to reading `Artist - Title` out of its own
name, and yt-dlp decoration (`[dQw4w9WgXcQ]`, `(Official Video)`, …) is stripped
before anything is looked up.

#### Matching, and why it would rather show nothing

Every fuzzy result is scored against what is playing — a Dice coefficient over
character bigrams for the title and artist, plus a five second window on the
length — and rejected if it does not clear both. A title with no artist behind it
and fewer than four significant characters is not searched at all.

That last rule has a story. A file named `K. [26Uo_l5lipo]` with no artist tag
used to search for `K.`, and the single result within eight seconds of its length
was an **instrumental** "Sicko Mode (feat. K.K. Slider)" — so the panel proudly
displayed *Instrumental*. Two things fixed it: the scoring above, and only
trusting an `instrumental` flag when it comes from an exact four-field lookup
rather than from a search. Wrong lyrics are worse than no lyrics, and there is a
manual override for whatever falls through.

#### Word-level timing

Real per-word timing is read from three sources: **NetEase `yrc`**, **enhanced
LRC** (the A2 extension, `<00:12.34>` before each word) and ID3 `SYLT`.

It matters more than it sounds. Word length does not predict how long a word is
held — in *K.*, `I` lasts 0.39s, `remember` 0.96s and `noticed` **1.65s**, so the
seven-letter word is sung 70% longer than the eight-letter one. No amount of
estimating from the text can produce that.

When only line timing is available the words are still swept, by spreading the
line across them by length — but over how long the line is *actually sung*, not
over the gap to the next line. Those are very different numbers: a line followed
by an instrumental break owns the whole break, which stretched the sweep to
around 1.2–1.4x on measured tracks and left the highlight visibly trailing the
vocal. The rate is calibrated per song, from the low quartile of each line's
seconds-per-character (lines butted against the next one have almost no gap, so
they reveal the true singing rate), then capped by the slot. Checked against
NetEase's real word timings for the same song, that moves the median line from
1.19x the true singing time to 0.94x.

Apple Music's TTML is the other large source of syllable timing, and what the
karaoke-style Android players generally proxy. It is deliberately not wired up:
those proxies re-export a private endpoint, and the one usually named
([Paxsenix](https://lyrics.paxsenix.org)) intermittently timed out and returned
nothing at all from its word-level endpoints when this was written. Kugou's `krc`
was rejected too — its search host was unreachable.

#### Fixing a bad match

**Fix lyrics…** in the lyrics pane searches both providers by hand. Results show
artist, album and length, with word-by-word ones flagged; picking one pins it to
that file and remembers it, so it stays fixed across restarts. A pinned choice
outranks every provider including the local files — an override the file could
silently overrule would not be much of an override — and there is a button to
clear it again.

#### Settings

| setting | does |
| --- | --- |
| `showLyrics` | the panel mode itself — the same thing the ♪ button toggles |
| `lyricsOnline` | whether anything may be looked up online; off keeps everything local |
| `lyricsWordLevel` | whether to spend a request looking for word-by-word timing |
| `lyricsOffset` | nudge in milliseconds, positive shows lines earlier |

Listeners in a listen-along session get lyrics too, since playback is local on
every client — the same lookup runs against the tags the host broadcast. There
is no file beside which to find a sidecar, so those go straight to LRCLIB.

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

### Popping out

⇱ on the track strip lifts the panel out of the sidebar so it floats anywhere
over the client; ⇲ puts it back. Drag it by the track strip, which becomes its
title bar and stops hiding itself over a video, since it is then the only thing
there is to grab. The resize edges work exactly as they do docked — the panel is
still pinned by its bottom-left corner, so it grows up and to the right.

It is not a separate window: it is the same portal on `document.body`, so it
moves with the Discord window, clips at its edges, and can't be dragged outside
it. Only what the panel is pinned to changes — a free window-relative anchor
instead of the spacer's rect. The spacer collapses to nothing while floating, so
the channel list gets that space back, and both the anchor and the popped-out
state are persisted.

## Media keys

Two mechanisms, picked with the `mediaKeys` setting.

**`session` (default)** — `navigator.mediaSession`. The track, artist and
embedded cover art are handed to the OS, along with handlers for
play/pause/next/previous/seek. This is the good path: the desktop routes the
keys, other players keep working normally, and you get a proper "now playing"
widget for free (SMTC on Windows, the Now Playing widget on macOS, MPRIS on
Linux — which is what KDE, GNOME and the Wayland compositors bind the media
keys to).

This path needs two Chromium features, `MediaSessionService` and
`HardwareMediaKeyHandling`. Electron enables both by default on Windows and
macOS — **but Discord's own bootstrap passes both to `--disable-features` on
every platform**, which is why the stock client never reacts to media keys. On
Linux, Electron additionally ships with them off in the first place.

`native.ts` therefore fixes the command line at import time, which is early
enough because plugin natives load before Discord's bootstrap runs:

- scrubs both features out of anything already on `--disable-features`
- wraps `app.commandLine.appendSwitch` so Discord's later
  `--disable-features` append gets the same scrub
- adds both to `--enable-features`

Chromium only reads feature switches before the app is ready. If the host app
(Vesktop, say) loads us after `app.whenReady`, `native.ts` logs a warning and
you'll need to pass the flag yourself:

```bash
vesktop --enable-features=MediaSessionService,HardwareMediaKeyHandling
```

On Linux, check it worked with `playerctl -l`; on Windows, play something and
press a media key — the SMTC flyout should show the track.

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

**Browse…** opens YouTube Music in its own Electron window, and leaves the site
completely alone — browsing, searching and playing all behave exactly as they
do in a normal browser. The additions live in a bar along the bottom:
back/forward/reload, **Download playing** — which queues whatever the player is
currently playing — and **Queue this page**, for when the page itself is the
thing you want (an album, a playlist, a video).

"Playing" is read from the page's own player (`#movie_player`'s
`getVideoData()`, which both YouTube and YouTube Music expose), so it works
mid-playlist, from search results, from anywhere — not just on a watch page.

The window gets its own `persist:vc-localmusic` session, so signing in there
never touches Discord's cookies — and it is a plain sandboxed window: no
preload, no node integration. It talks back by navigating to an unresolvable
`https://vc-localmusic.invalid/` sentinel that `will-navigate` reads and
cancels, which works no matter what the page's own CSP allows.

The playlist toggle applies to what the window queues, and follows it live.

### Signing in, and Liked Music

Signing in to YouTube inside the browse window is also what unlocks your own
library for yt-dlp: before every invocation the session's YouTube/Google
cookies are exported as a Netscape `cookies.txt` (into Discord's user data
directory, deleted when the plugin stops) and passed with `--cookies`. Nothing
else in the jar is exported, and anonymous cookies aren't exported at all.

That makes the **Liked** button work: it lists your newest 100 likes — the
`https://music.youtube.com/playlist?list=LM` playlist, fetched flat — each with
its own Download button, plus **Download all**. "All" runs one yt-dlp over the
whole playlist with `--download-archive` pointed at
`.vc-localmusic-archive.txt` in your music folder, so running it again only
fetches likes it hasn't fetched before. That archive applies to every playlist
download (single-track downloads skip it, so deliberately re-downloading one
song still works); delete the file to forget the history.

### Searching from the modal

The search box runs yt-dlp's own extractors, so no API key, no quota, and
anything listed is by definition downloadable:

- **YouTube** — `ytsearch25:your query`
- **Music** — `https://music.youtube.com/search?q=…#songs`
- any URL you paste is handed straight to yt-dlp, so playlists, albums and
  channels work too

Anything that needs you signed in — Liked Music, Watch later
(`https://www.youtube.com/playlist?list=WL`), private playlists — works once
you've signed in through the browse window, as above. `cookiesFromBrowser` is
the alternative for people who'd rather not: yt-dlp reads the cookie jar out of
an existing browser profile instead. Note that Chrome-family browsers on Linux
encrypt cookies against the desktop keyring, and Chrome ≥ 127 (Brave, Edge, …
included) on Windows locks and encrypts its cookie DB; Firefox is the path of
least resistance there, which is why the browse-window sign-in is the default
and takes precedence whenever it exists. When a configured browser's jar turns
out to be unreadable, the run is retried once without cookies rather than
failing outright — public tracks still download, only the signed-in-only stuff
doesn't.

## Supported formats

Only what Chromium can actually decode: `mp3`, `flac`, `m4a`, `aac`, `ogg`,
`oga`, `opus`, `wav`, `weba`, `mp4`, `m4v`, `webm`, `mov`.

`mkv`, `avi`, `wmv` and `wma` are deliberately excluded — including them would
put files in the library that silently refuse to play.

Tags — title, artist, album, track and disc number, cover art and any embedded
lyrics — are read for all of them:

| format | read from |
| --- | --- |
| mp3 | ID3v2.2 / v2.3 / v2.4 frames |
| flac | Vorbis comments + `PICTURE` blocks |
| m4a, mp4, m4v, mov | `moov > udta > meta > ilst` atoms |
| ogg, oga, opus | Vorbis / Opus comments, cover via `METADATA_BLOCK_PICTURE` |

Two notes, both of which were causing tracks to show up as bare file names:

- MP4 and Ogg family tags were not parsed at all until recently, so anything that
  was not an mp3 or a FLAC — which includes yt-dlp's default output — had no
  metadata whatsoever.
- The ID3 reader was taking byte 4 of the header as the major version when that
  is the *revision*. Every tag therefore looked like v2.2, whose frame ids are
  three bytes rather than four, so `TIT2` was read as `TIT` and the size that
  followed was garbage. In practice **no v2.3 or v2.4 mp3 ever produced tags**.
  Both are fixed; a library that used to show file names should now show titles.

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

## Listen along

Group listening sessions with other people running this plugin — no servers
anywhere, for anyone.

### How a session works

- The **host** opens the **Listen along** tab (the 👥 button on the panel) and
  starts a session. That mints a **group key** (`LMS1.…`) encoding the host's
  user id plus a random 16-byte secret. Hand the key to whoever you want in the
  session; anyone with it can join.
- A **joiner** pastes the key. Their plugin DMs the host a handshake: every
  signaling message is AES-256-GCM encrypted with a key HKDF-derived from the
  shared secret, chunked under Discord's message limit, and deleted once the
  connection is up (each side deletes its own — they're visible for a few
  seconds). Being able to decrypt *is* the authentication.
- The handshake carries a WebRTC offer/answer (non-trickle ICE, public STUN).
  From then on everything — control messages and the music itself — flows over
  peer-to-peer data channels in a star around the host. Discord is out of the
  loop.

### Audio

Listeners don't stream a compressed feed — they receive the **actual file**
over the data channel (16KB chunks, backpressured), verified against its
sha256, and cached on disk (size-capped LRU, configurable in settings; the
existing loopback server serves it with Range support). Playback is local on
every client and synchronized:

- NTP-style clock offset estimation over the control channel (min-RTT sample
  wins, smoothed)
- track starts are *scheduled* ~300ms in the future on the shared clock, so
  everyone starts together
- a 500ms drift loop hard-seeks past 250ms of error and inaudibly nudges
  `playbackRate` (≤2%) inside it

A listener who joins mid-track shows "Syncing…" until the transfer lands, then
drops in at the live position. The next two queued tracks are prefetched to
everyone, so track transitions are gapless even for large files. A rejoin reuses the cache
(`file-have`) and starts instantly.

### The unified queue & permissions

The host's queue is the queue — mirrored to every listener, along with the
host's library listing so listeners can browse and add. What listeners may do
is up to the host, **per member, toggleable live** from the member list:

| permission | covers |
|---|---|
| Playback control | the slider, play/pause, skip, picking a track |
| Add to queue | queue-add / play-next from the host's library |
| Reorder queue | drag-reorder, remove, clear |

Defaults for new joiners are plugin settings. Every request is re-checked by
the host at execution time — the disabled UI on the listener side is cosmetic.

### Limitations

- Joiner must be able to DM the host (friends or a mutual server).
- No TURN relay: a small fraction of NAT combinations (~5-10%) can't connect
  peer-to-peer. Ethernet/typical home NATs are fine.
- Video files play for listeners too (the whole file transfers), but cover art
  isn't transferred yet.
