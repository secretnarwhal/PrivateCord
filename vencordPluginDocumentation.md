# Vencord Plugin Development: Post-Mortem & Nuances

This document details the hurdles, hacks, and workarounds required to port a complex script (like Undiscord) into a native Vencord plugin within a Vesktop environment.

## 1. The "Invisible Plugin" Dilemma (File Structure & Build Regex)
**The Problem:** We wrote the plugin, built Vencord, but it wouldn't show up in the plugins list.
**The Nuance/Hack:** Vencord uses a highly specific `esbuild` script (`scripts/build/common.mjs`) to crawl the `src/plugins` directory and generate a massive virtual module.
*   **Attempt 1:** We put it in `userplugins/mass-deleter/index.ts`. The build script for the *desktop* target completely ignored the `userplugins` folder.
*   **Attempt 2:** We moved it to `plugins/mass-deleter/index.ts`. It built, but wasn't added to the global `Vencord.Plugins` object. The build script maps the **folder name** to the internal plugin name. Because our folder was `mass-deleter` but the plugin was `MassDeleter`, the metadata generation failed silently.
*   **The Fix:** We flattened it into a single file: `src/plugins/MassDeleter.ts`. By removing the directory structure and ensuring the filename matched the expected casing, the regex parser successfully grabbed it, exported it, and injected it into the Vencord UI.

## 2. Bypassing Vesktop's Stubborn Cache (The Nuclear Overwrite)
**The Problem:** Even after building Vencord locally and telling Vesktop to use the custom `dist` folder, Vesktop was still loading the old, official binaries without our plugin.
**The Nuance/Hack:** Vesktop downloads and caches `vencordDesktopRenderer.js` in `~/.config/vesktop/sessionData/vencordFiles/`. Sometimes, the app refuses to prioritize the custom path over its local cache.
*   **The Fix:** We bypassed the UI settings entirely and used a shell command to forcibly overwrite Vesktop's cached binaries with our newly built ones:
    `cp -v dist/vencordDesktop* ~/.config/vesktop/sessionData/vencordFiles/`

## 3. The React Import Ban
**The Problem:** The build failed with `[plugin: ban-imports] Cannot import from react.`
**The Nuance/Hack:** Vencord strictly forbids standard React imports because it needs to hook into Discord's internal, modified version of React to maintain context.
*   **The Fix:** We had to import `React`, `useState`, `useEffect`, and `useRef` directly from `@webpack/common`.

## 4. Component Aliasing & Legacy Props Crashing
**The Problem:** The plugin crashed Vesktop the millisecond the UI tried to render.
**The Nuance/Hack:** Vencord recently overhauled all of its UI components, breaking backwards compatibility.
*   **Alias Resolution:** Importing `{ Flex, Button } from "@components"` caused esbuild resolution errors. We had to specify the exact file paths: `import { Flex } from "@components/Flex";`.
*   **Legacy Props:** We tried to use `Button.Colors.RED`. The new components stripped out these old constants, causing a `TypeError: Cannot read properties of undefined`.
*   **The Fix:** We had to update to the modern API: `<Button variant="dangerPrimary">` and `<Heading tag="h5">`.

## 5. Uninitialized Store Crashes
**The Problem:** Clicking the trash icon instantly crashed Discord.
**The Nuance/Hack:** Our UI tried to pre-fill the inputs by calling `UserStore.getCurrentUser().id` and `SelectedGuildStore.getGuildId()` the moment it rendered. However, if the user clicked the button too fast (or if Discord was still connecting to the gateway), these stores returned `undefined`, causing fatal null-pointer exceptions.
*   **The Fix:** We added defensive optional chaining to everything: `UserStore?.getCurrentUser()?.id || ""`. We also wrapped the entire toolbar button in an `<ErrorBoundary>` so that if the UI failed to render, it wouldn't take the rest of Discord down with it.

## 6. Injecting the Toolbar Button
**The Problem:** We wanted the button in the top right next to the search bar, but Vencord doesn't have a simple `addToolbarButton` API.
**The Nuance/Hack:** We had to use regex patching to inject our component directly into Discord's minified React tree.
*   **The Fix:** We targeted the `BACK_FORWARD_NAVIGATION` switch case in Discord's header renderer. We regex-matched the trailing fragment and appended our `<HeaderWrapper>` right next to the Inbox and Help icons.

## 7. Background Execution & State Escaping
**The Problem:** When you close a Vencord `ModalRoot`, the React component is destroyed. If the deletion logic was inside the React component, closing the window would kill the deletion process.
**The Nuance/Hack:** We had to completely decouple the deletion logic from the React UI.
*   **The Fix:** We created `MassDeleterManager`, a pure JavaScript object living in the global scope. It handles the while-loop, rate limits, and progress counting. We then created a custom `useManager()` hook so the React UI and the Toolbar Icon could "subscribe" to the global manager and force a re-render whenever the manager fired its `notify()` function.

## 8. The Clipped SVG Arc
**The Problem:** The spinning blue progress arc was invisible.
**The Nuance/Hack:** Discord's top toolbar container has CSS `overflow: hidden;` applied to it. Because the SVG arc extended 140% outside the bounds of the trash icon to create a ring, Discord's renderer chopped its head off.
*   **The Fix:** Instead of trying to override Discord's core CSS (which causes layout shifts), we switched to an absolute-positioned `8px` status dot (yellow pulsing/green solid). We manually injected the pulse animation via `Vencord.Api.Styles.addStyle("vc-mass-deleter-styles", ...)` so it would animate natively without relying on React state intervals.
