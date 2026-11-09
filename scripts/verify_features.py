#!/usr/bin/env python3
"""Feature verification for Desk Clock v0.2 (browser mode, real Chromium).

Covers: zh/en i18n, font/colour customisation + per-style recommended defaults,
one-click reset (button + Alt+R), alarms, shutdown timer UI, resize grip.
"""
import functools
import http.server
import os
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


def boot(page, obj=None):
    page.goto(URL)
    set_prefs(page, obj or {})
    page.reload()
    page.wait_for_timeout(900)


def open_settings(page):
    if page.locator("#settings").is_hidden():
        page.locator("#gear").click()
    page.wait_for_timeout(120)


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=CHROME,
                                 args=["--no-sandbox", "--disable-gpu"])
    ctx = browser.new_context(viewport={"width": 980, "height": 760}, device_scale_factor=1)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)

    # ---------- default: Simplified Chinese ----------
    boot(page)
    check("default UI language = zh-CN", page.locator("html").get_attribute("lang") == "zh-CN")
    check("default label is Chinese", page.locator('[data-i18n="style"]').inner_text() == "时钟样式")
    # Prefs use lazy persistence: DEFAULTS live in memory until first interaction.
    check("default font = follow style", page.locator("#pref-font").input_value() == "",
          page.locator("#pref-font").input_value())
    check("default color = follow style", page.locator("#pref-color").input_value() == "",
          page.locator("#pref-color").input_value())
    check("default lang control = zh-CN", page.locator("#pref-lang").input_value() == "zh-CN")
    check("default x/y not written as 0 (centered on first run)",
          prefs(page).get("x") is None and prefs(page).get("y") is None, prefs(page))

    # ---------- switch to English ----------
    open_settings(page)
    page.locator("#pref-lang").select_option("en")
    page.wait_for_timeout(250)
    check("English switch applies", page.locator("html").get_attribute("lang") == "en"
          and page.locator('[data-i18n="style"]').inner_text() == "Clock style")
    check("English option labels", page.locator("#pref-style option[value='flip']").inner_text() == "Flip")
    check("English persisted", prefs(page).get("lang") == "en")
    page.screenshot(path=str(OUT / "settings-en.png"), omit_background=True)
    page.locator("#pref-lang").select_option("zh-CN")
    page.wait_for_timeout(200)

    # ---------- dropdown legibility (the Windows bug) ----------
    css = page.locator("#pref-style").evaluate(
        "e => { const c=getComputedStyle(e); const o=getComputedStyle(e.querySelector('option')); return {bg:c.backgroundColor,fg:c.color,opt:o.color,optbg:o.backgroundColor}; }")
    def lum(rgb):
        import re
        n = [int(x) for x in re.findall(r'\d+', rgb)[:3]]
        return sum(n) / 3 if n else 0
    # Intent-based assertion (v0.4): select stays an OPAQUE DARK field with
    # LIGHT text and explicitly-coloured options so Windows WebView2 popups
    # are always legible — exact hex is free to change with the design.
    check("select has opaque dark bg + light fg",
          lum(css["bg"]) < 90 and lum(css["fg"]) > 180 and "rgba" not in css["bg"], css)
    check("select option explicitly light", lum(css["opt"]) > 180, css)

    # ---------- custom font / color ----------
    page.locator("#pref-font").select_option("mono")
    page.wait_for_timeout(200)
    check("font custom applied", "monospace" in page.locator("#app").evaluate(
        "e => e.style.getPropertyValue('--dc-font')"))
    check("font pref persisted", prefs(page).get("font") == "mono")
    page.locator("#pref-font").select_option("__custom__")
    page.wait_for_timeout(150)
    check("custom font row shown", page.locator("#custom-font-row").is_visible())
    page.locator("#pref-font-custom").fill("Georgia, serif")
    page.locator("#pref-font-custom").dispatch_event("change")
    page.wait_for_timeout(200)
    check("custom font string applied", page.locator("#app").evaluate(
        "e => e.style.getPropertyValue('--dc-font')") == "Georgia, serif")

    page.locator("#pref-color").select_option("#ff6b6b")
    page.wait_for_timeout(200)
    check("color override applied", page.locator("#app").evaluate(
        "e => e.style.getPropertyValue('--dc-fg')") == "#ff6b6b")
    check("color pref persisted", prefs(page).get("color") == "#ff6b6b")
    page.locator("#pref-color").select_option("__custom__")
    page.wait_for_timeout(150)
    check("custom color row shown", page.locator("#custom-color-row").is_visible())
    page.locator("#pref-color-custom").fill("#123456")
    page.locator("#pref-color-custom").dispatch_event("input")
    page.wait_for_timeout(200)
    check("custom color applied", page.locator("#app").evaluate(
        "e => e.style.getPropertyValue('--dc-fg')") == "#123456")

    # ---------- per-style RECOMMENDED defaults intact ----------
    boot(page, {"style": "neon", "lang": "zh-CN"})
    check("neon recommended colour intact", page.locator("#app").evaluate(
        "e => getComputedStyle(e).getPropertyValue('--dc-fg').trim()") == "#8bfaff")
    boot(page, {"style": "segment", "lang": "zh-CN"})
    check("segment recommended font intact", "Courier New" in page.locator("#app").evaluate(
        "e => getComputedStyle(e).getPropertyValue('--dc-font').trim()"))

    # ---------- one-click reset (button + Alt+R) ----------
    boot(page, {"style": "neon", "lang": "en", "font": "mono", "color": "#ff6b6b",
                "scale": 2.0, "opacity": 0.5, "backdrop": "blur", "showSeconds": False})
    open_settings(page)
    page.locator("#reset-defaults").click()
    page.wait_for_timeout(300)
    p = prefs(page)
    check("reset button restores style/scale/opacity",
          p.get("style") == "flip" and p.get("scale") == 1 and p.get("opacity") == 1,
          str({k: p.get(k) for k in ("style", "scale", "opacity")}))
    check("reset restores font/color to recommended", p.get("font") == "" and p.get("color") == "")
    check("reset keeps user's language", p.get("lang") == "en", p.get("lang"))
    check("reset clears inline overrides",
          page.locator("#app").evaluate("e => e.style.getPropertyValue('--dc-fg')") == "")
    check("reset clears alarms", p.get("alarms") == [], p.get("alarms"))

    page.locator("#pref-color").select_option("#ff6b6b")
    page.wait_for_timeout(200)
    check("pre-shortcut override present", prefs(page).get("color") == "#ff6b6b")
    page.keyboard.press("Alt+r")
    page.wait_for_timeout(300)
    check("Alt+R restores defaults", prefs(page).get("color") == "" and prefs(page).get("style") == "flip")

    # ---------- alarms ----------
    boot(page, {"lang": "zh-CN"})
    open_settings(page)
    check("alarm hour/minute selects are locale-independent",
          page.locator("#alarm-hour option").count() == 24
          and page.locator("#alarm-minute option").count() == 60)
    page.locator("#alarm-hour").select_option("07")
    page.locator("#alarm-minute").select_option("30")
    page.locator("#alarm-repeat").check()
    page.locator("#alarm-add").click()
    page.wait_for_timeout(250)
    check("alarm added + persisted", len(prefs(page).get("alarms", [])) == 1
          and prefs(page)["alarms"][0]["time"] == "07:30", prefs(page).get("alarms"))
    check("alarm row visible", page.locator("#alarm-list .alarm-row").count() == 1)
    page.locator("#alarm-list .alarm-row button").click()
    page.wait_for_timeout(200)
    check("alarm removable", len(prefs(page).get("alarms", [])) == 0)

    now = page.evaluate("() => { const d=new Date(); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }")
    set_prefs(page, {"lang": "zh-CN", "alarms": [{"id": "test1", "time": now, "repeat": False}]})
    page.reload()
    page.wait_for_timeout(1600)
    check("alarm toast fires on matching minute", page.locator("#alarm-toast").is_visible())
    check("one-shot alarm consumed after firing", len(prefs(page).get("alarms", [])) == 0,
          prefs(page).get("alarms"))
    page.locator("#alarm-snooze").click()
    page.wait_for_timeout(200)
    check("snooze adds +5min alarm", len(prefs(page).get("alarms", [])) == 1
          and prefs(page)["alarms"][0]["repeat"] is False, prefs(page).get("alarms"))
    check("toast dismissed", page.locator("#alarm-toast").is_hidden())

    # ---------- shutdown timer (browser mode degrades gracefully) ----------
    boot(page, {"lang": "zh-CN"})
    open_settings(page)
    check("shutdown off by default", page.locator("#shutdown-status").inner_text() == "未启用")
    check("cancel hidden while off", page.locator("#shutdown-cancel").is_hidden())
    page.locator("#shutdown-min").fill("30")
    page.locator("#shutdown-start").click()
    page.wait_for_timeout(250)
    check("browser mode honestly reports unsupported",
          "不支持" in page.locator("#shutdown-status").inner_text(),
          page.locator("#shutdown-status").inner_text())
    page.screenshot(path=str(OUT / "settings-zh.png"), omit_background=True)

    # ---------- resize grip ----------
    boot(page, {"scale": 1, "lang": "zh-CN"})
    check("resize handle exists", page.locator("#resize-handle").count() == 1)
    box = page.locator("#resize-handle").bounding_box()
    page.mouse.move(box["x"] + 9, box["y"] + 9)
    page.mouse.down()
    page.mouse.move(box["x"] + 129, box["y"] + 9, steps=6)
    page.mouse.up()
    page.wait_for_timeout(300)
    check("dragging grip changes scale", prefs(page).get("scale", 1) > 1, prefs(page).get("scale"))
    check("scale readout updated", "%" in page.locator("#scale-out").inner_text())

    check("no JS errors across feature run", not errors, errors[:3])

    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
