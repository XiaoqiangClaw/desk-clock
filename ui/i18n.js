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
      tabTimer: '定时任务', tabTimezone: '时区校时', tabClocks: '多时区', tabPermission: '权限', tabAbout: '关于',
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
      alarmTone: '铃声', alarmToneNote: '选择预设铃声，或使用自己的音频文件（≤ 500KB，仅保存在本机）。',
      toneGentle: '柔和三连', toneBell: '清脆叮咚', toneTick: '电子滴答', toneRise: '上升音阶', toneChord: '和弦钟声', toneCustom: '自定义音频…',
      alarmCustomPick: '选择音频文件', alarmCustomClear: '移除自定义', alarmCustomNone: '未选择文件',
      alarmCustomTooBig: '文件过大（上限 500KB），请换一个', alarmCustomBad: '请选择一个音频文件',
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
      grpClockManager: '窗口管理',
      cmNote: '每个窗口都是全功能窗口；添加后点卡片「设置」或用顶部「正在编辑」下拉框，即可分别设置样式、时区、颜色、大小、位置等。',
      cmName: '名称', cmZone: '时区', cmCustomZone: '自定义 UTC 偏移', cmOffsetHint: '格式 ±HH:MM，如 +05:30 / -08:00',
      cmStyle: '窗口样式', cmStyleGlobal: '跟随全局（推荐）', cmShowSeconds: '显示秒',
      cmAdd: '＋ 添加窗口', cmEmpty: '目前只有主窗口，点上方按钮添加新窗口',
      cmNamePlaceholder: '窗口名称（可选）', cmWindow: '窗口', cmMainHint: '默认窗口 · 不可删除', cmMainTag: '主窗口',
      cmEdit: '重命名', cmHide: '隐藏', cmShow: '显示', cmDelete: '删除',
      cmRunning: '运行中', cmStopped: '已隐藏', cmEditHint: '改名后点「保存」生效', cmSave: '保存修改', cmCancel: '取消编辑',
      cmSettings: '设置', cmMain: '主窗口', cmTimezone: '时区', cmTzLocal: '本机时间',
      editingClock: '正在编辑', cmFullSettings: '每个窗口都能独立设置样式、颜色、字体、大小、位置、时区等；用顶部的「正在编辑」切换目标窗口。',
      extraBrowserOnly: '（浏览器预览：仅记录配置，不创建窗口）',
      // permissions
      permTitle: '权限与启动', permChecking: '正在检查权限…',
      permRetry: '重新检查', permCheckFail: '暂时无法读取权限状态，请点「重新检查」。',
      permElevateHint: '点击后会弹出系统授权窗口；若取消或超时，本程序会继续以当前权限运行。',
      permElevateFailed: '未获得授权，当前时钟继续运行。',
      permAdmin: '始终以管理员身份启动', permElevateNow: '立即以管理员身份重启',
      permQuit: '退出程序',
      permAdminNote: '勾选后，下次手动启动以及开机自启都会自动向 Windows 请求管理员权限（UAC 提示由系统弹出）；取消勾选即恢复普通权限。',
      permAdminOn: '已开启：下次启动将自动请求管理员权限',
      permAdminOff: '未开启：以标准权限启动',
      // donate / about
      donateTitle: '支持作者', donateNote: '如果这个小工具有帮到你，欢迎请作者喝杯咖啡 ☕',
      donateToggle: '请作者喝咖啡', donateHide: '收起',
      donateWechat: '微信支付', donateAlipay: '支付宝',
      donateFoot: '感谢您的支持',
      checkUpdate: '检查更新', goDownload: '下载新版本',
      updateChecking: '正在检查…', updateLatest: '已是最新版本 %s',
      updateFound: '发现新版本 %s', updateFail: '检查失败：%s',
      // misc
      shutdownOff: '未启用', shutdownAt: '将在 %s 关机', rebootAt: '将在 %s 重启',
      shutdownUnsupported: '此环境不支持自动关机',
      shutdownWarn: '到点将执行系统动作，请先保存工作；可随时取消。',
      resetDefaults: '一键还原默认设置（Alt+R）', resetDone: '已还原默认设定',
      resetNote: '将样式、字体、颜色、窗口行为、闹钟与定时任务等全部恢复为初始值（语言与窗口位置保留）。',
      alarmRinging: '⏰ 闹钟', alarmSnooze: '稍后提醒', alarmDismiss: '知道了',
      alarmMute: '静音', alarmMsg: '时间到：%s', alarmBrowserOnly: '（浏览器模式下仅弹窗提醒）',
      trayHint: '本程序常驻系统托盘，不在任务栏显示；关闭窗口只会隐藏到托盘，托盘菜单可重新显示或退出。',
      versionTip: '点击打开项目主页',
      styles: { flip: '翻页卡片', minimal: '极简细体', neon: '霓虹', eink: '电子墨水', segment: '七段数码', typewriter: '打字机', glass: '毛玻璃', analog: '指针表盘' },
      tones: { gentle: '柔和三连', bell: '清脆叮咚', tick: '电子滴答', rise: '上升音阶', chord: '和弦钟声', custom: '自定义音频…' },
      zones: { '-600': 'UTC-10 夏威夷', '-480': 'UTC-8  洛杉矶', '-420': 'UTC-7  丹佛', '-360': 'UTC-6  芝加哥', '-300': 'UTC-5  纽约', '-240': 'UTC-4  多伦多', '-180': 'UTC-3  圣保罗', '0': 'UTC+0  伦敦', '60': 'UTC+1  巴黎/柏林', '120': 'UTC+2  开罗', '180': 'UTC+3  莫斯科', '240': 'UTC+4  迪拜', '330': 'UTC+5:30 印度', '420': 'UTC+7  曼谷', '480': 'UTC+8  北京/新加坡', '540': 'UTC+9  东京', '600': 'UTC+10 悉尼', '660': 'UTC+11 墨尔本', '720': 'UTC+12 奥克兰', '840': 'UTC+14 斐济', '__custom__': '自定义 UTC 偏移' },
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
      tabTimer: 'Timer', tabTimezone: 'Time', tabClocks: 'World clocks', tabPermission: 'Permissions', tabAbout: 'About',
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
      alarmTone: 'Tone', alarmToneNote: 'Pick a preset tone or use your own audio file (≤ 500KB, stored locally only).',
      toneGentle: 'Soft triple', toneBell: 'Bright bell', toneTick: 'Digital tick', toneRise: 'Rising scale', toneChord: 'Chord chime', toneCustom: 'Custom audio…',
      alarmCustomPick: 'Choose audio file', alarmCustomClear: 'Remove custom', alarmCustomNone: 'No file chosen',
      alarmCustomTooBig: 'File too large (max 500KB)', alarmCustomBad: 'Please choose an audio file',
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
      grpClockManager: 'Window manager',
      cmNote: 'Every window is fully configurable. After adding one, use its Settings button or the "Editing" selector at the top to set style, time zone, colour, size and position independently.',
      cmName: 'Name', cmZone: 'Time zone', cmCustomZone: 'Custom UTC offset', cmOffsetHint: 'Format ±HH:MM, e.g. +05:30 / -08:00',
      cmStyle: 'Window style', cmStyleGlobal: 'Follow global', cmShowSeconds: 'Show seconds',
      cmAdd: '＋ Add window', cmEmpty: 'Only the main window so far — add one above',
      cmNamePlaceholder: 'Window name (optional)', cmWindow: 'Window', cmMainHint: 'Default window · cannot be removed', cmMainTag: 'Main',
      cmEdit: 'Rename', cmHide: 'Hide', cmShow: 'Show', cmDelete: 'Delete',
      cmRunning: 'Running', cmStopped: 'Hidden', cmEditHint: 'Click Save to apply the new name', cmSave: 'Save', cmCancel: 'Cancel',
      cmSettings: 'Settings', cmMain: 'Main clock', cmTimezone: 'Time zone', cmTzLocal: 'Local time',
      editingClock: 'Editing', cmFullSettings: 'Every window has its own style, colour, font, size, position and time zone. Use the "Editing" selector at the top to switch target.',
      extraBrowserOnly: '(browser preview: config only, no window created)',
      permTitle: 'Permissions & startup', permChecking: 'Checking permissions…',
      permRetry: 'Check again', permCheckFail: 'Could not read permission status — please retry.',
      permElevateHint: 'A system UAC prompt will appear; cancelling or timing out keeps the clock running as-is.',
      permElevateFailed: 'Authorization not granted; the clock keeps running.',
      permAdmin: 'Always launch as administrator', permElevateNow: 'Restart as administrator now',
      permQuit: 'Quit app',
      permAdminNote: 'Once enabled, every future launch (manual and autostart) will request administrator rights via a Windows UAC prompt; untick to revert to standard rights.',
      permAdminOn: 'Enabled: next launch will request admin rights',
      permAdminOff: 'Disabled: launching with standard rights',
      donateTitle: 'Support', donateNote: 'If this little clock helps you, buy the author a coffee ☕',
      donateToggle: 'Buy me a coffee', donateHide: 'Hide',
      donateWechat: 'WeChat Pay', donateAlipay: 'Alipay',
      donateFoot: 'Thank you for your support',
      checkUpdate: 'Check for updates', goDownload: 'Download update',
      updateChecking: 'Checking…', updateLatest: 'You are up to date (%s)',
      updateFound: 'New version available: %s', updateFail: 'Check failed: %s',
      shutdownOff: 'Not set', shutdownAt: 'Shutdown at %s', rebootAt: 'Reboot at %s',
      shutdownUnsupported: 'Auto shutdown not supported here',
      shutdownWarn: 'A system action will run. Save your work first; you can cancel anytime.',
      resetDefaults: 'Reset all settings (Alt+R)', resetDone: 'Defaults restored',
      resetNote: 'Restores style, font, colour, window behaviour, alarms and timers (language and window position are kept).',
      alarmRinging: '⏰ Alarm', alarmSnooze: 'Snooze', alarmDismiss: 'OK',
      alarmMute: 'Mute', alarmMsg: 'Time is up: %s', alarmBrowserOnly: '(popup only in browser mode)',
      trayHint: 'The clock lives in the system tray (no taskbar icon). Closing this window only hides it — use the tray menu to show or quit.',
      versionTip: 'Click to open the project page',
      styles: { flip: 'Flip', minimal: 'Minimal', neon: 'Neon', eink: 'E-ink', segment: 'Segment', typewriter: 'Typewriter', glass: 'Glass', analog: 'Analog' },
      tones: { gentle: 'Soft triple', bell: 'Bright bell', tick: 'Digital tick', rise: 'Rising scale', chord: 'Chord chime', custom: 'Custom audio…' },
      zones: { '-600': 'UTC-10 Honolulu', '-480': 'UTC-8  Los Angeles', '-420': 'UTC-7  Denver', '-360': 'UTC-6  Chicago', '-300': 'UTC-5  New York', '-240': 'UTC-4  Toronto', '-180': 'UTC-3  São Paulo', '0': 'UTC+0  London', '60': 'UTC+1  Paris/Berlin', '120': 'UTC+2  Cairo', '180': 'UTC+3  Moscow', '240': 'UTC+4  Dubai', '330': 'UTC+5:30 India', '420': 'UTC+7  Bangkok', '480': 'UTC+8  Beijing/Singapore', '540': 'UTC+9  Tokyo', '600': 'UTC+10 Sydney', '660': 'UTC+11 Melbourne', '720': 'UTC+12 Auckland', '840': 'UTC+14 Fiji', '__custom__': 'Custom UTC offset' },
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
      // 🔴 v0.5.1 修复：带 data-dyn 的节点内容由 JS 动态管理
      // （权限状态、定时状态、校时状态、铃声状态等）。
      // 如果这里再写 textContent，会把已渲染的真实状态重置回占位文案
      // —— 这正是「权限界面一直显示正在检查权限…」的根因。
      if (nodes[i].hasAttribute('data-dyn')) continue;
      nodes[i].textContent = t(L, nodes[i].getAttribute('data-i18n'));
    }
    var phs = document.querySelectorAll('[data-i18n-placeholder]');
    for (var q = 0; q < phs.length; q++) {
      phs[q].placeholder = t(L, phs[q].getAttribute('data-i18n-placeholder'));
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
    // v0.5 管理器 / 闹钟：动态生成的下拉也要随语言切换
    opts('cm-zone', 'zones');
    opts('cm-style', 'styles');
    opts('pref-alarm-tone', 'tones');
    var gear = document.getElementById('gear');
    if (gear) { gear.title = t(L, 'gearTitle'); gear.setAttribute('aria-label', t(L, 'gearTitle')); }
    var rh = document.getElementById('resize-handle');
    if (rh) { rh.title = t(L, 'resizeTitle'); rh.setAttribute('aria-label', t(L, 'resizeTitle')); }
  }

  window.DeskClock.I18n = { apply: apply, t: t, LANGS: ['zh-CN', 'en'] };
})();
