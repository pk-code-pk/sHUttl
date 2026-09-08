"""
Validation for arrival detection and the learned ETA model.

Arrival detection is the foundation of every accuracy claim: it produces the
ground truth both predictors get scored against, and the training data the
learned model is built from. It also fails silently — a detector that misses
half the arrivals still returns plausible-looking numbers, just from half the
evidence, and a detector that double-counts invents travel times of nearly zero.

So it is checked by driving a synthetic vehicle around each route's real
geometry at a known speed and asserting that every stop is detected exactly
once, in travel order. Then the learned model is checked against a deliberately
non-uniform speed profile, which is the case a single speed constant cannot
represent and therefore the case the whole model exists to handle.

Run: python validate_arrivals.py
"""

import sys
import time
from dataclasses import dataclass

import arrivals
import ridesystems_client as rs


@dataclass
class FakeVehicle:
    id: str
    latitude: float
    longitude: float
    routeId: str
    routeName: str = "synthetic"


def _latlng_at_arc(index, target: float):
    """Point on a shape at a given arc length."""
    for i in range(len(index.cum) - 1):
        if index.cum[i + 1] >= target:
            return index.shape[i]
    return index.shape[-1]


def drive(route_id, speed_profile, step_m=50.0, vehicle_id="VALIDATE", start=None):
    """Drive one lap, returning (arrivals in order, elapsed seconds)."""
    index = rs._shape_index_for_route(route_id)
    if index is None:
        return [], 0.0

    t = start if start is not None else time.time()
    t0 = t
    arc = 5.0
    detected = []

    while arc < index.length:
        lat, lng = _latlng_at_arc(index, arc)
        got = arrivals.observe_vehicles(
            [FakeVehicle(vehicle_id, lat, lng, route_id)], now=t
        )
        detected.extend(got)
        speed = speed_profile(arc)
        t += step_m / max(speed, 0.1)
        arc += step_m

    return detected, t - t0


def _is_ordered_subsequence(got, expected):
    """True when every detection appears in `expected`, in the same order."""
    it = iter(expected)
    return all(any(e == g for e in it) for g in got)


def check_detection():
    """Every pass of every stop, detected once per lap, in travel order.

    "Per stop" is not the unit: several routes serve a stop twice in one lap —
    QSEC passes Barry's Corner in both directions — so the expected sequence is
    the stop *passes* in arc order, repeats included. An earlier version of this
    check asserted one detection per distinct stop and reported the correct
    behaviour as a duplicate-counting bug.
    """
    print("Arrival detection — one synthetic lap per route")
    failures = []

    for route in rs.get_routes():
        index = rs._shape_index_for_route(route.myid)
        if index is None:
            failures.append(f"route {route.myid} has no geometry to drive")
            continue

        stop_arcs = sorted(
            arrivals._route_stop_arcs(route.myid, index), key=lambda s: s[1]
        )
        expected = [sid for sid, _arc in stop_arcs]

        # A fresh vehicle id per route so cooldown and track state from one lap
        # cannot suppress detections on the next.
        detected, _elapsed = drive(
            route.myid, lambda _arc: 8.0, vehicle_id=f"V-{route.myid}"
        )
        got = [a.stop_id for a in detected]

        # The lap starts at arc 5 and steps by 50 m, so a pass within a step of
        # either end can fall outside it. That is the harness stepping, not the
        # detector, so what is asserted is that the detections are an ordered
        # subsequence of the expected passes — nothing out of order, nothing
        # invented — with at most one missing.
        missing = len(expected) - len(got)
        ordered = _is_ordered_subsequence(got, expected)

        passes = len(expected)
        repeats = passes - len(set(expected))
        status = "OK" if ordered and 0 <= missing <= 1 else "FAIL"
        print(
            f"  {status:4} {route.myid:5} {len(got):2}/{passes:2} passes"
            f"{f' ({repeats} stops served twice)' if repeats else ''}"
            f"{'  ORDER MISMATCH' if not ordered else ''}"
            f"{f'  missing={missing}' if missing else ''}"
        )

        if not ordered:
            failures.append(
                f"route {route.myid} detections do not follow travel order: "
                f"got {got[:6]}... expected {expected[:6]}..."
            )
        elif missing > 1:
            failures.append(f"route {route.myid} missed {missing} stop passes")
        elif missing < 0:
            failures.append(f"route {route.myid} fired {-missing} extra arrivals")

    return failures


