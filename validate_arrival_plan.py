"""
Smoke test for /arrival_plan, calling the planner directly rather than over HTTP.

Three destinations a calendar is likely to name, with 40 minutes to get there.
Prints what the gazetteer resolved each to and what the planner recommends, so
a wrong stop mapping or an empty option list is visible without starting the
server. Exits non-zero if a destination fails to resolve.
"""

import json
import sys
from datetime import datetime, timedelta

import main

# (query, rider lat, rider lng) — origins chosen so each case has a direct
# route: Leverett -> Science Center (AC/AL/ME), Leverett -> SEC (AL/XSEC),
# Science Center -> Radcliffe Quad (AC/QE).
CASES = [
    ("Science Center", 42.3698, -71.1168),
    ("SEC 1.321", 42.3698, -71.1168),
    ("Radcliffe Quad", 42.3767, -71.1160),
]


def run() -> int:
    arrive_by = datetime.now() + timedelta(minutes=40)
    failures = 0
    first_plan = None
    for dest, lat, lng in CASES:
        plan = main.plan_arrival(dest, arrive_by, lat=lat, lng=lng)
        first_plan = first_plan or plan
        d = plan["dest"]
        print(f"\n== {dest!r} -> {d['resolved_name']} / stop {d['stop']['id']} {d['stop']['name']} "
              f"(confidence {d['confidence']}, walk {d['walk_minutes']} min)")
        if d["confidence"] < 0.5:
            failures += 1
        print(f"   origin stop: {plan['origin_stop']['name']}; {len(plan['options'])} options, "
              f"{sum(o['viable'] for o in plan['options'])} viable")
        rec = plan["recommended"]
        if rec is None:
            print("   recommended: none")
        else:
            print(f"   recommended: {rec['route_id']} from {rec['board_stop']['name']} "
                  f"leaving {rec['depart_at'][11:16]} (be there {rec['be_at_stop_by'][11:16]}), "
                  f"alight {rec['alight_stop']['name']} {rec['arrive_stop_at'][11:16]}, "
                  f"at dest {rec['arrive_dest_at'][11:16]}, slack {rec['slack_minutes']} min "
                  f"[{rec['eta_source']}]")

    print("\nFull response for the first case:")
    print(json.dumps(first_plan, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
