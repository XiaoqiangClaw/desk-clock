(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var SNOOZE_MS = 5 * 60 * 1000;
  var firing = null;

  // v0.4: 用 Web Audio 合成一段柔和的三连提示音，循环播放直到用户处理。
  // 不打包任何音频资源，零依赖，浏览器/各平台 WebView 都支持。
  var audioCtx = null;
  var ringTimer = null;
  var ringOn = false;

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

  // --------------------------------------------------------------- ring tone
  function ensureCtx() {
    if (audioCtx) return audioCtx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  // 一次「叮-叮-叮」：三个正弦音 + 轻微衰减包络，音量很轻不刺耳。
  function chime() {
    var ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    var t0 = ctx.currentTime;
    var notes = [880, 1108.73, 1318.51]; // A5, C#6, E6 —— 大三和弦
    notes.forEach(function (f, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t0 + i * 0.18);
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.14, t0 + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.42);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t0 + i * 0.18);
      osc.stop(t0 + i * 0.18 + 0.45);
    });
  }

  function startRing() {
    stopRing();
    ringOn = true;
    chime();
    ringTimer = setInterval(function () { if (ringOn) chime(); }, 2200);
  }

  function stopRing() {
    ringOn = false;
    if (ringTimer !== null) { clearInterval(ringTimer); ringTimer = null; }
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

  // v0.4: 统一入口。action = shutdown|reboot，mode = duration|clock。
  // 时间点模式在前端算出「从现在到目标时刻」的分钟数（跨天自动取次日），
  // 交给 Rust 用系统 shutdown/reboot 命令执行，避免 Rust 侧处理时区。
  function minutesUntil(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return 0;
    var now = new Date();
    var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      Number(m[1]), Number(m[2]), 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000));
  }

  function scheduleTimer(action, mode, minutes, hhmm) {
    var mins = mode === 'clock' ? minutesUntil(hhmm) : (Number(minutes) || 0);
    if (mins < 1) return Promise.reject(new Error('invalid time'));
    var d = new Date(Date.now() + mins * 60000);
    var label = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return invoke('schedule_timer', {
      action: action, minutes: mins, label: label
    });
  }

  function cancelTimer() { return invoke('cancel_timer'); }
  function timerStatus() { return invoke('get_timer_status'); }

  // 兼容旧命令名（回归脚本/v0.3 调用）
  function scheduleShutdown(minutes) { return scheduleTimer('shutdown', 'duration', minutes, ''); }
  function cancelShutdown() { return cancelTimer(); }
  function shutdownStatus() { return timerStatus(); }

  window.DeskClock.Alarm = {
    check: check, snooze: snooze, newId: newId,
    setFiring: function (v) { firing = v; },
    isFiring: function () { return !!firing; },
    startRing: startRing, stopRing: stopRing,
    minutesUntil: minutesUntil,
    scheduleTimer: scheduleTimer, cancelTimer: cancelTimer, timerStatus: timerStatus,
    scheduleShutdown: scheduleShutdown, cancelShutdown: cancelShutdown, shutdownStatus: shutdownStatus
  };
})();
