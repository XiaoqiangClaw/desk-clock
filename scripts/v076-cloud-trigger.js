// v0.7.6 云机打包续做锚点的静默条件检查
// 只有 Windows 交叉编译依赖装完（RC=0）或 GitHub 账号恢复时才触发一次。
const r = await exec({
  command: "ib --account c exec c-box-01 'grep -c \"^RC=\" /tmp/nsis-deps.log 2>/dev/null || echo 0' 2>/dev/null; bash /home/node/.openclaw/workspace-coder/projects/desk-clock/scripts/resume-release-v076.sh check 2>/dev/null"
});
const out = String((r && (r.stdout ?? r.output ?? r.text)) ?? r ?? "");
const depsReady = /^1$/m.test(out.trim()) || out.includes("RC=0");
const ghReady = out.includes("AVAILABLE");
if (!depsReady && !ghReady) {
  json({ fire: false });
} else {
  json({
    fire: true,
    message: "云机打包条件就绪（Windows 交叉编译依赖完成 或 GitHub 已恢复），按任务书续跑 v0.7.6 打包/发版"
  });
}
