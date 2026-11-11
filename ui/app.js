(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var DC = window.DeskClock;
  var Prefs = DC.Prefs;
  var FlipDigit = DC.FlipDigit;
  var Engine = DC.Engine;
  var I18n = DC.I18n;
  var Fonts = DC.Fonts;
  var Alarm = DC.Alarm;
  var Announce = DC.Announce;
  var ALLOWED_RULES = ['hourly', 'half', 'quarter', 'interval', 'custom'];
  var ALLOWED_CHIME = ['none', 'gentle', 'bell', 'tick', 'rise', 'chord'];

  // Native window base size at scale=1 (mirrors tauri.conf.json).
  var BASE_W = 640, BASE_H = 220;
  var CUSTOM = '__custom__';
  var APP_VERSION = '0.7.0';
  var PROJECT_URL = 'project';      // 传给 Rust open_link 的标识符
  var RELEASES_URL = 'releases';    // 同上（真实 URL 由 Rust 解析）

  var STYLES = ['flip', 'minimal', 'neon', 'eink', 'segment', 'typewriter', 'glass', 'analog'];
  var BACKDROPS = ['none', 'blur', 'dim', 'light'];

  // v0.4: 常用时区（固定 UTC 偏移，分钟；明确不含夏令时，界面有说明）
  var ZONES = [
    { label: 'UTC-10 夏威夷', offset: -600 },
    { label: 'UTC-8  洛杉矶', offset: -480 },
    { label: 'UTC-7  丹佛', offset: -420 },
    { label: 'UTC-6  芝加哥', offset: -360 },
    { label: 'UTC-5  纽约', offset: -300 },
    { label: 'UTC-4  多伦多', offset: -240 },
    { label: 'UTC-3  圣保罗', offset: -180 },
    { label: 'UTC+0  伦敦', offset: 0 },
    { label: 'UTC+1  巴黎/柏林', offset: 60 },
    { label: 'UTC+2  开罗', offset: 120 },
    { label: 'UTC+3  莫斯科', offset: 180 },
    { label: 'UTC+4  迪拜', offset: 240 },
    { label: 'UTC+5:30 印度', offset: 330 },
    { label: 'UTC+7  曼谷', offset: 420 },
    { label: 'UTC+8  北京/新加坡', offset: 480 },
    { label: 'UTC+9  东京', offset: 540 },
    { label: 'UTC+10 悉尼', offset: 600 },
    { label: 'UTC+11 墨尔本', offset: 660 },
    { label: 'UTC+12 奥克兰', offset: 720 },
    { label: 'UTC+14 斐济', offset: 840 }
  ];
  // 「任意时区」输入：支持 ±HH:MM / ±HH（分钟）
  function parseZoneInput(raw) {
    var s = String(raw || '').trim();
    var m = /^(\+|-)?(\d{1,2})(?::(\d{2}))?$/.exec(s);
    if (!m) return null;
    var sign = m[1] === '-' ? -1 : 1;
    var off = sign * ((Number(m[2]) * 60) + Number(m[3] || 0));
    if (off < -840 || off > 840) return null;
    return off;
  }
  function zoneLabelFor(offset) {
    for (var i = 0; i < ZONES.length; i++) if (ZONES[i].offset === offset) return ZONES[i].label;
    var h = Math.floor(Math.abs(offset) / 60), m2 = Math.abs(offset) % 60;
    var mm = m2 ? ':' + ('0' + m2).slice(-2) : '';
    return 'UTC' + (offset >= 0 ? '+' : '') + h + mm;
  }

  var app = document.getElementById('app');
  var clockEl = document.getElementById('clock');
  var gear = document.getElementById('gear');

  var state = null;
  var engine = null;
  var slots = {};
  var analog = null;
  var builtStyle = null;
  var builtPartsKey = '';
  var lastAlarmKey = '';   // 上一次闹钟去重 key
  var lastAnnounceKey = '';   // v0.7: 语音播报分钟去重 key
  var timerTarget = null;   // {label, action}
  var privStatus = null;
  var privError = false;    // v0.5: 权限状态读取失败（显示重试按钮）
  var editingClockId = null; // v0.5: 管理器正在编辑的窗口 id
  var ringTimeout = null;    // v0.6.2: 闹钟响铃自动停止计时器

  // v0.6：所有窗口配置化。注入值仅作为旧构建/兜底，真实值以 state 为准。
  var isSettingsWindow = window.__DC_VIEW__ === 'settings';
  var isExtraWindow = !!window.__DC_EXTRA__;
  var injectedTzOffset = (typeof window.__DC_TZ_OFFSET__ === 'number') ? window.__DC_TZ_OFFSET__ : null;
  var injectedStyle = window.__DC_STYLE__ || '';
  var injectedShowSeconds = (typeof window.__DC_SHOW_SECONDS__ === 'boolean')
    ? window.__DC_SHOW_SECONDS__ : null;

  var settings = document.getElementById('settings');

  if (isSettingsWindow) {
    document.body.setAttribute('data-view', 'settings');
    document.title = 'Desk Clock v' + APP_VERSION + ' · 设置';
    settings.hidden = false;
  } else if (isExtraWindow) {
    document.body.setAttribute('data-view', 'extra');
    document.title = 'Desk Clock v' + APP_VERSION + ' · ' + (window.__DC_TZ_LABEL__ || '时区时钟');
    // v0.6.1：所有窗口平等——额外窗口也保留齿轮与缩放柄，
    // 点齿轮会打开设置并自动把编辑目标切到自己。
  }

  function byId(id) { return document.getElementById(id); }
  function STRINGS_LANG() { return (state && state.lang) || 'zh-CN'; }

  function effectiveColor() {
    if (state.color === CUSTOM) return state.customColor;
    return state.color || '';
  }

  // v0.6：时区来自本窗口配置（null=本机时间）。
  function currentTzOffset() {
    if (state && typeof state.tzOffset === 'number' && isFinite(state.tzOffset)) return state.tzOffset;
    return injectedTzOffset;
  }
  function displayNow() {
    var now = new Date();
    var off = currentTzOffset();
    if (off === null || off === undefined) return now;
    return new Date(now.getTime() + (off + now.getTimezoneOffset()) * 60000);
  }

  // v0.6：窗口样式/秒显示都来自本窗口配置；注入值仅兜底。
  function effectiveShowSeconds() {
    if (state && typeof state.showSeconds === 'boolean') return state.showSeconds;
    if (injectedShowSeconds !== null) return injectedShowSeconds;
    return true;
  }

  // v0.5 流畅度优化：applyRoot 拆为两档——
  // applyRootLite：滑块 input 等高频事件只改 CSS 变量（无 DOM 遍历）；
  // applyRoot（完整）：语言/样式等低频变化才重刷 i18n 与全部 data-* 属性。
  function applyRootLite() {
    // v0.6：state 已是本窗口的完整配置，直接应用；注入值仅作旧构建兜底。
    var effStyle = (isExtraWindow && injectedStyle && STYLES.indexOf(injectedStyle) >= 0 && !state.style)
      ? injectedStyle : state.style;
    var style = STYLES.indexOf(effStyle) >= 0 ? effStyle : 'flip';
    var backdrop = BACKDROPS.indexOf(state.backdrop) >= 0 ? state.backdrop : 'none';
    state.style = style;
    state.backdrop = backdrop;
    app.setAttribute('data-style', style);
    app.setAttribute('data-backdrop', backdrop);
    app.setAttribute('data-show-sep', String(!!state.showSeparator));

    var sc = Number(state.scale) || 1;
    app.style.setProperty('--dc-scale', String(sc));

    // 🔴 不透明度只作用于时钟窗口，设置窗口永远清晰。
    if (isSettingsWindow) {
      app.style.removeProperty('opacity');
    } else if (!isOwnPanelOpen()) {
      app.style.opacity = String(Number(state.opacity));
    } else {
      app.style.removeProperty('opacity');
    }

    var font = Fonts.fontStack(state);
    if (font) app.style.setProperty('--dc-font', font);
    else app.style.removeProperty('--dc-font');

    var col = effectiveColor();
    if (col) {
      app.style.setProperty('--dc-fg', col);
      app.style.setProperty('--dc-accent', col);
    } else {
      app.style.removeProperty('--dc-fg');
      app.style.removeProperty('--dc-accent');
    }
    var out = byId('scale-out');
    if (out) out.textContent = Math.round(sc * 100) + '%';
  }

  function applyRoot() {
    applyRootLite();
    // v0.5 管理器：额外时钟窗口的秒显示由注入值优先，否则跟随全局
    app.setAttribute('data-show-sep', String(!!state.showSeparator));
    app.setAttribute('data-analog-theme', state.analogTheme === 'light' ? 'light' : 'dark');
    app.setAttribute('data-analog-penetrate', String(!!state.analogPenetrate));
    I18n.apply(state.lang);
    if (isSettingsWindow) document.title = 'Desk Clock v' + APP_VERSION + (state.lang === 'en' ? ' · Settings' : ' · 设置');
    else if (isExtraWindow) document.title = 'Desk Clock v' + APP_VERSION + ' · ' + (window.__DC_TZ_LABEL__ || '时区时钟');
    else document.title = 'Desk Clock v' + APP_VERSION;
    var vb = byId('ver-badge'); if (vb) vb.textContent = 'v' + APP_VERSION;
    var av = byId('about-version'); if (av) av.textContent = APP_VERSION;
  }

  function isOwnPanelOpen() {
    // 浏览器预览的嵌入式面板打开时，不应用窗口透明度（否则设置也跟着透明）
    return !isSettingsWindow && !isExtraWindow && settings && !settings.hidden;
  }

  // v0.6.2：窗口外壳尺寸 = #app 内容真实尺寸（逻辑像素）。
  // 外壳此前恒为 640×220，九宫格用 outer_size 贴边时可见内容右侧空出大片透明区。
  function appContentSize() {
    var r = app.getBoundingClientRect();
    var w = Math.ceil(r.width) || BASE_W;
    var h = Math.ceil(r.height) || BASE_H;
    return { w: w, h: h };
  }

  // v0.6：缩放/尺寸作用于「当前编辑目标窗口」，而非写死 main。
  function setWindowSize(scale) {
    if (!Prefs.isNative) return;
    // 独立设置窗口里无法测量目标时钟窗口，让 Rust 用已持久化的 w/h；
    // 时钟窗口自己测量 #app（含 padding）并把 w/h 传给 Rust。
    var own = !Prefs.isSettingsView() && !isSettingsWindow && !isExtraWindow;
    var size = own ? appContentSize() : null;
    var id = own ? Prefs.getSelfId() : Prefs.getTargetId();
    Prefs.setWindowGeometry(id, null, null, scale, size).catch(function () {});
  }

  // ------------------------------------------- cross-window preference sync
  function applyRemotePrefs(next) {
    var rebuild = next.style !== state.style ||
      next.showSeconds !== state.showSeconds ||
      next.hour12 !== state.hour12 ||
      next.analogTheme !== state.analogTheme;
    var isSettings = isSettingsWindow; // 设置窗口才需要重刷控制面板
    state = Prefs.normalize(next);
    // 高频跨窗口同步：时钟窗口走轻路径（只改 CSS 变量），设置窗口才全量
    if (isSettings) applyRoot(); else applyRootLite();
    if (engine) {
      engine.setOptions({
        showSeconds: isExtraWindow ? effectiveShowSeconds() : state.showSeconds,
        hour12: state.hour12,
        animate: state.style === 'flip'
      });
    }
    if (isSettings) syncControls();
    if (rebuild && engine && !isSettingsWindow) {
      var now = displayNow();
      ensureDom(engine.buildParts(now), true);
      renderFrame({ parts: engine.buildParts(now), now: now });
    }
    renderPrivilege();
  }

  // ------------------------------------------------------- privilege section
  function renderPrivilege() {
    var box = byId('perm-status');
    var note = byId('perm-note');
    var row = byId('perm-admin-row');
    var toggle = byId('perm-run-admin');
    var nowBtn = byId('perm-elevate-now');
    var quitBtn = byId('perm-quit');
    var retryBtn = byId('perm-retry');
    if (!box) return;
    var L = STRINGS_LANG();
    var s = privStatus;
    if (privError) {
      box.textContent = I18n.t(L, 'permCheckFail');
      box.className = 'perm-status standard';
      if (note) note.textContent = '';
      if (retryBtn) { retryBtn.hidden = false; retryBtn.disabled = false; retryBtn.textContent = I18n.t(L, 'permRetry'); }
      row.hidden = true; nowBtn.hidden = true;
      quitBtn.hidden = !Prefs.isNative;
      return;
    }
    if (retryBtn) { retryBtn.hidden = true; retryBtn.disabled = false; }
    if (!s) {
      // 仅在真正加载中显示；loadPrivilege 保证 4s 内必达（成功或 privError）。
      box.textContent = I18n.t(L, 'permChecking');
      box.className = 'perm-status';
      if (note) note.textContent = '';
      row.hidden = true; nowBtn.hidden = true; quitBtn.hidden = true;
      return;
    }
    var labels = { windows: 'Windows', macos: 'macOS', linux: 'Linux', browser: '浏览器预览', unknown: '未知' };
    box.className = 'perm-status ' + (s.isElevated ? 'elevated' : 'standard');
    box.textContent = (labels[s.platform] || s.platform) + ' · ' +
      (s.isElevated
        ? (L === 'en' ? 'Running with administrator / root rights' : '已以管理员 / root 身份运行')
        : (L === 'en' ? 'Running with standard rights' : '当前为标准权限')) +
      ' · ' + (s.runAsAdmin ? I18n.t(L, 'permAdminOn') : I18n.t(L, 'permAdminOff'));
    if (note) note.textContent = s.note || '';
    var supported = !!s.canElevate;
    row.hidden = !supported;
    if (supported) toggle.checked = !!s.runAsAdmin;
    nowBtn.hidden = !supported || !!s.isElevated;
    nowBtn.disabled = false;
    nowBtn.textContent = I18n.t(L, 'permElevateNow');
    quitBtn.hidden = !Prefs.isNative;
  }

  function loadPrivilege() {
    privError = false;
    privStatus = null;
    renderPrivilege();
    Prefs.privilegeStatus().then(function (s) {
      // unknown + 空 note 代表读取失败（含超时）→ 显示重试，不再永远「正在检查」。
      privError = !!(s && s.platform === 'unknown');
      privStatus = s;
      renderPrivilege();
    }).catch(function () {
      privError = true; privStatus = null; renderPrivilege();
    });
  }

  // ---------------------------------------------------------- tabs (v0.4)
  function bindTabs() {
    var tabs = document.querySelectorAll('#settings-tabs .tab');
    if (!tabs.length) return;
    function activate(name) {
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
      var panels = document.querySelectorAll('#settings-panels .panel');
      for (var j = 0; j < panels.length; j++) panels[j].classList.toggle('active', panels[j].getAttribute('data-panel') === name);
      var box = byId('settings-panels');
      if (box && isSettingsWindow) { try { box.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { box.scrollTop = 0; } }
    }
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () { activate(this.getAttribute('data-tab')); });
    }
    activate('appearance');
  }

  // ---------------------------------------------------------- donate/about
  function showDonatePanel() {
    var panel = byId('donate-panel');
    var btn = byId('donate-toggle');
    var L = STRINGS_LANG();
    if (!panel || !btn) return;
    panel.hidden = false;
    btn.textContent = I18n.t(L, 'donateHide');
    // 独立窗口需先切到「关于」Tab 才能看到
    if (isSettingsWindow) {
      var aboutTab = document.querySelector('#settings-tabs .tab[data-tab="about"]');
      if (aboutTab) aboutTab.click();
    }
    try { panel.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  function setDonateTab(which) {
    var img = byId('donate-img');
    if (img) img.src = which === 'alipay' ? 'assets/donate-alipay.jpg' : 'assets/donate-wechat.jpg';
    var tabs = document.querySelectorAll('.donate-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-donate') === which);
  }

  function setUpdateStatus(text) {
    var el = byId('update-status'); if (el) el.textContent = text;
  }

  function semverNewer(a, b) {
    function parts(v) { return String(v || '').replace(/^v/, '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
    var A = parts(a), B = parts(b);
    for (var i = 0; i < 3; i++) { if ((A[i] || 0) > (B[i] || 0)) return true; if ((A[i] || 0) < (B[i] || 0)) return false; }
    return false;
  }

  function checkUpdate(manual) {
    var L = STRINGS_LANG();
    if (manual) setUpdateStatus(I18n.t(L, 'updateChecking'));
    var dl = byId('download-update'); if (dl) dl.hidden = true;
    return Prefs.checkUpdate().then(function (info) {
      var latest = info && info.latest ? String(info.latest).replace(/^v/, '') : '';
      if (!latest) { if (manual) setUpdateStatus(I18n.t(L, 'updateFail').replace('%s', 'no data')); return; }
      if (semverNewer(latest, APP_VERSION)) {
        setUpdateStatus(I18n.t(L, 'updateFound').replace('%s', 'v' + latest));
        if (dl) { dl.hidden = false; dl.dataset.link = 'releases'; }
      } else {
        setUpdateStatus(I18n.t(L, 'updateLatest').replace('%s', 'v' + APP_VERSION));
      }
    }).catch(function (err) {
      if (manual) setUpdateStatus(I18n.t(L, 'updateFail').replace('%s', String(err || 'failed')));
    });
  }

  // ------------------------------------------- v0.5 多时区窗口管理器
  function cmOffsetText(offset) {
    var h = Math.floor(Math.abs(offset) / 60), m2 = Math.abs(offset) % 60;
    return 'UTC' + (offset >= 0 ? '+' : '-') + h + (m2 ? ':' + ('0' + m2).slice(-2) : '');
  }

  function cmResetEditor() {
    editingClockId = null;
    var name = byId('cm-name'); if (name) name.value = '';
    var add = byId('cm-add'); if (add) add.hidden = false;
    var save = byId('cm-save'); if (save) save.hidden = true;
    var cancel = byId('cm-cancel'); if (cancel) cancel.hidden = true;
    var hint = byId('cm-edit-hint'); if (hint) hint.hidden = true;
  }

  function cmReadEditor() {
    var nameEl = byId('cm-name');
    return { label: ((nameEl && nameEl.value) || '').trim().slice(0, 16) };
  }

  function cmFillEditor(c) {
    var name = byId('cm-name'); if (name) { name.value = c.label; name.focus(); }
    editingClockId = c.id;
    byId('cm-add').hidden = true;
    byId('cm-save').hidden = false;
    byId('cm-cancel').hidden = false;
    var hint = byId('cm-edit-hint'); if (hint) hint.hidden = false;
  }

  // 轮询核对真实窗口（WebView2 冷启动可能慢于单次固定延时）。
  function cmVerifyWindow(c, triesLeft) {
    if (triesLeft <= 0 || !Prefs.isNative) return;
    Prefs.listClockWindows().then(function (wins) {
      if (!Array.isArray(wins)) return;
      if (wins.indexOf('clock-' + c.id) >= 0 || c.visible === false) return;
      if (triesLeft > 1) {
        setTimeout(function () { cmVerifyWindow(c, triesLeft - 1); }, 700);
        return;
      }
      // 确实没建起来 → 标为未运行，避免列表显示假的「运行中」
      var next = (state.extraClocks || []).map(function (x) {
        return x.id === c.id ? Object.assign({}, x, { visible: false }) : x;
      });
      state.extraClocks = next;
      Prefs.save({ extraClocks: next });
      renderClockManager();
    }).catch(function () {});
  }

  function cmSpawn(c) {
    if (!Prefs.isNative) {
      // 浏览器预览：也写入 clocks，便于回归与本地调试
      try {
        var all = JSON.parse(localStorage.getItem('deskclock.clocks') || '{"activeId":"main","clocks":{}}');
        if (!all.clocks) all.clocks = {};
        if (!all.clocks.main) all.clocks.main = {};
        var base = {};
        var d = Prefs.DEFAULTS, wk;
        for (wk in d) if (Object.prototype.hasOwnProperty.call(d, wk)) base[wk] = d[wk];
        for (wk in all.clocks.main) if (Object.prototype.hasOwnProperty.call(all.clocks.main, wk)) base[wk] = all.clocks.main[wk];
        all.clocks[c.id] = base;
        localStorage.setItem('deskclock.clocks', JSON.stringify(all));
      } catch (e) {}
      return;
    }
    // v0.5.1：窗口创建是异步的，创建后核对真实窗口列表，
    // 创建失败时把该项标为「未运行」，避免列表显示假的「运行中」。
    Prefs.addClockWindow(c.id, c.label, c.offset, c.style, c.showSeconds, c.visible)
      .then(function () { setTimeout(function () { cmVerifyWindow(c, 4); }, 500); })
      .catch(function () {});
  }

  function renderClockManager() {
    var box = byId('cm-list');
    if (!box) return;
    var L = STRINGS_LANG();
    box.textContent = '';
    // v0.6.1：主窗口也作为一张卡片列出（用户要求「将我们的主窗口」纳入管理）。
    var rows = [{ id: 'main', label: I18n.t(L, 'cmMain'), isMain: true, visible: true }];
    (state.extraClocks || []).forEach(function (c) {
      rows.push({
        id: c.id, label: c.label || cmOffsetText(c.offset),
        offset: c.offset, style: c.style, visible: c.visible, isMain: false
      });
    });
    rows.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'cm-row' + (c.isMain ? ' cm-row-main' : '');
      row.setAttribute('data-cm-id', c.id);

      var info = document.createElement('div');
      info.className = 'cm-row-info';
      var title = document.createElement('div');
      title.className = 'cm-row-title';
      title.textContent = c.label;
      if (c.isMain) {
        var tag = document.createElement('span');
        tag.className = 'cm-row-tag';
        tag.textContent = I18n.t(L, 'cmMainTag');
        title.appendChild(tag);
      }
      var meta = document.createElement('div');
      meta.className = 'cm-row-meta';
      meta.textContent = c.isMain
        ? I18n.t(L, 'cmMainHint')
        : (c.visible === false ? I18n.t(L, 'cmStopped') : I18n.t(L, 'cmRunning'));
      info.appendChild(title); info.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'cm-row-actions';
      function mk(labelKey, cls, fn, action) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'dc-btn tiny ' + (cls || 'ghost');
        b.textContent = I18n.t(L, labelKey);
        if (action) b.setAttribute('data-cm-action', action);
        b.addEventListener('click', fn);
        return b;
      }
      actions.appendChild(mk('cmSettings', 'ghost', function () {
        Prefs.setActiveClock(c.id).then(function (fresh) {
          state = fresh;
          applyRoot(); syncControls(); syncAnalogPenetrateControls();
          var t = document.querySelector('#settings-tabs .tab[data-tab="appearance"]');
          if (t) t.click();
        }).catch(function () {});
      }, 'settings'));
      if (!c.isMain) {
        actions.appendChild(mk('cmEdit', 'ghost', function () { cmFillEditor(c); }, 'edit'));
        actions.appendChild(mk(c.visible === false ? 'cmShow' : 'cmHide', 'ghost', function () {
          var vis = !(c.visible !== false);
          var next = (state.extraClocks || []).map(function (x) {
            return x.id === c.id ? Object.assign({}, x, { visible: vis }) : x;
          });
          changed({ extraClocks: next });
          if (Prefs.isNative) Prefs.setClockWindowVisible(c.id, vis).catch(function () {});
        }, 'visibility'));
        actions.appendChild(mk('cmDelete', 'danger', function () {
          var next = (state.extraClocks || []).filter(function (x) { return x.id !== c.id; });
          changed({ extraClocks: next });
          if (Prefs.isNative) Prefs.closeClockWindow(c.id).catch(function () {});
          if (editingClockId === c.id) cmResetEditor();
        }, 'delete'));
      }
      row.appendChild(info); row.appendChild(actions);
      box.appendChild(row);
    });
  }

  // v0.5：同步「自定义音频」相关控件状态（显示/隐藏/提示文本）。
  function syncAlarmToneUI() {
    var toneSel = byId('pref-alarm-tone');
    if (!toneSel) return;
    toneSel.value = (typeof state !== 'undefined' && state && Alarm.ALLOWED_TONES.indexOf(state.alarmTone) >= 0)
      ? state.alarmTone : 'gentle';
    var hasCustom = Alarm.getHasCustom();
    byId('alarm-custom-pick').hidden = hasCustom;          // 已有自定义则隐藏「选择」
    byId('alarm-custom-clear').hidden = !hasCustom;        // 没有则隐藏「移除」
    var st = byId('alarm-custom-status');
    if (st) {
      st.textContent = hasCustom
        ? (state && state.alarmTone === 'custom' ? I18n.t(STRINGS_LANG(), 'toneCustom') : I18n.t(STRINGS_LANG(), 'alarmCustomNone'))
        : I18n.t(STRINGS_LANG(), 'alarmCustomNone');
      st.classList.toggle('ok', hasCustom && state && state.alarmTone === 'custom');
    }
  }

  // v0.6：设置窗口顶部的「正在编辑」选择器 —— 切换后重读该窗口配置并刷新全部控件。
  function refreshTargetOptions() {
    var sel = byId('target-clock');
    var wrap = byId('head-target');
    if (!sel || !wrap) return;
    wrap.hidden = !isSettingsWindow;   // 只有独立设置窗口显示
    if (!isSettingsWindow) return;
    var L = STRINGS_LANG();
    var all = [];
    // main 恒存在
    all.push({ id: 'main', name: I18n.t(L, 'cmMain') });
    (state.extraClocks || []).forEach(function (c) {
      all.push({ id: c.id, name: c.label || cmOffsetText(c.offset) });
    });
    var cur = Prefs.getTargetId();
    sel.textContent = '';
    all.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o.id; op.textContent = o.name;
      sel.appendChild(op);
    });
    if (all.some(function (o) { return o.id === cur; })) sel.value = cur;
    else { sel.value = 'main'; }
  }

  function bindTargetSelector() {
    var sel = byId('target-clock');
    if (!sel || !isSettingsWindow) return;
    sel.addEventListener('change', function () {
      var id = sel.value;
      Prefs.setActiveClock(id).then(function (fresh) {
        state = fresh;
        applyRoot();
        syncControls();
        syncAnalogPenetrateControls();
        setWindowSize(state.scale);
        refreshTargetOptions();
      }).catch(function () {});
    });
  }

  function bindClockManager() {
    var nameEl = byId('cm-name');
    if (nameEl) nameEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var btn = editingClockId ? byId('cm-save') : byId('cm-add');
        if (btn) btn.click();
      }
    });
    byId('cm-add').addEventListener('click', function () {
      var addBtn = this;
      if (addBtn.disabled) return;
      var list = (state.extraClocks || []).slice();
      if (list.length >= 8) return;
      var label = cmReadEditor().label ||
        (I18n.t(STRINGS_LANG(), 'cmWindow') + ' ' + (list.length + 2));
      var c = {
        id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        label: label, offset: 0, style: '', showSeconds: true, visible: true
      };
      list.push(c);
      changed({ extraClocks: list });
      addBtn.disabled = true;
      cmSpawn(c);
      cmResetEditor();
      setTimeout(function () { addBtn.disabled = false; }, 900);
    });
    byId('cm-save').addEventListener('click', function () {
      if (!editingClockId || editingClockId === 'main') { cmResetEditor(); return; }
      var label = cmReadEditor().label;
      if (!label) { var n = byId('cm-name'); if (n) n.focus(); return; }
      var id = editingClockId;
      var list = (state.extraClocks || []).map(function (x) {
        return x.id === id ? Object.assign({}, x, { label: label }) : x;
      });
      changed({ extraClocks: list });
      // 同步窗口自身配置里的名称（顶部「正在编辑」下拉框与窗口标题会用到）
      if (Prefs.isNative) Prefs.setWindowPrefs(id, { tzLabel: label }).catch(function () {});
      cmResetEditor();
    });
    byId('cm-cancel').addEventListener('click', cmResetEditor);
  }

  // ---------------------------------------------------------- extra binds
  function bindExtras() {
    bindTabs();

    var hint = byId('tray-hint');
    if (hint) hint.hidden = !Prefs.isNative;

    // Permission controls
    byId('perm-run-admin').addEventListener('change', function (e) {
      var wanted = e.target.checked;
      e.target.disabled = true;
      Prefs.setRunAsAdmin(wanted).then(function (s) {
        privStatus = s; state.runAsAdmin = !!s.runAsAdmin;
        renderPrivilege(); e.target.disabled = false;
      }).catch(function (err) {
        e.target.checked = !wanted; e.target.disabled = false;
        var b = byId('perm-status'); if (b) b.textContent = String(err || 'failed');
      });
    });
    byId('perm-elevate-now').addEventListener('click', function () {
      var b = this; b.disabled = true;
      var L = STRINGS_LANG();
      b.textContent = L === 'en' ? 'Requesting…' : '正在请求授权…';
      Prefs.restartElevated().then(function () {
        // 提权成功时本进程将退出；若仍在此（取消授权）则恢复并提示。
        b.disabled = false; b.textContent = I18n.t(L, 'permElevateNow');
        loadPrivilege();
      }).catch(function (err) {
        b.disabled = false; b.textContent = I18n.t(L, 'permElevateNow');
        var s = byId('perm-status'); if (s) s.textContent = I18n.t(L, 'permElevateFailed');
        var note = byId('perm-note'); if (note && err) note.textContent = String(err.message || err);
      });
    });
    byId('perm-quit').addEventListener('click', function () { Prefs.quitApp(); });
    byId('perm-retry').addEventListener('click', function () { loadPrivilege(); });

    // Donation controls
    byId('donate-toggle').addEventListener('click', function () {
      var panel = byId('donate-panel');
      var L = STRINGS_LANG();
      if (panel.hidden) showDonatePanel();
      else { panel.hidden = true; this.textContent = I18n.t(L, 'donateToggle'); }
    });
    (function () {
      var tabs = document.querySelectorAll('.donate-tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener('click', function () { setDonateTab(this.getAttribute('data-donate')); });
      }
    })();

    // Project link + update check
    byId('project-link').addEventListener('click', function () {
      Prefs.openUrl(PROJECT_URL).catch(function () { /* browser preview: no-op */ });
    });
    // v0.5：版本号徽标可直接点击跳转到项目主页
    (function () {
      var vb = byId('ver-badge'), av = byId('about-version');
      [vb, av].forEach(function (el) {
        if (!el) return;
        el.addEventListener('click', function () { Prefs.openUrl(PROJECT_URL).catch(function () {}); });
      });
    })();
    byId('check-update').addEventListener('click', function () { checkUpdate(true); });
    (function () {
      var dl = byId('download-update');
      if (dl) dl.addEventListener('click', function (e) {
        e.preventDefault();
        Prefs.openUrl(RELEASES_URL).catch(function () {});
      });
    })();
    // 自动检查（静默）：只在独立设置窗口启动时跑一次
    if (isSettingsWindow && Prefs.isNative) checkUpdate(false);

    // Rust-side tray "donate" intent
    Prefs.listen('show-donate', showDonatePanel);
    if (Prefs.isNative) {
      var core = window.__TAURI__ && window.__TAURI__.core;
      if (core && typeof core.invoke === 'function') {
        core.invoke('take_donate_intent').then(function (v) { if (v) showDonatePanel(); }).catch(function () {});
      }
    }

    // Quick position grid
    (function () {
      var btns = document.querySelectorAll('#pos-grid button');
      for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener('click', function () {
          var pos = this.getAttribute('data-pos');
          if (!Prefs.isNative) return;
          Prefs.presetPosition(pos).catch(function () {});
        });
      }
    })();

    // Alarm sound test
    byId('alarm-test-sound').addEventListener('click', function () { Alarm.startRing(); setTimeout(function () { Alarm.stopRing(); }, 1600); });

    // v0.5 铃声：预设选择 + 试听 + 自定义音频
    (function () {
      var toneSel = byId('pref-alarm-tone');
      toneSel.addEventListener('change', function () {
        var v = toneSel.value;
        Alarm.setCurrentTone(v);
        changed({ alarmTone: v });
        syncAlarmToneUI();
        if (v !== 'custom') Alarm.startRing(); setTimeout(function () { Alarm.stopRing(); }, 900);
      });
      byId('alarm-custom-pick').addEventListener('click', function () { byId('alarm-custom-file').click(); });
      byId('alarm-custom-file').addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        var L = STRINGS_LANG(), st = byId('alarm-custom-status');
        Alarm.saveCustomAudio(f).then(function (ok) {
          if (ok) {
            byId('pref-alarm-tone').value = 'custom';
            Alarm.setCurrentTone('custom');
            changed({ alarmTone: 'custom' });
            st.textContent = I18n.t(L, 'toneCustom');
            st.classList.add('ok');
            Alarm.startRing(); setTimeout(function () { Alarm.stopRing(); }, 1200);
          } else {
            st.textContent = I18n.t(L, 'alarmCustomTooBig');
            st.classList.remove('ok');
          }
          syncAlarmToneUI();
        });
      });
      byId('alarm-custom-clear').addEventListener('click', function () {
        Alarm.clearCustomAudio();
        byId('pref-alarm-tone').value = 'gentle';
        Alarm.setCurrentTone('gentle');
        changed({ alarmTone: 'gentle' });
        var st = byId('alarm-custom-status');
        st.textContent = I18n.t(STRINGS_LANG(), 'alarmCustomNone');
        st.classList.remove('ok');
        syncAlarmToneUI();
      });
    })();

    // v0.5 多时区窗口管理器
    bindClockManager();

    // Time sync
    (function () {
      var clockLabel = byId('sync-clock');
      function tick() {
        if (!clockLabel) return;
        clockLabel.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      }
      tick(); setInterval(tick, 1000);
    })();
    byId('sync-now').addEventListener('click', function () {
      var L = STRINGS_LANG();
      var st = byId('sync-status');
      if (!Prefs.isNative) { if (st) st.textContent = I18n.t(L, 'syncUnsupported'); return; }
      Prefs.syncSystemTime().then(function (msg) {
        if (st) st.textContent = msg ? String(msg) : I18n.t(L, 'syncOk');
      }).catch(function (err) {
        if (st) st.textContent = I18n.t(L, 'syncFail').replace('%s', String(err || 'failed'));
      });
    });

    // v0.5: 旧的单行多时区编辑器已被「多时区窗口管理器」(cm-*) 取代，
    // 不再绑定 extra-zone/extra-label/extra-add（这些元素已从 HTML 删除）。

    loadPrivilege();
  }

  function styleForParts(parts) {
    var key = [], i;
    for (i = 0; i < parts.length; i++) key.push(parts[i].type + ':' + parts[i].key);
    return key.join('|');
  }

  function clearClock() {
    while (clockEl.firstChild) clockEl.removeChild(clockEl.firstChild);
    slots = {}; analog = null; builtPartsKey = ''; builtStyle = null;
  }

  function buildDigital(parts) {
    clockEl.className = 'clock';
    var i, p, slot, span;
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      slot = document.createElement('span');
      slot.className = 'slot ' + p.type;
      slot.setAttribute('data-key', p.key);
      if (p.type === 'sep') {
        var d1 = document.createElement('i'); d1.className = 'dot';
        var d2 = document.createElement('i'); d2.className = 'dot';
        slot.appendChild(d1); slot.appendChild(d2);
      } else if (state.style === 'flip') {
        slot.flip = new FlipDigit(slot);
        slot.flip.set(p.value, false);
      } else {
        span = document.createElement('span');
        span.className = 'glyph'; span.textContent = p.value;
        slot.appendChild(span); slot.glyph = span;
      }
      clockEl.appendChild(slot);
      slots[p.key] = slot;
    }
    builtStyle = state.style;
    builtPartsKey = styleForParts(parts);
  }

  function buildAnalog(parts) {
    clockEl.className = 'analog';
    var i, tick, num, dial = document.createElement('div');
    dial.className = 'analog-dial';
    for (i = 0; i < 60; i++) {
      tick = document.createElement('div');
      tick.className = 'analog-tick' + (i % 5 === 0 ? ' major' : '');
      tick.style.setProperty('--a', (i * 6) + 'deg');
      dial.appendChild(tick);
    }
    for (i = 1; i <= 12; i++) {
      num = document.createElement('div');
      num.className = 'analog-num';
      num.textContent = String(i);
      num.style.setProperty('--rot', (i * 30) + 'deg');
      dial.appendChild(num);
    }
    var hour = document.createElement('div'); hour.className = 'hand hour';
    var minute = document.createElement('div'); minute.className = 'hand minute';
    var second = document.createElement('div'); second.className = 'hand second';
    var pin = document.createElement('div'); pin.className = 'analog-pin';
    dial.appendChild(hour); dial.appendChild(minute); dial.appendChild(second); dial.appendChild(pin);
    clockEl.appendChild(dial);
    analog = { hour: hour, minute: minute, second: second };
    builtStyle = 'analog';
    builtPartsKey = styleForParts(parts);
  }

  function ensureDom(parts, force) {
    var key = styleForParts(parts);
    if (!force && builtStyle === state.style && builtPartsKey === key) return;
    clearClock();
    if (state.style === 'analog') buildAnalog(parts);
    else buildDigital(parts);
  }

  function renderFrame(payload) {
    var parts = payload.parts, now = payload.now;
    ensureDom(parts, false);

    if (state.style === 'analog') {
      var h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds(), ms = now.getMilliseconds();
      if (analog) {
        analog.hour.style.transform = 'rotate(' + ((h + m / 60) * 30) + 'deg)';
        analog.minute.style.transform = 'rotate(' + ((m + s / 60 + ms / 60000) * 6) + 'deg)';
        analog.second.style.transform = 'rotate(' + ((s + ms / 1000) * 6) + 'deg)';
        analog.second.hidden = !state.showSeconds;
      }
      return;
    }

    var i, p, slot;
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; slot = slots[p.key];
      if (!slot || p.type !== 'digit') continue;
      if (state.style === 'flip') {
        if (slot.flip) slot.flip.set(p.value, engine.animate);
      } else if (slot.glyph && slot.glyph.textContent !== p.value) {
        slot.glyph.textContent = p.value;
      }
    }
  }

  function onTick(payload) {
    renderFrame(payload);
    if (!isSettingsWindow && !isExtraWindow) { maybeFireAlarms(payload.now); maybeAnnounce(); }
  }

  function maybeFireAlarms(now) {
    if (Alarm.isFiring()) return;
    // 闹钟按本机时间触发（额外时区窗口不触发）
    var local = new Date();
    var hm = ('0' + local.getHours()).slice(-2) + ':' + ('0' + local.getMinutes()).slice(-2);
    var hits = (state.alarms || []).filter(function (a) { return a.time === hm; });
    if (!hits.length) { lastAlarmKey = ''; return; }
    var key = hm + '|' + local.toDateString() + '|' + hits.map(function (a) { return a.id; }).join(',');
    if (key === lastAlarmKey) return;
    lastAlarmKey = key;
    var remaining = (state.alarms || []).filter(function (a) { return a.repeat || a.time !== hm; });
    state.alarms = remaining;
    Prefs.save({ alarms: remaining });
    renderAlarmList();
    showAlarmToast(hits.map(function (a) { return a.time; }).join('、'));
  }

  // v0.7（未发布）：语音播报。只在主时钟窗口触发（与闹钟一致），按分钟去重；
  // 先播前导提示音（若选），再用 Web Speech API 读时间。
  function maybeAnnounce() {
    if (!state || !Announce || state.announceEnabled !== true) return;
    var local = new Date();
    if (!Announce.shouldFire(local, state)) { lastAnnounceKey = ''; return; }
    var key = local.toDateString() + '|' + ('0' + local.getHours()).slice(-2) + ':' + ('0' + local.getMinutes()).slice(-2);
    if (key === lastAnnounceKey) return;
    lastAnnounceKey = key;
    if (state.announceChime && state.announceChime !== 'none' && Alarm.playChime) Alarm.playChime(state.announceChime);
    Announce.speak(Announce.buildText(local, state), state);
  }

  // v0.7（未发布）：填充语音下拉（保留当前选中；无语音时只留“跟随系统”）
  function fillVoiceSelect(voice) {
    var sel = byId('pref-announce-voice');
    if (!sel || !Announce) return;
    voice = voice || '';
    var vs = Announce.voices();
    sel.textContent = '';
    var d = document.createElement('option');
    d.value = ''; d.textContent = I18n.t(STRINGS_LANG(), 'announceVoiceDefault'); sel.appendChild(d);
    for (var i = 0; i < vs.length; i++) {
      var o = document.createElement('option');
      o.value = vs[i].voiceURI || String(vs[i].name || i);
      o.textContent = (vs[i].name || ('voice ' + i)) + ' (' + (vs[i].lang || '?') + ')';
      sel.appendChild(o);
    }
    var idx = 0;
    for (i = 0; i < sel.options.length; i++) if (sel.options[i].value === voice) { idx = i; break; }
    sel.selectedIndex = idx;
  }

  // v0.7（未发布）：指定时刻列表渲染 + 删除
  function renderAnnounceTimes() {
    var box = byId('announce-time-list');
    if (!box) return;
    box.textContent = '';
    var list = (state && state.announceTimes) || [];
    if (!list.length) {
      var e = document.createElement('div'); e.className = 'alarm-empty';
      e.textContent = I18n.t(STRINGS_LANG(), 'announceTimeEmpty'); box.appendChild(e); return;
    }
    list.forEach(function (t) {
      var row = document.createElement('div'); row.className = 'alarm-row';
      var info = document.createElement('span'); info.className = 'alarm-info';
      var tt = document.createElement('span'); tt.className = 'alarm-time-text'; tt.textContent = t.time;
      info.appendChild(tt); row.appendChild(info);
      var del = document.createElement('button'); del.className = 'alarm-del'; del.type = 'button'; del.textContent = '×';
      del.addEventListener('click', function () {
        var next = (state.announceTimes || []).filter(function (x) { return x.id !== t.id; });
        changed({ announceTimes: next });
      });
      row.appendChild(del); box.appendChild(row);
    });
  }

  // v0.7（未发布）：语音播报 UI 回显 + 联动显隐 + 支持状态提示
  function syncAnnounceUI() {
    var en = byId('pref-announce-enabled');
    if (!en || !state) return;
    en.checked = state.announceEnabled === true;
    byId('pref-announce-rate').value = String(state.announceRate == null ? 1 : state.announceRate);
    byId('pref-announce-volume').value = String(state.announceVolume == null ? 1 : state.announceVolume);
    byId('pref-announce-chime').value = (ALLOWED_CHIME.indexOf(state.announceChime) >= 0) ? state.announceChime : 'gentle';
    byId('pref-announce-include-date').checked = state.announceIncludeDate === true;
    byId('pref-announce-rule').value = (ALLOWED_RULES.indexOf(state.announceRule) >= 0) ? state.announceRule : 'hourly';
    byId('pref-announce-interval').value = String(state.announceInterval == null ? 30 : state.announceInterval);
    byId('pref-announce-quiet').checked = state.announceQuiet === true;
    byId('pref-announce-quiet-start').value = state.announceQuietStart || '22:00';
    byId('pref-announce-quiet-end').value = state.announceQuietEnd || '07:00';
    byId('announce-interval-row').hidden = state.announceRule !== 'interval';
    byId('announce-times-row').hidden = state.announceRule !== 'custom';
    byId('announce-quiet-row').hidden = state.announceQuiet !== true;
    fillVoiceSelect(typeof state.announceVoice === 'string' ? state.announceVoice : '');
    renderAnnounceTimes();
    var note = byId('announce-support-note');
    if (note) {
      if (!Announce.supported() || Announce.voices().length === 0) note.textContent = I18n.t(STRINGS_LANG(), 'announceVoiceUnsupported');
      else note.textContent = '';
    }
  }

  // v0.6.2：校时页显示当前编辑目标窗口的时区；系统校时校准 UTC 绝对时间，不分区。
  function syncTzInfo() {
    var el = byId('sync-tz');
    if (!el) return;
    var L = STRINGS_LANG();
    var off = state && state.tzOffset;
    var name = (typeof off === 'number' && isFinite(off)) ? zoneLabelFor(off) : I18n.t(L, 'cmTzLocal');
    el.textContent = I18n.t(L, 'syncTzCurrent').replace('%s', name);
  }

  function showAlarmToast(text) {
    var toast = byId('alarm-toast');
    if (!toast) return;
    var L = STRINGS_LANG();
    var seconds = Math.min(600, Math.max(5, Number(state.alarmRingSeconds) || 30));
    if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
    Alarm.setFiring(true);
    if (state.alarmSound) Alarm.startRing();
    ringTimeout = setTimeout(hideAlarmToast, seconds * 1000);
    if (Prefs.isNative) {
      // 原生：独立居中窗口（屏幕正中，按钮不在 drag region 内）。
      var actions = [
        { action: 'mute', label: I18n.t(L, 'alarmMute') },
        { action: 'snooze', label: I18n.t(L, 'alarmSnooze') },
        { action: 'terminate', label: I18n.t(L, 'alarmStop') },
        { action: 'dismiss', label: I18n.t(L, 'alarmDismiss') }
      ];
      Prefs.showAlert({
        kind: 'alarm',
        title: I18n.t(L, 'alarmRinging'),
        body: I18n.t(L, 'alarmMsg').replace('%s', text),
        note: I18n.t(L, 'alertAutoStop').replace('%s', String(seconds)),
        actions: actions, lang: L
      });
      return;
    }
    // 浏览器预览：保留旧 DOM 弹窗，供 7 套回归使用。
    byId('alarm-toast-body').textContent = I18n.t(L, 'alarmMsg').replace('%s', text);
    toast.hidden = false;
    try {
      var AC = window.__TAURI__ && window.__TAURI__.webviewWindow;
      if (AC && AC.getCurrentWebviewWindow) AC.getCurrentWebviewWindow().setFocus().catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function hideAlarmToast() {
    var toast = byId('alarm-toast');
    if (toast) toast.hidden = true;
    if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
    Alarm.setFiring(false);
    Alarm.stopRing();
    if (Prefs.isNative) Prefs.closeAlert();
    var mb = byId('alarm-mute'); if (mb) mb.disabled = false;
  }

  function renderAlarmList() {
    var box = byId('alarm-list');
    if (!box) return;
    box.textContent = '';
    var L = STRINGS_LANG();
    (state.alarms || []).forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'alarm-row';
      var info = document.createElement('span');
      info.className = 'alarm-info';
      var t = document.createElement('span'); t.className = 'alarm-time-text'; t.textContent = a.time;
      var tag = document.createElement('span'); tag.className = 'alarm-tag'; tag.textContent = I18n.t(L, 'alarmRepeat');
      info.appendChild(t); if (a.repeat) info.appendChild(tag);
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'alarm-del'; btn.textContent = '×'; btn.title = I18n.t(L, 'alarmRemove');
      btn.addEventListener('click', function () {
        state.alarms = (state.alarms || []).filter(function (x) { return x.id !== a.id; });
        Prefs.save({ alarms: state.alarms });
        renderAlarmList();
      });
      row.appendChild(info); row.appendChild(btn);
      box.appendChild(row);
    });
    if (!(state.alarms || []).length) {
      var empty = document.createElement('div');
      empty.className = 'alarm-empty'; empty.textContent = '—';
      box.appendChild(empty);
    }
  }

  function syncTimerModeUI() {
    // v0.5：输入框与「启动/取消」同行，单位随模式切换
    var mode = byId('shutdown-mode').value;
    var isClock = mode === 'clock';
    byId('shutdown-min').hidden = isClock;
    byId('shutdown-time').hidden = !isClock;
    byId('shutdown-unit-min').hidden = isClock;
    byId('shutdown-unit-clock').hidden = !isClock;
  }

  function updateTimerUI() {
    var L = STRINGS_LANG();
    var status = byId('shutdown-status');
    var startBtn = byId('shutdown-start');
    var cancelBtn = byId('shutdown-cancel');
    if (!status) return;
    if (timerTarget) {
      status.textContent = I18n.t(L, timerTarget.action === 'reboot' ? 'rebootAt' : 'shutdownAt').replace('%s', timerTarget.label);
      startBtn.hidden = true; cancelBtn.hidden = false;
    } else {
      status.textContent = I18n.t(L, 'shutdownOff');
      startBtn.hidden = false; cancelBtn.hidden = true;
    }
  }

  function syncControls() {
    byId('pref-lang').value = state.lang;
    syncTzControls();
    byId('pref-style').value = state.style;
    byId('pref-font').value = state.font;
    byId('custom-font-row').hidden = state.font !== CUSTOM;
    byId('pref-font-custom').value = state.customFont || '';
    byId('pref-color').value = state.color;
    byId('custom-color-row').hidden = state.color !== CUSTOM;
    byId('pref-color-custom').value = state.customColor || '#f6f7f9';
    byId('pref-seconds').checked = !!state.showSeconds;
    byId('pref-hour12').checked = !!state.hour12;
    byId('pref-separator').checked = !!state.showSeparator;
    byId('pref-ontop').checked = !!state.alwaysOnTop;
    byId('pref-autostart').checked = !!state.autostart;
    byId('pref-backdrop').value = state.backdrop;
    byId('pref-scale').value = String(state.scale);
    byId('pref-opacity').value = String(state.opacity);
    byId('pref-analog-theme').value = state.analogTheme;
    byId('analog-theme-row').hidden = state.style !== 'analog';
    byId('pref-clickthrough').checked = !!state.clickThrough;
    byId('pref-alarm-sound').checked = !!state.alarmSound;
    byId('alarm-ring-seconds').value = String(Math.min(600, Math.max(5, Number(state.alarmRingSeconds) || 30)));
    byId('timer-warn-mode').value = state.timerWarnMode === 'silent' ? 'silent' : 'popup';
    byId('timer-warn-seconds').value = String(Math.min(300, Math.max(5, Number(state.timerWarnSeconds) || 30)));
    byId('timer-warn-seconds').disabled = state.timerWarnMode === 'silent';
    byId('pref-auto-timesync').checked = !!state.autoTimeSync;
    syncTzInfo();
    byId('shutdown-action').value = state.timerAction;
    byId('shutdown-mode').value = state.timerMode;
    syncTimerModeUI();
    var out = byId('scale-out');
    if (out) out.textContent = Math.round((Number(state.scale) || 1) * 100) + '%';
    renderAlarmList();
    syncAlarmToneUI();
    syncAnnounceUI();
    renderClockManager();
    refreshTargetOptions();
    updateTimerUI();
    var vb = byId('ver-badge'), av = byId('about-version');
    if (vb) vb.textContent = 'v' + APP_VERSION;
    if (av) av.textContent = APP_VERSION;
  }

  function changed(patch, opts) {
    var k;
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
    Prefs.save(patch);
    // 高频滑块（scale/opacity）走轻路径，避免全量 i18n/DOM 遍历造成卡顿；
    // 其它低频变化走完整 applyRoot。
    var liteOnly = !!(opts && opts.lite);
    if (liteOnly) applyRootLite();
    else applyRoot();

    if (engine) {
      engine.setOptions({
        showSeconds: isExtraWindow ? effectiveShowSeconds() : state.showSeconds,
        hour12: state.hour12,
        animate: state.style === 'flip'
      });
    }
    if (patch.scale !== undefined) setWindowSize(state.scale);
    if (patch.lang !== undefined) { syncControls(); renderPrivilege(); }
    if (patch.style !== undefined && byId('analog-theme-row')) byId('analog-theme-row').hidden = state.style !== 'analog';
    if (opts && opts.rebuild && engine) {
      var now = displayNow();
      var parts = engine.buildParts(now);
      ensureDom(parts, true);
      renderFrame({ parts: parts, now: now });
    }
    // 高频轻路径（滑块/拖拽）只更新自身数值显示，避免整面板重绘卡顿
    if (liteOnly && !opts.rebuild) {
      var so = byId('scale-out');
      if (so) so.textContent = Math.round((Number(state.scale) || 1) * 100) + '%';
      return;
    }
    syncControls();
  }

  function resetDefaults() {
    var fresh = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    fresh.lang = state.lang;
    fresh.x = state.x; fresh.y = state.y;
    fresh.runAsAdmin = !!state.runAsAdmin;
    // v0.6.1：还原设置只重置「设置项」，不删除已创建的窗口——
    // 否则运行中的窗口还在、清单却被清空，重启后窗口凭空消失。
    fresh.extraClocks = state.extraClocks || [];
    state = fresh;
    Prefs.save(fresh);
    applyRoot();
    setWindowSize(state.scale);
    if (engine) engine.setOptions({ showSeconds: state.showSeconds, hour12: state.hour12, animate: state.style === 'flip' });
    if (!isSettingsWindow && engine) {
      var now = displayNow();
      var parts = engine.buildParts(now);
      ensureDom(parts, true);
      renderFrame({ parts: parts, now: now });
    }
    syncControls();
    var gearBtn = byId('gear');
    if (gearBtn) {
      var old = gearBtn.title;
      gearBtn.title = I18n.t(state.lang, 'resetDone');
      setTimeout(function () { gearBtn.title = old; }, 1800);
    }
  }

  // v0.6：每个窗口的时区（含主窗口）。local=本机时间；__custom__=任意 UTC 偏移。
  function tzSelectOptions() {
    var sel = byId('pref-tz');
    if (!sel || sel.options.length) return;
    var L = STRINGS_LANG();
    var local = document.createElement('option');
    local.value = 'local'; local.textContent = I18n.t(L, 'cmTzLocal');
    sel.appendChild(local);
    ZONES.forEach(function (z) {
      var o = document.createElement('option');
      o.value = String(z.offset); o.textContent = z.label;
      sel.appendChild(o);
    });
    var custom = document.createElement('option');
    custom.value = '__custom__'; custom.textContent = I18n.t(L, 'cmCustomZone');
    sel.appendChild(custom);
  }
  function syncTzControls() {
    tzSelectOptions();
    var sel = byId('pref-tz'), row = byId('pref-tz-custom-row'), inp = byId('pref-tz-offset');
    if (!sel || !row || !inp) return;
    var off = state.tzOffset;
    var isCustom = (typeof off === 'number' && isFinite(off) &&
      !ZONES.some(function (z) { return z.offset === off; }));
    if (off === null || off === undefined) sel.value = 'local';
    else if (isCustom) { sel.value = '__custom__'; inp.value = cmOffsetText(off).replace('UTC', ''); }
    else sel.value = String(off);
    row.hidden = !isCustom;
  }
  function bindTzControls() {
    var sel = byId('pref-tz'), row = byId('pref-tz-custom-row'), inp = byId('pref-tz-offset');
    if (!sel || !row || !inp) return;
    sel.addEventListener('change', function () {
      row.hidden = sel.value !== '__custom__';
      if (sel.value === 'local') changed({ tzOffset: null, tzLabel: '' }, { rebuild: true });
      else if (sel.value !== '__custom__') {
        var off = Number(sel.value) || 0;
        changed({ tzOffset: off, tzLabel: zoneLabelFor(off) }, { rebuild: true });
      }
    });
    inp.addEventListener('change', function () {
      var off = parseZoneInput(inp.value);
      if (off === null) { inp.value = ''; return; }
      changed({ tzOffset: off, tzLabel: cmOffsetText(off) }, { rebuild: true });
    });
  }

  function bindControls() {
    gear.addEventListener('click', function () {
      if (isExtraWindow && !Prefs.isNative) return;
      if (Prefs.isNative && !isSettingsWindow) {
        // v0.6.1：从哪个窗口点齿轮，设置窗口就默认编辑哪个窗口。
        Prefs.openSettings(Prefs.getSelfId()).catch(function () { settings.hidden = !settings.hidden; });
        return;
      }
      if (isSettingsWindow) return;
      settings.hidden = !settings.hidden;
      applyRoot();  // 打开/关闭嵌入式面板时重算 opacity，避免面板半透明
    });
    function close() {
      if (isSettingsWindow) { Prefs.closeSettings(); return; }
      settings.hidden = true;
      applyRoot();
    }
    byId('settings-close').addEventListener('click', close);
    // v0.5：关于页底部的「关闭」按钮已删除（头部 × 即可关闭）；旧版本若残留则仍绑定
    var sc2 = byId('settings-close-2');
    if (sc2) sc2.addEventListener('click', close);
    byId('reset-defaults').addEventListener('click', resetDefaults);

    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); resetDefaults(); }
    });

    byId('pref-lang').addEventListener('change', function (e) { changed({ lang: e.target.value }); });
    bindTzControls();
    byId('pref-style').addEventListener('change', function (e) { changed({ style: e.target.value }, { rebuild: true }); });
    byId('pref-font').addEventListener('change', function (e) {
      var v = e.target.value;
      if (v === CUSTOM) changed({ font: CUSTOM, customFont: byId('pref-font-custom').value });
      else changed({ font: v });
    });
    byId('pref-font-custom').addEventListener('change', function (e) { changed({ font: CUSTOM, customFont: e.target.value }); });
    byId('pref-color').addEventListener('change', function (e) {
      var v = e.target.value;
      if (v === CUSTOM) changed({ color: CUSTOM, customColor: byId('pref-color-custom').value });
      else changed({ color: v });
    });
    byId('pref-color-custom').addEventListener('input', function (e) { changed({ color: CUSTOM, customColor: e.target.value }); });
    byId('pref-seconds').addEventListener('change', function (e) { changed({ showSeconds: e.target.checked }, { rebuild: true }); });
    byId('pref-hour12').addEventListener('change', function (e) { changed({ hour12: e.target.checked }, { rebuild: true }); });
    byId('pref-separator').addEventListener('change', function (e) { changed({ showSeparator: e.target.checked }); });
    byId('pref-analog-theme').addEventListener('change', function (e) { changed({ analogTheme: e.target.value }, { rebuild: true }); });
    byId('pref-ontop').addEventListener('change', function (e) { changed({ alwaysOnTop: e.target.checked }); });
    byId('pref-autostart').addEventListener('change', function (e) {
      var wanted = e.target.checked;
      state.autostart = wanted;
      Prefs.save({ autostart: wanted });
      Prefs.setAutostart(wanted).then(function (actual) {
        state.autostart = actual; Prefs.save({ autostart: actual });
        byId('pref-autostart').checked = actual;
      });
    });
    byId('pref-clickthrough').addEventListener('change', function (e) { changed({ clickThrough: e.target.checked }); });
    byId('pref-alarm-sound').addEventListener('change', function (e) { changed({ alarmSound: e.target.checked }); });
    byId('pref-backdrop').addEventListener('change', function (e) { changed({ backdrop: e.target.value }); });
    byId('pref-scale').addEventListener('input', function (e) { changed({ scale: Number(e.target.value) }, { lite: true }); });
    byId('pref-opacity').addEventListener('input', function (e) { changed({ opacity: Number(e.target.value) }, { lite: true }); });
    byId('pref-auto-timesync').addEventListener('change', function (e) { changed({ autoTimeSync: e.target.checked }); });
    byId('shutdown-action').addEventListener('change', function (e) { changed({ timerAction: e.target.value }); });
    byId('shutdown-mode').addEventListener('change', function (e) {
      changed({ timerMode: e.target.value });
      syncTimerModeUI();
    });

    // analog penetration: 复用「指针穿透」开关（外观 Tab 之外也提供入口通过样式）
    // 采用独立控件注入到表盘配色行下方（避免再改 HTML）
    (function () {
      var row = byId('analog-theme-row');
      if (!row) return;
      var wrap = document.createElement('label');
      wrap.id = 'analog-penetrate-row';
      wrap.hidden = true;
      var span = document.createElement('span'); span.setAttribute('data-i18n', 'analogPenetrate'); span.textContent = '指针穿透';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'dc-switch'; cb.id = 'pref-analog-penetrate';
      wrap.appendChild(span); wrap.appendChild(cb);
      row.parentNode.insertBefore(wrap, row.nextSibling);
      cb.addEventListener('change', function (e) { changed({ analogPenetrate: e.target.checked }); });
    })();

    // Alarms — explicit hour/minute selects (locale-independent)
    (function () {
      var h = byId('alarm-hour'), m = byId('alarm-minute'), i, o;
      for (i = 0; i < 24; i++) { o = document.createElement('option'); o.value = ('0' + i).slice(-2); o.textContent = ('0' + i).slice(-2); h.appendChild(o); }
      for (i = 0; i < 60; i++) { o = document.createElement('option'); o.value = ('0' + i).slice(-2); o.textContent = ('0' + i).slice(-2); m.appendChild(o); }
      h.value = '07'; m.value = '30';
    })();
    byId('alarm-add').addEventListener('click', function () {
      var v = byId('alarm-hour').value + ':' + byId('alarm-minute').value;
      if (!/^\d{2}:\d{2}$/.test(v)) return;
      var list = (state.alarms || []).slice();
      list.push({ id: Alarm.newId(), time: v, repeat: byId('alarm-repeat').checked });
      changed({ alarms: list });
    });
    byId('alarm-toast-close').addEventListener('click', hideAlarmToast);
    byId('alarm-dismiss').addEventListener('click', hideAlarmToast);
    byId('alarm-stop').addEventListener('click', hideAlarmToast);
    byId('alarm-mute').addEventListener('click', function () { Alarm.stopRing(); this.disabled = true; });
    byId('alarm-ring-seconds').addEventListener('change', function (e) {
      changed({ alarmRingSeconds: Math.min(600, Math.max(5, Number(e.target.value) || 30)) });
    });
    byId('timer-warn-mode').addEventListener('change', function (e) { changed({ timerWarnMode: e.target.value }); });
    byId('timer-warn-seconds').addEventListener('change', function (e) {
      changed({ timerWarnSeconds: Math.min(300, Math.max(5, Number(e.target.value) || 30)) });
    });

    // v0.7（未发布）：语音播报 —— 总开关 / 声音 / 语速 / 音量 / 提示音 / 规则 / 间隔 / 指定时刻 / 免打扰
    (function () {
      byId('pref-announce-enabled').addEventListener('change', function (e) { changed({ announceEnabled: e.target.checked }); });
      byId('pref-announce-voice').addEventListener('change', function (e) { changed({ announceVoice: e.target.value }); });
      byId('pref-announce-rate').addEventListener('input', function (e) { changed({ announceRate: Math.min(2, Math.max(0.5, Number(e.target.value) || 1)) }); });
      byId('pref-announce-volume').addEventListener('input', function (e) { changed({ announceVolume: Math.min(1, Math.max(0, Number(e.target.value) || 1)) }); });
      byId('pref-announce-chime').addEventListener('change', function (e) {
        changed({ announceChime: e.target.value });
        if (e.target.value !== 'none' && Alarm.playChime) Alarm.playChime(e.target.value);
      });
      byId('pref-announce-include-date').addEventListener('change', function (e) { changed({ announceIncludeDate: e.target.checked }); });
      byId('pref-announce-rule').addEventListener('change', function (e) { changed({ announceRule: e.target.value }); });
      byId('pref-announce-interval').addEventListener('change', function (e) { changed({ announceInterval: Math.min(120, Math.max(5, Number(e.target.value) || 30)) }); });
      byId('pref-announce-quiet').addEventListener('change', function (e) { changed({ announceQuiet: e.target.checked }); });
      byId('pref-announce-quiet-start').addEventListener('change', function (e) { changed({ announceQuietStart: e.target.value }); });
      byId('pref-announce-quiet-end').addEventListener('change', function (e) { changed({ announceQuietEnd: e.target.value }); });
      byId('announce-preview').addEventListener('click', function () {
        if (state.announceChime && state.announceChime !== 'none' && Alarm.playChime) Alarm.playChime(state.announceChime);
        Announce.preview(state);
      });
      (function () {
        var h = byId('announce-hour'), m = byId('announce-minute'), i, o;
        for (i = 0; i < 24; i++) { o = document.createElement('option'); o.value = ('0' + i).slice(-2); o.textContent = ('0' + i).slice(-2); h.appendChild(o); }
        for (i = 0; i < 60; i++) { o = document.createElement('option'); o.value = ('0' + i).slice(-2); o.textContent = ('0' + i).slice(-2); m.appendChild(o); }
        h.value = '09'; m.value = '00';
      })();
      byId('announce-time-add').addEventListener('click', function () {
        var v = byId('announce-hour').value + ':' + byId('announce-minute').value;
        if (!/^\d{2}:\d{2}$/.test(v)) return;
        var list = (state.announceTimes || []).slice();
        list.push({ id: 'an' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: v });
        changed({ announceTimes: list });
      });
    })();
    byId('alarm-snooze').addEventListener('click', function () {
      var list = (state.alarms || []).slice();
      list.push(Alarm.snooze());
      changed({ alarms: list });
      hideAlarmToast();
      var mb = byId('alarm-mute'); if (mb) mb.disabled = false;
    });

    // Timer (shutdown / reboot, duration / clock)
    byId('shutdown-start').addEventListener('click', function () {
      var L = STRINGS_LANG();
      if (!Prefs.isNative) { byId('shutdown-status').textContent = I18n.t(L, 'shutdownUnsupported'); return; }
      var action = byId('shutdown-action').value;
      var mode = byId('shutdown-mode').value;
      var mins = Number(byId('shutdown-min').value) || 60;
      var hhmm = byId('shutdown-time').value;
      var warnMode = byId('timer-warn-mode').value;
      var warnSeconds = Math.min(300, Math.max(5, Number(byId('timer-warn-seconds').value) || 30));
      Alarm.scheduleTimer(action, mode, mins, hhmm, warnMode, warnSeconds).then(function (label) {
        timerTarget = { label: label, action: action };
        updateTimerUI();
      }).catch(function (err) { byId('shutdown-status').textContent = String(err || 'failed'); });
    });
    byId('shutdown-cancel').addEventListener('click', function () {
      Alarm.cancelTimer().then(function () { timerTarget = null; updateTimerUI(); })
        .catch(function (err) { byId('shutdown-status').textContent = String(err || 'failed'); });
    });

    // Drag the bottom-right grip to resize.
    (function () {
      var grip = byId('resize-handle');
      if (!grip) return;
      var origin = null;
      grip.addEventListener('pointerdown', function (e) {
        origin = { x: e.clientX, y: e.clientY, scale: Number(state.scale) || 1 };
        grip.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
      });
      grip.addEventListener('pointermove', function (e) {
        if (!origin) return;
        var dx = e.clientX - origin.x, dy = e.clientY - origin.y;
        var next = Math.min(2.5, Math.max(0.5, origin.scale + (dx + dy) / 2 / BASE_W * 2));
        next = Math.round(next * 20) / 20;
        if (Math.abs(next - (Number(state.scale) || 1)) < 0.001) return;
        changed({ scale: next }, { lite: true });
      });
      function end(e) {
        if (!origin) return;
        origin = null;
        try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    })();
  }

  // Persist the window position from Rust's physical-space move events.
  // v0.6.1：必须用「本窗口作用域」监听。全局 event.listen 注册的是 Any target，
  // Tauri 的 Any 目标会绕过 emit_to_window 的窗口过滤，导致每个窗口都收到其它
  // 窗口的 tauri://move 并把别人的坐标写进自己的配置，进而被重新定位。
  function listenMoved() {
    if (!Prefs.isNative) return;
    try {
      var timer = null;
      function onMove(e) {
        var pos = e && e.payload;
        if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          Prefs.save({ x: Math.round(pos.x), y: Math.round(pos.y) });
        }, 400);
      }
      var wv = window.__TAURI__ && window.__TAURI__.webviewWindow;
      if (wv && typeof wv.getCurrentWebviewWindow === 'function') {
        wv.getCurrentWebviewWindow().onMoved(onMove);
        return;
      }
      var ev = window.__TAURI__ && window.__TAURI__.event;
      if (ev && typeof ev.listen === 'function') ev.listen('tauri://move', onMove);
    } catch (e) { /* ignore */ }
  }

  // v0.5：隐藏原生下拉箭头 → 滚轮直接切换选项。
  // 只绑定「选项型」下拉；文件选择/颜色等不涉及。点击仍可展开原生弹窗（可达性兼底），
  // 但日常用滚轮即可，避免 WebView2 频繁弹原生下拉造成的卡顿。
  function bindWheelSelects() {
    var sels = document.querySelectorAll('.settings select.dc-select');
    for (var i = 0; i < sels.length; i++) {
      (function (sel) {
        // 跳过会重建 DOM 的特殊下拉（切换时依赖 change 事件+opts.i18n 同步仍保留）
        sel.addEventListener('wheel', function (e) {
          e.preventDefault();
          var n = sel.options.length;
          if (n < 2) return;
          var idx = sel.selectedIndex;
          var dir = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
          var next = Math.min(n - 1, Math.max(0, idx + dir));
          if (next === idx) return;
          sel.selectedIndex = next;
          // 触发标准 change 事件，所有现有监听器照常生效
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, { passive: false });
      })(sels[i]);
    }
  }

  function startEngine(animate) {
    var secs = effectiveShowSeconds();
    engine = new Engine({
      onTick: onTick,
      now: displayNow,
      showSeconds: secs,
      hour12: state.hour12,
      animate: animate
    });
    var now = displayNow();
    ensureDom(engine.buildParts(now), true);
    engine.start();
  }

  function syncAnalogPenetrateControls() {
    var row = byId('analog-penetrate-row');
    var cb = byId('pref-analog-penetrate');
    if (row) row.hidden = state.style !== 'analog';
    if (cb) cb.checked = !!state.analogPenetrate;
  }

  async function boot() {
    state = await Prefs.load();
    applyRoot();
    bindControls();
    bindExtras();
    bindTargetSelector();
    refreshTargetOptions();
    syncControls();
    syncAnalogPenetrateControls();
    bindWheelSelects();   // v0.5：滚轮切换下拉

    if (!isSettingsWindow) {
      // 先建时钟 DOM 再测量 #app 内容尺寸，否则首帧可能量到空容器。
      startEngine(state.style === 'flip');
      setWindowSize(state.scale);
      if (Prefs.isNative) {
        // 字体加载会改变内容宽度；待首帧与字体就绪后再校正一次。
        setTimeout(function () { setWindowSize(state.scale); }, 250);
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(function () { setWindowSize(state.scale); }).catch(function () {});
        }
      }
    }

    // v0.6.2：原生弹窗按钮动作与定时任务提前提醒（仅主时钟窗口处理，避免多窗口重复弹窗）。
    if (Prefs.isNative && !isSettingsWindow && !isExtraWindow) {
      Prefs.listen('alert-action', function (p) {
        if (!p || !p.action) return;
        if (p.action === 'mute') { Alarm.stopRing(); return; }
        if (p.action === 'snooze') {
          var list = (state.alarms || []).slice();
          list.push(Alarm.snooze());
          changed({ alarms: list });
          hideAlarmToast();
          return;
        }
        if (p.action === 'terminate' && p.kind === 'timer') {
          timerTarget = null; updateTimerUI();
          hideAlarmToast();
          return;
        }
        hideAlarmToast();
      });
      Prefs.listen('timer-warning', function (p) {
        if (!p) return;
        var L = STRINGS_LANG();
        var actName = I18n.t(L, p.action === 'reboot' ? 'alertActionReboot' : 'alertActionShutdown');
        Prefs.showAlert({
          kind: 'timer',
          title: I18n.t(L, 'alertTimerTitle'),
          body: I18n.t(L, 'alertTimerBody').replace('%s', String(p.label || '')).replace('%s', String(p.warnSeconds || 30)).replace('%s', actName),
          note: '', lang: L,
          actions: [
            { action: 'terminate', label: I18n.t(L, 'alertTerminate') },
            { action: 'dismiss', label: I18n.t(L, 'alarmDismiss') }
          ]
        });
      });
    }

    Prefs.onChanged(applyRemotePrefs);
    // v0.6.1：从某个时钟窗口点齿轮时，已存在的设置窗口要切到该窗口。
    Prefs.listen('settings-target-changed', function (p) {
      if (!isSettingsWindow || !p || !p.id) return;
      Prefs.setActiveClock(p.id).then(function (fresh) {
        state = fresh;
        applyRoot(); syncControls(); syncAnalogPenetrateControls();
        refreshTargetOptions();
      }).catch(function () {});
    });
    // v0.6：某窗口配置变化时，只应用到自己 / 当前编辑目标
    Prefs.onWindowChanged(function (fresh) {
      var rebuild = fresh.style !== state.style || fresh.showSeconds !== state.showSeconds;
      state = fresh;
      if (isSettingsWindow) { applyRoot(); syncControls(); }
      else {
        applyRootLite();
        if (engine) engine.setOptions({
          showSeconds: effectiveShowSeconds(), hour12: state.hour12,
          animate: state.style === 'flip'
        });
        if (rebuild && engine) {
          var n = displayNow();
          ensureDom(engine.buildParts(n), true);
          renderFrame({ parts: engine.buildParts(n), now: n });
        }
        // v0.6.2：其它窗口/设置页改了本窗口配置后，重新测量内容尺寸并
        // 校正外壳，避免内容变宽被裁切、九宫格贴边失准。
        if (!isSettingsWindow) setWindowSize(state.scale);
      }
    });

    // v0.5.1：Tauri hide() 不触发 document.hidden，用 Rust 定向事件停/复表，
    // 避免隐藏的额外时钟窗口仍每秒 tick 占用资源。
    if (isExtraWindow) {
      Prefs.listen('clock-visibility', function (v) {
        if (!engine) return;
        if (v === false) engine.stop(); else engine.start();
      });
    }

    if (Prefs.isNative) {
      Prefs.getAutostart().then(function (actual) {
        state.autostart = actual; Prefs.save({ autostart: actual });
        byId('pref-autostart').checked = actual;
      });
      Alarm.timerStatus().then(function (v) {
        // v0.4 Rust 返回 {label, action}；兼容旧版返回字符串或 null。
        if (v && typeof v === 'object') timerTarget = { label: v.label, action: v.action };
        else if (typeof v === 'string') timerTarget = { label: v, action: 'shutdown' };
        else timerTarget = null;
        updateTimerUI();
      }).catch(function () { /* ignore */ });
      // 启动时自动校时（仅主时钟窗口，避免多窗口重复触发）
      if (state.autoTimeSync && !isSettingsWindow && !isExtraWindow) Prefs.syncSystemTime().catch(function () {});
    }
    // 样式切换时同步「指针穿透」行的显示
    var styleSel = byId('pref-style');
    if (styleSel) styleSel.addEventListener('change', function () { setTimeout(syncAnalogPenetrateControls, 0); });
    if (!isSettingsWindow) listenMoved();   // v0.6：每个时钟窗口各自记录位置
  }

  boot().catch(function (err) {
    try { console.warn('Desk Clock: prefs unavailable, using defaults', err); } catch (e) {}
    state = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    applyRoot(); bindControls(); bindExtras(); syncControls(); syncAnalogPenetrateControls();
    Prefs.onChanged(applyRemotePrefs);
    if (!isSettingsWindow) startEngine(true);
  });
})();
