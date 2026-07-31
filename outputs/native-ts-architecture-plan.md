# `native.ts` Architecture Plan — LocalMusic Electron Wrapper

Scope: `src/plugins/localMusic.desktop/native.ts` (1161 lines), plus its direct
callers in `PlayerStore.ts`, `Downloader.tsx`, `tags.ts`, `types.ts`, and the
generic IPC plumbing in `src/main/ipcPlugins.ts` / `src/VencordNative.ts`. This
is a grounded plan, not a redesign — the file's overall shape (loopback server
+ auto-generated IPC + child-process yt-dlp) is sound and each section below
says so explicitly where that's the case. Line numbers refer to `native.ts`
as read on 2026-07-30, working tree (uncommitted revision ahead of
`e436ef51`).

---

## 1. The `stopServer` cleanup bug

**`stopServer` (native.ts:1138–1161) is defined but never called anywhere in
the codebase.** Confirmed by grep across `src/` — the only reference to the
identifier `stopServer` in the entire tree is its own definition.

### What it was supposed to replace

`PlayerStore.destroy()` (`PlayerStore.ts:756–787`), invoked from the plugin's
`stop()` (`index.tsx:46–50`), does its own partial cleanup:

```ts
Native.setGlobalMediaKeys(false).catch(() => { });
Native.closeBrowser().catch(() => { });
```

Two of `stopServer`'s five actions are therefore already redundantly covered:

- `releaseMediaKeys()` (native.ts:403–410) — already triggered because
  `setGlobalMediaKeys` (native.ts:416–430) calls `releaseMediaKeys()`
  unconditionally as its first line, regardless of the `enabled` argument.
- `browser?.destroy()` — already covered by the explicit `closeBrowser()` call
  (native.ts:1130–1134).

**What is *not* covered by anything else, and leaks today:**

| Resource | Where it lives | Only cleaned up by |
|---|---|---|
| The `http.Server` itself + listening socket | `server` (native.ts:110) | `stopServer` line 1158–1159 |
| The SSE heartbeat `setInterval` | `heartbeat` (native.ts:138) | `stopServer` line 1155–1156 |
| Open SSE response sockets | `eventClients` (native.ts:137) | `stopServer` line 1152–1153 |
| In-flight yt-dlp/ffmpeg child processes | `processes` (native.ts:709) | `stopServer` line 1145 (`killProcess`) |
| Job bookkeeping | `jobs` (native.ts:708) | `stopServer` line 1146 |
| Exported cookie jar on disk | `cookieFilePath()` (native.ts:496–498) | `stopServer` line 1150 (`unlink`) |

### Concrete failure scenarios

