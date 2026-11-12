#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v0.7.4: 日历数据「覆盖驱动」同步 + 每版内置最新数据 验收。

两部分：
  A. 纯文件结构检查（生成器双产出/自动探测、CI 降频、发版刷新纪律、覆盖驱动、
     备源容错、前端接线、文档、版本一致性）；
  B. Node 行为测试：用 mock 浏览器环境加载真实的 schedule.js / calendar-sync.js，
     实测 setData 热替换、validateData 严格校验、只增不减防回退、覆盖增长、
     缓存落盘、覆盖驱动 8 个日期场景、临期预取/跨年自愈/缓存恢复、主源故障自动切备源
     与交易日判定随之更新——不是 grep 字符串，是真跑逻辑。
"""
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


def rd(p):
    return (ROOT / p).read_text(encoding="utf-8")


# ========================================================================
# A. 文件结构检查
# ========================================================================

# --- A1. 生成器：自动探测年份 + 双产出 ---
gen = rd("scripts/gen-calendar.py")
check("gen-calendar.py has auto year detection (detect_years)",
      "def detect_years" in gen and "year_supported" in gen)
check("gen-calendar.py uses three-point probe",
      "(1, 1), (6, 1), (12, 31)" in gen)
check("gen-calendar.py does NOT hardcode year end as fixed range",
      "range(2024, 2028)" not in gen)
check("gen-calendar.py writes both .js and .json",
      "calendar-data.js" in gen and "calendar-data.json" in gen)
check("gen-calendar.py emits schema + coverage metadata",
      '"schema"' in gen and '"coverage"' in gen)

# --- A2. 数据双文件一致性 + 合法性 ---
cdjs = rd("ui/calendar-data.js")
m = re.search(r"CalendarData = (\{.*\});", cdjs, re.S)
check("calendar-data.js has parseable CalendarData object", bool(m))
data_js = json.loads(m.group(1)) if m else {}
data_json = json.loads(rd("ui/calendar-data.json"))
check("calendar-data.json is valid JSON", isinstance(data_json, dict))
check(".js and .json payloads are identical", data_js == data_json)
check("data has schema==1 and coverage list",
      data_js.get("schema") == 1 and isinstance(data_js.get("coverage"), list))
years = sorted(int(y) for y in data_js.get("years", {}))
check("year coverage is contiguous", years == list(range(years[0], years[-1] + 1)) if years else False,
      years)
check("data covers 2024..at least 2027", bool(years) and years[0] <= 2024 and years[-1] >= 2027)
shape_ok = all(
    isinstance(v.get("h"), list) and isinstance(v.get("w"), list)
    and all(re.fullmatch(r"\d{4}", x) for x in v["h"] + v["w"])
    for v in data_js.get("years", {}).values())
check("every year has valid h/w MMdd arrays", shape_ok)

# --- A3. 生成器幂等（CI 靠 git diff --quiet 判定变化，产出必须确定）---
r = subprocess.run(["python3", str(ROOT / "scripts" / "gen-calendar.py")],
                   capture_output=True, text=True, cwd=str(ROOT))
check("gen-calendar.py runs without error", r.returncode == 0, r.stderr.strip()[:120])
cdjs2 = rd("ui/calendar-data.js")
check("generator is idempotent (.js unchanged)", cdjs == cdjs2)

# --- A4. CI 定时任务 ①（v0.7.4 降频：11 月发布季每周 + 其余每月）---
wf = ROOT / ".github" / "workflows" / "calendar-sync.yml"
check("calendar-sync workflow exists", wf.exists())
w = wf.read_text(encoding="utf-8") if wf.exists() else ""
check("workflow has schedule cron + workflow_dispatch", "cron:" in w and "workflow_dispatch" in w)
check("workflow no longer polls every week all year", 'cron: "17 3 * * 1"' not in w)
check("workflow has November release-season weekly cron", 'cron: "17 3 * 11 1"' in w)
check("workflow has monthly off-season cron", 'cron: "17 3 1 1-10,12 *"' in w)
check("workflow upgrades chinese_calendar", "--upgrade chinese_calendar" in w)
check("workflow regenerates data", "scripts/gen-calendar.py" in w)
check("workflow commits only on change", "git diff --cached --quiet" in w)
check("workflow has contents: write permission", "contents: write" in w)
check("workflow only stages the two data files",
      "git add ui/calendar-data.js ui/calendar-data.json" in w)
check("workflow validates before committing", "node --check ui/calendar-data.js" in w)

# --- A5. 发版纪律（v0.7.4 新增）：每个版本都把当前最新数据直接内置 ---
rels = rd(".github/workflows/release.yml")
check("release.yml refreshes built-in data with latest library at publish time",
      "--upgrade chinese_calendar" in rels and "Setup Python" in rels)
check("release.yml runs gen-calendar.py before building",
      "python scripts/gen-calendar.py" in rels
      and rels.index("gen-calendar.py") < rels.index("Build and upload to GitHub Release"))
check("release.yml validates refreshed .js/.json consistency",
      "a == b" in rels and "coverage must be contiguous" in rels)

# --- A6. 运行时同步模块 ②（v0.7.4 覆盖驱动 + 备源容错）---
cs = rd("ui/calendar-sync.js")
check("calendar-sync.js defines DeskClock.CalendarSync", "window.DeskClock.CalendarSync" in cs)
check("uses self-hosted raw data (no third-party API)",
      "raw.githubusercontent.com" in cs and "calendar-data.json" in cs)
check("has coverage-driven decision (local/prefetch/expired)",
      "function decide" in cs and "'prefetch'" in cs and "'expired'" in cs and "'local'" in cs)
check("prefetch starts in December (month>=11)",
      "PREFETCH_MONTH = 11" in cs and "getMonth() >= PREFETCH_MONTH" in cs)
check("covered year -> zero network (local short-circuit)",
      "d === 'local' && !cacheRecoveryPending" in cs)
check("expired year -> immediate self-heal fetch",
      "if (y > maxY) return 'expired'" in cs)
check("cache loss -> builtin fallback + recovery fetch",
      "cacheRecoveryPending = true" in cs and "内置表兜底" in cs)
check("no more blind 24h-OK polling for covered data",
      "var OK_INTERVAL = 24 * 3600 * 1000" not in cs and "PREFETCH_OK_INTERVAL" in cs)
check("has two data sources (primary + mirror)",
      "var SOURCES = [RAW_URL, MIRROR_URL]" in cs and "cdn.jsdelivr.net/gh/" in cs)
check("mirror URL derived from primary (single source of truth)",
      ".replace('https://raw.githubusercontent.com/', 'https://cdn.jsdelivr.net/gh/')" in cs)
check("primary failure auto-falls-back to mirror",
      "function fetchWithFallback" in cs and "return attempt();" in cs)
check("strict validation via Schedule.validateData/setData",
      "S.validateData" in cs and "S.setData" in cs)
check("has offline/failure silent fallback (catch)", ".catch(" in cs)
check("has request timeout", "REQUEST_TIMEOUT" in cs and "AbortController" in cs)
check("does not autofetch in browser preview (noise-free regression)",
      "isNative" in cs and "'preview'" in cs)
check("exposes testable hooks (_applyRemote/_shouldFetch/_decide)",
      "_applyRemote: applyRemote" in cs and "_shouldFetch: shouldFetch" in cs
      and "_decide: decide" in cs)

# --- A7. schedule.js 热替换 API ---
sj = rd("ui/schedule.js")
for fn in ("function setData", "function validateData", "function coverageOf", "function coverage("):
    check("schedule.js has " + fn, fn in sj)
check("schedule.js exports setData/validateData/coverage",
      "setData: setData" in sj and "validateData: validateData" in sj and "coverage: coverage" in sj)
check("setData updates global CalendarData", "window.DeskClock.CalendarData = d;" in sj)

# --- A8. 前端接线 ---
html = rd("ui/index.html")
check("index.html loads calendar-sync.js after schedule.js",
      html.index('src="schedule.js"') < html.index('src="calendar-sync.js"') < html.index('src="app.js"'))
for eid in ("pref-cal-autosync", "cal-sync-now", "cal-sync-status"):
    check("index.html has #" + eid, 'id="%s"' % eid in html)
prefs = rd("ui/prefs.js")
check("prefs.js has calendarAutoSync default true", "calendarAutoSync: true" in prefs)
check("prefs.js whitelists calendarAutoSync", "'calendarAutoSync'" in prefs)
i18n = rd("ui/i18n.js")
check("i18n zh + en calendar strings", "calSyncTitle:" in i18n and "calSyncStatusOff:" in i18n
      and i18n.count("calSyncAuto:") >= 2)
app = rd("ui/app.js")
check("app.js wires CalendarSync.start()", "CS.start()" in app)
check("app.js renders calendar status", "renderCalSyncStatus" in app)
check("app.js binds manual check", "cal-sync-now" in app)
check("app.js binds auto-sync toggle", "pref-cal-autosync" in app)

# --- A9. 版本一致性 0.7.5 ---
ver_sources = {
    "ui/app.js": "var APP_VERSION = '0.7.5';",
    "src-tauri/Cargo.toml": 'version = "0.7.5"',
    "src-tauri/tauri.conf.json": '"version": "0.7.5"',
}
for p, needle in ver_sources.items():
    check("version 0.7.5 in " + p, needle in rd(p))
lib = rd("src-tauri/src/lib.rs")
check("lib.rs native titles all v0.7.5 (3)",
      len(re.findall(r"Desk Clock v0\.7\.5", lib)) == 3,
      len(re.findall(r"Desk Clock v0\.7\.4", lib)))
check("no stale 0.7.3 in version declarations",
      "var APP_VERSION = '0.7.3'" not in rd("ui/app.js")
      and 'version = "0.7.3"' not in rd("src-tauri/Cargo.toml")
      and '"version": "0.7.3"' not in rd("src-tauri/tauri.conf.json"))

# --- A10. 文档 ---
readme, changelog, spec = rd("README.md"), rd("CHANGELOG.md"), rd("docs/SPEC.md")
check("README mentions calendar auto-update", "自动更新" in readme and "交易日" in readme)
check("README documents v0.7.5", "v0.7.5" in readme)
check("README documents coverage-driven sync", "覆盖驱动" in readme)
check("README documents every-version fresh built-in data", "内置最新" in readme or "发版" in readme)
check("CHANGELOG has v0.7.4 and v0.7.5 sections", "v0.7.4" in changelog and "v0.7.5" in changelog)
check("CHANGELOG documents covered-driven + mirror fallback", "覆盖驱动" in changelog or "临期" in changelog)
check("SPEC documents CalendarSync / auto-detect", "CalendarSync" in spec and "自动" in spec)
check("SPEC documents coverage-driven decision", "覆盖驱动" in spec or "临期" in spec)
check("release.yml body targets v0.7.5", "## 🕐 Desk Clock v0.7.5" in rels)
check("release body mentions coverage-driven + fresh built-in", "覆盖驱动" in rels and "内置" in rels)
by = rd(".github/workflows/build.yml")
check("build.yml static checks include calendar-sync.js + .json",
      "node --check ui/calendar-sync.js" in by and "json.load(open('ui/calendar-data.json'))" in by)
check("build.yml compiles verify_calendar_sync.py", "verify_calendar_sync.py" in by)

# ========================================================================
# B. Node 行为测试（加载真实模块，mock 浏览器环境）
# ========================================================================
HARNESS = r'''
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2];
let pass = 0, fail = 0;
function ck(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
// --- mock browser globals ---
const store = {};
global.localStorage = {
  getItem(k){ return Object.prototype.hasOwnProperty.call(store,k) ? store[k] : null; },
  setItem(k,v){ store[k] = String(v); },
  removeItem(k){ delete store[k]; }
};
global.window = { DeskClock: {}, addEventListener(){} };
global.window.DeskClock.Prefs = { isNative: true };
global.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
// 可控 fetch：__FAIL_PRIMARY__ 时主源(raw)失败、备源(jsdelivr)成功；__FAIL_ALL__ 时全失败。
global.fetch = function(url){
  const mirror = url.indexOf('jsdelivr') >= 0;
  if (global.__FAIL_ALL__) return Promise.reject(new Error('all down'));
  if (global.__FAIL_PRIMARY__ && !mirror) return Promise.reject(new Error('primary down'));
  return Promise.resolve({ ok:true, json(){ return Promise.resolve(global.__REMOTE__); } });
};
const realSetTimeout = global.setTimeout;
global.setTimeout = function(fn){ global.__timers = (global.__timers||[]); global.__timers.push(fn); return 0; };
global.clearTimeout = function(){};

function load(rel){ (0, eval)(fs.readFileSync(path.join(ROOT, rel), 'utf-8')); }
load('ui/calendar-data.js');
load('ui/schedule.js');
load('ui/calendar-sync.js');
const S = window.DeskClock.Schedule;
const CS = window.DeskClock.CalendarSync;
const BUILTIN = window.DeskClock.CalendarData;

ck('Schedule loaded with built-in data', !!S && !!S.setData);
ck('CalendarSync loaded', !!CS && typeof CS.start === 'function');
ck('builtin coverage = 2024..2027', JSON.stringify(S.coverage()) === JSON.stringify([2024,2025,2026,2027]), S.coverage());
ck('S.covered(2026) true / S.covered(2035) false', S.covered(2026) && !S.covered(2035));

// ---- 覆盖驱动 8 个日期场景（v0.7.4 核心）----
const D = s => new Date(s + 'T00:00:00');
const COV = [2024,2025,2026,2027];
ck('decide: 覆盖内平日 -> local', CS._decide(D('2026-06-15'), COV) === 'local');
ck('decide: 覆盖末年但通知未发(10月) -> local', CS._decide(D('2027-10-20'), COV) === 'local');
ck('decide: 覆盖末年通知已发但未临期(11月) -> local', CS._decide(D('2027-11-10'), COV) === 'local');
ck('decide: 覆盖末年12月 -> prefetch', CS._decide(D('2027-12-01'), COV) === 'prefetch');
ck('decide: 覆盖末年12月底 -> prefetch', CS._decide(D('2027-12-25'), COV) === 'prefetch');
ck('decide: 跨年且数据未更新 -> expired(自愈)', CS._decide(D('2028-01-01'), COV) === 'expired');
ck('decide: 跨年且已拿到2028 -> local', CS._decide(D('2028-01-01'), [2024,2025,2026,2027,2028]) === 'local');
ck('decide: 次年覆盖内平日 -> local', CS._decide(D('2028-06-01'), [2024,2025,2026,2027,2028]) === 'local');
ck('decide: 无覆盖数据 -> expired', CS._decide(D('2026-03-01'), []) === 'expired');
ck('decide: 当前年不在覆盖内 -> expired (年份空洞自愈)',
   CS._decide(D('2026-06-15'), [2027,2028]) === 'expired');
// 阈值必须晚于 11 月上旬发布日：早触发必然空转
ck('prefetch threshold is December (after Nov notice)', CS._decide(D('2027-06-01'), COV) === 'local');

// ---- validateData 严格性 ----
ck('validateData accepts real data', S.validateData(BUILTIN));
ck('validateData rejects null', !S.validateData(null));
ck('validateData rejects array', !S.validateData([]));
ck('validateData rejects missing years', !S.validateData({schema:1}));
ck('validateData rejects malformed MMdd', !S.validateData({years:{'2028':{h:['13XY'],w:[]}}}));
ck('validateData rejects non-array h', !S.validateData({years:{'2028':{h:'x',w:[]}}}));
ck('validateData rejects empty years', !S.validateData({years:{}}));
ck('validateData rejects absurd year count (>40)',
   !S.validateData({years:Object.fromEntries(Array.from({length:41},(_,i)=>[String(2000+i),{h:[],w:[]}]))}));
// v0.7.5 新增：年份连续性 / MMdd 真实性 / coverage 一致性
ck('validateData rejects year gap',
   !S.validateData({years:{'2024':{h:[],w:[]},'2026':{h:[],w:[]}}}));
ck('validateData rejects impossible MMdd 0230',
   !S.validateData({years:{'2028':{h:['0230'],w:[]}}}));
ck('validateData rejects invalid MMdd 9999',
   !S.validateData({years:{'2028':{h:['9999'],w:[]}}}));
ck('validateData accepts leap day 0229 in leap year',
   S.validateData({years:{'2028':{h:['0229'],w:[]}}}));
ck('validateData rejects 0229 in non-leap year',
   !S.validateData({years:{'2027':{h:['0229'],w:[]}}}));
ck('validateData rejects coverage/years mismatch',
   !S.validateData({years:{'2028':{h:[],w:[]}},coverage:['2024']}));
// v0.7.5 新增：一次性规则不再被归一化成每天
ck('normalizeRule keeps once (no daily fallback)',
   S.normalizeRule({mode:'once'}).mode === 'once');
ck('matches(once) false (handled by repeat:false removal)',
   S.matches({mode:'once'}, new Date()) === false);

// ---- setData: 接受超集 / 拒绝回退 ----
const newer = JSON.parse(JSON.stringify(BUILTIN));
newer.years['2028'] = { h: ['0101','0501','1001'], w: ['0204'] };
newer.coverage = ['2024','2025','2026','2027','2028'];
let r1 = S.setData(newer);
ck('setData accepts superset with 2028', r1.ok === true, r1);
ck('coverage grows to 2028 after setData', JSON.stringify(S.coverage()) === JSON.stringify([2024,2025,2026,2027,2028]), S.coverage());
ck('S.covered(2028) now true', S.covered(2028));
ck('global CalendarData replaced', window.DeskClock.CalendarData === newer);
const d = (y,m,day)=> new Date(y, m-1, day);
ck('trading day excludes declared 2028 holiday (0101)', S.isTradingDay(d(2028,1,1)) === false || d(2028,1,1).getDay()===0 || d(2028,1,1).getDay()===6);
ck('trading day true on an ordinary 2028 weekday (non-holiday)', (function(){
  for (let m=1;m<=12;m++) for (let day=1;day<=28;day++){
    const x=d(2028,m,day), wd=x.getDay();
    if (wd>=1 && wd<=5) {
      const mmdd=('0'+m).slice(-2)+('0'+day).slice(-2);
      if (newer.years['2028'].h.indexOf(mmdd)<0) return S.isTradingDay(x)===true;
    }
  }
  return false;
})());
let r2 = S.setData({ years: { '2028': { h:['0101'], w:[] } } });
ck('setData rejects rollback (drops covered years)', r2.ok === false && r2.reason === 'rollback', r2);
ck('data unchanged after rejected rollback', JSON.stringify(S.coverage()) === JSON.stringify([2024,2025,2026,2027,2028]));
let r3 = S.setData({ bad: true });
ck('setData rejects invalid data', r3.ok === false && r3.reason === 'invalid', r3);

// ---- _applyRemote: 缓存 + emit + status ----
let events = 0;
CS.onChange(()=>{ events++; });
const evenNewer = JSON.parse(JSON.stringify(newer));
evenNewer.years['2029'] = { h:['0101'], w:[] };
evenNewer.coverage = ['2024','2025','2026','2027','2028','2029'];
let ar = CS._applyRemote(evenNewer, 'remote');
ck('_applyRemote accepts valid newer data', ar.ok === true, ar);
ck('_applyRemote extended coverage to 2029', JSON.stringify(S.coverage()).indexOf('2029') >= 0);
ck('_applyRemote wrote cache to localStorage', !!store['deskclock.calendar.data']);
ck('_applyRemote fired onChange', events > 0);
ck('status.source === remote after apply', CS.status().source === 'remote', CS.status().source);
ck('_applyRemote rejects invalid data', CS._applyRemote({nope:1},'remote').ok === false);

// ---- 开关 / 覆盖驱动下不联网 ----
CS.setEnabled(false);
ck('_shouldFetch(false) false when disabled', CS._shouldFetch(false) === false);
ck('_shouldFetch(true) true even when disabled (manual force)', CS._shouldFetch(true) === true);
CS.setEnabled(true);
ck('status.enabled reflects setEnabled(true)', CS.status().enabled === true);
// 当前真实系统日期落在 2024..2029 覆盖内 → 纯本地，不联网
ck('covered today -> shouldFetch false (zero network)', CS._shouldFetch(false) === false,
   { decision: CS.status().decision, coverage: CS.status().coverage });

// ---- 备源容错：主源故障自动切 jsDelivr ----
ck('SOURCES has exactly 2 entries', CS.SOURCES.length === 2);
ck('MIRROR_URL is jsdelivr @main', CS.MIRROR_URL.indexOf('cdn.jsdelivr.net/gh/') >= 0 && CS.MIRROR_URL.indexOf('@main/') >= 0);
ck('primary and mirror are distinct', CS.SOURCES[0] !== CS.SOURCES[1]);
global.__REMOTE__ = evenNewer;
global.__FAIL_PRIMARY__ = true;
CS._fetchWithFallback().then(function(r){
  ck('primary down -> falls back to mirror', r.sourceIndex === 1, r.sourceIndex);
  ck('fallback returns valid data', window.DeskClock.Schedule.validateData(r.data));
  global.__FAIL_PRIMARY__ = false;
  global.__FAIL_ALL__ = true;
  return CS._fetchWithFallback().then(
    function(){ ck('all sources down -> rejects', false, 'should have rejected'); finish(); },
    function(){ ck('all sources down -> rejects (silent fallback upstream)', true); finish(); }
  );
}).catch(function(e){ ck('fallback chain threw unexpectedly', false, String(e)); finish(); });

function finish(){
  // ---- start() 离线优先：应用缓存 ----
  window.DeskClock.CalendarData = BUILTIN;
  load('ui/schedule.js');
  const S2 = window.DeskClock.Schedule;
  ck('fresh engine (reload) starts at builtin coverage', JSON.stringify(S2.coverage()) === JSON.stringify([2024,2025,2026,2027]));
  load('ui/calendar-sync.js');
  const CS2 = window.DeskClock.CalendarSync;
  CS2.start();
  ck('start() applies newer cache (offline-first, no network)', window.DeskClock.Schedule.covered(2029) === true,
     window.DeskClock.Schedule.coverage());
  ck('start() status.source is cache', CS2.status().source === 'cache', CS2.status().source);
  console.log('HARNESS_SUMMARY ' + pass + ' ' + fail);
  process.exit(fail ? 1 : 0);
}
'''

harness_ok = False
try:
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
        tf.write(HARNESS)
        tmp_path = tf.name
    nr = subprocess.run(["node", tmp_path, str(ROOT)], capture_output=True, text=True, timeout=60)
    for line in nr.stdout.strip().splitlines():
        if line.startswith("PASS "):
            results.append((line[5:], True, ""))
        elif line.startswith("FAIL "):
            results.append((line[5:], False, ""))
    print(nr.stdout.strip())
    if nr.stderr.strip():
        print("HARNESS STDERR:", nr.stderr.strip()[:300])
    harness_ok = nr.returncode == 0 and "HARNESS_SUMMARY" in nr.stdout
    check("Node behavioral harness executed all assertions green", harness_ok, nr.returncode)
finally:
    try:
        os.unlink(tmp_path)
    except Exception:
        pass

failed = [r for r in results if not r[1]]
print("\n=== SUMMARY: %d passed, %d failed ===" % (len(results) - len(failed), len(failed)))
if failed:
    for n, _, d in failed:
        print("  FAILED:", n, d)
    raise SystemExit(1)
