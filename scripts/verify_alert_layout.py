#!/usr/bin/env python3
"""v0.7.6 修订回归：提醒窗必须铺满窗口，不得再现「上下黑边」。

主人 2026-11-13 13:27 装机截图反馈：卡片只占窗口中间 146px/260px，
上下各露出 57px 窗口底色 + 橙色描边 → 看成上下黑边。
本脚本用真实浏览器测量 DOM，断言 gap 为 0 且按钮全部可见。
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + ("  -> " + str(detail) if detail else ""))


payload = {
    "kind": "alarm", "title": "⏰ 闹钟", "body": "时间到：13:27",
    "content": "", "seconds": 10, "note": "将在 10 秒后自动停止", "lang": "zh-CN",
    "actions": [
        {"action": "mute", "label": "静音"},
        {"action": "snooze", "label": "稍后提醒"},
        {"action": "terminate", "label": "终止"},
        {"action": "dismiss", "label": "知道了"},
    ],
}

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 360, "height": 260}, device_scale_factor=1)
    page.add_init_script(
        "window.__DC_ALERT__ = " + json.dumps(payload, ensure_ascii=False) + ";"
    )
    page.goto((ROOT / "ui" / "alert.html").resolve().as_uri())
    page.wait_for_timeout(250)

    m = page.evaluate("""() => {
      const c = document.querySelector('.card').getBoundingClientRect();
      return {
        gapTop: c.top, gapBottom: innerHeight - c.bottom,
        cardH: c.height, winH: innerHeight,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        cardBg: getComputedStyle(document.querySelector('.card')).backgroundColor,
        buttons: [...document.querySelectorAll('.actions button')].map(b => {
          const r = b.getBoundingClientRect();
          return {label: b.textContent.trim(), visible: r.width > 0 && r.height > 0
                  && r.bottom <= innerHeight && r.top >= 0};
        })
      };
    }""")
    check("card fills window height", abs(m["gapTop"]) < 1 and abs(m["gapBottom"]) < 1,
          f"gapTop={m['gapTop']} gapBottom={m['gapBottom']} cardH={m['cardH']} winH={m['winH']}")
    check("no top/bottom letterbox (v0.7.6 visual fix)",
          m["gapTop"] < 1 and m["gapBottom"] < 1)
    check("card background equals window background",
          m["cardBg"] == m["bodyBg"], f"{m['cardBg']} vs {m['bodyBg']}")
    check("all 4 action buttons rendered and not clipped",
          len(m["buttons"]) == 4 and all(b["visible"] for b in m["buttons"]),
          m["buttons"])

    # 提醒内容较长时按钮仍须可见（内容区可滚动，不能把按钮挤出窗口）
    long_payload = dict(payload, content="会议纪要：\n" + "讨论桌面时钟发布计划。" * 12)
    page2 = browser.new_page(viewport={"width": 360, "height": 260}, device_scale_factor=1)
    page2.add_init_script(
        "window.__DC_ALERT__ = " + json.dumps(long_payload, ensure_ascii=False) + ";"
    )
    page2.goto((ROOT / "ui" / "alert.html").resolve().as_uri())
    page2.wait_for_timeout(250)
    m2 = page2.evaluate("""() => {
      const c = document.querySelector('.card').getBoundingClientRect();
      const btns = [...document.querySelectorAll('.actions button')];
      return {
        gapTop: c.top, gapBottom: innerHeight - c.bottom,
        contentVisible: !document.getElementById('content').hidden,
        buttonsVisible: btns.length === 4 && btns.every(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.bottom <= innerHeight && r.top >= 0;
        })
      };
    }""")
    check("long reminder text still fills window", m2["gapTop"] < 1 and m2["gapBottom"] < 1, m2)
    check("long reminder text is displayed", m2["contentVisible"])
    check("long reminder keeps all 4 buttons visible", m2["buttonsVisible"])

    # v0.7.6 二次修订：窗口必须按内容自适应高度，不能固定 260px 留大块空白。
    page3 = browser.new_page(viewport={"width": 360, "height": 176}, device_scale_factor=1)
    page3.add_init_script("window.__DC_ALERT__ = " + json.dumps(payload, ensure_ascii=False) + ";")
    page3.add_init_script("""
      window.__TAURI__ = { core: { invoke: (cmd, args) => {
        (window.__RESIZE_CALLS__ = window.__RESIZE_CALLS__ || []).push({cmd, height: args && args.height});
        return Promise.resolve();
      } } };
    """)
    page3.goto((ROOT / "ui" / "alert.html").resolve().as_uri())
    page3.wait_for_timeout(350)
    calls = page3.evaluate("window.__RESIZE_CALLS__ || []")
    check("alert invokes resize_alert with measured height",
          bool(calls) and calls[0]["cmd"] == "resize_alert"
          and isinstance(calls[0]["height"], (int, float)), calls)
    check("measured height is compact (no 260px letterbox)",
          bool(calls) and 120 <= calls[0]["height"] < 200, calls[0]["height"] if calls else None)
    browser.close()

failed = [n for n, ok, _ in results if not ok]
print(f"\n=== SUMMARY: {len(results) - len(failed)} passed, {len(failed)} failed ===")
for n in failed:
    print("  FAILED:", n)
raise SystemExit(1 if failed else 0)
