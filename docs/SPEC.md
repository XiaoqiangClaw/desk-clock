# Desk Clock — 设计契约

> 本文是模块接口、样式与配置模型的技术说明。
> 当前版本 **v0.7.4**，功能与行为以根目录 `README.md` 和 `CHANGELOG.md` 为准。

开源桌面时钟：只显示时间，可选是否显示秒，8 种样式，无边框透明、低资源、跨 Windows / macOS / Linux；
同一进程可开任意多个时钟窗口，**每个窗口都有全套独立配置**。

## 1. 架构

- 壳：Tauri v2（Rust），负责窗口/托盘/开机自启、每窗口配置持久化（`prefs.json` + `clocks.json`）、
  位置与尺寸恢复、权限、定时关机、单实例、外链解析；所有窗口由同一进程承载。
- UI：原生 HTML + CSS + JS，**不使用任何框架、不使用打包器、不使用 ES module**。
  全部用传统 `<script>` 标签按序加载，挂到全局命名空间 `DeskClock`。
  → 原因：`file://index.html` 直接用浏览器打开也能跑（ES module 在 file:// 会被 CORS 拦截），
    Tauri 内也能跑，零构建、最稳；浏览器模式用 localStorage 模拟后端，便于无头 Chromium 回归。
- 透明窗口：`decorations:false` + `transparent:true` + 页面 `background:transparent`。
  无边框、无窗口标题栏；**整个时钟不加任何外框/描边/黑底**。
- 视图分流：同一份 `index.html` 由初始化脚本标记区分两种角色：
  - **时钟窗口**（`main` 与 `clock-<id>`）：`data-tauri-drag-region` 可拖动，显示齿轮与缩放柄；
  - **设置窗口**（`__DC_VIEW__='settings'`）：固定尺寸、左侧 Tab、头部「正在编辑」目标选择器，
    永远不透明、不显示时钟/齿轮/缩放柄。

## 2. 配置（Prefs / Clocks）

全局项存 `prefs.json`，每窗口完整配置存 `clocks.json`（`{activeId, clocks:{<id>: {...}}}`）。
前端 `Prefs.DEFAULTS` 保留完整扁平对象作为兼容/降级基准；`WINDOW_KEYS` / `GLOBAL_KEYS` 决定 `Prefs.save()` 的分流。

| 层 | 字段 |
|---|---|
| 全局（一次设置，程序级共享） | `lang`, `alarms`, `alarmSound`, `alarmTone`, `timerAction`, `timerMode`, `autoTimeSync`, `autostart`, `runAsAdmin`, `extraClocks`（窗口清单） |
| 每窗口（各存一份、互不影响） | `style`, `showSeconds`, `hour12`, `showSeparator`, `alwaysOnTop`, `backdrop`, `scale`, `opacity`, `font`, `customFont`, `color`, `customColor`, `analogTheme`, `analogPenetrate`, `clickThrough`, `tzOffset`, `tzLabel`, `x`, `y` |

- `style`: flip | minimal | neon | eink | segment | typewriter | glass | analog
- `backdrop`: none | blur | dim | light —— 默认 **none**；其余为可选微弱背板，都不是黑色实底
- `x,y`: 该窗口左上角位置（**物理像素**，null = 首次居中 / 新窗口错开）
- `tzOffset`: 分钟偏移，`null` = 本机时间；固定 UTC 偏移，**不含夏令时**，界面以 UTC±N 标注
- `extraClocks[]`: `{id,label,offset,style,showSeconds,visible}`，是窗口清单；`offset/style/showSeconds`
  在 v0.6.1 起仅为历史兼容字段，真实显示值以 `clocks.json` 中该窗口自己的配置为准。
- 旧版本只有单份 `prefs.json`；`read_clocks()` 在 `clocks.json` 不存在时自动迁移（main 用旧全局值、
  `extra_clocks` 逐条补齐），升级不丢配置。

## 3. 模块接口（跨文件靠它对齐）

全局命名空间 `DeskClock`（简写 `DC`）。所有文件用 IIFE 挂 `window.DeskClock = window.DeskClock || {}`。