1. **Toggle the plugin off without restarting Discord** (a normal thing to do
   from Vencord's plugin settings UI): the HTTP server keeps listening on its
   OS-assigned port forever, the heartbeat timer fires every 25s forever
   (native.ts:154), and if the user re-enables the plugin, `PlayerStore.init()`
   → `ensureServer()` (`PlayerStore.ts:319–323`) → `Native.getServerInfo()`
   (native.ts:277–279) returns the *stale* `serverInfo`, since it was never
   nulled. This mostly "works by accident" today, but it means the intended
   re-entrant restart path (`serverInfo ?? await startServer()`) is never
   actually exercised, and any accumulated `eventClients` from the prior
   session are never released.
2. **Toggle the plugin off mid-download**: the spawned yt-dlp (and its ffmpeg
   child, on Windows specifically orphaned per the `killProcess` comment at
   native.ts:713–715) keeps running headless indefinitely, writing into the
   user's music folder with no UI able to see or cancel it, because the
   renderer's copy of `jobs`/`downloads` is gone but native.ts's copy is not.
3. **Cookie hygiene**: `README.md` documents the exported cookies file as
   "deleted when the plugin stops" — that claim is currently false whenever
   `stop()` is what triggers it, which is the normal disable path. A file
   containing live YouTube/Google session cookies (`SAPISID`,
   `__Secure-3PAPISID` — see `isLoginCookie`, native.ts:492–494) sits in
   Electron's `userData` directory indefinitely.

### What to wire

- In `PlayerStore.destroy()` (`PlayerStore.ts:756`), replace the two existing
  calls with a single `Native.stopServer()` call. Since `stopServer` already
  performs `releaseMediaKeys()` and `browser?.destroy()` internally, the
  explicit `setGlobalMediaKeys(false)` / `closeBrowser()` calls become dead
  weight and should be deleted rather than kept alongside.
- Add a main-process-level fallback for a hard app quit (not just a plugin
  toggle), since nothing today hooks `app.on("before-quit", ...)` for this
  plugin. Check `src/main/index.ts` / `src/main/persistAfterDiscordUpdates.ts`
  for the right hook point — there is no existing "ask every plugin native to
  clean up on quit" convention in this fork today, so this would be a new
  pattern, scoped to this plugin only, not a framework change.
- `stopServer` is already safe to call defensively (every teardown step is
  optional-chained or `.catch(() => {})`-guarded), so no idempotency work is
  needed — just wire the call sites.
- After the fix, confirm the re-entrant path still works: `stopServer` nulls
  `serverInfo` (native.ts:1160), so the next `getServerInfo()` call correctly
  starts a fresh server with a fresh token. This is already correct code; it
  is simply unreachable today.

---

## 2. The yt-dlp invocation layer

Walked: `resolveBinary` (444–457), `run` (459–463), `collect` (575–604),
`search` (639–702), `beginDownload` (770–858), `startDownload` (860–867).

### Concurrency control — the biggest real gap

There is **no limit on simultaneous yt-dlp processes**. `startDownload`
(860–867) calls `beginDownload` (770), which spawns immediately (line
802–814) and stores the job/process pair in the module-level `jobs`
(708) / `processes` (709) maps with no cap. Nothing in `Downloader.tsx` or
`PlayerStore.ts` throttles calls either — `download()` in `Downloader.tsx`
(line 176–183) fires `player.startDownload` per click with no queueing.

This is bounded in one specific case — a playlist download passes
`--yes-playlist` to a *single* yt-dlp invocation (native.ts:790–791), so
yt-dlp handles its own internal parallelism for tracks within one playlist.
The actual exposure is **separate jobs run concurrently with no cap** — e.g.
rapidly downloading several search results, or a "Download all" on a 100-item
Liked Music listing run alongside a manual URL paste. Each is a full
yt-dlp + ffmpeg process pair with real CPU/network cost.

**Recommended shape**: a small queue in front of `beginDownload`:
- Cap concurrent entries in `processes` (e.g. `MAX_CONCURRENT_DOWNLOADS = 2`,
  or a plugin setting later).
- Additional `startDownload` calls beyond the cap go into `jobs` with a new
  `"queued"` status — `DownloadStatus` (`types.ts:50`) currently only has
  `"running" | "done" | "error" | "cancelled"` and would need a fifth value.
- Drain the queue inside the existing `proc.on("close", ...)` handler
  (native.ts:834–853), after any job settles.
- `cancelDownload` (879–900) and `removeDownload` (902–912) need a
  "cancel while still queued, never spawned" path — today both assume a job
  either has a live `processes.get(id)` or is already terminal; a queued job
  has neither.

### Error handling — mostly good, two concrete inconsistencies

- `collect()` (575–604) resolves its rejection message from
  `stderr.trim().split("\n").at(-1)` (line 600) — the *last* stderr line.
  yt-dlp frequently prints a `WARNING:` or postprocessing note *after* the
  real `ERROR:` line, so "last line" is not reliably "the useful line."
  Compare this to `beginDownload`'s own stderr handler (820–825), which
  correctly searches with `lines.reverse().find(l => l.startsWith("ERROR:"))`.
  `collect()` (used by `ytDlpInfo` and `search`) should adopt the same
  ERROR-scanning approach for consistency — right now search failures and
  download failures surface errors via two different heuristics.
- `describeSpawnError` (465–471) handles `ENOENT` and `EACCES` but not
  `ETXTBSY`/quarantine-style failures — a freshly downloaded macOS binary
  that still has the quarantine bit set fails in a way this function doesn't
  special-case. Worth a targeted message pointing at
  `xattr -d com.apple.quarantine <path>`.
- No retry/backoff for transient failures (rate limiting, a DNS blip). A
  failed job just sits at `"error"` with no automatic retry — only the
  existing `canRetryWithoutCookies` path (line 800, retried at 842–846) has
  any retry logic at all, and it's cookie-specific. A similar single-retry
  pattern keyed on `HTTP Error 429`-style messages would fit the codebase's
  existing idiom without introducing a new one.
- Timeouts are hardcoded, duplicated magic numbers: `60_000` for `search`
  (670, 674), `15_000` for `ytDlpInfo` (610). Worth hoisting into named
  constants (`SEARCH_TIMEOUT_MS`, `VERSION_TIMEOUT_MS`) so a future
  settings-driven override has one place to land.

### Binary resolution

`resolveBinary` (444–457) — settings path → `<folder>/yt-dlp[.exe]` → bare
`"yt-dlp"` on `PATH` — is reasonable and doesn't need restructuring. Two
minor, non-urgent observations:

- It doesn't pre-validate the `PATH` fallback exists before spawning; this is
  fine as-is since `spawn` ENOENTs cleanly and `describeSpawnError` already
  handles that case with a clear message.
- `ytDlpInfo()` (606–615) re-runs `--version` on every call with no caching.
  Currently called once per Downloader mount (`Downloader.tsx:120–122`), so
  low-impact today — but if it's ever polled more frequently, cache the
  resolved-binary → version pair keyed on the resolved path, invalidated
  when `ytDlpPath` changes.
- No minimum-version gate: the version string is fetched and displayed but
  never compared against a floor. Not urgent; worth a TODO if version-specific
  breakage is ever reported (e.g. a cookie-handling flag that only exists in
  newer yt-dlp releases).

---

## 3. The loopback HTTP server

**Overall verdict: structurally solid, keep the design.** Token auth via
`timingSafeEqual` (`isValidToken`, 121–127), path allowlisting that correctly
avoids the classic prefix-matching bug by checking `resolved === root ||
resolved.startsWith(root + sep)` (`isPathAllowed`, 113–119) rather than a bare
`startsWith(root)`, HTTP range support for seeking (185–204), bind to
`127.0.0.1` only with an OS-assigned port (269) — this is the right shape for
a single-local-user trust model and should not be restructured.

Rough edges worth addressing, roughly in priority order:

- **Heartbeat lifecycle is coupled to `stopServer`, which (per §1) never
  runs**: `heartbeat` is created lazily on the first SSE client (153, `??=`)
  but only ever cleared at 1155–1156. Today it survives for the entire
  process lifetime once any client has ever connected — even after
  `eventClients` empties back to zero (a client disconnecting only does
  `eventClients.delete(res)` at line 151; nothing checks whether the set is
  now empty and stops the timer). Once §1 is fixed this stops mattering at
  "plugin disable" granularity, but independently of that fix, clearing
  `heartbeat` whenever `eventClients.size === 0` (checked inside the
  `req.on("close", ...)` handler at line 151) would be a small, self-contained
  correctness improvement.
- **No concurrency/size guard on `/media` and `/art`**: `createReadStream(path)
  .pipe(res)` (203, 213) has no cap on simultaneous streams. Not a practical
  problem given the trust model (one local user, one renderer), but flagging
  since a future feature (e.g. prefetching upcoming queue items) could
  multiply simultaneous range requests without anything here noticing.
- **Global singletons (`server`/`serverInfo`, 110–111) assume one window /
  one profile per main process** — consistent with how `browser` (941),
  `jobs`/`processes` (708–709), and `allowedRoots` (108) are all handled the
  same way throughout the file, so this isn't an isolated inconsistency, just
  a shared scalability ceiling. Not an active bug; worth naming as a known
  limitation rather than fixing speculatively.
- **Deleted-file vs. auth-failure are indistinguishable to the renderer**:
  `handleMedia`'s `stat(path)` (181) throwing (file deleted after the scan,
  before playback) is caught by the outer try/catch (260–264) and surfaces as
  a generic 500 — but the renderer's `<video>` error handler
  (`PlayerStore.ts` media `error` listener, ~109–113) shows the same fixed
  "Could not play X" message regardless of cause. Worth distinguishing at
  least in logs (404 "file vanished" vs 403 "not allowed" vs 500 "other") so
  support/debugging isn't guessing.

