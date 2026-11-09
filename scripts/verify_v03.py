#!/usr/bin/env python3
"""v0.3 feature verification (real Chromium, browser-mode simulation).

Covers: system-tray hint, independent settings-window view, permission/elevation
UI, donation QR tabs, and cross-window preference broadcast. Native-only paths
(tray menu, real UAC) are asserted structurally here and verified by CI build.
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

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=CHROME,
                                 args=["--no-sandbox", "--disable-gpu"])
    errors = []

    # ---------------- clock window (default embedded-panel fallback) ----------------
    ctx1 = browser.new_context(viewport={"width": 980, "height": 420}, device_scale_factor=1)
    clock = ctx1.new_page()
    clock.on("pageerror", lambda e: errors.append("clock: " + str(e)))
    clock.goto(URL)
    set_prefs(clock, {})
    clock.reload()
    clock.wait_for_timeout(900)

    check("tray hint exists in clock window", clock.locator("#tray-hint").count() == 1)
    check("tray hint hidden in browser preview", clock.locator("#tray-hint").is_hidden())
    check("permission section exists", clock.locator("#perm-status").count() == 1
          and clock.locator("#perm-run-admin").count() == 1
          and clock.locator("#perm-elevate-now").count() == 1)
    check("donate section exists", clock.locator("#donate-toggle").count() == 1
          and clock.locator("#donate-panel").count() == 1)
    check("donate images are committed assets",
          (UI_DIR / "assets/donate-wechat.jpg").is_file()
          and (UI_DIR / "assets/donate-alipay.jpg").is_file()
          and (UI_DIR / "assets/donate.jpg").is_file())
    check("browser mode reports no elevation support",
          clock.locator("#perm-status").inner_text().find("浏览器预览") >= 0,
          clock.locator("#perm-status").inner_text())
    check("admin row hidden in browser mode", clock.locator("#perm-admin-row").is_hidden())
    check("elevate-now hidden in browser mode", clock.locator("#perm-elevate-now").is_hidden())

    # Donate UI: toggle + tabs swap the QR source
    clock.locator("#gear").click()
    clock.wait_for_timeout(100)
    clock.locator("#donate-toggle").click()
    clock.wait_for_timeout(150)
    check("donate panel opens", clock.locator("#donate-panel").is_visible())
    check("default QR = wechat", "donate-wechat" in clock.locator("#donate-img").get_attribute("src"))
    clock.locator('.donate-tab[data-donate="alipay"]').click()
    clock.wait_for_timeout(120)
    check("alipay tab swaps QR", "donate-alipay" in clock.locator("#donate-img").get_attribute("src"))
    check("alipay tab active", "active" in (clock.locator('.donate-tab[data-donate="alipay"]').get_attribute("class") or ""))
    img_ok = clock.locator("#donate-img").evaluate("img => img.complete && img.naturalWidth > 100")
    check("QR image actually loads", img_ok)
    clock.locator('.donate-tab[data-donate="wechat"]').click()
    clock.wait_for_timeout(120)
    check("wechat tab swaps back", "donate-wechat" in clock.locator("#donate-img").get_attribute("src"))
    check("QR image loads (wechat)", clock.locator("#donate-img").evaluate("img => img.complete && img.naturalWidth > 100"))
    clock.locator("#donate-toggle").click()
    clock.wait_for_timeout(120)
    check("donate panel collapses", clock.locator("#donate-panel").is_hidden())

    # ---------------- independent settings window (simulated init script) ----------------
    ctx2 = browser.new_context(viewport={"width": 480, "height": 720}, device_scale_factor=1)
    settings = ctx2.new_page()
    settings.on("pageerror", lambda e: errors.append("settings: " + str(e)))
    # Same-origin localStorage seeding. Then inject BEFORE any page script:
    #  (1) the window-mode flag exactly as Rust's initialization_script does;
    #  (2) a minimal native shim so Prefs.isNative is true and the REAL
    #      cross-window listener path is exercised (not a hand-rolled mock).
    settings.goto(URL)
    set_prefs(settings, {"style": "neon", "lang": "en"})
    settings.add_init_script("""
      window.__DC_VIEW__ = 'settings';
      window.__dc_listeners = {};
      window.__dc_set_prefs_calls = 0;
      window.__TAURI__ = {
        core: { invoke: function(cmd, args) {
          args = args || {};
          try {
            if (cmd === 'get_prefs')
              return Promise.resolve(JSON.parse(localStorage.getItem('deskclock.prefs') || '{}'));
            if (cmd === 'set_prefs') {
              window.__dc_set_prefs_calls++;
              var cur = JSON.parse(localStorage.getItem('deskclock.prefs') || '{}');
              for (var k in args.patch) cur[k] = args.patch[k];
              localStorage.setItem('deskclock.prefs', JSON.stringify(cur));
              return Promise.resolve(cur);
            }
            if (cmd === 'get_autostart') return Promise.resolve(false);
            if (cmd === 'get_shutdown_status') return Promise.resolve(null);
            if (cmd === 'take_donate_intent') return Promise.resolve(false);
            if (cmd === 'get_privilege_status') return Promise.resolve({
              platform: 'windows', isElevated: false, canElevate: true,
              runAsAdmin: false, note: 'shim: native permission surface' });
          } catch (e) {}
          return Promise.resolve();
        }},
        event: { listen: function(name, cb) {
          (window.__dc_listeners[name] = window.__dc_listeners[name] || []).push(cb);
          return Promise.resolve(function(){});
        }}
      };
      window.__dc_broadcast = function(name, payload) {
        (window.__dc_listeners[name] || []).forEach(function(cb) { cb({payload: payload}); });
      };
    """)
    settings.reload()
    settings.wait_for_timeout(900)

    check("settings window switches body view", settings.locator("body").get_attribute("data-view") == "settings")
    check("settings panel visible in dedicated window", settings.locator("#settings").is_visible())
    check("clock hidden in settings window", settings.locator("#clock").is_hidden())
    check("gear hidden in settings window", settings.locator("#gear").is_hidden())
    check("resize grip hidden in settings window", settings.locator("#resize-handle").is_hidden())
    check("settings window reads stored prefs", settings.locator("#pref-style").input_value() == "neon")
    check("settings window title localized", "Settings" in settings.title(), settings.title())
    check("no engine started in settings window",
          settings.evaluate("() => !!(window.DeskClock && window.DeskClock.Engine) && document.querySelectorAll('#clock .slot').length === 0"))
    check("permission note rendered in dedicated window",
          settings.locator("#perm-note").inner_text().strip() != "",
          settings.locator("#perm-note").inner_text()[:60])
    check("native shim activates admin row", settings.locator("#perm-admin-row").is_visible())
    check("tray hint shown in native-simulated settings window",
          settings.locator("#tray-hint").is_visible())
    check("donate panel works in dedicated window", settings.locator("#donate-toggle").is_visible())
    settings.locator("#donate-toggle").click()
    settings.wait_for_timeout(120)
    check("dedicated window QR loads", settings.locator("#donate-img").evaluate("img => img.complete && img.naturalWidth > 100"))
    settings.screenshot(path=str(OUT / "settings-window-v03.png"), full_page=True)

    # ---------------- cross-window broadcast (REAL onChanged path) ----------------
    # Boot already registered Prefs.onChanged(applyRemotePrefs) against the
    # shim's event.listen. Emitting a full merged object must update every
    # control WITHOUT invoking set_prefs (no write-back loop between windows).
    calls_before = settings.evaluate("window.__dc_set_prefs_calls")
    settings.evaluate("window.__dc_broadcast('prefs-changed', {style:'segment', showSeconds:false, lang:'zh-CN'})")
    settings.wait_for_timeout(250)
    check("broadcast updates settings controls (no save loop)",
          settings.locator("#pref-style").input_value() == "segment"
          and settings.locator("#pref-seconds").is_checked() is False,
          settings.locator("#pref-style").input_value())
    # The local cache legitimately follows the authoritative broadcast (so a
    # fresh window sees current prefs), but NO backend write may happen.
    check("broadcast refreshes local cache from authoritative state",
          prefs(settings).get("style") == "segment", prefs(settings).get("style"))
    check("broadcast triggered zero set_prefs calls (no write-back loop)",
          settings.evaluate("window.__dc_set_prefs_calls") == calls_before,
          (calls_before, settings.evaluate("window.__dc_set_prefs_calls")))

    check("no JS errors across v0.3 run", not errors, errors[:5])
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