### `ui/prefs.js` → `DeskClock.Prefs`
- `Prefs.DEFAULTS`（完整扁平默认对象）、`Prefs.isNative`（`!!window.__TAURI__`）
- `Prefs.load(): Promise<object>` —— 全局项 + 本窗口/当前编辑目标窗口配置 `hydrate()` 成扁平对象供现有控件使用。
  - Native：`invoke('get_prefs')` + `invoke('get_window_configs')` + `invoke('get_window_prefs',{id})`；
    探测到旧后端（无 `get_window_configs`）时降级为单份 prefs 并**双写**保持兼容。
  - 浏览器：`localStorage['deskclock.prefs']` 与 `['deskclock.clocks']`。
- `Prefs.save(patch): Promise<object>` —— 字段级浅合并、防抖 ~200ms；按 `GLOBAL_KEYS` / `WINDOW_KEYS`
  分流：全局项 → `invoke('set_prefs',{patch})`；窗口项 → `invoke('set_window_prefs',{id:targetId,patch})`
  （旧后端降级为 `set_prefs`）。**窗口项绝不写 root prefs**，避免污染其它窗口。
- `Prefs.getSelfId()` / `getTargetId()`：本窗口 id / 设置窗口当前编辑目标；时钟窗口 `targetId=selfId`。
- `Prefs.setActiveClock(id)`：切换编辑目标并重载配置。
- `Prefs.onChanged(cb)` / `onWindowChanged(cb)` / `listen(evt,cb)`：全局项广播（不覆盖本窗口专属字段）、
  某窗口配置定向事件（时钟窗口只响应自己 id，设置窗口只响应当前目标）、通用事件订阅。
- 窗口管理：`addClockWindow / closeClockWindow / setClockWindowVisible / listClockWindows /
  windowConfigs / windowPrefs / setWindowPrefs`；位置与尺寸：`setWindowPosition / setWindowGeometry / presetPosition`。
- 其它：`setAutostart / getAutostart / privilegeStatus / setRunAsAdmin / restartElevated /
  openSettings(id) / closeSettings / quitApp / setClickThrough / syncSystemTime / checkUpdate / openUrl`。

### `ui/flip.js` → `DeskClock.FlipDigit`
单个 split-flap 数字位。
- `new FlipDigit(mountEl)` —— 在 mountEl 内建 DOM：
  ```
  .flip
    .flip-static .flip-top     (显示当前值上半)
    .flip-static .flip-bottom  (显示当前值下半)
    .flip-hinge                (水平铰链中线)
    .flip-anim.flip-top        (翻动的上半：旧值→)
    .flip-anim.flip-bottom     (翻动的下半：→新值)
  ```
  每半张卡用 `overflow:hidden` + 内部 `.flip-face` 定位，实现上半显示字形上半、下半显示字形下半。
- `.set(char, animate)` —— 值与当前相同则完全不操作（关键省资源）；不同则：
  无 animate 或 reduced-motion → 直接替换两半文本；
  有 animate → 加 `is-flipping` class 触发 CSS 3D rotateX 两段动画，动画结束（animationend）
  清理 class 并把静态两半设为新值。翻动中若又来新值，直接收敛到最新值（不排队、不卡顿）。
- `.value` 当前字符。

### `ui/clock.js` → `DeskClock.Engine`
- `new Engine(opts)`：opts = `{onTick, showSeconds, hour12, animate}`
- `.start() / .stop() / .setOptions(patch)`
- `onTick(payload)`，payload = `{parts, now}`
  - `parts`: 数组，元素 `{type:"digit"|"sep", value:string, key:string}`；
    24h 带秒 = `[H,H,sep,M,M,sep,S,S]`，不带秒 = `[H,H,sep,M,M]`；key 稳定（如 `d0,d1,sep0,...`），供复用 DOM。
  - `now`: 当前 `Date`；多窗口时由 `app.js::displayNow()` 按各窗口 `tzOffset` 平移后传入。
- **计时策略（低资源核心）**：不用 setInterval。每次 tick 后计算到「下一个边界」的毫秒数
  （显示秒→下一个整秒；不显示秒→下一个整分），`setTimeout` 单次唤醒，并做 ±20ms 对齐补偿。
  `document.visibilitychange` 隐藏时 `stop()`、可见时 `start()`；原生 `hide()` 另有 Rust 定向事件停/复表。
