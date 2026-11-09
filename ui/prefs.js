(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var DEFAULTS = {
    style: 'flip',
    showSeconds: true,
    hour12: false,
    showSeparator: true,       // v0.4: 数字样式是否显示冒号（隐藏时保留间距）
    alwaysOnTop: false,
    autostart: false,
    backdrop: 'none',
    scale: 1,
    opacity: 1,
    lang: 'zh-CN',
    font: '',
    customFont: '',
    color: '',
    customColor: '#f6f7f9',
    analogTheme: 'dark',       // v0.4: 表盘深色/浅色两套默认
    analogPenetrate: false,    // v0.4: 指针穿透表圈
    clickThrough: false,       // v0.4: 鼠标穿透（点击穿透到下层窗口）
    alarms: [],                // [{time:"HH:MM", repeat:bool, id:string}]
    alarmSound: true,          // v0.4: 闹钟响铃
    timerAction: 'shutdown',   // v0.4: shutdown | reboot
    timerMode: 'duration',     // v0.4: duration | clock
    autoTimeSync: false,       // v0.4: 启动时自动校时
    extraClocks: [],           // v0.4: [{id,label,offset}] 多时区窗口
    runAsAdmin: false,
    x: null,
    y: null
  };

  var HEX = /^#[0-9a-fA-F]{6}$/;
  var FONTS = ['', 'sans', 'serif', 'mono', 'rounded', '__custom__'];
  var COLORS = ['', '__custom__'];
  var STORAGE_KEY = 'deskclock.prefs';
  var isNative = !!window.__TAURI__;
  var SAVE_DEBOUNCE = 200;

  var current = clone(DEFAULTS);
  var saveTimer = null;
  var saveWaiters = [];
  var pendingPatch = {};

  function clone(obj) {
    var out = {}, k;
    for (k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
  }

  // Whitelist + type coercion: a corrupt/old prefs file can never break the UI.
  function normalize(obj) {
    var out = clone(DEFAULTS);
    if (!obj || typeof obj !== 'object') return out;
    if (typeof obj.style === 'string' && obj.style) out.style = obj.style;
    if (typeof obj.backdrop === 'string' && obj.backdrop) out.backdrop = obj.backdrop;
    if (obj.lang === 'en' || obj.lang === 'zh-CN') out.lang = obj.lang;
    ['showSeconds', 'hour12', 'showSeparator', 'alwaysOnTop', 'autostart',
     'analogPenetrate', 'clickThrough', 'alarmSound', 'autoTimeSync', 'runAsAdmin'
    ].forEach(function (k) {
      if (obj[k] !== undefined) out[k] = !!obj[k];
    });
    if (isFinite(obj.scale)) out.scale = Math.min(2.5, Math.max(0.5, Number(obj.scale)));
    if (isFinite(obj.opacity)) out.opacity = Math.min(1, Math.max(0.3, Number(obj.opacity)));
    // NOTE: global isFinite(null) === true. Guard with an explicit typeof check
    // or a fresh install would be persisted as x:0,y:0 and the window would
    // jump to the top-left corner instead of staying centered.
    if (typeof obj.x === 'number' && isFinite(obj.x)) out.x = obj.x;
    if (typeof obj.y === 'number' && isFinite(obj.y)) out.y = obj.y;
    if (FONTS.indexOf(obj.font) >= 0) out.font = obj.font;
    if (typeof obj.customFont === 'string' && obj.customFont.length <= 120) out.customFont = obj.customFont;
    if (typeof obj.color === 'string' && (COLORS.indexOf(obj.color) >= 0 || HEX.test(obj.color))) out.color = obj.color;
    if (typeof obj.customColor === 'string' && HEX.test(obj.customColor)) out.customColor = obj.customColor;
    if (obj.analogTheme === 'dark' || obj.analogTheme === 'light') out.analogTheme = obj.analogTheme;
    if (obj.timerAction === 'shutdown' || obj.timerAction === 'reboot') out.timerAction = obj.timerAction;
    if (obj.timerMode === 'duration' || obj.timerMode === 'clock') out.timerMode = obj.timerMode;
    if (Array.isArray(obj.alarms)) {
      out.alarms = obj.alarms.filter(function (a) {
        return a && typeof a.time === 'string' && /^\d{2}:\d{2}$/.test(a.time);
      }).slice(0, 20).map(function (a) {
        return {
          id: String(a.id || ('a' + Math.random().toString(36).slice(2, 9))),
          time: a.time,
          repeat: !!a.repeat
        };
      });
    }
    if (Array.isArray(obj.extraClocks)) {
      out.extraClocks = obj.extraClocks.filter(function (c) {
        return c && typeof c.label === 'string' && isFinite(c.offset);
      }).slice(0, 8).map(function (c) {
        return {
          id: String(c.id || ('c' + Math.random().toString(36).slice(2, 9))),
          label: c.label.slice(0, 16),
          offset: Math.max(-720, Math.min(840, Math.round(Number(c.offset))))
        };
      });
    }
    return out;
  }

  function invoke(cmd, args) {
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return Promise.reject(new Error('no tauri'));
    return core.invoke(cmd, args === undefined ? {} : args);
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function writeLocal(obj) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
    catch (e) { /* private mode / quota: keep working in memory */ }
  }

  function load() {
    if (!isNative) {
      current = normalize(readLocal());
      return Promise.resolve(clone(current));
    }
    return invoke('get_prefs')
      .then(function (p) { current = normalize(p); return clone(current); })
      .catch(function () { current = normalize(readLocal()); return clone(current); });
  }

  function get() { return clone(current); }

  function merge(patch) {
    var k;
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k];
    }
    current = normalize(current);
  }

  // Field-level patch write. Rust owns the authoritative full object and
  // broadcasts it back, so two windows can never overwrite each other's fields.
  function save(patch) {
    merge(patch);
    var snapshot = clone(current);
    writeLocal(snapshot);
    var k;
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) pendingPatch[k] = snapshot[k];
    }
    if (!isNative) return Promise.resolve(clone(snapshot));
    return new Promise(function (resolve) {
      saveWaiters.push(resolve);
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        var waiters = saveWaiters.slice();
        saveWaiters = [];
        var sent = pendingPatch;
        pendingPatch = {};
        invoke('set_prefs', { patch: sent })
          .then(function () { waiters.forEach(function (fn) { fn(clone(snapshot)); }); })
          .catch(function () { waiters.forEach(function (fn) { fn(clone(snapshot)); }); });
      }, SAVE_DEBOUNCE);
    });
  }

  function setWindowPosition(x, y) {
    if (!isNative) return Promise.resolve(null);
    return invoke('set_window_position', { x: x, y: y })
      .then(function (pos) { return pos || null; })
      .catch(function () { return null; });
  }

  function getAutostart() {
    if (!isNative) return Promise.resolve(false);
    return invoke('get_autostart', undefined)
      .then(function (v) { return !!v; })
      .catch(function () { return false; });
  }

  function setAutostart(enabled) {
    if (!isNative) return Promise.resolve(!!enabled);
    return invoke('set_autostart', { enabled: !!enabled })
      .then(function (res) { return res === undefined || res === null ? !!enabled : !!res; })
      .catch(function () { return !!enabled; });
  }

  // ------------------------------------------------ cross-window sync / extras

  function listen(event, cb) {
    if (!isNative) return function () {};
    try {
      var ev = window.__TAURI__ && window.__TAURI__.event;
      if (!ev || typeof ev.listen !== 'function') return function () {};
      var un = null, cancelled = false;
      ev.listen(event, function (e) { cb(e && e.payload); }).then(function (fn) {
        if (cancelled) { try { fn(); } catch (err) {} } else { un = fn; }
      });
      return function () {
        cancelled = true;
        if (un) { try { un(); } catch (err) {} }
      };
    } catch (e) { return function () {}; }
  }

  // `cb` receives a NORMALIZED full prefs object. Never call save() from it.
  function onChanged(cb) {
    return listen('prefs-changed', function (payload) {
      if (!payload || typeof payload !== 'object') return;
      current = normalize(payload);
      writeLocal(current);
      cb(clone(current));
    });
  }

  function privilegeStatus() {
    if (!isNative) {
      return Promise.resolve({
        platform: 'browser', isElevated: false, canElevate: false,
        runAsAdmin: false, note: '浏览器预览模式：无系统权限，仅用于查看界面。'
      });
    }
    return invoke('get_privilege_status').catch(function () {
      return { platform: 'unknown', isElevated: false, canElevate: false,
        runAsAdmin: false, note: '无法读取权限状态。' };
    });
  }

  function privilegeStatusFallback() {
    return { platform: 'browser', isElevated: false, canElevate: false,
      runAsAdmin: false, note: '浏览器预览模式：无系统权限，仅用于查看界面。' };
  }

  function setRunAsAdmin(enabled) {
    if (!isNative) return Promise.resolve(privilegeStatusFallback());
    return invoke('set_run_as_admin', { enabled: !!enabled });
  }

  function restartElevated() {
    if (!isNative) return Promise.reject(new Error('浏览器模式不支持提权'));
    return invoke('restart_elevated');
  }

  function openSettings() {
    if (!isNative) return Promise.resolve();
    return invoke('open_settings');
  }

  function closeSettings() {
    if (!isNative) return Promise.resolve();
    return invoke('close_settings');
  }

  function quitApp() {
    if (!isNative) return Promise.resolve();
    return invoke('quit_app');
  }

  // v0.4 new native commands
  function presetPosition(pos) { return invoke('preset_position', { pos: pos }); }
  function setClickThrough(enabled) { return invoke('set_click_through', { enabled: !!enabled }); }
  function syncSystemTime() { return invoke('sync_system_time'); }
  // 外链：前端只传标识符，Rust 解析真实地址（不接受任意 URL）。
  function openUrl(kind) { return invoke('open_link', { kind: kind }); }
  // 更新检查：GitHub REST API 允许跨域，前端直接 fetch；Rust 不引入 TLS 依赖。
  function checkUpdate() {
    try {
      return fetch('https://api.github.com/repos/xiaoqiangclub/desk-clock/releases/latest',
        { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'DeskClock' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { return { latest: d && d.tag_name ? String(d.tag_name) : '' }; });
    } catch (e) { return Promise.reject(e); }
  }
  function addClockWindow(id, label, offset) { return invoke('add_clock_window', { id: id, label: label, offset: offset }); }
  function closeClockWindow(id) { return invoke('close_clock_window', { id: id }); }
  function listClockWindows() { return invoke('list_clock_windows'); }

  window.DeskClock.Prefs = {
    DEFAULTS: clone(DEFAULTS),
    isNative: isNative,
    normalize: normalize,
    load: load,
    get: get,
    save: save,
    resetDefaults: function () { return save(clone(DEFAULTS)); },
    setWindowPosition: setWindowPosition,
    getAutostart: getAutostart,
    setAutostart: setAutostart,
    onChanged: onChanged,
    listen: listen,
    privilegeStatus: privilegeStatus,
    setRunAsAdmin: setRunAsAdmin,
    restartElevated: restartElevated,
    openSettings: openSettings,
    closeSettings: closeSettings,
    quitApp: quitApp,
    presetPosition: presetPosition,
    setClickThrough: setClickThrough,
    syncSystemTime: syncSystemTime,
    checkUpdate: checkUpdate,
    openUrl: openUrl,
    addClockWindow: addClockWindow,
    closeClockWindow: closeClockWindow,
    listClockWindows: listClockWindows
  };
})();
