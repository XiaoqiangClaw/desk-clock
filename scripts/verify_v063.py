#!/usr/bin/env python3
"""v0.7.4/v0.7.5 release: installer hooks + version consistency structural checks.
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
check("hooks.nsh calls unrestricted KillProcess", "nsis_tauri_utils::KillProcess " in h)
check("hooks.nsh calls RunAsUser", "RunAsUser" in h)
check("hooks.nsh calls unrestricted FindProcess", "nsis_tauri_utils::FindProcess " in h)
check("hooks.nsh uses --dc-exit-for-install", "--dc-exit-for-install" in h)
# v0.7.2: SID-filtered APIs caused the "Uninstallation Aborted / Failed to kill" hang
# when installer and clock run at different integrity levels. Must never come back.
check("hooks.nsh no longer calls SID-filtered process APIs",
      "nsis_tauri_utils::FindProcessCurrentUser" not in h
      and "nsis_tauri_utils::KillProcessCurrentUser" not in h)
check("hooks.nsh retries KillProcess up to 3 times", "$2 >= 3" in h)
check("hooks.nsh inserts prepare macro in both PRE hooks",
      len(re.findall(r"!insertmacro\s+_DC_PREPARE_APP_EXIT", h)) == 2,
      len(re.findall(r"!insertmacro\s+_DC_PREPARE_APP_EXIT", h)))
check("hooks.nsh checks FindProcess numeric return",
      re.search(r"\$\{If\}\s+\$0\s*!=\s*0", h) is not None)
check("hooks.nsh waits ~3s (200ms x 15)", "Sleep 200" in h and "15" in h)

# ===== 2. tauri.conf.json =====
conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
nsis = conf.get("bundle", {}).get("windows", {}).get("nsis", {})
check("bundle.windows.nsis.installerHooks == ./windows/hooks.nsh",
      nsis.get("installerHooks") == "./windows/hooks.nsh", nsis.get("installerHooks"))
check("tauri.conf.json version is 0.7.8", conf.get("version") == "0.7.8", conf.get("version"))
check("main window title is Desk Clock v0.7.8",
      conf["app"]["windows"][0].get("title") == "Desk Clock v0.7.8",
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
# v0.7.5: app.exit(0) alone was swallowed by the global CloseRequested handler
# (every window answers prevent_close + hide), so the installer path now goes
# through force_quit(), which sets QUITTING and really ends the process.
check("single-instance callback force-quits the app",
      "force_quit(app.clone())" in cb)
check("single-instance callback keeps show_main_now fallback", "show_main_now(app)" in cb)
check("CloseRequested hides to tray but lets quit / alert close for real",
      "api.prevent_close();" in lib and "let _ = window.hide();" in lib
      and "QUITTING.load(Ordering::SeqCst)" in lib
      and 'window.label() == "alert"' in lib)
check("lib.rs native titles all v0.7.8",
      len(re.findall(r"Desk Clock v0\.7\.8", lib)) == 3
      and "Desk Clock v0.6.3" not in lib,
      len(re.findall(r"Desk Clock v0\.7\.8", lib)))

# ===== 4. version consistency (4 places) =====
cargo = (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
appjs = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
check("Cargo.toml version 0.7.8", 'version = "0.7.8"' in cargo)
check("ui/app.js APP_VERSION 0.7.8", "var APP_VERSION = '0.7.8';" in appjs)
check("verify_v04.py version assertion 0.7.8",
      'version badge shows 0.7.8' in (ROOT / "scripts" / "verify_v04.py").read_text(encoding="utf-8"))
check("no stale 0.6.3 in version sources",
      all("0.6.3" not in (ROOT / p).read_text(encoding="utf-8")
          for p in ("src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "scripts/verify_v04.py")))

# ===== 5. docs =====
for name in ("README.md", "CHANGELOG.md", "docs/SPEC.md"):
    p = ROOT / name
    check("%s exists and mentions v0.7.4" % name,
          p.exists() and "v0.7.4" in p.read_text(encoding="utf-8"))
check("no TESTING markdown files", not any((ROOT.glob("TESTING-*.md"))))
check("no DELIVERY markdown files", not any((ROOT.glob("DELIVERY*.md"))))

failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
    raise SystemExit(1)
