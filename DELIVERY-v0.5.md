# Desk Clock v0.5.0 交付说明

> **历史快照**：本文记录 v0.5.0 当时的行为与验收口径，部分内容已被后续版本覆盖（尤其多窗口配置、窗口管理入口、拖动与位置记忆）。当前版本为 **v0.6.1**，请以 `README.md` 与 `DELIVERY-v0.6.1.md` 为准。

> 按主人 2026-11-09 第三批反馈逐条修复（附 4 张截图），全部落在 `main` 分支，版本 v0.5.0。
> 本机无 cargo/rustc，Rust 编译以 GitHub Actions 全平台 CI 为准；前端用真实 Chromium 回归。

## 逐条对照

| # | 反馈 | 落地 | 验证 |
|---|---|---|---|
| 1 | 「常驻系统托盘…」与「外观」Tab 上沿挤在一起 | 把托盘说明从设置头部**移入「窗口」Tab 的窗口行为卡片**；独立窗口 `tray-hint` 不再是悬浮条，Tab 未切到「窗口」时完全隐藏 | `verify_v05` 6 项：归属 window 面板 / 不在 head / 外观 Tab 隐藏 / 不与 Tab 栏重叠；`verify_v03` 已同步该断言 |
| 2 | 权限界面卡在「正在检查权限…」；点「立即以管理员身份重启」卡在「正在请求授权…」 | **根因**：旧 Rust `restart_elevated` 在同步 Tauri 命令里 `child.wait()` 等 UAC 点击，阻塞主线程 IPC，导致之后所有窗口的 invoke（含权限状态）全部挂起。修复=spawn 后**立即返回**，另起后台线程等结果，仅提权成功才退出本进程；并在提权前调用 `tauri_plugin_single_instance::destroy(app)` 释放实例锁，避免 UAC 新进程被当成第二个实例直接退出。前端再叠双保险：`privilegeStatus/restartElevated/setRunAsAdmin` 全部 `withTimeout`，异常必显示「重新检查」并恢复按钮 | `verify_v05`：正常状态不显示「正在检查」；**模拟 invoke 永不返回**时按钮 8s 后恢复、状态检查 4s 后出「重新检查」，不再永久转圈 |
| 3 | 「一键还原默认」写全；下面「关闭」按钮多余且摆放难看 | 文案改「**一键还原默认设置（Alt+R）**」；**删除**关于页底部多余的 `关闭` 按钮（独立设置窗口用系统标题栏 × / 嵌入面板用头部 ×）；卡片加标题「还原」+ 说明文字，按钮占满整行、说明在下 | `verify_v05`：完整文案 / `settings-close-2` 已不存在 / 说明与按钮不重叠 |
| 4 | 「截图/长按后扫码·感谢你的支持」应删掉前者，直接「感谢您的支持」；「（完全自愿）」删除 | 页脚**精确改为「感谢您的支持」**，去掉所有扫码/截图/长按字样；打赏说明去掉「（完全自愿）」 | `verify_v05` 3 项文案精确匹配 |
| 5 | 多时区应做成「管理器」，可开多个窗口、任意时区、各自样式 | 重做为**多时区窗口管理器**：① 名称 ② 时区（内置 20 个常用 + **自定义 UTC 偏移**，支持 ±HH:MM 任意值如 +05:45）③ 每窗口独立样式（跟随全局或 8 选 1）④ 每窗口独立「显示秒」⑤ 列表可**编辑 / 隐藏 / 显示 / 删除**，编辑后保存会销毁并按新配置重建窗口。Rust 侧 `add_clock_window` 扩展 style/showSeconds/visible，新增 `set_clock_window_visible`，注入 `__DC_STYLE__/__DC_SHOW_SECONDS__` | `verify_v05` 12 项：+05:45→345 分钟、样式/秒持久化、编辑/隐藏/显示/删除；`verify_v04` 已适配管理器 id |
| 6 | 定时关机/重启的「启动」按钮应和输入框同一行 | 重构为**单行 `.shutdown-line`**：输入框 + 单位 + 启动（或取消）并排；修复 `body[data-view=settings] .dc-input` 的 230px 高特异覆盖导致换行的问题 | `verify_v05` + `verify_v04`：时长/时间点两种模式均同行（y 差 <14px） |
| 7 | 闹钟应预设一些响铃声音，也支持自定义 | 新增**5 种预设铃声**（柔和三连 / 清脆叮咚 / 电子滴答 / 上升音阶 / 和弦钟声）+ **自定义音频**（选本地音频文件，≤500KB，base64 存 localStorage，仅本机、不上传、可移除）；切换即试听，选择持久化 | `verify_v05`：6 个选项 / 持久化 / 试听 / 自定义选择控件 / `Alarm.ALLOWED_TONES` |
| 8 | 设置界面右侧下拉框想隐藏，直接用鼠标滚轮滑动 | **隐藏原生下拉箭头**（保留点击/键盘兜底），给所有 `select.dc-select` 绑**滚轮切换选项**（触发标准 change，现有逻辑全部复用）；同时隐藏设置面板/列表的滚动条但保留滚轮滚动 | `verify_v05`：箭头弱化 / 滚轮改变选中值 / `scrollbar-width:none` |
| 9 | 设置界面卡顿不流畅，请优化 | 拆出 **`applyRootLite`**：滑块 `input`、拖动缩放、跨窗口同步只改 CSS 变量并**早退**，不再全量 `I18n.apply` 遍历 DOM、不再全量重绘管理器/闹钟列表；Tab 切换改平滑滚动；降低 `resize-handle` z-index 避免遮挡齿轮 | `verify_v05`：拖动不透明度滑块时 `I18n.apply` 调用数 = 0 |
| 10 | 点击版本号可跳转项目 | 头部版本徽标与「关于」页版本号都改为可点按钮，点击走 Rust `open_link('project')`（前端只传标识符，不接受任意 URL） | `verify_v05`：点击后 `open_link` 调用 +1 |

## 验证状态

- 真实 Chromium 回归：**31 + 43 + 34 + 63 + 45 = 216 项全绿**
  （`verify.py` / `verify_features.py` / `verify_v03.py` / `verify_v04.py` / `verify_v05.py`）。
- 静态检查（模拟 CI）：5 个 Python 脚本 `py_compile`、3 个 shell `bash -n`、8 个 JS `node --check`、2 个 JSON、2 个 workflow YAML 全部通过。
- Rust 全平台编译/打包：以 GitHub Actions CI 为准（本机无 cargo）；新增 API 均已对 docs.rs / 插件源码逐条核验签名：
  - `tauri_plugin_single_instance::destroy<R: Runtime, M: Manager<R>>(&M)`（稳定版 2.5.5 提供）；
  - `WebviewWindowBuilder::visible(bool)`、`WebviewWindow::show/hide/destroy`、`AppHandle::exit`；
  - `Option::filter` / `Option::as_deref` / `Child::wait`（`&mut self`）。

## 如实边界

- 时区使用**固定 UTC 偏移**（不含夏令时），界面以 `UTC±N` 明确标注；自定义偏移范围 ±14:00。
- 自定义铃声只存本机浏览器存储、≤500KB，不随偏好跨窗口同步、不写进 `prefs.json`。
- 提权重启仅在 Windows 有效；macOS/Linux 保持不自动提权并如实提示。
