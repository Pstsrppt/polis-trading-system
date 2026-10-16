"""Score the live model against its shadow challengers.

Every research call — live and shadow — is stored in model_calls with the price
at the time. This joins each call to where price actually was N hours later and
asks two things per model:

  1. Direction: when it said bullish, did price rise? bearish, fall?
     ("neutral" is an abstention, reported but not scored.)
  2. Calibration: is it right more often when it claims more confidence?
     A model whose confidence does not track its hit rate gives the
     confidence filter nothing to work with.

All models are scored on the same signals, so the comparison is like for like.
Run from the repo root:  python tools/score_models.py [hours ...]
"""
import bisect
import datetime as dt
import math
import subprocess
import sys
from collections import defaultdict

import MetaTrader5 as mt5

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HOURS = [int(h) for h in sys.argv[1:]] or [4, 24]


def fetch_calls():
    sql = ("SELECT to_char(signal_ts,'YYYY-MM-DD\"T\"HH24:MI:SS'), symbol, role, model, "
           "COALESCE(sentiment,''), COALESCE(confidence,0), ok "
           "FROM model_calls ORDER BY signal_ts")
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "polis", "-d", "polis",
         "-A", "-F", "|", "-t", "-c", sql],
        capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    rows = []
    for line in out.splitlines():
        p = line.split("|")
        if len(p) != 7:
            continue
        rows.append({
            "t": dt.datetime.fromisoformat(p[0]).replace(tzinfo=dt.timezone.utc),
            "sym": p[1], "role": p[2], "model": p[3],
            "sent": p[4], "conf": int(p[5] or 0), "ok": p[6] == "t",
        })
    return rows


def wilson(hits, n, z=1.96):
    """95% interval for a hit rate — small samples get honest, wide bands."""
    if n == 0:
        return 0.0, 0.0
    p = hits / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return 100 * (c - h), 100 * (c + h)


def main():
    calls = fetch_calls()
    if not calls:
        print("ยังไม่มีข้อมูลใน model_calls")
        return
    if not mt5.initialize():
        print("MT5 unavailable")
        return

    prices = {}
    lo = min(c["t"] for c in calls) - dt.timedelta(hours=2)
    hi = dt.datetime.now(dt.timezone.utc)
    for sym in {c["sym"] for c in calls}:
        r = mt5.copy_rates_range(sym, mt5.TIMEFRAME_M5, lo, hi)
        if r is not None and len(r):
            prices[sym] = ([b["time"] for b in r], [b["close"] for b in r])

    def price_at(sym, ts):
        times, closes = prices[sym]
        i = bisect.bisect_right(times, ts) - 1
        return closes[i] if 0 <= i < len(closes) else None

    span = f"{calls[0]['t']:%d/%m %H:%M} → {calls[-1]['t']:%d/%m %H:%M}"
    print(f"model_calls: {len(calls)} แถว  ({span} UTC)\n")

    for h in HOURS:
        cutoff = hi - dt.timedelta(hours=h)
        stats = defaultdict(lambda: {"n": 0, "hit": 0, "neutral": 0, "fail": 0,
                                     "buckets": defaultdict(lambda: [0, 0])})
        for c in calls:
            s = stats[(c["role"], c["model"])]
            if not c["ok"]:
                s["fail"] += 1
                continue
            if c["t"] > cutoff or c["sym"] not in prices:
                continue
            if c["sent"] not in ("bullish", "bearish"):
                s["neutral"] += 1
                continue
            p0 = price_at(c["sym"], c["t"].timestamp())
            p1 = price_at(c["sym"], (c["t"] + dt.timedelta(hours=h)).timestamp())
            if p0 is None or p1 is None or p1 == p0:
                continue
            right = (p1 > p0) == (c["sent"] == "bullish")
            s["n"] += 1
            s["hit"] += right
            b = "80+" if c["conf"] >= 80 else "60-79" if c["conf"] >= 60 else "<60"
            s["buckets"][b][0] += 1
            s["buckets"][b][1] += right

        print("=" * 92)
        print(f"ทายทิศถูกไหม — ดูราคาหลังผ่านไป {h} ชม.")
        print("=" * 92)
        print(f"  {'โมเดล':<34}{'วัดได้':>7}{'ถูก':>7}{'ช่วงเชื่อมั่น 95%':>20}"
              f"{'<60':>7}{'60-79':>8}{'80+':>7}{'งด':>5}{'พลาด':>6}")
        for (role, model), s in sorted(stats.items(), key=lambda kv: kv[0][0] != "live"):
            tag = "★ " if role == "live" else "  "
            if s["n"]:
                lo_ci, hi_ci = wilson(s["hit"], s["n"])
                acc = f"{100*s['hit']/s['n']:>6.0f}%"
                ci = f"{lo_ci:>8.0f}–{hi_ci:<3.0f}%"
            else:
                acc, ci = f"{'—':>7}", f"{'—':>20}"

            def bk(k):
                n, w = s["buckets"][k]
                return f"{100*w/n:>5.0f}%" if n >= 3 else f"{'·':>6}"
            print(f"  {tag}{model:<32}{s['n']:>7}{acc}{ci:>20}"
                  f"{bk('<60'):>7}{bk('60-79'):>8}{bk('80+'):>7}{s['neutral']:>5}{s['fail']:>6}")
        print()

    print("อ่านผล: ช่วงเชื่อมั่นที่คร่อม 50% แปลว่ายังแยกจากการเดาไม่ได้")
    print("        โมเดลที่ดีควรทายถูกบ่อยขึ้นในช่อง 80+ มากกว่าช่อง <60 (ความมั่นใจมีความหมาย)")
    print("        ★ = โมเดลตัวจริงที่ระบบใช้ตัดสินใจอยู่ตอนนี้")
    mt5.shutdown()


if __name__ == "__main__":
    main()
