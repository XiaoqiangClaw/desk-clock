(function () {
  'use strict';
  window.DeskClock = window.DeskClock || {};

  var STRINGS = {
    'zh-CN': {
      language: '界面语言', style: '时钟样式', font: '时钟字体',
      fontCustom: '自定义…', color: '时钟颜色', colorCustom: '自定义…',
      showSeconds: '显示秒', hour12: '12 小时制', alwaysOnTop: '总在最前',
      autostart: '开机自启', backdrop: '背景板', scale: '大小', opacity: '不透明度',
      showSeparator: '显示分隔符 :',
      close: '关闭', resizeTip: '拖动右下角也可调整',
      gearTitle: '设置', settingsTitle: '设置', resizeTitle: '拖动调整大小',
      // tabs
      tabAppearance: '外观', tabWindow: '窗口', tabAlarm: '闹钟',
      tabTimer: '定时任务', tabTimezone: '时区校时', tabPermission: '权限', tabAbout: '关于',
      grpBasic: '基础显示', grpTypography: '字体与配色', grpCanvas: '画布',
      grpWindow: '窗口行为', grpPosition: '快速定位', grpClockSync: '系统时间校准',
      grpExtraClocks: '多时区时钟', grpProject: '项目与更新',
      separatorNote: '关闭后仍保留时、分、秒之间的间距。',
      opacityNote: '仅影响桌面时钟窗口，设置窗口始终保持清晰。',
      analogTheme: '表盘配色',
      clickThrough: '鼠标穿透',
      clickThroughNote: '开启后点击可穿透到下方窗口；需先在托盘菜单关闭本开关才能再操作设置。',
      positionNote: '把时钟一键放到屏幕常用位置（按当前显示器工作区计算）。',
      // alarm
      alarmTitle: '闹钟', alarmRepeat: '每天重复', alarmAdd: '＋ 添加', alarmRemove: '删除',
      alarmSound: '响铃', alarmSoundNote: '到点播放提示音（浏览器需先有交互才允许出声）。',
      alarmTestSound: '试听',
      // timer
      timerTitle: '定时关机 / 重启', shutdownTitle: '定时关机',
      timerAction: '动作', timerMode: '方式',
      actionShutdown: '关机', actionReboot: '重启',
      modeDuration: '时长（分钟后）', modeClock: '指定时间点',
      minutes: '分钟', clockHint: '（当天或次日）',
      shutdownStart: '启动', shutdownCancel: '取消',
      // timezone / sync
      syncIntro: '若电脑时间不准，可让系统联网校准（需要管理员 / root 权限）。',
      syncNow: '立即校时', autoTimeSync: '启动时自动校时',
      syncNote: '校时调用操作系统自带的时间服务，不会修改本程序之外的任何数据。',
      syncUnsupported: '此环境不支持自动校时',
      syncOk: '已请求系统校时', syncFail: '校时失败（可能需要管理员权限）：%s',
      extraClockNote: '同一程序、单个实例下可打开多个独立时钟窗口，各自显示不同时区。',
      extraAdd: '＋ 打开窗口', extraEmpty: '还没有额外的时钟窗口',
      extraBrowserOnly: '（浏览器预览：仅记录配置，不创建窗口）',
      // permissions
      permTitle: '权限与启动', permChecking: '正在检查权限…',
      permAdmin: '始终以管理员身份启动', permElevateNow: '立即以管理员身份重启',
      permQuit: '退出程序',
      permAdminNote: '勾选后，下次手动启动以及开机自启都会自动向 Windows 请求管理员权限（UAC 提示由系统弹出）；取消勾选即恢复普通权限。',
      permAdminOn: '已开启：下次启动将自动请求管理员权限',
      permAdminOff: '未开启：以标准权限启动',
      // donate / about
      donateTitle: '支持作者', donateNote: '如果这个小工具有帮到你，欢迎请作者喝杯咖啡 ☕（完全自愿）',
      donateToggle: '请作者喝咖啡', donateHide: '收起',
      donateWechat: '微信支付', donateAlipay: '支付宝',
      donateFoot: '截图 / 长按后扫码 · 感谢你的支持',
      checkUpdate: '检查更新', goDownload: '下载新版本',
      updateChecking: '正在检查…', updateLatest: '已是最新版本 %s',
      updateFound: '发现新版本 %s', updateFail: '检查失败：%s',
      // misc
      shutdownOff: '未启用', shutdownAt: '将在 %s 关机', rebootAt: '将在 %s 重启',
      shutdownUnsupported: '此环境不支持自动关机',
      shutdownWarn: '到点将执行系统动作，请先保存工作；可随时取消。',
      resetDefaults: '一键还原默认（Alt+R）', resetDone: '已还原默认设定',
      alarmRinging: '⏰ 闹钟', alarmSnooze: '稍后提醒', alarmDismiss: '知道了',
      alarmMute: '静音', alarmMsg: '时间到：%s', alarmBrowserOnly: '（浏览器模式下仅弹窗提醒）',
      trayHint: '本程序常驻系统托盘，不在任务栏显示；关闭窗口只会隐藏到托盘，托盘菜单可重新显示或退出。',
      styles: { flip: '翻页卡片', minimal: '极简细体', neon: '霓虹', eink: '电子墨水', segment: '七段数码', typewriter: '打字机', glass: '毛玻璃', analog: '指针表盘' },
      backdrops: { none: '无', blur: '模糊', dim: '暗色', light: '浅色' },
      colors: { '': '跟随样式（推荐）', '#ffffff': '白色', '#8bfaff': '青色', '#6bff8f': '绿色', '#ffb000': '琥珀', '#ff9ec7': '粉色', '#ff6b6b': '红色', '#191a1c': '黑色', '__custom__': '自定义…' },
      fonts: { '': '跟随样式（推荐）', sans: '系统无衬线', serif: '衬线体', mono: '等宽 / 数码感', rounded: '圆润黑体', '__custom__': '自定义…' }
    },
    en: {
      language: 'Language', style: 'Clock style', font: 'Clock font',
      fontCustom: 'Custom…', color: 'Clock color', colorCustom: 'Custom…',
      showSeconds: 'Show seconds', hour12: '12-hour', alwaysOnTop: 'Always on top',
      autostart: 'Autostart', backdrop: 'Backdrop', scale: 'Size', opacity: 'Opacity',
      showSeparator: 'Show ":"', close: 'Close', resizeTip: 'Or drag the bottom-right corner',
      gearTitle: 'Settings', settingsTitle: 'Settings', resizeTitle: 'Drag to resize',
      tabAppearance: 'Appearance', tabWindow: 'Window', tabAlarm: 'Alarm',
      tabTimer: 'Timer', tabTimezone: 'Time', tabPermission: 'Permissions', tabAbout: 'About',
      grpBasic: 'Display', grpTypography: 'Font & colour', grpCanvas: 'Canvas',
      grpWindow: 'Window behaviour', grpPosition: 'Quick position', grpClockSync: 'System clock',
      grpExtraClocks: 'Multiple clocks', grpProject: 'Project & updates',
      separatorNote: 'Spacing between H/M/S is kept even when hidden.',
      opacityNote: 'Only affects the clock window; settings always stay clear.',
      analogTheme: 'Dial theme',
      clickThrough: 'Click through',
      clickThroughNote: 'Clicks pass through to windows below; disable it from the tray menu before using settings again.',
      positionNote: 'Snap the clock to a common spot on the current monitor.',
      alarmTitle: 'Alarm', alarmRepeat: 'Daily', alarmAdd: '＋ Add', alarmRemove: 'Remove',
      alarmSound: 'Sound', alarmSoundNote: 'Plays a chime when due (browser requires a prior interaction).',
      alarmTestSound: 'Test',
      timerTitle: 'Shutdown / reboot timer', shutdownTitle: 'Shutdown timer',
      timerAction: 'Action', timerMode: 'Mode',
      actionShutdown: 'Shut down', actionReboot: 'Reboot',
      modeDuration: 'After (minutes)', modeClock: 'At a clock time',
      minutes: 'min', clockHint: '(today or tomorrow)',
      shutdownStart: 'Start', shutdownCancel: 'Cancel',
      syncIntro: 'If the PC clock drifts, let the OS sync it over the network (needs admin/root).',
      syncNow: 'Sync now', autoTimeSync: 'Sync on startup',
      syncNote: 'Uses the OS built-in time service; no other data is touched.',
      syncUnsupported: 'Auto time sync not supported here',
      syncOk: 'System time sync requested', syncFail: 'Sync failed (admin may be required): %s',
      extraClockNote: 'One app instance can show several independent clock windows, each with its own time zone.',
      extraAdd: '＋ Open window', extraEmpty: 'No extra clock windows yet',
      extraBrowserOnly: '(browser preview: config only, no window created)',
      permTitle: 'Permissions & startup', permChecking: 'Checking permissions…',
      permAdmin: 'Always launch as administrator', permElevateNow: 'Restart as administrator now',
      permQuit: 'Quit app',
      permAdminNote: 'Once enabled, every future launch (manual and autostart) will request administrator rights via a Windows UAC prompt; untick to revert to standard rights.',
      permAdminOn: 'Enabled: next launch will request admin rights',
      permAdminOff: 'Disabled: launching with standard rights',
      donateTitle: 'Support', donateNote: 'If this little clock helps you, buy the author a coffee ☕ (totally optional)',
      donateToggle: 'Buy me a coffee', donateHide: 'Hide',
      donateWechat: 'WeChat Pay', donateAlipay: 'Alipay',
      donateFoot: 'Scan from a screenshot · thank you for your support',
      checkUpdate: 'Check for updates', goDownload: 'Download update',
      updateChecking: 'Checking…', updateLatest: 'You are up to date (%s)',
      updateFound: 'New version available: %s', updateFail: 'Check failed: %s',
      shutdownOff: 'Not set', shutdownAt: 'Shutdown at %s', rebootAt: 'Reboot at %s',
      shutdownUnsupported: 'Auto shutdown not supported here',
      shutdownWarn: 'A system action will run. Save your work first; you can cancel anytime.',
      resetDefaults: 'Reset defaults (Alt+R)', resetDone: 'Defaults restored',
      alarmRinging: '⏰ Alarm', alarmSnooze: 'Snooze', alarmDismiss: 'OK',
      alarmMute: 'Mute', alarmMsg: 'Time is up: %s', alarmBrowserOnly: '(popup only in browser mode)',
      trayHint: 'The clock lives in the system tray (no taskbar icon). Closing this window only hides it — use the tray menu to show or quit.',
      styles: { flip: 'Flip', minimal: 'Minimal', neon: 'Neon', eink: 'E-ink', segment: 'Segment', typewriter: 'Typewriter', glass: 'Glass', analog: 'Analog' },
      backdrops: { none: 'None', blur: 'Blur', dim: 'Dim', light: 'Light' },
      colors: { '': 'Follow style', '#ffffff': 'White', '#8bfaff': 'Cyan', '#6bff8f': 'Green', '#ffb000': 'Amber', '#ff9ec7': 'Pink', '#ff6b6b': 'Red', '#191a1c': 'Black', '__custom__': 'Custom…' },
      fonts: { '': 'Follow style', sans: 'System sans', serif: 'Serif', mono: 'Monospace', rounded: 'Rounded', '__custom__': 'Custom…' }
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
        if (STRINGS[L][group] && STRINGS[L][group][o.value] !== undefined) o.textContent = STRINGS[L][group][o.value];
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
