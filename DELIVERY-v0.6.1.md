# Desk Clock v0.6.1 交付说明

> 按主人 2026-11-10 安装测试反馈的修复版。

## 修复清单

| # | 项 | 处理 |
|---|---|---|
| 反馈 1 | 多时区并入窗口页 | 删掉独立的「多时区」Tab，窗口管理器整体并入「窗口」页 |
| 反馈 2 | 窗口图标换 ⊞ | 「窗口」Tab 图标由 `▢` 改为 `⊞` |
| 反馈 3 | 添加表单精简为「名称 + 按钮」 | 移除创建表单里的时区 / 自定义偏移 / 窗口样式 / 显示秒等冗余项，只留名称输入与「添加窗口」按钮 |
| 反馈 4 | 主窗口纳入窗口管理卡片 | 窗口清单首行恒列出「主窗口」卡片，不可删除、无隐藏按钮 |
| 反馈 5 | 新窗口可手动移动 | 补齐窗口拖动权限、放开额外窗口鼠标，新窗口可直接拖动 |
| 反馈 6 | 窗口位置完全独立 | 移动监听改为窗口作用域，各窗口位置各记各的，互不干扰 |
| 反馈 7 | 设置头部删「设置」二字；「正在编辑」与下拉框同行 | 删除头部标题文案，修正被 `.settings label` 命中的布局，让标签与目标选择框同一行 |
| 自查 1 | 额外窗口恢复齿轮与缩放柄且不再强制鼠标穿透 | 取消 `isExtraWindow` 的隐藏与强制穿透，额外窗口与主窗口完全平等，按各自 `clickThrough` 配置决定是否穿透 |
| 自查 2 | 一键还原默认不再误删窗口（缺陷 A） | `resetDefaults()` 保留 `state.extraClocks`，还原只重置设置项，不清空运行中的窗口清单 |
| 自查 3 | 新窗口完整继承主窗口配置（缺陷 B） | `add_clock_window` 只复制 `main` 当前完整配置并清空 x/y，不再覆盖时区 / 名称 / 秒 / 样式；浏览器预览分支同步去掉 4 行覆盖 |
| 自查 4 | 启动恢复改用每窗口 `clocks.json` 位置与注入值，避免重启回退（缺陷 C） | `spawn_extra_window` 的注入值改从该窗口自己的 `clocks.json` 配置读取（权威），不再用 legacy `extra_clocks` 的旧 offset/style/showSeconds；位置恢复也改读每窗口 x/y |

## 根因

**① 连锁移动（移动一个窗口其它窗口跟着动）**：`listenMoved` 用 `window.__TAURI__.event.listen('tauri://move')` 注册的是 **Any-target** 监听。Tauri 2.10.2 事件分发里的 `match_any_or_filter` 对 `EventTarget::Any` 直接判定为匹配返回 `true`，从而绕过 `emit_to_window` 的窗口过滤 —— 每个窗口都会收到所有窗口的 `tauri://move`，并把别人的坐标写进自己的配置、被重新定位。现改用 `getCurrentWebviewWindow().onMoved(...)` 注册 **Window 作用域**监听，只接收本窗口的移动事件。

**② 拖不动**：`capabilities/default.json` 原只有 `core:default`，而 Tauri 2.10.2 `build.rs` 中 `start_dragging` / `internal_toggle_maximize` 默认不授权，`#app` 的 `data-tauri-drag-region` 调用 `plugin:window|start_dragging` 会被 ACL 拒绝；同时额外窗口被 `set_ignore_cursor_events(true)` 恒强制鼠标穿透，收不到鼠标事件。现已补 `core:window:allow-start-dragging` / `core:window:allow-internal-toggle-maximize` 权限，并取消恒穿透，改由每个窗口自己的 `clickThrough` 配置决定。

## 验证

- 真实 Chromium 回归：`31 + 43 + 35 + 60 + 55 + 22 + 30 = 276` 项全绿（新增 `verify_v061.py` 30 项，覆盖 7 项反馈的 UI/布局/位置独立性，以及本轮补强的「还原默认保留窗口清单 / 新窗口继承主窗口时区 / 注入值取自每窗口配置」等断言）。
- 静态检查全过：JS `node --check`、Python `py_compile`、JSON 解析、源码结构断言。
- Rust 全平台编译/打包以 GitHub Actions CI 为准（本机无 webkit 开发库，未跑 cargo）。

## 如实边界

- 时区仍是固定 UTC 偏移（不含夏令时），界面以 UTC±N 标注。
- 鼠标穿透开启后窗口不再接收鼠标事件，需走托盘「恢复鼠标（关闭穿透）」恢复。
- 浏览器预览不创建真实窗口，多窗口行为以原生安装版为准。
