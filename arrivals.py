"""
Observed arrivals, learned segment travel times, and ETAs built from them.

Why this exists
---------------
eta_compare.py scores our predictions against the operator's. That can only ever
show whether we match them. To be *better* than them we need the thing neither
of us publishes: when the bus actually turned up.

We can observe that ourselves. The position poller sees every vehicle every few
seconds, so a bus passing a stop is an event we can timestamp. Those events are
ground truth, and they do two jobs:

  1. They let both predictors be scored against reality rather than each other
     (eta_scoreboard.py).
  2. They are training data. Learned per-segment travel times beat any global
     speed constant, because they absorb what a constant cannot: this route's
     traffic lights, this segment's left turn across Mass Ave, this hour's
     congestion.

Detection method
----------------
Not a proximity radius. At a 10 s poll interval a bus covers ~50 m, so a 30 m
circle around a stop is missed more often than hit. Instead each fix is
projected to an arc length along the route geometry, and any stop whose own arc
position falls between the previous fix and this one has been passed. The
arrival time is interpolated within that step, which also removes most of the
polling quantisation from the timestamp.

Storage
-------
Append-only JSONL, plus in-memory aggregates rebuilt from it at startup. Redis
is used when configured, since Render's filesystem does not survive a redeploy
and travel times take days to accumulate.
"""

import json
import logging
import math
import os
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Optional

import ridesystems_client as rs

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATA_DIR = os.getenv("SHUTTL_DATA_DIR", "data")
ARRIVALS_PATH = os.path.join(DATA_DIR, "arrivals.jsonl")

# A fix further than this from the route geometry is not on the route: a
# deadheading bus, a GPS spike, or a vehicle assigned to the wrong pattern.
MAX_OFF_ROUTE_M = 250.0

# Two fixes further apart than this along the route are not a continuous
# movement — the poller missed cycles, or the bus was out of service in between.
# Crossings inferred across such a gap would invent arrivals.
MAX_STEP_M = 1200.0

# A vehicle cannot legitimately re-cross the same pass of the same stop within
# this window; anything sooner is jitter around a stop it is idling at. Applies
# per arc position, so a route serving one stop twice per lap is unaffected.
REARRIVAL_COOLDOWN_S = 120.0

# How far along the shape to search when projecting a fix, given the previous
# one. Must exceed the furthest a bus travels between polls (MAX_STEP_M) with
# room for GPS error, and stay well under the distance between two passes of the
# same road, or the ambiguity it exists to resolve comes back.
PROJECTION_WINDOW_M = 400.0

# Two passes of one stop must be at least this far apart along the route to be
# separate arrivals. Below it, the shape is doubling back at a terminal rather
# than the bus coming round again.
MIN_PASS_SEPARATION_M = 400.0

# A stop further than this from the shape is not served by that pass of it.
# Tighter than MAX_OFF_ROUTE_M, which governs vehicles: a stop's position is
# fixed and surveyed, so a loose threshold here would attach a stop to a parallel
# street the route also drives.
STOP_ON_ROUTE_M = 40.0

# How many recent observations to keep per segment. Long enough to average out
# one bad light cycle, short enough to track the morning peak turning into
# midday.
SEGMENT_HISTORY = 24

# Travel times are bucketed by hour of the week: congestion on a Tuesday at 9am
# has nothing to do with a Sunday at 9am. 168 buckets is coarse enough to fill
# in a couple of weeks of service.
def _time_bucket(ts: float) -> int:
    lt = time.localtime(ts)
    return lt.tm_wday * 24 + lt.tm_hour


# A segment estimate below this many observations is not trusted on its own.
MIN_OBS_FOR_SEGMENT = 3

# Implausible segment times are dropped rather than averaged in: a bus held at a
# terminal for 20 minutes is not evidence about how long the leg takes.
MIN_SEGMENT_S = 5.0
MAX_SEGMENT_S = 900.0


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Arrival:
    """An observed pass of a vehicle by a stop."""

    t: float           # unix seconds, interpolated within the polling step
    route_id: str
    stop_id: str
    vehicle_id: str


