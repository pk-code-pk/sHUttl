import asyncio
from fastapi import FastAPI, HTTPException, Query, Depends, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from collections import defaultdict, deque
import datetime
from datetime import datetime 
from datetime import timedelta
import math 
import re
import os
import json
import logging
import time
from typing import Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from redis import Redis
from redis.exceptions import RedisError
import redis.asyncio as redis_async
from fastapi_limiter import FastAPILimiter
from fastapi_limiter.depends import RateLimiter
from ridesystems_client import (
    get_stops,
    get_vehicles,
    get_routes,
    DEFAULT_SYSTEM_ID,
    get_all_systems,
    get_platform_etas,
)

# Route geometry, now sourced from Ride Systems rather than GTFS shapes.txt.
# harvard_gtfs.py and harvard_mapping.py are no longer imported: Harvard left
# PassioGO on 2026-07-01, so there is no second feed to reconcile against and no
# GTFS export with live service in it. See ridesystems_client.py.
from ridesystems_client import distance_along_route_m, get_route_stop_ids
import arrivals as arrivals_module
import reminders as reminders_module
from pydantic import BaseModel, Field
from arrivals import (
    STORE as ARRIVAL_STORE,
    learned_eta_to_stop,
    observe_vehicles,
)
from harvard_shapes import (
    get_shape_for_route,
    get_shape_for_segment,
    get_stop_coords_for_route,
    get_route_id_by_name,
)
from harvard_places import PLACES, match_place, match_stop_name

logger = logging.getLogger("trip")
import harvard_schedule

REDIS_URL = os.getenv("REDIS_URL")
redis_client: Optional[Redis] = None

if REDIS_URL:
    try:
        redis_client = Redis.from_url(REDIS_URL)
        redis_client.ping()
        logger.info("Connected to Redis for caching", extra={"redis_url": REDIS_URL})
    except Exception as e:
        logger.warning("Failed to connect to Redis for caching, disabling cache", exc_info=e)
        redis_client = None
else:
    logger.info("REDIS_URL not set, running without Redis caching")

# Push subscriptions + reminders share the cache connection. Without Redis they
# fall back to data/reminders.json, which Render wipes on every deploy.
REMINDER_STORE = reminders_module.Store(redis_client)

# ---------------------------------------------------------------------------
# In-process TTL cache for PassioGO objects (stops, routes)
# These cannot be JSON-serialized for Redis, so we keep them in-memory.
# Stops: 10 min (match Redis STOPS_TTL).  Routes: 5 min (change at most daily).
# ---------------------------------------------------------------------------
_passio_cache: dict[str, tuple[Any, float]] = {}

def _passio_cache_get(key: str, ttl: float) -> Any:
    entry = _passio_cache.get(key)
    if entry is not None:
        data, ts = entry
        if time.time() - ts < ttl:
            return data
    return None

def _passio_cache_set(key: str, data: Any) -> None:
    _passio_cache[key] = (data, time.time())

def get_stops_cached(system_id: int):
    key = f"stops:{system_id}"
    cached = _passio_cache_get(key, 600)
    if cached is not None:
        return cached
    data = get_stops(system_id)
    _passio_cache_set(key, data)
    return data

def get_routes_cached(system_id: int):
    key = f"routes:{system_id}"
    cached = _passio_cache_get(key, 300)
    if cached is not None:
        return cached
    data = get_routes(system_id)
    _passio_cache_set(key, data)
    return data

ENV = os.getenv("ENV", "development").lower()
ENABLE_DOCS = os.getenv("ENABLE_DOCS", "true").lower() == "true"

if ENV == "production" and not ENABLE_DOCS:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
else:
    app = FastAPI()

CORS_ALLOWED_ORIGINS = os.getenv("CORS_ALLOWED_ORIGINS", "*")

if CORS_ALLOWED_ORIGINS.strip() == "*":
    origins = ["*"]
else:
    origins = [o.strip() for o in CORS_ALLOWED_ORIGINS.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#intialize our app with FastAPI framework 

@app.api_route("/health", methods=["GET", "HEAD"])
def health_check(response: Response):
    return {"status": "ok", "message": "Backend is running!"}
    
@app.head("/health")
def health_head():
    return Response(status_code=200)

@app.on_event("startup")
async def startup_event():
    # Replay observed arrivals so a restart keeps the learned travel times.
    # Segment history takes days of service to accumulate; losing it on every
    # deploy would mean the model never leaves its fallback.
    try:
        await asyncio.to_thread(ARRIVAL_STORE.load)
    except Exception as e:
        logger.warning("Could not replay arrival log", exc_info=e)

    # Start background vehicle position poller (runs regardless of Redis)
    asyncio.create_task(_vehicle_position_poller())
    logger.info("Vehicle position poller started")

    # Reminder ticks are what turn a saved class time into a push on the phone;
    # nothing else fires them.
    asyncio.create_task(reminders_module.reminder_scheduler(REMINDER_STORE))
    logger.info("Reminder scheduler started", extra={"store": REMINDER_STORE.backend})

    redis_url = os.getenv("REDIS_URL")
    if not redis_url:
        logger.info("REDIS_URL not set, running without rate limiting")
        return

    try:
        redis = redis_async.from_url(redis_url, encoding="utf-8", decode_responses=True)
        await FastAPILimiter.init(redis)
        logger.info("fastapi-limiter initialized with Redis", extra={"redis_url": redis_url})
    except Exception as e:
        logger.warning("Failed to initialize fastapi-limiter, rate limiting disabled", exc_info=e)


class OptionalRateLimiter(RateLimiter):
    async def __call__(self, request: Request, response: Response):
        # If limiter was never initialized, skip rate limiting
        if getattr(FastAPILimiter, "redis", None) is None:
            return

        try:
            return await super().__call__(request, response)
        except (RedisError, OSError, ConnectionError) as e:
            # Redis down / transient error -> fail open
            logger.warning("Rate limiter Redis error; skipping rate limit", exc_info=e)
            return


VEHICLE_STATE = {}  # cache: (system_id, vehicle_id) -> last 4 GPS positions + timestamps

VEHICLE_POLL_INTERVAL_S = 10  # seconds between background position polls

async def _vehicle_position_poller():
    """
    Background task: poll all vehicle positions every VEHICLE_POLL_INTERVAL_S seconds
    and feed them into VEHICLE_STATE so speed history accumulates independently of
    trip requests. Without this, VEHICLE_STATE is only populated when someone calls
    /trip, meaning fresh deploys and quiet periods always fall back to FALLBACK_SPEED_MS.

    The same position stream is the only source of ground truth we have: a bus
    crossing a stop between two fixes is an observed arrival. arrivals.py turns
    those into per-segment travel times, which is what lets the ETA model learn
    a route instead of assuming a constant speed. Keep this poller running —
    without it there is no training data and no way to score any predictor.
    """
    while True:
        try:
            # get_vehicles is a blocking network call — run in a thread so we don't
            # stall the async event loop.
            vehicles = await asyncio.to_thread(get_vehicles, DEFAULT_SYSTEM_ID)
            now = datetime.now()

            # Detect arrivals before updating VEHICLE_STATE: detection needs the
            # previous fix, and it keeps its own track of that.
            try:
                detected = await asyncio.to_thread(observe_vehicles, vehicles)
                if detected:
                    logger.info("Observed arrivals", extra={
                        "count": len(detected),
                        "stops": [(a.route_id, a.stop_id) for a in detected[:8]],
                    })
            except Exception as e:
                logger.warning("Arrival detection error", exc_info=e)

            for v in vehicles:
                v_lat = getattr(v, "latitude", None)
                v_lng = getattr(v, "longitude", None)
                if v_lat is None or v_lng is None:
                    continue
                key = (DEFAULT_SYSTEM_ID, v.id)
                prev = VEHICLE_STATE.get(key, [])
                prev.append({"lat": float(v_lat), "lng": float(v_lng), "t": now})
                if len(prev) > 4:
                    prev = prev[-4:]
                VEHICLE_STATE[key] = prev
            # Apply the same size cap used in enrichment
            if len(VEHICLE_STATE) > 500:
                VEHICLE_STATE.clear()
        except Exception as e:
            logger.warning("Vehicle position poller error", exc_info=e)
        await asyncio.sleep(VEHICLE_POLL_INTERVAL_S)

# ---------------------------------------------------------------------------
# Trip Skeletons (Performance Refactor)
# ---------------------------------------------------------------------------

from dataclasses import dataclass, field

@dataclass
class SegmentSkeleton:
    route_id: str
    start_stop_id: str
    end_stop_id: str
    # Minimal metadata needed for display/enrichment
    route_name: Optional[str] = None
    short_name: Optional[str] = None
    color: Optional[str] = None
    # Original Passio trip info (for reconstruction)
    raw_trip_info: dict = field(default_factory=dict)
    # Stop list for this segment (essential for enrichment)
    stops: list = field(default_factory=list)

@dataclass
class TripSkeleton:
    segments: list[SegmentSkeleton]
    score: float
    num_transfers: int
    has_live_vehicle: bool
    origin_stop: Any  # Stop object
    dest_stop: Any    # Stop object
    total_walk_m: float
    kind: str  # 'base_no_transfer', 'base_transfer', 'walk_modified'
    # For GTFS-only stops that aren't in the global index
    extra_stops_map: dict = field(default_factory=dict)


ROUTE_GRAPH_CACHE = {}


# ---------------------------------------------------------------------------
# ETA model constants
#
# Both values below were fitted against the operator's own arrival predictions
# using `python eta_compare.py fit`, over 76 paired samples on a single weekday
# afternoon. That is enough to correct a large bias and not enough to trust the
# second decimal place — rerun the fit across a full service day before relying
# on it, and expect the numbers to move.
#
# The fit cannot separate these two parameters cleanly: on Harvard's network
# there is roughly 800 m between consecutive stops, so "slower bus" and "more
# time stopped" explain the same data. Mean absolute error stays within
# 3.98-4.48 min across the whole plausible range of the pair. Dwell is
# therefore pinned at a defensible 20 s and only the speed is fitted, rather
# than letting the optimiser pick the 85 s dwell and 20 mph bus that sit at the
# edge of the search space.
# ---------------------------------------------------------------------------

# Fitted: 4.8 m/s is 10.7 mph, a stop-to-stop average through Cambridge traffic
# and lights. The previous 6.5 m/s (14.5 mph) was closer to a free-flowing
# cruising speed and made every fallback ETA optimistic.
FALLBACK_SPEED_MS = 4.8
MIN_SPEED_MS_FOR_ETA = 1.0   # below this, treat as unusable for ETA

# Speed measured from straight-line GPS displacement underestimates along-route speed
# on curved routes. This factor corrects for typical campus route tortuosity (~1.3x).
SPEED_TORTUOSITY_CORRECTION = 1.25

# Seconds a bus spends stopped at each stop it serves before reaching ours.
# Charged separately from travel time, which is only sound because the speed
# measurement discards hops below 1 m/s: measured speed is therefore a moving
# speed, and dwell is not counted twice.
DWELL_S_PER_STOP = 20.0


def norm_id(x) -> str | None:
    if x is None:
        return None
    s = str(x).strip()
    if not s:
        return None
    s = s.lower()
    s = re.sub(r"[^a-z0-9_-]+", "", s)
    return s or None


def vehicle_to_dict(v):
    # Passio objects can be pydantic or dict-like
    if isinstance(v, dict):
        return v
    if hasattr(v, "dict"):
        return v.dict()
    # last resort
    return {k: getattr(v, k) for k in dir(v) if not k.startswith("_")}


def get_vehicle_route_keys(v) -> list[str]:
    d = vehicle_to_dict(v)
    keys = []

    # common single route fields
    for k in ["route_id", "routeId", "route", "routeID", "routeid"]:
        nid = norm_id(d.get(k))
        if nid:
            keys.append(nid)

    # common multi-route fields (if any)
    for k in ["routes", "assignedRoutes", "routeIds", "route_ids"]:
        val = d.get(k)
        if isinstance(val, list):
            for item in val:
                nid = norm_id(item)
                if nid:
                    keys.append(nid)

    # dedupe
    out = []
    seen = set()
    for k in keys:
        if k not in seen:
            out.append(k)
            seen.add(k)
    return out


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:

## using haversine to calc distance between two sets of latitudes and longitudes 

    R = 6371000 ## earth rad. 
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)

    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2 
    )   

    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c 


def slice_shape_to_segment(
    shape_coords: list[tuple[float, float]],
    start_stop_lat: float,
    start_stop_lng: float,
    end_stop_lat: float,
    end_stop_lng: float,
    stop_coords: list[tuple[float, float]] | None = None,
) -> list[tuple[float, float]]:
    """
    Slice a GTFS shape polyline to only include the portion between start and end stops.

    Args:
        shape_coords: List of (lat, lon) tuples representing the full route shape
        start_stop_lat, start_stop_lng: Coordinates of boarding stop
        end_stop_lat, end_stop_lng: Coordinates of alighting stop
        stop_coords: Optional ordered (lat, lon) of the route's stop sequence,
                     used to determine travel direction on loop routes.

    Returns:
        Sliced portion of shape_coords between the two stops
    """
    if not shape_coords or len(shape_coords) < 2:
        return shape_coords

    # Find index of shape point closest to start stop
    start_idx = 0
    min_start_dist = float('inf')
    for i, (lat, lon) in enumerate(shape_coords):
        d = distance_m(lat, lon, start_stop_lat, start_stop_lng)
        if d < min_start_dist:
            min_start_dist = d
            start_idx = i

    # Find index of shape point closest to end stop
    end_idx = len(shape_coords) - 1
    min_end_dist = float('inf')
    for i, (lat, lon) in enumerate(shape_coords):
        d = distance_m(lat, lon, end_stop_lat, end_stop_lng)
        if d < min_end_dist:
            min_end_dist = d
            end_idx = i

    # Check if shape is effectively a loop (start is close to end)
    is_loop = False
    if len(shape_coords) > 2:
        start_pt = shape_coords[0]
        end_pt = shape_coords[-1]
        if distance_m(start_pt[0], start_pt[1], end_pt[0], end_pt[1]) < 150: # 150m threshold
            is_loop = True

    # For loops, use the GTFS stop sequence to determine the correct direction
    if is_loop and stop_coords and len(stop_coords) >= 2:
        MATCH_THRESHOLD = 200  # meters
        n_stops = len(stop_coords)
        N = len(shape_coords)

        # Find all stop-sequence indices matching start and end stops
        start_matches = [
            i for i, (la, lo) in enumerate(stop_coords)
            if distance_m(la, lo, start_stop_lat, start_stop_lng) < MATCH_THRESHOLD
        ]
        end_matches = [
            i for i, (la, lo) in enumerate(stop_coords)
            if distance_m(la, lo, end_stop_lat, end_stop_lng) < MATCH_THRESHOLD
        ]

        if start_matches and end_matches:
            # Find the (start, end) pair with shortest forward distance
            # in the stop sequence. Handles duplicate terminal stops correctly.
            best_fwd = float('inf')
            best_si, best_ei = start_matches[0], end_matches[0]
            for si in start_matches:
                for ei in end_matches:
                    fwd = (ei - si) % n_stops
                    if fwd == 0:
                        fwd = n_stops
                    if fwd < best_fwd:
                        best_fwd = fwd
                        best_si, best_ei = si, ei

            # Re-derive shape indices from the chosen stop-sequence endpoints.
            # This resolves ambiguity when a stop (e.g. loop terminal) maps to
            # multiple shape points near the closure boundary.
            s_lat, s_lng = stop_coords[best_si]
            e_lat, e_lng = stop_coords[best_ei]
            start_idx = min(range(N), key=lambda i: distance_m(
                shape_coords[i][0], shape_coords[i][1], s_lat, s_lng))
            end_idx = min(range(N), key=lambda i: distance_m(
                shape_coords[i][0], shape_coords[i][1], e_lat, e_lng))

        # Always slice forward (the bus's travel direction)
        if start_idx <= end_idx:
            sliced = shape_coords[start_idx:end_idx + 1]
        else:
            sliced = shape_coords[start_idx:] + shape_coords[:end_idx + 1]
    elif start_idx <= end_idx:
        # Standard case: forward along shape
        sliced = shape_coords[start_idx:end_idx + 1]
    else:
        # start_idx > end_idx
        if is_loop:
            # Wrap around: start -> end of shape -> beginning of shape -> end index
            sliced = shape_coords[start_idx:] + shape_coords[:end_idx + 1]
        else:
            # Not a loop, so probably moving in reverse direction along the shape
            # Swap and reverse
            start_idx, end_idx = end_idx, start_idx
            sliced = shape_coords[start_idx:end_idx + 1]
            sliced = list(reversed(sliced))

    # Return at least 2 points for a valid polyline
    if len(sliced) < 2:
        return [(start_stop_lat, start_stop_lng), (end_stop_lat, end_stop_lng)]

    return sliced


