"""
The M2 Cambridge shuttle, merged into the Harvard system.

The M2 runs a loop from the Longwood Medical Area through Kenmore, MIT and
Central Square to Harvard Square and back. It is not a Harvard route: the
Longwood Collective (formerly MASCO) operates it, and since January 2026 its
tracker is Passio, so it is not in the Ride Systems feed the rest of the app
reads. Harvard riders use it all the time, so it is merged in here as one more
route of system 831. That puts it on the map and in Next Bus, Routes and Plan
Trip with no special cases downstream.

Source: Passio's public, keyless feeds for the Longwood Collective, system
6986, where the M2 is GTFS route 8526:

- Static GTFS (stops, the loop's stop order, the shape):
  https://passio3.com/longwoodcollective/passioTransit/gtfs/google_transit.zip
  The feed's validity window is about a month and it is regenerated, so it is
  re-read every STATIC_TTL_S.
- GTFS-realtime as JSON (Passio's own JSON rendering of the standard feed):
  .../gtfs/realtime/vehiclePositions.json and .../tripUpdates.json

Where an M2 stop sits on top of a Harvard stop (Quincy Square, Widener Gate,
Sever Gate, Lamont Library), it becomes that stop rather than a second one, so
lists show one "Widener Gate" and Plan Trip can transfer there. The other M2
stops are added with ids prefixed "m2-".

Everything here fails soft: if Passio is unreachable, the M2 is simply absent
and the Harvard routes are untouched.
"""

from __future__ import annotations

import csv
import io
import logging
import math
import os
import threading
import time
import zipfile
from collections import Counter, defaultdict
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

ROUTE_ID = "M2"
ROUTE_NAME = "M2 Cambridge"
ROUTE_COLOR = "#610191"
GTFS_ROUTE_ID = os.getenv("M2_GTFS_ROUTE_ID", "8526")

_BASE = os.getenv("M2_PASSIO_BASE", "https://passio3.com/longwoodcollective/passioTransit/gtfs")
STATIC_URL = f"{_BASE}/google_transit.zip"
VEHICLES_URL = f"{_BASE}/realtime/vehiclePositions.json"
TRIP_UPDATES_URL = f"{_BASE}/realtime/tripUpdates.json"

STATIC_TTL_S = float(os.getenv("M2_STATIC_TTL_S", str(12 * 3600)))
VEHICLES_TTL_S = float(os.getenv("M2_VEHICLES_TTL_S", "5"))
TRIP_UPDATES_TTL_S = float(os.getenv("M2_TRIP_UPDATES_TTL_S", "20"))
TIMEOUT_S = 10

# An M2 stop this close to a Harvard stop is the same stop. The four that
# coincide are 3-29 m apart; the next nearest is over 200 m.
MERGE_RADIUS_M = 40.0

# Run labels, shaped like the operator's ("QUAD", "SEC") so the app shows them
# the same way: where the bus is heading next.
HEADING_HARVARD = "HARVARD SQ"
HEADING_LONGWOOD = "LONGWOOD"

ENABLED = os.getenv("M2_ENABLED", "true").lower() != "false"


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _get(url: str) -> requests.Response:
    resp = requests.get(url, timeout=TIMEOUT_S, headers={"User-Agent": "sHUttl/1.0"})
    resp.raise_for_status()
    return resp


# ---------------------------------------------------------------------------
# Static: the loop
# ---------------------------------------------------------------------------

class _Static:
    """The M2's stops in loop order and its shape, from the static GTFS."""

    def __init__(self, stops: list[dict], shape: list[tuple[float, float]]):
        # [{"gtfs_id", "name", "lat", "lng"}] in travel order, without the
        # loop's closing repeat of the first stop.
        self.stops = stops
        self.shape = shape


_static: Optional[_Static] = None
_static_at = 0.0
_static_lock = threading.Lock()


