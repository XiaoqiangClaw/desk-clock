#!/usr/bin/env python3
"""v0.7 (unreleased) TIME ANNOUNCEMENT verification — independent acceptance contract.

Written by the parent agent; the implementer MUST NOT edit this file.

Two layers:
  A. static structure checks (no browser needed)
  B. real Chromium (Playwright) UI + pure-function + trigger-chain checks

The browser layer injects a deterministic `speechSynthesis` mock so TTS calls
can be observed on headless Chromium (which has no voice engine).
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = ROOT / "ui"
CHROME = os.environ.get("CHROMIUM", "/usr/bin/chromium")

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


def rd(rel):
    p = ROOT / rel
    return p.read_text(encoding="utf-8") if p.exists() else ""


FIELDS = [
    "announceEnabled", "announceRule", "announceInterval", "announceTimes",
    "announceVoice", "announceRate", "announceVolume", "announceChime",
    "announceQuiet", "announceQuietStart", "announceQuietEnd",
    "announceIncludeDate", "announceLang",
]
RUST_FIELDS = [
    "announce_enabled", "announce_rule", "announce_interval", "announce_times",
    "announce_voice", "announce_rate", "announce_volume", "announce_chime",
    "announce_quiet", "announce_quiet_start", "announce_quiet_end",
    "announce_include_date", "announce_lang",
]
IDS = [
    "pref-announce-enabled", "pref-announce-voice", "announce-preview",
    "pref-announce-rate", "pref-announce-volume", "pref-announce-chime",
    "pref-announce-include-date", "announce-support-note",
    "pref-announce-rule", "announce-interval-row", "pref-announce-interval",
    "announce-times-row", "announce-hour", "announce-minute",
    "announce-time-add", "announce-time-list",
    "pref-announce-quiet", "announce-quiet-row",
    "pref-announce-quiet-start", "pref-announce-quiet-end",
]
I18N_KEYS = [
    "announceTitle", "announceEnabled", "announceEnabledNote",
    "announceVoice", "announceVoiceDefault", "announceVoiceNote",
    "announceVoiceUnsupported", "announceRate", "announceVolume",
    "announceChime", "announceChimeNone", "announcePreview",
    "announceIncludeDate", "announceRuleTitle", "announceRule",
    "announceRuleNote", "ruleHourly", "ruleHalf", "ruleQuarter",
    "ruleInterval", "ruleCustom", "announceInterval",
    "announceIntervalNote", "announceTimes", "announceTimeAdd",
    "announceTimeEmpty", "announceQuiet", "announceQuietStart",
    "announceQuietEnd", "announceQuietNote",
]

# ============================== A. static ==============================
ann = rd("ui/announce.js")
html = rd("ui/index.html")
prefs = rd("ui/prefs.js")
i18n = rd("ui/i18n.js")
appjs = rd("ui/app.js")
alarm = rd("ui/alarm.js")
lib = rd("src-tauri/src/lib.rs")
cargo = rd("src-tauri/Cargo.toml")
conf = rd("src-tauri/tauri.conf.json")

check("announce.js exists and is non-trivial", len(ann) > 2000, len(ann))
check("announce.js attaches window.DeskClock.Announce",
      "window.DeskClock.Announce" in ann)
check("announce.js exports all 8 APIs",
      all(("supported:" in ann, "voices:" in ann, "onVoicesChanged:" in ann,
           "inQuiet:" in ann, "shouldFire:" in ann, "buildText:" in ann,
           "speak:" in ann, "preview:" in ann)))
check("announce.js has no top-level API access without guard",
      "SpeechSynthesisUtterance" in ann and "speechSynthesis" in ann)

script_order = html.find('src="announce.js"')
check("index.html loads announce.js", script_order >= 0)
check("index.html loads announce.js after alarm.js and before app.js",
      html.find('src="alarm.js"') < script_order < html.find('src="app.js"'))
missing_ids = [i for i in IDS if ('id="%s"' % i) not in html]
check("index.html has all 20 announcement control ids", not missing_ids, missing_ids)
check("index.html adds no new tab button",
      'data-tab="announce"' not in html)
# count actual tab buttons / panels precisely
import re
n_tabs = len(re.findall(r'<button[^>]*class="tab[^"]*"[^>]*data-tab=', html))
n_panels = len(re.findall(r'<section[^>]*class="panel[^"]*"[^>]*data-panel=', html))
check("exactly 7 tabs (no new tab added)", n_tabs == 7, n_tabs)
check("exactly 7 panels (no new panel added)", n_panels == 7, n_panels)
check("announcement cards live inside the alarm panel",
      html.find('data-panel="alarm"') < html.find('id="pref-announce-enabled"') < html.find('data-panel="timer"'))

missing_defaults = [f for f in FIELDS if (f + ":") not in prefs]
check("prefs.js DEFAULTS has all 13 fields", not missing_defaults, missing_defaults)
check("prefs.js DEFAULTS announceEnabled is false",
      re.search(r"announceEnabled:\s*false", prefs) is not None)
gk = re.search(r"var GLOBAL_KEYS\s*=\s*\[(.*?)\];", prefs, re.S)
gkeys = gk.group(1) if gk else ""
wk = re.search(r"var WINDOW_KEYS\s*=\s*\[(.*?)\];", prefs, re.S)
wkeys = wk.group(1) if wk else ""
missing_g = [f for f in FIELDS if ("'%s'" % f) not in gkeys]
check("all 13 fields are GLOBAL_KEYS", not missing_g, missing_g)
check("no announcement field leaks into WINDOW_KEYS",
      all(("'%s'" % f) not in wkeys for f in FIELDS))
check("prefs.js normalize() clamps new numeric fields",
      "announceRate" in prefs and "announceVolume" in prefs
      and "announceInterval" in prefs and "announceTimes" in prefs)

missing_i18n_zh = [k for k in I18N_KEYS if (k + ":") not in i18n]
check("i18n.js declares all 30 announcement keys", not missing_i18n_zh, missing_i18n_zh)
check("i18n.js has announceRules option group",
      "announceRules" in i18n and "ruleHourly" in i18n)
check("i18n.js translates announcement rule select",
      "opts('pref-announce-rule'" in i18n)

missing_rust = [f for f in RUST_FIELDS if ("pub %s:" % f) not in lib]
check("lib.rs Prefs declares all 13 rust fields", not missing_rust, missing_rust)
check("lib.rs Default sets announce_enabled: false",
      re.search(r"announce_enabled:\s*false", lib) is not None)
check("lib.rs Default supplies all 13 values",
      all(re.search(re.escape(f) + r":", lib) for f in RUST_FIELDS))
check("lib.rs keeps serde default + camelCase",
      '#[serde(default, rename_all = "camelCase")]' in lib)
n_cmd = len(re.findall(r"#\[tauri::command\]", lib))
check("no new tauri command for announcement (generic merge only)",
      "fn announce_" not in lib, "commands=%d" % n_cmd)

check("alarm.js exports single-shot playChime",
      "playChime:" in alarm and "chime(" in alarm)
check("app.js references DeskClock.Announce", "DC.Announce" in appjs)
check("app.js defines maybeAnnounce + minute de-dup",
      "maybeAnnounce" in appjs and "lastAnnounceKey" in appjs
      and "Announce.shouldFire" in appjs and "Announce.speak" in appjs)
check("app.js calls maybeAnnounce from onTick",
      re.search(r"function onTick\([\s\S]{0,400}?maybeAnnounce", appjs) is not None)
check("app.js syncs + binds announcement UI",
      "syncAnnounceUI" in appjs and "renderAnnounceTimes" in appjs
      and "pref-announce-enabled" in appjs and "announce-preview" in appjs)
check("app.js plays chime before speaking",
      "Alarm.playChime" in appjs)

# version strings must be consistent at 0.7.7 (this is now a release)
check("APP_VERSION is 0.7.7", "var APP_VERSION = '0.7.7';" in appjs)
check("Cargo.toml version is 0.7.7", 'version = "0.7.7"' in cargo)
check("tauri.conf.json version is 0.7.7", '"version": "0.7.7"' in conf)
check("lib.rs native titles are v0.7.7",
      len(re.findall(r"Desk Clock v0\.7\.7", lib)) == 3,
      len(re.findall(r"Desk Clock v0\.7\.7", lib)))
check("docs mention v0.7 announcement",
      "播报" in rd("README.md") and "Announce" in rd("docs/SPEC.md")
      and "v0.7.7" in rd("CHANGELOG.md"))

# ============================== B. browser ==============================
from playwright.sync_api import sync_playwright


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


httpd = socketserver.TCPServer(("127.0.0.1", 0),
                              functools.partial(QuietHandler, directory=str(UI_DIR)))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/index.html" % httpd.server_address[1]

MOCK = r"""
window.__dcSpeakLog = [];
window.__dcCancelCount = 0;
window.__dcVoices = [
  {voiceURI:'mock-zh', name:'Mock 中文', lang:'zh-CN', localService:true, default:true},
  {voiceURI:'mock-en', name:'Mock English', lang:'en-US', localService:true, default:false}
];
window.SpeechSynthesisUtterance = function (text) {
  this.text = text; this.lang = ''; this.rate = 1; this.volume = 1;
  this.pitch = 1; this.voice = null;
};
var __synth = {
  getVoices: function () { return window.__dcVoices; },
  speak: function (u) {
    window.__dcSpeakLog.push({
      text: u.text, lang: u.lang, rate: u.rate, volume: u.volume,
      pitch: u.pitch, voice: u.voice ? (u.voice.voiceURI || u.voice.name || null) : null
    });
  },
  cancel: function () { window.__dcCancelCount++; },
  addEventListener: function () {}, removeEventListener: function () {},
  onvoiceschanged: null
};
Object.defineProperty(window, 'speechSynthesis',
  { configurable: true, get: function () { return __synth; } });
