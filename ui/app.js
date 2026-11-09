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

  // Native window base size at scale=1 (mirrors tauri.conf.json).
  var BASE_W = 640, BASE_H = 220;
  var CUSTOM = '__custom__';
  var APP_VERSION = '0.4.0';
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
    { label: 'UTC+0  伦敦', offset: 0 },
    { label: 'UTC+1  巴黎/柏林', offset: 60 },
    { label: 'UTC+3  莫斯科', offset: 180 },
    { label: 'UTC+4  迪拜', offset: 240 },
    { label: 'UTC+5:30 印度', offset: 330 },
    { label: 'UTC+8  北京/新加坡', offset: 480 },
    { label: 'UTC+9  东京', offset: 540 },
    { label: 'UTC+10 悉尼', offset: 600 },
    { label: 'UTC+12 奥克兰', offset: 720 }
  ];

  var app = document.getElementById('app');
  var clockEl = document.getElementById('clock');
  var gear = document.getElementById('gear');

  var state = null;
  var engine = null;
  var slots = {};
  var analog = null;
  var builtStyle = null;
  var builtPartsKey = '';
  var lastAlarmKey = '';
  var timerTarget = null;   // {label, action}
  var privStatus = null;

  // v0.3 dual-view + v0.4 extra clock windows.
  // __DC_VIEW__ === 'settings' -> independent settings window.
  // __DC_EXTRA__ === 1        -> an extra timezone clock window.
  var isSettingsWindow = window.__DC_VIEW__ === 'settings';
  var isExtraWindow = !!window.__DC_EXTRA__;
  var tzOffset = (typeof window.__DC_TZ_OFFSET__ === 'number') ? window.__DC_TZ_OFFSET__ : null;
  var tzLabel = window.__DC_TZ_LABEL__ || '';

  var settings = document.getElementById('settings');

  if (isSettingsWindow) {
    document.body.setAttribute('data-view', 'settings');
    document.title = 'Desk Clock · 设置';
    settings.hidden = false;
  } else if (isExtraWindow) {
    document.body.setAttribute('data-view', 'extra');
    document.title = 'Desk Clock · ' + (tzLabel || '时区时钟');
    // 额外窗口不显示齿轮/缩放柄/设置面板（设置是全局唯一窗口）
    if (gear) gear.style.display = 'none';
    var rh0 = document.getElementById('resize-handle');
    if (rh0) rh0.style.display = 'none';
  }

  function byId(id) { return document.getElementById(id); }
  function STRINGS_LANG() { return (state && state.lang) || 'zh-CN'; }

  function effectiveColor() {
    if (state.color === CUSTOM) return state.customColor;
    return state.color || '';
  }

  // v0.4 多时区：构造一个「本地 getter 返回目标墙上时间」的 Date。
  // display UTC = UTC + targetOffset；而本地 getter = UTC + localOffset，
  // 因此把 epoch 平移 (targetOffset - localOffset) 即可。
  // getTimezoneOffset() = UTC - local（分钟），故 localOffset = -getTimezoneOffset()。
  function displayNow() {
    var now = new Date();
    if (tzOffset === null) return now;
    return new Date(now.getTime() + (tzOffset + now.getTimezoneOffset()) * 60000);
  }

  function applyRoot() {
    var style = STYLES.indexOf(state.style) >= 0 ? state.style : 'flip';
    var backdrop = BACKDROPS.indexOf(state.backdrop) >= 0 ? state.backdrop : 'none';
    state.style = style;
    state.backdrop = backdrop;
    app.setAttribute('data-style', style);
    app.setAttribute('data-backdrop', backdrop);
    app.setAttribute('data-show-sep', String(!!state.showSeparator));
    app.setAttribute('data-analog-theme', state.analogTheme === 'light' ? 'light' : 'dark');
    app.setAttribute('data-analog-penetrate', String(!!state.analogPenetrate));

    var sc = Number(state.scale) || 1;
    app.style.setProperty('--dc-scale', String(sc));

    // 🔴 关键修复：不透明度只作用于时钟窗口，设置窗口永远清晰。
    // 浏览器预览里设置面板是 #app 的子元素，同样不应被半透明化，
    // 因此仅在「纯时钟窗口」（非设置窗口、且设置面板未打开）应用 opacity。
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
    I18n.apply(state.lang);
    if (isSettingsWindow) document.title = state.lang === 'en' ? 'Desk Clock · Settings' : 'Desk Clock · 设置';
    var vb = byId('ver-badge'); if (vb) vb.textContent = 'v' + APP_VERSION;
    var av = byId('about-version'); if (av) av.textContent = APP_VERSION;
  }

  function isOwnPanelOpen() {
    // 浏览器预览的嵌入式面板打开时，不应用窗口透明度（否则设置也跟着透明）
    return !isSettingsWindow && !isExtraWindow && settings && !settings.hidden;
  }

  function setWindowSize(scale) {
    if (!Prefs.isNative || isSettingsWindow || isExtraWindow) return;
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return;
    core.invoke('set_window_size', { width: BASE_W * scale, height: BASE_H * scale })
      .catch(function () { /* WM refused; keep the visual scale anyway */ });
  }

  // ------------------------------------------- cross-window preference sync
  function applyRemotePrefs(next) {
    var rebuild = next.style !== state.style ||
      next.showSeconds !== state.showSeconds ||
      next.hour12 !== state.hour12 ||
      next.analogTheme !== state.analogTheme;
    state = Prefs.normalize(next);
    applyRoot();
    if (engine) {
      engine.setOptions({
        showSeconds: state.showSeconds, hour12: state.hour12,
        animate: state.style === 'flip'
      });
    }
    syncControls();
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
    if (!box) return;
    var L = STRINGS_LANG();
    var s = privStatus;
    if (!s) {
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
    Prefs.privilegeStatus().then(function (s) {
      privStatus = s; renderPrivilege();
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
      var box = byId('settings-panels'); if (box) box.scrollTop = 0;
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

  // ------------------------------------------- multi-timezone extra windows
  function renderExtraList() {
    var box = byId('extra-list');
    if (!box) return;
    var L = STRINGS_LANG();
    box.textContent = '';
    var list = state.extraClocks || [];
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'alarm-empty';
      empty.textContent = I18n.t(L, 'extraEmpty');
      box.appendChild(empty);
      return;
    }
    list.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'extra-row';
      var span = document.createElement('span');
      span.textContent = c.label + '  (UTC' + (c.offset >= 0 ? '+' : '') + (c.offset / 60) + ')';
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'extra-del'; btn.textContent = '×';
      btn.title = '关闭';
      btn.addEventListener('click', function () {
        var next = (state.extraClocks || []).filter(function (x) { return x.id !== c.id; });
        changed({ extraClocks: next });
        if (Prefs.isNative) Prefs.closeClockWindow(c.id).catch(function () {});
      });
      row.appendChild(span); row.appendChild(btn);
      box.appendChild(row);
    });
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
      Prefs.restartElevated().catch(function (err) {
        b.disabled = false; b.textContent = I18n.t(L, 'permElevateNow');
        var s = byId('perm-status'); if (s) s.textContent = String(err || 'failed');
      });
    });
    byId('perm-quit').addEventListener('click', function () { Prefs.quitApp(); });

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

    // Extra timezone windows
    (function () {
      var sel = byId('extra-zone');
      if (sel) {
        ZONES.forEach(function (z) {
          var o = document.createElement('option');
          o.value = String(z.offset); o.textContent = z.label;
          sel.appendChild(o);
        });
        sel.value = '0';
      }
      byId('extra-add').addEventListener('click', function () {
        var labelEl = byId('extra-label');
        var label = (labelEl.value || '').trim() || (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : 'Clock');
        var offset = Number(sel.value) || 0;
        var list = (state.extraClocks || []).slice();
        var id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        list.push({ id: id, label: label, offset: offset });
        changed({ extraClocks: list });
        labelEl.value = '';
        if (Prefs.isNative) Prefs.addClockWindow(id, label, offset).catch(function () {});
        else {
          var st = document.createElement('div');
          st.className = 'field-note';
          st.textContent = I18n.t(STRINGS_LANG(), 'extraBrowserOnly');
          var box = byId('extra-list'); if (box) box.appendChild(st);
        }
      });
    })();

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
    if (!isSettingsWindow && !isExtraWindow) maybeFireAlarms(payload.now);
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

  function showAlarmToast(text) {
    var toast = byId('alarm-toast');
    if (!toast) return;
    var L = STRINGS_LANG();
    byId('alarm-toast-body').textContent = I18n.t(L, 'alarmMsg').replace('%s', text);
    toast.hidden = false;
    Alarm.setFiring(true);
    if (state.alarmSound) Alarm.startRing();
    try {
      var AC = window.__TAURI__ && window.__TAURI__.webviewWindow;
      if (AC && AC.getCurrentWebviewWindow) AC.getCurrentWebviewWindow().setFocus().catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function hideAlarmToast() {
    var toast = byId('alarm-toast');
    if (toast) toast.hidden = true;
    Alarm.setFiring(false);
    Alarm.stopRing();
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
    byId('shutdown-action').value = state.timerAction;
    byId('shutdown-mode').value = state.timerMode;
    byId('shutdown-duration-row').hidden = state.timerMode !== 'duration';
    byId('shutdown-clock-row').hidden = state.timerMode !== 'clock';
    byId('pref-auto-timesync').checked = !!state.autoTimeSync;
    var out = byId('scale-out');
    if (out) out.textContent = Math.round((Number(state.scale) || 1) * 100) + '%';
    renderAlarmList();
    renderExtraList();
    updateTimerUI();
  }

  function changed(patch, opts) {
    var k;
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
    Prefs.save(patch);
    applyRoot();

    if (engine) {
      engine.setOptions({
        showSeconds: state.showSeconds, hour12: state.hour12,
        animate: state.style === 'flip'
      });
    }
    if (patch.scale !== undefined) setWindowSize(state.scale);
    if (patch.lang !== undefined) { syncControls(); renderPrivilege(); }
    if (patch.style !== undefined && byId('analog-theme-row')) byId('analog-theme-row').hidden = state.style !== 'analog';
    if (patch.clickThrough !== undefined && Prefs.isNative) Prefs.setClickThrough(!!patch.clickThrough).catch(function () {});
    if (opts && opts.rebuild && engine) {
      var now = displayNow();
      var parts = engine.buildParts(now);
      ensureDom(parts, true);
      renderFrame({ parts: parts, now: now });
    }
    syncControls();
  }

  function resetDefaults() {
    var fresh = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    fresh.lang = state.lang;
    fresh.x = state.x; fresh.y = state.y;
    fresh.runAsAdmin = !!state.runAsAdmin;
    state = fresh;
    Prefs.save(fresh);
    applyRoot();
    setWindowSize(state.scale);
    if (engine) engine.setOptions({ showSeconds: state.showSeconds, hour12: state.hour12, animate: state.style === 'flip' });
    if (Prefs.isNative) Prefs.setClickThrough(false).catch(function () {});
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

  function bindControls() {
    gear.addEventListener('click', function () {
      if (isExtraWindow) return;
      if (Prefs.isNative && !isSettingsWindow) {
        Prefs.openSettings().catch(function () { settings.hidden = !settings.hidden; });
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
    byId('settings-close-2').addEventListener('click', close);
    byId('reset-defaults').addEventListener('click', resetDefaults);

    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); resetDefaults(); }
    });

    byId('pref-lang').addEventListener('change', function (e) { changed({ lang: e.target.value }); });
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
    byId('pref-scale').addEventListener('input', function (e) { changed({ scale: Number(e.target.value) }); });
    byId('pref-opacity').addEventListener('input', function (e) { changed({ opacity: Number(e.target.value) }); });
    byId('pref-auto-timesync').addEventListener('change', function (e) { changed({ autoTimeSync: e.target.checked }); });
    byId('shutdown-action').addEventListener('change', function (e) { changed({ timerAction: e.target.value }); });
    byId('shutdown-mode').addEventListener('change', function (e) { changed({ timerMode: e.target.value }); });

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
    byId('alarm-mute').addEventListener('click', function () { Alarm.stopRing(); this.disabled = true; });
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
      Alarm.scheduleTimer(action, mode, mins, hhmm).then(function (label) {
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
        changed({ scale: next });
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
  function listenMoved() {
    if (!Prefs.isNative) return;
    try {
      var event = window.__TAURI__ && window.__TAURI__.event;
      if (!event || typeof event.listen !== 'function') return;
      var timer = null;
      event.listen('tauri://move', function (e) {
        var pos = e && e.payload;
        if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          Prefs.save({ x: Math.round(pos.x), y: Math.round(pos.y) });
        }, 400);
      });
    } catch (e) { /* ignore */ }
  }

  function startEngine(animate) {
    engine = new Engine({
      onTick: onTick,
      now: displayNow,
      showSeconds: state.showSeconds,
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
    syncControls();
    syncAnalogPenetrateControls();

    if (!isSettingsWindow) {
      setWindowSize(state.scale);
      startEngine(state.style === 'flip');
    }

    Prefs.onChanged(applyRemotePrefs);

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
      if (state.clickThrough) Prefs.setClickThrough(true).catch(function () {});
      // 启动时自动校时（仅主时钟窗口，避免多窗口重复触发）
      if (state.autoTimeSync && !isSettingsWindow && !isExtraWindow) Prefs.syncSystemTime().catch(function () {});
    }
    // 样式切换时同步「指针穿透」行的显示
    var styleSel = byId('pref-style');
    if (styleSel) styleSel.addEventListener('change', function () { setTimeout(syncAnalogPenetrateControls, 0); });
    if (!isSettingsWindow && !isExtraWindow) listenMoved();
  }

  boot().catch(function (err) {
    try { console.warn('Desk Clock: prefs unavailable, using defaults', err); } catch (e) {}
    state = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    applyRoot(); bindControls(); bindExtras(); syncControls(); syncAnalogPenetrateControls();
    Prefs.onChanged(applyRemotePrefs);
    if (!isSettingsWindow) startEngine(true);
  });
})();
