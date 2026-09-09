"""
Validation for the Ride Systems migration.

The two coordinate paths in ridesystems_client.py are the only places where a
silent error would corrupt everything downstream, so they get checked against
independent ground truth:

  * Platform positions are compared to the stop coordinates Harvard published
    through PassioGO, which the old backend served for months.
  * Pattern polylines are checked for passing near the platforms of their own
    route — a shape decoded with the wrong transform would miss them entirely.

Run: python validate_ridesystems.py
"""

import math
import sys

import ridesystems_client as rs

# Stop coordinates as PassioGO reported them, still served by the deployed
# backend's /stops. Independent of anything this module computes.
PASSIO_REFERENCE = {
    "SEC": (42.363328644, -71.125392617),
    "Barry's Corner (Northbound)": (42.363958424, -71.127741708),
    "Stadium (Northbound)": (42.367121429, -71.124685),
    "Law School": (42.377977084, -71.119937392),
}

# Platform placement on a schematic map is deliberately nudged for legibility,
# so exact agreement is not expected; anything past this is a broken transform.
MAX_STOP_ERROR_M = 60.0
# A route's own stops should sit essentially on its polyline.
MAX_SHAPE_OFFSET_M = 75.0


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def check_stops(stops):
    print(f"\nStops: {len(stops)}")
    by_name = {s.name: s for s in stops}
    failures = []

    for name, (ref_lat, ref_lng) in PASSIO_REFERENCE.items():
        stop = by_name.get(name)
        if stop is None:
            print(f"  ?  {name:34} not in feed (route changes since Passio)")
            continue
        err = haversine_m(stop.latitude, stop.longitude, ref_lat, ref_lng)
        ok = err <= MAX_STOP_ERROR_M
        print(f"  {'OK' if ok else 'FAIL':4} {name:34} {err:6.1f} m from Passio position")
        if not ok:
            failures.append(f"{name} off by {err:.0f} m")

    missing_coords = [s.name for s in stops if not (-90 <= s.latitude <= 90)]
    if missing_coords:
        failures.append(f"{len(missing_coords)} stops with impossible latitude")

    # Everything should land inside Cambridge/Allston.
    out_of_area = [
        s.name
        for s in stops
        if not (42.34 <= s.latitude <= 42.40 and -71.15 <= s.longitude <= -71.10)
    ]
    if out_of_area:
        failures.append(f"stops outside Harvard's area: {out_of_area[:3]}")
    print(f"  {len(stops) - len(out_of_area)}/{len(stops)} stops inside the expected bounding box")

    return failures


def check_routes(routes, stops):
    print(f"\nRoutes: {len(routes)}")
    failures = []
    stop_by_id = {s.id: s for s in stops}

    for r in routes:
        shape = rs.get_route_shape(r.myid)
        patterns = rs.get_route_patterns(r.myid)
        chain = [stop_by_id[p] for p in r.platform_ids if p in stop_by_id]
        shape_len = len(shape) if shape else 0
        print(
            f"  {r.myid:5} {r.name[:28]:28} stops={len(chain):2} "
            f"variants={len(patterns)} shape_pts={shape_len:4} color={r.color}"
        )

        if len(chain) < 2:
            failures.append(f"route {r.myid} has fewer than 2 usable stops")
        if not shape:
            failures.append(f"route {r.myid} has no decodable geometry")
            continue

        # The canonical chain is derived by projection, so every stop in it must
        # sit on the canonical shape by construction. This catches a regression
        # in that derivation rather than a feed quirk.
        worst = 0.0
        worst_stop = ""
        for s in chain:
            d = min(haversine_m(s.latitude, s.longitude, la, lo) for la, lo in shape)
            if d > worst:
                worst, worst_stop = d, s.name
        status = "OK" if worst <= MAX_SHAPE_OFFSET_M else "FAIL"
        print(f"        {status}: worst chain stop-to-shape offset {worst:5.1f} m ({worst_stop})")
        if worst > MAX_SHAPE_OFFSET_M:
            failures.append(f"route {r.myid} chain stop {worst_stop} is {worst:.0f} m off shape")

        failures += check_chain_order(r, chain)

    return failures


def check_chain_order(route, chain):
    """The load-bearing check.

    Ride Systems sorts each route's stop array alphabetically by name, so the
    ordering has to be recovered from geometry. If that derivation broke we
    would get an alphabetical chain back, and every along-route distance in the
    ETA engine would be measured through a path no bus drives. Two signals:
    the order must not be alphabetical, and consecutive hops must be short
    enough to be real hops rather than jumps across campus.
    """
    failures = []
    names = [s.name for s in chain]

    if len(names) > 3 and names == sorted(names):
        failures.append(
            f"route {route.myid} chain is still in alphabetical order — "
            "geometric ordering did not take effect"
        )
        print("        FAIL: chain order is alphabetical")
        return failures

    hops = [
        haversine_m(a.latitude, a.longitude, b.latitude, b.longitude)
        for a, b in zip(chain, chain[1:])
    ]
    if not hops:
        return failures

    longest = max(hops)
    # Harvard's longest real gap between consecutive stops is the Charles
    # crossing to Allston, about 900 m. A hop far beyond that means the chain
    # is teleporting and the ordering is wrong.
    ok = longest <= 1500.0
    print(
        f"        {'OK' if ok else 'FAIL'}: chain order geometric "
        f"(median hop {sorted(hops)[len(hops) // 2]:5.0f} m, longest {longest:5.0f} m)"
    )
    if not ok:
        failures.append(
            f"route {route.myid} has a {longest:.0f} m hop between consecutive stops"
        )
    return failures


def check_vehicles(vehicles):
    print(f"\nLive vehicles: {len(vehicles)}")
    failures = []
    for v in vehicles:
        in_area = 42.34 <= v.latitude <= 42.40 and -71.15 <= v.longitude <= -71.10
        print(
            f"  {'OK' if in_area else 'FAIL':4} {v.id:>5} {v.routeId:5} "
            f"{v.latitude:.5f},{v.longitude:.5f} rp={v.route_progress}"
        )
        if not in_area:
            failures.append(f"vehicle {v.id} at implausible position")
    if not vehicles:
        print("  (none in service right now — not a failure, but nothing was verified)")
    return failures


def check_vendor_etas(stops):
    print("\nOperator ETAs (sample of 3 stops):")
    failures = []
    for s in stops[:3]:
        try:
            etas = rs.get_platform_etas(s.id)
        except Exception as e:
            failures.append(f"PlatformET failed for {s.name}: {e}")
            continue
        summary = ", ".join(f"{e.route_id}:{e.eta_minutes}m" for e in etas[:4]) or "none"
        print(f"  {s.name[:30]:30} {summary}")
    return failures


def main():
    failures = []
    stops = rs.get_stops()
    routes = rs.get_routes()

    failures += check_stops(stops)
    failures += check_routes(routes, stops)
    failures += check_vehicles(rs.get_vehicles())
    failures += check_vendor_etas(stops)

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
