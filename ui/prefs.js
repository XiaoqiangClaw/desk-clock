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
    x: null,
    y: null
  };

  var STORAGE_KEY = 'deskclock.prefs';
  var isNative = !!window.__TAURI__;
  var SAVE_DEBOUNCE = 200;

  var current = clone(DEFAULTS);
  var saveTimer = null;
  var saveWaiters = [];

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
    ['showSeconds', 'hour12', 'alwaysOnTop', 'autostart'].forEach(function (k) {
      if (obj[k] !== undefined) out[k] = !!obj[k];
    });
    if (isFinite(obj.scale)) out.scale = Math.min(2.5, Math.max(0.5, Number(obj.scale)));
    if (isFinite(obj.opacity)) out.opacity = Math.min(1, Math.max(0.3, Number(obj.opacity)));
    if (isFinite(obj.x)) out.x = Number(obj.x);
    if (isFinite(obj.y)) out.y = Number(obj.y);
    return out;
  }

  function localRead() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function localWrite(prefs) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); }
    catch (e) { /* private mode / quota */ }
  }

  function invoke(command, args) {
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') {
      return Promise.reject(new Error('Tauri core unavailable'));
    }
    return core.invoke(command, args);
  }

  function load() {
    if (!isNative) {
      current = normalize(localRead());
      return Promise.resolve(clone(current));
    }
    return invoke('get_prefs', undefined)
      .then(function (res) {
        var data = (res && typeof res === 'string') ? JSON.parse(res) : res;
        current = normalize(data);
        return clone(current);
      })
      .catch(function () {
        current = normalize(localRead());
        return clone(current);
      });
  }

  function get() { return clone(current); }

  function flush() {
    var snapshot = clone(current);
    var done = function () {
      var i;
      for (i = 0; i < saveWaiters.length; i++) saveWaiters[i]();
      saveWaiters = [];
    };
    localWrite(snapshot);
    if (!isNative) { done(); return Promise.resolve(); }
    // Key MUST be `prefs`: Tauri command args are matched by name.
    return invoke('set_prefs', { prefs: snapshot })
      .then(done, function () { done(); });  // local cache already written
  }

  function save(patch) {
    if (patch && typeof patch === 'object') {
      var k;
      for (k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k];
      }
      current = normalize(current);
    }
    localWrite(current);  // instant local durability, even if debounce is pending
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, SAVE_DEBOUNCE);
    return new Promise(function (resolve) { saveWaiters.push(resolve); });
  }

  // Window operations live in Rust (single coordinate system / correct DPI).
  function setWindowPosition(x, y) {
    if (!isNative) return Promise.resolve(null);
    return invoke('set_window_position', { x: x, y: y }).catch(function () { return null; });
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

  window.DeskClock.Prefs = {
    DEFAULTS: clone(DEFAULTS),
    isNative: isNative,
    load: load,
    get: get,
    save: save,
    setWindowPosition: setWindowPosition,
    getAutostart: getAutostart,
    setAutostart: setAutostart
  };
})();
