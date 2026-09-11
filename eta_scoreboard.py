"""
Head-to-head: our ETA vs the operator's, scored against observed arrivals.

The difference from eta_compare.py matters. That tool compares our predictions
to the operator's, which can only ever measure agreement — if they are wrong and
we match them, it reports success. This tool scores both against what actually
happened, so "more accurate than the operator" becomes a claim with a number
behind it instead of an assertion.

Ground truth comes from our own position stream: arrivals.py timestamps a bus
crossing a stop, and /arrivals serves those events. A prediction made at time t
for route R at stop S is scored against the first observed R arrival at S after
t. Error is signed in minutes, so bias and spread are both visible.

Usage:
    python eta_scoreboard.py collect --minutes 120    # log both predictions
    python eta_scoreboard.py score                    # head-to-head result

Collect needs to run for a while before scoring: a prediction is only scorable
once the bus it referred to has actually arrived, so a 20-minute prediction is
worth nothing until 20 minutes later.

What this can and cannot claim
------------------------------
It can claim: over N scored predictions, our mean absolute error was X and
theirs was Y.

It cannot claim our detector is perfect. An arrival is inferred from position
fixes, so a bus that passes a stop while the poller is stalled produces no
event, and predictions pointing at it get matched to the *next* arrival instead,
inflating error for both sides equally. Predictions with no subsequent arrival
within --horizon are dropped rather than guessed at, and the count is reported.
"""

import argparse
import json
import os
import statistics
import sys
import time
from collections import defaultdict
from urllib.parse import urlencode
from urllib.request import urlopen

DEFAULT_API = os.getenv("ETA_COMPARE_API", "http://localhost:8000")
DEFAULT_PRED_PATH = os.getenv("ETA_SCOREBOARD_PRED", "eta_predictions.jsonl")

# A prediction with no observed arrival within this many minutes is unscorable:
# either service ended, or we missed the arrival. Dropped, not guessed.
DEFAULT_HORIZON_MIN = 45.0


def _fetch(api: str, path: str, params: dict | None = None):
    url = f"{api.rstrip('/')}/{path.lstrip('/')}"
    if params:
        url = f"{url}?{urlencode(params)}"
    with urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode())


def sample_predictions(api: str) -> list[dict]:
    """Record both predictors' current answers, stamped with wall-clock time."""
    stops = _fetch(api, "stops")
    rows = []

    for stop in stops:
        t = time.time()
        try:
            payload = _fetch(api, "stop_etas", {"stop_id": stop["id"]})
        except Exception as e:
            print(f"  ! {stop['name']}: {e}", file=sys.stderr)
            continue

        ours = {o["route_id"]: o for o in payload.get("ours", [])}

        vendor: dict[str, float] = {}
        for v in payload.get("vendor", []):
            rid = v["route_id"]
            if rid not in vendor or v["eta_minutes"] < vendor[rid]:
                vendor[rid] = float(v["eta_minutes"])

        # Score every route either side has an opinion about. Restricting to
        # routes both predict would quietly exclude the cases where one of them
        # missed a bus entirely, which is exactly where accuracy differs.
        for rid in set(ours) | set(vendor):
            mine = ours.get(rid)
            # `eta_minutes` is what the app displays, which is the operator's
            # own number wherever they have one — scoring that against them is
            # scoring them against themselves. `own_eta_minutes` is our
            # projection regardless, and is the only honest "ours" column.
            own = mine.get("own_eta_minutes") if mine else None
            if own is None and mine and mine.get("eta_source") != "operator":
                own = mine.get("eta_minutes")
            rows.append({
                "t": round(t, 1),
                "stop_id": stop["id"],
                "stop_name": stop["name"],
                "route_id": rid,
                "ours_min": round(own, 3) if own is not None else None,
                "displayed_min": round(mine["eta_minutes"], 3) if mine else None,
                "vendor_min": vendor.get(rid),
                "eta_source": mine.get("eta_source") if mine else None,
                "learned_fraction": mine.get("learned_fraction") if mine else None,
                "distance_m": mine.get("distance_m") if mine else None,
            })

    return rows


