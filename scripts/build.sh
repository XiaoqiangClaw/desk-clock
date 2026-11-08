#!/usr/bin/env bash
# Produce native installers for the current OS (Windows .msi/.exe, macOS .dmg/.app, Linux .deb/.AppImage).
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/cargo not found. Install from https://rustup.rs" >&2; exit 1
fi
if ! cargo tauri --version >/dev/null 2>&1; then
  cargo install tauri-cli --version '^2.0.0' --locked
fi
exec cargo tauri build
