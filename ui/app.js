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

  var STYLES = ['flip', 'minimal', 'neon', 'eink', 'segment', 'typewriter', 'glass', 'analog'];
  var BACKDROPS = ['none', 'blur', 'dim', 'light'];

  var app = document.getElementById('app');
  var clockEl = document.getElementById('clock');
  var gear = document.getElementById('gear');
  var settings = document.getElementById('settings');

  var state = null;
  var engine = null;
  var slots = {};
  var analog = null;
  var builtStyle = null;
  var builtPartsKey = '';
  var lastAlarmKey = '';
  var shutdownTarget = null;

  function byId(id) { return document.getElementById(id); }

  function effectiveColor() {
    if (state.color === CUSTOM) return state.customColor;
    return state.color || '';
  }

  function applyRoot() {
    var style = STYLES.indexOf(state.style) >= 0 ? state.style : 'flip';
    var backdrop = BACKDROPS.indexOf(state.backdrop) >= 0 ? state.backdrop : 'none';
    state.style = style;
    state.backdrop = backdrop;
    app.setAttribute('data-style', style);
    app.setAttribute('data-backdrop', backdrop);
    var sc = Number(state.scale) || 1;
    app.style.setProperty('--dc-scale', String(sc));
    app.style.opacity = String(Number(state.opacity));

    // Custom font/colour override the per-style RECOMMENDED defaults.
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
  }

  function setWindowSize(scale) {
    if (!Prefs.isNative) return;
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return;
    core.invoke('set_window_size', { width: BASE_W * scale, height: BASE_H * scale })
      .catch(function () { /* WM refused; keep the visual scale anyway */ });
  }

  function styleForParts(parts) {
    var key = [], i;
    for (i = 0; i < parts.length; i++) key.push(parts[i].type + ':' + parts[i].key);
    return key.join('|');
  }

  function clearClock() {
    while (clockEl.firstChild) clockEl.removeChild(clockEl.firstChild);
    slots = {};
    analog = null;
    builtPartsKey = '';
    builtStyle = null;
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
        span.className = 'glyph';
        span.textContent = p.value;
        slot.appendChild(span);
        slot.glyph = span;
      }
      clockEl.appendChild(slot);
      slots[p.key] = slot;
    }
    builtStyle = state.style;
    builtPartsKey = styleForParts(parts);
  }

  function buildAnalog(parts) {
    clockEl.className = 'analog';
    var i, tick, dial = document.createElement('div');
    dial.className = 'analog-dial';
    for (i = 0; i < 12; i++) {
      tick = document.createElement('div');
      tick.className = 'analog-tick' + (i % 3 === 0 ? ' major' : '');
      tick.style.transform = 'rotate(' + (i * 30) + 'deg)';
      dial.appendChild(tick);
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
      p = parts[i];
      slot = slots[p.key];
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
    maybeFireAlarms(payload.now);
  }

  function maybeFireAlarms(now) {
    if (Alarm.isFiring()) return;
    var hm = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
    var hits = (state.alarms || []).filter(function (a) { return a.time === hm; });
    if (!hits.length) { lastAlarmKey = ''; return; }
    var key = hm + '|' + now.toDateString() + '|' + hits.map(function (a) { return a.id; }).join(',');
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
    try {
      var AC = window.__TAURI__ && window.__TAURI__.webviewWindow;
      if (AC && AC.getCurrentWebviewWindow) {
        AC.getCurrentWebviewWindow().setFocus().catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  function hideAlarmToast() {
    var toast = byId('alarm-toast');
    if (toast) toast.hidden = true;
    Alarm.setFiring(false);
  }

  function STRINGS_LANG() { return (state && state.lang) || 'zh-CN'; }

  function renderAlarmList() {
    var box = byId('alarm-list');
    if (!box) return;
    box.textContent = '';
    var L = STRINGS_LANG();
    (state.alarms || []).forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'alarm-row';
      var span = document.createElement('span');
      span.textContent = a.time + (a.repeat ? ' · ' + I18n.t(L, 'alarmRepeat') : '');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = I18n.t(L, 'alarmRemove');
      btn.addEventListener('click', function () {
        state.alarms = (state.alarms || []).filter(function (x) { return x.id !== a.id; });
        Prefs.save({ alarms: state.alarms });
        renderAlarmList();
      });
      row.appendChild(span); row.appendChild(btn);
      box.appendChild(row);
    });
    if (!(state.alarms || []).length) {
      var empty = document.createElement('div');
      empty.className = 'alarm-empty';
      empty.textContent = '—';
      box.appendChild(empty);
    }
  }

  function updateShutdownUI() {
    var L = STRINGS_LANG();
    var status = byId('shutdown-status');
    var startBtn = byId('shutdown-start');
    var cancelBtn = byId('shutdown-cancel');
    if (!status) return;
    if (shutdownTarget) {
      status.textContent = I18n.t(L, 'shutdownAt').replace('%s', shutdownTarget);
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
    byId('pref-ontop').checked = !!state.alwaysOnTop;
    byId('pref-autostart').checked = !!state.autostart;
    byId('pref-backdrop').value = state.backdrop;
    byId('pref-scale').value = String(state.scale);
    byId('pref-opacity').value = String(state.opacity);
    var out = byId('scale-out');
    if (out) out.textContent = Math.round((Number(state.scale) || 1) * 100) + '%';
    renderAlarmList();
    updateShutdownUI();
  }

  function changed(patch, opts) {
    var k;
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
    }
    Prefs.save(patch);
    applyRoot();

    engine.setOptions({
      showSeconds: state.showSeconds,
      hour12: state.hour12,
      animate: state.style === 'flip'
    });
    if (patch.scale !== undefined) setWindowSize(state.scale);
    if (patch.lang !== undefined) { syncControls(); }
    if (opts && opts.rebuild) {
      var now = new Date();
      var parts = engine.buildParts(now);
      ensureDom(parts, true);
      renderFrame({ parts: parts, now: now });
    }
    syncControls();
  }

  function resetDefaults() {
    var fresh = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    // Keep the user's chosen language and window position across a reset.
    fresh.lang = state.lang;
    fresh.x = state.x; fresh.y = state.y;
    state = fresh;
    Prefs.save(fresh);
    applyRoot();
    setWindowSize(state.scale);
    engine.setOptions({
      showSeconds: state.showSeconds, hour12: state.hour12,
      animate: state.style === 'flip'
    });
    var now = new Date();
    var parts = engine.buildParts(now);
    ensureDom(parts, true);
    renderFrame({ parts: parts, now: now });
    syncControls();
    var gearBtn = byId('gear');
    if (gearBtn) {
      var old = gearBtn.title;
      gearBtn.title = I18n.t(state.lang, 'resetDone');
      setTimeout(function () { gearBtn.title = old; }, 1800);
    }
  }

  function bindControls() {
    gear.addEventListener('click', function () { settings.hidden = !settings.hidden; });
    function close() { settings.hidden = true; }
    byId('settings-close').addEventListener('click', close);
    byId('settings-close-2').addEventListener('click', close);
    byId('reset-defaults').addEventListener('click', resetDefaults);

    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        resetDefaults();
      }
    });

    byId('pref-lang').addEventListener('change', function (e) { changed({ lang: e.target.value }); });
    byId('pref-style').addEventListener('change', function (e) {
      changed({ style: e.target.value }, { rebuild: true });
    });
    byId('pref-font').addEventListener('change', function (e) {
      var v = e.target.value;
      if (v === CUSTOM) changed({ font: CUSTOM, customFont: byId('pref-font-custom').value });
      else changed({ font: v });
    });
    byId('pref-font-custom').addEventListener('change', function (e) {
      changed({ font: CUSTOM, customFont: e.target.value });
    });
    byId('pref-color').addEventListener('change', function (e) {
      var v = e.target.value;
      if (v === CUSTOM) changed({ color: CUSTOM, customColor: byId('pref-color-custom').value });
      else changed({ color: v });
    });
    byId('pref-color-custom').addEventListener('input', function (e) {
      changed({ color: CUSTOM, customColor: e.target.value });
    });
    byId('pref-seconds').addEventListener('change', function (e) {
      changed({ showSeconds: e.target.checked }, { rebuild: true });
    });
    byId('pref-hour12').addEventListener('change', function (e) { changed({ hour12: e.target.checked }); });
    byId('pref-ontop').addEventListener('change', function (e) {
      changed({ alwaysOnTop: e.target.checked });
    });
    byId('pref-autostart').addEventListener('change', function (e) {
      var wanted = e.target.checked;
      state.autostart = wanted;
      Prefs.save({ autostart: wanted });
      Prefs.setAutostart(wanted).then(function (actual) {
        state.autostart = actual;
        Prefs.save({ autostart: actual });
        byId('pref-autostart').checked = actual;
      });
    });
    byId('pref-backdrop').addEventListener('change', function (e) { changed({ backdrop: e.target.value }); });
    byId('pref-scale').addEventListener('input', function (e) { changed({ scale: Number(e.target.value) }); });
    byId('pref-opacity').addEventListener('input', function (e) { changed({ opacity: Number(e.target.value) }); });

    // Alarms — explicit hour/minute selects so the label never depends on the
    // OS locale (input[type=time] renders "AM/PM" under en-US WebView2).
    (function () {
      var h = byId('alarm-hour'), m = byId('alarm-minute'), i, o;
      for (i = 0; i < 24; i++) {
        o = document.createElement('option');
        o.value = ('0' + i).slice(-2); o.textContent = ('0' + i).slice(-2);
        h.appendChild(o);
      }
      for (i = 0; i < 60; i++) {
        o = document.createElement('option');
        o.value = ('0' + i).slice(-2); o.textContent = ('0' + i).slice(-2);
        m.appendChild(o);
      }
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
    byId('alarm-snooze').addEventListener('click', function () {
      var list = (state.alarms || []).slice();
      list.push(Alarm.snooze());
      changed({ alarms: list });
      hideAlarmToast();
    });

    // Shutdown timer
    byId('shutdown-start').addEventListener('click', function () {
      var mins = Number(byId('shutdown-min').value) || 60;
      if (!Prefs.isNative) {
        byId('shutdown-status').textContent = I18n.t(STRINGS_LANG(), 'shutdownUnsupported');
        return;
      }
      Alarm.scheduleShutdown(mins).then(function (target) {
        shutdownTarget = target;
        updateShutdownUI();
      }).catch(function (err) {
        byId('shutdown-status').textContent = String(err || 'failed');
      });
    });
    byId('shutdown-cancel').addEventListener('click', function () {
      Alarm.cancelShutdown().then(function () {
        shutdownTarget = null;
        updateShutdownUI();
      }).catch(function (err) {
        byId('shutdown-status').textContent = String(err || 'failed');
      });
    });

    // Drag the bottom-right grip to resize.
    (function () {
      var grip = byId('resize-handle');
      if (!grip) return;
      var origin = null;
      grip.addEventListener('pointerdown', function (e) {
        origin = { x: e.clientX, y: e.clientY, scale: Number(state.scale) || 1 };
        grip.setPointerCapture(e.pointerId);
        e.preventDefault(); e.stopPropagation();
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
      showSeconds: state.showSeconds,
      hour12: state.hour12,
      animate: animate
    });
    ensureDom(engine.buildParts(new Date()), true);
    engine.start();
  }

  async function boot() {
    state = await Prefs.load();
    applyRoot();
    bindControls();
    syncControls();
    setWindowSize(state.scale);   // restore remembered size on startup
    startEngine(state.style === 'flip');

    if (Prefs.isNative) {
      Prefs.getAutostart().then(function (actual) {
        state.autostart = actual;
        Prefs.save({ autostart: actual });
        byId('pref-autostart').checked = actual;
      });
      Alarm.shutdownStatus().then(function (v) {
        shutdownTarget = v || null;
        updateShutdownUI();
      }).catch(function () { /* ignore */ });
    }
    listenMoved();
  }

  boot().catch(function (err) {
    try { console.warn('Desk Clock: prefs unavailable, using defaults', err); } catch (e) {}
    state = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    applyRoot();
    bindControls();
    syncControls();
    startEngine(true);
  });
})();
