// desk-clock v0.7.6 发版锚点的静默条件检查（automations trigger, headless）
// 账号仍被暂停时 fire:false —— 不唤醒模型、不发任何消息，零噪音。
const r = await exec({
  command: "bash /home/node/.openclaw/workspace-coder/projects/desk-clock/scripts/resume-release-v076.sh check"
});
const out = String((r && (r.stdout ?? r.output ?? r.text)) ?? r ?? "");
if (!out.includes("AVAILABLE")) {
  json({ fire: false });
} else {
  json({ fire: true, message: "GitHub 账号已恢复，立即续跑 desk-clock v0.7.6 发版" });
}