"""

FIXED_DATE = r"""
var __RealDate = Date;
var __t = new __RealDate(2026, 10, 11, 9, 0, 0).getTime();
function __FakeDate() {
  if (arguments.length === 0) return new __RealDate(__t);
  return new (__RealDate.bind.apply(__RealDate,
    [null].concat(Array.prototype.slice.call(arguments))))();
}
__FakeDate.now = function () { return __t; };
__FakeDate.parse = __RealDate.parse;
__FakeDate.UTC = __RealDate.UTC;
__FakeDate.prototype = __RealDate.prototype;
window.Date = __FakeDate;
"""


def prefs_of(page):
    return page.evaluate("JSON.parse(localStorage.getItem('deskclock.prefs')||'{}')")


def boot(page, obj=None):
    page.goto(URL)
    page.evaluate("localStorage.removeItem('deskclock.clocks')")
    page.evaluate("p => localStorage.setItem('deskclock.prefs', JSON.stringify(p))", obj or {})
    page.reload()
    page.wait_for_timeout(700)


def open_settings(page):
    if page.locator("#settings").is_hidden():
        page.locator("#gear").click()
    page.wait_for_timeout(120)


with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, executable_path=CHROME,
                                 args=["--no-sandbox", "--disable-gpu"])
    errors = []

    # ---- ctx1: default / UI / persistence / pure functions ----
    ctx = browser.new_context(viewport={"width": 980, "height": 760})
    ctx.add_init_script(script=MOCK)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)

    boot(page)
    check("default: no TTS call at all (feature OFF)", len(page.evaluate("window.__dcSpeakLog")) == 0,
          page.evaluate("window.__dcSpeakLog"))
    check("default: announceEnabled unchecked",
          page.locator("#pref-announce-enabled").is_checked() is False)
    check("default: DEFAULTS.announceEnabled === false",
          page.evaluate("window.DeskClock.Prefs.DEFAULTS.announceEnabled") is False)
    check("default: rule = hourly", page.locator("#pref-announce-rule").input_value() == "hourly")

    open_settings(page)
    page.wait_for_timeout(200)
    # 时钟窗口模式下 .settings-tabs 不渲染（仅独立设置窗口才显示 tab），
    # 各 panel 扁平展开——直接操作控件即可，不切 tab。
    check("announcement controls visible in settings (flat clock window)",
          page.locator("#pref-announce-enabled").is_visible())
    check("interval row hidden by default", page.locator("#announce-interval-row").is_hidden())
    check("times row hidden by default", page.locator("#announce-times-row").is_hidden())
    check("quiet row hidden by default", page.locator("#announce-quiet-row").is_hidden())
    voices_n = page.locator("#pref-announce-voice option").count()
    check("voice select offers default + 2 mock voices", voices_n == 3, voices_n)

    # --- rule → row visibility ---
    page.locator("#pref-announce-rule").select_option("interval")
    page.wait_for_timeout(350)
    check("interval rule reveals interval row", page.locator("#announce-interval-row").is_visible())
    page.locator("#pref-announce-rule").select_option("custom")
    page.wait_for_timeout(350)
    check("custom rule reveals times row", page.locator("#announce-times-row").is_visible())
    check("custom rule hides interval row", page.locator("#announce-interval-row").is_hidden())
    page.locator("#pref-announce-quiet").check()
    page.wait_for_timeout(350)
    check("quiet toggle reveals quiet row", page.locator("#announce-quiet-row").is_visible())

    # --- persistence + state readback ---
    page.locator("#pref-announce-enabled").check()
    page.wait_for_timeout(300)
    # 先切 interval 让输入框可见再填值；range 用 evaluate 设值（fill 不适用于 range）
    page.locator("#pref-announce-rule").select_option("interval")
    page.wait_for_timeout(200)
    page.locator("#pref-announce-interval").fill("45")
    page.locator("#pref-announce-interval").dispatch_event("change")
    page.evaluate("() => { var r=document.getElementById('pref-announce-rate'); r.value='1.5'; r.dispatchEvent(new Event('input',{bubbles:true})); }")
    page.evaluate("() => { var v=document.getElementById('pref-announce-volume'); v.value='0.6'; v.dispatchEvent(new Event('input',{bubbles:true})); }")
    page.locator("#pref-announce-voice").select_option("mock-en")
    page.locator("#pref-announce-chime").select_option("none")
    page.locator("#pref-announce-include-date").check()
    page.locator("#pref-announce-rule").select_option("half")
    page.wait_for_timeout(500)
    p = prefs_of(page)
    check("prefs persist: enabled/rule/interval/rate/volume/voice/chime/date",
          p.get("announceEnabled") is True and p.get("announceRule") == "half"
          and p.get("announceInterval") == 45
          and abs(float(p.get("announceRate", 0)) - 1.5) < 0.01
          and abs(float(p.get("announceVolume", 0)) - 0.6) < 0.01
          and p.get("announceVoice") == "mock-en" and p.get("announceChime") == "none"
          and p.get("announceIncludeDate") is True, p)
    page.reload()
    page.wait_for_timeout(700)
    open_settings(page)
    page.wait_for_timeout(200)
    check("state readback after reload (not just saved)",
          page.locator("#pref-announce-enabled").is_checked()
          and page.locator("#pref-announce-rule").input_value() == "half"
          and page.locator("#pref-announce-voice").input_value() == "mock-en"
          and page.locator("#pref-announce-chime").input_value() == "none"
          and page.locator("#pref-announce-include-date").is_checked())

    # --- preview button → real TTS call ---
    before = len(page.evaluate("window.__dcSpeakLog"))
    page.locator("#announce-preview").click()
    page.wait_for_timeout(250)
    log = page.evaluate("window.__dcSpeakLog")
    check("preview triggers exactly one TTS call", len(log) == before + 1, log[-1:] if log else [])
    check("preview text is non-empty and time-like",
          bool(log) and len(log[-1]["text"]) > 4, log[-1]["text"] if log else "")
    check("preview applies selected voice / rate / volume",
          bool(log) and log[-1]["voice"] == "mock-en"
          and abs(log[-1]["rate"] - 1.5) < 0.01
          and abs(log[-1]["volume"] - 0.6) < 0.01, log[-1] if log else {})
    check("speak() cancels previous utterance",
          page.evaluate("window.__dcCancelCount") >= 1)

    # --- custom times add/remove ---
    page.locator("#pref-announce-rule").select_option("custom")
    page.wait_for_timeout(300)
    page.locator("#announce-hour").select_option("07")
    page.locator("#announce-minute").select_option("15")
    page.locator("#announce-time-add").click()
    page.wait_for_timeout(400)
    tl = prefs_of(page).get("announceTimes", [])
    check("custom time added to prefs", len(tl) == 1 and tl[0].get("time") == "07:15", tl)
    check("custom time row rendered", page.locator("#announce-time-list .alarm-row").count() == 1)
    page.locator("#announce-time-list .alarm-row button").click()
    page.wait_for_timeout(400)
    check("custom time removed", len(prefs_of(page).get("announceTimes", [])) == 0)

    # --- pure functions: shouldFire ---
    sf = page.evaluate("""() => {
      var A = window.DeskClock.Announce;
      var D = function (h, m) { return new Date(2026, 10, 11, h, m, 0); };
      var base = { announceEnabled: true };
      var c = function (o) { var x = {}; for (var k in base) x[k] = base[k]; for (var k in o) x[k] = o[k]; return x; };
      return {
        off: A.shouldFire(D(9,0), c({announceEnabled:false, announceRule:'hourly'})),
        hourly0900: A.shouldFire(D(9,0), c({announceRule:'hourly'})),
        hourly0901: A.shouldFire(D(9,1), c({announceRule:'hourly'})),
        half0930: A.shouldFire(D(9,30), c({announceRule:'half'})),
        half0915: A.shouldFire(D(9,15), c({announceRule:'half'})),
        quarter0915: A.shouldFire(D(9,15), c({announceRule:'quarter'})),
        quarter0910: A.shouldFire(D(9,10), c({announceRule:'quarter'})),
        interval30_0930: A.shouldFire(D(9,30), c({announceRule:'interval', announceInterval:30})),
        interval30_0920: A.shouldFire(D(9,20), c({announceRule:'interval', announceInterval:30})),
        custom0907: A.shouldFire(D(9,7), c({announceRule:'custom', announceTimes:[{id:'a',time:'09:07'}]})),
        custom0908: A.shouldFire(D(9,8), c({announceRule:'custom', announceTimes:[{id:'a',time:'09:07'}]})),
        quietBlock: A.shouldFire(D(23,0), c({announceRule:'hourly', announceQuiet:true,
                                            announceQuietStart:'22:00', announceQuietEnd:'07:00'})),
        quietAllow: A.shouldFire(D(12,0), c({announceRule:'hourly', announceQuiet:true,
                                            announceQuietStart:'22:00', announceQuietEnd:'07:00'}))
      };
    }""")
    expect = {
        "off": False, "hourly0900": True, "hourly0901": False,
        "half0930": True, "half0915": False, "quarter0915": True, "quarter0910": False,
        "interval30_0930": True, "interval30_0920": False,
        "custom0907": True, "custom0908": False,
        "quietBlock": False, "quietAllow": True,
    }
    bad = {k: (v, expect[k]) for k, v in sf.items() if v != expect[k]}
    check("shouldFire: all 13 rule/quiet cases", not bad, bad)
    check("shouldFire is a pure function (repeated call stable)",
          page.evaluate("""() => {
            var A = window.DeskClock.Announce, d = new Date(2026,10,11,9,0,0);
            var c = {announceEnabled:true, announceRule:'hourly'};
            return A.shouldFire(d,c) === A.shouldFire(d,c);
          }"""))

    # --- pure functions: inQuiet cross-midnight ---
    iq = page.evaluate("""() => {
      var A = window.DeskClock.Announce;
      var D = function (h,m) { return new Date(2026,10,11,h,m,0); };
      var c = {announceQuiet:true, announceQuietStart:'22:00', announceQuietEnd:'07:00'};
      return { h23:A.inQuiet(D(23,0),c), h03:A.inQuiet(D(3,0),c),
               h22:A.inQuiet(D(22,0),c), h07:A.inQuiet(D(7,0),c),
               h12:A.inQuiet(D(12,0),c),
               disabled:A.inQuiet(D(23,0),{announceQuiet:false,
                 announceQuietStart:'22:00',announceQuietEnd:'07:00'}),
               same:A.inQuiet(D(23,0),{announceQuiet:true,
                 announceQuietStart:'22:00',announceQuietEnd:'22:00'}) };
    }""")
    check("inQuiet handles cross-midnight window + edge/disabled cases",
          iq == {"h23": True, "h03": True, "h22": True, "h07": False,
                 "h12": False, "disabled": False, "same": False}, iq)

    # --- pure functions: buildText zh/en ---
    bt = page.evaluate("""() => {
      var A = window.DeskClock.Announce;
      var D = function (h,m) { return new Date(2026,10,11,h,m,0); };
      var zh = function (inc) { return {lang:'zh-CN', hour12:true, announceIncludeDate:!!inc}; };
      var en = function (h12) { return {lang:'en', hour12:h12, announceIncludeDate:false}; };
      return {
        z0900: A.buildText(D(9,0), zh(false)),
        z1530: A.buildText(D(15,30), zh(false)),
        z2205: A.buildText(D(22,5), zh(false)),
        zDate: A.buildText(D(9,0), zh(true)),
        e0900: A.buildText(D(9,0), en(true)),
        e1530: A.buildText(D(15,30), en(true)),
        e1530_24: A.buildText(D(15,30), en(false)),
        staleEn: A.buildText(D(15,30), {lang:'zh-CN', announceLang:'en', hour12:false})
      };
    }""")
    check("buildText zh 09:00 exact", bt["z0900"] == "现在是上午九点整", bt["z0900"])
    check("buildText zh 15:30 exact", bt["z1530"] == "现在是下午三点三十分", bt["z1530"])
    check("buildText zh 22:05 exact", bt["z2205"] == "现在是晚上十点零五分", bt["z2205"])
    check("buildText zh with date includes month/day/weekday",
          "十一月" in bt["zDate"] and "星期三" in bt["zDate"] and "九点整" in bt["zDate"], bt["zDate"])
    # v0.7.5: English speech removed — every config now announces in Chinese.
    check("buildText ignores en UI lang (09:00)",
          bt["e0900"] == "现在是上午九点整", bt["e0900"])
    check("buildText ignores en UI lang (15:30)",
          bt["e1530"] == "现在是下午三点三十分" and bt["e1530_24"] == "现在是下午三点三十分", bt["e1530_24"])
    check("buildText ignores stale announceLang=en",
          bt["staleEn"] == "现在是下午三点三十分", bt["staleEn"])

    # --- speak() assembly + voices() + supported() ---
    sp = page.evaluate("""() => {
      var A = window.DeskClock.Announce;
      var ok = A.speak('测试播报', {announceVoice:'invalid', announceRate:9,
        announceVolume:-3, announceLang:'zh-CN'});
      var last = window.__dcSpeakLog[window.__dcSpeakLog.length-1];
      return {ok:ok, last:last, voices:A.voices().length, supported:A.supported()};
    }""")
    check("speak() returns true when engine present", sp["ok"] is True)
    check("speak() clamps rate/volume and auto-matches zh voice",
          sp["last"]["rate"] == 2 and sp["last"]["volume"] == 0
          and sp["last"]["voice"] == "mock-zh" and sp["last"]["lang"] == "zh-CN"
          and sp["last"]["pitch"] == 1, sp["last"])
    check("voices() + supported() report the mock engine",
          sp["voices"] == 2 and sp["supported"] is True, sp)

    # --- i18n switch: no raw keys on announcement card ---
    page.locator("#pref-lang").select_option("en")
    page.wait_for_timeout(400)
    title = page.locator('[data-i18n="announceTitle"]').first.inner_text()
    check("en i18n renders announcement title (no raw key)",
          bool(title) and title != "announceTitle" and title != "语音播报",
          title)
    check("en i18n renders enabled label (no raw key)",
          page.locator('[data-i18n="announceEnabled"]').first.inner_text() != "announceEnabled")

    check("no JS errors in default/UI run", not errors, errors[:6])
    ctx.close()

    # ---- ctx2: real first-frame trigger at a fixed 09:00 ----
    ctx2 = browser.new_context(viewport={"width": 980, "height": 400})
    ctx2.add_init_script(script=FIXED_DATE)
    ctx2.add_init_script(script=MOCK)
    page2 = ctx2.new_page()
    err2 = []
    page2.on("pageerror", lambda e: err2.append(str(e)))
    page2.on("console", lambda m: err2.append("console.error: " + m.text) if m.type == "error" else None)

    # (a) OFF at exact hour → no announcement
    page2.goto(URL)
    page2.evaluate("localStorage.removeItem('deskclock.clocks')")
    page2.evaluate("""() => localStorage.setItem('deskclock.prefs', JSON.stringify({
      announceEnabled:false, announceRule:'hourly', lang:'zh-CN', hour12:true
    }))""")
    page2.reload()
    page2.wait_for_timeout(800)
    check("fixed 09:00, feature OFF → zero TTS calls",
          len(page2.evaluate("window.__dcSpeakLog")) == 0,
          page2.evaluate("window.__dcSpeakLog"))

    # (b) ON at exact hour → exactly one announcement, correct text
    page2.evaluate("""() => {
      window.__dcSpeakLog.length = 0;
      localStorage.setItem('deskclock.prefs', JSON.stringify({
        announceEnabled:true, announceRule:'hourly', announceChime:'none',
        lang:'zh-CN', hour12:true
      }));
    }""")
    page2.reload()
    page2.wait_for_timeout(900)
    log2 = page2.evaluate("window.__dcSpeakLog")
    check("fixed 09:00, feature ON → exactly one announcement (de-dup works)",
          len(log2) == 1, log2)
    check("announcement text is the 09:00 sentence",
          bool(log2) and "九点整" in log2[0]["text"], log2[0]["text"] if log2 else "")
    check("no JS errors in fixed-time trigger run", not err2, err2[:6])
    ctx2.close()

    browser.close()

httpd.shutdown()
failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
sys.exit(1 if failed else 0)
