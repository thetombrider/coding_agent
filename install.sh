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

# Seed a global ~/.orin/.env so `orin` finds the API key from ANY directory,
# not just the repo. Without this, `orin` only works where a local .env exists.
ORIN_ENV="${HOME}/.orin/.env"
if [[ ! -f "$ORIN_ENV" ]]; then
  mkdir -p "${HOME}/.orin"
  cp "${ROOT}/.env.example" "$ORIN_ENV"
  echo "Created ${ORIN_ENV} — add your OPENROUTER_API_KEY there to run orin anywhere."
fi

echo "Linking orin command..."
bun link

echo
echo "Orin is ready."
echo
echo "Set your API key (works from any directory):"
echo "  edit ~/.orin/.env and set OPENROUTER_API_KEY=..."
echo "  (or add it to ~/.orin/config.json under provider.openrouter.apiKey)"
echo
echo "Start the agent:"
echo "  orin"
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
