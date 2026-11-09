#!/usr/bin/env python3
"""v0.5 feedback-batch verification (real Chromium, browser-mode simulation).

Covers every item from the user's 2026-11-09 feedback batch:
  1. tray hint moved into the Window tab (no overlap with Appearance tab)
  2. permissions never hang (checking / requesting always settles)
  3. reset button full label + no stray Close button + tidy layout
  4. donation copy: "感谢您的支持", no "（完全自愿）", no scan hint
  5. multi-timezone MANAGER: arbitrary offset, per-window style/seconds,
     edit / hide / show / delete
  6. timer start button shares the row with its input
  7. alarm tone presets + custom audio + test
  8. hidden dropdown arrows + wheel-to-change + hidden scrollbars
  9. settings performance: lightweight slider path (no full i18n re-render)
 10. version badge clickable -> opens project link
Native-only Rust paths are asserted structurally and validated by CI compile.
"""
import functools
import http.server
import os
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "ui"
OUT = ROOT / ".preview"
OUT.mkdir(exist_ok=True)
CHROME = os.environ.get("CHROMIUM", "/usr/bin/chromium")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


httpd = socketserver.TCPServer(
    ("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(UI_DIR))
)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/index.html" % httpd.server_address[1]


def prefs(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")


# Native shim: get_privilege_status can optionally HANG to prove the UI's
# timeout guard still recovers. Default settles normally.
SETTINGS_INIT = r"""
window.__DC_VIEW__='settings';
window.__dc_listeners={};
window.__dc_invokes=[];
window.__DC_HANG_PRIV__ = false;
window.__DC_HANG_RESTART__ = false;
window.__TAURI__={
  core:{invoke:function(cmd,args){
    args=args||{};
    window.__dc_invokes.push(cmd);
    try{
      if(cmd==='get_prefs') return Promise.resolve(JSON.parse(localStorage.getItem('deskclock.prefs')||'{}'));
      if(cmd==='set_prefs'){
        var cur=JSON.parse(localStorage.getItem('deskclock.prefs')||'{}');
        for(var k in args.patch) cur[k]=args.patch[k];
        localStorage.setItem('deskclock.prefs',JSON.stringify(cur));
        return Promise.resolve(cur);
      }
      if(cmd==='get_autostart') return Promise.resolve(false);
      if(cmd==='get_timer_status') return Promise.resolve(null);
      if(cmd==='take_donate_intent') return Promise.resolve(false);
      if(cmd==='get_privilege_status') {
        if(window.__DC_HANG_PRIV__) return new Promise(function(){});
        return Promise.resolve({platform:'windows',isElevated:false,canElevate:true,runAsAdmin:false,note:'shim'});
      }
      if(cmd==='restart_elevated') {
        if(window.__DC_HANG_RESTART__) return new Promise(function(){});
        return Promise.resolve();
      }
      if(cmd==='open_link') return Promise.resolve();
      if(cmd==='set_run_as_admin') return Promise.resolve({platform:'windows',isElevated:false,canElevate:true,runAsAdmin:!!args.enabled,note:'shim'});
      if(cmd==='get_shutdown_status') return Promise.resolve(null);
    }catch(e){}
    return Promise.resolve();
  }},
  event:{listen:function(n,cb){(window.__dc_listeners[n]=window.__dc_listeners[n]||[]).push(cb);return Promise.resolve(function(){});}}
};
"""


def boot_settings(page, prefs_obj=None, init_extra=""):
    page.goto(URL)
    page.evaluate(
        "p => localStorage.setItem('deskclock.prefs', JSON.stringify(p))",
        prefs_obj or {},
    )
    page.add_init_script(SETTINGS_INIT + (init_extra or ""))
    page.reload()
    page.wait_for_timeout(700)


def gototab(page, name):
    page.locator('#settings-tabs .tab[data-tab="%s"]' % name).click()
    page.wait_for_timeout(120)


with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True, executable_path=CHROME, args=["--no-sandbox", "--disable-gpu"]
    )
    errors = []

    # ===================== dedicated settings window =====================
    ctx = browser.new_context(viewport={"width": 560, "height": 720})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("settings: " + str(e)))
    boot_settings(page, {})

    # 1) tray hint lives in the Window tab, not above the Appearance tab
    hint = page.locator("#tray-hint")
    check("tray hint exists", hint.count() == 1)
    check("tray hint inside Window panel",
          hint.evaluate("e => !!e.closest('[data-panel=window]')"))
    check("tray hint NOT in settings head",
          hint.evaluate("e => !e.closest('.settings-head')"))
    gototab(page, "appearance")
    check("tray hint hidden on Appearance tab (no overlap)", hint.is_hidden())
    gototab(page, "window")
    check("tray hint visible on Window tab", hint.is_visible())
    check("tray hint does not overlap tab bar",
          hint.bounding_box()["y"] > page.locator("#settings-tabs").bounding_box()["y"])

    # 3) reset button: full label, no stray Close, tidy
    gototab(page, "about")
    reset = page.locator("#reset-defaults")
    check("reset label fully spelled out", "一键还原默认设置" in reset.inner_text(),
          reset.inner_text())
    check("no stray bottom Close button", page.locator("#settings-close-2").count() == 0)
    check("reset note present", page.locator(".reset-note").count() == 1)
    rb = reset.bounding_box()
    nb = page.locator(".reset-note").bounding_box()
    check("reset note sits below button, no overlap", nb["y"] >= rb["y"] + rb["height"] - 2,
          (rb["y"], rb["height"], nb["y"]))

    # 4) donation copy
    check("donate note has no 完全自愿",
          "完全自愿" not in page.locator(".donate-note").inner_text(),
          page.locator(".donate-note").inner_text())
    check("donate foot is exactly 感谢您的支持",
          page.locator(".donate-foot").inner_text().strip() == "感谢您的支持",
          page.locator(".donate-foot").inner_text())
    check("donate foot has no 截图/长按/扫码",
          not any(w in page.locator(".donate-foot").inner_text() for w in ["截图", "长按", "扫码"]))

    # 10) version badge clickable -> open_link('project')
    gototab(page, "about")
    before = page.evaluate("window.__dc_invokes.filter(x=>x==='open_link').length")
    page.locator("#ver-badge").click()
    page.wait_for_timeout(120)
    after = page.evaluate("window.__dc_invokes.filter(x=>x==='open_link').length")
    check("version badge opens project link", after == before + 1, (before, after))
    check("about version badge also clickable", page.locator("#about-version").count() == 1)

    # 2) permission resolves normally
    gototab(page, "permission")
    check("perm status settled (not '正在检查权限')",
          "正在检查" not in page.locator("#perm-status").inner_text(),
          page.locator("#perm-status").inner_text())
    # elevate button must recover even when restart_elevated never settles
    page.evaluate("window.__DC_HANG_RESTART__ = true")
    page.locator("#perm-elevate-now").click()
    page.wait_for_timeout(150)
    check("elevate shows requesting state", "正在请求授权" in page.locator("#perm-elevate-now").inner_text(),
          page.locator("#perm-elevate-now").inner_text())
    # withTimeout is 8s; wait for the guard
    page.wait_for_timeout(8500)
    check("elevate button recovers from hang (no eternal spinner)",
          "正在请求授权" not in page.locator("#perm-elevate-now").inner_text()
          and not page.locator("#perm-elevate-now").is_disabled(),
          page.locator("#perm-elevate-now").inner_text())

    # 7) alarm tones: presets + custom + test
    gototab(page, "alarm")
    tone = page.locator("#pref-alarm-tone")
    check("tone select has 6 options", tone.locator("option").count() == 6,
          tone.locator("option").count())
    tone.select_option("bell")
    page.wait_for_timeout(150)
    check("tone pref persisted", prefs(page).get("alarmTone") == "bell")
    check("Alarm exposes tone API",
          page.evaluate("Array.isArray(window.DeskClock.Alarm.ALLOWED_TONES) && window.DeskClock.Alarm.ALLOWED_TONES.length===6"))
    check("test sound button present", page.locator("#alarm-test-sound").count() == 1)
    check("custom audio picker present", page.locator("#alarm-custom-pick").count() == 1)
    check("custom audio file input present", page.locator("#alarm-custom-file").count() == 1)

    # 8) hidden dropdown arrows + wheel-to-change
    arrow = page.locator("#pref-alarm-tone").evaluate("e => getComputedStyle(e).backgroundImage")
    check("select has minimal/hidden arrow", "gradient" in arrow)
    cur = tone.input_value()
    page.locator("#pref-alarm-tone").hover()
    page.mouse.wheel(0, 120)
    page.wait_for_timeout(150)
    check("wheel changes select value", tone.input_value() != cur, (cur, tone.input_value()))
    # scrollbars hidden in settings window
    sb = page.locator("#settings-panels").evaluate("e => getComputedStyle(e).scrollbarWidth")
    check("settings scrollbar hidden", sb == "none", sb)

    # 9) performance: slider uses lightweight path (no full I18n DOM sweep)
    gototab(page, "appearance")
    # instrument I18n.apply to count calls
    page.evaluate("""() => {
      window.__i18n_calls = 0;
      var orig = window.DeskClock.I18n.apply;
      window.DeskClock.I18n.apply = function(){ window.__i18n_calls++; return orig.apply(null, arguments); };
    }""")
    op = page.locator("#pref-opacity")
    op.fill("0.5")
    op.dispatch_event("input")
    page.wait_for_timeout(150)
    calls = page.evaluate("window.__i18n_calls")
    check("opacity slider does NOT trigger full I18n sweep", calls == 0, calls)
    check("opacity still applied to clock prefs", prefs(page).get("opacity") == 0.5)

    # 6) timer start button inline with input (both modes)
    gototab(page, "timer")
    for mode, inp in [("duration", "#shutdown-min"), ("clock", "#shutdown-time")]:
        page.locator("#shutdown-mode").select_option(mode)
        page.wait_for_timeout(120)
        ib = page.locator(inp).bounding_box()
        bb = page.locator("#shutdown-start").bounding_box()
        check("start shares row with %s input" % mode, abs(ib["y"] - bb["y"]) < 14,
              (ib["y"], bb["y"]))

    # 5) manager: arbitrary offset, per-window style, edit/hide/delete
    gototab(page, "timezone")
    check("manager present", page.locator("#cm-list").count() == 1)
    check("manager zone count >= 20", page.locator("#cm-zone option").count() >= 20,
          page.locator("#cm-zone option").count())
    check("manager allows arbitrary offset",
          page.locator('#cm-zone option[value="__custom__"]').count() == 1)
    page.locator("#cm-name").fill("东京")
    page.locator("#cm-zone").select_option("540")
    page.locator("#cm-style").select_option("neon")
    page.locator("#cm-seconds").uncheck()
    page.locator("#cm-add").click()
    page.wait_for_timeout(180)
    cl = prefs(page).get("extraClocks", [])
    check("manager persists style+seconds+offset",
          len(cl) == 1 and cl[0]["offset"] == 540 and cl[0]["style"] == "neon"
          and cl[0]["showSeconds"] is False, cl)
    check("manager row rendered", page.locator("#cm-list .cm-row").count() == 1)
    # hide/show
    page.locator("#cm-list .cm-row button").nth(1).click()
    page.wait_for_timeout(150)
    check("manager hide updates config", prefs(page)["extraClocks"][0]["visible"] is False)
    page.locator("#cm-list .cm-row button").nth(1).click()
    page.wait_for_timeout(150)
    check("manager show updates config", prefs(page)["extraClocks"][0]["visible"] is True)
    # edit
    page.locator("#cm-list .cm-row button").nth(0).click()
    page.wait_for_timeout(120)
    check("edit exposes save/cancel",
          page.locator("#cm-save").is_visible() and page.locator("#cm-cancel").is_visible())
    page.locator("#cm-name").fill("大阪")
    page.locator("#cm-save").click()
    page.wait_for_timeout(150)
    check("edit saves new label", prefs(page)["extraClocks"][0]["label"] == "大阪")
    # arbitrary custom offset
    page.locator("#cm-name").fill("加德满都")
    page.locator("#cm-zone").select_option("__custom__")
    page.wait_for_timeout(100)
    page.locator("#cm-offset").fill("+05:45")
    page.locator("#cm-add").click()
    page.wait_for_timeout(180)
    cl = prefs(page).get("extraClocks", [])
    check("arbitrary +05:45 offset -> 345 min", any(c["offset"] == 345 for c in cl), cl)
    # delete via danger button
    page.locator("#cm-list .cm-row button.danger").first.click()
    page.wait_for_timeout(150)
    check("manager delete removes one", len(prefs(page).get("extraClocks", [])) == 1)

    # ===================== hanging privilege-status guard =====================
    ctx2 = browser.new_context(viewport={"width": 560, "height": 720})
    p2 = ctx2.new_page()
    p2.on("pageerror", lambda e: errors.append("perm-hang: " + str(e)))
    boot_settings(p2, {}, "\nwindow.__DC_HANG_PRIV__ = true;")
    # boot_settings init_extra is appended AFTER SETTINGS_INIT but add_init_script
    # runs before page scripts, so force the flag via evaluate + reload instead
    p2.evaluate("window.__DC_HANG_PRIV__ = true")
    p2.reload()
    gototab(p2, "permission")
    p2.wait_for_timeout(4500)
    check("privilege check timeout offers retry button",
          p2.locator("#perm-retry").is_visible(),
          p2.locator("#perm-status").inner_text())
    check("privilege status text is failure, not checking",
          "正在检查" not in p2.locator("#perm-status").inner_text(),
          p2.locator("#perm-status").inner_text())

    check("no JS errors across v0.5 run", not errors, errors[:5])
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
import sys
sys.exit(1 if failed else 0)
