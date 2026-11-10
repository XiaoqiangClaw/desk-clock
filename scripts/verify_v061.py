#!/usr/bin/env python3
"""v0.6.1 verification: merged window manager, head layout, independent positions.

Covers the user's 2026-11-10 feedback batch:
  * "World clocks" tab removed; window manager merged into the Window page
  * Window tab icon is the new ⊞ glyph
  * redundant add-window fields (zone/style/seconds/custom row) are gone
  * settings head drops the "设置" title; "Editing" label and selector share a row
  * the main window is listed as an undeletable manager card
  * rename persists to extraClocks and the target selector
  * per-window move listeners use the window-scoped onMoved API (no Any-target)
  * Rust/config structural assertions (no cargo; CI compiles)
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
window.__dc_onMoved=0;
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
  webviewWindow:{getCurrentWebviewWindow:function(){
    return {onMoved:function(cb){window.__dc_onMoved++;window.__dc_onMovedCb=cb;return Promise.resolve(function(){});}};
  }},
  event:{listen:function(n,cb){(window.__dc_listeners[n]=window.__dc_listeners[n]||[]).push(cb);return Promise.resolve(function(){});}}
};
"""


CLOCK_INIT = SETTINGS_INIT.replace(
    "window.__DC_VIEW__='settings';window.__DC_SETTINGS__=1;", ""
)


