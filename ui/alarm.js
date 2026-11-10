(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var SNOOZE_MS = 5 * 60 * 1000;
  var firing = null;

  // --------------------------------------------------------------- ring tone
  var audioCtx = null;
  var ringTimer = null;
  var ringOn = false;
  var customBlobUrl = null;   // v0.5: 用户自定义音频的 blob URL（仅本机内存/本地存储）
  var currentTone = 'gentle'; // gentle|bell|tick|rise|chord|custom
  var customEl = null;        // 播放自定义音频的 <audio> 元素

  var ALLOWED_TONES = ['gentle', 'bell', 'tick', 'rise', 'chord', 'custom'];

  function ensureCtx() {
    if (audioCtx) return audioCtx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  function stopRing() {
    ringOn = false;
    if (ringTimer !== null) { clearInterval(ringTimer); ringTimer = null; }
    if (customEl) { try { customEl.pause(); } catch (e) {} }
  }

  function nowHM() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function newId() { return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function invoke(cmd, args) {
    var core = window.__TAURI__ && window.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return Promise.reject(new Error('no tauri'));
    return core.invoke(cmd, args === undefined ? {} : args);
  }

  // ------------------------------------------------- tone synthesis helpers
  function playNote(freq, start, dur, peak) {
    var ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak || 0.16, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(start); osc.stop(start + dur + 0.02);
  }

  function chime(type) {
    var ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var t0 = ctx.currentTime, i;
    switch (type || currentTone) {
      case 'gentle':   // 柔和三连：A5 C#6 E6
        [880, 1108.73, 1318.51].forEach(function (f, j) { playNote(f, t0 + j * 0.18, 0.42); });
        break;
      case 'bell':     // 清脆叮咚：两个四度音快速连击（带泛音）
        [659.25, 880].forEach(function (f, j) {
          playNote(f, t0 + j * 0.12, 0.35, 0.14);
          playNote(f * 1.5, t0 + j * 0.12 + 0.05, 0.30, 0.07);
        });
        break;
      case 'tick':     // 电子滴答：三个方波短脉冲
        for (i = 0; i < 3; i++) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'square'; o.frequency.value = 880;
          g.gain.setValueAtTime(0.0001, t0 + i * 0.25);
          g.gain.exponentialRampToValueAtTime(0.06, t0 + i * 0.25 + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.25 + 0.08);
          o.connect(g); g.connect(ctx.destination);
          o.start(t0 + i * 0.25); o.stop(t0 + i * 0.25 + 0.10);
        }
        break;
      case 'rise':     // 上升音阶：C E G C(高)
        [523.25, 659.25, 783.99, 1046.50].forEach(function (f, j) { playNote(f, t0 + j * 0.14, 0.28, 0.13); });
        break;
      case 'chord':    // 和弦钟声：大九和弦同时发声后衰减
        [523.25, 659.25, 783.99, 987.77, 1174.66].forEach(function (f) { playNote(f, t0, 0.85, 0.09); });
        break;
      case 'custom':   // 由 <audio> 元素处理
        break;
    }
  }

  function playCustom() {
    if (!customBlobUrl) { chime('gentle'); return; }
    if (!customEl) {
      customEl = document.createElement('audio');
      customEl.id = 'alarm-custom-audio';
      customEl.loop = true;
      customEl.preload = 'auto';
      document.body.appendChild(customEl);
    }
    if (customEl.src !== customBlobUrl) customEl.src = customBlobUrl;
    try { customEl.currentTime = 0; customEl.play(); }
    catch (e) { chime('gentle'); }
  }

  function startRing(forceTone) {
    stopRing();
    ringOn = true;
    if (forceTone && ALLOWED_TONES.indexOf(forceTone) >= 0) currentTone = forceTone;
    if (currentTone === 'custom' && customBlobUrl) {
      playCustom();
      return;
    }
    chime(currentTone);
    ringTimer = setInterval(function () { if (ringOn) chime(currentTone); }, 2100);
  }

  // Called once per clock tick. Returns the list of alarms that just fired.
  function check(state, saveFn) {
    if (firing) return [];
    var hm = nowHM();
    var hits = (state.alarms || []).filter(function (a) { return a.time === hm; });
    if (!hits.length) return [];
    var last = state._lastAlarmKey || '';
    var key = hm + '|' + new Date().toDateString() + '|' + hits.map(function (a) { return a.id; }).join(',');
    if (key === last) return [];
    state._lastAlarmKey = key;
    var remaining = (state.alarms || []).filter(function (a) { return a.repeat || a.time !== hm; });
    saveFn({ alarms: remaining });
    return hits.map(function (a) { return { id: a.id, time: a.time, label: a.time }; });
  }

  function snooze() {
    var d = new Date(Date.now() + SNOOZE_MS);
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return { id: newId(), time: hm, repeat: false };
  }

  function minutesUntil(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return 0;
    var now = new Date();
    var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      Number(m[1]), Number(m[2]), 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000));
  }

  function scheduleTimer(action, mode, minutes, hhmm, warnMode, warnSeconds) {
    var mins = mode === 'clock' ? minutesUntil(hhmm) : (Number(minutes) || 0);
    if (mins < 1) return Promise.reject(new Error('invalid time'));
    var d = new Date(Date.now() + mins * 60000);
    var label = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return invoke('schedule_timer', {
      action: action, minutes: mins, label: label,
      warnMode: warnMode === 'silent' ? 'silent' : 'popup',
      warnSeconds: Math.min(300, Math.max(5, Number(warnSeconds) || 30))
    });
  }

  function cancelTimer() { return invoke('cancel_timer'); }
  function timerStatus() { return invoke('get_timer_status'); }

  // 自定义音频以 base64 存在 localStorage（≤500KB，经 UI 校验），
  // 启动时还原为 blob URL；不写进 prefs.json，避免污染跨窗口同步。
  var CUSTOM_KEY = 'deskclock.alarm.customAudioB64';

  function readCustomFromStorage() {
    try {
      var raw = localStorage.getItem(CUSTOM_KEY);
      if (!raw) return null;
      var bin = atob(raw);
      var buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(0);
      return URL.createObjectURL(new Blob([buf], { type: 'audio/*' }));
    } catch (e) { return null; }
  }

  function saveCustomToStorage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || file.size > 500 * 1024) { reject(new Error('too big')); return; }
      if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name || '')) {
        reject(new Error('not audio')); return;
      }
      var r = new FileReader();
      r.onload = function () {
        try {
          var b64 = String(r.result).split(',')[1];
          localStorage.setItem(CUSTOM_KEY, b64);
          resolve(b64);
        } catch (e) { reject(e); }
      };
      r.onerror = function () { reject(new Error('read failed')); };
      r.readAsDataURL(file);
    });
  }

  customBlobUrl = readCustomFromStorage();

  window.DeskClock.Alarm = {
    check: check, snooze: snooze, newId: newId,
    setFiring: function (v) { firing = v; },
    isFiring: function () { return !!firing; },
    startRing: startRing, stopRing: stopRing,
    minutesUntil: minutesUntil,
    scheduleTimer: scheduleTimer, cancelTimer: cancelTimer, timerStatus: timerStatus,
    scheduleShutdown: function (mins) { return scheduleTimer('shutdown', 'duration', mins, ''); },
    cancelShutdown: cancelTimer,
    shutdownStatus: timerStatus,
    ALLOWED_TONES: ALLOWED_TONES,
    getCurrentTone: function () { return currentTone; },
    setCurrentTone: function (t) { if (ALLOWED_TONES.indexOf(t) >= 0) currentTone = t; },
    // 自定义音频 API
    getHasCustom: function () { return !!customBlobUrl; },
    setCustomAudioUrl: function (url) { customBlobUrl = url; },
    clearCustomAudio: function () {
      if (customBlobUrl) { try { URL.revokeObjectURL(customBlobUrl); } catch (e) {} customBlobUrl = null; }
      try { localStorage.removeItem(CUSTOM_KEY); } catch (e) {}
      if (customEl) { try { customEl.pause(); } catch (e) {} }
    },
    saveCustomAudio: function (file) {
      return saveCustomToStorage(file).then(function () {
        customBlobUrl = readCustomFromStorage();
        return !!customBlobUrl;
      });
    }
  };
})();