def cmd_collect(args):
    deadline = time.time() + args.minutes * 60
    total = 0
    passes = 0

    with open(args.out, "a") as fh:
        while time.time() < deadline:
            rows = sample_predictions(args.api)
            for r in rows:
                fh.write(json.dumps(r) + "\n")
            fh.flush()
            total += len(rows)
            passes += 1
            print(f"pass {passes}: {len(rows)} predictions logged "
                  f"({total} total, {(deadline - time.time()) / 60:.0f} min left)")
            if time.time() < deadline:
                time.sleep(args.interval)

    print(f"\nWrote {total} predictions to {args.out}")
    print("Wait for the buses these referred to to arrive, then run: "
          "python eta_scoreboard.py score")
    return 0


def _load_jsonl(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def cmd_score(args):
    preds = _load_jsonl(args.preds)
    if not preds:
        print(f"No predictions at {args.preds}. Run `collect` first.", file=sys.stderr)
        return 1

    payload = _fetch(args.api, "arrivals", {"limit": 20000})
    arrivals = payload.get("arrivals", [])
    if not arrivals:
        print("No observed arrivals yet. The position poller needs to run "
              "through some service before anything can be scored.", file=sys.stderr)
        return 1
    if payload.get("truncated"):
        print("note: arrival list was truncated; scoring only the recent window\n")

    # (route, stop) -> sorted arrival times
    by_key: dict[tuple, list[float]] = defaultdict(list)
    for a in arrivals:
        by_key[(a["route_id"], a["stop_id"])].append(a["t"])
    for v in by_key.values():
        v.sort()

    horizon_s = args.horizon * 60
    scored = []
    unscorable = 0

    for p in preds:
        times = by_key.get((p["route_id"], p["stop_id"]))
        if not times:
            unscorable += 1
            continue
        truth_t = next((t for t in times if t > p["t"]), None)
        if truth_t is None or (truth_t - p["t"]) > horizon_s:
            unscorable += 1
            continue
        actual_min = (truth_t - p["t"]) / 60.0
        scored.append((p, actual_min))

    if not scored:
        print(f"Nothing scorable yet ({unscorable} predictions had no matching "
              f"arrival within {args.horizon:.0f} min).", file=sys.stderr)
        return 1

    print(f"Loaded {len(preds)} predictions and {len(arrivals)} observed arrivals")
    print(f"Scored {len(scored)}; dropped {unscorable} with no arrival "
          f"within {args.horizon:.0f} min\n")

    _report(scored)
    return 0


def _errors(scored, side):
    key = "ours_min" if side == "ours" else "vendor_min"
    return [(p[key] - actual, p) for p, actual in scored if p.get(key) is not None]


def _stats(errs):
    if not errs:
        return None
    vals = [e for e, _ in errs]
    abs_vals = [abs(v) for v in vals]
    return {
        "n": len(vals),
        "mae": statistics.mean(abs_vals),
        "median": statistics.median(abs_vals),
        "bias": statistics.mean(vals),
        "p90": sorted(abs_vals)[int(len(abs_vals) * 0.9) - 1] if len(abs_vals) > 1 else abs_vals[0],
        "within2": sum(1 for a in abs_vals if a <= 2.0) / len(abs_vals) * 100,
    }


def _report(scored):
    ours = _stats(_errors(scored, "ours"))
    theirs = _stats(_errors(scored, "vendor"))

    print("=" * 68)
    print("Scored against observed arrivals")
    print("=" * 68)
    print(f"  {'':22}{'ours':>12}{'operator':>12}")
    if ours and theirs:
        rows = [
            ("predictions scored", f"{ours['n']}", f"{theirs['n']}"),
            ("mean abs error", f"{ours['mae']:.2f} min", f"{theirs['mae']:.2f} min"),
            ("median abs error", f"{ours['median']:.2f} min", f"{theirs['median']:.2f} min"),
            ("90th pct abs error", f"{ours['p90']:.2f} min", f"{theirs['p90']:.2f} min"),
            ("bias", f"{ours['bias']:+.2f} min", f"{theirs['bias']:+.2f} min"),
            ("within 2 min", f"{ours['within2']:.0f}%", f"{theirs['within2']:.0f}%"),
        ]
        for label, a, b in rows:
            print(f"  {label:22}{a:>12}{b:>12}")

        delta = theirs["mae"] - ours["mae"]
        print()
        if delta > 0.05:
            print(f"  We are more accurate by {delta:.2f} min of mean absolute error.")
        elif delta < -0.05:
            print(f"  The operator is more accurate by {-delta:.2f} min of mean "
                  "absolute error.")
        else:
            print("  The two are within noise of each other.")

        # Head-to-head on the same events, which is stricter than comparing
        # aggregates computed over slightly different subsets.
        both = [
            (p["ours_min"] - actual, p["vendor_min"] - actual)
            for p, actual in scored
            if p.get("ours_min") is not None and p.get("vendor_min") is not None
        ]
        if both:
            we_win = sum(1 for o, v in both if abs(o) < abs(v))
            print(f"  On the {len(both)} events both predicted, we were closer "
                  f"{we_win / len(both) * 100:.0f}% of the time.")
    else:
        for name, st in (("ours", ours), ("operator", theirs)):
            print(f"  {name}: {'no scorable predictions' if not st else st}")

    # The whole point of the learned model is that it should beat the fallback.
    # If it does not, that is the first thing worth knowing.
    print("\n  our error by ETA source:")
    per_source = defaultdict(list)
    for p, actual in scored:
        if p.get("ours_min") is None:
            continue
        per_source[p.get("eta_source") or "unknown"].append(p["ours_min"] - actual)
    for src in sorted(per_source, key=lambda s: -len(per_source[s])):
        vals = per_source[src]
        print(f"    {src:18} n={len(vals):5}  "
              f"MAE {statistics.mean([abs(v) for v in vals]):5.2f}  "
              f"bias {statistics.mean(vals):+5.2f}")

    # Error should grow with how far ahead you are predicting, for both sides.
    # If ours grows faster, the model is weak in the tail rather than overall.
    print("\n  by how far ahead the prediction was (actual minutes to arrival):")
    buckets = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 1e9)]
    for lo, hi in buckets:
        rows = [(p, a) for p, a in scored if lo <= a < hi]
        if not rows:
            continue
        o = [p["ours_min"] - a for p, a in rows if p.get("ours_min") is not None]
        v = [p["vendor_min"] - a for p, a in rows if p.get("vendor_min") is not None]
        label = f"{lo:2.0f}-{hi:.0f} min" if hi < 1e9 else f"{lo:2.0f}+ min   "
        o_txt = f"{statistics.mean([abs(x) for x in o]):5.2f}" if o else "    -"
        v_txt = f"{statistics.mean([abs(x) for x in v]):5.2f}" if v else "    -"
        print(f"    {label:14} n={len(rows):5}  ours MAE {o_txt}  operator MAE {v_txt}")

    # Where a prediction was missing entirely, which aggregates hide.
    ours_missing = sum(1 for p, _ in scored if p.get("ours_min") is None)
    theirs_missing = sum(1 for p, _ in scored if p.get("vendor_min") is None)
    if ours_missing or theirs_missing:
        print(f"\n  buses actually arrived that we did not predict at all: {ours_missing}")
        print(f"  buses actually arrived that the operator did not predict: {theirs_missing}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--horizon", type=float, default=DEFAULT_HORIZON_MIN,
                        help="drop predictions with no arrival within this many minutes")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_collect = sub.add_parser("collect", help="log both predictors over time")
    p_collect.add_argument("--minutes", type=float, default=120.0)
    p_collect.add_argument("--interval", type=float, default=60.0)
    p_collect.add_argument("--out", default=DEFAULT_PRED_PATH)
    p_collect.set_defaults(func=cmd_collect)

    p_score = sub.add_parser("score", help="score both against observed arrivals")
    p_score.add_argument("--preds", default=DEFAULT_PRED_PATH)
    p_score.set_defaults(func=cmd_score)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
