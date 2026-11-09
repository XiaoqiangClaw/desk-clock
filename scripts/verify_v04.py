#!/usr/bin/env python3
"""v0.4 feature verification (real Chromium, browser-mode simulation).

Covers: tabbed settings, show-separator, analog themes + penetration,
opacity isolation, small精致 buttons, alarm sound/mute, reboot + clock-time
timer, quick position grid, click-through, multi-timezone config, time sync,
donation copy/link/update check, and multi-window time rendering.
Native-only paths are asserted structurally and validated by CI compile.
"""
import functools
import http.server
import os
import re
import socketserver
import sys
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

httpd = socketserver.TCPServer(("127.0.0.1", 0),
                              functools.partial(QuietHandler, directory=str(UI_DIR)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/index.html" % httpd.server_address[1]

def prefs(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")

def set_prefs(page, obj):
    page.evaluate("p => localStorage.setItem('deskclock.prefs', JSON.stringify(p))", obj)

def boot(page, obj=None, init=""):
    page.goto(URL)
    set_prefs(page, obj or {})
    if init:
        page.add_init_script(init)
    page.reload()
    page.wait_for_timeout(800)

SETTINGS_INIT = """
window.__DC_VIEW__='settings';
window.__dc_listeners={};
window.__TAURI__={
  core:{invoke:function(cmd,args){
    args=args||{};
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
      if(cmd==='get_privilege_status') return Promise.resolve({platform:'windows',isElevated:false,canElevate:true,runAsAdmin:false,note:'shim'});
      if(cmd==='check_update') return Promise.resolve({latest:'0.5.1'});
      if(cmd==='get_shutdown_status') return Promise.resolve(null);
    }catch(e){}
    return Promise.resolve();
  }},
  event:{listen:function(n,cb){(window.__dc_listeners[n]=window.__dc_listeners[n]||[]).push(cb);return Promise.resolve(function(){});}}
};
"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=CHROME,
                                 args=["--no-sandbox", "--disable-gpu"])
    errors = []

    # ================= clock window (browser preview, panels flattened) =================
    ctx = browser.new_context(viewport={"width": 1100, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("clock: " + str(e)))
    boot(page)
    page.locator("#gear").click()
    page.wait_for_timeout(150)

    # ---- tab structure ----
    check("8 settings tabs present", page.locator("#settings-tabs .tab").count() == 8,
          page.locator("#settings-tabs .tab").count())
    check("all panels present", page.locator("#settings-panels .panel").count() == 8)

    # ---- show separator (hide but keep spacing) ----
    sep = page.locator("#pref-separator")
    check("separator toggle defaults on", sep.is_checked())
    sep.uncheck()
    page.wait_for_timeout(200)
    check("separator pref persisted", prefs(page).get("showSeparator") is False)
    check("app marks separator hidden", page.locator("#app").get_attribute("data-show-sep") == "false")
    dot_opacity = page.locator(".sep .dot").first.evaluate("e => getComputedStyle(e).opacity")
    check("hidden separator dots transparent", float(dot_opacity) == 0.0, dot_opacity)
    sep_count = page.locator("#clock .sep").count()
    sep.check(); page.wait_for_timeout(150)
    check("separator slots still occupy space", page.locator("#clock .sep").count() == sep_count)

    # ---- analog theme + penetration ----
    page.locator("#pref-style").select_option("analog")
    page.wait_for_timeout(250)
    check("analog theme row visible", page.locator("#analog-theme-row").is_visible())
    check("analog dial renders", page.locator(".analog-dial").count() == 1)
    check("analog has 60 ticks + 12 numbers",
          page.locator(".analog-tick").count() == 60 and page.locator(".analog-num").count() == 12,
          (page.locator(".analog-tick").count(), page.locator(".analog-num").count()))
    check("analog has 3 hands + pin",
          page.locator(".hand").count() == 3 and page.locator(".analog-pin").count() == 1)
    page.locator("#pref-analog-theme").select_option("light")
    page.wait_for_timeout(150)
    check("light theme applied", page.locator("#app").get_attribute("data-analog-theme") == "light")
    check("light theme pref persisted", prefs(page).get("analogTheme") == "light")
    pen = page.locator("#pref-analog-penetrate")
    check("penetration control injected", pen.count() == 1)
    pen.check(); page.wait_for_timeout(150)
    check("penetration applied", page.locator("#app").get_attribute("data-analog-penetrate") == "true")
    check("penetration pref persisted", prefs(page).get("analogPenetrate") is True)
    page.locator("#pref-style").select_option("flip"); page.wait_for_timeout(150)

    # ---- opacity isolation (the reported bug) ----
    op = page.locator("#pref-opacity")
    op.fill("0.4"); op.dispatch_event("input"); page.wait_for_timeout(200)
    settings_op = page.locator("#settings").evaluate("e => getComputedStyle(e).opacity")
    check("embedded settings panel stays opaque when clock opacity changes",
          float(settings_op) == 1.0, settings_op)
    op.fill("1"); op.dispatch_event("input"); page.wait_for_timeout(150)

    # ---- prettier / smaller buttons ----
    btn = page.locator("#alarm-add")
    box = btn.bounding_box()
    check("add button is compact (< 34px tall)", box["height"] < 34, box["height"])
    check("buttons use dc-btn class", page.locator("#alarm-add").get_attribute("class").find("dc-btn") >= 0)
    check("select uses dc-select styling", page.locator("#pref-style").get_attribute("class").find("dc-select") >= 0)

    # ---- alarm sound + mute ----
    snd = page.locator("#pref-alarm-sound")
    check("alarm sound defaults on", snd.is_checked())
    check("test sound button exists", page.locator("#alarm-test-sound").count() == 1)
    check("mute button in toast", page.locator("#alarm-mute").count() == 1)

    # ---- timer: reboot + clock mode ----
    page.locator("#shutdown-action").select_option("reboot")
    page.locator("#shutdown-mode").select_option("clock")
    page.wait_for_timeout(150)
    check("reboot action selectable", prefs(page).get("timerAction") == "reboot")
    check("clock mode pref persisted", prefs(page).get("timerMode") == "clock")
    check("clock-time input visible in clock mode", page.locator("#shutdown-time").is_visible())
    check("duration input hidden in clock mode", page.locator("#shutdown-min").is_hidden())
    # v0.5：启动按钮与输入框同一行
    _inp = page.locator("#shutdown-time").bounding_box()
    _btn = page.locator("#shutdown-start").bounding_box()
    check("start button shares row with clock input", abs(_inp["y"] - _btn["y"]) < 14,
          (_inp["y"], _btn["y"]))
    page.locator("#shutdown-mode").select_option("duration"); page.wait_for_timeout(120)
    _inp2 = page.locator("#shutdown-min").bounding_box()
    _btn2 = page.locator("#shutdown-start").bounding_box()
    check("start button shares row with minutes input", abs(_inp2["y"] - _btn2["y"]) < 14,
          (_inp2["y"], _btn2["y"]))
    page.locator("#shutdown-mode").select_option("clock"); page.wait_for_timeout(120)
    # minutesUntil: a time 1 minute later should produce 1 (crossing midnight handled)
    m = page.evaluate("() => window.DeskClock.Alarm.minutesUntil('23:59')")
    check("minutesUntil returns positive minutes", isinstance(m, int) and 1 <= m <= 1440, m)

    # ---- quick position grid ----
    check("9 quick-position buttons", page.locator("#pos-grid button").count() == 9,
          page.locator("#pos-grid button").count())
    check("position presets include center + corners",
          page.locator('#pos-grid button[data-pos="center"]').count() == 1
          and page.locator('#pos-grid button[data-pos="top-left"]').count() == 1
          and page.locator('#pos-grid button[data-pos="bottom-right"]').count() == 1)

    # ---- click through ----
    ct = page.locator("#pref-clickthrough")
    ct.check(); page.wait_for_timeout(150)
    check("click-through pref persisted", prefs(page).get("clickThrough") is True)

    # ---- time sync controls ----
    check("live clock label ticking", page.locator("#sync-clock").count() == 1)
    check("sync-now button present", page.locator("#sync-now").count() == 1)
    page.locator("#sync-now").click(); page.wait_for_timeout(150)
    check("browser mode reports sync unsupported honestly",
          "不支持" in page.locator("#sync-status").inner_text(),
          page.locator("#sync-status").inner_text())
    page.locator("#pref-auto-timesync").check(); page.wait_for_timeout(150)
    check("auto time sync pref persisted", prefs(page).get("autoTimeSync") is True)

    # ---- v0.5 multi-timezone window manager ----
    check("manager zone select populated", page.locator("#cm-zone option").count() >= 10,
          page.locator("#cm-zone option").count())
    check("manager offers arbitrary UTC offset", page.locator("#cm-zone option[value='__custom__']").count() == 1)
    check("manager style options", page.locator("#cm-style option").count() >= 8,
          page.locator("#cm-style option").count())
    page.locator("#cm-name").fill("纽约")
    page.locator("#cm-zone").select_option("-300")
    page.locator("#cm-style").select_option("analog")
    page.locator("#cm-add").click(); page.wait_for_timeout(200)
    extras = prefs(page).get("extraClocks", [])
    check("manager config persisted", len(extras) == 1 and extras[0]["offset"] == -300
          and extras[0]["style"] == "analog", extras)
    check("manager row rendered", page.locator("#cm-list .cm-row").count() == 1)
    # 自定义 UTC 偏移（任意时区）
    page.locator("#cm-name").fill("自定义")
    page.locator("#cm-zone").select_option("__custom__"); page.wait_for_timeout(100)
    check("custom offset row visible", page.locator("#cm-custom-row").is_visible())
    page.locator("#cm-offset").fill("+05:30")
    page.locator("#cm-add").click(); page.wait_for_timeout(200)
    extras = prefs(page).get("extraClocks", [])
    check("arbitrary offset persisted", any(c.get("offset") == 330 for c in extras), extras)
    # 编辑 / 显示隐藏 / 删除
    page.locator("#cm-list .cm-row").first.locator("button").nth(0).click(); page.wait_for_timeout(120)
    check("edit mode exposes save", page.locator("#cm-save").is_visible())
    page.locator("#cm-save").click(); page.wait_for_timeout(150)
    check("save returns to add mode", page.locator("#cm-add").is_visible())
    # 删除全部
    for _ in range(len(prefs(page).get("extraClocks", []))):
        page.locator("#cm-list .cm-row").first.locator("button.danger").click(); page.wait_for_timeout(120)
    check("manager rows removable", len(prefs(page).get("extraClocks", [])) == 0)

    # ---- donation copy + link + update ----
    check("donate button renamed to coffee",
          "咖啡" in page.locator("#donate-toggle").inner_text()
          or "coffee" in page.locator("#donate-toggle").inner_text().lower(),
          page.locator("#donate-toggle").inner_text())
    check("project link present", page.locator("#project-link").count() == 1)
    check("check-update button present", page.locator("#check-update").count() == 1)
    check("version badge shows 0.5.1", "0.5.1" in page.locator("#ver-badge").inner_text(),
          page.locator("#ver-badge").inner_text())
    qr = page.locator("#donate-img")
    page.locator("#donate-toggle").click(); page.wait_for_timeout(150)
    check("QR image square-ish after crop (1:1)",
          qr.evaluate("img => Math.abs(img.naturalWidth - img.naturalHeight) < 4"),
          (qr.evaluate("img=>img.naturalWidth"), qr.evaluate("img=>img.naturalHeight")))
    page.locator("#donate-toggle").click()

    page.screenshot(path=str(OUT / "settings-v04.png"), full_page=True)

    # ================= dedicated settings window (native shim) =================
    ctx2 = browser.new_context(viewport={"width": 520, "height": 760})
    sw = ctx2.new_page()
    sw.on("pageerror", lambda e: errors.append("settings: " + str(e)))
    boot(sw, {"lang": "en"}, SETTINGS_INIT)
    check("dedicated window: tabs visible", sw.locator("#settings-tabs").is_visible())
    check("dedicated window: only one panel active",
          sw.locator("#settings-panels .panel.active").count() == 1,
          sw.locator("#settings-panels .panel.active").count())
    sw.locator('#settings-tabs .tab[data-tab="timer"]').click(); sw.wait_for_timeout(120)
    check("tab switch hides other panels",
          sw.locator('[data-panel="timer"]').is_visible()
          and sw.locator('[data-panel="appearance"]').is_hidden())
    # 🔴 opacity isolation in dedicated window (the exact reported bug)
    sw.locator('#settings-tabs .tab[data-tab="appearance"]').click(); sw.wait_for_timeout(100)
    sw.locator("#pref-opacity").fill("0.3")
    sw.locator("#pref-opacity").dispatch_event("input"); sw.wait_for_timeout(200)
    app_op = sw.locator("#app").evaluate("e => getComputedStyle(e).opacity")
    body_op = sw.locator("#settings").evaluate("e => getComputedStyle(e).opacity")
    check("dedicated settings window stays fully opaque on opacity change",
          float(app_op) == 1.0 and float(body_op) == 1.0, (app_op, body_op))
    sw.screenshot(path=str(OUT / "settings-window-v04.png"), full_page=True)

    # ================= extra timezone clock window =================
    ctx3 = browser.new_context(viewport={"width": 700, "height": 300})
    ew = ctx3.new_page()
    ew.on("pageerror", lambda e: errors.append("extra: " + str(e)))
    ew.goto(URL)
    ew.add_init_script("""
      window.__DC_EXTRA__=1;
      window.__DC_TZ_OFFSET__=-300;
      window.__DC_TZ_LABEL__='纽约';
    """)
    ew.reload(); ew.wait_for_timeout(900)
    check("extra window shows clock engine", ew.locator("#clock .slot").count() > 0,
          ew.locator("#clock .slot").count())
    check("extra window hides gear", ew.locator("#gear").is_hidden())
    check("extra window hides resize grip", ew.locator("#resize-handle").is_hidden())
    check("extra window hides settings panel", ew.locator("#settings").is_hidden())
    # The displayed hour must differ from local by the configured offset.
    diff = ew.evaluate("""() => {
      const glyphs = [...document.querySelectorAll('#clock .glyph')].map(e=>e.textContent);
      const faces = [...document.querySelectorAll('#clock .flip-static .flip-top .flip-face')].map(e=>e.textContent);
      return {glyphs: glyphs, faces: faces, localH: new Date().getHours(), tz: window.__DC_TZ_OFFSET__};
    }""")
    shown = diff["glyphs"] or diff["faces"]
    check("extra window renders digits", len(shown) >= 4, shown)
    # 验证时区确实生效（用与实现无关的独立公式）：
    # 目标墙上小时 = (真 epoch + tz 偏移) 的 UTC 小时。
    # 本地 13:57 (UTC+8) 且 tz=-5h 时应显示 00:57（当天凌晨），不是 8 点。
    if shown:
        shown_h = int(shown[0] + shown[1])
        expect_h = ew.evaluate("""(tz) => {
          return new Date(Date.now() + tz*60000).getUTCHours();
        }""", diff["tz"])
        check("extra window applies timezone offset", shown_h == expect_h,
              (shown_h, expect_h, diff["localH"], diff["tz"]))

    check("no JS errors across v0.4 run", not errors, errors[:5])
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
