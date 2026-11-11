#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成日历数据（两个同源、恒等的文件）：
  ui/calendar-data.js   —— 挂 window.DeskClock.CalendarData，作为应用内置数据 + file:// 直接打开时的兜底
  ui/calendar-data.json —— 纯 JSON，供运行时静默同步（GitHub raw）拉取最新版本

数据源：chinese_calendar（社区维护的国务院办公厅历年放假安排映射）。
注意：A股「交易日」不是独立数据，而是「周一~周五 且 非法定节假日」的派生结果；
工作日 / 周末 / 法定节假日 / 交易日 四种重复规则共用同一份 h / w 原语，
因此本文件一更新，四种规则（含交易日）同时自动更新。

年份**自动探测**：从 START_YEAR 起逐年用三点法调用 is_workday，直到库不再支持该年为止。
当上游库随国务院发布的新一年放假安排升级后，只需重跑本脚本（或由
.github/workflows/calendar-sync.yml 定时任务自动重跑），数据即自动扩展到新年份，
无需手改任何年份常量——这就是「自动跟随权威数据源」的构建期一半。

两个文件由同一份 payload 生成、恒等、不含时间戳（幂等），便于 CI 用
`git diff --quiet` 判断数据是否真的变化，仅在变化时提交回 main。

用法：
  pip install -U chinese_calendar
  python3 scripts/gen-calendar.py                 # 自动探测年份（推荐，CI 用这个）
  YEARS=2024-2027 python3 scripts/gen-calendar.py # 固定年份（回归/复现用）
"""
import datetime
import json
import os
import sys

try:
    from chinese_calendar import is_workday
except ImportError:
    sys.stderr.write("需要 chinese_calendar：pip install -U chinese_calendar\n")
    sys.exit(1)

START_YEAR = 2024
SOURCE = "chinese_calendar (国务院办公厅历年放假安排映射)"
SCHEMA = 1


def year_supported(y):
    """三点探测：该年 1/1、6/1、12/31 都能被 is_workday 判定才算库完整支持。
    避免把「只发布了部分安排」的年份误纳入而产出半截数据。"""
    for m, d in ((1, 1), (6, 1), (12, 31)):
        try:
            is_workday(datetime.date(y, m, d))
        except Exception:
            return False
    return True


def detect_years():
    years, y = [], START_YEAR
    while y <= START_YEAR + 30 and year_supported(y):
        years.append(y)
        y += 1
    return years


def parse_years_spec(spec):
    ys = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            ys.extend(range(int(a), int(b) + 1))
        else:
            ys.append(int(part))
    return sorted(set(ys))


def gen(years):
    out = {}
    for y in years:
        h, w = [], []
        d = datetime.date(y, 1, 1)
        while d.year == y:
            mmdd = "%02d%02d" % (d.month, d.day)
            if is_workday(d):
                if d.weekday() >= 5:          # 周末却要上班 = 调休补班
                    w.append(mmdd)
            else:                            # 非工作日
                if d.weekday() < 5:          # 周几停休 = 法定节假日（落在普通周末的不在此列）
                    h.append(mmdd)
            d += datetime.timedelta(days=1)
        out[str(y)] = {"h": sorted(h), "w": sorted(w)}
    return out


def main():
    spec = os.environ.get("YEARS", "").strip()
    years = parse_years_spec(spec) if spec else detect_years()
    if not years:
        sys.stderr.write("未探测到任何可支持年份，请检查 chinese_calendar 安装\n")
        sys.exit(1)
    unsupported = [y for y in years if not year_supported(y)]
    if unsupported:
        sys.stderr.write("以下年份 chinese_calendar 尚不支持：%s\n" % unsupported)
        sys.exit(2)

    payload = {
        "schema": SCHEMA,
        "source": SOURCE,
        "coverage": [str(y) for y in years],
        "years": gen(years),
    }
    data_js = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    js_path = os.path.join(root, "ui", "calendar-data.js")
    json_path = os.path.join(root, "ui", "calendar-data.json")

    header = ("// 自动生成，请勿手改；更新数据请运行 scripts/gen-calendar.py"
              "（.github/workflows/calendar-sync.yml 会定时自动重跑）\n"
              "// 数据来源：chinese_calendar（国务院办公厅历年放假安排映射），覆盖 "
              + ", ".join(payload["coverage"]) + "\n")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("window.DeskClock = window.DeskClock || {};\n")
        f.write("window.DeskClock.CalendarData = ")
        f.write(data_js)
        f.write(";\n")
    with open(json_path, "w", encoding="utf-8") as f:
        f.write(data_js)
        f.write("\n")

    print("wrote", js_path)
    print("wrote", json_path)
    print("coverage:", ", ".join(payload["coverage"]))
    for y, v in payload["years"].items():
        print("  %s: statutoryHolidays=%d makeupWorkdays=%d" % (y, len(v["h"]), len(v["w"])))


if __name__ == "__main__":
    main()
