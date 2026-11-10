#!/usr/bin/env python3
"""v0.6 verification: every clock window is fully configurable.

Covers the user's 2026-11-09 request:
  * all windows equal — each has a complete config (style/colour/font/size/
    position/timezone/opacity/backdrop/analog/click-through/visible)
  * main window can set a time zone too
  * settings window has an "Editing: [window]" target selector; switching
    reloads that window's config
  * manager rows have a "设置/Settings" button that jumps to that window
  * per-window configs are isolated (changing one does not leak to others)
  * global items (lang/alarms/timer) stay shared
Native-only Rust paths are validated by CI compile.
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

SETTINGS_INIT = """
window.__DC_VIEW__='settings';window.__DC_SETTINGS__=1;
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
      if(cmd==='get_shutdown_status') return Promise.resolve(null);
      // v0.6 真实后端语义：窗口配置存 desksclock.clocks
      if(cmd==='get_window_configs'){
        var v=JSON.parse(localStorage.getItem('deskclock.clocks')||'null');
        if(v&&v.clocks) return Promise.resolve(v);
        return Promise.resolve({activeId:'main',clocks:{main:{}}});
      }
      if(cmd==='set_active_clock'){
        var a=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"activeId":"main","clocks":{}}');
        a.activeId=args.id; localStorage.setItem('deskclock.clocks',JSON.stringify(a));
        return Promise.resolve();
      }
      if(cmd==='get_window_prefs'){
        var g=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"clocks":{}}');
        return Promise.resolve((g.clocks&&g.clocks[args.id])||{});
      }
      if(cmd==='set_window_prefs'){
        var w=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"activeId":"main","clocks":{}}');
        if(!w.clocks)w.clocks={};
        var cur=w.clocks[args.id]||{};
        for(var k in args.patch)cur[k]=args.patch[k];
        w.clocks[args.id]=cur; w.activeId=args.id;
        localStorage.setItem('deskclock.clocks',JSON.stringify(w));
        return Promise.resolve(cur);
      }
      if(cmd==='add_clock_window'){
        var ac=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"activeId":"main","clocks":{}}');
        if(!ac.clocks)ac.clocks={};
        var base=JSON.parse(JSON.stringify(ac.clocks.main||{}));
        base.tzOffset=args.offset; base.tzLabel=args.label;
        if(args.style)base.style=args.style;
        if(typeof args.showSeconds==='boolean')base.showSeconds=args.showSeconds;
        ac.clocks[args.id]=base;
        localStorage.setItem('deskclock.clocks',JSON.stringify(ac));
        return Promise.resolve();
      }
      if(cmd==='close_clock_window'){
        var cc=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"clocks":{}}');
        if(cc.clocks)delete cc.clocks[args.id];
        localStorage.setItem('deskclock.clocks',JSON.stringify(cc));
        return Promise.resolve();
      }
    }catch(e){}
    return Promise.resolve();
  }},
  event:{listen:function(n,cb){(window.__dc_listeners[n]=window.__dc_listeners[n]||[]).push(cb);return Promise.resolve(function(){});}}
};
"""


def clocks(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.clocks')||'{}')")


def prefs(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")


def boot_settings(page, init=SETTINGS_INIT):
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.add_init_script(init)
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

    # ================= dedicated settings window =================
    ctx = browser.new_context(viewport={"width": 760, "height": 700})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("settings: " + str(e)))
    boot_settings(page)

    # --- target selector exists in dedicated window ---
    check("editing-target selector visible", page.locator("#head-target").is_visible())
    check("target defaults to main window",
          page.locator("#target-clock").input_value() == "main")

    # --- main window can set a time zone (was missing before) ---
    gototab(page, "appearance")
    check("time-zone control present on appearance page", page.locator("#pref-tz").count() == 1)
    check("time-zone defaults to local", page.locator("#pref-tz").input_value() == "local")
    page.locator("#pref-tz").select_option("540")
    page.wait_for_timeout(250)
    c = clocks(page)
    check("main window timezone persisted", c.get("clocks", {}).get("main", {}).get("tzOffset") == 540,
          c.get("clocks", {}).get("main", {}).get("tzOffset"))

    # --- create two windows via manager ---
    gototab(page, "window")
    for name in ["东京", "纽约"]:
        page.locator("#cm-name").fill(name)
        page.locator("#cm-add").click()
        page.wait_for_timeout(250)
    opts = page.evaluate("[...document.querySelectorAll('#target-clock option')].map(o=>({v:o.value,t:o.textContent}))")
    check("target selector lists main + 2 windows", len(opts) == 3, opts)
    tokyo = [o["v"] for o in opts if o["t"] == "东京"][0]
    ny = [o["v"] for o in opts if o["t"] == "纽约"][0]

    # v0.6.1: the add form no longer sets a time zone (redundant config removed).
    # Each window is fully configurable afterwards — give them distinct zones
    # through the "Editing" selector + appearance page, then verify isolation.
    page.locator("#target-clock").select_option(tokyo)
    page.wait_for_timeout(350)
    gototab(page, "appearance")
    page.locator("#pref-tz").select_option("540")
    page.wait_for_timeout(250)
    page.locator("#target-clock").select_option(ny)
    page.wait_for_timeout(350)
    gototab(page, "appearance")
    page.locator("#pref-tz").select_option("-300")
    page.wait_for_timeout(250)

    # --- each window has a full independent config ---
    page.locator("#target-clock").select_option(tokyo)
    page.wait_for_timeout(350)
    gototab(page, "appearance")
    page.locator("#pref-color").select_option("#ff6b6b")
    page.wait_for_timeout(250)
    page.locator("#pref-opacity").fill("0.6")
    page.locator("#pref-opacity").dispatch_event("input")
    page.wait_for_timeout(250)
    page.locator("#pref-style").select_option("neon")
    page.wait_for_timeout(250)
    c = clocks(page)["clocks"]
    check("target window keeps its own colour", c[tokyo].get("color") == "#ff6b6b", c[tokyo].get("color"))
    check("target window keeps its own opacity", c[tokyo].get("opacity") == 0.6, c[tokyo].get("opacity"))
    check("target window keeps its own style", c[tokyo].get("style") == "neon", c[tokyo].get("style"))
    check("other window NOT affected by colour", not c[ny].get("color"), c[ny].get("color"))
    check("main window NOT affected by style", c["main"].get("style") != "neon", c["main"].get("style"))
    check("each window keeps its own timezone",
          c[tokyo].get("tzOffset") == 540 and c[ny].get("tzOffset") == -300,
          (c[tokyo].get("tzOffset"), c[ny].get("tzOffset")))

    # --- switching target reloads that window's controls ---
    page.locator("#target-clock").select_option(ny)
    page.wait_for_timeout(400)
    gototab(page, "appearance")
    check("switching target loads that window's style",
          page.locator("#pref-style").input_value() != "neon",
          page.locator("#pref-style").input_value())
    check("switching target loads that window's timezone",
          page.locator("#pref-tz").input_value() == "-300",
          page.locator("#pref-tz").input_value())

    # --- manager row has a Settings button that jumps to that window ---
    gototab(page, "window")
    first_settings = page.locator('#cm-list .cm-row:not(.cm-row-main) button[data-cm-action="settings"]').first
    check("manager rows expose a settings button", first_settings.count() == 1)
    first_settings.click()
    page.wait_for_timeout(350)
    check("settings button switches to appearance tab",
          page.locator('[data-panel="appearance"]').is_visible())

    # --- global items stay shared ---
    gototab(page, "appearance")
    page.locator("#pref-lang").select_option("en")
    page.wait_for_timeout(200)
    check("language is global (written to root prefs)", prefs(page).get("lang") == "en",
          prefs(page).get("lang"))

    # ================= clock window honours its own config =================
    ctx2 = browser.new_context(viewport={"width": 1100, "height": 900})
    cw = ctx2.new_page()
    cw.on("pageerror", lambda e: errors.append("clock: " + str(e)))
    cw.goto(URL)
    cw.evaluate("""() => {
      localStorage.setItem('deskclock.prefs', JSON.stringify({lang:'zh-CN'}));
      localStorage.setItem('deskclock.clocks', JSON.stringify({activeId:'main',clocks:{
        main:{style:'neon', showSeconds:false, tzOffset:540, color:'#6bff8f', scale:1, opacity:1, backdrop:'none', analogTheme:'dark', hour12:false, showSeparator:true, alwaysOnTop:false, font:'', customFont:'', customColor:'#f6f7f9', analogPenetrate:false, clickThrough:false, x:null, y:null, tzLabel:'东京'}
      }}));
    }""")
    cw.reload()
    cw.wait_for_timeout(800)
    check("clock window applies its own style", cw.locator("#app").get_attribute("data-style") == "neon")
    fg = cw.locator("#app").evaluate("e=>getComputedStyle(e).getPropertyValue('--dc-fg').trim()")
    check("clock window applies its own colour", fg == "#6bff8f", fg)
    # tzOffset 540 => wall clock = UTC+9; verify hour matches independent formula
    shown = cw.evaluate("""() => {
      const g=[...document.querySelectorAll('#clock .glyph')].map(e=>e.textContent);
      const f=[...document.querySelectorAll('#clock .flip-static .flip-face')].map(e=>e.textContent);
      return g.length?g:f;
    }""")
    expect_h = cw.evaluate("() => new Date(Date.now()+540*60000).getUTCHours()")
    check("clock window applies its own timezone",
          len(shown) >= 2 and int(shown[0] + shown[1]) == expect_h,
          (shown[:2], expect_h))
    check("clock window hides seconds per its config",
          cw.evaluate("document.querySelectorAll('#clock .sep').length") == 1,
          cw.evaluate("document.querySelectorAll('#clock .sep').length"))

    check("no JS errors across v0.6 run", not errors, errors[:5])
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
import sys
sys.exit(1 if failed else 0)
