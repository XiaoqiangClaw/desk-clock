# 交付说明（给主人）· 2026-11-09 · v0.3

## 本轮新增（按你的要求逐条对照）
| 你的要求 | 落实情况 |
|---|---|
| 启动后不显示任务栏图标 | ✅ 主窗口 `skipTaskbar: true`，改由**系统托盘常驻**（TrayIconBuilder + 应用图标 + 菜单） |
| 点击设置图标弹出**独立设置窗口** | ✅ 齿轮不再展开内嵌面板，而是调用 Rust 命令创建真正的原生窗口（可拖拽标题栏、可调整大小）；同一个 `index.html` 通过初始化脚本切换为「设置视图」，零重复代码 |
| 关闭不退出，托盘常驻 | ✅ 任何窗口点 ✕ / Alt+F4 都只是隐藏；托盘菜单「显示时钟 / 设置… / 打赏支持 / 退出」，左键点托盘图标直接唤出时钟 |
| 权限提示 | ✅ 设置面板新增「权限与启动」区：实时显示当前平台 + 是否管理员/root，并给出诚实说明（Windows 提权可行、mac/Linux 需 sudo，不冒充） |
| 点击确认授权管理员启动 | ✅ Windows：①勾选「始终以管理员身份启动」→ 写入 HKCU AppCompatFlags RUNASADMIN 层（**下次手动启动、开机自启都会自动弹 UAC**）；②「立即以管理员身份重启」→ ShellExecute runas 弹 UAC，确认后新进程接管。两步都带文字说明 |
| 打赏功能 | ✅ 设置窗口新增「打赏支持」区：微信支付 / 支付宝 Tab 切换收款码（素材为你提供的原图裁切），托盘菜单也有「打赏支持」直达 |
| 其他必要优化 | ✅ 双窗口偏好**字段级合并 + Rust 广播同步**（设置窗口改样式、时钟窗口挪位置互不覆盖）；重置默认保留语言/位置/管理员选择；CI 增加新资产与脚本的静态检查 |

## 技术要点（为什么这么做）
- **双窗口同一 HTML**：`WebviewWindowBuilder.initialization_script` 注入 `window.__DC_VIEW__='settings'`，CSS 按视图切换布局；浏览器预览模式行为不变，所有旧回归全绿。
- **偏好同步**：`set_prefs` 改为只传变更字段（patch），Rust 持有权威对象 → 落盘 → `emit("prefs-changed", full)`；前端收到广播只应用不回写，验证脚本确认 **0 次回环写**。
- **提权不搞黑魔法**：RUNASADMIN 兼容层是微软官方机制，注册表写在 HKCU（无需提权即可设置），对 exe 生效即覆盖一切启动途径（含自启）；UAC 弹窗由系统出，应用绝不静默提权。
- **Windows 死锁规避**：托盘菜单线程里创建窗口走独立线程（官方 wry#583 建议）；`open_settings` 是 async command。

## 验收证据
- `python3 scripts/verify.py` → **31/31 PASS**（v0.2 全量回归）
- `python3 scripts/verify_features.py` → **43/43 PASS**（i18n/字体/颜色/重置/闹钟/关机/缩放）
- `python3 scripts/verify_v03.py` → **33/33 PASS**（托盘提示、独立设置窗口视图、权限区、打赏 Tab、跨窗口广播无回写）
- 预览截图：`.preview/settings-window-v03.png`
- Rust 编译：本机已部署 rustup + WebKit 依赖做 `cargo check`（CI 白跑风险已压到最低）；GitHub Actions 全平台出包为准

## 如实边界
- 托盘左键唤出时钟在 **Linux 上无效**（Tauri 官方：Linux 不发托盘点击事件），Linux 用户请用托盘右键菜单「显示时钟」；macOS/Windows 正常。
- macOS/Linux 定时关机需要 root/polkit，应用不会自动提权（界面已如实说明）；Windows 无需提权即可用 `shutdown /s`。
- RUNASADMIN 提权仅在 Windows 生效；mac/Linux 的「管理员」选项自动隐藏。
- 收款码为本地静态图片，无任何网络请求。
