#!/usr/bin/env node
// Headless reproduction of the Terminal.app "Gi=31337…" graphics-probe leak.
//
//   node scripts/repro-graphics-leak.mjs
//
// WHY THIS EXISTS
// ---------------
// OpenTUI's native layer only emits its Kitty graphics capability probe
// (`\x1b_Gi=31337,…,a=q,…;AAAA\x1b\\`) AFTER a real terminal answers its
// capability handshake. Under a bare pipe / dumb PTY nothing answers, native
// bails before the graphics step, and the probe never fires — so a naive
// headless run looks "clean" and proves nothing.
//
// This harness puts the app on the SLAVE side of a real PTY and, on the MASTER
// side, replays the answers a macOS Terminal.app would send (cursor position,
// DA1, DECRQM) while staying SILENT for everything Terminal.app does not support
// (Kitty graphics, Kitty keyboard, XTVERSION). That drives native detection all
// the way to the graphics step, so the probe — if our source regression is
// present — actually gets written. We then assert whether `Gi=31337` / `\x1b_G`
// shows up in what the app wrote.
//
// EXIT CODE (so it doubles as a `git bisect run` oracle):
//   0 = GOOD  (no probe leaked)
//   1 = BAD   (probe leaked)
//   125 = could not run (e.g. node-pty missing) → bisect skips this commit
//
//   git bisect start <bad> <good>
//   git bisect run node scripts/repro-graphics-leak.mjs
//
// REQUIREMENTS
//   • Run on the affected platform (macOS / the OpenTUI native lib that leaks).
//     The leak lives in the darwin native dylib; a Linux CI box cannot reproduce
//     it regardless of source, because the leaking native code is not loaded.
//   • `node-pty` (dynamically imported). If absent:
//        bun add -d node-pty   # or: npm i -D node-pty
//
// Tuning via env: REPRO_TIMEOUT_MS (default 6000), REPRO_DEBUG=1 (dump traffic).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = Number(process.env.REPRO_TIMEOUT_MS ?? 6000);
const DEBUG = process.env.REPRO_DEBUG === "1";

const dbg = (...a) => DEBUG && console.error("[repro]", ...a);

let pty;
try {
  pty = await import("node-pty");
} catch {
  console.error(
    "repro: node-pty is required but not installed.\n" +
      "       Install it with:  bun add -d node-pty   (or npm i -D node-pty)",
  );
  process.exit(125); // bisect: skip — cannot evaluate this commit
}

// What the app WRITES that we must answer for native detection to proceed.
const CURSOR_POS_REQ = /\x1b\[6n/;          // DSR cursor position
const PRIMARY_DA = /\x1b\[(?:0)?c/;         // DA1
const SECONDARY_DA = /\x1b\[>(?:0)?c/;      // DA2
const DECRQM = /\x1b\[\?(\d+)\$p/g;         // mode query  ESC [ ? Ps $ p

// The smoking gun: OpenTUI's Kitty graphics capability query.
const PROBE = /\x1b_G|Gi=\d+,[^;]*a=q[^;]*;/;

// Terminal.app-ish replies. It is an xterm relative: answers cursor/DA/DECRQM,
// and is SILENT for Kitty graphics, Kitty keyboard and XTVERSION.
function terminalAppReplies(chunk) {
  let out = "";
  if (CURSOR_POS_REQ.test(chunk)) out += "\x1b[1;1R";
  if (SECONDARY_DA.test(chunk)) out += "\x1b[>1;95;0c";
  else if (PRIMARY_DA.test(chunk)) out += "\x1b[?1;2c"; // vt100 + AVO
  let m;
  DECRQM.lastIndex = 0;
  while ((m = DECRQM.exec(chunk)) !== null) {
    // Report every queried mode as "reset" (2): not enabled. Enough for the
    // handshake to complete without claiming graphics support.
    out += `\x1b[?${m[1]};2$y`;
  }
  return out;
}

const term = pty.spawn(
  "bun",
  ["src/cli.ts", "--faux"],
  {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: ROOT,
    env: {
      ...process.env,
      // Emulate the real Terminal.app environment that triggers the leak.
      TERM_PROGRAM: "Apple_Terminal",
      TERM: "xterm-256color",
      // Do NOT pre-set OPENTUI_GRAPHICS here — we want to observe whether the
      // app's own source disables the probe. (Set it to test the env path.)
    },
  },
);

let buffer = "";
let leaked = false;
let settled = false;

const finish = (code, reason) => {
  if (settled) return;
  settled = true;
  dbg("finishing:", reason);
  try {
    term.write("\x03"); // Ctrl+C — ask the app to exit
    term.write("q");
  } catch {}
  setTimeout(() => {
    try {
      term.kill();
    } catch {}
    if (leaked) {
      console.error("LEAK: OpenTUI graphics probe (Gi=31337…) was written to the terminal.");
    } else {
      console.error("CLEAN: no graphics probe observed within the window.");
    }
    process.exit(code);
  }, 150);
};

term.onData((data) => {
  buffer += data;
  if (DEBUG) dbg("app→term:", JSON.stringify(data));

  if (!leaked && PROBE.test(data)) {
    leaked = true;
    finish(1, "probe detected");
    return;
  }

  const replies = terminalAppReplies(data);
  if (replies) {
    dbg("term→app:", JSON.stringify(replies));
    term.write(replies);
  }
});

term.onExit(({ exitCode }) => {
  dbg("app exited", exitCode);
  finish(leaked ? 1 : 0, "app exited");
});

// No probe within the window → treat as clean (GOOD).
setTimeout(() => finish(leaked ? 1 : 0, "timeout"), TIMEOUT_MS);