---

## 4. IPC surface design

### The mechanism itself is correctly chosen — don't replace it

Every exported async function in `native.ts` becomes one auto-generated
`ipcMain.handle` channel via the build-time glob in `scripts/build/build.mjs`
and the wiring loop in `src/main/ipcPlugins.ts:27–38`
(`VencordPluginNative_LocalMusic_<fnName>`). This gives zero-boilerplate,
type-safe (`PluginNative<typeof import("./native")>`, `PlayerStore.ts:14`)
IPC with no separate channel-name file to keep in sync. This plugin currently
exports 19 functions this way: `getServerInfo` (277), `pickFolder` (281),
`authoriseFolder` (300), `scanFolder` (312), `readMetadata` (366),
`readMetadataBatch` (373), `setGlobalMediaKeys` (416), `ytDlpInfo` (606),
`getBrowserLogin` (501), `search` (639), `startDownload` (860),
`getDownloads` (875), `cancelDownload` (879), `removeDownload` (902),
`clearFinishedDownloads` (914), `openBrowser` (1057),
`updateBrowserOptions` (1126), `closeBrowser` (1130), `stopServer` (1138).
This is a lot of surface for one plugin, but it's flat-by-design (the
mechanism doesn't support nested namespaces per plugin) and each function is
independently a reasonable unit — restructuring the *mechanism* is not
justified.

