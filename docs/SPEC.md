# Desk Clock — 设计契约（v1）

私有桌面时钟：只显示时间，可选是否显示秒，多种社区流行样式，低资源、稳定、无边框、
开机自启、记住窗口位置、跨 Windows / macOS / Linux。

## 1. 架构

- 壳：Tauri v2（Rust），只负责窗口、托盘、开机自启、位置恢复、偏好持久化。
- UI：原生 HTML + CSS + JS，**不使用任何框架、不使用打包器、不使用 ES module**。
  全部用传统 `<script>` 标签按序加载，挂到全局命名空间 `DeskClock`。
  → 原因：这样 `file://index.html` 直接用浏览器打开也能跑（ES module 在 file:// 会被 CORS 拦截），
    Tauri 内也能跑，零构建、最稳。
- 透明窗口：`decorations:false` + `transparent:true` + 页面 `background:transparent`。
  无边框、无窗口标题栏；卡片本身可以有自己的视觉，但**整个时钟不加任何外框/描边/黑底**。

## 2. 偏好设置（Prefs）

默认值：
```
style:"flip", showSeconds:true, hour12:false, alwaysOnTop:false,
autostart:false, backdrop:"none", scale:1, opacity:1, x:null, y:null
```
- `style`: flip | minimal | neon | eink | segment | typewriter | glass | analog
- `backdrop`: none | blur | dim | light —— 默认 **none**（满足"不要黑色背景/无边框"）；
  其余为可选微弱背板，供花哨壁纸上提高可读性，都不是黑色实底。
- `x,y`: 窗口左上角位置（null = 首次居中）

## 3. 模块接口（必须严格遵守，跨文件靠它对齐）

全局命名空间 `DeskClock`（简写 `DC`）。所有文件用 IIFE 挂 `window.DeskClock = window.DeskClock || {}`。

### `ui/prefs.js` → `DeskClock.Prefs`
- `Prefs.DEFAULTS`（上述默认对象）
- `Prefs.isNative`（boolean，`!!window.__TAURI__`）
- `Prefs.load(): Promise<object>` —— 合并默认值后返回完整 prefs。
  - Native：`window.__TAURI__.core.invoke('get_prefs')`；异常则回退 localStorage。
  - 浏览器：`localStorage['deskclock.prefs']`（JSON）。
- `Prefs.save(patch): Promise<void>` —— 浅合并、持久化（内部防抖 ~200ms）；
  Native 调 `invoke('set_prefs', {prefs})`；浏览器写 localStorage。
- `Prefs.setAutostart(enabled): Promise<boolean>` —— Native 调 `invoke('set_autostart',{enabled})`
  返回实际状态；浏览器返回 enabled（仅演示）。

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
- `.start() / .stop()`
- `.setOptions(patch)` —— 改 showSeconds/hour12/animate 后重排。
- `onTick(payload)`，payload = `{ parts, now }`
  - `parts`: 数组，元素 `{type:"digit"|"sep", value:string, key:string}`；
    24h 带秒 = `[H,H,sep,M,M,sep,S,S]`，不带秒 = `[H,H,sep,M,M]`；
    `sep` 的 value 为 `":"`；key 稳定（如 `d0,d1,sep0,d2,d3,...`），供复用 DOM。
  - `now`: 当前 `Date`。
- **计时策略（低资源核心）**：不用 setInterval。每次 tick 后计算到「下一个边界」的毫秒数
  （显示秒→下一个整秒；不显示秒→下一个整分），`setTimeout` 单次唤醒，并做 ±20ms 对齐补偿。
  `document.visibilitychange` 隐藏时 `stop()`、可见时 `start()`（页面隐藏不空转）。
- `hour12=true` 时小时按 12 小时制（不额外显示 AM/PM，保持"仅显示时间"）。

### `ui/app.js` → 装配
1. `await Prefs.load()` → 应用根节点 `data-style`、`data-backdrop`、`--dc-scale`、`opacity`。
2. 依据当前 style 构建 DOM：
   - 除 `analog` 外：建 `.clock` 容器，按 `parts` 复用/创建槽位；
     `flip` 风格每个 digit 槽位内放一个 `FlipDigit`；其余风格 digit 槽位为普通文本 span。
     `sep` 用带两个点的元素（CSS `::before/::after` 或文本）。
   - `analog`：建 `.analog` 表盘（12 刻度 + 时/分/秒三根指针），tick 时用 `now` 旋转指针；
     `showSeconds=false` 时隐藏秒针。
3. `Engine` 每次 tick 调 `renderFrame(payload)`：更新数字（flip 走 `.set(v, animate)`）、
   冒号呼吸（可选 CSS）、analog 指针角度。
4. 设置面板：`#gear` 按钮点击 toggle `#settings`（绝对定位浮层，圆角但**不给时钟主体加边框**）。
   面板项：样式下拉、显示秒、12/24 小时、置顶、开机自启、背板、缩放、不透明度、关闭按钮。
   每项变更 → `Prefs.save(patch)` → 即时重绘（换 style 需重建 DOM）。
5. 拖拽：`#app` 带 `data-tauri-drag-region`（Tauri v2 原生支持，无边框窗口靠它拖动）；
   浏览器预览下用 CSS `cursor:move` 占位即可。
6. 位置记忆：Native 下监听窗口 `onMoved`（`window.__TAURI__.webviewWindow.getCurrentWebviewWindow().onMoved`），
   防抖 400ms 后 `Prefs.save({x,y})`；启动时由 Rust 侧读 prefs 恢复位置（前端不重复设）。
7. 置顶 / 开机自启：置顶走 `getCurrentWebviewWindow().setAlwaysOnTop(v)`；
   自启走 `Prefs.setAutostart(v)`（勾选状态以返回值为准）。
8. 所有 Native 调用都要 `try/catch` 并判 `Prefs.isNative`，浏览器预览不得报错。

## 4. 样式主题（ui/styles.css）

8 个 `data-style` 取值，每个用 CSS 变量覆盖 + 必要覆写：
| key | 风格 | 要点 |
|---|---|---|
| `flip` | 翻页卡片（参考图，去黑底） | 深炭灰卡片浮在透明背景上；水平铰链中线；上下半明暗差；卡片间细缝；双点冒号；翻页 3D 动画；**无黑色底板、无外框** |
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
- `backdrop` 四档：`none` 全透明；`blur` 极淡毛玻璃；`dim` 极淡暗雾（非黑色实底）；
  `light` 极淡亮雾。均低透明度（≤0.18）且**不带边框**。
- 缩放用根 `--dc-scale`（transform: scale），不改布局流。
- `@media (prefers-reduced-motion: reduce)` 关闭所有动画/过渡。
- 动画只用 `transform/opacity`，`will-change` 仅在 `.is-flipping` 期间加。

## 5. 验收标准

- `node --check` 全部 JS 通过。
- 浏览器打开 `ui/index.html`：默认 flip 风格能显示当前时间、逐秒翻页、无黑底无边框。
- 切换到 8 种风格均正常渲染；关秒后数字不再每秒变；12/24 切换正确。
- chromium 无头截图可目视核对（脚本 `scripts/preview.sh`）。
- Native 侧：`cargo` 在目标机可编译；`tauri.conf.json` 合法 JSON；`withGlobalTauri:true`。

## 6. 非目标（v1 不做）

闹钟/计时器/倒计时、多时区、网络校时、音效、字体下载、系统托盘自定义菜单（v1 用窗口内设置面板）。
