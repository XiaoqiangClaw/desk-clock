# Desk Clock v0.4.0 交付说明

> **历史快照**：本文记录 v0.4.0 当时的行为与验收口径，部分内容已被后续版本覆盖（尤其多窗口配置、窗口管理入口、拖动与位置记忆）。当前版本为 **v0.6.1**，请以 `README.md` 与 `DELIVERY-v0.6.1.md` 为准。

> 本轮按主人两批反馈逐条优化，全部落在 `main` 分支，版本 v0.4.0。
> 本机无 cargo/rustc，Rust 编译以 GitHub Actions 全平台 CI 为准；前端用真实 Chromium 回归。

---

## 第一批：闹钟 / 定时器 / 表盘 / 设置界面 / 打赏

| # | 原话 | 落地 | 验证 |
|---|---|---|---|
| 1 | 闹钟可以添加声音 | Web Audio 合成柔和「叮-叮-叮」三连提示音，循环到用户处理；设置里可开关、可「试听」，提醒卡有「静音」按钮。零音频资源、零依赖 | `verify_v04` 声音控件/静音按钮/默认开启 |
| 2 | 按钮做得漂亮点、不要这么大 | 全局换成 `.dc-btn`：圆角、柔和描边、24px 高的小按钮；提醒卡三个按钮并排且更小；闹钟「删除」改圆形 `×` | `verify_v04` 添加按钮高度 <34px、class 校验 |
| 3 | 每天的勾选单独一行 | 闹钟编辑区改为：第一行 HH / MM 选择，第二行「每天重复」开关 + 「＋添加」 | 结构断言 + 截图 |
| 4 | 删除按钮位置调整 | 列表行改「时间 + 每天标签 …… 最右圆形 ×」，不再和文字挤在一起 | `verify_features` 闹钟可删除 |
| 5 | 定时关机和定时重启完善、没有重启 | 新增「动作：关机 / 重启」，Rust 侧 Windows `/r`、mac/Linux `-r` | `verify_v04` 动作可选且持久化 |
| 6 | 支持设置时间点或当前时长方式 | 新增「方式：时长（N 分钟后）/ 指定时间点（如 23:00）」，时间点跨天自动取次日，前端算好分钟数交给系统命令 | `verify_v04` 模式切换 + `minutesUntil` 正值 |
| 7 | 指针表盘无法正常观看 | 重画：固定 200px 圆心、12 个数字 + 60 刻度、明确 z-index 与 transform-origin，指针不再溢出/看不见 | `verify_v04` 60 刻度/12 数字/3 指针/轴钉 |
| 8 | 默认有黑白 2 种样式 | 表盘配色：深色 / 浅色两套（仅对 analog 生效，不污染其它样式推荐色） | `verify_v04` light 主题生效；`verify_features` neon 推荐色回归 |
| 9 | 缺少「是否显示 :」设置项，隐藏时保留间距 | `showSeparator` 开关；分隔符槽位始终存在，隐藏时只把点设为透明 → 间距不变 | `verify_v04` 点透明 + 槽位数不变 |
| 10 | 缺少「指针穿透」设置项 | `analogPenetrate`：指针尾部越过圆心、秒针略伸出表圈；只在指针表盘样式下显示该行 | `verify_v04` 属性 + 持久化 |
| 11 | 左侧下拉框太丑，美化 | 全部换 `.dc-select`：深灰圆角、自定义箭头、hover/focus 光环；option 显式浅色（Windows WebView2 弹层始终可读） | `verify_features` 意图化断言（深色不透明底+浅色字） |
| 12 | 调不透明度时设置界面也变透明 | 🔴 根因：设置面板是 `#app` 子元素，继承了 opacity。修复：嵌入式面板打开时移除、`body[data-view=settings]` 强制 `opacity:1 !important` | `verify_v04` 两种窗口下 opacity 均恒为 1 |
| 13 | 「查看收款码」改「请作者喝咖啡」 | 按钮文案改为「请作者喝咖啡」（en: Buy me a coffee） | `verify_v04` 文案断言 |
| 14 | 收款码裁剪、居中 | 去底部文字区 + 四周均衡留白，重采样为 640×640 正方形，CSS 中居中显示 | `verify_v04` 图片 naturalWidth/Height 1:1 |
| 15 | 添加链接快速跳转到项目 | 「↗ GitHub · xiaoqiangclub/desk-clock」按钮；**前端只传标识符、Rust 解析真实 URL**（不接受任意路径，防滥用） | `verify_v04` 链接存在 |
| 16 | 自动升级功能 | 打开设置窗口静默检查 GitHub Releases 最新版，发现新版显示「下载新版本」；也可手动「检查更新」。用前端 fetch（GitHub API 允许跨域），Rust 不引入 TLS 依赖 | `verify_v04` 控件 + 版本徽标 |

---

## 第二批：位置 / 单实例多窗口 / 时区 / 校时 / 界面重设计