def latlng_to_xy_m(lat: float, lng: float, ref_lat: float, ref_lng: float) -> tuple[float, float]:
    # Equirectangular approximation (good for small areas around Cambridge)
    r = 6371000.0
    x = math.radians(lng - ref_lng) * r * math.cos(math.radians(ref_lat))
    y = math.radians(lat - ref_lat) * r
    return x, y


def project_point_to_segment(px, py, ax, ay, bx, by):
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    denom = abx*abx + aby*aby
    if denom <= 0:
        return (ax, ay, 0.0)  # A==B segment
    t = (apx*abx + apy*aby) / denom
    t = max(0.0, min(1.0, t))
    cx = ax + t * abx
    cy = ay + t * aby
    return (cx, cy, t)


# Global cache for route geometries (prefix distances and XY coordinates)
ROUTE_GEOMETRY_CACHE = {}

def get_route_geometry(stops: list[dict]):
    """
    Returns prefix distances and XY coords for a stop sequence.
    Caches result to avoid redundant expensive math.
    """
    if not stops: return None
    # Key by stop IDs string
    sid_tuple = tuple(str(s.get("id") or s.get("stop_id")) for s in stops)
    if sid_tuple in ROUTE_GEOMETRY_CACHE:
        return ROUTE_GEOMETRY_CACHE[sid_tuple]

    pts = []
    for s in stops:
        lat = s.get("lat") or s.get("latitude")
        lng = s.get("lng") or s.get("longitude")
        if lat is None or lng is None: continue
        pts.append((float(lat), float(lng)))

    if len(pts) < 2: return None

    pts_loop = pts + [pts[0]]
    ref_lat, ref_lng = pts_loop[0]
    xy = [latlng_to_xy_m(lat, lng, ref_lat, ref_lng) for lat, lng in pts_loop]
    
    prefix = [0.0]
    for i in range(len(xy) - 1):
        ax, ay = xy[i]
        bx, by = xy[i+1]
        prefix.append(prefix[-1] + math.hypot(bx - ax, by - ay))

    data = {
        "xy": xy,
        "prefix": prefix,
        "ref": (ref_lat, ref_lng),
        "total_len": prefix[-1]
    }
    
    if len(ROUTE_GEOMETRY_CACHE) > 1000:
        ROUTE_GEOMETRY_CACHE.clear()
        
    ROUTE_GEOMETRY_CACHE[sid_tuple] = data
    return data


def distance_to_boarding_stop_along_chain_m(
    vehicle_lat: float,
    vehicle_lng: float,
    stops: list[dict],  # ordered route stops in travel order
    boarding_stop_id: str | int | None = None,
) -> tuple[float, int] | None:
    """
    Returns (distance_m, stops_ahead) along the stop-chain from the vehicle's
    snapped position forward to the boarding stop, assuming the route is a loop
    (cyclic). stops_ahead counts the stops the bus must serve on the way, which
    the ETA needs in order to charge dwell time.
    Falls back to None if insufficient data.
    """
    if not stops or len(stops) < 2:
        return None

    # 1) Rotate stops so boarding stop is index 0 if possible
    if boarding_stop_id is not None:
        idx = None
        for i, s in enumerate(stops):
            # match by id if present, else skip rotation
            if str(s.get("id")) == str(boarding_stop_id) or str(s.get("stop_id")) == str(boarding_stop_id):
                idx = i
                break
        if idx is not None:
            stops = stops[idx:] + stops[:idx]

    # 2) Build points; require lat/lng
    pts = []
    for s in stops:
        lat = s.get("lat") or s.get("latitude")
        lng = s.get("lng") or s.get("longitude")
        if lat is None or lng is None:
            continue
        pts.append((float(lat), float(lng)))

    if len(pts) < 2:
        return None

    # 3) Treat as cyclic loop by closing the polyline
    pts_loop = pts + [pts[0]]

    ref_lat, ref_lng = pts_loop[0]
    # Precompute XY for polyline points
    xy = [latlng_to_xy_m(lat, lng, ref_lat, ref_lng) for lat, lng in pts_loop]
    vx, vy = latlng_to_xy_m(vehicle_lat, vehicle_lng, ref_lat, ref_lng)

    # 4) Prefix distances along polyline
    seg_lens = []
    prefix = [0.0]
    for i in range(len(xy) - 1):
        ax, ay = xy[i]
        bx, by = xy[i+1]
        seg_len = math.hypot(bx - ax, by - ay)
        seg_lens.append(seg_len)
        prefix.append(prefix[-1] + seg_len)

    total_len = prefix[-1]
    if total_len <= 0:
        return None

    # 5) Find closest segment + projection fraction t
    best_d2 = float("inf")
    best_i = 0
    best_t = 0.0

    for i in range(len(xy) - 1):
        ax, ay = xy[i]
        bx, by = xy[i+1]
        cx, cy, t = project_point_to_segment(vx, vy, ax, ay, bx, by)
        d2 = (vx - cx)**2 + (vy - cy)**2
        if d2 < best_d2:
            best_d2 = d2
            best_i = i
            best_t = t

    # 6) Distance from boarding stop (index 0) to projected point along chain
    dist_from_boarding_to_proj = prefix[best_i] + best_t * seg_lens[best_i]

    # 7) Remaining distance forward along loop to reach boarding stop again
    remaining = total_len - dist_from_boarding_to_proj

    # Normalize small negatives due to float
    if remaining < 0:
        remaining = 0.0

    # 8) How many stops the bus still has to serve before ours. Distance alone
    # underestimates arrival time badly, because a bus spends real time stopped:
    # measured against the operator's own predictions, a pure distance/speed
    # model ran ~6 min optimistic and got worse the further away the bus was.
    # Every stop between the projection and the boarding stop sits at a prefix
    # beyond the projected position.
    stops_ahead = sum(1 for pd in prefix[1:-1] if pd > dist_from_boarding_to_proj)

    return remaining, stops_ahead






def stopdict(stop):
#takes list of stops and turns it into json data 
    return{
        "id": stop.id, 
        "name": stop.name,
        "lat": stop.latitude,
        "lng": stop.longitude,
    }

def vehicledict(vehicle, route_color=None):
    lat = getattr(vehicle, "latitude", None)
    lng = getattr(vehicle, "longitude", None)
    if(lat is not None and lng is not None):
        lat = float(lat)
        lng = float(lng)

    return {
        "id": vehicle.id,
        "route_id": getattr(vehicle, "routeId", None),
        "route_name": getattr(vehicle, "routeName", None),
        "lat": lat,
        "lng": lng,
        "heading": getattr(vehicle, "heading", None),
        "color": route_color,
    }



def find_nearest_stop(lat: float, lng: float, stops: list):
    ## find the stop closest to any given lat and lng. returns (stop, dist in meters)
    best_stop = None
    best_dist = float("inf")

    for s in stops:
        d = distance_m(lat, lng, s.latitude, s.longitude)
        if d < best_dist:
            best_dist = d 
            best_stop = s 
    return best_stop, best_dist

def match_stops(lat: float, lng:float, lat2: float, lng2: float, stops: list):
    originstop, origindist = find_nearest_stop(lat, lng, stops)
    deststop, destdist = find_nearest_stop(lat2, lng2, stops)
    base = {
        "origin": {
            "location": { "lat": lat, "lng": lng
            },
            "nearest_stop": stopdict(originstop),
            "distance_m": origindist,
        },
        "destination": {
            "location": { "lat": lat2, "lng": lng2 }, 
            "nearest_stop": stopdict(deststop),
            "distance_m": destdist,

            }



        }
    return base, originstop, deststop


STOPS_TTL = 60 * 10  # 10 minutes

@app.get("/stops", dependencies=[Depends(OptionalRateLimiter(times=30, seconds=60))])
def list_stops(system_id: int = DEFAULT_SYSTEM_ID):
    cache_key = f"api:stops:{system_id}"

    if redis_client is not None:
        try:
            cached = redis_client.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.warning("Redis error reading stops cache", exc_info=e)

    stops = get_stops(system_id)
    data = [stopdict(s) for s in stops]

    if redis_client is not None:
        try:
            redis_client.setex(cache_key, STOPS_TTL, json.dumps(data))
        except Exception as e:
            logger.warning("Redis error writing stops cache", exc_info=e)

    return data

@app.get("/systems")
def list_systems():
    systems = get_all_systems()
    # Sort by name, default to empty string if None
    systems_sorted = sorted(systems, key=lambda s: (getattr(s, "name", "") or "").lower())
    
    return [
        {
            "id": s.id,
            "name": s.name,
            "username": getattr(s, "username", None),
            "homepage": getattr(s, "homepage", None),
        }
        for s in systems_sorted
    ]
 


def route_paths_for_system(system_id: int = DEFAULT_SYSTEM_ID) -> list[dict[str, Any]]:
    """
    Build ordered polyline paths for each route in the system based on stops.routesAndPositions.
    Returns a list of dicts with:
      - route_id
      - route_name
      - short_name
      - color
      - path: [{ lat, lng, stop_id, stop_name }, ...]
    """
    stops = get_stops(system_id)
    routes = get_routes(system_id)

    # Map route_id (myid) -> route object
    routes_by_id: dict[str, Any] = {}
    for r in routes:
        rid = getattr(r, "myid", None)
        if rid is not None:
            routes_by_id[str(rid)] = r

    # Build mapping: route_id -> list of (sequenceIndex, stop)
    route_to_points: dict[str, list[tuple[int, Any]]] = {}

    for s in stops:
        routes_and_positions = getattr(s, "routesAndPositions", {}) or {}
        # routes_and_positions is a dict: { routeId: [direction, sequenceIndex] }
        for rid, pos in routes_and_positions.items():
            # pos might be [direction, index] or just index; be defensive
            seq_index = None
            if isinstance(pos, (list, tuple)):
                if len(pos) >= 2:
                    seq_index = pos[1]
                elif len(pos) == 1:
                    seq_index = pos[0]
            else:
                seq_index = pos

            if seq_index is None:
                continue

            try:
                seq_index_int = int(seq_index)
            except (TypeError, ValueError):
                continue

            rid_str = str(rid)
            route_to_points.setdefault(rid_str, []).append((seq_index_int, s))

    result: list[dict[str, Any]] = []

    for rid, seq_stops in route_to_points.items():
        route_obj = routes_by_id.get(rid)
        if not route_obj:
            continue

        # Sort by sequence index
        seq_stops_sorted = sorted(seq_stops, key=lambda x: x[0])

        path: list[dict[str, Any]] = []
        for _, s in seq_stops_sorted:
            lat = getattr(s, "latitude", None)
            lng = getattr(s, "longitude", None)
            if lat is None or lng is None:
                continue
            path.append({
                "lat": float(lat),
                "lng": float(lng),
                "stop_id": s.id,
                "stop_name": s.name,
            })

        if not path:
            continue

        color = getattr(route_obj, "groupColor", None) or getattr(route_obj, "color", None)
        if color and not color.startswith("#"):
            color = f"#{color}"

        result.append({
            "route_id": rid,
            "route_name": route_obj.name,
            "short_name": getattr(route_obj, "shortName", None),
            "color": color,
            "path": path,
        })

    # Upgrade the stop-to-stop path to the operator's real street geometry.
    # Without this a route draws as straight lines between stops.
    for r_entry in result:
        rid = r_entry.get("route_id")
        shape = get_shape_for_route(rid) if rid else None
        if not shape and r_entry.get("route_name"):
            resolved = get_route_id_by_name(r_entry["route_name"])
            shape = get_shape_for_route(resolved) if resolved else None
        if shape:
            # Empty stop_id/stop_name: these are shape vertices, not stops.
            r_entry["path"] = [
                {"lat": lat, "lng": lon, "stop_id": "", "stop_name": ""}
                for lat, lon in shape
            ]

    return result


@app.get("/route_paths")
def list_route_paths(system_id: int = DEFAULT_SYSTEM_ID):
    """
    Return ordered polyline paths for all routes in a system, based on stops.routesAndPositions.
    """
    return route_paths_for_system(system_id)


VEHICLES_TTL = 2  # seconds

@app.get("/vehicles", dependencies=[Depends(OptionalRateLimiter(times=60, seconds=60))])
def list_vehicles(system_id: int = DEFAULT_SYSTEM_ID):
    cache_key = f"api:vehicles:{system_id}"

    if redis_client is not None:
        try:
            cached = redis_client.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.warning("Redis error reading vehicles cache", exc_info=e)

    vehicles = get_vehicles(system_id)
    routes = get_routes(system_id)

    # Map route.myid -> color string
    route_colors = {}
    for r in routes:
        rid = getattr(r, "myid", None)
        if rid is not None:
            # Prefer groupColor, fallback to color
            color = getattr(r, "groupColor", None) or getattr(r, "color", None)
            if color:
                # Ensure color starts with #
                if not color.startswith("#"):
                    color = f"#{color}"
                route_colors[str(rid)] = color

    data = [vehicledict(v, route_colors.get(str(getattr(v, "routeId", None)))) for v in vehicles]

    if redis_client is not None:
        try:
            redis_client.setex(cache_key, VEHICLES_TTL, json.dumps(data))
        except Exception as e:
            logger.warning("Redis error writing vehicles cache", exc_info=e)

    return data


