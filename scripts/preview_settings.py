#!/usr/bin/env python3
"""Standalone preview tool: regenerate the 3 settings-window screenshots.

Not part of any regression assertion. Produces v0.6.3 settings screenshots:
  .preview/settings-zh.png           zh-CN, appearance tab, 760x700
  .preview/settings-en.png           en, appearance tab, 760x700
  .preview/settings-window-v063.png  zh-CN, window tab with populated manager
"""
import functools
import http.server
import os
import socketserver
import struct
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "ui"
OUT = ROOT / ".preview"
OUT.mkdir(exist_ok=True)
CHROME = os.environ.get("CHROME", "/usr/bin/chromium")


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

WINDOW_PREFS = {
    "lang": "zh-CN",
    "extraClocks": [
        {"id": "c1", "label": "东京", "offset": 540, "style": "", "showSeconds": True, "visible": True},
        {"id": "c2", "label": "纽约", "offset": -300, "style": "", "showSeconds": True, "visible": True},
    ],
}
WINDOW_CLOCKS = {"activeId": "main", "clocks": {"main": {}, "c1": {}, "c2": {}}}


def boot(page, prefs_obj=None, clocks_obj=None):
    page.goto(URL)
    page.evaluate("localStorage.clear()")
    if prefs_obj is not None:
        page.evaluate(
            "p => localStorage.setItem('deskclock.prefs', JSON.stringify(p))", prefs_obj
        )
    if clocks_obj is not None:
        page.evaluate(
            "c => localStorage.setItem('deskclock.clocks', JSON.stringify(c))", clocks_obj
        )
    page.add_init_script(SETTINGS_INIT)
    page.reload()
    page.wait_for_timeout(700)


def gototab(page, name):
    page.locator('#settings-tabs .tab[data-tab="%s"]' % name).click()
    page.wait_for_timeout(150)


def size_of(path):
    with open(path, "rb") as f:
        data = f.read(24)
    return struct.unpack(">II", data[16:24])


def save(page, path):
    page.screenshot(path=str(path))
    w, h = size_of(path)
    if (w, h) != (760, 700):
        raise RuntimeError("%s is %dx%d, expected 760x700" % (path, w, h))
    print("saved: %s  %dx%d" % (path, w, h))


with sync_playwright() as pw:
    browser = pw.chromium.launch(
        headless=True, executable_path=CHROME, args=["--no-sandbox", "--disable-gpu"]
    )
    ctx = browser.new_context(viewport={"width": 760, "height": 700})
    page = ctx.new_page()

    # 1. zh-CN appearance tab
    boot(page, prefs_obj={"lang": "zh-CN"})
    page.evaluate("window.scrollTo(0,0)")
    save(page, OUT / "settings-zh.png")

    # 2. en appearance tab
    boot(page, prefs_obj={"lang": "en"})
    page.evaluate("window.scrollTo(0,0)")
    save(page, OUT / "settings-en.png")

    # 3. zh-CN window tab with populated manager
    boot(page, prefs_obj=WINDOW_PREFS, clocks_obj=WINDOW_CLOCKS)
    gototab(page, "window")
    card = page.locator("#window-manager-card")
    card.scroll_into_view_if_needed()
    page.evaluate("document.getElementById('window-manager-card').scrollIntoView({block:'center'})")
    page.wait_for_timeout(200)
    rows = page.locator("#cm-list .cm-row").count()
    if rows != 3:
        raise RuntimeError("expected 3 manager rows (main+tokyo+ny), got %d" % rows)
    if page.locator('#cm-list .cm-row[data-cm-id="main"] .cm-row-tag').count() != 1:
        raise RuntimeError("main card missing tag")
    save(page, OUT / "settings-window-v063.png")

    browser.close()

httpd.shutdown()

print("=== preview_settings: 3 screenshots OK ===")
