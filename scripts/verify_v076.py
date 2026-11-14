#!/usr/bin/env python3
"""v0.7.6 regression: the two real root causes must never come back.

1. Alert popup: WebviewWindowBuilder::build() inside a SYNCHRONOUS Tauri
   command deadlocks on Windows WebView2 (official docs.rs warning), so the
   window is never created and IPC never returns. Must be async + worker
   thread, with a page-level fallback.
2. Autostart: auto-launch 0.6.0 writes an UNQUOTED exe path to the Windows
   Run value, so any install dir with a space silently breaks logon startup
   while is_enabled() still reports "on". Must rewrite with quotes + verify.
"""
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
prefs = rd("ui/prefs.js")
html = rd("ui/index.html")
i18n = rd("ui/i18n.js")
alert_html = rd("ui/alert.html")

# ---------------------------------------------------------------- A. popup
# Isolate the show_alert body (from the command signature to the next command).
m = re.search(
    r"#\[tauri::command\]\s*async fn show_alert\((.*?)\n\}\n", lib, re.S
)
check("show_alert is an ASYNC command (not synchronous)", m is not None)
body = m.group(1) if m else ""
check("show_alert builds the window on a worker thread",
      "std::thread::spawn" in body)
# The build() must live INSIDE the spawned closure, never in the command body.
spawn = body.find("std::thread::spawn")
build = body.find(".build()")
check("build() happens inside the spawned closure",
      spawn != -1 and build != -1 and build > spawn,
      f"spawn@{spawn} build@{build}")
check("no duplicate build() in the synchronous part of show_alert",
      len(re.findall(r"\.build\(\)", body)) == 1)
check("alert window is explicitly visible", ".visible(true)" in body)
check("alert window stays opaque (no transparent swallow-click regression)",
      ".transparent(false)" in body)
check("alert window is centred + always on top",
      ".center()" in body and ".always_on_top(true)" in body)
check("alert emits alert-build-failed fallback on build error",
      "alert-build-failed" in body)
check("re-entrant check avoids duplicate label window creation",
      body.count('get_webview_window("alert")') >= 2)
check("alert auto-close is generation-guarded (reuse safe)",
      "ALERT_GENERATION" in lib and "ALERT_GENERATION.fetch_add" in lib
      and "ALERT_GENERATION.load" in lib)

# Frontend fallback + diagnostics wiring
check("app.js remembers last native alert payload",
      "lastAlertPayload" in app and "lastAlertPayload = payload" in app)
check("app.js listens for alert-build-failed",
      "Prefs.listen('alert-build-failed'" in app)
check("app.js fallback shows in-window toast",
      "showInWindowAlertFallback" in app and "toast.hidden = false" in app)
check("alert.html renders reminder content block",
      'id="content"' in alert_html and "[hidden]" in alert_html)
# v0.7.6 修订：主人装机截图反馈「上下黑边」。卡片必须铺满窗口、
# 与窗口同色，否则 flex 居中会在上下露出窗口底色形成黑边。
check("alert card fills window (no top/bottom letterbox)",
      "height: 100%" in alert_html and "justify-content: center" in alert_html
      and "border-radius: 0" in alert_html)
check("alert card background equals window background",
      "background: #181a1f" in alert_html)
check("alert layout regression script exists and is in CI",
      (ROOT / "scripts" / "verify_alert_layout.py").exists()
      and "scripts/verify_alert_layout.py" in rd(".github/workflows/build.yml"))
# v0.7.6 二次修订：窗口按内容自适应（真机二次反馈「还是这个样子」）
check("alert window uses compact initial size, not fixed 260",
      ".inner_size(360.0, 176.0)" in lib and ".inner_size(360.0, 260.0)" not in lib)
check("resize_alert command exists, is registered and clamps height",
      "fn resize_alert(" in lib and "resize_alert," in lib
      and "height.clamp(120.0, 420.0)" in lib)
check("alert.html measures content and calls resize_alert",
      "fitWindow" in alert_html and "invoke('resize_alert'" in alert_html)
check("alert.html refits on reused-window payload update",
      "render(); fitWindow();" in alert_html)

# ------------------------------------------------------------- B. autostart
check("repair_windows_run_value exists",
      "fn repair_windows_run_value(app: &AppHandle)" in lib)
# The quoted path is the whole point: `\"<exe>\" --startup`.
check("Run value is written with a QUOTED absolute exe path",
      'format!("\\"{}\\" --startup", exe.display())' in lib)
check("Run value is read back and verified",
      "fn reg_query_raw" in lib and "Run value read-back mismatch" in lib)
check("repair handles both HKCU and HKLM",
      "WIN_RUN_KEY_HKLM" in lib and "WIN_RUN_KEY" in lib)
check("reg.exe runs without flashing a console window",
      "CREATE_NO_WINDOW" in lib or "0x0800_0000" in lib)
check("set_autostart writes the registry value directly on Windows",
      "repair_windows_run_value(&app)?;" in lib)
check("startup self-heal also repairs (not just re-enables)",
      "autostart repair failed" in lib and "win_autostart_healthy(handle)" in lib)
check("diagnostics command is registered",
      "get_autostart_diagnostics" in lib and "repair_autostart" in lib)
check("diagnostics expose the real registry state",
      all(k in lib for k in ("pathQuoted", "pathMatchesExe", "runValue",
                             "runAsAdminCompat", "disabledByTaskManager")))
check("diagnostics are read-only (no reg add in probe)",
      "fn windows_autostart_probe" in lib)
check("prefs.js exposes diagnostics + repair",
      "autostartDiagnostics: autostartDiagnostics" in prefs
      and "repairAutostart: repairAutostart" in prefs)
check("settings UI has diagnose + repair buttons",
      'id="autostart-diag-btn"' in html and 'id="autostart-repair-btn"' in html
      and 'id="autostart-diag"' in html)
check("app.js renders diagnostics and wires both buttons",
      "describeAutostart" in app and "Prefs.autostartDiagnostics()" in app
      and "Prefs.repairAutostart()" in app)
check("i18n covers diagnostics strings (zh + en)",
      "autostartDiagUnquoted" in i18n and "autostartDiagAdmin" in i18n
      and "alertFallback" in i18n
      and i18n.count("autostartDiagOk") == 2)
check("UAC / RUNASADMIN conflict is explicitly surfaced",
      "runAsAdminCompat" in app and "autostartDiagAdmin" in i18n)

# ------------------------------------------------------------ C. packaging
check("version bumped past 0.7.6",
      "var APP_VERSION = '0.7.8';" in app
      and '"version": "0.7.8"' in rd("src-tauri/tauri.conf.json")
      and 'version = "0.7.8"' in rd("src-tauri/Cargo.toml"))
check("CHANGELOG documents the autostart root cause",
      "v0.7.6" in rd("CHANGELOG.md") and "auto-launch" in rd("CHANGELOG.md"))
check("release body targets v0.7.8",
      "## 🕐 Desk Clock v0.7.8" in rd(".github/workflows/release.yml"))
check("new regression script is in CI static checks",
      "scripts/verify_v076.py" in rd(".github/workflows/build.yml"))

# ---------------------------------------------------------------- summary
failed = [n for n, ok, _ in results if not ok]
print(f"\n=== SUMMARY: {len(results) - len(failed)} passed, {len(failed)} failed ===")
for n, _, d in results:
    if not n in failed:
        continue
    print("  FAILED:", n, d)
raise SystemExit(1 if failed else 0)