@app.get("/nearest_stop")
def api_nearest_stop(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    system_id: int = DEFAULT_SYSTEM_ID,
):
    if system_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid system_id")

    ##given any lat and lng, return the closest shuttle stop and its dist in meters 
    stops = get_stops(system_id)
    stop, dist = find_nearest_stop(lat, lng, stops)
    if not stop:
        raise HTTPException(
            status_code=404,
            detail="No nearby shuttle stops found for this location",
        )
    return {
        "stop": stopdict(stop),
        "distance_m": dist, 
    }

@app.get("/match_stops")
def api_match_stops(lat: float, lng: float, lat2: float, lng2: float, system_id: int = DEFAULT_SYSTEM_ID):
    stops = get_stops(system_id)
    base, _, _ = match_stops(lat, lng, lat2, lng2, stops)
    return base 



def build_trip_indexes(stops, routes, vehicles):
    """
    Build reusable indexes for the /trip request.
    """
    stops_by_id = {str(s.id): s for s in stops}
    routes_by_id = {str(r.myid): r for r in routes if hasattr(r, "myid")}
    
    # Map stop_id -> set of route_ids
    routes_by_stop = defaultdict(set)
    for s in stops:
        sid = str(s.id)
        rap = getattr(s, "routesAndPositions", {}) or {}
        for rid in rap.keys():
            routes_by_stop[sid].add(str(rid))
            
    # Map route_id -> list of vehicles
    route_to_vehicles = defaultdict(list)
    for v in vehicles:
        for rk in get_vehicle_route_keys(v):
            route_to_vehicles[rk].append(v)
            
    # Map route_name -> list of vehicles (for fuzzy matching)
    name_to_vehicles = defaultdict(list)
    rid_to_name = {norm_id(r.myid): r.name for r in routes if hasattr(r, "myid") and r.myid}
    for v in vehicles:
        for rk in get_vehicle_route_keys(v):
            rname = rid_to_name.get(rk)
            if rname:
                name_to_vehicles[rname.lower()].append(v)
                
    return {
        "stops_by_id": stops_by_id,
        "routes_by_id": routes_by_id,
        "routes_by_stop": routes_by_stop,
        "route_to_vehicles": route_to_vehicles,
        "name_to_vehicles": name_to_vehicles,
        "rid_to_name": rid_to_name,
        "all_vehicles": vehicles,
        "next_bus_cache": {} # Request-level cache for enrichment
    }


def find_common_routes(origin_stop, dest_stop, routes_by_id: dict):
    # This now just filters the routes using set intersection on IDs
    origin_routes = getattr(origin_stop, "routesAndPositions", {}) or {}
    dest_routes = getattr(dest_stop, "routesAndPositions", {}) or {}

    common_route_ids = set(origin_routes.keys()) & set(dest_routes.keys()) 
        
    result = []
    for rid in common_route_ids:
        route = routes_by_id.get(str(rid))
        if route:
            # Use groupColor first, fallback to color, normalize with # prefix
            color = getattr(route, "groupColor", None) or getattr(route, "color", None)
            if color and not color.startswith("#"):
                color = f"#{color}"
            result.append({
                "route_id": rid,
                "route_name": route.name,
                "short_name": getattr(route, "shortName", None),
                "color": color,
            })
    return result


NEAR_STOP_METERS = 30

def enrich_routes_with_next_bus(routes, origin_stop, vehicle_indexes, system_id: int = DEFAULT_SYSTEM_ID, debug: bool = False):
    route_to_vehicles = vehicle_indexes["route_to_vehicles"]
    name_to_vehicles = vehicle_indexes["name_to_vehicles"]
    rid_to_name = vehicle_indexes["rid_to_name"]
    vehicles = vehicle_indexes.get("all_vehicles", [])

    result = [] 
    next_bus_cache = vehicle_indexes.get("next_bus_cache", {})

    for route in routes:
        seg_id = route.get("route_id")
        seg_key = norm_id(seg_id)
        
        start_stop = route.get("start_stop", {})
        boarding_stop_id = str(start_stop.get("id") or start_stop.get("stop_id") or "")
        
        # Request-level cache check
        cache_key = (seg_key, boarding_stop_id)
        if cache_key in next_bus_cache:
            r = dict(route)
            r["next_bus"] = next_bus_cache[cache_key]
            result.append(r)
            continue

        candidates = list(route_to_vehicles.get(seg_key, [])) if seg_key else []
        
        match_mode = "exact"
        # Fuzzy fallback: if no exact vehicles, look for vehicles on routes with the same name
        if not candidates and seg_key:
            seg_name = route.get("route_name") or rid_to_name.get(seg_key)
            if seg_name:
                candidates = name_to_vehicles.get(seg_name.lower(), [])
                if candidates:
                    match_mode = "fuzzy_name"

        # Enhanced debug info for ALL system vehicles (for tracing)
        debug_candidates = []
        if debug:
            for v in vehicles:
                vk = get_vehicle_route_keys(v)
                debug_candidates.append({
                    "id": getattr(v, "id", None),
                    "keys": vk,
                    "is_exact": seg_key in vk
                })

        best_dist = float("inf")
        best_vehicle = None
        best_stops_ahead = 0
        
        # leg_stops: boarding→destination only (for ride ETA and display)
        # projection_stops: full sorted route loop (for along-chain vehicle distance)
        stops = route.get("stops") or []
        projection_stops = route.get("full_route_stops") or stops
        start_stop = route.get("start_stop", {})
        boarding_stop_id = start_stop.get("id") or start_stop.get("stop_id")

        for vehicle in candidates:
            v_lat = getattr(vehicle, "latitude", None)
            v_lng = getattr(vehicle, "longitude", None)
            if v_lat is None or v_lng is None:
                continue

            v_lat, v_lng = float(v_lat), float(v_lng)

            # Near-stop override: if bus is physically at the stop (within 30m),
            # treat distance as 0 to avoid snapping past the stop.
            straight_dist = distance_m(origin_stop.latitude, origin_stop.longitude, v_lat, v_lng)

            if straight_dist <= NEAR_STOP_METERS:
                along_dist, stops_ahead = 0.0, 0
            else:
                projected = distance_to_boarding_stop_along_chain_m(
                    vehicle_lat=v_lat,
                    vehicle_lng=v_lng,
                    stops=projection_stops,
                    boarding_stop_id=boarding_stop_id,
                )
                along_dist, stops_ahead = projected if projected is not None else (None, 0)

                # Prefer distance measured along the route's real geometry. The
                # stop chain above sums straight lines between stops and so
                # understates how far the bus drives, which made ETAs optimistic
                # by a margin that grew with distance. The chain is still what
                # supplies stops_ahead, and still the fallback when a route has
                # no usable geometry.
                road_dist = distance_along_route_m(
                    seg_id, v_lat, v_lng, origin_stop.latitude, origin_stop.longitude
                )
                if road_dist is not None:
                    along_dist = road_dist

            curr_dist = along_dist if along_dist is not None else straight_dist

            if curr_dist < best_dist:
                best_vehicle = vehicle
                best_dist = curr_dist
                best_stops_ahead = stops_ahead

        if best_vehicle is None:
            r = dict(route)
            r["next_bus"] = None
            if debug:
                r["debug_next_bus"] = {
                    "route_key": seg_key,
                    "match_mode": match_mode,
                    "candidates_count": len(candidates),
                    "reason": "no_best_vehicle",
                    "boarding_stop": {"id": boarding_stop_id, "lat": origin_stop.latitude, "lng": origin_stop.longitude},
                    "system_vehicles": debug_candidates[:10] # sample
                }
            result.append(r)
            continue 

        # We have a best_vehicle. Calculate smoothed speed.
        key = (system_id, best_vehicle.id)
        prev_states = VEHICLE_STATE.get(key, [])
        v_lat_raw = getattr(best_vehicle, "latitude", None)
        v_lng_raw = getattr(best_vehicle, "longitude", None)
        if v_lat_raw is None or v_lng_raw is None:
            route["next_bus"] = None
            result.append(route)
            continue
        v_lat = float(v_lat_raw)
        v_lng = float(v_lng_raw)

        prev_states.append({"lat": v_lat, "lng": v_lng, "t": datetime.now()})
        if len(prev_states) > 4:
            prev_states = prev_states[-4:]
        VEHICLE_STATE[key] = prev_states
        # Evict stale entries to prevent unbounded growth (retired/rotated vehicle IDs)
        if len(VEHICLE_STATE) > 500:
            VEHICLE_STATE.clear()

        speed_ms = None
        if len(prev_states) >= 2:
            total_dist = 0.0 
            total_dt = 0.0 
            for i in range(len(prev_states) - 1):
                p1 = prev_states[i] 
                p2 = prev_states[i+1] 
                dt = (p2["t"] - p1["t"]).total_seconds()
                d = distance_m(p1["lat"], p1["lng"], p2["lat"], p2["lng"])
                # Sanity check for speed: 1 m/s to 20 m/s (~45 mph)
                if dt > 0.1 and 1 <= (d/dt) <= 20: 
                    total_dist += d
                    total_dt += dt
            if total_dt > 0:
                # Straight-line displacement underestimates along-route speed on curves.
                # Apply tortuosity correction so ETA is consistent with along-chain distance.
                speed_ms = (total_dist / total_dt) * SPEED_TORTUOSITY_CORRECTION

        speed_source = "cache"
        if speed_ms is None or not math.isfinite(speed_ms) or speed_ms < MIN_SPEED_MS_FOR_ETA:
            speed_ms = FALLBACK_SPEED_MS
            speed_source = "fallback"

        # ETA to the boarding stop.
        #
        # Preferred: sum the measured travel time of each hop the bus still has
        # to make. Those durations come from arrivals we observed ourselves, so
        # they already contain this route's lights, turns and dwell — none of
        # which a speed constant can represent, and all of which are why a
        # distance model is systematically wrong in ways that vary by segment.
        #
        # Fallback: distance over speed, plus dwell per intervening stop. Used
        # until a segment has been travelled a few times, so a route works from
        # the first request and improves as history accumulates.
        eta_to_boarding_stop_s = None
        eta_source = None
        learned_fraction = None

        learned = None
        if best_dist is not None and best_dist > 0:
            try:
                learned = learned_eta_to_stop(
                    route_id=str(seg_id),
                    vehicle_lat=v_lat,
                    vehicle_lng=v_lng,
                    target_stop_id=str(boarding_stop_id),
                    fallback_speed_ms=speed_ms,
                    dwell_s=DWELL_S_PER_STOP,
                )
            except Exception as e:
                # A modelling failure must never cost the rider an ETA.
                logger.warning("Learned ETA failed; using distance model",
                               exc_info=e, extra={"route": seg_id})

        # Require most of the journey to be covered by measured segments before
        # trusting it. A mostly-fallback "learned" estimate is just the distance
        # model wearing a better name, and reporting it as learned would make
        # the scoreboard flatter.
        if learned is not None and learned.learned_fraction >= 0.6:
            eta_to_boarding_stop_s = learned.seconds
            eta_source = "learned_segments"
            learned_fraction = learned.learned_fraction
        elif best_dist is not None and speed_ms > 0:
            eta_to_boarding_stop_s = (
                best_dist / speed_ms + best_stops_ahead * DWELL_S_PER_STOP
            )
            eta_source = "distance_model"
            learned_fraction = learned.learned_fraction if learned else 0.0

        # Calculate Segment Ride ETA
        ride_eta_s = None
        segment_eta_s = None
        leg_stops = route.get("stops", [])
        if leg_stops and len(leg_stops) >= 2 and speed_ms > 0:
            seg_dist = 0.0
            for i in range(len(leg_stops) - 1):
                s1 = leg_stops[i]
                s2 = leg_stops[i+1]
                dm = distance_m(s1["lat" if "lat" in s1 else "latitude"], s1["lng" if "lng" in s1 else "longitude"], 
                                s2["lat" if "lat" in s2 else "latitude"], s2["lng" if "lng" in s2 else "longitude"])
                seg_dist += dm
            
            # seg_dist is a sum of straight-line hop distances. speed_ms has already been
            # inflated by SPEED_TORTUOSITY_CORRECTION to approximate along-route speed.
            # Dividing straight-line distance by inflated speed made ride ETAs ~20% too short.
            # Apply the same tortuosity factor to seg_dist so both sides use along-route units.
            # Dwell applies to the ride too: every stop between boarding and
            # destination costs the same stopped time, minus the final one,
            # where arrival is what we are timing.
            ride_dwell_s = max(0, len(leg_stops) - 2) * DWELL_S_PER_STOP
            ride_eta_s = (seg_dist * SPEED_TORTUOSITY_CORRECTION) / speed_ms + ride_dwell_s
            if eta_to_boarding_stop_s is not None:
                segment_eta_s = eta_to_boarding_stop_s + ride_eta_s

        # Show the operator's prediction for this stop and route when they have
        # one. They are simply more accurate — 0.44 min mean absolute error
        # against our 3.63 over 76 paired samples — because they know the
        # assigned run, the scheduled departure and whether a driver is holding,
        # none of which is inferable from position alone. Ours is kept alongside
        # it so the two stay comparable, and is what gets shown wherever they
        # have no prediction.
        operator_eta_s = None
        try:
            for e in get_platform_etas(str(boarding_stop_id)):
                if norm_id(e.route_id) == seg_key:
                    candidate_s = float(e.eta_minutes) * 60.0
                    if operator_eta_s is None or candidate_s < operator_eta_s:
                        operator_eta_s = candidate_s
        except Exception as exc:
            # Their feed being down must not cost the rider an ETA; ours stands.
            logger.warning("Operator ETA lookup failed; using our estimate",
                           exc_info=exc, extra={"stop": boarding_stop_id})

        own_eta_s = eta_to_boarding_stop_s
        if operator_eta_s is not None:
            eta_to_boarding_stop_s = operator_eta_s
            eta_source = "operator"
            if ride_eta_s is not None:
                segment_eta_s = eta_to_boarding_stop_s + ride_eta_s

        r = dict(route)
        r["next_bus"] = {
            "vehicle_id": best_vehicle.id,
            "lat": v_lat,
            "lng": v_lng,
            "distance_to_boarding_stop_m": best_dist,
            "stops_ahead": best_stops_ahead,
            "eta_source": eta_source,
            # Our own estimate, kept whichever one is being shown, so the
            # accuracy tooling can score them against observed arrivals.
            "own_eta_s": own_eta_s,
            "learned_fraction": learned_fraction,
            "eta_to_origin_stop": eta_to_boarding_stop_s,   # legacy name
            "eta_to_boarding_stop_s": eta_to_boarding_stop_s,
            "ride_eta_s": ride_eta_s,
            "segment_eta_s": segment_eta_s,
            "speed_source": speed_source
        }
        
        # Populate request-level cache
        if seg_key and boarding_stop_id:
            next_bus_cache[cache_key] = r["next_bus"]
        
        if debug:
            r["debug_next_bus"] = {
                "route_key": seg_key,
                "candidates_count": len(candidates),
                "speed_ms": speed_ms,
                "speed_source": speed_source,
                "distance_mode": "along_chain" if best_dist is not None else "straight",
                "reason": "ok",
                "boarding_stop": {"id": boarding_stop_id, "lat": origin_stop.latitude, "lng": origin_stop.longitude},
                "best_vehicle": {
                    "id": best_vehicle.id,
                    "v_keys": get_vehicle_route_keys(best_vehicle),
                    "dist": best_dist
                }
            }
            
        result.append(r)
    return result