- `hour12=true` 时小时按 12 小时制（不额外显示 AM/PM，保持「仅显示时间」）。

### `ui/schedule.js` → `DeskClock.Schedule`（v0.7.2，v0.7.3 加热替换）
- 闹钟重复规则引擎 + 中国大陆法定日历判定。零运行时依赖、可离线、纯函数便于无头回归；顶层零副作用。
- 数据来自 `ui/calendar-data.js`（`DeskClock.CalendarData`）：`years[YYYY] = { h:[MMdd...], w:[MMdd...] }`，`h`=法定节假日停休日（仅周几停休，不含普通周末）、`w`=调休补班日（周末上班）。由 `scripts/gen-calendar.py` 从 `chinese_calendar` 生成；顶层另有 `schema`/`source`/`coverage` 元数据。覆盖年份自动探测（当前 2024–2027）。
- **运行时可热替换（v0.7.3）**：闭包内 `CD` 初始取 `window.DeskClock.CalendarData`，`setData(data)` 校验通过后重新赋值 `CD` 并同步全局 `DeskClock.CalendarData` 与导出对象的 `CalendarData`；所有判定函数（`rec()` 等）都读 `CD`，替换后四种规则即时生效。`validateData(data)` 严格校验结构（年份 4 位、`h`/`w` 数组、元素 `\d{4}`、数量上限）。**只增不减**：新数据年份集合必须是当前超集，否则拒绝，防止回退/损坏数据把日历弄错。`coverage()` 返回已覆盖年份升序数组。
- 派生口径：**工作日** = 周一~周五且不在 `h`，或在 `w`；**周末** = 周六/日且不在 `w`；**节假日** = 在 `h`；**A股交易日** = 周一~周五且不在 `h`（周末含调休补班一律休市）。数据未覆盖年份退化为周一~周五口径。交易日是派生结果、不是独立数据集。
- 接口：`isWorkday/isWeekend/isHoliday/isTradingDay(Date)`、`covered(year)`、`coverage()`、`validateData(data)`、`setData(data)`、`normalizeRule(rule)`、`fromLegacy(repeat, rule)`、`matches(rule, date)`、`summary(rule, lang)`、`MODES`（`daily|workdays|weekends|holidays|trading|custom`）。
- `rule = { mode, weekdays:[0-6], dates:['YYYY-MM-DD'], skipHolidays }`；`dates` 显式命中一律响铃；`custom` 按 `weekdays` 命中，可选 `skipHolidays` 排除法定节假日。
- 兼容：`DeskClock.Prefs.normalize()` 把每条闹钟规整为 `{ id, time, repeat, rule }`；旧 `repeat:true`→`daily`、`false`→`once`（一次性，响后移除）。触发在 `ui/app.js` 的 `maybeFireAlarms()`：一次性到点即响，重复闹钟按 `Schedule.matches(rule, localDate)` 判定。

### 日历数据自动更新（v0.7.3 双层闭环 → v0.7.4 覆盖驱动，`scripts/gen-calendar.py` + `ui/calendar-sync.js` + CI）
> 交易日不是独立数据、而是「工作日/节假日」的派生结果；真正会过期的是国务院每年发布的放假 + 调休安排（政策数据，约每年 11 月上旬发布次年安排，`chinese_calendar` 随之更新）。四种规则共用一份**按年整块覆盖**的数据，一更新全更新。v0.7.4 改为「覆盖驱动」：数据覆盖今天就不联网，只在临期/过期/缓存丢失时才拉。

- **生成器 `scripts/gen-calendar.py`**：用「三点探测法」（每年 1/1、6/1、12/31 均可被 `is_workday` 判定才算完整支持）自动发现 `chinese_calendar` 支持到的最新年份，从 2024 起连续纳入，**不写死年份常量**；支持 `YEARS=2024-2027` 环境变量固定年份（复现/回归用）。同时产出两个恒等、幂等（便于 `git diff --quiet`）的文件：
  - `ui/calendar-data.js`：`window.DeskClock.CalendarData = {...};`，内置兜底、挂全局、`file://` 可跑；
  - `ui/calendar-data.json`：纯 JSON，供运行时 `fetch`，自托管于本仓库 `main` 分支（`raw.githubusercontent.com`，CORS `*`）。
