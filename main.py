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
from redis import Redis
from redis.exceptions import RedisError
import redis.asyncio as redis_async
from fastapi_limiter import FastAPILimiter
from fastapi_limiter.depends import RateLimiter
from passio_client import get_stops, get_vehicles, get_routes, DEFAULT_SYSTEM_ID, get_all_systems

# Harvard GTFS integration (for system_id = 831)
from harvard_gtfs import (
    get_harvard_gtfs,
    get_harvard_graph,
    harvard_neighbors,
    HarvardEdge,
    get_harvard_shape_for_route_direction,
    debug_print_harvard_gtfs_summary,
)
from harvard_mapping import (
    get_harvard_passio_to_gtfs_map,
    get_gtfs_to_passio_map,
    get_passio_stop_by_id,
)

logger = logging.getLogger("trip")

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
@app.get("/health")
#test health of our api endpoint  
def health_check():
    return {"status": "ok", "message": "Backend is running!"}


@app.on_event("startup")
async def startup_event():
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


VEHICLE_STATE = {} ##cache to store history of bus positions to deduce accurate etas 

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


# Constants for ETA fallbacks
FALLBACK_SPEED_MS = 5.0      # ~11 mph (reasonable campus shuttle)
MIN_SPEED_MS_FOR_ETA = 1.0   # below this, treat as unusable for ETA


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
) -> list[tuple[float, float]]:
    """
    Slice a GTFS shape polyline to only include the portion between start and end stops.
    
    Args:
        shape_coords: List of (lat, lon) tuples representing the full route shape
        start_stop_lat, start_stop_lng: Coordinates of boarding stop
        end_stop_lat, end_stop_lng: Coordinates of alighting stop
    
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

    # Handle slicing
    if start_idx <= end_idx:
        # Standard case: forward along shape
        sliced = shape_coords[start_idx:end_idx + 1]
    else:
        # start_idx > end_idx
        if is_loop:
            # Wrap around: start -> end of shape -> beginning of shape -> end index
            # This covers the Quad Express 90 -> 10 case
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
) -> float | None:
    """
    Returns distance along the stop-chain from the vehicle's snapped position
    forward to the boarding stop, assuming the route is a loop (cyclic).
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

    return remaining






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

    # Harvard-specific: Use high-res GTFS shapes if available
    if system_id == 831:
        # Import here to avoid circular dependencies if any
        from harvard_mapping import get_gtfs_route_id_by_name
        from harvard_gtfs import get_harvard_shape_for_route_direction
        
        for r_entry in result:
            p_name = r_entry.get("route_name")
            if p_name:
                gtfs_id = get_gtfs_route_id_by_name(p_name)
                if gtfs_id:
                    shape = get_harvard_shape_for_route_direction(gtfs_id, None)
                    if shape:
                        # Override path with GTFS shape
                        # Use empty strings for stop_id/name as they are shape points, not stops
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
        
        stops = route.get("stops") or []
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
                along_dist = 0.0
            else:
                along_dist = distance_to_boarding_stop_along_chain_m(
                    vehicle_lat=v_lat,
                    vehicle_lng=v_lng,
                    stops=stops,
                    boarding_stop_id=boarding_stop_id,
                )
            
            curr_dist = along_dist if along_dist is not None else straight_dist
            
            if curr_dist < best_dist:
                best_vehicle = vehicle 
                best_dist = curr_dist

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
        v_lat = float(getattr(best_vehicle, "latitude", None))
        v_lng = float(getattr(best_vehicle, "longitude", None))

        prev_states.append({"lat": v_lat, "lng": v_lng, "t": datetime.now()})
        if len(prev_states) > 4:
            prev_states = prev_states[-4:] 
        VEHICLE_STATE[key] = prev_states 

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
                speed_ms = total_dist / total_dt

        speed_source = "cache"
        if speed_ms is None or not math.isfinite(speed_ms) or speed_ms < MIN_SPEED_MS_FOR_ETA:
            speed_ms = FALLBACK_SPEED_MS
            speed_source = "fallback"

        # Calculate ETA to boarding stop
        eta_to_boarding_stop_s = best_dist / speed_ms if (best_dist is not None and speed_ms > 0) else None

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
            
            ride_eta_s = seg_dist / speed_ms
            if eta_to_boarding_stop_s is not None:
                segment_eta_s = eta_to_boarding_stop_s + ride_eta_s

        r = dict(route)
        r["next_bus"] = {
            "vehicle_id": best_vehicle.id,
            "lat": v_lat,
            "lng": v_lng,
            "distance_to_boarding_stop_m": best_dist,
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
    debug: bool = False
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
    
    # Imports for GTFS shapes
    from harvard_mapping import get_gtfs_route_id_by_name
    from harvard_gtfs import get_harvard_shape_for_route_direction
    
    for i, seg_skel in enumerate(skeleton.segments):
        start_stop = get_stop(seg_skel.start_stop_id)
        end_stop = get_stop(seg_skel.end_stop_id)
        
        if not start_stop or not end_stop:
             continue

        # Reconstruct stop objects for the segment
        leg_stops = []
        
        # FIX: For base_no_transfer, we might only have [start, end] in the skeleton.
        # We should try to hydrate the full stop list from the route if available,
        # to ensure accurate ETA and stop counts.
        if len(seg_skel.stops) <= 2 and seg_skel.route_id:
             r_obj = vehicle_indexes["routes_by_id"].get(str(seg_skel.route_id))
             # If we have the route object and it has stops
             if r_obj and hasattr(r_obj, 'getStops'):
                  all_stops = r_obj.getStops()
                  start_id_str = str(seg_skel.start_stop_id)
                  end_id_str = str(seg_skel.end_stop_id)
                  
                  # Find all occurrences of start and end
                  start_indices = [i for i, s in enumerate(all_stops) if str(s.id) == start_id_str]
                  end_indices = [i for i, s in enumerate(all_stops) if str(s.id) == end_id_str]
                  
                  best_slice = []
                  min_len = float('inf')
                  
                  # Try all pairs of (start, end)
                  for s_idx in start_indices:
                      for e_idx in end_indices:
                          # Forward (linear) case
                          if s_idx <= e_idx:
                              sub = all_stops[s_idx : e_idx+1]
                              if len(sub) < min_len:
                                  min_len = len(sub)
                                  best_slice = sub
                          else:
                              # Wrap-around case (loop)
                              # Assuming route is circular: [s_idx:] + [:e_idx+1]
                              sub = all_stops[s_idx:] + all_stops[:e_idx+1]
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

        # Build route payload for enrichment
        payload_route = {
            "route_id": seg_skel.route_id,
            "route_name": seg_skel.route_name,
            "short_name": seg_skel.short_name,
            "color": seg_skel.color,
            "stops": leg_stops,
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
        
        # GTFS Polyline Slicing
        polyline = []
        if system_id == 831:
            shape = None
            route_id = str(seg_skel.route_id or "")
            if route_id:
                shape = get_harvard_shape_for_route_direction(route_id, None)
            
            if not shape and enriched_data.get("route_name"):
                 gtfs_id = get_gtfs_route_id_by_name(enriched_data["route_name"])
                 if gtfs_id:
                      shape = get_harvard_shape_for_route_direction(gtfs_id, None)
            
            if shape:
                # Slice!
                # FIX: Use start_stop object attributes directly, NOT the dict
                slat = getattr(start_stop, 'latitude', None) or getattr(start_stop, 'lat', None)
                slng = getattr(start_stop, 'longitude', None) or getattr(start_stop, 'lng', None)
                elat = getattr(end_stop, 'latitude', None) or getattr(end_stop, 'lat', None)
                elng = getattr(end_stop, 'longitude', None) or getattr(end_stop, 'lng', None)
                
                if slat is not None and slng is not None and elat is not None and elng is not None:
                    sliced = slice_shape_to_segment(shape, float(slat), float(slng), float(elat), float(elng))
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


# ---------------------------------------------------------------------------
# Harvard GTFS-specific pathfinding (for system_id = 831)
# ---------------------------------------------------------------------------

from functools import lru_cache

@lru_cache(maxsize=4096)
def find_k_paths_harvard(origin_gtfs_id: str, dest_gtfs_id: str, k=1, max_depth=20, max_transfers=1):
    """
    Find up to K distinct paths from origin to dest using BFS on the Harvard GTFS graph.
    Each path is (nodes, edges) where nodes are GTFS stop_ids.
    """
    graph = get_harvard_graph()
    
    if origin_gtfs_id == dest_gtfs_id:
        return [([origin_gtfs_id], [])]
    
    # queue of (current_node, nodes_list, edges_list, last_route_id, transfers_count)
    queue = deque([(origin_gtfs_id, [origin_gtfs_id], [], None, 0)])
    results = []
    seen_signatures = set()
    
    while queue and len(results) < k:
        curr, path_nodes, path_edges, last_rid, transfers = queue.popleft()
        
        if len(path_nodes) > max_depth + 1:
            continue
        
        edges = graph.get(curr, [])
        for edge in edges:
            nxt = edge.next_stop_id
            rid = edge.route_id
            
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
            
            if nxt == dest_gtfs_id:
                # Deduplicate by route/stop sequence
                sig = "-".join(str(e[2]) for e in new_edges) + ":" + "-".join(new_nodes)
                if sig not in seen_signatures:
                    results.append((new_nodes, new_edges))
                    seen_signatures.add(sig)
            else:
                queue.append((nxt, new_nodes, new_edges, rid, new_transfers))
    
    return results


def find_direct_route_harvard(origin_gtfs_id: str, dest_gtfs_id: str) -> list[str]:
    """
    Check if there's a direct (no-transfer) route from origin to dest in Harvard GTFS.
    Returns list of route_ids that connect them directly, or empty list.
    """
    graph = get_harvard_graph()
    
    if origin_gtfs_id == dest_gtfs_id:
        return []
    
    # BFS to find paths with 0 transfers (same route throughout)
    queue = deque([(origin_gtfs_id, [origin_gtfs_id], None)])
    visited = {(origin_gtfs_id, None)}  # (stop, route) pairs
    direct_routes = set()
    
    while queue:
        curr, path, route_id = queue.popleft()
        
        if len(path) > 25:  # Limit depth
            continue
        
        for edge in graph.get(curr, []):
            nxt = edge.next_stop_id
            rid = edge.route_id
            
            # If we've established a route, stick with it
            if route_id is not None and rid != route_id:
                continue
            
            effective_route = rid if route_id is None else route_id
            
            if (nxt, effective_route) in visited:
                continue
            visited.add((nxt, effective_route))
            
            if nxt == dest_gtfs_id:
                direct_routes.add(effective_route)
            else:
                queue.append((nxt, path + [nxt], effective_route))
    
    return list(direct_routes)


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


MAX_WALK_M = 500
MAX_NEARBY_STOPS = 5

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
    # For Harvard, verify direct route exists in GTFS
    if system_id == 831 and stops is not None:
        passio_to_gtfs = get_harvard_passio_to_gtfs_map(stops)
        origin_gtfs_id = passio_to_gtfs.get(str(origin_stop.id))
        dest_gtfs_id = passio_to_gtfs.get(str(dest_stop.id))
        
        if origin_gtfs_id and dest_gtfs_id:
            # Check if GTFS has a direct route
            direct_gtfs_routes = find_direct_route_harvard(origin_gtfs_id, dest_gtfs_id)
            if not direct_gtfs_routes:
                return []
    
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
        has_live = bool(route_to_vehicles.get(rid))
        
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
    # Harvard-specific: use GTFS graph
    if system_id == 831:
        return _plan_base_transfer_trip_harvard(
            origin_stop, dest_stop, user_origin_lat, user_origin_lng,
            user_dest_lat, user_dest_lng, stops, routes_list, vehicle_indexes,
            system_id, debug
        )
    
    # Non-Harvard: use existing PassioGO-based logic
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
            
            # Live check (Approx)
            if route_to_vehicles.get(str(r_id)):
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
        score = (0 if has_live else 10000) + (num_transfers * 500) + (total_walk * 0.5)
        
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


def _plan_base_transfer_trip_harvard(
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
    """
    Harvard-specific transfer trip planning using GTFS graph.
    """
    # Initialize mapping (first call will build it)
    passio_to_gtfs = get_harvard_passio_to_gtfs_map(stops)
    gtfs_to_passio = get_gtfs_to_passio_map(stops)
    
    # Map PassioGO stops to GTFS IDs
    origin_passio_id = str(origin_stop.id)
    dest_passio_id = str(dest_stop.id)
    
    origin_gtfs_id = passio_to_gtfs.get(origin_passio_id)
    dest_gtfs_id = passio_to_gtfs.get(dest_passio_id)
    
    # Fallback to legacy if mapping fails
    if not origin_gtfs_id or not dest_gtfs_id:
        # We can recursively call the non-harvard logic by faking system_id?
        # Or just inline it. For safety, return [] as Harvard fallback is rarely hits.
        # Original code returned None.
        return []
    
    path_candidates = find_k_paths_harvard(origin_gtfs_id, dest_gtfs_id, k=1, max_depth=20, max_transfers=1)
    if not path_candidates:
        return []
    
    candidates = []
    
    # GTFS Data for PseudoStop lookups
    gtfs_data = get_harvard_gtfs()
    # Local extra stops accumulation
    extra_stops_map = {}
    
    stop_by_passio_id = {str(s.id): s for s in stops}
    
    # Route Mapping Logic
    gtfs_id_to_passio_id = {}
    passio_routes_map = vehicle_indexes.get("routes_by_id", {})
    vehicles_by_route = vehicle_indexes.get("vehicles_by_route", {})
    from harvard_mapping import get_gtfs_route_id_by_name
    
    for pid, r_obj in passio_routes_map.items():
        gid = get_gtfs_route_id_by_name(r_obj.name)
        if gid:
            if gid in gtfs_id_to_passio_id:
                curr_pid = gtfs_id_to_passio_id[gid]
                curr_live = bool(vehicles_by_route.get(str(curr_pid)))
                new_live = bool(vehicles_by_route.get(str(pid)))
                if not curr_live and new_live:
                    gtfs_id_to_passio_id[gid] = str(pid)
            else:
                gtfs_id_to_passio_id[gid] = str(pid)

    origin_walk = distance_m(user_origin_lat, user_origin_lng, origin_stop.latitude, origin_stop.longitude)
    dest_walk = distance_m(user_dest_lat, user_dest_lng, dest_stop.latitude, dest_stop.longitude)
    total_walk = origin_walk + dest_walk
    
    route_to_vehicles = vehicle_indexes.get("route_to_vehicles", {})

    for gtfs_nodes, gtfs_edges in path_candidates:
        passio_nodes = []
        # Convert Nodes
        for gtfs_id in gtfs_nodes:
            passio_id = gtfs_to_passio.get(gtfs_id)
            if passio_id:
                passio_nodes.append(passio_id)
            else:
                passio_nodes.append(gtfs_id)
                # Create PseudoStop if unknown
                if gtfs_id not in stop_by_passio_id and gtfs_id not in extra_stops_map:
                    gtfs_stop = gtfs_data.stops_by_id.get(gtfs_id)
                    if gtfs_stop:
                        extra_stops_map[gtfs_id] = PseudoStop(gtfs_id, gtfs_stop.stop_name, gtfs_stop.lat, gtfs_stop.lon)
        
        # Convert Edges
        passio_edges = []
        for (from_gtfs, to_gtfs, route_id) in gtfs_edges:
            passio_route_id = gtfs_id_to_passio_id.get(route_id, route_id)
            from_passio = gtfs_to_passio.get(from_gtfs, from_gtfs)
            to_passio = gtfs_to_passio.get(to_gtfs, to_gtfs)
            passio_edges.append((from_passio, to_passio, passio_route_id))
            
        rid_to_name = vehicle_indexes["rid_to_name"]
        raw_segments = compress_path_by_route(passio_nodes, passio_edges, rid_to_canonical=rid_to_name)
        
        seg_skeletons = []
        has_live = False
        
        for rseg in raw_segments:
            r_id = rseg["route_id"]
            start_i = rseg["start_stop_index"]
            end_i = rseg["end_stop_index"]
            
            seg_nodes = passio_nodes[start_i:end_i+1]
            start_sid = seg_nodes[0]
            end_sid = seg_nodes[-1]
            
            # Lookup route info
            # Try Passio route first
            passio_route = passio_routes_map.get(str(r_id))
            r_name = passio_route.name if passio_route else None
            short_name = getattr(passio_route, "shortName", None) if passio_route else None
            color = getattr(passio_route, "color", None) or getattr(passio_route, "groupColor", None)
            if color and not color.startswith("#"): color = f"#{color}"
            
            # Check Live
            if route_to_vehicles.get(str(r_id)):
                has_live = True
                
            seg_skeletons.append(SegmentSkeleton(
                route_id=str(r_id),
                start_stop_id=str(start_sid),
                end_stop_id=str(end_sid),
                route_name=r_name,
                short_name=short_name,
                color=color,
                stops=seg_nodes
            ))
            
        num_transfers = max(0, len(seg_skeletons) - 1)
        score = (0 if has_live else 10000) + (num_transfers * 500) + (total_walk * 0.5)
        
        candidates.append(TripSkeleton(
            segments=seg_skeletons,
            score=score,
            num_transfers=num_transfers,
            has_live_vehicle=has_live,
            kind="base_transfer",
            origin_stop=origin_stop,
            dest_stop=dest_stop,
            total_walk_m=total_walk,
            extra_stops_map=extra_stops_map
        ))
        
    return candidates


MAX_WALK_PAIRS = 10
MAX_WALK_TIME = 2.0  # seconds

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
    # Get candidates
    origin_candidates = find_nearby_stops(user_origin_lat, user_origin_lng, stops)
    dest_candidates = find_nearby_stops(user_dest_lat, user_dest_lng, stops)
    
    # Try nearest first
    o_cands = origin_candidates[:5]
    d_cands = dest_candidates[:5]
    
    skeletons = []
    pairs_tried = 0
    t0 = time.perf_counter()
    
    for o_stop, o_walk_dist in o_cands:
        for d_stop, d_walk_dist in d_cands:
            # Check limits
            if pairs_tried >= MAX_WALK_PAIRS:
                return skeletons
            if (time.perf_counter() - t0) > MAX_WALK_TIME:
                return skeletons
            
            pairs_tried += 1
            
            # 1. No Transfer (Cheaper)
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
                
            # 2. Transfer
            # Only try transfer if we haven't found a direct option? 
            # Or always try? Original logic tried transfer if no direct found.
            # "if not cand: ... Try Transfer"
            # It picked the BEST single candidate per pair.
            # If No-Transfer worked, it DID NOT try Transfer for that pair?
            # Re-reading original:
            # cand = plan_base_no_transfer(...)
            # if not cand: cand = plan_base_transfer(...)
            # So yes, PREFER direct. If direct exists for a pair, don't bother with transfer for THAT pair.
            
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


def select_best_candidate(candidates):
    def category(c) -> int:
        live = c["has_live_bus"]
        transfers = c["num_transfers"]
        kind = c["kind"]

        if live and transfers == 0 and kind == "base_no_transfer":
            return 1  # live, no transfers
        if live and kind == "walk_modified":
            return 2  # live, walk-modified
        if live and transfers >= 1 and kind == "base_transfer":
            return 3  # live, transfers
        if not live and transfers == 0 and kind == "base_no_transfer":
            return 4  # dead, no transfers
        if not live and kind == "walk_modified":
            return 5  # dead, walk-modified
        if not live and transfers >= 1 and kind == "base_transfer":
            return 6  # dead, transfers
        return 999  # fallback

    def tie_breaker(c) -> float:
        transfers = c["num_transfers"]
        walk = c["total_walk_m"]
        # Try to get a representative ETA
        eta = 0.0
        for seg in c["segments"]:
            nb = seg.get("next_bus")
            if nb and nb.get("eta_to_origin_stop") is not None:
                eta = nb["eta_to_origin_stop"]
                break
        return transfers * 1000.0 + walk * 0.2 + (eta * 0.1)

    return min(candidates, key=lambda c: (category(c), tie_breaker(c)))


@app.get("/trip", dependencies=[Depends(OptionalRateLimiter(times=20, seconds=60))])
def api_trip(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    lat2: float = Query(..., ge=-90, le=90),
    lng2: float = Query(..., ge=-180, le=180),
    system_id: int = DEFAULT_SYSTEM_ID,
    debug: bool = False,
    debug_paths: bool = False,
):
    if system_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid system_id")

    # 1. Fetch data
    t0 = time.perf_counter()
    stops = get_stops(system_id)
    routes_list = get_routes(system_id)
    vehicles = get_vehicles(system_id)
    
    t_fetch = time.perf_counter()
    
    # 0. Check Cache
    cache_key = f"trip:{system_id}:{round(lat,4)}:{round(lng,4)}:{round(lat2,4)}:{round(lng2,4)}"
    if redis_client is not None:
        try:
            cached = redis_client.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.warning("Redis error reading trip cache", exc_info=e)

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
    
    # 2. Base Transfer (Try strictly if no direct?)
    # Reproducing logic: if direct exists, prefer it. But to ensure best Walk-Modified candidates are ranked fairly,
    # we collect them all?
    # Actually, legacy logic: "if not cand_nt: try transfer".
    # So we only add transfer skeletons if NO direct skeletons exist.
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
        
    t_search_end = time.perf_counter()
        
    # ---------------------------------------------------------
    # Phase 2: Rank & Prune
    # ---------------------------------------------------------
    # Sort lower score first
    all_skeletons.sort(key=lambda x: x.score)
    
    # Pick Top K
    K = 3
    top_skeletons = all_skeletons[:K]
    
    # ---------------------------------------------------------
    # Phase 3: Enrichment
    # ---------------------------------------------------------
    t_enrich_start = time.perf_counter()
    enriched_candidates = []
    
    for skel in top_skeletons:
        try:
            enriched = enrich_trip_skeleton(
                skel, lat, lng, lat2, lng2,
                vehicle_indexes, system_id, debug
            )
            enriched_candidates.append(enriched)
        except Exception as e:
            logger.error("Enrichment failed for skeleton", exc_info=e)
            
    if not enriched_candidates:
        raise HTTPException(404, "No enrichable trips found")

    t_enrich_end = time.perf_counter()

    # ---------------------------------------------------------
    # Phase 4: Final Selection
    # ---------------------------------------------------------
    best_candidate = select_best_candidate(enriched_candidates)
    
    t_total = time.perf_counter() - t0
    
    if debug_paths:
        best_candidate["trip"]["debug_selection"] = {
            "chosen_kind": best_candidate["kind"],
            "total_skeletons": len(all_skeletons),
            "enriched_count": len(enriched_candidates),
            "top_candidates": [
                {
                    "kind": c["kind"],
                    "live": c["has_live_bus"],
                    "transfers": c["num_transfers"],
                    "walk": c["total_walk_m"]
                }
                for c in enriched_candidates
            ],
            "timings": {
                "fetch": t_fetch - t0,
                "index": t_idx - t_fetch,
                "search": t_search_end - t_search_start,
                "enrich": t_enrich_end - t_enrich_start,
                "total": t_total
            }
        }
    
    final_result = best_candidate["trip"]
    
    # Log timings
    logger.info(
        "TRIP timings system=%s total=%.3fs search=%.3fs enrich=%.3fs n_skel=%d n_enriched=%d",
        system_id, t_total, 
        t_search_end - t_search_start, 
        t_enrich_end - t_enrich_start,
        len(all_skeletons),
        len(enriched_candidates)
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