def enrich_trip_skeleton(
    skeleton: TripSkeleton,
    user_origin_lat: float,
    user_origin_lng: float,
    user_dest_lat: float,
    user_dest_lng: float,
    vehicle_indexes: dict,
    system_id: int,
    debug: bool = False,
    route_stops_cache: dict | None = None,
    polyline_slice_cache: dict | None = None,
) -> dict:
    """
    Inflate a TripSkeleton into a full JSON response object with GTFS shapes and ETAs.
    Only called for the top candidates.
    """
    enriched_segments = []
    
    # Combined lookup: Global stops + Extra skeleton stops
    base_stops = vehicle_indexes.get("stops_by_id", {})
    extra_stops = skeleton.extra_stops_map or {}
    
    def get_stop(sid):
        if not sid: return None
        sid_str = str(sid)
        return extra_stops.get(sid_str) or base_stops.get(sid_str)
    
    for i, seg_skel in enumerate(skeleton.segments):
        start_stop = get_stop(seg_skel.start_stop_id)
        end_stop = get_stop(seg_skel.end_stop_id)
        
        if not start_stop or not end_stop:
             continue

        # Build full sorted route stop list first (sorted by routesAndPositions sequence).
        # This is the source of truth for travel order — used for both vehicle projection
        # and for slicing the leg stop list below.
        rid_str = str(seg_skel.route_id)
        rr = vehicle_indexes["routes_by_id"].get(rid_str)
        full_route_stops: list[dict] = []
        sorted_route_stop_objs: list = []

        if rr and hasattr(rr, "getStops"):
            _cache_key_full = str(seg_skel.route_id)
            if route_stops_cache is not None and _cache_key_full in route_stops_cache:
                all_route_stops = route_stops_cache[_cache_key_full] or []
            else:
                all_route_stops = rr.getStops() or []
                if route_stops_cache is not None:
                    route_stops_cache[_cache_key_full] = all_route_stops
            if all_route_stops:
                def _stop_seq(s, _rid=rid_str):
                    rap = getattr(s, "routesAndPositions", {}) or {}
                    positions = rap.get(_rid)
                    if isinstance(positions, (list, tuple)) and positions:
                        return min(int(p) for p in positions)
                    try:
                        return int(positions)
                    except (TypeError, ValueError):
                        return 9999
                sorted_route_stop_objs = sorted(all_route_stops, key=_stop_seq)
                full_route_stops = [stopdict(s) for s in sorted_route_stop_objs]

        # Reconstruct leg_stops (boarding→destination slice) from the already-sorted
        # stop objects. Previously this sliced unsorted PassioGO API order, which caused
        # wrong stops (e.g. Sever Gate in a Winthrop→SEC trip) and inflated ETAs.
        leg_stops = []
        if len(seg_skel.stops) <= 2 and sorted_route_stop_objs:
            start_id_str = str(seg_skel.start_stop_id)
            end_id_str = str(seg_skel.end_stop_id)

            start_indices = [i for i, s in enumerate(sorted_route_stop_objs) if str(s.id) == start_id_str]
            end_indices = [i for i, s in enumerate(sorted_route_stop_objs) if str(s.id) == end_id_str]

            best_slice = []
            min_len = float('inf')

            for s_idx in start_indices:
                for e_idx in end_indices:
                    if s_idx <= e_idx:
                        sub = sorted_route_stop_objs[s_idx : e_idx + 1]
                        if len(sub) < min_len:
                            min_len = len(sub)
                            best_slice = sub
                    else:
                        # Wrap-around case for loop routes
                        sub = sorted_route_stop_objs[s_idx:] + sorted_route_stop_objs[:e_idx + 1]
                        if len(sub) < min_len:
                            min_len = len(sub)
                            best_slice = sub

            if best_slice:
                leg_stops = [stopdict(s) for s in best_slice]

        # If hydration failed or wasn't needed, use skeleton stops
        if not leg_stops:
            for sid in seg_skel.stops:
                s_obj = get_stop(sid)
                if s_obj:
                    leg_stops.append(stopdict(s_obj))

        # If full_route_stops couldn't be built, fall back to leg_stops
        if not full_route_stops:
            full_route_stops = leg_stops

        # Build route payload for enrichment
        payload_route = {
            "route_id": seg_skel.route_id,
            "route_name": seg_skel.route_name,
            "short_name": seg_skel.short_name,
            "color": seg_skel.color,
            "stops": leg_stops,             # for display + ride ETA (leg only)
            "full_route_stops": full_route_stops,  # for vehicle projection (full loop)
            "start_stop": stopdict(start_stop),
            "end_stop": stopdict(end_stop)
        }
        
        # Calculate ETAs
        enriched_list = enrich_routes_with_next_bus(
            [payload_route], 
            start_stop, 
            vehicle_indexes, 
            system_id, 
            debug=debug
        )
        enriched_data = enriched_list[0] if enriched_list else payload_route
        
        # Slice the operator's route geometry down to this leg. Segment-aware,
        # because a route has several patterns and the widest one does not
        # always serve both endpoints of the leg.
        polyline = []
        route_id = str(seg_skel.route_id or "")
        shape = None
        shape_rid = None

        if route_id:
            shape = get_shape_for_segment(
                route_id, seg_skel.start_stop_id, seg_skel.end_stop_id
            )
            if shape:
                shape_rid = route_id

        if not shape and enriched_data.get("route_name"):
            shape_rid = get_route_id_by_name(enriched_data["route_name"])
            if shape_rid:
                shape = get_shape_for_segment(
                    shape_rid, seg_skel.start_stop_id, seg_skel.end_stop_id
                )

        if shape:
            slat = getattr(start_stop, 'latitude', None) or getattr(start_stop, 'lat', None)
            slng = getattr(start_stop, 'longitude', None) or getattr(start_stop, 'lng', None)
            elat = getattr(end_stop, 'latitude', None) or getattr(end_stop, 'lat', None)
            elng = getattr(end_stop, 'longitude', None) or getattr(end_stop, 'lng', None)

            # Stop sequence lets the slicer pick the right way round a loop.
            stop_coords = get_stop_coords_for_route(shape_rid) if shape_rid else None

            if slat is not None and slng is not None and elat is not None and elng is not None:
                _slice_key = (shape_rid, str(seg_skel.start_stop_id), str(seg_skel.end_stop_id))
                if polyline_slice_cache is not None and _slice_key in polyline_slice_cache:
                    sliced = polyline_slice_cache[_slice_key]
                else:
                    sliced = slice_shape_to_segment(
                        shape, float(slat), float(slng), float(elat), float(elng),
                        stop_coords=stop_coords,
                    )
                    if polyline_slice_cache is not None:
                        polyline_slice_cache[_slice_key] = sliced
                polyline = [{"lat": lat, "lng": lon} for lat, lon in sliced]
        
        # Build Final Segment
        final_seg = {
            "leg_index": i,
            "route_id": seg_skel.route_id,
            "route_name": enriched_data.get("route_name"),
            "short_name": enriched_data.get("short_name"),
            "color": enriched_data.get("color"),
            "start_stop": stopdict(start_stop),
            "end_stop": stopdict(end_stop),
            "dest_stop": stopdict(end_stop), # Used by frontend for stop count sometimes?
            "stops": leg_stops,
            "next_bus": enriched_data.get("next_bus"),
            "polyline": polyline
        }
        if debug:
             final_seg["debug_next_bus"] = enriched_data.get("debug_next_bus")
             
        enriched_segments.append(final_seg)
        
    # Calculate walk distances
    origin_walk = distance_m(user_origin_lat, user_origin_lng, skeleton.origin_stop.latitude, skeleton.origin_stop.longitude)
    dest_walk = distance_m(user_dest_lat, user_dest_lng, skeleton.dest_stop.latitude, skeleton.dest_stop.longitude)
    
    trip_dict = {
        "origin": {
            "location": {"lat": user_origin_lat, "lng": user_origin_lng},
            "nearest_stop": stopdict(skeleton.origin_stop),
            "distance_m": origin_walk,
        },
        "destination": {
            "location": {"lat": user_dest_lat, "lng": user_dest_lng},
            "nearest_stop": stopdict(skeleton.dest_stop),
            "distance_m": dest_walk,
        },
        "system_id": system_id,
        "segments": enriched_segments
    }
    
    return {
        "kind": skeleton.kind,
        "trip": trip_dict,
        "segments": enriched_segments,
        "has_live_bus": skeleton.has_live_vehicle,
        "num_transfers": skeleton.num_transfers,
        "total_walk_m": origin_walk + dest_walk,
    }

def build_route_graph(stops: list):
    stop_by_id = {} 
    routes_to_stops = defaultdict(list) 
    for s in stops:
        sid = str(s.id)
        stop_by_id[sid] = s 

        routes = getattr(s, "routesAndPositions", {}) 
        for rid, pos in routes.items():
            # pos is usually [seq_id] or [seq_id1, seq_id2]
            if isinstance(pos, (list, tuple)):
                for p_id in pos:
                    routes_to_stops[rid].append((sid, s, p_id))
            else:
                routes_to_stops[rid].append((sid, s, pos))
    graph = defaultdict(list)

    for rid, lst in routes_to_stops.items():
        lst_sorted = sorted(lst, key=lambda x:x[2])
        for i in range(len(lst_sorted) - 1):
            sid1, s1, _ = lst_sorted[i]
            sid2, s2, _ = lst_sorted[i+1]

            d = distance_m(s1.latitude, s1.longitude, s2.latitude, s2.longitude) 

            graph[sid1].append({"to": sid2, "route_id": rid, "distance_m": d})
            # removed undirected back-edge to preserve route directionality

    return graph, stop_by_id

def get_route_graph(system_id: int, stops: list):
    cached = ROUTE_GRAPH_CACHE.get(system_id)
    if cached is None:
        graph, stop_by_id = build_route_graph(stops)
        ROUTE_GRAPH_CACHE[system_id] = (graph, stop_by_id)
        return graph, stop_by_id
    return cached
##cache the graph 

def shortest_stop_path(graph, origin_stop_id: str, dest_stop_id: str):
    origin = str(origin_stop_id)
    dest = str(dest_stop_id)
    if origin == dest: 
        return [origin], []
    queue = deque([origin])
    visited = {origin}
    parent = {}

    while queue:
        curr = queue.popleft()
        for edge in graph.get(curr, []):
            next = edge["to"]
            rid = edge["route_id"]
            if next not in visited:
                visited.add(next)
                parent[next] = (curr, rid)
                if next == dest:
                    queue.append(next)
                    queue.clear()
                    break 
                queue.append(next) 
    if dest not in parent:
        return None, None
    
    edges_rev = [] 
    node = dest 
    while node != origin:
        prev, rid = parent[node]
        edges_rev.append((prev, node, rid))
        node = prev 

    edges = list(reversed(edges_rev))

    path_ids = [origin] + [to_id for (_, to_id, _) in edges]
    return path_ids, edges 


def find_k_paths(graph, origin, dest, k=1, max_depth=20, max_transfers=1):
    """
    Find up to K distinct paths from origin to dest using BFS.
    Each path is (nodes, edges).
    Deduplicated by (route_id sequence, stop_id sequence).
    """
    if origin == dest:
        return [([origin], [])]

    # queue of (current_node, nodes_list, edges_list, last_route_id, transfers_count)
    queue = deque([(origin, [origin], [], None, 0)])
    results = []
    seen_signatures = set()

    while queue and len(results) < k:
        curr, path_nodes, path_edges, last_rid, transfers = queue.popleft()
        
        if len(path_nodes) > max_depth + 1:
            continue

        for edge in graph.get(curr, []):
            nxt = edge["to"]
            rid = edge["route_id"]
            
            # Simple cycle prevention
            if nxt in path_nodes:
                continue
                
            new_transfers = transfers
            if last_rid is not None and rid != last_rid:
                new_transfers += 1
                
            if new_transfers > max_transfers:
                continue

            new_nodes = path_nodes + [nxt]
            new_edges = path_edges + [(curr, nxt, rid)]
            
            if nxt == dest:
                # Deduplicate by route/stop sequence
                sig = "-".join(str(e[2]) for e in new_edges) + ":" + "-".join(new_nodes)
                if sig not in seen_signatures:
                    results.append((new_nodes, new_edges))
                    seen_signatures.add(sig)
            else:
                queue.append((nxt, new_nodes, new_edges, rid, new_transfers))
                
    return results


def is_valid_eta(x):
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x) and x > 0


def get_path_metrics(segments):
    active = sum(1 for s in segments if s.get("next_bus") is not None)

    eta_vals = []
    for s in segments:
        nb = s.get("next_bus") or {}
        v = nb.get("segment_eta_s")
        if is_valid_eta(v):
            eta_vals.append(float(v))

    has_eta = len(eta_vals) > 0
    total_eta = sum(eta_vals) if has_eta else None

    transfers = max(0, len(segments) - 1)
    sig = "-".join(str(s.get("route_id") or "") for s in segments)

    return dict(
        active=active, 
        has_eta=has_eta, 
        total_eta=total_eta, 
        transfers=transfers, 
        n=len(segments), 
        sig=sig
    )


def path_sort_key(m):
    # Higher active first (negative active)
    # If tie and both have ETA: lower total ETA
    # If ETA missing: prioritize fewer transfers
    return (
        -m["active"],
        0 if m["has_eta"] else 1,                 # prefer paths with ETA when active ties
        m["total_eta"] if m["has_eta"] else float("inf"),
        m["transfers"],
        m["n"],
        m["sig"],
    )

def same_display_line(seg_a, seg_b):
    # if they match display name or short name 
    if seg_a.get("route_name") is None or seg_b.get("route_name") is None:
        return False

    if seg_a["route_name"] != seg_b["route_name"]:
        return False

    if seg_a.get("short_name") != seg_b.get("short_name"):
        return False  # handles None vs None so we chill 

    # 2)  end stop of A == start stop of B, checks for path continuity 
    if seg_a["end_stop"]["id"] != seg_b["start_stop"]["id"]:
        return False

    return True











def merge_segments_for_display(segments):
    if not segments:
        return segments

    merged = [segments[0]]

    for seg in segments[1:]:
        last = merged[-1]

        if same_display_line(last, seg):
            # extend last instead of adding a new one
            last["end_stop"] = seg["end_stop"]
            last["stops"].extend(seg["stops"][1:])  # avoid duplicating transfer stop
            # keep last["next_bus"] as-is
        else:
            merged.append(seg)

    return merged