- **① 构建期 `.github/workflows/calendar-sync.yml`**（v0.7.4 降频）：**11 月发布季每周一 + 其余月份每月 1 号**定时 + 手动触发，`pip install --upgrade chinese_calendar` → 重跑生成器 → `node --check` + 结构/双文件一致性校验 → 仅当 `git diff` 有变化才提交回 `main`。`GITHUB_TOKEN` 的 push 不触发其它 workflow，无构建循环。贴合政策数据一年一发的节奏，避免全年每周空跑。
- **③ 发版纪律 `.github/workflows/release.yml`**（v0.7.4 新增）：每个 publish job 在打包前先 `pip install --upgrade chinese_calendar` → 重跑生成器 → 校验 `.js`/`.json` 一致性与年份连续，把**发版时刻最新的数据直接打进安装包**。因此每个版本内置的都是当前最新数据，不依赖发版时恰好刚同步过；运行时同步仅服务于已装旧版本。
- **② 运行时 `ui/calendar-sync.js` → `DeskClock.CalendarSync`**（v0.7.4 覆盖驱动）：已安装旧版本无需重装即享新年份。
  - `decide(today, coverage)` 纯函数是核心：`y > maxYear → 'expired'`（跨年/过期，立即自愈拉取）；`y === maxYear && month >= 11 → 'prefetch'`（覆盖末年 12 月起临期预取，晚于国务院 11 月上旬发布通知，不空转）；否则 `'local'`（覆盖内纯本地零联网）。8 个关键日期场景已回归断言。
  - `start()`：先应用 `localStorage` 缓存（离线即享上次同步成果）；缓存丢失/损坏则 `cacheRecoveryPending = true`，内置表兜底并允许一次联网恢复。`status()`/`onChange(cb)` 供 UI 展示覆盖年份、来源（builtin/cache/remote）、`decision`、busy/error。
  - `shouldFetch(force)`：开关 + 覆盖驱动 + 轻量节流。`local` 且无恢复需求直接返回 false；`expired` 为硬需求（只有上次失败且距今 < 4h 才退避，否则每次启动尝试直到成功）；`prefetch`/恢复 走 `PREFETCH_OK_INTERVAL`(24h) / `FAIL_INTERVAL`(4h)。浏览器预览（非 native）自动跳过联网以免回归噪声。
  - `fetchWithFallback()`：数据源 `SOURCES = [RAW_URL, MIRROR_URL]`。主源为本仓库 `raw.githubusercontent.com`；**备源 `MIRROR_URL` 由主 URL 字符串派生**为 `cdn.jsdelivr.net/gh/.../desk-clock@main/ui/calendar-data.json`（同一仓库同一文件、CORS `*`，避免维护两份地址）。主源失败自动切备源，双源失败才静默回落。
  - `_applyRemote(data, source)`：`Schedule.setData()` 严格校验（`validateData`：年份 4 位、`h`/`w` 数组、元素 `\d{4}`、数量上限）+ 只增不减防回退 → 落缓存 + `emit()`。任何失败/超时（8s `AbortController`）/数据异常静默回落，绝不抛错、不打扰用户。
  - `setEnabled(v)`：由关转开时立即尝试一次；`storage` 事件让其它窗口实时跟上同步结果。
  - 关键常量：`RAW_URL`、`PREFETCH_MONTH = 11`、`PREFETCH_OK_INTERVAL`、`FAIL_INTERVAL`、`REQUEST_TIMEOUT`。零新依赖、零新权限（与 `Prefs.checkUpdate` 同一通道），数据源自托管可控可审计。
- **偏好与 UI**：`ui/prefs.js` 新增全局项 `calendarAutoSync`（默认 `true`）；设置「关于」页「📅 日历数据」卡片（`pref-cal-autosync` 开关 / `cal-sync-now` 手动检查 / `cal-sync-status` 状态行，`data-dyn` 由 `renderCalSyncStatus()` 管理），i18n 中英双语。`ui/index.html` 加载顺序：`calendar-data.js` → `schedule.js` → `calendar-sync.js` → `app.js`。
- **验收**：`scripts/verify_calendar_sync.py`（138 项）——纯文件结构检查 + Node 行为测试（mock 浏览器环境真实加载两个模块，实测热替换覆盖增长、严格校验、防回退、缓存落盘、覆盖驱动 8 个日期场景、主源故障切备源、双源失败、离线优先、年份连续性 / 闰日 / coverage 一致性校验与交易日判定随之更新）。