### Two concrete asymmetries worth fixing within that mechanism

- **`updateBrowserOptions` (1126–1128) exists only to keep two copies of the
  same state in sync.** Every other yt-dlp-related export
  (`ytDlpInfo`, `search`, `startDownload`, `openBrowser`) is stateless between
  calls — the renderer passes a fresh `YtDlpOptions` (`types.ts:31–40`, built
  by `ytDlpOptions()` in `settings.ts:86–93`) every time, and native.ts does
  nothing with it beyond that one call. `openBrowser` breaks this pattern by
  also caching `browseOptions` (native.ts:943) for later use by
  `enqueueFromBrowser` (951–960) — which is why `updateBrowserOptions` has to
  exist at all, and why `Downloader.tsx:140` needs a dedicated `useEffect`
  whose only job is re-syncing it on every `playlist`/`folder` change. This is
  a symptom of the browse window needing a subscription/push model rather
  than the stateless request/response model everything else uses. A cleaner
  fix: have the browser's `/enqueue` sentinel request (native.ts:1111–1120)
  carry the current playlist toggle in its own query string, sourced from
  state the renderer pushes at `openBrowser` time and whenever it changes,
  rather than maintaining a second synced copy in `browseOptions`. This is a
  real but contained refactor scoped to the browser region (924–1136); not
  urgent, but worth doing before adding any more state to that window.
- **No explicit trust-boundary comment on the exported functions.** Every
  handler trusts its arguments' *runtime* shape — TypeScript types are
  compile-time only, and nothing validates e.g. that `startDownload`'s `url`
  argument (860) is actually a string before it reaches
  `/^https?:\/\//i.test(url)` (771). Given these channels are only reachable
  from this plugin's own trusted renderer bundle today, this is low risk and
  **not** a call for runtime validation — but a one-line comment at the top of
  the file stating that assumption explicitly would prevent someone from
  copy-pasting one of these handlers into a context where the caller isn't
  trusted.

Everything else about the current export list (flat functions, one per
operation, download-related ones grouped only by naming convention) is a
reasonable use of the mechanism's ceiling and doesn't need restructuring.

---

## 5. Tag parsing gaps — MP4/M4A

### Current state