def compress_path_by_route(path_stop_ids, edges, rid_to_canonical=None):
    segments = [] 
    if not edges:
        return segments 
    current_route = edges[0][2]
    segment_start_idx = 0 

    
    for edge_idx, (_, _, rid) in enumerate(edges):
        # Use canonical ID (like route name) to merge variants of the same line
        canon = rid_to_canonical.get(norm_id(rid), rid) if rid_to_canonical else rid
        
        if canon != (rid_to_canonical.get(norm_id(current_route), current_route) if rid_to_canonical else current_route):
            # finish the previous segment at the stop before this edge
            end_idx = edge_idx
            segments.append({
                "route_id": current_route,
                "start_stop_index": segment_start_idx,
                "end_stop_index": end_idx,
            })
            # start a new segment
            segment_start_idx = edge_idx
            current_route = rid

    # last segment goes to the final stop
    segments.append({
        "route_id": current_route,
        "start_stop_index": segment_start_idx,
        "end_stop_index": len(path_stop_ids) - 1,
    })

    return segments


def build_trip_segments(path_stop_ids, segments, stop_by_id, stops, routes_list, vehicle_indexes, system_id: int = DEFAULT_SYSTEM_ID, debug: bool = False):
    """
    Turn compressed segments into enriched trip segments:
    each with route info, start/end stop, list of stops on that leg, and next_bus.
    """
    trip_segments = []

    for seg in segments:
        route_id = seg["route_id"]
        start_idx = seg["start_stop_index"]
        end_idx = seg["end_stop_index"]

        start_stop_id = path_stop_ids[start_idx]
        end_stop_id = path_stop_ids[end_idx]

        start_stop = stop_by_id[start_stop_id]
        end_stop = stop_by_id[end_stop_id]

        # stops along this leg
        leg_stop_ids = path_stop_ids[start_idx:end_idx + 1]
        leg_stops = [stopdict(stop_by_id[sid]) for sid in leg_stop_ids]

        # get route metadata, next_bus using existing funcs
        candidate_routes = find_common_routes(start_stop, end_stop, vehicle_indexes["routes_by_id"])
        # find the route dict that matches this rid
        chosen_route = None
        for r in candidate_routes:
            if r["route_id"] == route_id:
                chosen_route = r
                break

        if chosen_route is None:
            # fallback, we know rid but not other info 
            chosen_route = {
                "route_id": route_id,
                "route_name": None,
                "short_name": None,
                "color": None,
            }

        # Attach stops for ETA calculation
        payload_route = dict(chosen_route)
        payload_route["stops"] = leg_stops

        enriched_list = enrich_routes_with_next_bus([payload_route], start_stop, vehicle_indexes, system_id, debug=debug)
        enriched_route = enriched_list[0] if enriched_list else payload_route

        trip_segments.append({
            "leg_index": segments.index(seg),
            "route_id": route_id,
            "route_name": enriched_route.get("route_name"),
            "short_name": enriched_route.get("short_name"),
            "color": enriched_route.get("color"),
            "start_stop": stopdict(start_stop),
            "end_stop": stopdict(end_stop),
            "dest_stop": stopdict(end_stop),
            "stops": leg_stops,
            "next_bus": enriched_route.get("next_bus"),
            "debug_next_bus": enriched_route.get("debug_next_bus") if debug else None,
        })

    return trip_segments










def build_direct_candidate(origin_stop, dest_stop, routes_list, vehicle_indexes, system_id: int):
    # 1. Find common routes
    routes = find_common_routes(origin_stop, dest_stop, vehicle_indexes["routes_by_id"])
    if not routes:
        return {"segments": None, "has_live_bus": False, "all_live": False}
        
    # 2. Enrich all of them to find the best functioning one
    #    We need to attach full stop lists for accurate ETA
    routes_by_id = vehicle_indexes["routes_by_id"]
    
    enrichable_routes = []
    for r in routes:
        rr = routes_by_id.get(str(r["route_id"]))
        r_copy = dict(r)
        if rr and hasattr(rr, 'getStops'):
             r_copy["stops"] = [stopdict(s) for s in rr.getStops()]
        enrichable_routes.append(r_copy)
        
    enriched_routes = enrich_routes_with_next_bus(enrichable_routes, origin_stop, vehicle_indexes, system_id)
    
    # 3. Classify live vs dead
    live = [r for r in enriched_routes if r.get("next_bus") and is_valid_eta(r["next_bus"].get("eta_to_origin_stop"))]
    
    has_live = len(live) > 0
    
    # 4. Choose best route
    if has_live:
        # Min ETA
        best = min(live, key=lambda x: x["next_bus"]["eta_to_origin_stop"])
    else:
        # Fallback: Just take the first one
        best = enriched_routes[0]
        
    # 5. Build segment
    #    For display, we'll just use [origin, dest] to avoid graph complexity for now.
    segment = {
        "route_id": best.get("route_id"),
        "route_name": best.get("route_name"),
        "short_name": best.get("short_name"),
        "color": best.get("color"),
        "start_stop": stopdict(origin_stop),
        "end_stop": stopdict(dest_stop),
        "stops": [stopdict(origin_stop), stopdict(dest_stop)], 
        "next_bus": best.get("next_bus"),
        "leg_index": 0
    }
    
    return {
        "segments": [segment],
        "has_live_bus": has_live,
        "all_live": has_live
    }


MAX_WALK_M = 800
MAX_NEARBY_STOPS = 8

def find_nearby_stops(lat: float, lng: float, stops: list) -> list[tuple[object, float]]:
    candidates = []
    
    for s in stops:
        d = distance_m(lat, lng, s.latitude, s.longitude)
        if d <= MAX_WALK_M:
            candidates.append((s, d))
            
    candidates.sort(key=lambda pair: pair[1])
    return candidates[:MAX_NEARBY_STOPS]


def plan_base_no_transfer_trip(
    origin_stop,
    dest_stop,
    user_origin_lat: float,
    user_origin_lng: float,
    user_dest_lat: float,
    user_dest_lng: float,
    routes_list: list,
    vehicle_indexes: dict,
    system_id: int,
    stops: list = None,
) -> list[TripSkeleton]:
    # The GTFS cross-check that used to run here is gone. It existed to catch
    # pairs that PassioGO's routesAndPositions omitted, by confirming them
    # against a second feed. There is no second feed now, and there is nothing
    # left to disagree with: stop-to-route membership and travel order both come
    # from the same Ride Systems response that supplies the geometry.
    routes = find_common_routes(origin_stop, dest_stop, vehicle_indexes["routes_by_id"])
    if not routes:
        return []

    candidates = []
    
    route_to_vehicles = vehicle_indexes.get("route_to_vehicles", {})
    
    origin_walk = distance_m(user_origin_lat, user_origin_lng, origin_stop.latitude, origin_stop.longitude)
    dest_walk = distance_m(user_dest_lat, user_dest_lng, dest_stop.latitude, dest_stop.longitude)
    total_walk = origin_walk + dest_walk
    
    for r in routes:
        rid = str(r["route_id"])
        
        # Check Live (Approximate O(1) check)
        # If any vehicles are on this route, we treat it as potentially live.
        # Enrichment will calculate actual ETA later.
        # route_to_vehicles is keyed by norm_id(), which lowercases. Passio route
        # ids were numeric so a raw lookup happened to work; Ride Systems ids are
        # letters ("AL"), and a raw lookup silently reports every route as dead,
        # which then costs it the 20000-point live bonus in scoring.
        has_live = bool(route_to_vehicles.get(norm_id(rid)))
        
        # Segment Skeleton
        # For No-Transfer, we pass [origin, dest] as stops, matching legacy behavior.
        # This keeps ride ETA approx. logic identical.
        seg = SegmentSkeleton(
            route_id=rid,
            start_stop_id=str(origin_stop.id),
            end_stop_id=str(dest_stop.id),
            route_name=r.get("route_name"),
            short_name=r.get("short_name"),
            color=r.get("color"),
            stops=[str(origin_stop.id), str(dest_stop.id)]
        )
        
        # Scoring
        base_score = 0 if has_live else 20000
        score = base_score + total_walk * 0.5 
        
        skel = TripSkeleton(
            segments=[seg],
            score=score,
            num_transfers=0,
            has_live_vehicle=has_live,
            kind="base_no_transfer",
            origin_stop=origin_stop,
            dest_stop=dest_stop,
            total_walk_m=total_walk
        )
        candidates.append(skel)
        
    return candidates

@dataclass
class PseudoStop:
    id: str
    name: str
    latitude: float
    longitude: float


def plan_base_transfer_trip(
    origin_stop,
    dest_stop,
    user_origin_lat: float,
    user_origin_lng: float,
    user_dest_lat: float,
    user_dest_lng: float,
    stops: list,
    routes_list: list,
    vehicle_indexes: dict,
    system_id: int,
    debug: bool = False
) -> list[TripSkeleton]:
    # Harvard used to be routed through a separate GTFS-graph planner here,
    # because PassioGO's stop sequences were not trustworthy enough to build a
    # graph from. Ride Systems' sequences are derived from the route geometry
    # itself (see ridesystems_client._ShapeIndex), so every system now uses the
    # one graph builder.
    graph, stop_by_id = get_route_graph(system_id, stops)
    origin_id = str(origin_stop.id)
    dest_id = str(dest_stop.id)

    # Limit to 1 transfer and max 20 stops for performance on campus systems
    path_candidates = find_k_paths(graph, origin_id, dest_id, k=1, max_depth=20, max_transfers=1)
    if not path_candidates:
        return []

    skeletons = []
    rid_to_name = vehicle_indexes["rid_to_name"]
    route_to_vehicles = vehicle_indexes["route_to_vehicles"]
    
    origin_walk = distance_m(user_origin_lat, user_origin_lng, origin_stop.latitude, origin_stop.longitude)
    dest_walk = distance_m(user_dest_lat, user_dest_lng, dest_stop.latitude, dest_stop.longitude)
    total_walk = origin_walk + dest_walk

    for nodes, edges in path_candidates:
        raw_segments = compress_path_by_route(nodes, edges, rid_to_canonical=rid_to_name)
        
        seg_skeletons = []
        has_live = False
        
        for rseg in raw_segments:
            r_id = rseg["route_id"]
            start_i = rseg["start_stop_index"]
            end_i = rseg["end_stop_index"]
            
            # Identify stops
            seg_nodes = nodes[start_i:end_i+1] # IDs
            start_stop = stop_by_id[seg_nodes[0]]
            end_stop = stop_by_id[seg_nodes[-1]]
            
            # Route info
            rr_list = find_common_routes(start_stop, end_stop, vehicle_indexes["routes_by_id"])
            # Match r_id
            chosen = next((r for r in rr_list if r["route_id"] == r_id), None)
            
            r_name = chosen["route_name"] if chosen else None
            short_name = chosen["short_name"] if chosen else None
            color = chosen["color"] if chosen else None
            
            # Live check (Approx). Normalized key, as above.
            if route_to_vehicles.get(norm_id(r_id)):
                has_live = True
                
            seg_skeletons.append(SegmentSkeleton(
                route_id=r_id,
                start_stop_id=str(start_stop.id),
                end_stop_id=str(end_stop.id),
                route_name=r_name,
                short_name=short_name,
                color=color,
                stops=seg_nodes
            ))
            
        # Score
        num_transfers = max(0, len(seg_skeletons) - 1)
        # Score: Live*0, Dead*10000 + transfers*500 + walk*0.5
        score = (0 if has_live else 10000) + (num_transfers * 10000) + (total_walk * 0.5)
        
        skel = TripSkeleton(
            segments=seg_skeletons,
            score=score,
            num_transfers=num_transfers,
            has_live_vehicle=has_live,
            kind="base_transfer",
            origin_stop=origin_stop,
            dest_stop=dest_stop,
            total_walk_m=total_walk
        )
        skeletons.append(skel)
        
    return skeletons


MAX_WALK_PAIRS = 20
MAX_WALK_TIME = 3.0  # seconds

def plan_walk_modified_trip(
    user_origin_lat: float,
    user_origin_lng: float,
    user_dest_lat: float,
    user_dest_lng: float,
    stops: list,
    routes_list: list,
    vehicle_indexes: dict,
    system_id: int,
    debug: bool = False
) -> list[TripSkeleton]:
    origin_candidates = find_nearby_stops(user_origin_lat, user_origin_lng, stops)
    dest_candidates = find_nearby_stops(user_dest_lat, user_dest_lng, stops)

    # Pre-generate all (origin, dest) pairs and sort by total walk distance.
    # Previously the nested loop iterated origin-first, so the 20-pair limit cut off
    # combinations from farther origin stops even if they had much shorter total walk.
    # Sorting ensures the best 20 pairs by total walk are always tried.
    # Also skip same-stop pairs (origin == dest stop) which produce nonsense self-loop trips.
    all_pairs = [
        (o_stop, o_dist, d_stop, d_dist)
        for o_stop, o_dist in origin_candidates
        for d_stop, d_dist in dest_candidates
        if str(o_stop.id) != str(d_stop.id)
    ]
    all_pairs.sort(key=lambda p: p[1] + p[3])

    skeletons = []
    pairs_tried = 0
    t0 = time.perf_counter()

    for o_stop, _o_dist, d_stop, _d_dist in all_pairs:
        if pairs_tried >= MAX_WALK_PAIRS:
            break
        if (time.perf_counter() - t0) > MAX_WALK_TIME:
            break

        pairs_tried += 1

        # 1. No Transfer — always preferred over transfer for a given stop pair
        cands_no_tx = plan_base_no_transfer_trip(
            o_stop, d_stop,
            user_origin_lat, user_origin_lng,
            user_dest_lat, user_dest_lng,
            routes_list, vehicle_indexes,
            system_id, stops=stops
        )
        for c in cands_no_tx:
            c.kind = "walk_modified"
            skeletons.append(c)

        # 2. Transfer — only if no direct route exists for this pair
        if not cands_no_tx:
            cands_tx = plan_base_transfer_trip(
                o_stop, d_stop,
                user_origin_lat, user_origin_lng,
                user_dest_lat, user_dest_lng,
                stops, routes_list, vehicle_indexes,
                system_id, debug
            )
            for c in cands_tx:
                c.kind = "walk_modified"
                skeletons.append(c)

    return skeletons


SHORT_SEGMENT_THRESHOLD_M = 300


