// Side-effect-only module. Importing it disables OpenTUI's Kitty graphics
// capability probe on terminals that can't handle it (Terminal.app) by setting
// OPENTUI_GRAPHICS before @opentui/core is ever loaded.
//
// @opentui/core reads OPENTUI_GRAPHICS on first access (caching it) and forwards
// it to the native renderer when the renderer is constructed. Both happen as a
// side effect of importing "@opentui/solid/preload"/the renderer, so this must
// run first. cli.ts imports this module before any @opentui import to guarantee
// that ordering; nothing here imports @opentui.
import { applyTerminalEnvOverrides } from "./terminal-env.js";

applyTerminalEnvOverrides();
