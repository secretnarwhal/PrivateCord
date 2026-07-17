# GifVault

Turns your favorite GIFs into a file explorer. Fully replaces the Favorites section of Discord's GIF picker.

![Favorites tab replaced by a folder explorer]

## Features

- **Folders in folders** — organize favorites into arbitrarily nested folders, navigated like an OS file explorer (breadcrumbs, up button, Backspace to go up, spring-loaded folders while dragging).
- **Drag & drop everywhere** — drag GIFs onto folders, breadcrumbs or the up button to move them; drag folders into folders to nest; drag a GIF into Discord's chat box to insert its link.
- **Search** — matches custom names, `#tags` and URLs, scoped to the current folder and everything below it.
- **Sorting** — newest/oldest starred, name A–Z / Z–A, shuffle.
- **Names & tags** — right-click a GIF → *Edit name & tags* to make searching actually useful.
- **Resizable popout window** — the ↗ toolbar button opens a movable, resizable floating explorer that works even with the picker closed. Position and size are remembered.
- **Quick actions** — hover a GIF for send / copy link / unfavorite; right-click GIFs, folders or the background for everything else (rename, folder colors, move-to, delete…).

Folder structure, names and tags are stored locally (DataStore). Which GIFs are favorited stays in your Discord account, so unstarring in GifVault = unstarring in Discord.

## Interop

- **GifPaste**: click-to-send goes through Discord's native select path, so GifPaste's insert-instead-of-send behavior is respected.
- **FavoriteGifSearch**: superseded by GifVault's search; it politely no-ops while GifVault controls the Favorites tab, so you can keep both enabled or disable it.