def collapse_short_transit_segments(
    skeletons: list[TripSkeleton],
    user_origin_lat: float,
    user_origin_lng: float,
    user_dest_lat: float,
    user_dest_lng: float,
    vehicle_indexes: dict,
) -> list[TripSkeleton]:
    """Replace trivially walkable first/last transit segments with walk legs.

    For multi-segment trips, if the first or last segment covers less than
    SHORT_SEGMENT_THRESHOLD_M, remove it and turn that leg into a walk by
    adjusting the skeleton's origin/dest stop.
    """
    stops_by_id = vehicle_indexes["stops_by_id"]
    route_to_vehicles = vehicle_indexes.get("route_to_vehicles", {})
    result = []

    for skel in skeletons:
        if len(skel.segments) < 2:
            result.append(skel)
            continue

        modified = False

        # --- Check first segment ---
        first_seg = skel.segments[0]
        start_stop = stops_by_id.get(first_seg.start_stop_id) or skel.extra_stops_map.get(first_seg.start_stop_id)
        end_stop = stops_by_id.get(first_seg.end_stop_id) or skel.extra_stops_map.get(first_seg.end_stop_id)
        if start_stop and end_stop:
            seg_dist = distance_m(start_stop.latitude, start_stop.longitude,
                                  end_stop.latitude, end_stop.longitude)
            if seg_dist < SHORT_SEGMENT_THRESHOLD_M:
                skel.segments = skel.segments[1:]
                skel.origin_stop = end_stop
                skel.num_transfers = max(0, skel.num_transfers - 1)
                skel.kind = "walk_modified"
                modified = True

        # --- Check last segment (after potential first-segment removal) ---
        if len(skel.segments) >= 2:
            last_seg = skel.segments[-1]
            start_stop = stops_by_id.get(last_seg.start_stop_id) or skel.extra_stops_map.get(last_seg.start_stop_id)
            end_stop = stops_by_id.get(last_seg.end_stop_id) or skel.extra_stops_map.get(last_seg.end_stop_id)
            if start_stop and end_stop:
                seg_dist = distance_m(start_stop.latitude, start_stop.longitude,
                                      end_stop.latitude, end_stop.longitude)
                if seg_dist < SHORT_SEGMENT_THRESHOLD_M:
                    skel.segments = skel.segments[:-1]
                    skel.dest_stop = start_stop
                    skel.num_transfers = max(0, skel.num_transfers - 1)
                    skel.kind = "walk_modified"
                    modified = True

        # Skip skeletons with no segments left (entire trip is walkable)
        if not skel.segments:
            continue

        if modified:
            # Recalculate walk distance and score
            origin_walk = distance_m(user_origin_lat, user_origin_lng,
                                     skel.origin_stop.latitude, skel.origin_stop.longitude)
            dest_walk = distance_m(user_dest_lat, user_dest_lng,
                                   skel.dest_stop.latitude, skel.dest_stop.longitude)
            skel.total_walk_m = origin_walk + dest_walk

            has_live = any(
                bool(route_to_vehicles.get(norm_id(seg.route_id)))
                for seg in skel.segments
            )
            skel.has_live_vehicle = has_live

            if skel.num_transfers == 0:
                skel.score = (0 if has_live else 20000) + skel.total_walk_m * 0.5
            else:
                skel.score = (0 if has_live else 10000) + (skel.num_transfers * 10000) + (skel.total_walk_m * 0.5)

        result.append(skel)

    return result


def _dedup_skeletons(skeletons: list) -> list:
    """Deduplicate skeletons by route signature (same sequence of route_ids).
    Keeps the skeleton with the lowest score for each unique signature."""
    seen: dict = {}
    for skel in skeletons:
        sig = tuple(seg.route_id for seg in skel.segments)
        if sig not in seen or skel.score < seen[sig].score:
            seen[sig] = skel
    return list(seen.values())




@app.get("/trip", dependencies=[Depends(OptionalRateLimiter(times=20, seconds=60))])
def api_trip(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    lat2: float = Query(..., ge=-90, le=90),
    lng2: float = Query(..., ge=-180, le=180),
    system_id: int = DEFAULT_SYSTEM_ID,
    route_id: str | None = None,
    debug: bool = False,
    debug_paths: bool = False,
):
    """Plan a trip between two points.

    `route_id` restricts the answer to trips carried by that one route. It
    exists for "show me this bus's run", which is a different question from
    "get me there fastest": on a loop the far end of a run comes back near
    where it started, so the unrestricted planner correctly answers with a
    one-hop shortcut on some other route — and then the map draws a route the
    rider was not asking about. Falls back to the unrestricted result when the
    named route cannot make the trip.
    """
    if system_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid system_id")

    t0 = time.perf_counter()

    # 0. Check cache before any data fetches
    cache_key = (
        f"trip_v2:{system_id}:{round(lat,4)}:{round(lng,4)}"
        f":{round(lat2,4)}:{round(lng2,4)}:{route_id or '-'}"
    )
    if redis_client is not None:
        try:
            cached = redis_client.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.warning("Redis error reading trip cache", exc_info=e)

    # 1. Fetch data (stops + routes from in-process cache; vehicles always fresh)
    stops = get_stops_cached(system_id)
    routes_list = get_routes_cached(system_id)
    vehicles = get_vehicles(system_id)

    t_fetch = time.perf_counter()

    vehicle_indexes = build_trip_indexes(stops, routes_list, vehicles)
    t_idx = time.perf_counter()
    
    # Identify user origin/dest stops
    origin_stop, origin_dist = find_nearest_stop(lat, lng, stops)
    dest_stop, dest_dist = find_nearest_stop(lat2, lng2, stops)
    
    if not origin_stop or not dest_stop:
         raise HTTPException(404, "No nearby stops found for origin or destination")

    # ---------------------------------------------------------
    # Phase 1: Skeleton Search
    # ---------------------------------------------------------
    t_search_start = time.perf_counter()
    all_skeletons = []
    
    # 1. Base No Transfer
    s_nt = plan_base_no_transfer_trip(
        origin_stop, dest_stop, lat, lng, lat2, lng2,
        routes_list, vehicle_indexes, system_id, stops=stops
    )
    all_skeletons.extend(s_nt)

    # 2. Base Transfer — only run when no direct single-bus route exists.
    # On a campus shuttle, walking more is always preferred over transferring.
    if not s_nt:
        s_tx = plan_base_transfer_trip(
            origin_stop, dest_stop, lat, lng, lat2, lng2,
            stops, routes_list, vehicle_indexes, system_id, debug
        )
        all_skeletons.extend(s_tx)

    # 3. Walk Modified (Always try)
    s_wm = plan_walk_modified_trip(
        lat, lng, lat2, lng2,
        stops, routes_list, vehicle_indexes, system_id, debug
    )
    all_skeletons.extend(s_wm)
    
    if not all_skeletons:
        raise HTTPException(
            status_code=404,
            detail="No shuttle route with live tracking found.",
        )

    # Collapse trivially walkable first/last transit legs into walk segments
    all_skeletons = collapse_short_transit_segments(
        all_skeletons, lat, lng, lat2, lng2, vehicle_indexes
    )

    t_search_end = time.perf_counter()

    # ---------------------------------------------------------
    # Phase 2: Dedup, Rank & Prune
    # ---------------------------------------------------------
    all_skeletons = _dedup_skeletons(all_skeletons)
    all_skeletons.sort(key=lambda x: x.score)

    if route_id:
        on_route = [
            skel for skel in all_skeletons
            if skel.segments
            and all(norm_id(seg.route_id) == norm_id(route_id) for seg in skel.segments)
        ]
        if on_route:
            all_skeletons = on_route
        else:
            logger.info(
                "No trip on the requested route; answering unrestricted",
                extra={"route_id": route_id},
            )

    # Pick Top K (more than before to surface diverse options)
    K = 6
    top_skeletons = all_skeletons[:K]

    # ---------------------------------------------------------
    # Phase 3: Enrichment
    # ---------------------------------------------------------
    t_enrich_start = time.perf_counter()
    enriched_candidates = []
    _route_stops_cache: dict = {}    # shared across workers; GIL makes dict ops thread-safe
    _polyline_slice_cache: dict = {}  # keyed by (route_id, start_stop_id, end_stop_id)

    def _enrich_one(skel: TripSkeleton) -> dict | None:
        try:
            return enrich_trip_skeleton(
                skel, lat, lng, lat2, lng2,
                vehicle_indexes, system_id, debug,
                route_stops_cache=_route_stops_cache,
                polyline_slice_cache=_polyline_slice_cache,
            )
        except Exception as e:
            logger.error("Enrichment failed for skeleton", exc_info=e)
            return None

    with ThreadPoolExecutor(max_workers=min(len(top_skeletons), 4)) as pool:
        # Key futures by index to avoid TripSkeleton hashability issues (dataclass __hash__ = None)
        futures = {pool.submit(_enrich_one, skel): i for i, skel in enumerate(top_skeletons)}
        results: list[dict | None] = [None] * len(top_skeletons)
        for fut in as_completed(futures):
            idx = futures[fut]
            results[idx] = fut.result()

    # Preserve original skeleton order
    for result in results:
        if result is not None:
            enriched_candidates.append(result)

    if not enriched_candidates:
        raise HTTPException(404, "No enrichable trips found")

    t_enrich_end = time.perf_counter()

    # ---------------------------------------------------------
    # Phase 4: Filter + Sort candidates — live first, transfers always last
    # ---------------------------------------------------------
    # If any single-bus option exists (direct or walk-modified), suppress all
    # transfer routes entirely. On a campus shuttle, walk more > transfer always.
    has_single_bus = any(c["num_transfers"] == 0 for c in enriched_candidates)
    if has_single_bus:
        enriched_candidates = [c for c in enriched_candidates if c["num_transfers"] == 0]
    def _candidate_sort_key(c: dict) -> tuple:
        live = c["has_live_bus"]
        transfers = c["num_transfers"]
        kind = c["kind"]
        if live and transfers == 0 and kind == "base_no_transfer":
            cat = 1
        elif live and kind == "walk_modified":
            cat = 2
        elif live and transfers >= 1 and kind == "base_transfer":
            cat = 3
        elif not live and transfers == 0 and kind == "base_no_transfer":
            cat = 4
        elif not live and kind == "walk_modified":
            cat = 5
        elif not live and transfers >= 1 and kind == "base_transfer":
            cat = 6
        else:
            cat = 999
        # Tiebreaker: within the same category and walk distance, prefer lower ETA
        eta = float("inf")
        for seg in c.get("segments", []):
            nb = seg.get("next_bus") or {}
            v = nb.get("eta_to_boarding_stop_s")
            if v is not None and v < eta:
                eta = v
        return (cat, c["total_walk_m"], eta)

    enriched_candidates.sort(key=_candidate_sort_key)

    t_total = time.perf_counter() - t0

    # Build candidates list: each = trip data + metadata fields
    result_candidates = []
    for c in enriched_candidates:
        candidate = dict(c["trip"])
        candidate["is_live"] = c["has_live_bus"]
        candidate["kind"] = c["kind"]
        candidate["num_transfers"] = c["num_transfers"]
        candidate["total_walk_m"] = c["total_walk_m"]
        result_candidates.append(candidate)

    if debug_paths and result_candidates:
        result_candidates[0]["debug_selection"] = {
            "total_skeletons": len(all_skeletons),
            "enriched_count": len(enriched_candidates),
            "all_candidates": [
                {
                    "kind": c["kind"],
                    "live": c["has_live_bus"],
                    "transfers": c["num_transfers"],
                    "walk": c["total_walk_m"],
                }
                for c in enriched_candidates
            ],
            "timings": {
                "fetch": t_fetch - t0,
                "index": t_idx - t_fetch,
                "search": t_search_end - t_search_start,
                "enrich": t_enrich_end - t_enrich_start,
                "total": t_total,
            },
        }

    final_result = {"candidates": result_candidates}

    # Log timings
    logger.info(
        "TRIP timings system=%s total=%.3fs search=%.3fs enrich=%.3fs n_skel=%d n_enriched=%d n_candidates=%d",
        system_id, t_total,
        t_search_end - t_search_start,
        t_enrich_end - t_enrich_start,
        len(all_skeletons),
        len(enriched_candidates),
        len(result_candidates),
    )

    # Cache response
    if redis_client is not None:
        try:
            redis_client.setex(cache_key, 15, json.dumps(final_result))
        except Exception as e:
            logger.warning("Redis error writing trip cache", exc_info=e)

    return final_result


@app.get("/vehicles_raw")
def list_vehicles_raw(system_id: int = DEFAULT_SYSTEM_ID):
    vehicles = get_vehicles(system_id)
    # vars(v) turns the Python object into its __dict__ so you see real fields
    return [vars(v) for v in vehicles]


# ---------------------------------------------------------------------------
# Arrival predictions: ours vs the operator's
#
# Ride Systems publishes its own arrival predictions (PlatformET). We do not
# route on them. The projection engine above — snap the bus to the route chain,
# measure the remaining distance, divide by a smoothed speed — still produces
# every ETA the app shows.
#
# Keeping our own engine means its accuracy is measurable rather than assumed:
# the operator's number is an independent label for the same event, so the two
# can be compared continuously. eta_compare.py drives this endpoint to do that.
# ---------------------------------------------------------------------------

def estimate_arrivals_for_stop(stop_id: str, system_id: int = DEFAULT_SYSTEM_ID) -> list[dict]:
    """Our predicted arrival, per route serving this stop.

    Runs the same enrichment path /trip uses, so the numbers reported here are
    the numbers riders see rather than a parallel reimplementation.
    """
    stops = get_stops(system_id)
    stop = next((s for s in stops if str(s.id) == str(stop_id)), None)
    if stop is None:
        raise HTTPException(status_code=404, detail="Unknown stop")

    routes = get_routes_cached(system_id)
    vehicles = get_vehicles(system_id)
    vehicle_indexes = build_trip_indexes(stops, routes, vehicles)

    payload_routes = []
    for rid in (getattr(stop, "routesAndPositions", {}) or {}).keys():
        route = vehicle_indexes["routes_by_id"].get(str(rid))
        if route is None:
            continue

        # The full loop in travel order is what the vehicle gets projected onto.
        full_route_stops = []
        if hasattr(route, "getStops"):
            full_route_stops = [stopdict(s) for s in (route.getStops() or [])]

        color = getattr(route, "groupColor", None) or getattr(route, "color", None)
        payload_routes.append({
            "route_id": str(rid),
            "route_name": route.name,
            "short_name": getattr(route, "shortName", None),
            "color": color,
            # Boarding-only: we are predicting arrival at this stop, not a ride.
            "stops": [stopdict(stop)],
            "full_route_stops": full_route_stops,
            "start_stop": stopdict(stop),
            "end_stop": stopdict(stop),
        })

    enriched = enrich_routes_with_next_bus(
        payload_routes, stop, vehicle_indexes, system_id
    )

    out = []
    for r in enriched:
        nb = r.get("next_bus")
        if not nb or nb.get("eta_to_boarding_stop_s") is None:
            continue
        out.append({
            "route_id": r["route_id"],
            "route_name": r.get("route_name"),
            "eta_minutes": nb["eta_to_boarding_stop_s"] / 60.0,
            "distance_m": nb.get("distance_to_boarding_stop_m"),
            "stops_ahead": nb.get("stops_ahead"),
            "vehicle_id": nb.get("vehicle_id"),
            "speed_source": nb.get("speed_source"),
            "eta_source": nb.get("eta_source"),
            "learned_fraction": nb.get("learned_fraction"),
        })

    out.sort(key=lambda e: e["eta_minutes"])
    return out


