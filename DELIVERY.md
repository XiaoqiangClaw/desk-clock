# 交付说明（给主人）· 2026-11-08

## 成品
开源（MIT）桌面时钟 **Desk Clock**，一套代码跨 Windows / macOS / Linux；源码托管于 GitHub 公共仓库，由 GitHub Actions 免费自动打包。

## 你要的，逐条对照
| 你的要求 | 落实情况 |
|---|---|
| 只显示时间 | ✅ 就只是时间，无日期/无闹钟/无多余功能 |
| 可选是否显示秒 | ✅ 设置面板勾选；关掉后**每分钟才醒一次**（更省资源） |
| 多种社区流行样式 | ✅ 8 种：翻页卡片 / 极简细体 / 霓虹 / 电子墨水 / 七段数码管 / 打字机终端 / 毛玻璃 / 指针表盘，随点随切 |
| 参考图那种翻页卡片 | ✅ `flip` 样式：split-flap 卡片 + 水平铰链中线 + 上下半明暗差 + 双点冒号 + 真实 3D 翻页动画 |
| 去掉黑色背景 | ✅ 窗口全透明 + 卡片无外框无黑底；`backdrop` 默认 `none`（要可读性可换 blur/dim/light 极低透明度背板，都不是黑底） |
| 无边框 | ✅ 无窗口边框、无标题栏、时钟主体无描边/无外阴影（8 种样式逐一目检 + 计算样式断言：border=0px、background=transparent、box-shadow=none） |
| 减少资源占用、稳定 | ✅ 不打包第二个 Chromium（Tauri 复用系统 WebView）；不用 setInterval，单次 setTimeout 对齐整秒/整分；窗口隐藏/最小化暂停；翻页只在变化数位动画；断点续存、设置原子写入（临时文件+rename）不会写坏 |
| 开机自启 | ✅ Tauri 官方 autostart 插件（Win 注册表 / macOS LaunchAgent / Linux 桌面项），勾选即生效，**勾选状态回读系统真实状态**（注册失败会如实回落） |
| 保持时钟位置 | ✅ 窗口移动防抖 400ms 存物理坐标，启动按 DPI 转逻辑坐标恢复；**拔显示器越界时自动回中**，不会出现在找不到的位置 |
| 多系统 | ✅ 同代码 Win/macOS/Linux；各平台 `scripts/build.sh` 出原生安装包 |
| 选择好的语言与架构 | ✅ Rust(Tauri v2) 薄壳 + 原生 HTML/CSS/JS（零框架、零打包、零运行时依赖、零 npm） |

## 配置项（设置面板，齿轮按钮）
样式 8 选 1 · 显示秒 · 12/24 小时 · **总在最前** · 开机自启 · 背板(none/blur/dim/light) · 缩放(0.5~2.5) · 不透明度(0.3~1) · 关闭
拖动：按住时钟任意空白处移动（无边框窗口靠原生拖拽区）。

## 验收证据（不是口头说完成）
- 真实 Chromium 无头跑通：`python3 scripts/verify.py` → **31/31 PASS**（8 样式渲染、秒开关联动 8↔5 位、12/24 小时换算、置顶/自启/背板/缩放/不透明度全部「即时生效+持久化+状态回显」、透明无边框、全程无 JS 报错）
- 8 张样式截图在 `.preview/`（透明底，PNG 黑底只是查看器底色，真实桌面/系统壁纸上为全透明）
- 翻页动画：秒针位每秒真实 3D 翻转（截图 flip.png 为静止帧）
- 低资源设计已落地（单次定时器/隐藏暂停/逐位动画/系统 WebView）

## 交付内容
1. **完整源码**：`projects/desk-clock/`（已开源至 `github.com/xiaoqiangclub/desk-clock`，MIT）
2. **一键脚本**：`scripts/dev.sh`（开发）、`scripts/build.sh`（出安装包）、`scripts/verify.py`（回归验收）
3. **立即可看的成品**：直接用浏览器打开 `ui/index.html` 就是全功能时钟（浏览器模式设置存 localStorage）
4. 各平台安装包：在装有 Rust 的目标机上 `bash scripts/build.sh`，产物在 `src-tauri/target/release/bundle/`

## 原生安装包（已在 InstaBox 主机真编译）
- 构建环境：InstaBox `d-spare-01`（Debian 13 / Rust 1.99 / 4C8G），Tauri CLI v2.12.4 + Tauri v2.12.5，`libwebkit2gtk-4.1-dev` 等依赖齐备
- 产物（已回拉到 `dist/`，均与远端 SHA256 一致）：
  - `Desk-Clock_0.1.0_amd64.deb` — Debian/Ubuntu/Mint 系（`sudo dpkg -i` 或 `sudo apt install ./...deb`）
  - `Desk-Clock-0.1.0-1.x86_64.rpm` — Fedora/RHEL/openSUSE 系（`sudo rpm -i` 或 `dnf install ./...rpm`）
  - `.AppImage`（103 MiB）在远端也成功产出，因回拉通道对大文件不稳定未带回；需要时可在目标机重跑 `scripts/build.sh`，或单独索取
- 编译零 warning；源码与二进制一致（修完两处无害告警后增量重编译并回拉覆盖）
- Windows（.msi/.exe）与 macOS（.dmg/.app）需**在对应系统上**跑 `scripts/build.sh`（跨平台交叉编译 Tauri 不支持，这是工具链限制，非代码问题）

## 如实边界（不冒充已做）
- 自启/置顶的**真实系统效果**需在有图形界面的目标机上首跑确认一次（代码路径与权限已齐、编译通过；本网关无桌面环境不实测 GUI）
- 透明窗口在 Linux 依赖 WebKitGTK 合成器支持；个别纯 X11/无合成 WM 下透明可能退化为不透明（Tauri/WebKit 平台限制）
- `analog` 样式关秒时隐藏秒针（表盘与刻度仍保留，属正常表盘观感）
- AppImage 与 Win/macOS 安装包见上节说明
