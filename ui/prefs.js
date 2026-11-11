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
    alarmTone: 'gentle',       // v0.5: gentle|bell|tick|rise|chord|custom
    alarmRingSeconds: 30,      // v0.6.2: 闹钟响铃时长（秒），到点自动停
    timerAction: 'shutdown',   // v0.4: shutdown | reboot
    timerMode: 'duration',     // v0.4: duration | clock
    timerWarnMode: 'popup',    // v0.6.2: popup | silent（定时动作前是否弹窗）
    timerWarnSeconds: 30,      // v0.6.2: 提前多少秒弹窗提醒
    autoTimeSync: false,       // v0.4: 启动时自动校时
    extraClocks: [],           // v0.5: [{id,label,offset,style,showSeconds,visible}] 窗口管理器
    tzOffset: null,            // v0.6: 每窗口时区偏移（分钟，null=本机时间）
    tzLabel: '',               // v0.6: 每窗口时区显示名
    // v0.7（未发布）：语音播报（默认关闭）
    announceEnabled: false,
    announceRule: 'hourly',
    announceInterval: 30,
    announceTimes: [],
    announceVoice: '',
    announceRate: 1,
    announceVolume: 1,
    announceChime: 'gentle',
    announceQuiet: false,
    announceQuietStart: '22:00',
    announceQuietEnd: '07:00',
    announceIncludeDate: false,
    announceLang: '',
    // v0.7.3：日历数据自动同步（默认开启；关闭后仅用内置/缓存数据，绝不联网）
    calendarAutoSync: true,
    runAsAdmin: false,
    x: null,
    y: null
  };

  var HEX = /^#[0-9a-fA-F]{6}$/;
  var FONTS = ['', 'sans', 'serif', 'mono', 'rounded', '__custom__'];
  var COLORS = ['', '__custom__'];
  var TONES = ['gentle', 'bell', 'tick', 'rise', 'chord', 'custom'];
  var CLOCK_STYLES = ['flip', 'minimal', 'neon', 'eink', 'segment', 'typewriter', 'glass', 'analog'];
  var STORAGE_KEY = 'deskclock.prefs';
  var CLOCKS_KEY = 'deskclock.clocks';
  var isNative = !!window.__TAURI__;
  var SAVE_DEBOUNCE = 200;

  // v0.6：窗口 id。时钟窗口用注入值，主窗口无注入→回退 'main'；
  // 设置窗口用 __DC_SETTINGS__ 标记，只操作当前 targetId。
  var selfId = window.__DC_CLOCK_ID__ || 'main';
  var isSettingsWindow = !!window.__DC_SETTINGS__ || window.__DC_VIEW__ === 'settings';
  var targetId = selfId;
  var supportsWindowApi = false;   // v0.6：后端是否提供每窗口配置 API

  // 全局项（所有窗口共享）vs 每窗口项。save() 按此分流。
  var GLOBAL_KEYS = ['lang', 'alarms', 'alarmSound', 'alarmTone', 'alarmRingSeconds',
    'timerAction', 'timerMode', 'timerWarnMode', 'timerWarnSeconds',
    'autoTimeSync', 'autostart', 'runAsAdmin', 'extraClocks',
    // v0.7（未发布）：语音播报全局项
    'announceEnabled', 'announceRule', 'announceInterval', 'announceTimes',
    'announceVoice', 'announceRate', 'announceVolume', 'announceChime',
    'announceQuiet', 'announceQuietStart', 'announceQuietEnd',
    'announceIncludeDate', 'announceLang',
    // v0.7.3：日历数据自动同步开关（默认开启，用户可关）
    'calendarAutoSync'];
  var WINDOW_KEYS = ['style', 'showSeconds', 'hour12', 'showSeparator', 'alwaysOnTop',
    'backdrop', 'scale', 'opacity', 'font', 'customFont', 'color', 'customColor',
    'analogTheme', 'analogPenetrate', 'clickThrough', 'tzOffset', 'tzLabel', 'x', 'y'];

  var current = clone(DEFAULTS);
  var saveTimer = null;
  var saveWaiters = [];
  var pendingPatch = {};
  var pendingGlobal = {};
  var pendingWin = {};

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
     'analogPenetrate', 'clickThrough', 'alarmSound', 'autoTimeSync', 'runAsAdmin',
     // v0.7（未发布）：语音播报开关类
     'announceEnabled', 'announceQuiet', 'announceIncludeDate',
     // v0.7.3：日历自动同步开关
     'calendarAutoSync'
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
    // v0.6：每窗口时区（null 表示本机时间）
    if (obj.tzOffset === null) out.tzOffset = null;
    else if (typeof obj.tzOffset === 'number' && isFinite(obj.tzOffset)) {
      out.tzOffset = Math.max(-840, Math.min(840, Math.round(obj.tzOffset)));
    }
    if (typeof obj.tzLabel === 'string') out.tzLabel = obj.tzLabel.slice(0, 24);
    if (FONTS.indexOf(obj.font) >= 0) out.font = obj.font;
    if (typeof obj.customFont === 'string' && obj.customFont.length <= 120) out.customFont = obj.customFont;
    if (typeof obj.color === 'string' && (COLORS.indexOf(obj.color) >= 0 || HEX.test(obj.color))) out.color = obj.color;
    if (typeof obj.customColor === 'string' && HEX.test(obj.customColor)) out.customColor = obj.customColor;
    if (obj.analogTheme === 'dark' || obj.analogTheme === 'light') out.analogTheme = obj.analogTheme;
    if (obj.timerAction === 'shutdown' || obj.timerAction === 'reboot') out.timerAction = obj.timerAction;
    if (obj.timerMode === 'duration' || obj.timerMode === 'clock') out.timerMode = obj.timerMode;
    if (isFinite(obj.alarmRingSeconds)) out.alarmRingSeconds = Math.min(600, Math.max(5, Math.round(Number(obj.alarmRingSeconds))));
    if (isFinite(obj.timerWarnSeconds)) out.timerWarnSeconds = Math.min(300, Math.max(5, Math.round(Number(obj.timerWarnSeconds))));
    if (obj.timerWarnMode === 'popup' || obj.timerWarnMode === 'silent') out.timerWarnMode = obj.timerWarnMode;
    if (TONES.indexOf(obj.alarmTone) >= 0) out.alarmTone = obj.alarmTone;
    if (Array.isArray(obj.alarms)) {
      out.alarms = obj.alarms.filter(function (a) {
        return a && typeof a.time === 'string' && /^[0-9]{2}:[0-9]{2}$/.test(a.time);
      }).slice(0, 20).map(function (a) {
        var rule = (window.DeskClock && window.DeskClock.Schedule)
          ? window.DeskClock.Schedule.fromLegacy(a.repeat, a.rule)
          : { mode: a.repeat === false ? 'once' : 'daily' };
        return {
          id: String(a.id || ('a' + Math.random().toString(36).slice(2, 9))),
          time: a.time,
          repeat: !!a.repeat,
          rule: rule
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
          offset: Math.max(-840, Math.min(840, Math.round(Number(c.offset)))),
          // v0.5 管理器：每窗口独立样式/秒显示/可见性（空样式=跟随全局）
          style: (typeof c.style === 'string' && CLOCK_STYLES.indexOf(c.style) >= 0) ? c.style : '',
          showSeconds: c.showSeconds === undefined ? true : !!c.showSeconds,
          visible: c.visible === undefined ? true : !!c.visible
        };
      });
    }
    // v0.7（未发布）：语音播报字段白名单 + 类型钳制
    if (['hourly', 'half', 'quarter', 'interval', 'custom'].indexOf(obj.announceRule) >= 0) out.announceRule = obj.announceRule;
    if (typeof obj.announceVoice === 'string') out.announceVoice = obj.announceVoice.slice(0, 256);
    if (['zh-CN', 'en', ''].indexOf(obj.announceLang) >= 0) out.announceLang = obj.announceLang;
    if (['none', 'gentle', 'bell', 'tick', 'rise', 'chord'].indexOf(obj.announceChime) >= 0) out.announceChime = obj.announceChime;
    if (typeof obj.announceRate === 'number' && isFinite(obj.announceRate)) out.announceRate = Math.min(2, Math.max(0.5, obj.announceRate));
    if (typeof obj.announceVolume === 'number' && isFinite(obj.announceVolume)) out.announceVolume = Math.min(1, Math.max(0, obj.announceVolume));
    if (typeof obj.announceInterval === 'number' && isFinite(obj.announceInterval)) out.announceInterval = Math.min(120, Math.max(5, Math.round(obj.announceInterval)));
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(obj.announceQuietStart || '')) out.announceQuietStart = obj.announceQuietStart;
    else if (obj.announceQuietStart) out.announceQuietStart = DEFAULTS.announceQuietStart;
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(obj.announceQuietEnd || '')) out.announceQuietEnd = obj.announceQuietEnd;
    else if (obj.announceQuietEnd) out.announceQuietEnd = DEFAULTS.announceQuietEnd;
    if (Array.isArray(obj.announceTimes)) {
      out.announceTimes = obj.announceTimes
        .filter(function (t) { return t && typeof t.time === 'string' && /^\d{2}:\d{2}$/.test(t.time); })
        .slice(0, 20)
        .map(function (t) { return { id: String(t.id || ('an' + Math.random().toString(36).slice(2, 9))), time: t.time }; });
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

  // ---------- 浏览器预览的本地窗口配置（与 Rust clocks.json 同形） ----------
  function readLocalClocks() {
    try {
      var v = JSON.parse(localStorage.getItem(CLOCKS_KEY) || 'null');
      if (v && v.clocks && typeof v.clocks === 'object') return v;
    } catch (e) {}
    var c = {}; c.main = windowDefaults();
    return { activeId: 'main', clocks: c };
  }
  function writeLocalClocks(v) {
    try { localStorage.setItem(CLOCKS_KEY, JSON.stringify(v)); } catch (e) {}
  }
  function windowDefaults() {
    var out = {}, i;
    for (i = 0; i < WINDOW_KEYS.length; i++) {
      var k = WINDOW_KEYS[i];
      if (k === 'tzOffset' || k === 'x' || k === 'y') out[k] = null;
      else out[k] = DEFAULTS[k];   // 原始值直接取；clone() 只适用于对象
    }
    return out;
  }
  function localWindowPrefs(id) {
    var all = readLocalClocks();
    if (!all.clocks[id]) { all.clocks[id] = all.clocks.main ? clone(all.clocks.main) : windowDefaults(); writeLocalClocks(all); }
    return all.clocks[id];
  }

  // 把窗口配置 + 全局配置合并成一个扁平对象供现有控件使用。
  // 浏览器预览/回归里 localStorage(prefs) 是唯一权威（脚本会直接 setItem），
  // 故这里让 g 的窗口字段覆盖 w；原生由 Rust clocks.json 提供权威值。
  // 且 g 未显式提供的窗口项一律走默认值，避免上一轮 clocks 残留污染。
  function hydrate(globalObj, winObj) {
    var merged = normalize(globalObj), k;
    for (k in winObj) if (Object.prototype.hasOwnProperty.call(winObj, k)) merged[k] = winObj[k];
    if (!isNative) {
      // 浏览器预览/回归里 localStorage(prefs) 是权威：g 里显式写的窗口项覆盖 w；
      // g 未写的窗口项保留 w（clocks.json 模拟）的值，避免冲掉真实窗口配置。
      for (k = 0; k < WINDOW_KEYS.length; k++) {
        var key = WINDOW_KEYS[k];
        if (globalObj && Object.prototype.hasOwnProperty.call(globalObj, key)) merged[key] = globalObj[key];
      }
    }
    return merged;
  }

  function load() {
    if (!isNative) {
      var g = readLocal();
      var hasClocks = false;
      try { hasClocks = !!localStorage.getItem(CLOCKS_KEY); } catch (e) {}
      var w;
      if (!hasClocks) {
        // 首次 / 回归脚本直接写 localStorage 的场景：把 g 里的窗口字段作为 main 初值
        w = windowDefaults();
        for (var kk = 0; kk < WINDOW_KEYS.length; kk++) {
          var key = WINDOW_KEYS[kk];
          if (Object.prototype.hasOwnProperty.call(g, key)) w[key] = g[key];
        }
        var initAll = { activeId: 'main', clocks: { main: w } };
        writeLocalClocks(initAll);
      } else {
        w = localWindowPrefs(isSettingsWindow ? (readLocalClocks().activeId || 'main') : selfId);
      }
      if (isSettingsWindow) targetId = readLocalClocks().activeId || 'main';
      current = hydrate(g, w);
      return Promise.resolve(clone(current));
    }
    // 全局 + 指定窗口配置并行读取。
    // 兼容旧后端/shim：若 get_window_configs 不可用（返回空），
    // 直接把 get_prefs 的完整对象当本窗口配置（单份 prefs 行为）。
    return Promise.all([
      invoke('get_prefs'),
      invoke('get_window_configs').catch(function () { return null; }),
      isSettingsWindow
        ? invoke('get_window_configs').catch(function () { return null; })
        : invoke('get_window_prefs', { id: selfId }).catch(function () { return null; })
    ]).then(function (res) {
      var g = res[0] || {}, all = res[1];
      var legacyMode = !all || !all.clocks;
      supportsWindowApi = !legacyMode;
      if (isSettingsWindow) {
        targetId = (all && all.activeId) || 'main';
        var w = (all && all.clocks && all.clocks[targetId]) || windowDefaults();
        current = legacyMode ? normalize(g) : hydrate(g, w);
      } else {
        var wp = legacyMode ? g : (res[2] || windowDefaults());
        current = legacyMode ? normalize(g) : hydrate(g, wp);
      }
      writeLocal(g);
      return clone(current);
    }).catch(function () {
      current = normalize(readLocal());
      return clone(current);
    });
  }

  function get() { return clone(current); }
  function getTargetId() { return targetId; }
  function getSelfId() { return selfId; }
  function isSettingsView() { return isSettingsWindow; }

  // 切换设置窗口的编辑目标，并重读该窗口配置。
  function setActiveClock(id) {
    targetId = id;
    if (!isNative) {
      var all = readLocalClocks(); all.activeId = id; writeLocalClocks(all);
      return load();
    }
    return invoke('set_active_clock', { id: id }).then(function () { return load(); });
  }

  function merge(patch) {
    var k;
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) current[k] = patch[k];
    }
    current = normalize(current);
  }

  // v0.6：字段级 patch 按 GLOBAL/WINDOW 分流，并合并高频写入（滑块拖动）。
  // 全局项写根 prefs（所有窗口共享）；窗口项只写目标窗口配置。
  function save(patch) {
    merge(patch);
    var snapshot = clone(current);
    var k;
    for (k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      if (WINDOW_KEYS.indexOf(k) >= 0) pendingWin[k] = snapshot[k];
      else pendingGlobal[k] = snapshot[k];
    }
    if (!isNative) {
      if (Object.keys(pendingGlobal).length) { writeLocal(mergeLocal(pendingGlobal)); pendingGlobal = {}; }
      if (Object.keys(pendingWin).length) {
        // 浏览器预览/回归：窗口项也镜像回 prefs key，保持旧断言与行为一致。
        writeLocal(mergeLocal(pendingWin));
        var all = readLocalClocks();
        var cur = all.clocks[targetId] || windowDefaults();
        for (var w in pendingWin) cur[w] = pendingWin[w];
        all.clocks[targetId] = cur; all.activeId = targetId;
        writeLocalClocks(all); pendingWin = {};
      }
      return Promise.resolve(clone(snapshot));
    }
    // 立即镜像到 localStorage（供回归/降级读取）；真正的 IPC 仍合并节流。
    // v0.6：真后端（supportsWindowApi）下窗口项绝不写 root prefs，避免污染全局；
    // 旧后端/shim 下才把窗口项一并镜像，保持旧断言兼容。
    var mirror = {};
    for (var mg in pendingGlobal) mirror[mg] = pendingGlobal[mg];
    if (!supportsWindowApi) {
      for (var mw in pendingWin) mirror[mw] = pendingWin[mw];
    } else if (Object.keys(pendingWin).length) {
      try {
        var mwAll = readLocalClocks();
        var mwCur = mwAll.clocks[targetId] || windowDefaults();
        for (var mw2 in pendingWin) mwCur[mw2] = pendingWin[mw2];
        mwAll.clocks[targetId] = mwCur;
        writeLocalClocks(mwAll);
      } catch (e) {}
    }
    if (Object.keys(mirror).length) writeLocal(mergeLocal(mirror));
    return new Promise(function (resolve) {
      saveWaiters.push(resolve);
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        var waiters = saveWaiters.slice(); saveWaiters = [];
        var gp = pendingGlobal, wp = pendingWin;
        pendingGlobal = {}; pendingWin = {};
        var jobs = [];
        var merged = {};
        for (var kg in gp) merged[kg] = gp[kg];
        if (!supportsWindowApi) {
          // 旧后端 / 测试 shim：窗口项并入根 prefs，保证读写一致
          for (var kw in wp) merged[kw] = wp[kw];
          if (Object.keys(merged).length) jobs.push(invoke('set_prefs', { patch: merged }));
        } else {
          if (Object.keys(gp).length) jobs.push(invoke('set_prefs', { patch: gp }));
          if (Object.keys(wp).length) {
            jobs.push(invoke('set_window_prefs', { id: targetId, patch: wp })
              .catch(function () { return invoke('set_prefs', { patch: wp }); }));
          }
        }
        if (!jobs.length) { waiters.forEach(function (fn) { fn(clone(snapshot)); }); return; }
        Promise.all(jobs.map(function (p) { return p.catch(function () {}); }))
          .then(function () { waiters.forEach(function (fn) { fn(clone(snapshot)); }); });
      }, SAVE_DEBOUNCE);
    });
  }

  function mergeLocal(patch) {
    var cur = readLocal(), k;
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
    return cur;
  }

  function setWindowPosition(x, y) {
    // v0.6：作用于当前目标窗口（设置窗口选谁改谁，时钟窗口改自己）
    if (!isNative) return Promise.resolve(null);
    return invoke('set_window_geometry', { id: targetId, x: x, y: y })
      .then(function () { return { x: x, y: y }; })
      .catch(function () { return null; });
  }

  function setWindowGeometry(id, x, y, scale, size) {
    if (!isNative) return Promise.resolve(null);
    // v0.6.2：size = {w,h} 为 #app 内容尺寸（逻辑像素）；缺省时 Rust 用已存尺寸。
    return invoke('set_window_geometry', {
      id: id, x: x, y: y, scale: scale,
      w: size ? size.w : null, h: size ? size.h : null
    }).catch(function () { return null; });
  }

  function showAlert(payload) {
    if (!isNative) return Promise.resolve(null);
    return invoke('show_alert', { payload: payload }).catch(function () { return null; });
  }
  function closeAlert() {
    if (!isNative) return Promise.resolve(null);
    return invoke('close_alert').catch(function () { return null; });
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
      // 关键修复：命令失败时如实返回 false，绝不再「假成功」掩盖真实错误
      // （Tauri v2 在 capabilities 未授权或注册表写入异常时命令会 reject）。
      .catch(function () { return false; });
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

  // 全局项广播（语言/闹钟等）：所有窗口都应用，但不得覆盖本窗口专属字段。
  function onChanged(cb) {
    return listen('prefs-changed', function (payload) {
      if (!payload || typeof payload !== 'object') return;
      var g = normalize(payload), k;
      // 只把全局项合进 current，保留本窗口的 WINDOW_KEYS 现值
      for (k in g) {
        if (Object.prototype.hasOwnProperty.call(g, k) && WINDOW_KEYS.indexOf(k) < 0) current[k] = g[k];
      }
      writeLocal(payload);
      cb(clone(current));
    });
  }

  // v0.6：某窗口配置变化。时钟窗口只响应自己 id；设置窗口只响应当前目标。
  function onWindowChanged(cb) {
    return listen('window-prefs-changed', function (payload) {
      if (!payload || typeof payload !== 'object') return;
      var id = payload.id;
      if (!isSettingsWindow && id !== selfId) return;
      if (isSettingsWindow && id !== targetId) return;
      var w = payload.prefs || {}, k;
      for (k in w) if (Object.prototype.hasOwnProperty.call(w, k)) current[k] = w[k];
      cb(clone(current));
    });
  }

  // ------------------------------------------------------ timeout helpers
  // v0.5：权限 invoke 若因系统/插件异常永不 settle，前端必须自行恢复，
  // 不能停留「正在检查…／正在请求授权…」。
  function withTimeout(promise, ms, fallbackValue, rejectMessage) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (rejectMessage) reject(new Error(rejectMessage));
        else resolve(fallbackValue);
      }, ms);
      Promise.resolve(promise).then(function (v) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }).catch(function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function privilegeStatus() {
    if (!isNative) {
      return Promise.resolve({
        platform: 'browser', isElevated: false, canElevate: false,
        runAsAdmin: false, note: '浏览器预览模式：无系统权限，仅用于查看界面。'
      });
    }
    return withTimeout(invoke('get_privilege_status'), 4000, null, null)
      .then(function (s) {
        return s && typeof s === 'object' ? s : {
          platform: 'unknown', isElevated: false, canElevate: false,
          runAsAdmin: false, note: '无法读取权限状态。'
        };
      })
      .catch(function () {
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
    return withTimeout(invoke('set_run_as_admin', { enabled: !!enabled }), 8000,
      null, '授权设置超时，请重试。');
  }

  // v0.5：命令立即返回（Rust 后台线程等 UAC）；这里仍加超时兜底，
  // 保证任何异常下按钮都能恢复，不会永远显示「正在请求授权…」。
  function restartElevated() {
    if (!isNative) return Promise.reject(new Error('浏览器模式不支持提权'));
    return withTimeout(invoke('restart_elevated'), 8000, null, '授权请求超时。');
  }

  function openSettings(id) {
    if (!isNative) return Promise.resolve();
    return invoke('open_settings', id ? { id: id } : {});
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
  // v0.6：九宫格作用于当前目标窗口（不再是写死的 main）。
  function presetPosition(pos) { return invoke('preset_position_for', { id: targetId, pos: pos }); }
  function setClickThrough(enabled) { return invoke('set_click_through', { enabled: !!enabled }); }
  function syncSystemTime() { return invoke('sync_system_time'); }
  // 外链：前端只传标识符，Rust 解析真实地址（不接受任意 URL）。
  function openUrl(kind) { return invoke('open_link', { kind: kind }); }
  // 更新检查：GitHub REST API 允许跨域，前端直接 fetch；Rust 不引入 TLS 依赖。
  // 返回 { latest, assetUrl }：assetUrl 是当前平台对应的新版本安装包直链（用于一键更新）。
  function checkUpdate() {
    try {
      return fetch('https://api.github.com/repos/xiaoqiangclub/desk-clock/releases/latest',
        { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'DeskClock' } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) {
          var tag = d && d.tag_name ? String(d.tag_name) : '';
          var assetUrl = pickAssetUrl(d && d.assets);
          return { latest: tag, assetUrl: assetUrl || '' };
        });
    } catch (e) { return Promise.reject(e); }
  }
  // 从 release assets 里挑出当前平台的安装包直链
  function pickAssetUrl(assets) {
    if (!assets || !assets.length) return '';
    var plat = String(navigator.platform || '').toLowerCase();
    var ua = String(navigator.userAgent || '').toLowerCase();
    var isWin = /win/.test(plat) || /windows/.test(ua);
    var isMac = /mac/.test(plat);
    function first(suffix) {
      suffix = suffix.toLowerCase();
      for (var i = 0; i < assets.length; i++) {
        if (String(assets[i].name || '').toLowerCase().indexOf(suffix) >= 0) {
          return assets[i].browser_download_url || '';
        }
      }
      return '';
    }
    if (isWin) return first('.exe');
    if (isMac) return first('.dmg') || first('.app.tar.gz');
    return first('.appimage') || first('.deb') || first('.rpm'); // Linux
  }
  // 一键更新：打开新版本安装包直链（Rust 仅放行本项目 release 直链）
  function openUpdateInstaller(url) { return invoke('open_update_installer', { url: url }); }
  function addClockWindow(id, label, offset, style, showSeconds, visible) {
    return invoke('add_clock_window', {
      id: id, label: label, offset: offset,
      style: style || '', showSeconds: !!showSeconds, visible: !!visible
    });
  }
  function closeClockWindow(id) { return invoke('close_clock_window', { id: id }); }
  function setClockWindowVisible(id, visible) {
    return invoke('set_clock_window_visible', { id: id, visible: !!visible });
  }
  function listClockWindows() { return invoke('list_clock_windows'); }
  // v0.6：窗口配置 / 目标选择
  function windowConfigs() { return invoke('get_window_configs'); }
  function setWindowPrefs(id, patch) { return invoke('set_window_prefs', { id: id, patch: patch }); }
  function windowPrefs(id) { return invoke('get_window_prefs', { id: id }); }

  window.DeskClock.Prefs = {
    DEFAULTS: clone(DEFAULTS),
    isNative: isNative,
    normalize: normalize,
    load: load,
    get: get,
    save: save,
    getTargetId: getTargetId,
    getSelfId: getSelfId,
    isSettingsView: isSettingsView,
    setActiveClock: setActiveClock,
    onChanged: onChanged,
    onWindowChanged: onWindowChanged,
    resetDefaults: function () { return save(clone(DEFAULTS)); },
    setWindowPosition: setWindowPosition,
    setWindowGeometry: setWindowGeometry,
    showAlert: showAlert, closeAlert: closeAlert,
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
    openUpdateInstaller: openUpdateInstaller,
    openUrl: openUrl,
    addClockWindow: addClockWindow,
    closeClockWindow: closeClockWindow,
    setClockWindowVisible: setClockWindowVisible,
    listClockWindows: listClockWindows,
    windowConfigs: windowConfigs,
    setWindowPrefs: setWindowPrefs,
    windowPrefs: windowPrefs
  };
})();
