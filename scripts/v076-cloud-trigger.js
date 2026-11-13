// v0.7.6 云机打包续做锚点：静默条件 + 时间兜底
// 触发条件（满足其一即 fire 一次）：
//   a) Windows 交叉编译依赖装完（云机 /tmp/nsis-deps.log 出现 RC=）
//   b) GitHub 账号恢复（resume-release-v076.sh check 输出 AVAILABLE）
//   c) 兜底：首次检查起 45 分钟后无条件 fire，保证云机一定被清理销账，
//      不会出现「两个条件都不满足 → 永久占机」的纪律漏洞。
const r = await exec({
  command: "ib --account c exec c-box-01 'grep -c \"^RC=\" /tmp/nsis-deps.log 2>/dev/null || echo 0' 2>/dev/null; bash /home/node/.openclaw/workspace-coder/projects/desk-clock/scripts/resume-release-v076.sh check 2>/dev/null"
});
const out = String((r && (r.stdout ?? r.output ?? r.text)) ?? r ?? "");
const depsReady = /(^|\n)\s*1\s*(\n|$)/.test(out) || out.includes("RC=0") || out.includes("RC=1");
const ghReady = out.includes("AVAILABLE");

const now = Date.now();
const first = (trigger.state && trigger.state.firstSeenMs) || now;
const timedOut = now - first > 45 * 60 * 1000;
const state = { firstSeenMs: first };

if (depsReady || ghReady || timedOut) {
  json({
    fire: true,
    message: (depsReady ? "云机 Windows 交叉编译依赖已完成" : ghReady ? "GitHub 账号已恢复" : "兜底超时：无论条件是否满足，立即收尾清理云机并如实回报")
      + " —— 按任务书续跑 v0.7.6 打包/发版与算力销账",
    state
  });
} else {
  json({ fire: false, state });
}
