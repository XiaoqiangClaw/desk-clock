#!/usr/bin/env python3
# 生成 ui/calendar-data.js：中国大陆法定节假日 + 调休补班日（周末上班）的静态数据。
#
# 数据来源：chinese_calendar（社区维护的国务院办公厅历年放假安排映射）。
# 仅在“构建期/数据更新期”运行本脚本；产出的 calendar-data.js 是纯静态文件，
# 前端零运行时依赖、可离线、file:// 直接打开也能用（挂全局，不 fetch）。
#
# 用法：
#   python3 scripts/gen-calendar.py            # 覆盖默认年份区间
#   YEARS=2024-2027 python3 scripts/gen-calendar.py
#
# 重要：chinese_calendar 的 is_holiday 会把普通周末也算进去，因此下面只以
# is_workday 为唯一原语来派生，避免把周末误当成法定节假日。两个集合：
#   h = 法定节假日停休日（仅“工作日外的周几停休”，不含普通周末）
#   w = 调休补班日（本为周末、但需上班的日子）
#   - 工作日  = 周一~周五 且 不在 h 中，或 在 w 中
#   - 周末    = 周六/周日 且 不在 w 中
#   - 节假日  = 在 h 中（法定节假日；落在普通周末的那几天天然归“周末”）
#   - 交易日  = 周一~周五 且 不在 h 中（A股：周末一律休市，含调休补班周末）
import datetime
import json
import os
import sys

try:
    from chinese_calendar import is_workday
except ImportError:
    sys.stderr.write("需要 chinese_calendar：pip install chinese_calendar\n")
    sys.exit(1)

DEFAULT_YEARS = range(2024, 2028)  # 2024..2027（库支持到 2027）


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
    spec = os.environ.get("YEARS", "")
    if spec:
        ys = []
        for part in spec.split(","):
            if "-" in part:
                a, b = part.split("-")
                ys.extend(range(int(a), int(b) + 1))
            else:
                ys.append(int(part))
        years = sorted(set(ys))
    else:
        years = list(DEFAULT_YEARS)
    data = gen(years)
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(root, "ui", "calendar-data.js")
    payload = {
        "source": "chinese_calendar (国务院办公厅历年放假安排映射)",
        "years": data,
    }
    with open(path, "w", encoding="utf-8") as f:
        f.write("// 自动生成，请勿手改；更新数据请运行 scripts/gen-calendar.py\n")
        f.write("// 数据来源：chinese_calendar（国务院办公厅历年放假安排映射），覆盖 ")
        f.write(", ".join(sorted(data.keys())) + "\n")
        f.write("window.DeskClock = window.DeskClock || {};\n")
        f.write("window.DeskClock.CalendarData = ")
        f.write(json.dumps(payload, ensure_ascii=False, indent=2))
        f.write(";\n")
    print("wrote", path)
    for y, v in data.items():
        print("  %s: statutoryHolidays=%d makeupWorkdays=%d" % (y, len(v["h"]), len(v["w"])))


if __name__ == "__main__":
    main()