class _ArrivalStore:
    """Append-only log plus the aggregates derived from it."""

    def __init__(self):
        self._lock = threading.Lock()
        self._fh = None

        # (route_id, from_stop, to_stop, bucket) -> recent durations in seconds
        self.segment_times: dict[tuple, deque] = defaultdict(
            lambda: deque(maxlen=SEGMENT_HISTORY)
        )
        # (route_id, stop_id) -> arrival times, newest last. Used to resolve
        # "when did the next bus actually arrive" when scoring predictions.
        self.stop_arrivals: dict[tuple, deque] = defaultdict(
            lambda: deque(maxlen=400)
        )
        self.total_arrivals = 0
        # vehicle_id -> its previous arrival, for deriving segment durations
        self._last_by_vehicle: dict[str, Arrival] = {}

    # -- persistence ------------------------------------------------------

    def _ensure_file(self):
        if self._fh is not None:
            return
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            self._fh = open(ARRIVALS_PATH, "a")
        except OSError as e:
            # A read-only filesystem must not take the API down; the in-memory
            # aggregates still work for the life of the process.
            logger.warning("Cannot open arrival log; keeping arrivals in memory only",
                           exc_info=e)
            self._fh = False  # sentinel: tried and failed

    def append(self, a: Arrival):
        with self._lock:
            self._record(a)
            self._ensure_file()
            if self._fh:
                try:
                    self._fh.write(json.dumps({
                        "t": round(a.t, 1),
                        "route_id": a.route_id,
                        "stop_id": a.stop_id,
                        "vehicle_id": a.vehicle_id,
                    }) + "\n")
                    self._fh.flush()
                except OSError as e:
                    logger.warning("Failed to write arrival", exc_info=e)

    def load(self):
        """Rebuild aggregates from the log. Called once at startup."""
        if not os.path.exists(ARRIVALS_PATH):
            return 0
        loaded = 0
        with self._lock:
            # Ordering matters: segment times come from consecutive arrivals of
            # one vehicle, so the log has to be replayed in the order written.
            with open(ARRIVALS_PATH) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                        self._record(Arrival(
                            t=float(d["t"]),
                            route_id=str(d["route_id"]),
                            stop_id=str(d["stop_id"]),
                            vehicle_id=str(d["vehicle_id"]),
                        ))
                        loaded += 1
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                        continue
        logger.info("Replayed observed arrivals", extra={
            "arrivals": loaded,
            "segments": len(self.segment_times),
        })
        return loaded

    # -- aggregation ------------------------------------------------------

    def _record(self, a: Arrival):
        """Fold one arrival into the aggregates. Caller holds the lock."""
        self.total_arrivals += 1
        self.stop_arrivals[(a.route_id, a.stop_id)].append(a.t)

        prev = self._last_by_vehicle.get(a.vehicle_id)
        self._last_by_vehicle[a.vehicle_id] = a

        if prev is None or prev.route_id != a.route_id:
            return
        duration = a.t - prev.t
        if not (MIN_SEGMENT_S <= duration <= MAX_SEGMENT_S):
            return
        key = (a.route_id, prev.stop_id, a.stop_id, _time_bucket(a.t))
        self.segment_times[key].append(duration)

    # -- queries ----------------------------------------------------------

    def segment_estimate(
        self, route_id: str, from_stop: str, to_stop: str, at: Optional[float] = None
    ) -> Optional[tuple[float, int]]:
        """Learned seconds for one hop, as (median, sample count).

        Median rather than mean: a bus held at a stop or caught by one long
        light produces outliers that a mean chases and a median ignores.

        Falls back progressively — this hour of this weekday, then the same hour
        on any day, then any time — so a segment starts contributing as soon as
        it has been travelled a few times, without pretending a Sunday
        observation describes Monday rush hour.
        """
        at = at if at is not None else time.time()
        bucket = _time_bucket(at)
        hour = bucket % 24

        exact = self.segment_times.get((route_id, from_stop, to_stop, bucket))
        if exact and len(exact) >= MIN_OBS_FOR_SEGMENT:
            return _median(exact), len(exact)

        same_hour = []
        any_time = []
        for (rid, f, t, b), vals in self.segment_times.items():
            if rid != route_id or f != from_stop or t != to_stop:
                continue
            any_time.extend(vals)
            if b % 24 == hour:
                same_hour.extend(vals)

        if len(same_hour) >= MIN_OBS_FOR_SEGMENT:
            return _median(same_hour), len(same_hour)
        if len(any_time) >= MIN_OBS_FOR_SEGMENT:
            return _median(any_time), len(any_time)
        return None

    def next_arrival_after(
        self, route_id: str, stop_id: str, after: float
    ) -> Optional[float]:
        """When a bus on this route next actually reached this stop."""
        for t in self.stop_arrivals.get((route_id, stop_id), ()):
            if t > after:
                return t
        return None

    def coverage(self) -> dict:
        """How much of the network has enough history to be predicted well."""
        pairs = set()
        well_covered = set()
        for (rid, f, t, _b), vals in self.segment_times.items():
            pairs.add((rid, f, t))
            if len(vals) >= MIN_OBS_FOR_SEGMENT:
                well_covered.add((rid, f, t))
        return {
            "arrivals": self.total_arrivals,
            "segments_seen": len(pairs),
            "segments_usable": len(well_covered),
        }


