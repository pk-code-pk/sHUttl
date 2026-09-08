"""
Score our ETA engine against the operator's own predictions.

Ride Systems publishes arrival predictions per stop. sHUttl does not route on
them — the projection engine in main.py still produces every ETA the app shows.
Keeping our own engine and treating theirs as an independent label is what makes
our accuracy measurable at all: before this, the engine's ETAs were unfalsifiable.

Usage:
    python eta_compare.py collect --minutes 30      # sample into observations file
    python eta_compare.py report                    # score what has been collected
    python eta_compare.py once                      # one sample, printed, not saved

Method
------
For a stop S and route R, both sides answer the same question: how long until
the next R bus reaches S. Each sample pairs our prediction with the operator's
soonest prediction for that (S, R).

Two things this cannot claim, and the report says so:

  * The operator's prediction is not ground truth. It is a second estimate, from
    a system with vehicle telemetry we do not see. Agreement means we match
    their model, not that either matches reality. Measuring true error needs
    observed arrivals, which needs a stop-side observer we do not have.
  * The pairing assumes both sides are talking about the same bus. When two
    buses run a route close together they can disagree about which is next, and
    those samples inflate the error. `--max-error` drops the worst of them from
    the headline figure and reports how many were dropped, rather than hiding it.
"""

import argparse
import json
import os
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen

DEFAULT_API = os.getenv("ETA_COMPARE_API", "http://localhost:8000")
DEFAULT_OBS_PATH = os.getenv("ETA_COMPARE_OBS", "eta_observations.jsonl")

# Samples further apart than this are almost always a next-bus disagreement
# rather than a modelling error; see the note in the module docstring.
DEFAULT_MAX_ERROR_MIN = 15.0


def _fetch(api: str, path: str, params: dict | None = None):
    url = f"{api.rstrip('/')}/{path.lstrip('/')}"
    if params:
        url = f"{url}?{urlencode(params)}"
    with urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode())


def sample(api: str) -> list[dict]:
    """One pass over every stop, returning paired observations."""
    stops = _fetch(api, "stops")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    observations = []

    for stop in stops:
        try:
            payload = _fetch(api, "stop_etas", {"stop_id": stop["id"]})
        except Exception as e:
            print(f"  ! {stop['name']}: {e}", file=sys.stderr)
            continue

        # Soonest operator prediction per route.
        vendor_by_route: dict[str, float] = {}
        for v in payload.get("vendor", []):
            rid = v["route_id"]
            if rid not in vendor_by_route or v["eta_minutes"] < vendor_by_route[rid]:
                vendor_by_route[rid] = float(v["eta_minutes"])

        for ours in payload.get("ours", []):
            rid = ours["route_id"]
            if rid not in vendor_by_route:
                # We see a bus they do not predict for, or vice versa. Not an
                # error to measure — a disagreement about whether a bus is
                # coming at all, which belongs in its own count.
                continue
            observations.append({
                "t": now,
                "stop_id": stop["id"],
                "stop_name": stop["name"],
                "route_id": rid,
                "ours_min": round(float(ours["eta_minutes"]), 3),
                "vendor_min": vendor_by_route[rid],
                "distance_m": ours.get("distance_m"),
                "stops_ahead": ours.get("stops_ahead"),
                "speed_source": ours.get("speed_source"),
                "vehicle_id": ours.get("vehicle_id"),
            })

    return observations


def cmd_collect(args):
    deadline = time.time() + args.minutes * 60
    total = 0
    passes = 0

    with open(args.out, "a") as fh:
        while time.time() < deadline:
            obs = sample(args.api)
            for o in obs:
                fh.write(json.dumps(o) + "\n")
            fh.flush()
            total += len(obs)
            passes += 1
            print(
                f"pass {passes}: {len(obs)} paired predictions "
                f"({total} total, {(deadline - time.time()) / 60:.0f} min left)"
            )
            if time.time() < deadline:
                time.sleep(args.interval)

    print(f"\nWrote {total} observations from {passes} passes to {args.out}")
    return 0


def cmd_once(args):
    obs = sample(args.api)
    if not obs:
        print("No paired predictions right now (no buses in service?).")
        return 0
    print(f"{'stop':30} {'route':6} {'ours':>7} {'vendor':>7} {'error':>7}")
    for o in sorted(obs, key=lambda x: abs(x["ours_min"] - x["vendor_min"]), reverse=True):
        err = o["ours_min"] - o["vendor_min"]
        print(
            f"{o['stop_name'][:30]:30} {o['route_id']:6} "
            f"{o['ours_min']:7.1f} {o['vendor_min']:7.1f} {err:+7.1f}"
        )
    _summarize(obs, args.max_error)
    return 0


def _load(path: str) -> list[dict]:
    if not os.path.exists(path):
        print(f"No observations at {path}. Run `collect` first.", file=sys.stderr)
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


