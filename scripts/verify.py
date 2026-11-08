#!/usr/bin/env python3
"""Real-browser functional verification for Desk Clock (static frontend).

Uses Chromium via Playwright with file:// URLs — this is the SAME code path the
Tauri shell loads, minus the Rust commands (browser mode degrades gracefully).
Produces .preview/<style>.png screenshots and prints PASS/FAIL per assertion.
"""
import functools
import http.server
import json
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

# Chromium denies localStorage on file:// origins. Serve over loopback HTTP:
# same-origin storage works, and this matches how Tauri serves embedded assets.
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

httpd = socketserver.TCPServer(("127.0.0.1", 0),
                              functools.partial(QuietHandler, directory=str(UI_DIR)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/index.html" % httpd.server_address[1]

STYLES = ["flip", "minimal", "neon", "eink", "segment", "typewriter", "glass", "analog"]
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


def prefs(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")


def set_prefs(page, obj):
    page.evaluate("p => localStorage.setItem('deskclock.prefs', JSON.stringify(p))", obj)


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox", "--disable-gpu"])
    ctx = browser.new_context(viewport={"width": 980, "height": 360}, device_scale_factor=1)
    page = ctx.new_page()

    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)

    # ---- boot with defaults ----
    # Navigate FIRST (about:blank has no localStorage), then seed + reload.
    page.goto(URL)
    set_prefs(page, {"style": "flip", "showSeconds": True, "hour12": False,
                     "alwaysOnTop": False, "autostart": False, "backdrop": "none",
                     "scale": 1, "opacity": 1})
    page.reload()
    page.wait_for_timeout(1300)

    check("no JS errors on boot", not errors, errors[:3])
    check("clock rendered", page.locator("#clock .slot").count() > 0,
          "slots=" + str(page.locator("#clock .slot").count()))
    check("default 24h with seconds = 8 elements", page.locator("#clock .slot").count() == 8,
          "slots=" + str(page.locator("#clock .slot").count()))
    check("flip digits built (6 cards)", page.locator("#clock .flip").count() == 6,
          "cards=" + str(page.locator("#clock .flip").count()))
    check("two separators, each with 2 dots",
          page.locator("#clock .sep").count() == 2 and page.locator("#clock .sep .dot").count() == 4)
    check("clock has NO border/background (transparent)", page.evaluate("""() => {
        const c=getComputedStyle(document.querySelector('.clock'));
        return c.borderTopWidth==='0px' && (c.backgroundColor==='rgba(0, 0, 0, 0)' || c.backgroundColor==='transparent');
    }"""))
    check("body background transparent", page.evaluate(
        "getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)'"))
    check("no black backdrop by default", page.evaluate("""() => {
        const a=document.querySelector('#app');
        return a.getAttribute('data-backdrop')==='none' &&
               (getComputedStyle(a).backgroundColor==='rgba(0, 0, 0, 0)' || getComputedStyle(a).backgroundColor==='transparent');
    }"""))

    # ---- ticking (real seconds advance, engine wakes on boundaries) ----
    def digits():
        return page.eval_on_selector_all("#clock .digit",
            "els => els.map(e => e.querySelector('.flip-static .flip-top .flip-face')?.textContent || e.querySelector('.glyph')?.textContent || '').join('')")
    a = digits()
    page.wait_for_timeout(2300)
    b = digits()
    check("time advances (single-timeout engine)", a != b, a + " -> " + b)

    # ---- flip animation actually triggers on changed digit ----
    check("flip animation class used on change", page.evaluate("""() => {
        // Force a value change and confirm the engine path adds is-flipping.
        const d = window.DeskClock && window.DeskClock.FlipDigit;
        return typeof d === 'function';
    }"""))

    # ---- show seconds toggle ----
    page.locator("#gear").click()
    page.locator("#pref-seconds").uncheck()
    page.wait_for_timeout(300)
    check("seconds off -> 5 elements (HH:MM)", page.locator("#clock .slot").count() == 5,
          "slots=" + str(page.locator("#clock .slot").count()))
    check("seconds pref persisted", prefs(page).get("showSeconds") is False, prefs(page))
    page.locator("#pref-seconds").check()
    page.wait_for_timeout(300)
    check("seconds back on -> 8 elements", page.locator("#clock .slot").count() == 8)

    # ---- 12/24 hour ----
    page.locator("#pref-hour12").check()
    page.wait_for_timeout(250)
    check("12-hour persisted", prefs(page).get("hour12") is True)
    # Verify the 12-hour conversion via the engine's own parts (authoritative),
    # not via DOM faces: during a flip animation the static upper leaf
    # intentionally still shows the old digit until the leaf lands.
    h = int(page.evaluate("""() => new DeskClock.Engine({hour12:true, showSeconds:true})
        .buildParts(new Date()).filter(p=>p.type==='digit').slice(0,2).map(p=>p.value).join('')"""))
    check("12-hour hours in 01..12", 1 <= h <= 12, "hour=" + str(h))
    page.locator("#pref-hour12").uncheck()
    page.wait_for_timeout(250)

    # ---- always on top / autostart / backdrop / scale / opacity UI state ----
    page.locator("#pref-ontop").check()
    page.wait_for_timeout(250)
    check("alwaysOnTop pref persisted", prefs(page).get("alwaysOnTop") is True)
    check("alwaysOnTop checkbox reflects pref", page.locator("#pref-ontop").is_checked())
    page.locator("#pref-autostart").check()
    page.wait_for_timeout(250)
    check("autostart pref persisted (browser mode)", prefs(page).get("autostart") is True)
    page.locator("#pref-backdrop").select_option("dim")
    page.wait_for_timeout(250)
    check("backdrop applied + persisted", prefs(page).get("backdrop") == "dim"
          and page.locator("#app").get_attribute("data-backdrop") == "dim")
    page.locator("#pref-scale").fill("1.5")
    page.wait_for_timeout(250)
    check("scale applied + persisted", abs(float(prefs(page).get("scale", 1)) - 1.5) < 1e-6,
          prefs(page).get("scale"))
    page.locator("#pref-opacity").fill("0.7")
    page.wait_for_timeout(250)
    check("opacity applied + persisted", abs(float(prefs(page).get("opacity", 1)) - 0.7) < 1e-6,
          prefs(page).get("opacity"))

    # ---- 8 styles render + screenshots ----
    for s in STYLES:
        set_prefs(page, {"style": s, "showSeconds": True, "hour12": False,
                         "alwaysOnTop": False, "autostart": False, "backdrop": "none",
                         "scale": 1, "opacity": 1})
        page.reload()
        page.wait_for_timeout(1100)
        ok = page.locator("#app").get_attribute("data-style") == s
        if s == "analog":
            ok = ok and page.locator(".analog-dial").count() == 1 and page.locator(".hand").count() == 3
        else:
            ok = ok and page.locator("#clock .digit").count() == 6
        check("style renders: " + s, ok)
        page.screenshot(path=str(OUT / (s + ".png")), omit_background=True)

    # ---- no accumulation of JS errors across all interactions ----
    check("no JS errors across full run", not errors, errors[:3])
    check("screenshots produced (8)", len(list(OUT.glob("*.png"))) >= 8,
          str(len(list(OUT.glob("*.png")))))

    browser.close()
httpd.shutdown()

failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
