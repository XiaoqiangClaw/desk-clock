# Desk Clock v0.6.3 交付说明

> 当前版本交付口径；历史快照见 `DELIVERY.md` 总索引与 `DELIVERY-v0.6.2.md`。

## 问题

安装 / 更新时选择「自动关闭运行中的工具」失败：弹出 NSIS 提示「Desk Clock 正在运行！点击确定以终止运行。」后无法自动关闭进程。

## 根因

官方 `installer.nsi` 在复制/删除文件前用 `CheckIfAppIsRunning`（Windows RestartManager）发 `WM_CLOSE` 并等待进程退出；而本程序 `lib.rs` 的 `.on_window_event` 对**所有窗口**一律 `api.prevent_close(); window.hide();`（点 × 只隐藏到托盘）。安装器的关闭请求同样被拦成「隐藏窗口」，进程仍在 → `RmShutdown` 失败并 `Abort`。

## 修法（最小改动，不改普通关窗语义）

1. `src-tauri/src/lib.rs`：单实例插件回调识别 `--dc-exit-for-install` → `app.exit(0)`；其余参数仍 `show_main_now`。`CloseRequested → hide` 语义不变，托盘「退出」照旧 `app.exit(0)`。
2. `src-tauri/windows/hooks.nsh`（新建）：定义官方 `NSIS_HOOK_PREINSTALL` / `NSIS_HOOK_PREUNINSTALL`（POST 两个为空宏），共用 `_DC_PREPARE_APP_EXIT`：
   - `nsis_tauri_utils::RunAsUser "$INSTDIR\desk-clock.exe" "--dc-exit-for-install"` 经 `tauri-plugin-single-instance` 把参数转发给已在运行的实例，请求优雅退出；
   - 每 200ms 用 `FindProcessCurrentUser "desk-clock.exe"` 查一次，最多 15 次（约 3 秒）；返回值 0=仍在运行、非 0=已退出；
   - 仍在运行则 `KillProcessCurrentUser "desk-clock.exe"` 兜底。其返回值不强制判断（1=有没杀掉的），如实交给模板后续 `CheckIfAppIsRunning` 报错，不静默吞掉。
3. `src-tauri/tauri.conf.json`：`bundle.windows.nsis.installerHooks = "./windows/hooks.nsh"`（宏在 `CheckIfAppIsRunning` 之前执行）。`bundle.active/targets/icon` 保持不变。
4. 版本四处升 `0.6.3`（`Cargo.toml` / `tauri.conf.json` / `ui/app.js` / 3 处 Rust 硬编码标题 + 主窗口 title），新增 `scripts/verify_v063.py` 纯结构断言，3 张设置配图按 v0.6.3 重新生成（文件名沿用 `settings-window-v062.png`）。

## 验证

- `scripts/verify_v063.py`：钩子宏、`installerHooks` 路径、单实例退出回调、四处版本、文档齐全，全绿。
- 既有 8 套真实 Chromium 回归 `31+43+35+60+55+22+30+34 = 310` 项全绿（版本断言同步到 0.6.3）。
- `python3 -m py_compile` / `node --check` / JSON 解析 / Rust 括号结构静态校验全过；Rust 编译与 NSIS 打包以 GitHub Actions CI 为准（本机缺 webkit 开发库，未跑 cargo）。
- 回归数字 310 不变：本轮不新增前端断言。

## 复测步骤

1. 先装 v0.6.2 并让 Desk Clock 保持运行（托盘常驻）。
2. 双击 v0.6.3 安装包覆盖安装，提示「Desk Clock 正在运行」时点「确定 / 自动关闭运行中的工具」。
3. 应**自动关闭成功**、安装顺利完成，不再弹「自动关闭失败」；安装后启动新版本，托盘图标正常。
4. 再测一次卸载（从控制面板或安装器卸载入口），同样应自动关闭成功。
5. 回归确认：普通点窗口 × 仍只隐藏到托盘，托盘菜单「退出」才真正结束进程。