### `ui/announce.js` → `DeskClock.Announce`（v0.7，未发布）
- 语音播报（纯 Web Speech API + 复用 `Alarm` 合成提示音，零新依赖）；顶层零副作用，`speechSynthesis` 全部 try/catch 保护，无语音引擎时优雅降级（仅播提示音）。
- 纯函数：`shouldFire(now,cfg)`（整点/半点/每刻/间隔/指定时刻 + 免打扰跨午夜）、`inQuiet(now,cfg)`、`buildText(now,cfg)`（中英文报时，12/24 制，可含日期/星期）。
- 副作用：`speak(text,cfg)`（voice/lang/rate/volume/pitch 装配，`cancel()` 后 `speak`）、`preview(cfg)`、`voices()`、`supported()`、`onVoicesChanged(cb)`。
- 触发：`ui/app.js` 的 `maybeAnnounce()` 仅在**主时钟窗口**（非设置、非额外）按分钟去重触发；13 个全局字段（`announceEnabled` 默认 `false`）与 `ui/prefs.js` 的 `DEFAULTS`/`GLOBAL_KEYS` 对齐。

### `ui/app.js` → 装配
1. `await Prefs.load()` → 应用根节点 `data-style`、`data-backdrop`、`--dc-scale`、`opacity`；
   设置窗口固定 `opacity:1`。
2. 依据当前 style 构建 DOM：除 `analog` 外建 `.clock` 容器并按 `parts` 复用/创建槽位
   （`flip` 每 digit 槽位内放 `FlipDigit`）；`analog` 建 `.analog` 表盘（12 刻度 + 时/分/秒三针，
   关秒时隐藏秒针）。
3. `Engine` 每次 tick 调 `renderFrame(payload)` 更新数字/冒号呼吸/指针角度。
4. 设置面板（Tab 化、卡片分组）：外观 / 窗口 / 闹钟 / 定时任务 / 时区校时 / 权限 / 关于（**7 个**）。
   「窗口」页含窗口行为、九宫格定位、**窗口管理**卡片（v0.6.1 起「多时区」已并入此页）。
   每项变更 → `Prefs.save(patch)` → 即时重绘（换 style 需重建 DOM）。
5. 拖拽：`#app` 带 `data-tauri-drag-region`；Tauri v2 内置脚本调 `plugin:window|start_dragging`，
   故 `capabilities/default.json` **必须**显式授予 `core:window:allow-start-dragging` 与
   `core:window:allow-internal-toggle-maximize`（`core:default` 不含这两项）。
6. 位置记忆（v0.6.1 关键）：用 `window.__TAURI__.webviewWindow.getCurrentWebviewWindow().onMoved(cb)`
   注册**窗口作用域**监听，防抖 400ms 后 `Prefs.save({x,y})` 写入本窗口配置。
   **禁止**用全局 `event.listen('tauri://move')`——那会注册 Any-target 监听，绕过 Tauri 的窗口过滤，
   导致每个窗口收到所有窗口的移动事件并连锁串位。启动时由 Rust 按窗口 id 从 `clocks.json` 恢复位置。
7. 置顶 / 穿透 / 尺寸：由 Rust `set_window_prefs` 按窗口 id 应用到真实窗口
   （`set_always_on_top` / `set_ignore_cursor_events` / `set_size`），前端不直接调窗口插件命令。
8. 从任一时钟窗口点齿轮 → `Prefs.openSettings(selfId)` → Rust 把 `activeId` 设为该窗口并
   emit `settings-target-changed`，已存在的设置窗口据此切换目标。
9. 所有 Native 调用都要 `try/catch` 并判 `Prefs.isNative`，浏览器预览不得报错。

## 4. 样式主题（ui/styles.css）

