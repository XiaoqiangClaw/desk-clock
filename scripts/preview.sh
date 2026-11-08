#!/usr/bin/env bash
# Headless visual check of the static UI (no Rust toolchain needed).
# Delegates to verify.py, which serves ui/ over loopback HTTP so localStorage
# works (Chromium denies it on file://) and writes .preview/<style>.png.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/verify.py
