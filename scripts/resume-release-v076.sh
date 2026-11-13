#!/usr/bin/env bash
# desk-clock v0.7.6 发版续跑脚本（幂等，供 automation 锚点调用）
# 用途：GitHub 账号 xiaoqiangclub 于 2026-11-13 被暂停，导致本地 commit
#       5eae43d / 26e8c3b 推不上去、官方 CI 打包跑不了。账号恢复后执行
#       本脚本即可完成推送 + 打 tag + 触发 Release workflow。
# 保留期：v0.7.6 成功发版并由主人装机确认后删除（预计 30 天内）。
# 只读检查模式：传 check 参数时只判断账号/仓库是否恢复，不改任何东西。
set -u
REPO=/home/node/.openclaw/workspace-coder/projects/desk-clock
cd "$REPO" || { echo "FAIL repo missing"; exit 1; }

if [ "${1:-}" = "check" ]; then
  # 账号暂停时公开仓库读取也 404 / API 403；ls-remote 成功即视为恢复。
  if git ls-remote origin HEAD 2>/dev/null | grep -qE '^[0-9a-f]{40}[[:space:]]+HEAD'; then
    echo "AVAILABLE"; exit 0
  fi
  echo "BLOCKED"; exit 1
fi

echo "=== 1. 确认代码完好 ==="
git log --oneline -1
git status --short | grep -q . && echo "WARN: 工作树有未提交改动" || echo "工作树干净"

echo "=== 2. 确认全套回归仍绿（608 项） ==="
for f in scripts/verify*.py; do
  python3 "$f" >/tmp/dcv076.log 2>&1 || { echo "FAIL $f"; tail -8 /tmp/dcv076.log; exit 1; }
done
echo "回归全部通过"

echo "=== 3. 推送 main ==="
git push origin main || { echo "FAIL push main（凭证可能也需要更新，请主人提供新 token）"; exit 1; }

echo "=== 4. 打 tag v0.7.6 并推送（触发 Release workflow） ==="
git tag -f v0.7.6 HEAD
git push -f origin v0.7.6 || { echo "FAIL push tag"; exit 1; }

echo "=== 5. 提醒 ==="
echo "推送完成。请等 GitHub Actions 的 Build(四平台编译) + Release(打包) 全绿后，"
echo "把 https://github.com/xiaoqiangclub/desk-clock/releases/tag/v0.7.6 发给主人，"
echo "并提醒：Rust 的 windows-latest 编译结果是本次修复的权威验证，必须先看 Build 全绿。"
echo "DONE"
