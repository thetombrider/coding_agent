#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="${BUN_INSTALL}/bin/bun"

# ── Colors ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_LOGO=$'\033[38;5;187m'   # logoHighlight (#D4CCC0)
  C_BAR=$'\033[38;5;187m'    # filled portion
  C_TRACK=$'\033[38;5;240m'  # empty portion
  C_LABEL=$'\033[1m'
  C_OK=$'\033[38;5;114m'
else
  C_RESET=""
  C_DIM=""
  C_LOGO=""
  C_BAR=""
  C_TRACK=""
  C_LABEL=""
  C_OK=""
fi

# ── Logo ────────────────────────────────────────────────────────────────────
print_logo() {
  printf '%s\n' ""
  while IFS= read -r line; do
    printf '%s%s%s\n' "${C_LOGO}" "${line}" "${C_RESET}"
  done <<'LOGO'
  ██████╗  ██████╗  ██╗ ███╗   ██╗
 ██╔═══██╗ ██╔══██╗ ██║ ████╗  ██║
 ██║   ██║ ██████╔╝ ██║ ██╔██╗ ██║
 ██║   ██║ ██╔══██╗ ██║ ██║╚██╗██║
 ╚██████╔╝ ██║  ██║ ██║ ██║ ╚████║
  ╚═════╝  ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═══╝
LOGO
  printf '%s\n' ""
}

# ── Progress bar ────────────────────────────────────────────────────────────
BAR_WIDTH=32
STEP_INDEX=0
STEP_LABEL=""

# Total steps run inside the bar. (Bun is only counted if it actually installs.)
TOTAL_STEPS=4

# Redraw the single in-place bar line:  ████████░░░░  25%  Installing dependencies …
# \r returns to col 0, \033[K erases the rest, so only one bar line ever exists.
draw_bar() {
  local progress=$1
  local filled=$(( progress * BAR_WIDTH / TOTAL_STEPS ))
  if (( filled > BAR_WIDTH )); then filled=$BAR_WIDTH; fi
  local empty=$(( BAR_WIDTH - filled ))
  local bar=""
  if (( filled > 0 )); then bar+="${C_BAR}$(printf '█%.0s' $(seq 1 "$filled"))${C_RESET}"; fi
  if (( empty > 0 )); then bar+="${C_TRACK}$(printf '░%.0s' $(seq 1 "$empty"))${C_RESET}"; fi
  local pct=$(( progress * 100 / TOTAL_STEPS ))
  if (( pct > 100 )); then pct=100; fi
  local lbl="${STEP_LABEL}"
  if [[ -n "$lbl" ]]; then lbl="  ${lbl}"; fi
  printf '\r\033[K  %s  %3d%%%s' "$bar" "$pct" "$lbl"
}

# begin_step "Label" — show the label next to the (still-empty-for-this-step) bar.
begin_step() {
  STEP_LABEL="${C_LABEL}$1 …${C_RESET}"
  draw_bar "$STEP_INDEX"
}

# finish_step "Label" — advance the bar by one step and redraw it in place.
# No newline: the bar stays on its single line until everything is done.
finish_step() {
  local label=$1
  local inc=${2:-1}
  STEP_INDEX=$(( STEP_INDEX + inc ))
  STEP_LABEL=""
  draw_bar "$STEP_INDEX"
}

# ── Steps ───────────────────────────────────────────────────────────────────
install_bun() {
  if command -v bun >/dev/null 2>&1 || [[ -x "$BUN_BIN" ]]; then
    # nothing to do; don't count toward the bar
    return 0
  fi
  TOTAL_STEPS=$(( TOTAL_STEPS + 1 ))
  begin_step "Installing Bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  finish_step "Installing Bun"
}

ensure_path_hint() {
  local bun_bin_dir="${BUN_INSTALL}/bin"
  if [[ ":$PATH:" != *":${bun_bin_dir}:"* ]]; then
    echo
    echo "Add Bun to your PATH so the orin command is available:"
    echo "  export PATH=\"${bun_bin_dir}:\$PATH\""
    echo
    echo "To make this permanent, add that line to ~/.bashrc or ~/.zshrc."
  fi
}

# ── Run ──────────────────────────────────────────────────────────────────────
# Count real steps so the bar denominator is always correct.
TOTAL_STEPS=4  # deps, build, init-config, link (Bun install is conditional)

print_logo
# Draw the initial empty bar on its own line (no newline yet).
draw_bar 0

install_bun
export PATH="${BUN_INSTALL}/bin:${PATH}"
cd "$ROOT"

begin_step "Installing dependencies"
bun install >/dev/null 2>&1
finish_step "Installing dependencies"

begin_step "Building orin"
bun run build >/dev/null 2>&1
finish_step "Building orin"

begin_step "Initializing ~/.orin/config.json"
bun run init-config >/dev/null 2>&1
finish_step "Initializing ~/.orin/config.json"

begin_step "Linking orin command"
bun link >/dev/null 2>&1
finish_step "Linking orin command"

# finalize bar to 100%
STEP_INDEX=$TOTAL_STEPS
STEP_LABEL=""
draw_bar "$STEP_INDEX"
printf '\n\n'

printf '%sOrin is ready.%s\n\n' "${C_OK}" "${C_RESET}"
echo "Start the agent:"
echo "  orin"
echo
echo "Configure API keys in the TUI after starting:"
echo "  /providers configure openrouter   LLM provider (required for real agent use)"
echo "  /settings e2b                     E2B key for the task tool (optional)"
echo "Keys are saved to ~/.orin/config.json."
echo
echo "Offline demo (no API key):"
echo "  orin --faux"
echo
echo "From this repo without a global install:"
echo "  bun run start"
echo
echo "After git pull, run this script again (or: bun run update) to rebuild."
echo

ensure_path_hint
