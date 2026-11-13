GitHub 账号已恢复，请续跑 desk-clock v0.7.6 发版（主人 2026-11-13 报的「闹钟等弹窗不显示 + 开机自启失败」修复版；上一轮因 GitHub 账号被暂停，推送返回 403，代码已本地提交但发不了包）。

步骤：
1. cd /home/node/.openclaw/workspace-coder/projects/desk-clock
2. 执行 bash scripts/resume-release-v076.sh （幂等：跑全套 13 个回归脚本 608 项 → push main → 打 tag v0.7.6 → push tag 触发 Release workflow）
3. 若 push 仍失败（凭证也失效），如实报告并请主人提供新 token 或新目标仓库，绝不假称成功。
4. 推送成功后用 gh run list 查看 Build（四平台编译，重点 windows-latest）与 Release 结果；必须先看 Build 全绿（Rust 的 windows-latest 是本次修复的权威编译验证）。
5. 全绿后，把 https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.7.6 与真机验证步骤合并成【一条完整消息】回报主人：装新版 → 设置页「窗口」里点「检测开机自启状态」看注册表真值（路径是否带引号、是否指向当前 exe、是否被任务管理器禁用、是否设了 RUNASADMIN）→ 设个 1 分钟后的闹钟验证居中弹窗。
6. 成功后把锚点 desk-clock-v076-release-resume 删除，并清理 scripts/resume-release-v076.sh 与 scripts/v076-trigger.js（保留期已到）。

纪律：中间过程只落盘，不连发进度卡片；工具调用后必须在同一轮产出最终文字结论。
背景与两个真根因详见 reports/2026-11/2026-11-13-v076-弹窗与自启真根因修复留证.md。
