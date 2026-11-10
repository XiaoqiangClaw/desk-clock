# v0.6.3 安装测试清单（给主人）

> 本轮只修一件事：NSIS 安装/更新时「自动关闭运行中的工具」。历史快照见 `TESTING-v0.6.2.md`，当前版本以本文件与 `DELIVERY-v0.6.3.md` 为准。

| 系统 | 下载（以 Release 实际资产名为准） |
|---|---|
| Windows | `Desk.Clock_0.6.3_x64_en-US.msi`（推荐）/ `Desk.Clock_0.6.3_x64-setup.exe` |
| macOS M 系列 | `Desk.Clock_0.6.3_aarch64.dmg` |
| macOS Intel | `Desk.Clock_0.6.3_x64.dmg` |
| Ubuntu/Debian | `Desk.Clock_0.6.3_amd64.deb` |
| Fedora/RHEL | `Desk.Clock-0.6.3-1.x86_64.rpm` |
| 其它 Linux | `Desk.Clock_0.6.3_amd64.AppImage` |

> 覆盖安装即可，旧配置自动迁移，不丢设置。

## 一、本轮修复复测（重点，仅 Windows NSIS `-setup.exe` 涉及）

1. **保持旧版运行**：先装 v0.6.2 启动，确认托盘里有 Desk Clock 图标、时钟窗口可见（不要手动退出）。
2. **覆盖安装**：双击 v0.6.3 的 `*-setup.exe`，出现「Desk Clock 正在运行！点击确定以终止运行。」时点「确定」（即「自动关闭运行中的工具」）。
3. **预期**：安装器**自动关闭旧实例并顺利完成**，不再弹「自动关闭失败 / 无法终止」；全程不需手动去托盘点退出，也不需要任务管理器结束进程。
4. **安装后**：启动 v0.6.3，托盘图标正常、时钟窗口正常显示、原有配置/窗口清单/位置不丢；系统标题栏/窗口列表带 `v0.6.3`。
5. **卸载路径**：再从控制面板或安装器卸载入口卸载一次，同样应自动关闭运行中的实例而无需手动退出。

## 二、回归确认（不能退化）

6. 普通点窗口右上角 × 仍只是**隐藏到托盘**（进程不退出），左键点托盘可重新唤出；托盘菜单「退出」才真正结束进程。
7. 闹钟 / 定时提醒弹窗、响铃时长、定时任务提前提醒与终止、九宫格贴边、多窗口独立配置、中英双语、自动更新检查、校时页时区说明照常（详见 `TESTING-v0.6.2.md`，仅作回归，不是本轮新增）。
8. 设置窗口 3 张配图已按 v0.6.3 重生成（文件名沿用 `settings-window-v062.png`），头部版本徽标显示 `v0.6.3`。

---

如实边界：`installerHooks` 仅作用于 Windows NSIS (`-setup.exe`) 安装器；`.msi` 走 WiX 自身的关闭策略，macOS/Linux 不涉及 RestartManager。Rust 编译与 NSIS 打包以 GitHub Actions CI 为准，本机未跑 cargo。

仍有问题请回「系统 + 包类型（msi / setup.exe）+ 哪一步 + 截图」。
