(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  // ==========================================================================
  // DeskClock.CalendarSync — 日历数据运行时静默同步（v0.7.4 覆盖驱动）
  // --------------------------------------------------------------------------
  // 背景：工作日 / 周末 / 法定节假日 / A股交易日 四种重复规则共用同一份国务院
  // 放假 + 调休数据（ui/calendar-data.js）。数据按「年」整块覆盖，国务院每年
  // 11 月上旬发布次年安排后上游 chinese_calendar 才会更新。
  //
  // v0.7.4 改为「覆盖驱动」而非 v0.7.3 的「按时间盲轮询」：
  //   · 当前年份落在覆盖范围内 → 纯本地，完全不联网（一年只真正需要更新一次）
  //   · 覆盖末年的 12 月起       → 预取次年（此时国务院通知已发布，一定拿得到）
  //   · 跨年 / 内置表已过期      → 立即拉取，自愈（哪怕整个 12 月没开机）
  //   · 缓存丢失/损坏            → 内置表兜底 + 尝试恢复此前同步到的未来年份
  //   · 数据源 主→备 自动切换    → 双源都失败才静默回落，功能永不中断
  //
  // 设计约束：零新依赖、零新权限、默认静默、内置表永远兜底、可开关。
  // 另：每个版本发布时 release.yml 会把「当前最新」的数据重新生成并直接打进安装包。
  // ==========================================================================

  // 主源：本仓库 main 分支自托管静态文件（非第三方 API，可控可审计，CORS *）。
  var RAW_URL = 'https://raw.githubusercontent.com/xiaoqiangclub/desk-clock/main/ui/calendar-data.json';
  // 备源：由主 URL 派生的 jsDelivr CDN 镜像（同一仓库同一文件，实测 HTTP 200 + CORS *）。
  // 派生而非硬编码，避免维护两份地址、也保证两源永远指向同一份数据。
  var MIRROR_URL = RAW_URL
    .replace('https://raw.githubusercontent.com/', 'https://cdn.jsdelivr.net/gh/')
    .replace('/main/', '@main/');
  var SOURCES = [RAW_URL, MIRROR_URL];

  var DATA_KEY = 'deskclock.calendar.data';      // 上次成功同步的数据（JSON 字符串）
  var META_KEY = 'deskclock.calendar.meta';      // { lastSync, lastAttempt, lastAttemptOk, source }
  var START_DELAY = 2500;                        // 启动后延迟，绝不阻塞首屏
  var PREFETCH_OK_INTERVAL = 24 * 3600 * 1000;   // 临期预取成功后 24h 内不重复联网
  var FAIL_INTERVAL = 4 * 3600 * 1000;           // 失败后 4h 内不重试（避免刷屏）
  var REQUEST_TIMEOUT = 8000;                    // 单源单次请求超时
  var PREFETCH_MONTH = 11;                       // 0-based：11 = 12 月起开始预取次年

  var listeners = [];
  var state = {
    enabled: true,
    source: 'builtin',   // builtin | cache | remote
    lastSync: 0,
    busy: false,
    lastError: false
  };
  var started = false;
  var startTimer = null;
  var cacheRecoveryPending = false;             // 缓存丢失 → 允许一次联网恢复

  function Sched() { return window.DeskClock && window.DeskClock.Schedule; }
  function now() { return Date.now(); }
  function currentCoverage() {
    var S = Sched();
    return (S && S.coverage) ? S.coverage() : [];
  }

  function readMeta() {
    try {
      var m = JSON.parse(localStorage.getItem(META_KEY) || '{}');
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return {}; }
  }
  function writeMeta(m) {
    try { localStorage.setItem(META_KEY, JSON.stringify(m || {})); } catch (e) {}
  }
  function readCache() {
    try {
      var s = localStorage.getItem(DATA_KEY);
      if (!s) return null;
      return JSON.parse(s);
    } catch (e) { return null; }
  }
  function writeCache(data) {
    try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function emit() {
    for (var j = 0; j < listeners.length; j++) {
      try { listeners[j](status()); } catch (e) {}
    }
  }

  // ---- 覆盖驱动的核心判定（纯函数，便于回归测试注入任意日期/覆盖）----
  // 返回 'local'（数据够用，纯本地）| 'prefetch'（临期预取）| 'expired'（已过期，立即拉）
  function decide(today, coverage) {
    var y = today.getFullYear();
    var maxY = (coverage && coverage.length) ? coverage[coverage.length - 1] : (y - 1);
    // v0.7.5: 当前年份必须在覆盖集合里。旧实现只看最大覆盖年，遇到年份
    // 空洞（或只有更晚的末年）会误判为「覆盖内零联网」，节假日规则退化。
    if (!coverage || coverage.indexOf(y) < 0) return 'expired';
    if (y > maxY) return 'expired';                                  // 跨年，内置表已过期 → 自愈
    if (y === maxY && today.getMonth() >= PREFETCH_MONTH) return 'prefetch'; // 12 月起预取次年
    return 'local';                                                 // 覆盖内且未临期 → 零联网
  }

  // 是否值得联网：开关 + 覆盖驱动判定 + 轻量节流（仅约束「预取/恢复/失败」，不约束「已过期」）。
  function shouldFetch(force) {
    if (!state.enabled && !force) return false;
    if (force) return true;
    var d = decide(new Date(), currentCoverage());
    if (d === 'local' && !cacheRecoveryPending) return false;
    var meta = readMeta(), last = meta.lastAttempt || 0;
    if (d === 'expired') {
      // 已过期是硬需求：只有「上次失败且距今 < 4h」才退避，否则每次启动都尝试，直到成功。
      if (!meta.lastAttemptOk && (now() - last) < FAIL_INTERVAL) return false;
      return true;
    }
    // prefetch / cache-recovery：成功 24h、失败 4h 节流，避免临期月每天开机都拉。
    var interval = meta.lastAttemptOk ? PREFETCH_OK_INTERVAL : FAIL_INTERVAL;
    return (now() - last) >= interval;
  }

  // 核心：校验 + 热替换 + 落缓存。返回 {ok, reason}。独立函数便于回归测试注入 mock 数据。
  function applyRemote(data, source) {
    var S = Sched();
    if (!S || typeof S.setData !== 'function') return { ok: false, reason: 'no-schedule' };
    var res = S.setData(data);
    if (!res.ok) return res;
    writeCache(data);
    var meta = readMeta();
    meta.lastSync = now();
    meta.source = source;
    writeMeta(meta);
    state.source = source;
    state.lastSync = meta.lastSync;
    state.lastError = false;
    cacheRecoveryPending = false;
    emit();
    return { ok: true, coverage: res.coverage };
  }

  // 带超时的 fetch（AbortController 优先，旧 WebView 退化到 Promise.race）。
  function fetchJson(url) {
    var ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    var p = fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: ac ? ac.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ac) { try { ac.abort(); } catch (e) {} }
        reject(new Error('timeout'));
      }, REQUEST_TIMEOUT);
    });
    return Promise.race([p, timeout]).then(function (v) {
      if (timer) clearTimeout(timer);
      return v;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  // 主源失败自动切备源；任一源成功即返回 {data, sourceIndex}；全失败才抛出。
  function fetchWithFallback() {
    var idx = 0;
    function attempt() {
      if (idx >= SOURCES.length) return Promise.reject(new Error('all-sources-failed'));
      var i = idx++;
      var bust = SOURCES[i] + (SOURCES[i].indexOf('?') >= 0 ? '&' : '?') + 'v=' + now();
      return fetchJson(bust).then(function (data) {
        return { data: data, sourceIndex: i };
      }, function () {
        return attempt();   // 该源失败 → 下一个源
      });
    }
    return attempt();
  }

  // 一次同步：静默、绝不抛出。force=true 跳过所有判定（手动「立即检查」）。
  function syncNow(force) {
    if (state.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    if (!shouldFetch(force)) return Promise.resolve({ ok: false, reason: 'local' });
    state.busy = true;
    state.lastError = false;
    emit();
    var meta0 = readMeta();
    meta0.lastAttempt = now();
    writeMeta(meta0);

    // 浏览器预览 / 回归环境不自动打外网（手动 force 仍允许，便于验证）。
    var isNative = !!(window.DeskClock && window.DeskClock.Prefs && window.DeskClock.Prefs.isNative);
    if (!isNative && !force) {
      state.busy = false;
      emit();
      return Promise.resolve({ ok: false, reason: 'preview' });
    }

    return fetchWithFallback().then(function (r) {
      var res = applyRemote(r.data, 'remote');
      var meta = readMeta();
      meta.lastAttemptOk = !!res.ok;
      if (res.ok) meta.usedSourceIndex = r.sourceIndex;
      writeMeta(meta);
      state.busy = false;
      state.lastError = !res.ok;
      emit();
      return res;
    }).catch(function () {
      // 双源都失败：无感，保留内置/缓存数据，仅登记节流。
      var meta = readMeta();
      meta.lastAttemptOk = false;
      writeMeta(meta);
      state.busy = false;
      state.lastError = true;
      emit();
      return { ok: false, reason: 'failed' };
    });
  }

  // 启动：先应用缓存（离线即享上次同步成果），再按「覆盖驱动」决定是否后台联网。
  function start() {
    if (started) return;
    started = true;
    var S = Sched();
    var meta = readMeta();
    state.lastSync = meta.lastSync || 0;

    var cached = readCache();
    var cacheOk = !!(cached && S && typeof S.validateData === 'function' && S.validateData(cached));
    if (cacheOk) {
      var res = S.setData(cached);               // 只增不减，缓存比内置旧会被安全拒绝
      if (res.ok) state.source = 'cache';
    } else {
      // 缓存丢失/损坏：内置表兜底（Schedule 默认已加载），并允许一次联网恢复未来年份。
      cacheRecoveryPending = true;
    }
    emit();

    // 跨窗口：任一窗口同步成功后，其它已打开窗口实时跟上（同源 localStorage）。
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('storage', function (ev) {
        if (!ev || ev.key !== DATA_KEY || !ev.newValue) return;
        var S2 = Sched();
        if (!S2 || typeof S2.setData !== 'function') return;
        try {
          var d = JSON.parse(ev.newValue);
          if (S2.validateData(d) && S2.setData(d).ok) { state.source = 'remote'; state.lastError = false; }
        } catch (e) {}
        emit();
      });
    }

    if (startTimer) clearTimeout(startTimer);
    startTimer = setTimeout(function () { syncNow(false); }, START_DELAY);
  }

  function setEnabled(v) {
    var was = state.enabled;
    state.enabled = !!v;
    emit();
    // 仅「由关转开」时立即尝试一次（仍受覆盖驱动判定保护）；启动首次赋值不额外联网。
    if (state.enabled && !was) syncNow(false);
  }
  function status() {
    return {
      enabled: state.enabled,
      coverage: currentCoverage(),
      source: state.source,
      lastSync: state.lastSync,
      busy: state.busy,
      lastError: state.lastError,
      decision: decide(new Date(), currentCoverage())
    };
  }
  function onChange(cb) {
    if (typeof cb === 'function') listeners.push(cb);
    return function () {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  window.DeskClock.CalendarSync = {
    RAW_URL: RAW_URL,
    MIRROR_URL: MIRROR_URL,
    SOURCES: SOURCES,
    start: start,
    syncNow: syncNow,
    setEnabled: setEnabled,
    status: status,
    onChange: onChange,
    _applyRemote: applyRemote,        // 回归测试：注入 mock 数据
    _shouldFetch: shouldFetch,        // 回归测试：节流/开关判定
    _decide: decide,                  // 回归测试：覆盖驱动日期场景
    _fetchWithFallback: fetchWithFallback
  };
})();
