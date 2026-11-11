(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  // 桌面时钟「语音播报」模块（v0.7，未发布）。
  // 纯前端 Web Speech API + 复用现有 WebAudio 铃声做前导音/降级。零新依赖、跨平台。
  // 设计原则：顶层零副作用（不访问 speechSynthesis，避免在无语音引擎的环境报错），
  // 纯函数（inQuiet/shouldFire/buildText）便于无头 Chromium 回归。

  // ---- 中文数字 0-59（小时/分钟/月/日/星期）----
  var ZH_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  function zhNum(n) {
    n = Math.max(0, Math.min(59, n | 0));
    if (n < 10) return ZH_DIGIT[n];
    var t = Math.floor(n / 10), o = n % 10;
    var r = (t === 1 ? '十' : ZH_DIGIT[t] + '十');
    if (o !== 0) r += ZH_DIGIT[o];
    return r;
  }
  var ZH_WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  // 时段词基于 24h 小时
  function periodWord(h24) {
    if (h24 < 5) return '凌晨';
    if (h24 < 9) return '早上';
    if (h24 < 12) return '上午';
    if (h24 < 13) return '中午';
    if (h24 < 18) return '下午';
    return '晚上';
  }
  var EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var EN_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function buildZh(now, cfg) {
    var h = now.getHours(), m = now.getMinutes();
    var h12 = !!cfg.hour12;
    var withDate = !!cfg.announceIncludeDate;
    var hourDisplay = h12 ? (h % 12 === 0 ? 12 : h % 12) : h;
    var minPart;
    if (m === 0) minPart = '整';
    else if (m < 10) minPart = '零' + zhNum(m) + '分';
    else minPart = zhNum(m) + '分';
    var s = '现在是' + periodWord(h) + zhNum(hourDisplay) + '点' + minPart;
    if (withDate) {
      s = '今天是' + zhNum(now.getMonth() + 1) + '月' + zhNum(now.getDate()) + '日' +
        ZH_WEEK[now.getDay()] + '，' + s;
    }
    return s;
  }

  function buildEn(now, cfg) {
    var h = now.getHours(), m = now.getMinutes();
    var h12 = !!cfg.hour12;
    var withDate = !!cfg.announceIncludeDate;
    var pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    var s;
    if (h12) {
      var h12v = h % 12 === 0 ? 12 : h % 12;
      s = "It's " + h12v + ':' + pad2(m) + ' ' + (h < 12 ? 'AM' : 'PM') + '.';
    } else {
      s = "It's " + pad2(h) + ':' + pad2(m) + '.';
    }
    if (withDate) {
      s = "It's " + EN_WEEK[now.getDay()] + ', ' + EN_MONTHS[now.getMonth()] + ' ' +
        now.getDate() + '. ' + s;
    }
    return s;
  }

  // ---- 纯函数 ----
  function parseHM(str) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str == null ? '' : str).trim());
    if (!m) return null;
    var h = +m[1], mm = +m[2];
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }

  function inQuiet(now, cfg) {
    if (!cfg || cfg.announceQuiet !== true) return false;
    var start = parseHM(cfg.announceQuietStart);
    var end = parseHM(cfg.announceQuietEnd);
    if (start === null || end === null) return false;
    if (start === end) return false;           // 视为不限制
    var cur = now.getHours() * 60 + now.getMinutes();
    if (start < end) return cur >= start && cur < end;   // 同日内
    return cur >= start || cur < end;                          // 跨午夜
  }

  function shouldFire(now, cfg) {
    if (!cfg || cfg.announceEnabled !== true) return false;
    if (inQuiet(now, cfg)) return false;
    var h = now.getHours(), m = now.getMinutes();
    var mod = h * 60 + m;
    var rule = cfg.announceRule || 'hourly';
    switch (rule) {
      case 'hourly': return m === 0;
      case 'half': return m === 0 || m === 30;
      case 'quarter': return m % 15 === 0;
      case 'interval': {
        var N = Math.round(Number(cfg.announceInterval) || 0);
        N = Math.min(120, Math.max(5, N));
        return mod % N === 0;
      }
      case 'custom': {
        var times = cfg.announceTimes || [];
        var hm = ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
        for (var i = 0; i < times.length; i++) {
          if (times[i] && String(times[i].time) === hm) return true;
        }
        return false;
      }
      default: return false;
    }
  }

  function buildText(now, cfg) {
    cfg = cfg || {};
    var L = cfg.announceLang || cfg.lang || 'zh-CN';
    return String(L).indexOf('en') === 0 ? buildEn(now, cfg) : buildZh(now, cfg);
  }

  // ---- Web Speech API（运行时访问，全部 try/catch 保护）----
  function supported() {
    try { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); }
    catch (e) { return false; }
  }
  function voices() {
    try {
      var v = window.speechSynthesis && window.speechSynthesis.getVoices();
      return (v && v.length) ? v : [];
    } catch (e) { return []; }
  }
  function onVoicesChanged(cb) {
    var unbind = function () {};
    try {
      var s = window.speechSynthesis;
      if (!s) return unbind;
      if (typeof s.addEventListener === 'function') s.addEventListener('voiceschanged', cb);
      else if (s.onvoiceschanged !== undefined) s.onvoiceschanged = cb;
    } catch (e) { /* ignore */ }
    return unbind;
  }
  function speak(text, cfg) {
    if (!supported()) return false;
    try {
      cfg = cfg || {};
      var u = new window.SpeechSynthesisUtterance(text);
      var list = voices();
      var chosen = null;
      var want = cfg.announceVoice;
      if (want) {
        for (var i = 0; i < list.length; i++) {
          if (list[i].voiceURI === want || list[i].name === want) { chosen = list[i]; break; }
        }
      }
      if (!chosen) {
        var langFull = String(cfg.announceLang || cfg.lang || 'zh-CN');
        var prefix = langFull.indexOf('zh') === 0 ? 'zh' :
                     langFull.indexOf('en') === 0 ? 'en' : '';
        if (prefix) {
          for (i = 0; i < list.length; i++) {
            if (String(list[i].lang || '').indexOf(prefix) === 0) { chosen = list[i]; break; }
          }
        }
        if (!chosen) for (i = 0; i < list.length; i++) { if (list[i].default) { chosen = list[i]; break; } }
        if (!chosen && list.length) chosen = list[0];
      }
      u.voice = chosen || null;
      u.lang = String(cfg.announceLang || cfg.lang || 'zh-CN').indexOf('en') === 0 ? 'en-US' : 'zh-CN';
      u.rate = Math.min(2, Math.max(0.5, Number(cfg.announceRate) || 1));
      u.volume = Math.min(1, Math.max(0, Number(cfg.announceVolume) || 1));
      u.pitch = 1;
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  function preview(cfg) {
    var now = new Date();
    var text = buildText(now, cfg);
    speak(text, cfg);
    return text;
  }

  window.DeskClock.Announce = {
    supported: supported,
    voices: voices,
    onVoicesChanged: onVoicesChanged,
    inQuiet: inQuiet,
    shouldFire: shouldFire,
    buildText: buildText,
    speak: speak,
    preview: preview
  };
})();