| # | 原话 | 落地 | 验证 |
|---|---|---|---|
| 17 | 快速设置位置：左上/右上/居中… | 九宫格一键定位（含四角+四边+居中），Rust 用 `current_monitor().work_area()` 物理像素计算，避开任务栏，结果回写位置偏好 | `verify_v04` 9 个按钮 + 关键位置存在 |
| 18 | 只允许一个实例 | 接入 `tauri-plugin-single-instance`；第二次启动把参数交给首个进程并退出，首个进程唤起主窗口 | CI 编译（插件签名已核验） |
| 19 | 支持创建显示多个时间 / 多个窗口 | 同一进程可开任意 `clock-<id>` 独立窗口；启动时按偏好自动恢复；托盘不影响 | `verify_v04` 额外窗口渲染/隐藏齿轮与设置面板 |
| 20 | 支持设置不同的时区 | 内置 14 个常用 UTC 偏移；Rust 注入 `__DC_TZ_OFFSET__`，前端平移 epoch 后按本地 getter 渲染（独立公式验证：UTC+8 本地 13 点、UTC-5 显示 00 点） | `verify_v04` 时区偏移生效断言 |
| 21 | 电脑时间不准 → 是否开启自动同步时间 | 「立即校时」调系统时间服务（Windows `w32tm /resync`、macOS `sntp`、Linux `timedatectl set-ntp`），可勾「启动时自动校时」；需权限，失败如实提示，不假装成功 | `verify_v04` 控件 + 浏览器模式如实提示 |
| 22 | 设置内容太多，是否用 Tab 重新设计 | 重设计为**左侧竖向 Tab（7 组）+ 右侧卡片式分区**：外观 / 窗口 / 闹钟 / 定时任务 / 时区校时 / 权限 / 关于；独立设置窗口只显示当前 Tab，浏览器预览为方便回归平铺全部 | `verify_v04` 7 个 Tab / 7 面板 / 切换只显示一个 / 截图 |
| 23 | 其他你觉得有必要的 | ① 鼠标穿透（托盘有「恢复鼠标」兜底，不会锁死）② 托盘加「检查更新」③ 版本徽标 + 关于卡片 ④ 统一开关控件（`.dc-switch`）⑤ 多时区配置持久化与删除 ⑥ 设置窗口加宽到 560×640 | 各处回归 |

---

## 我主动考虑并做的边界/稳健性

- **外链安全**：前端只传 `project` / `releases` 标识符，Rust 解析真实 URL；不接受前端任意 URL（承既有路径安全铁律）。
- **多时区窗口不触发闹钟**：闹钟按本机时间判断，额外窗口只显示时间，避免重复响铃。
- **点击穿透不锁死**：托盘常驻「恢复鼠标（关闭穿透）」菜单项，即使窗口已收不到鼠标事件也能关。
- **不覆盖其它样式配色**：表盘主题 CSS 限定 `[data-style="analog"]`，修掉了重构中一度出现的「neon 推荐色被 dark 主题覆盖」回归（已复跑验证）。
- **原子写 + 字段级合并**：沿用 v0.3 的 `set_prefs` patch 广播，多窗口并存时不会互相覆盖位置/设置。
- **单实例与多窗口不冲突**：多窗口是同一进程内的多个 WebviewWindow，不是多开进程。
- **更新检查不硬装**：只提示 + 跳转下载，不引入自更新签名/权限复杂度（如实说明）。

## 已知边界（如实）

- 自动提权仍为 Windows 专属；macOS/Linux 的定时动作与系统校时需要 root/polkit，界面如实提示。
- Linux 上 Tauri 不发托盘点击事件，「左键点托盘唤出时钟」无效，用托盘右键菜单「显示时钟」。
- 时区用**固定 UTC 偏移**，不含夏令时（界面已用 UTC±N 标注，避免误导）。
- 系统校时是「请求 OS 同步」，是否立即生效取决于系统时间服务与权限。
- 自动升级检查需要能访问 GitHub API；离线时手动检查会如实显示失败。

## 验证状态

- 前端真实 Chromium：**31 + 43 + 34 + 55 = 163 项全绿**（`verify.py` / `verify_features.py` / `verify_v03.py` / `verify_v04.py`）。
- Rust 编译 + 全平台出包：**GitHub Actions Build run `42574157295` 5/5 job 全绿**；**Release run `42575459657` 4/4 job 全绿**，9 个安装包已发布到 [v0.4.0 Releases](https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.4.0)（含 Windows `.msi` + `.exe`、macOS 双架构 dmg、Linux deb/rpm/AppImage）。
- 期间踩坑已闭环：Windows 打包阶段 WiX/NSIS 工具下载偶发 504（Rust 编译本身成功）→ 抽出 `scripts/prepare-windows-tools.ps1` 预置工具到 Tauri 缓存目录，build.yml / release.yml 共用，实测两个流程的 Windows job 均「WiX ready / NSIS ready」后正常出包。
- 所有新引入 Tauri API 均在 docs.rs / tauri-bundler 源码逐条核验签名；capability 的 `clock-*` 通配符为官方支持的 glob。
- 交付文件：`TESTING-v0.4.md`（安装验收清单）、`README.md`、`DELIVERY.md`、`.preview/settings-window-v04.png`（该图已由 v0.6.1 配图替换）。