def check_learned_model():
    """The learned model must beat a constant speed on a non-uniform route.

    Drives laps with a fast half and a slow half, then asks for an ETA across
    each. A constant-speed model must be wrong on both by construction; the
    learned model should be close on both.
    """
    print("\nLearned travel times — non-uniform speed profile")
    failures = []

    route = next((r for r in rs.get_routes() if len(r.platform_ids) >= 6), None)
    if route is None:
        return ["no route with enough stops to test the learned model"]

    index = rs._shape_index_for_route(route.myid)
    half = index.length / 2
    FAST, SLOW = 10.0, 2.5

    def profile(arc):
        return SLOW if arc > half else FAST

    # Enough laps to clear MIN_OBS_FOR_SEGMENT.
    t = time.time()
    for lap in range(arrivals.MIN_OBS_FOR_SEGMENT + 1):
        _d, elapsed = drive(route.myid, profile, vehicle_id=f"LEARN-{lap}", start=t)
        t += elapsed + 300  # layover, discarded by MAX_SEGMENT_S

    usable = 0
    errors = []
    stop_arcs = sorted(arrivals._route_stop_arcs(route.myid, index), key=lambda s: s[1])

    # Skip the hop that wraps from the last pass of one lap to the first of the
    # next: its observed duration includes the synthetic layover between laps,
    # which the speed profile says nothing about. Including terminal layover in
    # a real estimate is correct — a rider does wait through it — but here it
    # would be scored against a truth that excludes it.
    for i in range(len(stop_arcs) - 1):
        from_sid, from_arc = stop_arcs[i]
        to_sid, to_arc = stop_arcs[i + 1]
        if from_sid == to_sid:
            continue
        est = arrivals.STORE.segment_estimate(route.myid, from_sid, to_sid)
        if est is None:
            continue
        span = to_arc - from_arc
        if span <= 0:
            continue
        # A hop that straddles the profile's midpoint has no single true speed.
        if (from_arc > half) != (to_arc > half):
            continue
        truth = span / profile(from_arc)
        usable += 1
        errors.append(abs(est[0] - truth) / truth)

    if not usable:
        return [f"no segments learned on route {route.myid}"]

    worst = max(errors)
    mean = sum(errors) / len(errors)
    print(f"  route {route.myid}: {usable} segments learned")
    print(f"  mean relative error {mean * 100:5.1f}%   worst {worst * 100:5.1f}%")

    # The synthetic drive has no noise, so the only error is arrival-time
    # interpolation within a step. Anything large means the model is not
    # actually learning the profile it was shown.
    if mean > 0.15:
        failures.append(f"learned segment times off by {mean * 100:.0f}% on average")
    else:
        print("  OK: learned times track the profile they were driven at")

    # And confirm a single constant cannot do the same job.
    const_speed = index.length / sum(
        (stop_arcs[(i + 1) % len(stop_arcs)][1] - a if stop_arcs[(i + 1) % len(stop_arcs)][1] > a
         else stop_arcs[(i + 1) % len(stop_arcs)][1] - a + index.length) / profile(a)
        for i, (_s, a) in enumerate(stop_arcs)
    )
    const_errors = []
    for i, (from_sid, from_arc) in enumerate(stop_arcs):
        to_sid, to_arc = stop_arcs[(i + 1) % len(stop_arcs)]
        span = to_arc - from_arc
        if span < 0:
            span += index.length
        truth = span / profile(from_arc)
        const_errors.append(abs(span / const_speed - truth) / truth)
    const_mean = sum(const_errors) / len(const_errors)
    print(f"  best single constant speed ({const_speed:.1f} m/s) would be off "
          f"{const_mean * 100:.0f}% on average")
    if const_mean <= mean:
        failures.append(
            "a constant speed matched the learned model, so this test is not "
            "exercising what it claims to"
        )

    return failures


def main():
    failures = []
    failures += check_detection()
    failures += check_learned_model()

    print()
    if failures:
        print(f"{len(failures)} problem(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
