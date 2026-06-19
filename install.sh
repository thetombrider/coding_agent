#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
BUN_BIN="${BUN_INSTALL}/bin/bun"

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    return
  fi
  if [[ -x "$BUN_BIN" ]]; then
    return
  fi
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
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

install_bun
export PATH="${BUN_INSTALL}/bin:${PATH}"

cd "$ROOT"

echo "Installing dependencies..."
bun install

echo "Building orin..."
bun run build

echo "Initializing ~/.orin/config.json..."
bun run init-config

echo "Linking orin command..."
bun link

echo
echo "Orin is ready."
echo
echo "Start the agent:"
echo "  orin"
echo
echo "Configure API keys in the TUI after starting:"
echo "  /providers configure openrouter   LLM provider (required for real agent use)"
echo "  /settings e2b                     E2B key for the task tool (optional)"
echo "Keys are saved to ~/.orin/config.json (or set OPENROUTER_API_KEY / E2B_API_KEY)."
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
