#!/usr/bin/env bash
# Headless visual check of the static UI (no Rust toolchain needed).
# 1) verify.py serves ui/ over loopback HTTP (Chromium denies localStorage on
#    file://) and writes the 8 clock-style screenshots .preview/<style>.png.
# 2) preview_settings.py writes the 3 v0.6.1 settings-window screenshots.
# Together they regenerate all 11 tracked .preview/*.png images.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/verify.py
python3 scripts/preview_settings.py