def _median(vals) -> float:
    s = sorted(vals)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


STORE = _ArrivalStore()


# ---------------------------------------------------------------------------
# Arrival detection
# ---------------------------------------------------------------------------

@dataclass
class _VehicleTrack:
    arc: float
    t: float
    route_id: str


_tracks: dict[str, _VehicleTrack] = {}
_last_arrival: dict[tuple[str, str], float] = {}
_track_lock = threading.Lock()


def observe_vehicles(vehicles, now: Optional[float] = None) -> list[Arrival]:
    """Turn a batch of position fixes into observed arrivals.

    Called from the background poller. Returns the arrivals detected in this
    batch, mostly so the caller can log them.
    """
    now = now if now is not None else time.time()
    detected: list[Arrival] = []

    for v in vehicles:
        try:
            arrivals = _observe_one(v, now)
        except Exception as e:
            # Never let one malformed vehicle stop the poller.
            logger.warning("Arrival detection failed for vehicle",
                           exc_info=e, extra={"vehicle": getattr(v, "id", "?")})
            continue
        detected.extend(arrivals)

    for a in detected:
        STORE.append(a)

    return detected


def _observe_one(v, now: float) -> list[Arrival]:
    route_id = str(getattr(v, "routeId", "") or "")
    vid = str(getattr(v, "id", "") or "")
    if not route_id or not vid:
        return []

    index = rs._shape_index_for_route(route_id)
    if index is None or index.length <= 0:
        return []

    with _track_lock:
        prev = _tracks.get(vid)

    # Resolve the projection against the previous position where we have one.
    # On a route that drives the same road twice per lap, globally nearest
    # projection flips between the two passes and fabricates arrivals.
    if prev is not None and prev.route_id == route_id:
        arc, offset = index.project_near(
            float(v.latitude), float(v.longitude), prev.arc, PROJECTION_WINDOW_M
        )
    else:
        arc, offset = index.project(float(v.latitude), float(v.longitude))

    if offset > MAX_OFF_ROUTE_M:
        return []

    with _track_lock:
        _tracks[vid] = _VehicleTrack(arc=arc, t=now, route_id=route_id)

        # Vehicle tags churn daily; bound the dicts.
        if len(_tracks) > 500:
            cutoff = now - 3600
            for k in [k for k, tr in _tracks.items() if tr.t < cutoff]:
                del _tracks[k]

    if prev is None or prev.route_id != route_id:
        return []

    travelled = arc - prev.arc
    if travelled < 0:
        # Wrapped past the end of a loop.
        travelled += index.length
    if travelled <= 0 or travelled > MAX_STEP_M:
        return []

    stop_arcs = _route_stop_arcs(route_id, index)
    if not stop_arcs:
        return []

    out = []
    for stop_id, stop_arc in stop_arcs:
        # Distance from the previous fix forward to this stop, on the loop.
        delta = stop_arc - prev.arc
        if delta < 0:
            delta += index.length
        if not (0 < delta <= travelled):
            continue

        # Interpolate within the step rather than stamping the poll time, which
        # would quantise every arrival to the polling interval.
        frac = delta / travelled
        t_arrival = prev.t + frac * (now - prev.t)

        # Dedupe per *pass*, not per stop. A time-based cooldown on (vehicle,
        # stop) cannot tell GPS jitter at one pass from a genuine second pass a
        # few hundred metres later on the same lap: Overnight loops back past
        # Mather and Dunster within a minute, and a stop-level cooldown silently
        # dropped the second arrival. Keying on the arc position makes the two
        # passes distinct events while still collapsing jitter at either one.
        key = (vid, stop_id, round(stop_arc))
        if t_arrival - _last_arrival.get(key, 0.0) < REARRIVAL_COOLDOWN_S:
            continue
        _last_arrival[key] = t_arrival

        out.append(Arrival(t=t_arrival, route_id=route_id, stop_id=stop_id,
                           vehicle_id=vid))

    if len(_last_arrival) > 4000:
        _last_arrival.clear()

    out.sort(key=lambda a: a.t)
    return out


