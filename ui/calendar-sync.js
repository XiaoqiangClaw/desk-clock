(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  // ==========================================================================
  // DeskClock.CalendarSync — 日历数据运行时静默同步（v0.7.3）
  // --------------------------------------------------------------------------
  // 背景：工作日 / 周末 / 法定节假日 / A股交易日 四种重复规则共用同一份国务院
  // 放假 + 调休数据（ui/calendar-data.js）。这份是政策数据，国务院每年（约 11 月）
  // 发布次年安排后上游 chinese_calendar 才会更新，因此内置表会随时间过期。
  //
  // 本模块让「已安装旧版本」的用户无需重装/升级，也能自动拿到未来年份的正确日历：
  //   1) 启动先应用 localStorage 里上次成功同步的缓存（离线可用）；
  //   2) 按节流静默从本仓库自托管的 calendar-data.json 拉取最新数据；
  //   3) 严格校验（Schedule.validateData）+ 只增不减（Schedule.setData）后热替换；
  //   4) 失败 / 超时 / 离线 / 数据异常一律静默回落到缓存或内置表，绝不打扰用户。
  //
  // 设计约束：零新依赖、零新权限（与 checkUpdate 同为前端直接 fetch）、默认静默、
  // 内置表永远兜底、可通过偏好开关关闭自动联网。
  // ==========================================================================

  // 数据源固定为本仓库 main 分支的静态文件（自托管，非第三方 API，可控可审计）。
  // raw.githubusercontent.com 返回 Access-Control-Allow-Origin: *，与现有检查更新同一通道。
  var RAW_URL = 'https://raw.githubusercontent.com/xiaoqiangclub/desk-clock/main/ui/calendar-data.json';

  var DATA_KEY = 'deskclock.calendar.data';      // 上次成功同步的数据（JSON 字符串）
  var META_KEY = 'deskclock.calendar.meta';      // { lastSync, lastAttempt, source }
  var START_DELAY = 2500;                        // 启动后延迟，绝不阻塞首屏
  var OK_INTERVAL = 24 * 3600 * 1000;            // 成功后 24h 内不重复联网
  var FAIL_INTERVAL = 4 * 3600 * 1000;           // 失败后 4h 内不重试
  var REQUEST_TIMEOUT = 8000;                    // 单次请求超时

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

  function Sched() { return window.DeskClock && window.DeskClock.Schedule; }
  function now() { return Date.now(); }

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
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](status()); } catch (e) {}
    }
  }

  // 核心：校验 + 热替换 + 落缓存。返回 {ok, reason}。抽成独立函数便于回归测试注入 mock 数据。
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

  // 判断是否值得联网：尊重开关 + 节流。
  function shouldFetch(force) {
    if (!state.enabled && !force) return false;
    var meta = readMeta();
    var last = meta.lastAttempt || 0;
    var interval = meta.lastAttemptOk ? OK_INTERVAL : FAIL_INTERVAL;
    if (force) return true;
    return (now() - last) >= interval;
  }

  // 一次同步：静默、绝不抛出。force=true 跳过节流（手动「立即检查」或开关刚打开）。
  function syncNow(force) {
    if (state.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    if (!shouldFetch(force)) return Promise.resolve({ ok: false, reason: 'throttled' });
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

    var bust = RAW_URL + (RAW_URL.indexOf('?') >= 0 ? '&' : '?') + 'v=' + now();
    return fetchJson(bust).then(function (data) {
      var res = applyRemote(data, 'remote');
      var meta = readMeta();
      meta.lastAttemptOk = !!res.ok;
      writeMeta(meta);
      state.busy = false;
      state.lastError = !res.ok;
      emit();
      return res;
    }).catch(function () {
      // 失败无感：保留内置 / 缓存数据，仅做节流登记。
      var meta = readMeta();
      meta.lastAttemptOk = false;
      writeMeta(meta);
      state.busy = false;
      state.lastError = true;
      emit();
      return { ok: false, reason: 'failed' };
    });
  }

  // 启动：先应用缓存（离线即享上次同步成果），再按节流决定是否后台联网。
  function start() {
    if (started) return;
    started = true;
    var S = Sched();
    var meta = readMeta();
    state.lastSync = meta.lastSync || 0;

    var cached = readCache();
    if (cached && S && typeof S.validateData === 'function' && S.validateData(cached)) {
      var res = S.setData(cached);               // 只增不减，缓存比内置旧会被安全拒绝
      if (res.ok) state.source = 'cache';
    }
    emit();

    // 跨窗口：任一窗口同步成功后，其它已打开窗口实时跟上（同源 localStorage）。
    // 浏览器不触发 storage 事件时也无妨——各窗口下次启动会重新应用缓存。
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('storage', function (ev) {
        if (!ev || ev.key !== DATA_KEY || !ev.newValue) return;
        var S = Sched();
        if (!S || typeof S.setData !== 'function') return;
        try {
          var d = JSON.parse(ev.newValue);
          if (S.validateData(d) && S.setData(d).ok) { state.source = 'remote'; state.lastError = false; }
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
    // 仅「由关转开」时立即尝试一次（仍受节流保护）；启动时首次赋值不额外联网，
    // 统一交给 start() 的延迟检查，避免多个窗口冷启动同时打网络。
    if (state.enabled && !was) syncNow(false);
  }
  function status() {
    var S = Sched();
    return {
      enabled: state.enabled,
      coverage: (S && S.coverage) ? S.coverage() : [],
      source: state.source,
      lastSync: state.lastSync,
      busy: state.busy,
      lastError: state.lastError
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
    start: start,
    syncNow: syncNow,
    setEnabled: setEnabled,
    status: status,
    onChange: onChange,
    _applyRemote: applyRemote,        // 供回归测试注入 mock 数据（不依赖真实网络）
    _shouldFetch: shouldFetch
  };
})();
