# Desk Clock v0.6.2 交付说明

> 按主人 2026-11-10 第三批安装测试反馈（3 张截图 + 追加文字）逐条修复，版本 v0.6.2。
> 本文件是当前版本的交付口径；历史版本见 `DELIVERY.md` 总索引。

## 修复清单

| # | 反馈 | 处理 |
|---|---|---|
| 1 | 「快速定位」右侧 3 个位置离屏幕右边距太大，没有和左侧同步 | 根因：窗口外壳恒为 640×220，而可见时钟只有约 300–500px；`preset_position_for` 用 `outer_size()` 贴边等于让透明外壳贴边。改为**外壳尺寸 = `#app` 内容真实尺寸**：前端 `setWindowSize` 测 `getBoundingClientRect()`，经 `set_window_geometry` 把 `w/h` 写入该窗口 `clocks.json`；`spawn_extra_window` 与主窗口启动恢复都优先读 `w/h`；`set_window_prefs` 的缩放分支同步。`preset_position_for` 算法一行未动，外壳变小后右侧自然与左侧对称。 |
| 2 | 「系统时间校准」是不是该加一个时区选项，不然不知道校准哪个时区 | **不加下拉**。系统校时（w32tm / sntp / timedatectl）校准的是 UTC 绝对时间，与时区无关，加「校准哪个时区」是概念误导。真实信息缺口已补：校时页顶部显示**当前编辑目标窗口的时区**（本机时间 / UTC+8 北京…），并加说明「系统校准的是 UTC 绝对时间，与时区无关；各窗口显示的时区可在『外观』页单独设置」。 |
| 3 | 版本号直接显示在窗口标题中 | 主窗口 / 额外时钟窗口 / 设置窗口 / 提醒窗口，原生标题与 `document.title` 均为 `Desk Clock v0.6.2`（+后缀）；版本三处硬编码统一升 0.6.2。 |
| 4 | 「正在编辑」和下拉框挨着蓝色的点显示 | `.settings-head` 去掉 `space-between`，改 `gap:12px` 左对齐；关闭按钮 `margin-left:auto` 推到最右。蓝点/版本徽标 → 正在编辑标签 → 下拉框依次紧邻。 |
| 5 | 闹钟弹窗按钮和右上角 × 都无法点击 | 根因：`#app` 是 `data-tauri-drag-region`，v0.6.1 补 `start_dragging` 权限后原生拖动真正生效，`.alarm-toast` 只给容器加了 `no-drag`，子元素仍被吞进 drag region。改为 `.alarm-toast, .alarm-toast * { -webkit-app-region:no-drag }`，并给 5 个按钮显式 `data-tauri-drag-region="false"`（双保险，对照 Tauri 2.10.2 `drag.js` 判定规则）。 |
| 6 | 闹钟等弹窗应显示在屏幕中间 | 旧弹窗相对透明时钟小窗口居中、窗口放角落它就在角落且会被裁切。新建 `ui/alert.html` **独立提醒窗口**：`.center()`、always-on-top、无 drag-region、无标题栏、透明背景；Rust `show_alert/close_alert/alert_action` 三命令管理，payload 经 initialization_script 注入。按钮必然可点。浏览器预览保留旧 DOM 弹窗（7 套回归依赖）。 |
| 7 | 闹钟一直响，应可设置响铃时长，默认 30 秒 | 新增全局项 `alarmRingSeconds`（默认 30，5–600），闹钟页数字输入 + 中英说明；`showAlarmToast` 起 `setTimeout` 自动 `hideAlarmToast()`，手动关闭/静音也清计时器。 |
| 8 | 自动关机/重启到点前应弹窗提醒，默认提前 30 秒、提前量可设；可设静默执行不弹窗不提醒 | 新增 `timerWarnMode`（popup 默认 / silent）与 `timerWarnSeconds`（默认 30，5–300）。`schedule_timer` 追加两参、起守护线程持 `generation`，到 `(seconds - warnSeconds)` 时 `app.emit("timer-warning", ...)`，由主时钟窗口用 I18n 生成文案再 `Prefs.showAlert` 弹居中窗；静默模式不起线程不弹窗。取消/重新排程递增 generation 作废旧线程。 |
| 9 | 弹窗中应该有「终止」按钮，方便取消 | 闹钟弹窗 4 按钮：静音 / 稍后提醒 / **终止** / 知道了；定时任务弹窗 2 按钮：**终止任务** / 知道了。`alert_action(terminate, timer)` 直接调 `cancel_timer_inner`（`shutdown /a` 或 `-c`），并广播 `alert-action` 让前端清空状态。浏览器预览 DOM 弹窗同步加「终止」按钮。 |

## 架构要点

- **弹窗通道**：`app.js`（仅主时钟窗口监听）→ `Prefs.showAlert(payload)` → Rust `show_alert` → 独立 `alert.html` 窗口 → 按钮 `invoke('alert_action')` → Rust emit `alert-action` → 主窗口停铃 / 加稍后提醒 / 清定时任务。Rust 不内嵌任何 UI 文案，文案全部由前端 I18n 生成后随 payload 传入。
- **配置分层**：新增 3 项都是全局项，同时进 `ui/prefs.js`（DEFAULTS / normalize / GLOBAL_KEYS）与 Rust `Prefs` 结构（camelCase 映射），保证重启持久化与跨窗口同步。
- **窗口尺寸**：`clocks.json` 每窗口新增 `w/h`（逻辑像素，前端测量）；旧配置无 `w/h` 时回退 `640*scale / 220*scale`，首次启动前端 boot 会测量并校正一次。

## 验证

- 真实 Chromium 回归：`31 + 43 + 35 + 60 + 55 + 22 + 30 + 34 = 310` 项全绿（新增 `verify_v062.py` 34 项，覆盖 9 项反馈的 DOM/布局/持久化/通道与纯文件结构断言）。
- 静态检查全过：4 个 JS `node --check`、`py_compile`、JSON 解析、Rust 括号结构校验（BRACKETS OK）。
- Rust 全平台编译/打包以 GitHub Actions CI 为准（本机无 webkit 开发库，未跑 cargo）。

## 如实边界

- OS 定时关机/重启仍由系统自带 `shutdown` 排程；弹窗「终止任务」调用 `shutdown /a`（Windows）或 `shutdown -c`（macOS/Linux），需要相应权限，失败会如实返回。
- 浏览器预览不会创建原生弹窗/定时线程，沿用旧 DOM 弹窗；原生行为以安装版为准。
- 时区仍是固定 UTC 偏移（不含夏令时）；系统校时是请求 OS 同步 UTC 绝对时间，不改任何窗口的显示时区。
- 提醒窗口未做代码签名相关处理，随主程序同包分发。