_stop_arc_cache: dict[str, list[tuple[str, float]]] = {}
_stop_arc_lock = threading.Lock()


def _route_stop_arcs(route_id: str, index) -> list[tuple[str, float]]:
    """Arc position of each of a route's stops, cached per route."""
    with _stop_arc_lock:
        cached = _stop_arc_cache.get(route_id)
        if cached is not None:
            return cached

    stop_ids = rs.get_route_stop_ids(route_id)
    if not stop_ids:
        return []
    by_id = {s.id: s for s in rs.get_stops()}

    arcs = []
    for sid in stop_ids:
        s = by_id.get(sid)
        if s is None:
            continue
        # Every pass, not just the nearest one: a route that serves a stop
        # twice in a lap arrives there twice, and collapsing those to one arc
        # makes the second arrival invisible.
        for arc in index.local_minima(
            s.latitude, s.longitude, STOP_ON_ROUTE_M, MIN_PASS_SEPARATION_M
        ):
            arcs.append((sid, arc))

    with _stop_arc_lock:
        if len(_stop_arc_cache) > 64:
            _stop_arc_cache.clear()
        _stop_arc_cache[route_id] = arcs
    return arcs


def invalidate_route_cache():
    """Drop cached arc positions after a route-structure refresh."""
    with _stop_arc_lock:
        _stop_arc_cache.clear()


# ---------------------------------------------------------------------------
# ETA from learned travel times
# ---------------------------------------------------------------------------

@dataclass
class LearnedEta:
    seconds: float
    # Fraction of the journey covered by learned segments rather than fallback.
    learned_fraction: float
    segments_used: int
    observations: int


def learned_eta_to_stop(
    route_id: str,
    vehicle_lat: float,
    vehicle_lng: float,
    target_stop_id: str,
    fallback_speed_ms: float,
    dwell_s: float,
    at: Optional[float] = None,
) -> Optional[LearnedEta]:
    """Predict arrival by summing learned times for the hops that remain.

    Each hop the bus still has to make contributes its own measured duration,
    which already includes that hop's lights, turns and dwell. Hops with no
    history yet fall back to distance over speed plus dwell, so the estimate
    degrades smoothly on a new route instead of disappearing.

    The current partial hop is charged pro rata by distance: a bus a third of
    the way along a hop is charged two thirds of that hop's learned time.
    """
    at = at if at is not None else time.time()

    index = rs._shape_index_for_route(route_id)
    if index is None or index.length <= 0:
        return None

    stop_arcs = _route_stop_arcs(route_id, index)
    if len(stop_arcs) < 2:
        return None

    v_arc, v_off = index.project(vehicle_lat, vehicle_lng)
    if v_off > MAX_OFF_ROUTE_M:
        return None

    target = next((s for s in stop_arcs if s[0] == str(target_stop_id)), None)
    if target is None:
        return None

    # Walk the stop sequence forward from the bus to the target, on the loop.
    ordered = sorted(stop_arcs, key=lambda s: s[1])
    n = len(ordered)
    start_i = next((i for i, (_sid, arc) in enumerate(ordered) if arc > v_arc), 0)

    total = 0.0
    learned_s = 0.0
    segments = 0
    observations = 0

    prev_stop_id = None
    prev_arc = v_arc

    for step in range(n + 1):
        sid, arc = ordered[(start_i + step) % n]

        span = arc - prev_arc
        if span < 0:
            span += index.length

        if prev_stop_id is None:
            # Partial first hop: prorate the hop the bus is midway through.
            hop_from = ordered[(start_i - 1) % n][0]
            est = STORE.segment_estimate(route_id, hop_from, sid, at)
            full_span = arc - ordered[(start_i - 1) % n][1]
            if full_span < 0:
                full_span += index.length
            if est and full_span > 0:
                secs = est[0] * (span / full_span)
                learned_s += secs
                observations += est[1]
                segments += 1
            else:
                secs = span / max(fallback_speed_ms, 0.1) + dwell_s
            total += secs
        else:
            est = STORE.segment_estimate(route_id, prev_stop_id, sid, at)
            if est:
                total += est[0]
                learned_s += est[0]
                observations += est[1]
                segments += 1
            else:
                total += span / max(fallback_speed_ms, 0.1) + dwell_s

        if sid == target[0]:
            break

        prev_stop_id = sid
        prev_arc = arc
    else:
        return None

    return LearnedEta(
        seconds=total,
        learned_fraction=(learned_s / total) if total > 0 else 0.0,
        segments_used=segments,
        observations=observations,
    )
