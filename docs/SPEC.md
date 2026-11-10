# Desk Clock — 设计契约

> **阅读顺序**：本文是项目初始（v1 草案）的模块接口与视觉契约，用于理解「为什么这样写」。
> 当前（**v0.6.1**）的完整功能、多窗口配置分层与行为，以根目录 `README.md` 和 `DELIVERY-v0.6.1.md` 为准。
> 本文已把与现状冲突的接口/非目标表述同步修正，新增第 7 节记录 v0.6 之后的关键演进。

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

## 5. 验收标准

- `node --check` 全部 JS 通过；Python 回归脚本 `py_compile` 通过；`tauri.conf.json` /
  `capabilities/default.json` 合法 JSON；shell 脚本 `bash -n` 通过。
- 真实 Chromium（Playwright + loopback HTTP）分版本回归：
  `verify.py` 31 + `verify_features.py` 43 + `verify_v03.py` 35 + `verify_v04.py` 60 +
  `verify_v05.py` 55 + `verify_v06.py` 22 + `verify_v061.py` 30 = **276 项全绿**（v0.6.1）。
- 浏览器打开 `ui/index.html`：默认 flip 风格能显示当前时间、逐秒翻页、无黑底无边框；8 风格均正常渲染。
- 多窗口：每个窗口各自渲染自己的样式/颜色/时区/显示秒；切换编辑目标不串配置；
  两个独立页面均只注册窗口作用域 `onMoved`、无全局 `tauri://move` 监听。
- Rust 全平台编译/打包以 GitHub Actions CI 为准（本机可能缺 webkit 开发库，不跑 cargo）。

## 6. 初始非目标 → 现状

初版草案把以下列为「v1 不做」；**这些功能后来都已实现**，不再是限制：

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

## 7. v0.6 之后的架构演进（要点）

1. **v0.6.0**：从「一份共享配置 + 额外窗口 4 个独立参数」重构为 `clocks.json` 每窗口完整配置；
   所有窗口平等，主窗口只是默认存在的那一个；设置窗口增加「正在编辑」目标选择器；
   新增 `window-prefs-changed` 定向事件，各窗口只应用自己/当前目标，避免广播覆盖。
   旧后端兼容靠 `supportsWindowApi` 探测（`get_window_configs` 无 `clocks` 则降级为双写 `set_prefs`）。
2. **v0.6.1**：窗口管理并入「窗口」页并精简为「名称 + 添加窗口」；主窗口纳入卡片清单；
   补 `start_dragging` 权限、取消额外窗口恒鼠标穿透，使每个窗口都能拖动与点齿轮；
   位置监听改窗口作用域 `onMoved` 修连锁移动；`set_window_prefs` 不再因改配置而重定位窗口；
   启动恢复与注入值改从每窗口 `clocks.json` 读取，避免重启回退；一键还原默认不再误删窗口清单。
   详见 `DELIVERY-v0.6.1.md`。