`tags.ts`'s `readTags()` (238–244) tries `parseId3` (70–142), then
`parseFlac` (144–176), and returns `{}` on no match or any thrown error.
**There is no MP4/M4A branch at all** — the file's own header comment (7–9)
and the doc comment on `readTags` itself (line 236: "MP4/M4A atoms are not
parsed, those fall back to the file name") both say so explicitly. This is a
known, documented gap, not an oversight to discover — the question is scope
and priority.

### Why it's currently mostly invisible

The plugin's default `ytDlpArgs` (`settings.ts:65`) is
`-x --audio-format mp3 --embed-metadata --embed-thumbnail` — everything
downloaded through the default settings gets transcoded to mp3 specifically
so the existing ID3 path can read it back. The gap becomes visible when:

1. A user changes `ytDlpArgs` to skip the mp3 transcode (many YouTube audio
   streams are natively AAC-in-M4A, so keeping the original codec avoids a
   quality-losing re-encode — a completely reasonable thing to want) — those
   files lose all metadata and cover art immediately.
2. A user drops pre-existing `.m4a`/`.aac` files into their music folder
   directly, outside the downloader. `AUDIO_EXTS` (native.ts:85) already
   lists both as playable, so they appear in the library, just untagged.
3. Video files: `.mp4`/`.m4v` (native.ts:86) are the same container family
   and go through the identical missing-parser path for embedded cover art.

### What a real implementation looks like

MP4-family tags live in the `moov/udta/meta/ilst` atom tree (iTunes-style
atoms — `©nam`=title, `©ART`=artist, `©alb`=album, `covr`=cover), a nested
length-prefixed box structure, fundamentally different from ID3's flat frame
list or FLAC's flat block list — it cannot reuse `parseId3`/`parseFlac`'s
frame-walking loops as-is; it needs its own recursive box walker, but should
mirror their existing shape and defensiveness:

1. Add `parseMp4(path): Promise<ParsedTags | null>`, same signature pattern
   as `parseFlac` (144–176).
2. Reuse `readBytes(path, length, position)` (tags.ts:20–29) unchanged — it's
   already a generic positioned reader, no MP4-specific changes needed there.
3. Walk top-level boxes (`size: uint32` + `fourcc: 4 bytes`), handling the
   64-bit large-box escape (`size === 1`, real size in the next 8 bytes) and
   the `size === 0` ("box extends to EOF") case — neither ID3 nor FLAC parsing
   needed this since those formats aren't nested containers.
4. Descend `moov` → `udta` → `meta` (note: unlike `ilst`'s children, the
   `meta` box itself has a 4-byte version/flags prefix before its children
   start) → `ilst`.
5. Within `ilst`, each child's fourcc is the tag key and contains one `data`
   sub-box (8-byte header: type indicator + locale, then payload). Map
   `©nam`/`©ART`/`©alb` the same way `parseId3`'s frame `switch`
   (104–138) maps `TIT2`/`TPE1`/`TALB`, and map `covr`'s `data` payload (type
   flag 13/14 → JPEG/PNG) into `tags.picture` the same way `APIC` is handled
   (114–137).
6. Apply the same bounds-checking discipline the existing parsers use
   (`if (size <= 0 || offset + ... > body.length) break` — mirrors the FLAC
   guard at line 161 and the ID3 guard at line 99) so a malformed or
   truncated atom can't read past the buffer or infinite-loop.
7. Wire it into `readTags` (238–244) as a third fallback:
   `(await parseId3(path)) ?? (await parseFlac(path)) ?? (await parseMp4(path)) ?? {}`.

### Scope honesty

This is meaningfully more code than the FLAC parser — FLAC's block list is
flat, MP4's box tree requires real recursion through four nested container
levels plus the 64-bit/zero-size edge cases those flatter formats never had
to handle. But it fits the file's existing "no dependencies, just enough for
title/artist/album/cover" philosophy exactly as well as the FLAC parser does
— it's a bounded, fully-specified addition, not a reason to pull in a
metadata library.

---

## Suggested sequencing

1. **Wire `stopServer`** (§1) — small diff, fixes a real resource/secret leak,
   no design questions to resolve first.
2. **`collect()` error-message consistency + describeSpawnError quarantine
   case** (§2) — small, low-risk, immediately improves error messages users
   actually see.
3. **Download concurrency queue** (§2) — the one piece of real new design
   (queue + a `"queued"` status), worth doing before this plugin sees heavier
   use (e.g. large "Download all" runs).
4. **MP4/M4A tag parsing** (§5) — self-contained, additive, no interaction
   with the other items; can happen in parallel with 1–3.
5. **HTTP server heartbeat lifecycle tidy** (§3) — small, but low urgency
   once §1 lands, since §1 already bounds the leak to "while the plugin is
   enabled" instead of "forever."
6. **`browseOptions`/`updateBrowserOptions` refactor** (§4) — the most
   invasive item here (touches the browse-window protocol), lowest urgency;
   do last and only if more state needs to join `browseOptions` anyway.
