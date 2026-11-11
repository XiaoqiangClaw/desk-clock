(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  // 重复规则引擎 + 中国大陆法定日历（工作日/周末/节假日/交易日）。
  // 设计：零运行时依赖、可离线；日历数据来自 ui/calendar-data.js（静态、挂全局）。
  // 仅用两个原语集合 h(法定节假日停休日) / w(调休补班日) 派生全部判断，见 gen-calendar.py。

  var CD = (window.DeskClock && window.DeskClock.CalendarData) || { years: {} };

  // 重复模式（含“自定义”）。与旧版 repeat:bool 兼容：旧 repeat:true 无 rule → daily。
  var MODES = ['daily', 'workdays', 'weekends', 'holidays', 'trading', 'custom'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function md(d) { return pad2(d.getMonth() + 1) + pad2(d.getDate()); }       // MMdd
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function rec(y) { return (CD.years && CD.years[String(y)]) || null; }
  function covered(y) { return !!rec(y); }

  // ---- 日历判断（date: Date）----
  function isWorkday(d) {
    var r = rec(d.getFullYear());
    if (!r) { var w = d.getDay(); return w >= 1 && w <= 5; }   // 数据未覆盖：退化为周一~周五
    var m = md(d);
    if (r.w.indexOf(m) >= 0) return true;                      // 调休补班（周末上班）
    var wd = d.getDay();
    return (wd >= 1 && wd <= 5) && r.h.indexOf(m) < 0;          // 周一~周五 且非法定节假日
  }
  function isHoliday(d) {
    var r = rec(d.getFullYear());
    if (!r) return false;
    return r.h.indexOf(md(d)) >= 0;
  }
  function isWeekend(d) {
    var wd = d.getDay();
    if (wd === 0 || wd === 6) {
      var r = rec(d.getFullYear());
      if (r) return r.w.indexOf(md(d)) < 0;                     // 周末但非补班
      return true;
    }
    return false;
  }
  function isTradingDay(d) {
    var wd = d.getDay();
    if (wd === 0 || wd === 6) return false;                     // 周末（含调休补班）一律休市
    return !isHoliday(d);                                       // 周一~周五 且非法定节假日
  }

  // ---- 规则归一化（防御：损坏/旧数据不会让 UI 崩）----
  function normalizeRule(rule) {
    var out = { mode: 'daily', weekdays: [], dates: [], skipHolidays: false };
    if (!rule || typeof rule !== 'object') return out;
    if (MODES.indexOf(rule.mode) >= 0) out.mode = rule.mode;
    if (Array.isArray(rule.weekdays)) {
      var seen = {};
      out.weekdays = rule.weekdays.filter(function (x) {
        x = Number(x);
        if (!(x >= 0 && x <= 6) || seen[x]) return false;
        seen[x] = 1; return true;
      }).sort();
    }
    if (Array.isArray(rule.dates)) {
      out.dates = rule.dates.filter(function (s) {
        return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      }).slice(0, 60);
    }
    if (rule.mode === 'custom') out.skipHolidays = !!rule.skipHolidays;
    return out;
  }

  // 旧版 repeat:bool 兼容：true→daily，false→一次性（无 rule）
  function fromLegacy(repeat, rule) {
    if (rule && typeof rule === 'object') return normalizeRule(rule);
    return normalizeRule({ mode: repeat === false ? 'once' : 'daily' });
  }

  // ---- 规则匹配：某天是否应响 ----
  // rule 为 undefined/空 → daily；rule.dates 中显式包含 → 一律命中（个性化附加日）。
  function matches(rule, d) {
    var r = normalizeRule(rule);
    if (r.dates && r.dates.indexOf(ymd(d)) >= 0) return true;
    switch (r.mode) {
      case 'once': return false;                 // 一次性：由 repeat:false 的删除逻辑处理，不应在此命中
      case 'daily': return true;
      case 'workdays': return isWorkday(d);
      case 'weekends': return isWeekend(d);
      case 'holidays': return isHoliday(d);
      case 'trading': return isTradingDay(d);
      case 'custom': {
        var hit = r.weekdays.indexOf(d.getDay()) >= 0;
        if (hit && r.skipHolidays && isHoliday(d)) return false;
        return hit;
      }
      default: return true;
    }
  }

  // ---- 人类可读摘要 ----
  // lang: 'zh-CN' | 'en'。weekday 名：0=日 1=一 ... 6=六
  var WD_ZH = ['日', '一', '二', '三', '四', '五', '六'];
  var WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function summary(rule, lang) {
    var r = normalizeRule(rule);
    var zh = lang !== 'en';
    if (r.mode === 'once') return zh ? '一次性' : 'One-shot';
    if (r.mode === 'daily') return zh ? '每天' : 'Daily';
    if (r.mode === 'workdays') return zh ? '工作日' : 'Workdays';
    if (r.mode === 'weekends') return zh ? '周末' : 'Weekends';
    if (r.mode === 'holidays') return zh ? '法定节假日' : 'Holidays';
    if (r.mode === 'trading') return zh ? 'A股交易日' : 'Trading days';
    // custom
    var parts = [];
    if (r.weekdays.length) {
      var names = r.weekdays.map(function (x) { return zh ? WD_ZH[x] : WD_EN[x]; });
      parts.push((zh ? '周' : '') + names.join(zh ? '、' : ','));
    }
    if (r.dates.length) parts.push((zh ? r.dates.length + '个指定日期' : r.dates.length + ' date(s)'));
    var s = (zh ? '自定义(' : 'Custom(') + parts.join(zh ? '；' : '; ') + ')';
    if (r.skipHolidays) s += zh ? '·排除节假日' : '·no holidays';
    return s;
  }

  window.DeskClock.Schedule = {
    MODES: MODES,
    CalendarData: CD,
    isWorkday: isWorkday, isHoliday: isHoliday, isWeekend: isWeekend, isTradingDay: isTradingDay,
    covered: covered,
    normalizeRule: normalizeRule, fromLegacy: fromLegacy, matches: matches, summary: summary,
    _md: md, _ymd: ymd
  };
})();
