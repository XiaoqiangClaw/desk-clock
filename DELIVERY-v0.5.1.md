# Desk Clock v0.5.1 交付说明

> 按主人 2026-11-09 第四批反馈（2 张截图 + 追加的点击拦截 bug）逐条修复，版本 v0.5.1。

## 逐条对照

| # | 反馈 | 根因 / 落地 | 验证 |
|---|---|---|---|
| 1 | 「多时区窗口管理器」单独作为一个设置页面 | 从「时区校时」Tab 拆出，新增独立 Tab「多时区」；校时仍留在原页。共 8 个 Tab | `verify_v05` 独立页断言 + `verify_v04` 8 Tab/8 面板 |
| 2 | **添加窗口后电脑上并没有显示出窗口** | 根因：`add_clock_window` 在**同步 Tauri 命令里直接 `WebviewWindowBuilder::build()`**，Windows WebView2 下与主线程互锁（项目里 `ensure_settings_window` 早就注明要规避）；且所有窗口都 `.center()` 完全重叠。修复：命令改 `async` + **后台线程建窗**，并按已有窗口数**自动错开位置**；另加窗口存在性回写，建窗失败会把该项标成「已隐藏」而不是假的「运行中」 | `verify_v05` 管理器配置/列表；Rust 由 CI 编译验证 |
| 3 | **新增窗口后其它应用窗口的按钮点不动** | 根因：额外窗口是 `transparent(true)` + `always_on_top(true)` 的 640×220 无边框大矩形，**透明区域照样接收鼠标事件**，盖住其它程序形成隐形点击挡板。修复：额外窗口统一 `set_ignore_cursor_events(true)`（鼠标穿透；它本来就没有齿轮/缩放柄/设置等交互元素）；同时去掉强制置顶，改为**跟随全局「总在最前」** | Rust 结构 + CI 编译；此为本轮最严重 bug |
| 4 | 「关闭」按钮改为「删除」 | i18n 的 `cmDelete` 中英文均改为「删除 / Delete」，按钮直接取该键 | `verify_v05` 断言按钮文字含「删除」不含「关闭」 |
| 5 | **新增窗口后电脑会卡** | 三处根因：① 同步 build 死锁（见 #2）② 隐藏的窗口 Tauri `hide()` 不会让 `document.hidden` 变 true，**仍每秒 tick**（多窗口叠加白耗资源）③ 连点会并发建窗。修复：`emit_to` 定向通知隐藏窗口 `engine.stop()` / 显示时 `engine.start()`；添加按钮建窗期间禁用 900ms 防连点；沿用 v0.5 的轻量渲染路径 | `verify_v05` 无 JS 错误；Rust 由 CI 验证 |
| 6 | **设置管理员身份启动后，权限界面一直「正在检查权限…」** | 根因不是真的卡住：`#perm-status` 带 `data-i18n="permChecking"`，每次 `I18n.apply()`（切换任何设置/跨窗口同步都会触发）都把**已渲染好的真实状态**重写回占位文案。截图中下方「当前已以管理员身份运行」「开关已打开」「退出程序」全部正常，正好印证。修复：`I18n.apply` 跳过带 `data-dyn` 的节点；#perm-status / 定时状态 / 校时状态 / 铃声状态 / 更新状态共 5 处打标记 | `verify_v05` 新增断言：手动触发 `I18n.apply('zh-CN')` 后状态文本**保持不变** |
| 7 | 设置界面固定大小、不显示下拉框（滚动条）、确保所有内容正常显示 | 设置窗口固定 **760×700**（`min=max=inner_size`、不可缩放）；内部只有右侧面板滚动，`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`，**滚轮仍可滚动**；键盘焦点用细描边代替滚动条。逐个 Tab 滚到底验证内容不截断（外观页 713px 内容 / 649px 视口，可完整滚到） | `verify_v05` 逐 Tab 可达性 + 滚动条隐藏断言 |

## 主动补修（主人未提，但排查发现）

- **假「运行中」**：窗口创建改为异步后，前端会核对 Rust `list_clock_windows` 的真实窗口列表（轮询 4 次），建窗失败自动把该行标为已隐藏。
- **隐藏窗口停表**：如上 #5，避免多个隐藏窗口继续跑动画。
- **防连点**：建窗期间禁用「＋ 添加窗口」。
- **位置**：不再全部居中重叠，按窗口数错开；不再强制置顶。
- 5 个动态状态节点统一加 `data-dyn`，一次性杜绝同类「文案被 i18n 重置」问题（定时状态、校时状态、铃声状态、更新状态也一并受益）。

## 验证状态

- 真实 Chromium 回归：**31 + 43 + 34 + 63 + 55 = 226 项全绿**。
- 静态检查（模拟 CI）：5 个 Python 脚本 `py_compile`、3 个 shell `bash -n`、8 个 JS `node --check`、2 个 JSON、2 个 workflow YAML 全过。
- Rust 全平台编译/打包：以 GitHub Actions CI 为准（本机无 cargo）。新增 API 均已对 docs.rs 逐条核验签名：
  `WebviewWindowBuilder::max_inner_size`、`Emitter::emit_to<I,S>(&self, target, event, payload)`（用 `&str` 作 `EventTarget`）、`WebviewWindow::set_ignore_cursor_events`、`WebviewWindow::destroy/show/hide`。

## 如实边界

- 额外时钟窗口为**纯展示**：鼠标穿透后无法直接拖动/点击关闭，请从设置里的「多时区」页用「隐藏 / 显示 / 删除」管理（这也是避免它拦截其它应用的代价）。
- 窗口位置按逻辑像素错开，极端多显示器/混合缩放环境下若跑到屏幕外，可用「隐藏 → 显示」重建。
- 时区仍为固定 UTC 偏移（不含夏令时）。