@app.get("/stop_etas", dependencies=[Depends(OptionalRateLimiter(times=60, seconds=60))])
def api_stop_etas(stop_id: str, system_id: int = DEFAULT_SYSTEM_ID):
    """Our arrival predictions for a stop, alongside the operator's.

    `ours` drives the app. `vendor` is here for comparison only — see
    eta_compare.py, which samples this endpoint over time to score our engine
    against the operator's predictions.
    """
    stops = get_stops(system_id)
    stop = next((s for s in stops if str(s.id) == str(stop_id)), None)
    if stop is None:
        raise HTTPException(status_code=404, detail="Unknown stop")

    ours = estimate_arrivals_for_stop(stop_id, system_id)

    vendor = []
    try:
        for e in get_platform_etas(stop_id):
            vendor.append({
                "route_id": e.route_id,
                "route_name": e.route_name,
                "destination": e.destination,
                "eta_minutes": e.eta_minutes,
                "scheduled": e.scheduled,
            })
    except HTTPException:
        # The operator's predictions are a nice-to-have on this endpoint; ours
        # are the product. Never fail the request because theirs was down.
        logger.warning("Operator ETA fetch failed", extra={"stop_id": stop_id})

    return {
        "stop": stopdict(stop),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "ours": ours,
        "vendor": vendor,
    }


@app.get("/arrivals")
def api_arrivals(since: float | None = None, limit: int = 5000):
    """Arrivals we observed ourselves, as (route, stop, time) triples.

    This is the ground truth both predictors get scored against: not what
    anyone predicted, but when a bus was actually seen to reach a stop. Derived
    from the position stream by arrivals.py.
    """
    out = []
    for (route_id, stop_id), times in ARRIVAL_STORE.stop_arrivals.items():
        for t in times:
            if since is not None and t <= since:
                continue
            out.append({"t": t, "route_id": route_id, "stop_id": stop_id})

    out.sort(key=lambda a: a["t"])
    truncated = len(out) > limit
    return {
        "arrivals": out[-limit:],
        "count": min(len(out), limit),
        "truncated": truncated,
    }


@app.get("/eta_model")
def api_eta_model():
    """How much of the network the learned model actually covers.

    `segments_usable` is the number of stop-to-stop hops with enough observed
    traversals to predict from. Until that approaches `segments_seen`, most
    ETAs still come from the distance fallback, and the scoreboard will show
    the two sources separately.
    """
    coverage = ARRIVAL_STORE.coverage()
    return {
        **coverage,
        "min_observations_per_segment": arrivals_module.MIN_OBS_FOR_SEGMENT,
        "fallback_speed_ms": FALLBACK_SPEED_MS,
        "dwell_s_per_stop": DWELL_S_PER_STOP,
    }


# ---------------------------------------------------------------------------
# Next Bus Out
#
# The other half of the app answers "how do I get from A to B". This answers
# the question people actually ask most often on campus: "I am standing here,
# what is leaving and when". No inputs, no planning — location in, departures
# out.
#
# It covers stops within a short walk rather than only the single nearest one,
# because the nearest stop is frequently the wrong answer: a bus in 2 minutes
# from a stop 200 m away beats a bus in 14 minutes from the one you are
# standing at. Each departure carries the walk to its stop so that trade-off
# is visible instead of hidden.
# ---------------------------------------------------------------------------

# Beyond this, walking to a different stop stops being a reasonable suggestion
# for someone who just wants the next bus.
DEPARTURES_WALK_RADIUS_M = 500.0
DEPARTURES_MAX_STOPS = 4

# Typical walking pace, for deciding whether a departure is actually catchable.
WALK_SPEED_MS = 1.35


# How many downstream stops to report per departure. Enough to answer "does
# this bus go where I need", not the whole loop.
DEPARTURE_TO_STOPS = 8


def hop_estimate(route_id: str, prev_id: str, sid: str, stops_by_id: dict) -> tuple[float, str]:
    """Seconds for one stop-to-stop hop, and where the number came from.

    Learned segment time when the store has one, the distance model otherwise.
    Shared by the departure board and the arrival planner so a bus cannot be
    shown reaching the same stop at two different times on two screens.
    """
    learned = ARRIVAL_STORE.segment_estimate(route_id, prev_id, sid)
    if learned is not None:
        return learned[0], "learned"
    prev_stop = stops_by_id.get(prev_id)
    stop = stops_by_id.get(sid)
    hop_m = (
        distance_m(prev_stop.latitude, prev_stop.longitude,
                   stop.latitude, stop.longitude)
        if prev_stop and stop else 0.0
    )
    return hop_m / FALLBACK_SPEED_MS + DWELL_S_PER_STOP, "estimated"


def downstream_stops(route_id: str, boarding_stop_id: str, depart_in_min: float) -> list[dict]:
    """Where a bus goes after this stop, with a clock time for each.

    Answers the question a departure board leaves open: the route code and a
    headsign tell you nothing if you do not already know the route. Times are
    cumulative from the departure, using the learned segment times where they
    exist and the distance model where they do not — the same estimates the ETA
    itself is built from, so the numbers cannot disagree with each other.
    """
    chain = get_route_stop_ids(route_id)
    if not chain:
        return []

    try:
        start = chain.index(str(boarding_stop_id))
    except ValueError:
        return []

    stops_by_id = {str(s.id): s for s in get_stops(DEFAULT_SYSTEM_ID)}
    out: list[dict] = []
    cumulative_s = depart_in_min * 60.0
    prev_id = str(boarding_stop_id)

    # Wrap around the loop, stopping before we arrive back at the boarding stop.
    for step in range(1, min(len(chain), DEPARTURE_TO_STOPS + 1)):
        sid = chain[(start + step) % len(chain)]
        if sid == str(boarding_stop_id):
            break
        stop = stops_by_id.get(sid)
        if stop is None:
            continue

        hop_s, source = hop_estimate(route_id, prev_id, sid, stops_by_id)
        cumulative_s += hop_s
        out.append({
            **stopdict(stop),
            "minutes": cumulative_s / 60.0,
            "arrives_at": (datetime.now() + timedelta(seconds=cumulative_s)).strftime("%-I:%M"),
            "source": source,
        })
        prev_id = sid

    return out


def run_polyline(route_id: str, boarding_stop, to_stops: list[dict]) -> list[dict]:
    """The stretch a bus rides from the boarding stop through its onward stops.

    Built hop by hop — boarding stop to the first onward stop, that to the
    next, and so on — with the same slicer Plan Trip uses for a segment, then
    joined. Not sliced boarding-to-last in one go: on a loop the last onward
    stop can sit a hundred metres behind the boarding stop (XSEC ends at
    Kennedy School, round the corner from where you board it), and a single
    slice between those two points is a stub, not the run. Each hop is short
    and unambiguous, so the join is the whole loop the bus actually drives.
    """
    if not to_stops:
        return []
    stop_coords = get_stop_coords_for_route(route_id)
    pts: list[tuple[float, float]] = []
    prev_id, prev_lat, prev_lng = str(boarding_stop.id), float(boarding_stop.latitude), float(boarding_stop.longitude)
    for t in to_stops:
        shape = get_shape_for_segment(route_id, prev_id, str(t["id"]))
        hop = (
            slice_shape_to_segment(shape, prev_lat, prev_lng, float(t["lat"]), float(t["lng"]), stop_coords=stop_coords)
            if shape else [(prev_lat, prev_lng), (float(t["lat"]), float(t["lng"]))]
        )
        # Drop the join vertex so consecutive hops do not double a point.
        if pts and hop and pts[-1] == hop[0]:
            hop = hop[1:]
        pts.extend(hop)
        prev_id, prev_lat, prev_lng = str(t["id"]), float(t["lat"]), float(t["lng"])
    return [{"lat": lat, "lng": lng} for lat, lng in pts]


