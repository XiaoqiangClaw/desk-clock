(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var SNOOZE_MS = 5 * 60 * 1000;
  var firing = null;

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
    // One-shot alarms: remove after firing.
    var remaining = (state.alarms || []).filter(function (a) { return a.repeat || a.time !== hm; });
    saveFn({ alarms: remaining });
    return hits.map(function (a) { return { id: a.id, time: a.time, label: a.time }; });
  }

  function snooze() {
    var d = new Date(Date.now() + SNOOZE_MS);
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return { id: newId(), time: hm, repeat: false };
  }

  function scheduleShutdown(minutes) {
    // Compute the label from a REAL local Date (avoids any hardcoded UTC
    // offset on the Rust side, which would be wrong outside UTC+8).
    var mins = Number(minutes) || 0;
    var d = new Date(Date.now() + mins * 60000);
    var label = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return invoke('schedule_shutdown', { minutes: mins, label: label });
  }

  function cancelShutdown() {
    return invoke('cancel_shutdown');
  }

  function shutdownStatus() {
    return invoke('get_shutdown_status');
  }

  window.DeskClock.Alarm = {
    check: check, snooze: snooze, newId: newId,
    setFiring: function (v) { firing = v; },
    isFiring: function () { return !!firing; },
    scheduleShutdown: scheduleShutdown,
    cancelShutdown: cancelShutdown,
    shutdownStatus: shutdownStatus
  };
})();
