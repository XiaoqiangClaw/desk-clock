#!/usr/bin/env python3
"""v0.6.2 UI and configuration checks (positions, time-sync note, titles,
header, alert popups, ring duration, timer warning / silent / terminate).

Real Chromium for DOM assertions plus pure-file structural assertions for Rust
(no cargo on this host; CI compiles). Does not replace the 7 older suites.
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

# Minimal Tauri shim for the browser-based checks.
SETTINGS_INIT = """
window.__DC_VIEW__='settings';window.__DC_SETTINGS__=1;
window.__dc_listeners={};window.__dc_onMoved=0;window.__dc_alerts=[];
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
      if(cmd==='set_window_geometry'){ window.__dc_geometry=args; return Promise.resolve(); }
      if(cmd==='add_clock_window'){
        var ac=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"activeId":"main","clocks":{}}');
        if(!ac.clocks)ac.clocks={};
        ac.clocks[args.id]=JSON.parse(JSON.stringify(ac.clocks.main||{}));
        localStorage.setItem('deskclock.clocks',JSON.stringify(ac));
        return Promise.resolve();
      }
      if(cmd==='close_clock_window'){
        var cc=JSON.parse(localStorage.getItem('deskclock.clocks')||'{"clocks":{}}');
        if(cc.clocks)delete cc.clocks[args.id];
        localStorage.setItem('deskclock.clocks',JSON.stringify(cc));
        return Promise.resolve();
      }
      if(cmd==='show_alert'){ window.__dc_alerts.push(args.payload); return Promise.resolve(); }
      if(cmd==='close_alert'){ return Promise.resolve(); }
      if(cmd==='schedule_timer'){ window.__dc_timer_args=args; return Promise.resolve('23:59'); }
    }catch(e){}
    return Promise.resolve();
  }},
  webviewWindow:{getCurrentWebviewWindow:function(){
    return {onMoved:function(cb){window.__dc_onMoved++;window.__dc_onMovedCb=cb;return Promise.resolve(function(){});},
            setFocus:function(){return Promise.resolve();}};
  }},
  event:{listen:function(n,cb){(window.__dc_listeners[n]=window.__dc_listeners[n]||[]).push(cb);return Promise.resolve(function(){});}}
};
"""
CLOCK_INIT = SETTINGS_INIT.replace(
    "window.__DC_VIEW__='settings';window.__DC_SETTINGS__=1;", ""
)


def prefs(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")


def boot(page, init, p=None, clocks=None):
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    if p is not None:
        page.evaluate("p => localStorage.setItem('deskclock.prefs', JSON.stringify(p))", p)
    if clocks is not None:
        page.evaluate("c => localStorage.setItem('deskclock.clocks', JSON.stringify(c))", clocks)
    page.add_init_script(init)
    page.reload()
    page.wait_for_timeout(700)


def gototab(page, name):
    page.locator('#settings-tabs .tab[data-tab="%s"]' % name).click()
    page.wait_for_timeout(150)


with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True, executable_path=CHROME, args=["--no-sandbox", "--disable-gpu"]
    )
    errors = []
    ctx = browser.new_context(viewport={"width": 760, "height": 700})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("settings: " + str(e)))
    boot(page, SETTINGS_INIT)

    # ===== A: version + title + header =====
    check("APP_VERSION is 0.7.8", "v0.7.8" in page.locator("#ver-badge").inner_text())
    check("settings window title contains version", "v0.7.8" in page.evaluate("document.title"))
    lb = page.locator("#head-target label").bounding_box()
    badge = page.locator("#ver-badge").bounding_box()
    check("editing selector is next to the blue dot / version badge",
          lb["x"] - badge["x"] - badge["width"] < 420,
          (round(lb["x"]), round(badge["x"] + badge["width"])))
    check("editing label and selector share a row",
          abs((lb["y"] + lb["height"] / 2) - (page.locator("#target-clock").bounding_box()["y"] + 20)) < 20)

    # ===== B: time-sync page shows current window time zone =====
    gototab(page, "timezone")
    tz0 = page.locator("#sync-tz").inner_text()
    check("sync page shows current time zone", "本机时间" in tz0 or "UTC" in tz0, tz0)
    check("sync page explains UTC is zone-independent", "UTC" in page.locator('[data-i18n="syncTzNote"]').inner_text())

    # ===== C: new controls / defaults =====
    gototab(page, "alarm")
    check("alarm ring duration default 30", page.locator("#alarm-ring-seconds").input_value() == "30")
    gototab(page, "timer")
    check("timer warn mode default popup", page.locator("#timer-warn-mode").input_value() == "popup")
    check("timer warn seconds default 30", page.locator("#timer-warn-seconds").input_value() == "30")
    check("timer warn seconds enabled in popup mode", not page.locator("#timer-warn-seconds").is_disabled())
    page.locator("#timer-warn-mode").select_option("silent")
    page.wait_for_timeout(200)
    check("timer warn mode persists", prefs(page).get("timerWarnMode") == "silent")
    check("timer warn seconds disabled in silent mode", page.locator("#timer-warn-seconds").is_disabled())
    page.locator("#timer-warn-mode").select_option("popup")
    page.locator("#timer-warn-seconds").fill("45")
    page.locator("#timer-warn-seconds").dispatch_event("change")
    page.wait_for_timeout(200)
    check("timer warn seconds persists", int(prefs(page).get("timerWarnSeconds", 0)) == 45)
    gototab(page, "alarm")
    page.locator("#alarm-ring-seconds").fill("60")
    page.locator("#alarm-ring-seconds").dispatch_event("change")
    page.wait_for_timeout(200)
    check("alarm ring seconds persists", int(prefs(page).get("alarmRingSeconds", 0)) == 60)

    # ===== D: schedule_timer carries warn params =====
    gototab(page, "timer")
    page.locator("#shutdown-min").fill("1")
    page.locator("#shutdown-start").click()
    page.wait_for_timeout(250)
    targs = page.evaluate("window.__dc_timer_args || null")
    check("schedule_timer receives warnMode/warnSeconds",
          bool(targs) and targs.get("warnMode") == "popup" and int(targs.get("warnSeconds", 0)) == 45,
          targs)

    # ===== E: alarm popup DOM is clickable (clock view; settings view hides the toast) =====
    tctx = browser.new_context(viewport={"width": 980, "height": 360})
    tw = tctx.new_page()
    tw.on("pageerror", lambda e: errors.append("toast: " + str(e)))
    boot(tw, CLOCK_INIT)
    attrs = tw.evaluate("""() => {
        return ['alarm-toast-close','alarm-mute','alarm-snooze','alarm-stop','alarm-dismiss']
          .map(id => { const e=document.getElementById(id); return e ? e.getAttribute('data-tauri-drag-region') : null; });
    }""")
    check("all 5 popup buttons opt out of drag region", attrs == ["false"] * 5, attrs)
    tw.evaluate("document.getElementById('alarm-toast').hidden = false")
    check("alarm toast visible", tw.locator("#alarm-toast").is_visible())
    tw.locator("#alarm-stop").click()
    check("alarm toast stop button works", tw.locator("#alarm-toast").is_hidden())
    tw.evaluate("document.getElementById('alarm-toast').hidden = false")
    tw.locator("#alarm-toast-close").click()
    check("alarm toast close X works", tw.locator("#alarm-toast").is_hidden())
    tctx.close()

    # ===== F: settings view has no JS errors =====
    check("no JS errors in settings view", not [e for e in errors if e.startswith("settings:")], errors[:3])

    # ===== G: clock view title + geometry measurement =====
    cctx = browser.new_context(viewport={"width": 980, "height": 360})
    cw = cctx.new_page()
    cw.on("pageerror", lambda e: errors.append("clock: " + str(e)))
    boot(cw, CLOCK_INIT)
    check("clock view title contains version", "v0.7.8" in cw.evaluate("document.title"),
          cw.evaluate("document.title"))
    geo = cw.evaluate("window.__dc_geometry || null")
    check("set_window_geometry receives measured w/h",
          bool(geo) and geo.get("w") and geo.get("h"), geo)
    cctx.close()

    # ===== H: pure-file structural assertions =====
    lib = (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
    appjs = (ROOT / "ui" / "app.js").read_text(encoding="utf-8")
    prefsjs = (ROOT / "ui" / "prefs.js").read_text(encoding="utf-8")
    css = (ROOT / "ui" / "styles.css").read_text(encoding="utf-8")
    caps = (ROOT / "src-tauri" / "capabilities" / "default.json").read_text(encoding="utf-8")
    alert = (ROOT / "ui" / "alert.html")

    check("content-size geometry persisted in Rust", '"w".into()' in lib and '"h".into()' in lib)
    check("spawn uses persisted content size", 'cfg.get("w")' in lib and 'cfg.get("h")' in lib)
    check("alert window commands exist", all(("fn %s(" % n) in lib for n in ("show_alert", "close_alert", "alert_action")))
    check("timer warning thread + generation", "timer-warning" in lib and "generation" in lib)
    check("alert window registered in capabilities", '"alert"' in caps)
    check("independent alert page exists", alert.exists() and "__DC_ALERT__" in alert.read_text(encoding="utf-8"))
    check("all popup descendants opt out of drag region", ".alarm-toast, .alarm-toast * { -webkit-app-region: no-drag; }" in css)
    check("native alert path + listeners present",
          "Prefs.showAlert" in appjs and "alert-action" in appjs and "timer-warning" in appjs)
    check("ring auto-stop timer present", "ringTimeout = setTimeout(hideAlarmToast" in appjs)
    check("new global prefs defaults", "alarmRingSeconds: 30" in prefsjs and "timerWarnSeconds: 30" in prefsjs)
    check("showAlert/closeAlert exported", "showAlert: showAlert" in prefsjs and "closeAlert: closeAlert" in prefsjs)
    check("no JS errors across v0.6.2 run", not errors, errors[:5])

    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
