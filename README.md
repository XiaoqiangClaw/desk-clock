# Desk Clock

一个**开源免费**的桌面时钟：只显示时间，可选是否显示秒，多种社区流行样式（含参考图那种
去黑底的翻页卡片），低资源占用、稳定、无边框、支持开机自启、记住窗口位置，
一套代码跨 **Windows / macOS / Linux**。

> 本项目采用 [MIT License](LICENSE)，由 GitHub Actions 在**公共仓库**自动打包全平台安装包（公库 Actions 免费无限）。

## 为什么是这个架构

| 需求 | 做法 |
|---|---|
| 减少系统资源占用 | **Tauri v2** 复用系统自带 WebView（Win=WebView2 / macOS=WKWebView / Linux=WebKitGTK），不打包第二个 Chromium；Rust 壳只管窗口/托盘/自启/位置，没有常驻轮询 |
| 稳定 | 前端零框架、零打包器、零 ES module、零运行时依赖；全部传统 `<script>` 挂全局命名空间，`file://` 直接打开也能跑；偏好写入用「临时文件 + 原子 rename」，断电不会写坏 |
| 低 CPU | 不用 `setInterval`；每次 tick 后计算到下一个整秒/整分，用**单次 `setTimeout`** 唤醒；关秒时每分钟只醒一次；窗口隐藏/最小化暂停；翻页动画只在真正变化的数位触发 |
| 不要黑色背景 / 不要边框 | 透明窗口（`transparent:true` + `decorations:false`）+ 页面 `background:transparent`；翻页卡片本身浮在透明背景上，时钟主体**无任何外框/描边/黑底**；默认背板 `none` |
| 记住位置 | Rust 启动读 prefs 恢复坐标（并校验仍在可见显示器内，显示器拔了自动居中兜底）；前端监听窗口移动，防抖 400ms 写回 |
| 开机自启 | Tauri 官方 `autostart` 插件（macOS=LaunchAgent，Windows=注册表，Linux=desktop entry），设置面板勾选即生效，以系统返回的实际状态为准 |
| 多系统 | 同一份 Rust + 静态前端，三系统各自 `cargo tauri build` 出原生安装包 |

## 目录

```
ui/                 静态前端（index.html + 4 个 JS + styles.css）—— 浏览器可直接打开
src-tauri/          Tauri v2 Rust 壳（窗口 / 偏好持久化 / 位置恢复 / 自启）
docs/SPEC.md        设计契约（模块接口、8 种样式、验收标准）
scripts/dev.sh      开发运行
scripts/build.sh    出各平台安装包
scripts/preview.sh  无头 Chromium 截图验收 8 种样式
```

## 快速开始

### 只想看长什么样（不需要 Rust）

```bash
bash scripts/preview.sh          # 生成 .preview/*.png 八张样式截图
# 或直接浏览器打开 ui/index.html
```

### 直接下载安装包

在 [Releases](https://github.com/xiaoqiangclub/desk-clock/releases) 下载对应平台的安装包；
每次 push 到 `main` 或手动触发 workflow 后，[Actions](https://github.com/xiaoqiangclub/desk-clock/actions) 会产出可下载的构建产物。

浏览器模式下设置存 `localStorage`，可即时切换样式/秒/12 小时制/背板/缩放/不透明度。

### 装成桌面程序

前置（各系统一次）：

- 通用：[Rust ≥ 1.77](https://rustup.rs) + `cargo install tauri-cli --version '^2.0.0' --locked`
- Linux(Debian/Ubuntu)：`sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- Windows：WebView2 Runtime（Win11 自带）+ MSVC Build Tools
- macOS：Xcode Command Line Tools

```bash
bash scripts/dev.sh       # 开发运行
bash scripts/build.sh     # 出安装包（产物在 src-tauri/target/release/bundle/）
```

## 使用

- 无边框窗口，**按住时钟任意空白处拖动**（`data-tauri-drag-region`）；
- 点右下角齿轮打开设置；
- 样式：`flip`（去黑底翻页牌）/ `minimal` / `neon` / `eink` / `segment` / `typewriter` / `glass` / `analog`；
- 「开机自启」「总在最前」由原生壳接管；
- 背板默认 `none`（全透明），在花哨壁纸上可读性不足时可选 `blur` / `dim` / `light`（都是极低透明度，不是黑底）；
- 系统开启「减少动态效果」时自动关闭翻页动画。

## 状态

- [x] 架构 / 设计契约
- [x] Tauri v2 壳（透明无边框窗口、偏好原子持久化、位置恢复与越界兜底、自启、置顶权限）
- [x] 静态前端（8 样式、翻页 3D 动画、单次 setTimeout 引擎、设置面板）
- [x] 无头 Chromium 功能 + 视觉验收（31/31 PASS）
- [x] **Linux 原生安装包已在 InstaBox 主机真编译并回拉**（`dist/` 下 deb + rpm，零 warning，SHA256 校验一致）
- [ ] Windows / macOS 安装包需在对应系统上跑 `scripts/build.sh`（Tauri 不支持跨平台交叉编译）

### 现成安装包
```
dist/Desk-Clock_0.1.0_amd64.deb          Debian/Ubuntu/Mint：sudo apt install ./dist/*.deb
dist/Desk-Clock-0.1.0-1.x86_64.rpm       Fedora/RHEL/openSUSE：sudo dnf install ./dist/*.rpm
```

## 开源

- 协议：[MIT](LICENSE)
- 自动打包：`.github/workflows/build.yml`（Linux / Windows / macOS 四目标矩阵，产物上传为 workflow artifacts）
- 欢迎 PR；提交前请先跑 `python3 scripts/verify.py` 与 `bash scripts/build.sh`（需本地 Rust 环境）。
