#!/usr/bin/env python3
"""v0.7.7 regression: Windows autostart must be self-managed (not plugin-driven).

Root cause (verified against upstream sources, not a guess):
  * tauri-plugin-autostart 2.7.0 uses `app.package_info().name` as the Run value
    NAME. tauri-codegen sets `PackageInfo.name` from tauri.conf.json
    `productName` when present -> "Desk Clock" (WITH A SPACE), not the Cargo
    package name "desk-clock".
  * auto-launch 0.6.0 writes `format!("{} {}", app_path, args)` WITHOUT quoting,
    so `C:\\Users\\x\\AppData\\Local\\Desk Clock\\desk-clock.exe --startup`
    is parsed by Windows as `C:\\...\\Desk` and silently skipped at logon.
  * v0.7.6 fixed the quoting but wrote to the WRONG value name ("desk-clock"),
    leaving the plugin's broken "Desk Clock" value in place forever. is_enabled()
    reads "Desk Clock" -> UI always shows "on", logon never starts.

v0.7.7 therefore owns Windows autostart end to end:
  quoted absolute path + --startup, exact read-back, legacy value cleanup,
  StartupApproved disable-flag cleanup, and a startup.log proving whether
  Windows actually launched the app at logon.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


def rd(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


lib = rd("src-tauri/src/lib.rs")
app = rd("ui/app.js")
i18n = rd("ui/i18n.js")
conf = json.loads(rd("src-tauri/tauri.conf.json"))
cargo = rd("src-tauri/Cargo.toml")
readme = rd("README.md")
changelog = rd("CHANGELOG.md")
rels = rd(".github/workflows/release.yml")

# ------------------------------------------------- A. value name = productName
check("Run value name comes from package_info (== productName)",
      "fn win_run_value_name(app: &AppHandle) -> String" in lib
      and "app.package_info().name.clone()" in lib)
check("productName is a single source of truth (with space, as Windows sees it)",
      conf.get("productName") == "Desk Clock")

# ------------------------------------------- B. quoted command + read-back
check("expected Run command is QUOTED absolute path + --startup",
      'format!("\\"{}\\" --startup", exe.display())' in lib)
check("write is verified by an exact read-back comparison",
      "Run value read-back mismatch (expected" in lib)
check("read-back failure surfaces as Err (never a false success)",
      "return Err(format!(" in lib and "registry says" in lib)

# --------------------------------------------------- C. legacy cleanup
check("legacy value names are deleted (v0.7.6 wrote the wrong name)",
      "WIN_LEGACY_RUN_NAMES" in lib
      and '"desk-clock"' in lib
      and lib.count("reg_delete(WIN_RUN_KEY, legacy)") >= 2)
check("legacy cleanup runs in both repair and disable paths",
      "fn win_autostart_disable" in lib and "for legacy in WIN_LEGACY_RUN_NAMES" in lib)

# ------------------------------------------- D. Task Manager disable flag
check("StartupApproved enabled bytes are (re)written",
      "WIN_APPROVED_KEY" in lib and "WIN_APPROVED_ENABLED_HEX" in lib
      and "020000000000000000000000" in lib)
check("disabled-by-Task-Manager state is detected",
      "fn win_is_disabled_by_task_manager" in lib)
check("healthy = quoted + matches exe + not disabled",
      "fn win_autostart_healthy" in lib
      and "!win_is_disabled_by_task_manager(&name)" in lib)

# ------------------------------------------------ E. no plugin on Windows
check("set_autostart bypasses the plugin on Windows",
      '#[cfg(target_os = "windows")]\n    {\n        // v0.7.7' in lib)
check("non-Windows platforms still use the plugin",
      "app.autolaunch().is_enabled()" in lib and "mgr.enable()" in lib)
check("startup self-heal rewrites (not just re-enables)",
      "win_autostart_healthy(handle)" in lib
      and "autostart repair failed" in lib)
check("repair writes back the saved intent (autostart = true)",
      'patch_prefs(&app, "autostart", serde_json::json!(true));' in lib)

# ---------------------------------------------------------- F. startup log
check("startup log is written on every launch",
      "fn win_log_startup" in lib and "win_log_startup(handle);" in lib)
check("startup log distinguishes AUTOSTART vs MANUAL",
      '"AUTOSTART"' in lib and '"MANUAL   "' in lib)
check("startup log records argv (proves the --startup path)",
      "args={:?}" in lib)
check("startup log rotates at 64 KiB",
      "64 * 1024" in lib)
check("diagnostics expose the startup log + its path",
      '"startupLog"' in lib and '"startupLogPath"' in lib)

# ------------------------------------------------------------ G. diagnostics
check("probe is read-only (no reg add inside it)",
      re.search(r"fn windows_autostart_probe\(app: &AppHandle\).*?json!", lib, re.S)
      is not None
      and "reg_add(" not in
      re.search(r"fn windows_autostart_probe\(app: &AppHandle\).*?\n\}\n", lib, re.S).group(0))
check("probe reports valueName / expectedCommand / legacyValues",
      all(k in lib for k in ('"valueName"', '"expectedCommand"', '"legacyValues"', '"healthy"')))
check("UI renders legacy entries + startup log",
      "autostartDiagLegacy" in app and "autostartDiagLog" in app)
check("i18n covers legacy + log strings (zh + en)",
      i18n.count("autostartDiagLegacy") == 2 and i18n.count("autostartDiagLog") == 2)

# --------------------------------------------------------------- H. versions
check("APP_VERSION is 0.7.8", "var APP_VERSION = '0.7.8';" in app)
check("Cargo.toml version is 0.7.8", 'version = "0.7.8"' in cargo)
check("tauri.conf.json version is 0.7.8", conf.get("version") == "0.7.8")
check("lib.rs native titles all v0.7.8 (3)",
      len(re.findall(r"Desk Clock v0\.7\.8", lib)) == 3,
      len(re.findall(r"Desk Clock v0\.7\.8", lib)))
check("README documents v0.7.8", "v0.7.8" in readme)
check("CHANGELOG has a v0.7.8 section", "## v0.7.8" in changelog or "v0.7.8 更新详情" in changelog)
check("release.yml body targets v0.7.8", "## 🕐 Desk Clock v0.7.8" in rels)
check("CI static checks include verify_v077.py",
      "scripts/verify_v077.py" in rd(".github/workflows/build.yml"))

failed = [n for n, ok, _ in results if not ok]
print(f"\n=== SUMMARY: {len(results) - len(failed)} passed, {len(failed)} failed ===")
for n, _, d in results:
    if n in failed:
        print("  FAILED:", n, d)
raise SystemExit(1 if failed else 0)