8 个 `data-style` 取值，每个用 CSS 变量覆盖 + 必要覆写：
| key | 风格 | 要点 |
|---|---|---|
| `flip` | 翻页卡片 | 深炭灰卡片浮在透明背景上；水平铰链中线；上下半明暗差；翻页 3D 动画；**无黑色底板、无外框** |
| `minimal` | 极简细体大数字 | system-ui 细字重、超大字号、字距收紧 |
| `neon` | 霓虹发光 | 高饱和色 + 多层 text-shadow 光晕 |
| `eink` | 电子墨水 | 近黑字、纸感、极低对比动效、无发光 |
| `segment` | 七段数码管 | 等宽、方角、暗红/琥珀 LED 感（用字体+字距模拟，不引外部字体） |
| `typewriter` | 打字机/终端 | 等宽字体、绿色/琥珀、轻微字距 |
| `glass` | 毛玻璃 | 半透明浅色字 + backdrop-filter 柔化背板（背板=blur 时更明显） |
| `analog` | 指针表盘 | CSS 圆盘、刻度、三针；表盘半透明不黑底 |

通用要求：
- `html,body{background:transparent;overflow:hidden}`；`.clock` **无 border / 无 background / 无 box-shadow 外框**。
- 文字默认带极轻 `text-shadow` 保证在任意壁纸上可读（transparent 窗口需要）。
- `backdrop` 四档均低透明度（≤0.18）且**不带边框**。
- 缩放用根 `--dc-scale`（`font-size` + `zoom` 配合），不改布局流。
- `@media (prefers-reduced-motion: reduce)` 关闭所有动画/过渡。
- 动画只用 `transform/opacity`，`will-change` 仅在 `.is-flipping` 期间加。

## 5. 质量检查

- `node --check` 全部 JS 通过；Python 回归脚本 `py_compile` 通过；`tauri.conf.json` /
  `capabilities/default.json` 合法 JSON；shell 脚本 `bash -n` 通过。
- 真实 Chromium（Playwright + loopback HTTP）分版本自动化检查：
  `verify.py` 31 + `verify_announce.py` 77 + `verify_calendar_sync.py` 138 +
  `verify_features.py` 60 + `verify_v03.py` 35 + `verify_v04.py` 60 +
  `verify_v05.py` 55 + `verify_v06.py` 22 + `verify_v061.py` 30 +
  `verify_v062.py` 34 + `verify_v063.py` 33 = **575 项通过**（v0.7.6 工作区基线）。
- 浏览器打开 `ui/index.html`：默认 flip 风格能显示当前时间、逐秒翻页、无黑底无边框；8 风格均正常渲染。
- 多窗口：每个窗口各自渲染自己的样式/颜色/时区/显示秒；切换编辑目标不串配置；
  两个独立页面均只注册窗口作用域 `onMoved`、无全局 `tauri://move` 监听。
- Rust 全平台编译与打包由 GitHub Actions 完成。

## 6. 早期非目标 → 现状

早期版本曾把以下列为暂不实现；**这些功能后来均已实现**：

| 初版非目标 | 现状 |
|---|---|
| 闹钟 / 计时器 / 倒计时 | v0.4 已有多条闹钟、每天重复、稍后提醒、定时关机/重启（时长/时间点） |
| 多时区 | v0.4 起支持 20 个常用 UTC 偏移 + 自定义 ±HH:MM；v0.6 起每窗口独立时区 |
| 网络校时 | v0.4 起「立即校时」+「启动时自动校时」 |
| 音效 | v0.4 Web Audio 提示音；v0.5 起 5 种预设铃声 + 自定义音频 |
| 字体下载 | 未做（保持零外部依赖），但支持系统字体与自定义字体名 |
| 系统托盘自定义菜单 | v0.3 起托盘常驻，含显示/设置/打赏/更新/恢复鼠标/退出 |

当前已知边界（如实保留）：
- 时区为**固定 UTC 偏移，不含夏令时**；界面以 UTC±N 标注避免误导。
- 开启「鼠标穿透」的窗口不再接收鼠标事件，需走托盘「恢复鼠标（关闭穿透）」。
- 浏览器预览不创建真实原生窗口，多窗口行为以原生安装版为准。
- 安装包未做代码签名（macOS 需右键打开，Windows 可能弹 SmartScreen）。

## 7. 版本演进

各版本的功能变化、修复与发布记录统一见根目录 `CHANGELOG.md`；本文只保留稳定的接口、配置模型与设计约束。