def _parse_static(blob: bytes) -> _Static:
    zf = zipfile.ZipFile(io.BytesIO(blob))

    def rows(name: str):
        with zf.open(name) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))

    trips = [t for t in rows("trips.txt") if t.get("route_id") == GTFS_ROUTE_ID]
    if not trips:
        raise ValueError(f"no trips for route {GTFS_ROUTE_ID} in the M2 feed")
    trip_ids = {t["trip_id"] for t in trips}

    by_trip: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in rows("stop_times.txt"):
        if r["trip_id"] in trip_ids:
            by_trip[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"]))

    # The most common stop order is the loop. (Every trip in the feed has the
    # same one today; this keeps a stray short trip from defining the route.)
    counts: dict[tuple[str, ...], int] = defaultdict(int)
    for seq in by_trip.values():
        counts[tuple(sid for _, sid in sorted(seq))] += 1
    order = list(max(counts, key=counts.get))
    if len(order) > 1 and order[0] == order[-1]:
        order = order[:-1]

    gtfs_stops = {s["stop_id"]: s for s in rows("stops.txt")}
    stops = [
        {
            "gtfs_id": sid,
            "name": gtfs_stops[sid]["stop_name"].strip(),
            "lat": float(gtfs_stops[sid]["stop_lat"]),
            "lng": float(gtfs_stops[sid]["stop_lon"]),
        }
        for sid in order
        if sid in gtfs_stops
    ]

    shape_id = Counter(t["shape_id"] for t in trips).most_common(1)[0][0]
    pts = sorted(
        ((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"]))
         for r in rows("shapes.txt") if r["shape_id"] == shape_id),
    )
    shape = [(lat, lng) for _, lat, lng in pts]
    if len(shape) < 2:
        shape = [(s["lat"], s["lng"]) for s in stops] + [(stops[0]["lat"], stops[0]["lng"])]
    return _Static(stops, shape)


def get_static() -> Optional[_Static]:
    """The M2 loop, refreshed every STATIC_TTL_S; the previous copy on failure."""
    global _static, _static_at
    if not ENABLED:
        return None
    if _static is not None and time.time() - _static_at < STATIC_TTL_S:
        return _static
    with _static_lock:
        if _static is not None and time.time() - _static_at < STATIC_TTL_S:
            return _static
        try:
            _static = _parse_static(_get(STATIC_URL).content)
            _static_at = time.time()
            logger.info("Loaded M2 schedule", extra={"stops": len(_static.stops), "shape_points": len(_static.shape)})
        except Exception as e:
            # Try again in a few minutes rather than on every request.
            _static_at = time.time() - STATIC_TTL_S + 300
            logger.warning("M2 schedule unavailable", exc_info=e)
        return _static


# ---------------------------------------------------------------------------
# Merging into the Harvard map data
# ---------------------------------------------------------------------------

# GTFS stop id -> the app's stop id, and the app's stop id -> index in the
# loop. Rebuilt with each merge.
_stop_map: dict[str, str] = {}
_loop_index: dict[str, int] = {}
# Index in the loop of the first Harvard Square stop: before it a bus is
# heading to Harvard, from it on to Longwood.
_harvard_from = 0


def extend_mapdata(stops: list, routes: list, route_shapes: dict, route_patterns: dict,
                   route_stop_coords: dict, stop_cls, route_cls, pattern_cls) -> None:
    """Add the M2 to a Ride Systems map data snapshot, in place.

    The classes are passed in rather than imported, so this module does not
    depend on ridesystems_client and the merge cannot create an import cycle.
    """
    global _stop_map, _loop_index, _harvard_from
    static = get_static()
    if static is None or not static.stops:
        return

    stop_map: dict[str, str] = {}
    chain: list[str] = []
    first_shared: Optional[int] = None
    # Only Harvard's own stops are merge candidates. Matching against M2 stops
    # added a moment ago would fold the two sides of Mass Ave (MIT northbound
    # and southbound) into one stop.
    harvard_stops = list(stops)
    for i, s in enumerate(static.stops):
        near = min(harvard_stops, key=lambda h: _haversine_m(s["lat"], s["lng"], h.latitude, h.longitude), default=None)
        if near is not None and _haversine_m(s["lat"], s["lng"], near.latitude, near.longitude) <= MERGE_RADIUS_M:
            sid = near.id
            if first_shared is None:
                first_shared = i
        else:
            sid = f"m2-{s['gtfs_id']}"
            if not any(x.id == sid for x in stops):
                stops.append(stop_cls(id=sid, name=s["name"], latitude=s["lat"], longitude=s["lng"],
                                      routesAndPositions={}, tag=None, code=None))
        stop_map[s["gtfs_id"]] = sid
        chain.append(sid)

    by_id = {x.id: x for x in stops}
    for seq, sid in enumerate(chain):
        by_id[sid].routesAndPositions[ROUTE_ID] = [0, seq]

    routes.append(route_cls(id=ROUTE_ID, myid=ROUTE_ID, name=ROUTE_NAME, shortName=ROUTE_ID,
                            color=ROUTE_COLOR, groupColor=ROUTE_COLOR, platform_ids=list(chain), pattern_tags=[-2]))
    route_shapes[ROUTE_ID] = list(static.shape)
    route_patterns[ROUTE_ID] = [pattern_cls(tag=-2, route_id=ROUTE_ID, shape=list(static.shape), stop_ids=list(chain))]
    route_stop_coords[ROUTE_ID] = [(by_id[sid].latitude, by_id[sid].longitude) for sid in chain]

    _stop_map = stop_map
    _loop_index = {sid: i for i, sid in enumerate(chain)}
    _harvard_from = first_shared or 0


def serves(stop_id: str) -> bool:
    return str(stop_id) in _loop_index


# ---------------------------------------------------------------------------
# Live: vehicles and arrival predictions
# ---------------------------------------------------------------------------

_rt_cache: dict[str, tuple[Any, float]] = {}
_rt_lock = threading.Lock()


def _realtime(url: str, ttl: float) -> dict:
    with _rt_lock:
        hit = _rt_cache.get(url)
        if hit is not None and time.time() - hit[1] < ttl:
            return hit[0]
    try:
        data = _get(url).json()
    except Exception as e:
        logger.warning("M2 realtime feed unavailable", exc_info=e, extra={"url": url})
        # A minute-old answer is better than none; older is misleading.
        if hit is not None and time.time() - hit[1] < 60:
            return hit[0]
        return {}
    with _rt_lock:
        _rt_cache[url] = (data, time.time())
    return data


def _is_m2(entity_part: dict) -> bool:
    return str(((entity_part or {}).get("trip") or {}).get("route_id") or "") == GTFS_ROUTE_ID


def get_vehicles(vehicle_cls) -> list:
    """M2 buses now, as the app's vehicle objects."""
    if get_static() is None:
        return []
    out = []
    for ent in _realtime(VEHICLES_URL, VEHICLES_TTL_S).get("entity") or []:
        v = ent.get("vehicle") or {}
        if not _is_m2(v):
            continue
        pos = v.get("position") or {}
        lat, lng = pos.get("latitude"), pos.get("longitude")
        if lat is None or lng is None:
            continue
        vid = str((v.get("vehicle") or {}).get("id") or ent.get("id"))
        out.append(vehicle_cls(id=f"m2-{vid}", latitude=float(lat), longitude=float(lng),
                               routeId=ROUTE_ID, routeName=ROUTE_ID, heading=pos.get("bearing")))
    return out


def heading_at(stop_id: str) -> str:
    """Where an M2 bus at this stop goes next: Harvard Square or Longwood."""
    i = _loop_index.get(str(stop_id))
    if i is None:
        return HEADING_LONGWOOD
    return HEADING_HARVARD if i < _harvard_from else HEADING_LONGWOOD


def arrivals_at(stop_id: str, now: Optional[float] = None) -> list[int]:
    """Minutes until each M2 bus predicted at this stop, soonest first."""
    sid = str(stop_id)
    if sid not in _loop_index:
        return []
    now = now or time.time()
    gtfs_ids = {g for g, ours in _stop_map.items() if ours == sid}
    minutes: list[int] = []
    for ent in _realtime(TRIP_UPDATES_URL, TRIP_UPDATES_TTL_S).get("entity") or []:
        tu = ent.get("trip_update") or {}
        if not _is_m2(tu):
            continue
        for stu in tu.get("stop_time_update") or []:
            if str(stu.get("stop_id")) not in gtfs_ids:
                continue
            t = (stu.get("arrival") or {}).get("time") or (stu.get("departure") or {}).get("time")
            if t is None:
                continue
            dt = float(t) - now
            # A prediction a little in the past is a bus at the stop now.
            if dt >= -60:
                minutes.append(max(0, round(dt / 60.0)))
                break  # one arrival per bus: its next pass of this stop
    return sorted(minutes)