@app.get("/departures", dependencies=[Depends(OptionalRateLimiter(times=60, seconds=60))])
def api_departures(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    radius_m: float = Query(DEPARTURES_WALK_RADIUS_M, gt=0, le=2000),
    system_id: int = DEFAULT_SYSTEM_ID,
):
    """Departures from the stops within walking distance of a point.

    Sorted soonest first across all nearby stops. `catchable` is false when the
    walk to that stop takes longer than the bus will take to arrive — still
    listed, because a rider may prefer to know, but not presented as an option
    they can take.
    """
    stops = get_stops(system_id)
    if not stops:
        raise HTTPException(status_code=503, detail="No stops available")

    nearby = [
        (s, distance_m(lat, lng, s.latitude, s.longitude)) for s in stops
    ]
    nearby = [(s, d) for s, d in nearby if d <= radius_m]
    nearby.sort(key=lambda pair: pair[1])
    nearby = nearby[:DEPARTURES_MAX_STOPS]

    if not nearby:
        # Someone off campus. Report the closest stop anyway so the client can
        # say how far away it is rather than showing an empty screen.
        closest, dist = min(
            ((s, distance_m(lat, lng, s.latitude, s.longitude)) for s in stops),
            key=lambda pair: pair[1],
        )
        return {
            "location": {"lat": lat, "lng": lng},
            "nearest_stop": stopdict(closest),
            "nearest_stop_distance_m": dist,
            "out_of_range": True,
            "departures": [],
            "generated_at": datetime.now().isoformat(timespec="seconds"),
        }

    # The operator's per-stop predictions carry a destination headsign, which
    # our own projection has no equivalent for and which is what tells a rider
    # where a bus is actually going.
    departures = []
    for stop, walk_m in nearby:
        walk_s = walk_m / WALK_SPEED_MS

        vendor_by_route: dict[str, list] = defaultdict(list)
        try:
            for e in get_platform_etas(stop.id):
                vendor_by_route[e.route_id].append(e)
        except HTTPException:
            logger.warning("Operator ETAs unavailable for stop",
                           extra={"stop_id": stop.id})

        ours_by_route = {}
        try:
            for o in estimate_arrivals_for_stop(stop.id, system_id):
                ours_by_route[o["route_id"]] = o
        except HTTPException:
            pass

        for route_id in set(vendor_by_route) | set(ours_by_route):
            mine = ours_by_route.get(route_id)
            vendor_list = sorted(
                vendor_by_route.get(route_id, []), key=lambda e: e.eta_minutes
            )
            vendor = vendor_list[0] if vendor_list else None

            # Show the operator's prediction when they have one.
            #
            # They are simply better: measured against each other over 76
            # paired samples, theirs sat at 0.44 min mean absolute error and
            # ours at 3.63. That is not an algorithm gap — they know the
            # assigned run, the scheduled departure, whether a driver is
            # holding at a terminal, and they get telemetry we cannot see. A
            # rider wants the accurate number, not ours.
            #
            # Our own estimate still runs, and still fills in wherever they
            # have no prediction — a bus they are not predicting for is
            # exactly the case where an inferred ETA beats nothing at all.
            # eta_compare.py and eta_scoreboard.py keep scoring both.
            if vendor is not None:
                eta_min = float(vendor.eta_minutes)
                source = "operator"
            elif mine is not None:
                eta_min = mine["eta_minutes"]
                source = mine.get("eta_source") or "ours"
            else:
                continue

            route = next(
                (r for r in get_routes_cached(system_id) if str(r.myid) == str(route_id)),
                None,
            )
            color = None
            route_name = vendor.route_name if vendor else None
            if route is not None:
                color = getattr(route, "groupColor", None) or getattr(route, "color", None)
                route_name = route.name

            departures.append({
                "route_id": route_id,
                "route_name": route_name,
                "short_name": getattr(route, "shortName", None) if route else route_id,
                "color": color,
                "headsign": vendor.destination if vendor else None,
                "eta_minutes": eta_min,
                "eta_source": source,
                "stop": stopdict(stop),
                "walk_m": walk_m,
                "walk_minutes": walk_s / 60.0,
                # False when the bus will be gone before you could get there.
                "catchable": eta_min * 60.0 >= walk_s,
                # Where this bus takes you, so the row can answer "does it go
                # where I need" without a second request.
                "to_stops": (to_stops := downstream_stops(route_id, stop.id, eta_min)),
                # The geometry of that run, so the map can draw the stretch
                # this bus will ride the way Plan Trip draws a trip.
                "polyline": run_polyline(route_id, stop, to_stops),
                # Later buses on the same route, so the list can show a second
                # option without another request.
                "following_minutes": [float(e.eta_minutes) for e in vendor_list[1:3]],
            })

    departures.sort(key=lambda d: (not d["catchable"], d["eta_minutes"]))

    return {
        "location": {"lat": lat, "lng": lng},
        "nearest_stop": stopdict(nearby[0][0]),
        "nearest_stop_distance_m": nearby[0][1],
        "out_of_range": False,
        "stops_considered": len(nearby),
        "departures": departures,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------------------
# GET /arrival_plan
#
# The inverse of the departure board. Departures answer "what is leaving now";
# this answers "I have to be at Maxwell Dworkin at 3:00 — which bus, from which
# stop, and when do I need to be standing there". The input is the text a
# calendar event carries, not a coordinate, because that is what a rider has.
# ---------------------------------------------------------------------------

# Standing at the stop this long before the bus is due absorbs the operator's
# ETA rounding (whole minutes) and a bus that runs a little early.
ARRIVAL_PLAN_STOP_BUFFER_S = 120.0

# Planning a loop: this many hops is more than any Harvard route has stops, so
# the search always either reaches the destination or wraps back to the start.
ARRIVAL_PLAN_MAX_HOPS = 40

# How far ahead the operator's live ETAs are worth anything. Past this the
# planner falls back to Harvard's published headways (harvard_schedule.py).
ARRIVAL_PLAN_LIVE_HORIZON_MIN = 45


def resolve_location(query: str, system_id: int = DEFAULT_SYSTEM_ID):
    """Free text -> (stops, resolved_name, confidence, place_latlng).

    Gazetteer first, fuzzy stop names second. Returns every stop the gazetteer
    lists for the place so the planner can alight at whichever side of a
    paired stop a route actually serves; the first is the preferred one.
    `place_latlng` is None when we only matched a stop name, since then the
    stop is the best position we have.
    """
    stops = get_stops(system_id)
    by_id = {str(s.id): s for s in stops}

    hit = match_place(query)
    if hit is not None:
        name, conf = hit
        lat, lng, ids = PLACES[name]
        found = [by_id[i] for i in ids if i in by_id]
        if found:
            return found, name, round(conf, 3), (lat, lng)

    hit = match_stop_name(query, [s.name for s in stops])
    if hit is not None:
        name, conf = hit
        stop = next(s for s in stops if s.name == name)
        return [stop], name, round(conf, 3), None

    return [], query, 0.0, None


def _departures_from_stop(stop, system_id: int) -> dict[str, list[tuple[float, str, str | None]]]:
    """Upcoming departures per route as (minutes, eta_source, route_name).

    The same preference order /departures uses — operator predictions when
    they exist (every trip they list, not only the first), our own projection
    where they have none — so the planner's departure clock is the one the
    departure board already shows.
    """
    out: dict[str, list[tuple[float, str, str | None]]] = defaultdict(list)
    try:
        for e in get_platform_etas(stop.id):
            out[e.route_id].append((float(e.eta_minutes), "operator", e.route_name))
    except HTTPException:
        logger.warning("Operator ETAs unavailable for stop", extra={"stop_id": stop.id})

    try:
        for o in estimate_arrivals_for_stop(stop.id, system_id):
            if out.get(o["route_id"]):
                continue
            src = "learned" if (o.get("eta_source") or "").startswith("learned") else "estimated"
            out[o["route_id"]].append((o["eta_minutes"], src, o.get("route_name")))
    except HTTPException:
        pass
    return out


def ride_to_first_of(route_id: str, board_stop_id: str, alight_ids: set[str], stops_by_id: dict):
    """Ride time from a stop to whichever of `alight_ids` the route reaches first.

    Returns (seconds, alight_stop_id) or None when the route never gets there
    before looping back to the boarding stop.
    """
    chain = get_route_stop_ids(route_id)
    if not chain or str(board_stop_id) not in chain:
        return None
    start = chain.index(str(board_stop_id))
    total_s = 0.0
    prev_id = str(board_stop_id)
    for step in range(1, min(len(chain), ARRIVAL_PLAN_MAX_HOPS) + 1):
        sid = chain[(start + step) % len(chain)]
        if sid == str(board_stop_id):
            return None
        hop_s, _source = hop_estimate(route_id, prev_id, sid, stops_by_id)
        total_s += hop_s
        if sid in alight_ids:
            return total_s, sid
        prev_id = sid
    return None


def plan_arrival(
    dest: str,
    arrive_by: datetime,
    lat: float | None = None,
    lng: float | None = None,
    origin_stop_id: str | None = None,
    system_id: int = DEFAULT_SYSTEM_ID,
) -> dict:
    """The work behind /arrival_plan, callable without HTTP (validate_arrival_plan.py)."""
    # Everything else in this file clocks in naive local time; meet it there.
    if arrive_by.tzinfo is not None:
        arrive_by = arrive_by.astimezone().replace(tzinfo=None)
    now = datetime.now()

    stops = get_stops(system_id)
    if not stops:
        raise HTTPException(status_code=503, detail="No stops available")
    stops_by_id = {str(s.id): s for s in stops}

    dest_stops, resolved_name, confidence, place_latlng = resolve_location(dest, system_id)
    if not dest_stops:
        raise HTTPException(status_code=404, detail=f"Could not resolve destination: {dest!r}")
    dest_ids = {str(s.id) for s in dest_stops}

    # Board candidates: like /departures, the stops within a short walk rather
    # than only the nearest — the nearest stop may not be on a route that goes
    # where you need, or its bus may leave too late.
    if origin_stop_id is not None:
        origin = stops_by_id.get(str(origin_stop_id))
        if origin is None:
            raise HTTPException(status_code=404, detail="Unknown origin_stop_id")
        board_candidates = [(origin, 0.0)]
    elif lat is not None and lng is not None:
        nearby = sorted(
            ((s, distance_m(lat, lng, s.latitude, s.longitude)) for s in stops),
            key=lambda pair: pair[1],
        )
        board_candidates = [p for p in nearby if p[1] <= DEPARTURES_WALK_RADIUS_M][:DEPARTURES_MAX_STOPS]
        if not board_candidates:
            board_candidates = nearby[:1]
        origin = board_candidates[0][0]
    else:
        raise HTTPException(status_code=422, detail="Provide lat and lng, or origin_stop_id")

    routes_by_id = {str(r.myid): r for r in get_routes_cached(system_id)}

    def walk_from(stop) -> float:
        if place_latlng is None:
            return 0.0
        return distance_m(stop.latitude, stop.longitude, place_latlng[0], place_latlng[1])

    options = []
    live_routes_at: dict[str, set[str]] = {}
    for board, walk_to_board_m in board_candidates:
        if str(board.id) in dest_ids:
            continue
        walk_to_board_s = walk_to_board_m / WALK_SPEED_MS
        live_deps = _departures_from_stop(board, system_id)
        live_routes_at[str(board.id)] = set(live_deps)
        for route_id, deps in live_deps.items():
            ride = ride_to_first_of(route_id, board.id, dest_ids, stops_by_id)
            if ride is None:
                continue
            ride_s, alight_id = ride
            alight = stops_by_id[alight_id]
            walk_m = walk_from(alight)
            walk_s = walk_m / WALK_SPEED_MS
            route = routes_by_id.get(route_id)
            color = (getattr(route, "groupColor", None) or getattr(route, "color", None)) if route else None

            for eta_min, source, vendor_name in deps:
                depart_at = now + timedelta(minutes=eta_min)
                arrive_stop_at = depart_at + timedelta(seconds=ride_s)
                arrive_dest_at = arrive_stop_at + timedelta(seconds=walk_s)
                slack_s = (arrive_by - arrive_dest_at).total_seconds()
                # A bus you cannot reach in time is not an option, however
                # well it lines up with the meeting.
                reachable = eta_min * 60.0 >= walk_to_board_s
                options.append({
                    "route_id": route_id,
                    "route_name": route.name if route else vendor_name,
                    "color": color,
                    "board_stop": stopdict(board),
                    "alight_stop": stopdict(alight),
                    "depart_at": depart_at.isoformat(timespec="seconds"),
                    "be_at_stop_by": (depart_at - timedelta(seconds=ARRIVAL_PLAN_STOP_BUFFER_S)).isoformat(timespec="seconds"),
                    "arrive_stop_at": arrive_stop_at.isoformat(timespec="seconds"),
                    "arrive_dest_at": arrive_dest_at.isoformat(timespec="seconds"),
                    "slack_minutes": round(slack_s / 60.0, 1),
                    "eta_source": source,
                    "viable": slack_s >= 0 and reachable,
                    # Not in the contract, but the reason an option is not
                    # viable should be visible rather than inferred.
                    "walk_to_stop_minutes": round(walk_to_board_s / 60.0, 1),
                    "ride_minutes": round(ride_s / 60.0, 1),
                })

    # Scheduled departures fill in what the operator cannot see yet. Live ETAs
    # reach about 45 minutes ahead; a class two hours from now, or a route with
    # no bus out at the moment, comes from Harvard's published headways. Where
    # a route has live ETAs from a stop, the schedule only starts past the live
    # horizon so the same bus is not listed twice. Everything here is marked
    # "schedule" so the UI can say approximately.
    horizon = now + timedelta(minutes=ARRIVAL_PLAN_LIVE_HORIZON_MIN)
    for board, walk_to_board_m in board_candidates:
        if str(board.id) in dest_ids:
            continue
        walk_to_board_s = walk_to_board_m / WALK_SPEED_MS
        for route_id in harvard_schedule.ROUTES_WITH_SCHEDULE:
            ride = ride_to_first_of(route_id, board.id, dest_ids, stops_by_id)
            if ride is None:
                continue
            ride_s, alight_id = ride
            anchor_id = harvard_schedule.anchor_stop_for(route_id)
            if anchor_id is None:
                continue
            if anchor_id == str(board.id):
                offset_s = 0.0
            else:
                to_board = ride_to_first_of(route_id, anchor_id, {str(board.id)}, stops_by_id)
                if to_board is None:
                    continue
                offset_s = to_board[0]
            window_start = horizon if route_id in live_routes_at.get(str(board.id), set()) else now
            if window_start >= arrive_by:
                continue
            alight = stops_by_id[alight_id]
            walk_s = walk_from(alight) / WALK_SPEED_MS
            route = routes_by_id.get(route_id)
            color = (getattr(route, "groupColor", None) or getattr(route, "color", None)) if route else None
            offset = timedelta(seconds=offset_s)
            for anchor_dep, _block in harvard_schedule.departures_in_window(route_id, window_start - offset, arrive_by):
                depart_at = anchor_dep + offset
                if depart_at < window_start or depart_at > arrive_by:
                    continue
                arrive_stop_at = depart_at + timedelta(seconds=ride_s)
                arrive_dest_at = arrive_stop_at + timedelta(seconds=walk_s)
                slack_s = (arrive_by - arrive_dest_at).total_seconds()
                reachable = (depart_at - now).total_seconds() >= walk_to_board_s
                options.append({
                    "route_id": route_id,
                    "route_name": route.name if route else route_id,
                    "color": color,
                    "board_stop": stopdict(board),
                    "alight_stop": stopdict(alight),
                    "depart_at": depart_at.isoformat(timespec="seconds"),
                    "be_at_stop_by": (depart_at - timedelta(seconds=ARRIVAL_PLAN_STOP_BUFFER_S)).isoformat(timespec="seconds"),
                    "arrive_stop_at": arrive_stop_at.isoformat(timespec="seconds"),
                    "arrive_dest_at": arrive_dest_at.isoformat(timespec="seconds"),
                    "slack_minutes": round(slack_s / 60.0, 1),
                    "eta_source": "schedule",
                    "viable": slack_s >= 0 and reachable,
                    "walk_to_stop_minutes": round(walk_to_board_s / 60.0, 1),
                    "ride_minutes": round(ride_s / 60.0, 1),
                })

    options.sort(key=lambda o: o["depart_at"])
    viable = [o for o in options if o["viable"]]
    # Latest viable departure: the least time wasted waiting at the far end.
    recommended = max(viable, key=lambda o: o["depart_at"]) if viable else None

    dest_stop = dest_stops[0]
    dest_walk_m = walk_from(dest_stop)
    return {
        "dest": {
            "query": dest,
            "resolved_name": resolved_name,
            "stop": stopdict(dest_stop),
            "walk_m": round(dest_walk_m, 1),
            "walk_minutes": round(dest_walk_m / WALK_SPEED_MS / 60.0, 1),
            "confidence": confidence,
        },
        "origin_stop": stopdict(origin),
        "arrive_by": arrive_by.isoformat(timespec="seconds"),
        "options": options,
        "recommended": recommended,
        "generated_at": now.isoformat(timespec="seconds"),
    }


def arrival_plan_for(dest: str, arrive_by: datetime, lat=None, lng=None, origin_stop_id=None) -> dict:
    """What the reminder scheduler calls. Same answer as GET /arrival_plan.

    Exists so reminders.py can plan without going over HTTP; the name and
    keyword arguments are the contract it was written against.
    """
    return plan_arrival(dest=dest, arrive_by=arrive_by, lat=lat, lng=lng, origin_stop_id=origin_stop_id)


@app.get("/arrival_plan", dependencies=[Depends(OptionalRateLimiter(times=30, seconds=60))])
def api_arrival_plan(
    dest: str = Query(..., min_length=1),
    arrive_by: datetime = Query(...),
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    origin_stop_id: str | None = None,
    system_id: int = DEFAULT_SYSTEM_ID,
):
    """Which bus to take, from where, and when to be at the stop, to reach `dest` by `arrive_by`.

    `recommended` is the latest departure that still gets there in time; the
    full `options` list is returned so a client can offer the earlier, safer
    ones too.
    """
    return plan_arrival(dest, arrive_by, lat, lng, origin_stop_id, system_id)


# Web Push reminders
# ---------------------------------------------------------------------------

class PushSubscribeBody(BaseModel):
    # The PushSubscription.toJSON() object from the browser, stored verbatim
    # because pywebpush wants exactly that shape back.
    subscription: dict[str, Any]
    client_id: str = Field(min_length=1, max_length=128)


class ReminderIn(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(default="", max_length=200)
    arrive_by: str
    dest: str = Field(default="", max_length=200)
    origin_lat: Optional[float] = None
    origin_lng: Optional[float] = None
    origin_stop_id: Optional[str] = None
    lead_minutes: int = Field(default=reminders_module.DEFAULT_LEAD_MINUTES, ge=0, le=180)
    # Echoed back from GET so a client re-PUTting its list keeps sent state.
    sent_at: Optional[str] = None


class RemindersPut(BaseModel):
    client_id: str = Field(min_length=1, max_length=128)
    reminders: list[ReminderIn] = Field(default_factory=list, max_length=50)


@app.get("/push/public_key")
def api_push_public_key():
    if not reminders_module.vapid_configured():
        raise HTTPException(status_code=404, detail="Push not configured")
    return {"public_key": reminders_module.VAPID_PUBLIC_KEY}


@app.post("/push/subscribe", dependencies=[Depends(OptionalRateLimiter(times=10, seconds=60))])
def api_push_subscribe(body: PushSubscribeBody):
    sub = body.subscription
    if not sub.get("endpoint") or not isinstance(sub.get("keys"), dict):
        raise HTTPException(status_code=400, detail="subscription must include endpoint and keys")
    try:
        REMINDER_STORE.set_subscription(body.client_id, sub)
    except (RedisError, OSError) as e:
        logger.warning("Could not store push subscription", exc_info=e)
        raise HTTPException(status_code=503, detail="Reminder store unavailable")
    return {"ok": True}


@app.delete("/push/subscribe", dependencies=[Depends(OptionalRateLimiter(times=10, seconds=60))])
def api_push_unsubscribe(client_id: str = Query(..., min_length=1, max_length=128)):
    try:
        REMINDER_STORE.delete_subscription(client_id)
    except (RedisError, OSError) as e:
        logger.warning("Could not delete push subscription", exc_info=e)
        raise HTTPException(status_code=503, detail="Reminder store unavailable")
    return {"ok": True}


@app.put("/reminders", dependencies=[Depends(OptionalRateLimiter(times=20, seconds=60))])
def api_put_reminders(body: RemindersPut):
    """Replace this client's reminder set. Past `arrive_by` entries are dropped."""
    now = reminders_module.now_aware()
    kept, dropped = [], []
    for r in body.reminders:
        norm = reminders_module.normalize_reminder(r.model_dump())
        if norm is None:
            raise HTTPException(status_code=400, detail=f"reminder {r.id!r}: arrive_by is not an ISO datetime")
        if reminders_module.is_expired(norm, now):
            dropped.append(norm["id"])
            continue
        kept.append(norm)
    try:
        REMINDER_STORE.set_reminders(body.client_id, kept)
    except (RedisError, OSError) as e:
        logger.warning("Could not store reminders", exc_info=e)
        raise HTTPException(status_code=503, detail="Reminder store unavailable")
    return {"ok": True, "reminders": kept, "dropped": dropped}


@app.get("/reminders", dependencies=[Depends(OptionalRateLimiter(times=30, seconds=60))])
def api_get_reminders(client_id: str = Query(..., min_length=1, max_length=128)):
    try:
        return {
            "client_id": client_id,
            "reminders": REMINDER_STORE.get_reminders(client_id),
            "subscribed": REMINDER_STORE.get_subscription(client_id) is not None,
        }
    except (RedisError, OSError) as e:
        logger.warning("Could not read reminders", exc_info=e)
        raise HTTPException(status_code=503, detail="Reminder store unavailable")
