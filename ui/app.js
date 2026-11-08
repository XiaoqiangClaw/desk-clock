(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var DC = window.DeskClock;
  var Prefs = DC.Prefs;
  var FlipDigit = DC.FlipDigit;
  var Engine = DC.Engine;

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

  function byId(id) { return document.getElementById(id); }

  function applyRoot() {
    var style = STYLES.indexOf(state.style) >= 0 ? state.style : 'flip';
    var backdrop = BACKDROPS.indexOf(state.backdrop) >= 0 ? state.backdrop : 'none';
    state.style = style;
    state.backdrop = backdrop;
    app.setAttribute('data-style', style);
    app.setAttribute('data-backdrop', backdrop);
    app.style.setProperty('--dc-scale', String(Number(state.scale) || 1));
    app.style.opacity = String(Number(state.opacity));
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

  function syncControls() {
    byId('pref-style').value = state.style;
    byId('pref-seconds').checked = !!state.showSeconds;
    byId('pref-hour12').checked = !!state.hour12;
    byId('pref-ontop').checked = !!state.alwaysOnTop;
    byId('pref-autostart').checked = !!state.autostart;
    byId('pref-backdrop').value = state.backdrop;
    byId('pref-scale').value = String(state.scale);
    byId('pref-opacity').value = String(state.opacity);
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
    if (opts && opts.rebuild) {
      var now = new Date();
      var parts = engine.buildParts(now);
      ensureDom(parts, true);
      renderFrame({ parts: parts, now: now });
    }
    syncControls();
  }

  function bindControls() {
    gear.addEventListener('click', function () { settings.hidden = !settings.hidden; });
    function close() { settings.hidden = true; }
    byId('settings-close').addEventListener('click', close);
    byId('settings-close-2').addEventListener('click', close);

    byId('pref-style').addEventListener('change', function (e) {
      changed({ style: e.target.value }, { rebuild: true });
    });
    byId('pref-seconds').addEventListener('change', function (e) {
      changed({ showSeconds: e.target.checked }, { rebuild: true });
    });
    byId('pref-hour12').addEventListener('change', function (e) {
      changed({ hour12: e.target.checked });
    });
    byId('pref-ontop').addEventListener('change', function (e) {
      // Rust applies setAlwaysOnTop inside set_prefs; no JS window API needed.
      changed({ alwaysOnTop: e.target.checked });
    });
    byId('pref-autostart').addEventListener('change', function (e) {
      var wanted = e.target.checked;
      state.autostart = wanted;
      Prefs.save({ autostart: wanted });
      // Reflect the system's REAL state (may differ if registration failed).
      Prefs.setAutostart(wanted).then(function (actual) {
        state.autostart = actual;
        Prefs.save({ autostart: actual });
        byId('pref-autostart').checked = actual;
      });
    });
    byId('pref-backdrop').addEventListener('change', function (e) {
      changed({ backdrop: e.target.value });
    });
    byId('pref-scale').addEventListener('input', function (e) {
      changed({ scale: Number(e.target.value) });
    });
    byId('pref-opacity').addEventListener('input', function (e) {
      changed({ opacity: Number(e.target.value) });
    });
  }

  // Persist the window position from Rust's physical-space move events.
  function listenMoved() {
    if (!Prefs.isNative) return;
    try {
      var core = window.__TAURI__ && window.__TAURI__.core;
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
      onTick: renderFrame,
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
    startEngine(state.style === 'flip');

    // Autostart checkbox must reflect the OS, not just the stored pref.
    if (Prefs.isNative) {
      Prefs.getAutostart().then(function (actual) {
        state.autostart = actual;
        Prefs.save({ autostart: actual });
        byId('pref-autostart').checked = actual;
      });
    }
    listenMoved();
  }

  boot().catch(function (err) {
    // Degraded mode: never leave a blank window, even if prefs are unreadable.
    try { console.warn('Desk Clock: prefs unavailable, using defaults', err); } catch (e) {}
    state = JSON.parse(JSON.stringify(Prefs.DEFAULTS));
    applyRoot();
    bindControls();
    syncControls();
    startEngine(true);
  });
})();
