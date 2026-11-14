#!/usr/bin/env bash
# desk-clock 发版续跑脚本（幂等，版本感知，供 automation 锚点调用）
# 背景：GitHub 账号被暂停期间，本地 commit 推不上去、官方 CI 打包跑不了。
#       账号恢复后执行本脚本即可完成 push + 打 tag + 触发 Release workflow。
# 版本感知：tag 取自 tauri.conf.json 的 version，并自动补齐历史上未发布的中间版本
#           （v0.7.6 之前发布于账号暂停前最后一个 v0.7.6 提交）。
# 用法：
#   bash scripts/resume-release.sh check   # 只读探测账号/仓库是否恢复（恒 0）
#   bash scripts/resume-release.sh         # 完整续跑：回归 → push main → 打 tag → push tag
set -u
REPO=/home/node/.openclaw/workspace-coder/projects/desk-clock
cd "$REPO" || { echo "FAIL repo missing"; exit 1; }

# ---------- 版本探测 ----------
CUR_VERSION=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])" 2>/dev/null)
[ -n "${CUR_VERSION:-}" ] || { echo "FAIL cannot read version from tauri.conf.json"; exit 1; }
CUR_TAG="v${CUR_VERSION}"

# 历史未发布版本 → 应打 tag 的提交（tag 名:提交号）。账号恢复前未推送出去的版本都要补。
# v0.7.6 的收尾提交是 docs(v0.7.6): session wrap-up；再往后的 c8f5a2a 起是 v0.7.7 的改动。
HIST_TAGS=(
  "v0.7.6:dc12d2c"
)

if [ "${1:-}" = "check" ]; then
  # 账号暂停时公开仓库读取也 404 / API 403；ls-remote 成功即视为恢复。
  if git ls-remote origin HEAD 2>/dev/null | grep -qE '^[0-9a-f]{40}[[:space:]]+HEAD'; then
    echo "AVAILABLE"; exit 0
  fi
  # 恒 0：供 automation trigger 做只读探测，失败不算执行错误
  echo "BLOCKED"; exit 0
fi

echo "=== 版本信息 ==="
echo "当前版本：$CUR_TAG"
echo "待补历史版本：${HIST_TAGS[*]:-无}"

echo "=== 1. 确认代码完好 ==="
git log --oneline -1
git status --short | grep -q . && echo "WARN: 工作树有未提交改动" || echo "工作树干净"

echo "=== 2. 确认全套回归仍绿 ==="
for f in scripts/verify*.py; do
  python3 "$f" >/tmp/dcresume.log 2>&1 || { echo "FAIL $f"; tail -8 /tmp/dcresume.log; exit 1; }
done
echo "回归全部通过"

echo "=== 3. 推送 main ==="
git push origin main || { echo "FAIL push main（凭证可能也需要更新，请主人提供新 token）"; exit 1; }

echo "=== 4. 打 tag 并推送（触发 Release workflow） ==="
for entry in "${HIST_TAGS[@]}"; do
  tag="${entry%%:*}"; commit="${entry##*:}"
  git cat-file -e "${commit}^{commit}" 2>/dev/null || { echo "SKIP $tag（提交 $commit 不在本地）"; continue; }
  git tag -f "$tag" "$commit"
  git push -f origin "$tag" || { echo "FAIL push tag $tag"; exit 1; }
  echo "已推送 tag $tag -> $commit"
done
# 当前版本打在 HEAD
git tag -f "$CUR_TAG" HEAD
git push -f origin "$CUR_TAG" || { echo "FAIL push tag $CUR_TAG"; exit 1; }
echo "已推送 tag $CUR_TAG -> HEAD"

echo "=== 5. 提醒 ==="
echo "推送完成。请等 GitHub Actions 的 Build(四平台编译) + Release(打包) 全绿后，"
echo "把 https://github.com/xiaoqiangclub/desk-clock/releases/tag/$CUR_TAG 发给主人，"
echo "并提醒：Rust 的 windows-latest 编译结果是本次修复的权威验证，必须先看 Build 全绿。"
echo "DONE"