def _summarize(obs: list[dict], max_error: float):
    if not obs:
        print("\nNothing to score.")
        return

    errors = [(o["ours_min"] - o["vendor_min"], o) for o in obs]
    kept = [(e, o) for e, o in errors if abs(e) <= max_error]
    dropped = len(errors) - len(kept)

    if not kept:
        print(f"\nAll {len(errors)} samples exceeded the {max_error:.0f} min cutoff.")
        return

    e_vals = [e for e, _ in kept]
    abs_vals = [abs(e) for e in e_vals]

    print(f"\n{'=' * 62}")
    print("Our ETA vs the operator's prediction")
    print(f"{'=' * 62}")
    print(f"  paired samples      {len(kept)}"
          f"{f' (+{dropped} dropped over {max_error:.0f} min)' if dropped else ''}")
    print(f"  mean abs error      {statistics.mean(abs_vals):.2f} min")
    print(f"  median abs error    {statistics.median(abs_vals):.2f} min")
    print(f"  bias (ours-theirs)  {statistics.mean(e_vals):+.2f} min", end="")
    if statistics.mean(e_vals) < -0.5:
        print("   <- we predict buses arriving sooner than they do")
    elif statistics.mean(e_vals) > 0.5:
        print("   <- we predict buses arriving later than they do")
    else:
        print()
    if len(e_vals) > 1:
        print(f"  stdev of error      {statistics.stdev(e_vals):.2f} min")
    within = sum(1 for a in abs_vals if a <= 2.0) / len(abs_vals) * 100
    print(f"  within 2 min        {within:.0f}%")

    # Where the error lives. A bias that grows with distance points at the speed
    # model; a flat offset points at unmodelled dwell time at intervening stops.
    print("\n  by remaining distance to the stop:")
    buckets = [(0, 300), (300, 800), (800, 1500), (1500, 1e9)]
    for lo, hi in buckets:
        rows = [
            e for e, o in kept
            if o.get("distance_m") is not None and lo <= o["distance_m"] < hi
        ]
        if not rows:
            continue
        label = f"{lo:5.0f}-{hi:.0f} m" if hi < 1e9 else f"{lo:5.0f}+ m    "
        print(
            f"    {label:16} n={len(rows):4}  "
            f"MAE {statistics.mean([abs(x) for x in rows]):5.2f}  "
            f"bias {statistics.mean(rows):+5.2f}"
        )

    print("\n  by route:")
    per_route = defaultdict(list)
    for e, o in kept:
        per_route[o["route_id"]].append(e)
    for rid in sorted(per_route, key=lambda r: -len(per_route[r])):
        vals = per_route[rid]
        print(
            f"    {rid:6} n={len(vals):4}  "
            f"MAE {statistics.mean([abs(v) for v in vals]):5.2f}  "
            f"bias {statistics.mean(vals):+5.2f}"
        )

    # Speed history is what separates the engine from a constant-speed guess, so
    # split the score by whether it was available.
    print("\n  by speed source:")
    per_src = defaultdict(list)
    for e, o in kept:
        per_src[o.get("speed_source") or "unknown"].append(e)
    for src in sorted(per_src, key=lambda s: -len(per_src[s])):
        vals = per_src[src]
        print(
            f"    {src:10} n={len(vals):4}  "
            f"MAE {statistics.mean([abs(v) for v in vals]):5.2f}  "
            f"bias {statistics.mean(vals):+5.2f}"
        )

    print(
        "\n  The operator's prediction is a second estimate, not ground truth;\n"
        "  agreement means our model matches theirs. Samples where the two\n"
        "  sides picked different buses inflate the tail, which is what the\n"
        f"  {max_error:.0f} min cutoff removes."
    )


def cmd_report(args):
    obs = _load(args.obs)
    if not obs:
        return 1
    span = ""
    times = sorted(o["t"] for o in obs if "t" in o)
    if times:
        span = f"  ({times[0]} to {times[-1]})"
    print(f"Loaded {len(obs)} observations from {args.obs}{span}")
    _summarize(obs, args.max_error)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--api", default=DEFAULT_API, help="backend base URL")
    parser.add_argument(
        "--max-error",
        type=float,
        default=DEFAULT_MAX_ERROR_MIN,
        help="drop samples disagreeing by more than this many minutes",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_collect = sub.add_parser("collect", help="sample repeatedly into a file")
    p_collect.add_argument("--minutes", type=float, default=30.0)
    p_collect.add_argument("--interval", type=float, default=60.0)
    p_collect.add_argument("--out", default=DEFAULT_OBS_PATH)
    p_collect.set_defaults(func=cmd_collect)

    p_once = sub.add_parser("once", help="one sample, printed, not saved")
    p_once.set_defaults(func=cmd_once)

    p_report = sub.add_parser("report", help="score collected observations")
    p_report.add_argument("--obs", default=DEFAULT_OBS_PATH)
    p_report.set_defaults(func=cmd_report)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
