GitHub 账号恢复或云主机打包续跑（desk-clock v0.7.6）。这是分片续做任务，接 2026-11-13 12:26 主人「申诉后可否在云主机打包 / 有无免费平台」。

当前已完成（本轮实测）：
- InstaBox C 号 c-box-01（Debian 13 / Rust 1.99 / Node 22）：装齐 webkit2gtk-4.1-dev 2.54 等依赖，cargo install tauri-cli v2.12.4 --locked，cargo tauri build --bundles deb,appimage **RC=0**。
- 产物：Desk Clock_0.7.6_amd64.deb (4.83 MiB) + AppImage (105.60 MiB)；Xvfb 下真实创建 `Desk Clock v0.7.6` 640x220 窗口、进程稳定。
- deb 已回传本机 /tmp/dc-artifacts/Desk Clock_0.7.6_amd64.deb（sha256 cc258254befa3e53e3e56b26f85131e741f36f841dd3afa7dcd175c4282f357b）。
- Windows NSIS 交叉编译依赖（nsis/lld/llvm/clang + x86_64-pc-windows-msvc target + cargo-xwin）正在云机后台安装，日志 /tmp/nsis-deps.log。

请执行：
1. 先查 /tmp/nsis-deps.log 是否有 RC=0。若完成，尝试在 /data/dc/src-tauri 执行：
   cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
   产物在 target/x86_64-pc-windows-msvc/release/bundle/nsis/。这是官方标注「实验性、last resort」的路径，失败就如实说明，不要假称成功。
2. 成功则把 .exe 用 `instabox cp c-box-01:<path> /tmp/dc-artifacts/` 拉回本机，sha256 校验。
3. 用 message 工具把安装包作为附件单条发给主人（飞书直聊 user:ou_320530731b7993ac8a9a8be53f685958），附一句：这是 Linux 云机打出的包，Windows 包若成功另附；装新版后到设置页「窗口」点「检测开机自启状态」看注册表真值，并设个 1 分钟后的闹钟验证居中弹窗。
4. 无论成败，收尾必须：清理云机 /data/dc 与 /tmp/dc-full.tgz、`compute release instabox "<结果>"`、`ib pool --report c ok`、`ib raw POST /v1/machines/<machineId>/suspend`（用 machineId，不是 name），本机 /tmp/dc-artifacts 产物转存到 projects/desk-clock/dist/ 后再清 /tmp/dc-full.tgz。不留残留。
5. 若 GitHub 申诉已恢复（可用 scripts/resume-release-v076.sh check 判断 AVAILABLE），优先执行完整发版脚本，并删除锚点 2be731d3-04e9-4268-9dff-27c934bb260c。

纪律：中间过程只落盘不连发进度卡片；工具调用后同一轮产出最终文字结论；不假称成功；产物必须回自家地盘并 sha256 校验。
方案与平台对比见 reports/2026-11/2026-11-13-v076-免费打包平台调研.md。
