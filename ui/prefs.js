(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var DEFAULTS = {
    style: 'flip',
    showSeconds: true,
    hour12: false,
    alwaysOnTop: false,
    autostart: false,
    backdrop: 'none',
    scale: 1,
    opacity: 1,
    lang: 'zh-CN',
    font: '',                 // '' = the style's own recommended font
    customFont: '',
    color: '',                // '' = the style's own recommended colour
    customColor: '#f6f7f9',
    alarms: [],               // [{time:"HH:MM", repeat:bool, id:string}]
    runAsAdmin: false,        // Windows: always elevate on future launches
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
    ['showSeconds', 'hour12', 'alwaysOnTop', 'autostart', 'runAsAdmin'].forEach(function (k) {
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
    if (typeof obj.customFont === 'string' && obj.customFont.length <= 120) {
      out.customFont = obj.customFont;
    }
    if (typeof obj.color === 'string' && (COLORS.indexOf(obj.color) >= 0 || HEX.test(obj.color))) {
      out.color = obj.color;
    }
    if (typeof obj.customColor === 'string' && HEX.test(obj.customColor)) {
      out.customColor = obj.customColor;
    }
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
  // broadcasts it back, so two windows can never overwrite each other's fields
  // (e.g. settings changes `style` while the clock saves a moved `x`).
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

  function setRunAsAdmin(enabled) {
    if (!isNative) return Promise.resolve(privilegeStatusFallback());
    return invoke('set_run_as_admin', { enabled: !!enabled });
  }

  function privilegeStatusFallback() {
    return { platform: 'browser', isElevated: false, canElevate: false,
      runAsAdmin: false, note: '浏览器预览模式：无系统权限，仅用于查看界面。' };
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
    quitApp: quitApp
  };
})();
