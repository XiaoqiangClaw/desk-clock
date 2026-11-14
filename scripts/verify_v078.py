#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.7.8 regression: Windows autostart must not be blocked by the RUNASADMIN
compatibility layer, and the two settings must be mutually exclusive.

🔴 真机根因（主人 Windows 11 build 26200，2026-11-14）：
    注册表 Run 值完全正确 —— 带引号、指向真实存在的 v0.7.7 exe；
    StartupApproved 两个字节都是 02（启用）；火绒与任务管理器都显示「已启用」；
    但 startup.log 里只有 MANUAL、从来没有 AUTOSTART —— Windows 登录时压根没执行它。
    而 AppCompatFlags\Layers 里有一条：
        "C:\\...\\Desk Clock\\desk-clock.exe" = RUNASADMIN

RUNASADMIN 的含义是「这个 exe 每次启动都弹 UAC 提权」。在**登录阶段**（开机自启）
没有交互桌面可以弹 UAC，Windows 就把这个启动项**静默跳过** —— 注册表一切正常，
进程却永远不出现。v0.7.7 只清了 StartupApproved，没碰 AppCompatFlags\Layers，所以仍失败。

v0.7.8 的四条硬约束（本脚本逐条断言）：
  A. 开启/修复开机自启 → 必须清掉 RUNASADMIN 兼容层；
  B. 开机自启与「始终以管理员身份启动」互斥，代码里要挡；
  C. 诊断要能点名这个真凶（adminCompatBlocking）；
  D. 安装器要自己写启动项 —— 打破「程序起不来 → 自愈跑不了 → 永远修不好」的死锁。
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
FAILED = []


def rd(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def check(name, ok, detail=""):
    if ok:
        print("PASS " + name)
    else:
        print("FAIL " + name + (" — " + str(detail) if detail else ""))
        FAILED.append(name)


lib = rd("src-tauri/src/lib.rs")
hooks = rd("src-tauri/windows/hooks.nsh")
appjs = rd("ui/app.js")
prefsjs = rd("ui/prefs.js")
conf = json.loads(rd("src-tauri/tauri.conf.json"))

# ------------------------------------------------ A. clearing RUNASADMIN
check("repair_windows_run_value clears the RUNASADMIN compat layer",
      "fn repair_windows_run_value" in lib
      and re.search(r"fn repair_windows_run_value.*?clear_admin_compat\(\)", lib, re.S) is not None,
      "the repair path must remove RUNASADMIN, otherwise login silently skips the entry")

check("clear_admin_compat helper exists and delegates to set_admin_compat(false)",
      "fn clear_admin_compat" in lib and "set_admin_compat(false)" in lib)

check("set_autostart_ex clears RUNASADMIN before writing the Run value",
      "fn set_autostart_ex" in lib
      and re.search(r"fn set_autostart_ex.*?clear_admin_compat\(\)\?;", lib, re.S) is not None,
      "enabling autostart must drop RUNASADMIN first")

check("set_autostart_ex reports clearedAdminMode to the UI",
      '"clearedAdminMode"' in lib and '"clearedAdminMode": cleared_admin_mode' in lib)

check("startup self-heal also clears a blocking RUNASADMIN",
      "win_admin_compat_present()" in lib
      and re.search(r"win_autostart_healthy\(handle\).*?clear_admin_compat\(\)", lib, re.S) is not None,
      "a healthy Run value plus RUNASADMIN still fails at logon — self-heal must clear it too")

check("win_admin_compat_present reads AppCompatFlags\\Layers",
      "fn win_admin_compat_present" in lib
      and "WIN_APPCOMPAT_LAYERS_KEY" in lib
      and '"RUNASADMIN"' in lib)

# ------------------------------------------------ B. mutual exclusion
check("set_run_as_admin refuses to enable while autostart is on",
      "ADMIN_AUTOSTART_CONFLICT" in lib
      and re.search(r"fn set_run_as_admin.*?ADMIN_AUTOSTART_CONFLICT", lib, re.S) is not None,
      "the two features are mutually exclusive on Windows (no UAC at logon)")

check("the conflict message explains the UAC-at-logon cause",
      "UAC" in lib and "开机自启" in lib)

# ------------------------------------------------ C. diagnostics
check("probe exposes adminCompatBlocking",
      '"adminCompatBlocking"' in lib
      and "admin_compat_blocking" in lib)

check("diagnostics UI names the root cause explicitly",
      "adminCompatBlocking" in appjs and "静默跳过" in appjs)

check("UI surfaces clearedAdminMode without a black box",
      "clearedAdminMode" in appjs and "clearedAdminMode" in prefsjs)

check("frontend calls the new set_autostart_ex command",
      "set_autostart_ex" in prefsjs)

# ------------------------------------------------ D. installer writes the entry
check("NSIS post-install hook writes the startup entry",
      "NSIS_HOOK_POSTINSTALL" in hooks
      and re.search(r"!macro NSIS_HOOK_POSTINSTALL\s*\n\s*!insertmacro _DC_WRITE_AUTOSTART", hooks) is not None,
      "the installer must write the Run value — the app cannot self-heal if it never starts")

check("installer writes a quoted absolute path with --startup",
      "'\"$INSTDIR\\desk-clock.exe\" --startup'" in hooks)

check("installer clears the StartupApproved disabled byte",
      "StartupApproved" in hooks and "02 00 00 00 00 00 00 00 00 00 00 00" in hooks)

check("installer deletes the legacy value names",
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "desk-clock"' in hooks
      and 'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "DeskClock"' in hooks)

check("installer removes the RUNASADMIN compat layer",
      "AppCompatFlags\\Layers" in hooks
      and 'DeleteRegValue HKCU "Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers"' in hooks)

check("installer only writes when the user had already opted in",
      "ReadRegStr $0 HKCU" in hooks and "${OrIf} $1 != \"\"" in hooks)

# ------------------------------------------------ E. version
check("tauri.conf.json version is 0.7.8", conf.get("version") == "0.7.8", conf.get("version"))
check("Cargo.toml version is 0.7.8", 'version = "0.7.8"' in rd("src-tauri/Cargo.toml"))
check("APP_VERSION is 0.7.8", "var APP_VERSION = '0.7.8';" in appjs)
check("CHANGELOG has a v0.7.8 section",
      "## v0.7.8" in rd("CHANGELOG.md") or "v0.7.8 更新详情" in rd("CHANGELOG.md"))

print()
if FAILED:
    print("=== SUMMARY: %d failed ===" % len(FAILED))
    for f in FAILED:
        print("  FAILED: " + f)
    sys.exit(1)
print("=== SUMMARY: all v0.7.8 checks passed ===")