def prefs(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")


def boot_settings(page):
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    page.add_init_script(SETTINGS_INIT)
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

    # ================= 1-7: merged manager + head layout =================
    ctx = browser.new_context(viewport={"width": 760, "height": 700})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("settings: " + str(e)))
    boot_settings(page)

    check("no separate clocks tab",
          page.locator('#settings-tabs .tab[data-tab="clocks"]').count() == 0)
    check("window tab icon is the new glyph",
          page.locator('#settings-tabs .tab[data-tab="window"] i').inner_text() == "⊞",
          page.locator('#settings-tabs .tab[data-tab="window"] i').inner_text())
    check("manager merged into window panel",
          page.locator('[data-panel="window"] #cm-list').count() == 1
          and page.locator('[data-panel="clocks"]').count() == 0)
    check("redundant manager fields removed",
          page.locator("#cm-zone, #cm-style, #cm-seconds, #cm-custom-row").count() == 0)
    check("simplified add form present",
          page.locator("#cm-name").count() == 1 and page.locator("#cm-add").count() == 1)

    # --- head layout ---
    check("settings title text removed", page.locator("#settings-title").count() == 0)
    gototab(page, "window")
    lb = page.locator("#head-target label").bounding_box()
    sb = page.locator("#target-clock").bounding_box()
    lbc = lb["y"] + lb["height"] / 2
    sbc = sb["y"] + sb["height"] / 2
    check("editing label and selector share a row", abs(lbc - sbc) < 8, (lbc, sbc))

    # --- main window card, undeletable / no visibility button ---
    check("initial list is exactly the main card",
          page.locator("#cm-list .cm-row").count() == 1
          and page.locator('#cm-list .cm-row[data-cm-id="main"]').count() == 1)
    check("main card has no delete/visibility buttons",
          page.locator('#cm-list .cm-row[data-cm-id="main"] button[data-cm-action="delete"]').count() == 0
          and page.locator('#cm-list .cm-row[data-cm-id="main"] button[data-cm-action="visibility"]').count() == 0)

    # --- add one window ---
    page.locator("#cm-name").fill("东京")
    page.locator("#cm-add").click()
    page.wait_for_timeout(250)
    check("one add -> two cards", page.locator("#cm-list .cm-row").count() == 2)
    newrow = page.locator("#cm-list .cm-row:not(.cm-row-main)")
    check("new card has 4 action buttons",
          newrow.locator("button[data-cm-action]").count() == 4,
          newrow.locator("button[data-cm-action]").count())
    cl = prefs(page).get("extraClocks", [])
    check("one window persisted with correct label", len(cl) == 1 and cl[0]["label"] == "东京", cl)
    check("target selector lists main + 1 new window",
          page.locator("#target-clock option").count() == 2,
          page.locator("#target-clock option").count())

    # --- new window fully inherits main's config (no redundant creation opts) ---
    main_tz = page.evaluate("""() => {
      const w=JSON.parse(localStorage.getItem('deskclock.clocks')||'{}');
      return (w.clocks&&w.clocks.main)?w.clocks.main.tzOffset:undefined;
    }""")
    new_tz = page.evaluate("""(id) => {
      const w=JSON.parse(localStorage.getItem('deskclock.clocks')||'{}');
      return (w.clocks&&w.clocks[id])?w.clocks[id].tzOffset:undefined;
    }""", cl[0]["id"])
    check("new window inherits main time zone", new_tz == main_tz, (main_tz, new_tz))

    # --- rename ---
    newrow.locator('button[data-cm-action="edit"]').click()
    page.wait_for_timeout(120)
    page.locator("#cm-name").fill("大阪")
    page.locator("#cm-save").click()
    page.wait_for_timeout(250)
    cl = prefs(page).get("extraClocks", [])
    check("rename updates extraClocks label", len(cl) == 1 and cl[0]["label"] == "大阪", cl)
    opt_texts = page.evaluate("[...document.querySelectorAll('#target-clock option')].map(o=>o.textContent)")
    check("rename appears in target selector", "大阪" in opt_texts, opt_texts)

    # --- reset defaults must NOT wipe the window list ---
    gototab(page, "about")
    page.locator("#reset-defaults").click()
    page.wait_for_timeout(250)
    cl_after_reset = prefs(page).get("extraClocks", [])
    check("reset defaults keeps existing windows",
          len(cl_after_reset) == 1 and cl_after_reset[0]["label"] == "大阪",
          cl_after_reset)

    # ================= 8: position independence (JS side) =================
    for idx in range(2):
        c = browser.new_context(viewport={"width": 1100, "height": 900})
        cw = c.new_page()
        cw.on("pageerror", lambda e, i=idx: errors.append("clock%d: %s" % (i, e)))
        cw.goto(URL)
        cw.evaluate("localStorage.clear()")
        cw.add_init_script(CLOCK_INIT)
        cw.reload()
        cw.wait_for_timeout(700)
        move_listeners = cw.evaluate("(window.__dc_listeners['tauri://move']||[]).length")
        moved_calls = cw.evaluate("window.__dc_onMoved||0")
        check("clock page %d has no global Any-target move listener" % (idx + 1),
              move_listeners == 0, move_listeners)
        check("clock page %d registered window-scoped onMoved" % (idx + 1),
              moved_calls >= 1, moved_calls)
        c.close()

    # ================= 9: pure-file structural assertions =================
    lib = (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
    caps = (ROOT / "src-tauri" / "capabilities" / "default.json").read_text(encoding="utf-8")
    appjs = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
    spawn = lib[lib.index("fn spawn_extra_window("):lib.index("fn add_clock_window(")]
    check("no hard-coded set_ignore_cursor_events(true) in spawn_extra_window",
          "set_ignore_cursor_events(true)" not in spawn)
    check("restore_window_position present, old restore_position gone",
          "restore_window_position" in lib and "fn restore_position(" not in lib)
    swp = lib[lib.index("fn set_window_prefs("):lib.index("fn set_window_geometry(")]
    check("set_window_prefs body has no set_position", "set_position" not in swp)
    addw = lib[lib.index("fn add_clock_window("):lib.index("fn set_clock_window_visible(")]
    check("new window fully inherits (no tz/showSeconds override)",
          'o.insert("tzOffset"' not in addw and 'o.insert("showSeconds"' not in addw)
    check("spawn injects from per-window config, not legacy args",
          'cfg.get("tzOffset")' in lib and "_offset: f64" in lib)
    appjs_txt = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
    check("resetDefaults preserves extraClocks",
          "fresh.extraClocks = state.extraClocks || []" in appjs_txt)
    check("drag permission granted", "core:window:allow-start-dragging" in caps)
    check("app.js uses onMoved(onMove)", "onMoved(onMove)" in appjs)

    check("no JS errors across v0.6.1 run", not errors, errors[:5])
    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
