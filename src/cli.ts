#!/usr/bin/env bun

// Bootstrap shim. Keep this file free of any SolidJS / @opentui/solid imports
// (other than the preload below) so the plugin is registered before they load.
//
// OpenTUI's renderer requires Bun's FFI, so `orin` must run on Bun. But under
// Bun, @opentui/solid resolves SolidJS via the "node" export condition to its
// *server* (SSR) build, which breaks the universal TUI renderer — a falsy
// <Show> emits an orphan "" text node and the app crashes on startup. The
// repo's bunfig.toml registers a Bun plugin (via this same preload) that
// rewrites solid-js' server build to its client build, but bunfig.toml is only
// picked up when Bun runs from the repo directory. That's why `orin` worked
// from the clone but crashed from anywhere else.
//
// Importing the preload here registers that plugin programmatically, regardless
// of the current directory. It must run before SolidJS is loaded, so the real
// entrypoint is pulled in via a dynamic import afterwards.
import "@opentui/solid/preload";

await import("./main.js");
