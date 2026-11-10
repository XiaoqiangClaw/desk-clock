#!/usr/bin/env python3
"""v0.6.3 verification: NSIS installerHooks auto-close fix.

Pure-file structural assertions only (no Chromium needed on this host).
Does not replace the 8 older suites; checks hooks.nsh, tauri.conf.json,
lib.rs single-instance callback, version consistency and docs.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


# ===== 1. hooks.nsh =====
hooks = ROOT / "src-tauri" / "windows" / "hooks.nsh"
check("hooks.nsh exists", hooks.exists(), str(hooks))
h = hooks.read_text(encoding="utf-8") if hooks.exists() else ""
check("hooks.nsh defines NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREINSTALL" in h)
check("hooks.nsh defines NSIS_HOOK_PREUNINSTALL", "NSIS_HOOK_PREUNINSTALL" in h)
check("hooks.nsh defines NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_POSTINSTALL" in h)
check("hooks.nsh defines NSIS_HOOK_POSTUNINSTALL", "NSIS_HOOK_POSTUNINSTALL" in h)
check("hooks.nsh calls KillProcessCurrentUser", "KillProcessCurrentUser" in h)
check("hooks.nsh calls RunAsUser", "RunAsUser" in h)
check("hooks.nsh calls FindProcessCurrentUser", "FindProcessCurrentUser" in h)
check("hooks.nsh uses --dc-exit-for-install", "--dc-exit-for-install" in h)
check("hooks.nsh inserts prepare macro in both PRE hooks",
      len(re.findall(r"!insertmacro\s+_DC_PREPARE_APP_EXIT", h)) == 2,
      len(re.findall(r"!insertmacro\s+_DC_PREPARE_APP_EXIT", h)))
check("hooks.nsh checks FindProcessCurrentUser numeric return",
      re.search(r"\$\{If\}\s+\$0\s*!=\s*0", h) is not None)
check("hooks.nsh waits ~3s (200ms x 15)", "Sleep 200" in h and "15" in h)

# ===== 2. tauri.conf.json =====
conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
nsis = conf.get("bundle", {}).get("windows", {}).get("nsis", {})
check("bundle.windows.nsis.installerHooks == ./windows/hooks.nsh",
      nsis.get("installerHooks") == "./windows/hooks.nsh", nsis.get("installerHooks"))
check("tauri.conf.json version is 0.6.3", conf.get("version") == "0.6.3", conf.get("version"))
check("main window title is Desk Clock v0.6.3",
      conf["app"]["windows"][0].get("title") == "Desk Clock v0.6.3",
      conf["app"]["windows"][0].get("title"))
check("bundle.active/targets/icon unchanged",
      conf["bundle"].get("active") is True
      and conf["bundle"].get("targets") == "all"
      and len(conf["bundle"].get("icon", [])) == 5)

# ===== 3. lib.rs single-instance callback =====
lib = (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
m = re.search(
    r"tauri_plugin_single_instance::init\(\|(.*?)\|\s*\{(.*?)\n\s*\}\)",
    lib, re.S,
)
cb = m.group(2) if m else ""
check("single-instance callback found", bool(m))
check("single-instance callback checks --dc-exit-for-install",
      "--dc-exit-for-install" in cb)
check("single-instance callback calls app.exit(0)", "app.exit(0)" in cb)
check("single-instance callback keeps show_main_now fallback", "show_main_now(app)" in cb)
check("CloseRequested still hides to tray (semantics unchanged)",
      "api.prevent_close();" in lib and "let _ = window.hide();" in lib)
check("lib.rs native titles all v0.6.3",
      len(re.findall(r"Desk Clock v0\.6\.3", lib)) == 3
      and "Desk Clock v0.6.2" not in lib,
      len(re.findall(r"Desk Clock v0\.6\.3", lib)))

# ===== 4. version consistency (4 places) =====
cargo = (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
appjs = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
check("Cargo.toml version 0.6.3", 'version = "0.6.3"' in cargo)
check("ui/app.js APP_VERSION 0.6.3", "var APP_VERSION = '0.6.3';" in appjs)
check("verify_v04.py version assertion 0.6.3",
      'version badge shows 0.6.3' in (ROOT / "scripts" / "verify_v04.py").read_text(encoding="utf-8"))
check("no stale 0.6.2 in version sources",
      all("0.6.2" not in (ROOT / p).read_text(encoding="utf-8")
          for p in ("src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "scripts/verify_v04.py")))

# ===== 5. docs =====
for name in ("README.md", "DELIVERY.md", "DELIVERY-v0.6.3.md", "TESTING-v0.6.3.md", "docs/SPEC.md"):
    p = ROOT / name
    check("%s exists and mentions v0.6.3" % name,
          p.exists() and "v0.6.3" in p.read_text(encoding="utf-8"))
check("DELIVERY-v0.6.2.md marked as historical snapshot",
      "历史快照" in (ROOT / "DELIVERY-v0.6.2.md").read_text(encoding="utf-8"))
check("TESTING-v0.6.2.md marked as historical snapshot",
      "历史快照" in (ROOT / "TESTING-v0.6.2.md").read_text(encoding="utf-8"))

failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
    raise SystemExit(1)
