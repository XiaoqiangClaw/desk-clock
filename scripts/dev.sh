#!/usr/bin/env bash
# Build & run the native Tauri shell. Requires Rust >= 1.77 and the Tauri v2 CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/cargo not found. Install from https://rustup.rs" >&2
  exit 1
fi
if ! cargo tauri --version >/dev/null 2>&1; then
  echo "tauri-cli v2 not found. Installing (this can take a few minutes)..." >&2
  cargo install tauri-cli --version '^2.0.0' --locked
fi
echo "Linux prerequisites (Debian/Ubuntu):"
echo "  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
echo
exec cargo tauri dev
