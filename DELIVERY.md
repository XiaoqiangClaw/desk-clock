# Desk Clock 交付总览

本文件是各版本交付说明的**总索引**。当前版本 **v0.6.2**，行为以 `README.md` 与 `DELIVERY-v0.6.2.md` 为准；各版本逐条反馈 → 修复 → 验证对照见对应版本文件。

## 版本索引

| 版本 | 主题 | 交付文件 | TESTING | Release |
|---|---|---|---|---|
| v0.3.0 | 托盘常驻、独立设置窗口、管理员权限（无独立交付文件，记录见 `DELIVERY-v0.4.md` 之前的历史与 `TESTING-v0.3.md`） | — | `TESTING-v0.3.md` | [v0.3.0](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.3.0) |
| v0.4.0 | 闹钟 / 定时关机重启 / 表盘重绘 / Tab 化设置 / 多窗口与时区 / 系统校时 / 自动更新检查（本仓第一批 + 第二批反馈） | `DELIVERY-v0.4.md` | `TESTING-v0.4.md` | [v0.4.0](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.4.0) |
| v0.5.0 | 多时区窗口管理器、闹钟铃声、UAC 卡死修复、界面与流畅度优化 | `DELIVERY-v0.5.md` | `TESTING-v0.5.md` | [v0.5.0](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.5.0) |
| v0.5.1 | 额外窗口点击拦截修复、异步建窗、权限状态不再被 i18n 重置 | `DELIVERY-v0.5.1.md` | `TESTING-v0.5.1.md` | [v0.5.1](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.5.1) |
| v0.6.0 | **所有窗口完全平等**：`clocks.json` 每窗口完整配置、「正在编辑」目标切换、主窗口也能设时区 | `DELIVERY-v0.6.0.md` | `TESTING-v0.6.0.md` | [v0.6.0](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.6.0) |
| v0.6.1 | 窗口管理并入「窗口」页并精简表单、头部布局整理；修复窗口拖不动与窗口连锁移动；位置/注入值每窗口独立 | `DELIVERY-v0.6.1.md` | `TESTING-v0.6.1.md` | [v0.6.1](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.6.1) |
| v0.6.2 | 九宫格内容贴边、校时页时区说明、版本号进标题、头部左对齐；弹窗屏幕居中可点击、响铃时长、定时任务提前提醒/静默/终止（**当前**） | `DELIVERY-v0.6.2.md` | `TESTING-v0.6.2.md` | [v0.6.2](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.6.2) |

> v0.3.0 与 v0.4.0 阶段没有独立于 `DELIVERY.md` 的版本文件；v0.4.0 的完整交付说明已原样迁移至 `DELIVERY-v0.4.md`。

## 当前版本交付口径

- **回归**：无头真实 Chromium 共 **310 项全绿**：`verify.py` 31 + `verify_features.py` 43 + `verify_v03.py` 35 + `verify_v04.py` 60 + `verify_v05.py` 55 + `verify_v06.py` 22 + `verify_v061.py` 30 + `verify_v062.py` 34。
- **verify 脚本清单**：`scripts/verify.py`（基础功能 + 视觉）、`verify_features.py`（双语/字体色/还原/闹钟/关机/拖拽）、`verify_v03.py`（托盘/权限）、`verify_v04.py`（v0.4 新功能）、`verify_v05.py`（v0.5 反馈批次）、`verify_v06.py`（每窗口独立配置）、`verify_v061.py`（v0.6.1 反馈批次 + 位置独立性）、`verify_v062.py`（v0.6.2 反馈批次：贴边/标题/头部/弹窗/响铃/提醒）。另有独立工具脚本 `scripts/preview_settings.py`（生成设置界面配图，不参与断言）。
- **CI**：GitHub Actions 全平台构建，Release 产出 **9 个安装包**（Windows `.msi` + `-setup.exe`、macOS Intel/Apple Silicon 双 dmg、Linux deb/rpm/AppImage）。
- **配图**：`.preview/` 共 11 张 —— 8 张时钟样式截图（flip/minimal/neon/eink/segment/typewriter/glass/analog）+ 3 张 v0.6.2 设置界面截图（`settings-zh.png`、`settings-en.png`、`settings-window-v062.png`，由 `scripts/preview_settings.py` 生成）。
- **安装验收**：当前版本步骤见 `TESTING-v0.6.2.md`。
