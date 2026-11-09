(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var STRINGS = {
    'zh-CN': {
      language: '界面语言', style: '时钟样式', font: '时钟字体',
      fontCustom: '自定义…', color: '时钟颜色', colorCustom: '自定义…',
      showSeconds: '显示秒', hour12: '12 小时制', alwaysOnTop: '总在最前',
      autostart: '开机自启', backdrop: '背景板', scale: '大小', opacity: '不透明度',
      close: '关闭', resizeTip: '拖动右下角也可调整',
      gearTitle: '设置', settingsTitle: '设置', resizeTitle: '拖动调整大小',
      alarmTitle: '闹钟', alarmRepeat: '每天', alarmAdd: '添加', alarmRemove: '删除',
      shutdownTitle: '定时关机', minutes: '分钟', shutdownStart: '启动', shutdownCancel: '取消',
      shutdownOff: '未启用', shutdownAt: '将在 %s 关机', shutdownUnsupported: '此环境不支持自动关机',
      shutdownWarn: '到点将关闭计算机，请先保存工作；可随时取消。',
      resetDefaults: '一键还原默认（Alt+R）', resetDone: '已还原默认设定',
      alarmRinging: '⏰ 闹钟', alarmSnooze: '稍后提醒（5 分钟）', alarmDismiss: '知道了',
      alarmMsg: '时间到：%s', alarmBrowserOnly: '（浏览器模式下仅弹窗提醒）',
      styles: {
        flip: '翻页卡片', minimal: '极简细体', neon: '霓虹', eink: '电子墨水',
        segment: '七段数码', typewriter: '打字机', glass: '毛玻璃', analog: '指针表盘'
      },
      backdrops: { none: '无', blur: '模糊', dim: '暗色', light: '浅色' },
      colors: {
        '': '跟随样式（推荐）', '#ffffff': '白色', '#8bfaff': '青色', '#6bff8f': '绿色',
        '#ffb000': '琥珀', '#ff9ec7': '粉色', '#ff6b6b': '红色', '#191a1c': '黑色',
        '__custom__': '自定义…'
      },
      fonts: {
        '': '跟随样式（推荐）', sans: '系统无衬线', serif: '衬线体',
        mono: '等宽 / 数码感', rounded: '圆润黑体', '__custom__': '自定义…'
      }
    },
    en: {
      language: 'Language', style: 'Clock style', font: 'Clock font',
      fontCustom: 'Custom…', color: 'Clock color', colorCustom: 'Custom…',
      showSeconds: 'Show seconds', hour12: '12-hour', alwaysOnTop: 'Always on top',
      autostart: 'Autostart', backdrop: 'Backdrop', scale: 'Size', opacity: 'Opacity',
      close: 'Close', resizeTip: 'Or drag the bottom-right corner',
      gearTitle: 'Settings', settingsTitle: 'Settings', resizeTitle: 'Drag to resize',
      alarmTitle: 'Alarm', alarmRepeat: 'Daily', alarmAdd: 'Add', alarmRemove: 'Remove',
      shutdownTitle: 'Shutdown timer', minutes: 'min', shutdownStart: 'Start', shutdownCancel: 'Cancel',
      shutdownOff: 'Not set', shutdownAt: 'Shutdown at %s', shutdownUnsupported: 'Auto shutdown not supported here',
      shutdownWarn: 'Your computer will shut down. Save your work first; you can cancel anytime.',
      resetDefaults: 'Reset defaults (Alt+R)', resetDone: 'Defaults restored',
      alarmRinging: '⏰ Alarm', alarmSnooze: 'Snooze (5 min)', alarmDismiss: 'Dismiss',
      alarmMsg: 'Time is up: %s', alarmBrowserOnly: '(popup only in browser mode)',
      styles: {
        flip: 'Flip', minimal: 'Minimal', neon: 'Neon', eink: 'E-ink',
        segment: 'Segment', typewriter: 'Typewriter', glass: 'Glass', analog: 'Analog'
      },
      backdrops: { none: 'None', blur: 'Blur', dim: 'Dim', light: 'Light' },
      colors: {
        '': 'Follow style', '#ffffff': 'White', '#8bfaff': 'Cyan', '#6bff8f': 'Green',
        '#ffb000': 'Amber', '#ff9ec7': 'Pink', '#ff6b6b': 'Red', '#191a1c': 'Black',
        '__custom__': 'Custom…'
      },
      fonts: {
        '': 'Follow style', sans: 'System sans', serif: 'Serif',
        mono: 'Monospace', rounded: 'Rounded', '__custom__': 'Custom…'
      }
    }
  };

  function t(lang, key) {
    var table = STRINGS[lang] || STRINGS['zh-CN'];
    return table[key] !== undefined ? table[key] : key;
  }

  function apply(lang) {
    var L = STRINGS[lang] ? lang : 'zh-CN';
    document.documentElement.lang = L;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(L, nodes[i].getAttribute('data-i18n'));
    }
    function opts(id, group) {
      var sel = document.getElementById(id);
      if (!sel) return;
      for (var j = 0; j < sel.options.length; j++) {
        var o = sel.options[j];
        if (STRINGS[L][group][o.value] !== undefined) o.textContent = STRINGS[L][group][o.value];
      }
    }
    opts('pref-style', 'styles');
    opts('pref-backdrop', 'backdrops');
    opts('pref-color', 'colors');
    opts('pref-font', 'fonts');
    var gear = document.getElementById('gear');
    if (gear) { gear.title = t(L, 'gearTitle'); gear.setAttribute('aria-label', t(L, 'gearTitle')); }
    var st = document.getElementById('settings-title');
    if (st) st.textContent = t(L, 'settingsTitle');
    var rh = document.getElementById('resize-handle');
    if (rh) { rh.title = t(L, 'resizeTitle'); rh.setAttribute('aria-label', t(L, 'resizeTitle')); }
  }

  window.DeskClock.I18n = { apply: apply, t: t, LANGS: ['zh-CN', 'en'] };
})();
