from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from collections import defaultdict, deque
import datetime
from datetime import datetime 
from datetime import timedelta
import math 
import re
from passio_client import get_stops, get_vehicles, get_routes, DEFAULT_SYSTEM_ID, get_all_systems
from typing import Any
app = FastAPI() 

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#intialize our app with FastAPI framework 
@app.get("/health")
#test health of our api endpoint  
def health_check():
    return {"status": "ok", "message": "Backend is running!"}


VEHICLE_STATE = {} ##cache to store history of bus positions to deduce accurate etas 

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



def find_nearest_stop(lat: float, lng: float, system_id: int = DEFAULT_SYSTEM_ID):
    ## find the stop closest to any given lat and lng. returns (stop, dist in meters)
    stops = get_stops(system_id)
    best_stop = None
    best_dist = float("inf")

    for s in stops:
        d = distance_m(lat, lng, s.latitude, s.longitude)
        if d < best_dist:
            best_dist = d 
            best_stop = s 
    return best_stop, best_dist

def match_stops(lat: float, lng:float, lat2: float, lng2: float, system_id: int = DEFAULT_SYSTEM_ID):
    originstop, origindist = find_nearest_stop(lat, lng, system_id)
    deststop, destdist = find_nearest_stop(lat2, lng2, system_id)
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


@app.get("/stops")

def list_stops(system_id: int = DEFAULT_SYSTEM_ID):
    stops = get_stops(system_id)
    return [stopdict(s) for s in stops]

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

    return result


@app.get("/route_paths")
def list_route_paths(system_id: int = DEFAULT_SYSTEM_ID):
    """
    Return ordered polyline paths for all routes in a system, based on stops.routesAndPositions.
    """
    return route_paths_for_system(system_id)


@app.get("/vehicles")
def list_vehicles(system_id: int = DEFAULT_SYSTEM_ID):
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

    return [vehicledict(v, route_colors.get(str(getattr(v, "routeId", None)))) for v in vehicles]


@app.get("/nearest_stop")
def api_nearest_stop(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    system_id: int = DEFAULT_SYSTEM_ID,
):
    if system_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid system_id")

    ##given any lat and lng, return the closest shuttle stop and its dist in meters 
    stop, dist = find_nearest_stop(lat, lng, system_id)
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
    base, _, _ = match_stops(lat, lng, lat2, lng2, system_id)
    return base 



def find_common_routes(origin_stop, dest_stop, system_id: int = DEFAULT_SYSTEM_ID):
    origin_routes = getattr(origin_stop, "routesAndPositions", {}) or {}
    dest_routes = getattr(dest_stop, "routesAndPositions", {}) or {}

    common_route_ids = set(origin_routes.keys()) & set(dest_routes.keys()) 

    all_routes = get_routes(system_id)
    routes_by_id = {r.myid: r for r in all_routes}
        
    result = []
    for rid in common_route_ids:
        route = routes_by_id.get(rid)
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
        else: 
            result.append({
                "route_id": rid,
                "route_name": None,
                "short_name": None, 
                "color": None, 
            })
    return result 


NEAR_STOP_METERS = 30

def enrich_routes_with_next_bus(routes, origin_stop, system_id: int = DEFAULT_SYSTEM_ID, debug: bool = False):
    vehicles = get_vehicles(system_id)
    
    # Build indexes for faster lookup
    route_to_vehicles = {}
    name_to_vehicles = {}
    
    for v in vehicles:
        v_keys = get_vehicle_route_keys(v)
        # 1. Exact match index
        for rk in v_keys:
            route_to_vehicles.setdefault(rk, []).append(v)
        
        # 2. Name-based index for fuzzy matching (variants)
        # Note: Passio vehicle objects usually don't have route names directly, 
        # so we rely on the routes list to bridge them if needed.
        # But for now, we'll build it from 'routes' if we have it.
    
    # Bridge route names to vehicles
    routes_list = get_routes(system_id)
    rid_to_name = {norm_id(r.myid): r.name for r in routes_list if r.myid}
    for v in vehicles:
        for rk in get_vehicle_route_keys(v):
            rname = rid_to_name.get(rk)
            if rname:
                name_to_vehicles.setdefault(rname.lower(), []).append(v)

    result = [] 
    for route in routes:
        seg_id = route.get("route_id")
        seg_key = norm_id(seg_id)
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

def build_route_graph(system_id: int = DEFAULT_SYSTEM_ID):
    stops = get_stops(system_id)
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

def get_route_graph(system_id: int = DEFAULT_SYSTEM_ID):
    cached = ROUTE_GRAPH_CACHE.get(system_id)
    if cached is None:
        graph, stop_by_id = build_route_graph(system_id)
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


def find_k_paths(graph, origin_stop_id: str, dest_stop_id: str, k: int = 5, max_depth: int = 5):
    """
    Find up to K distinct paths from origin to dest using BFS.
    Each path is (nodes, edges).
    Deduplicated by (route_id sequence, stop_id sequence).
    """
    origin = str(origin_stop_id)
    dest = str(dest_stop_id)
    
    if origin == dest:
        return [([origin], [])]

    # queue of (current_node, nodes_list, edges_list)
    queue = deque([(origin, [origin], [])])
    results = []
    seen_signatures = set()

    while queue and len(results) < k:
        curr, path_nodes, path_edges = queue.popleft()
        
        if len(path_nodes) > max_depth + 1:
            continue

        for edge in graph.get(curr, []):
            nxt = edge["to"]
            rid = edge["route_id"]
            
            # Simple cycle prevention within a single path
            if nxt in path_nodes:
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
                queue.append((nxt, new_nodes, new_edges))
                
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


def build_trip_segments(path_stop_ids, segments, stop_by_id, system_id: int = DEFAULT_SYSTEM_ID, debug: bool = False):
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
        candidate_routes = find_common_routes(start_stop, end_stop, system_id)
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

        enriched_list = enrich_routes_with_next_bus([payload_route], start_stop, system_id, debug=debug)
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









@app.get("/trip")
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

    # snaps user loc to nearest stops 
    base, origin_stop, dest_stop = match_stops(lat, lng, lat2, lng2, system_id)

    if origin_stop is None or dest_stop is None:
        raise HTTPException(
            status_code=404,
            detail="No nearby shuttle stops found for origin or destination",
        )

    graph, stop_by_id = get_route_graph(system_id)
    origin_id = str(origin_stop.id)
    dest_id = str(dest_stop.id)

    # 1) Find multiple candidate paths
    path_candidates = find_k_paths(graph, origin_id, dest_id, k=5, max_depth=5)

    if not path_candidates:
        raise HTTPException(
            status_code=404,
            detail="No shuttle route found between these locations",
        )

    # 1.5) Build canonical mapping for compression
    routes_list = get_routes(system_id)
    rid_to_name = {norm_id(r.myid): r.name for r in routes_list if r.myid}

    # 2) Enrich and rank all candidates
    candidate_data = []
    for nodes, edges in path_candidates:
        raw_segments = compress_path_by_route(nodes, edges, rid_to_canonical=rid_to_name)
        segments = build_trip_segments(nodes, raw_segments, stop_by_id, system_id, debug=debug)
        
        metrics = get_path_metrics(segments)
        candidate_data.append({
            "segments": segments,
            "metrics": metrics,
            "sort_key": path_sort_key(metrics)
        })

    # 3) Pick best candidate
    candidate_data.sort(key=lambda x: x["sort_key"])
    best_candidate = candidate_data[0]
    
    # 4) Merge segments for display if they are the same route line
    final_segments = merge_segments_for_display(best_candidate["segments"])

    base["system_id"] = system_id
    base["segments"] = final_segments
    
    if debug_paths:
        base["candidate_paths"] = [
            {
                "routes": [s["route_id"] for s in c["segments"]],
                "metrics": c["metrics"]
            }
            for c in candidate_data
        ]
        base["best_index"] = 0

    return base


@app.get("/vehicles_raw")
def list_vehicles_raw(system_id: int = DEFAULT_SYSTEM_ID):
    vehicles = get_vehicles(system_id)
    # vars(v) turns the Python object into its __dict__ so you see real fields
    return [vars(v) for v in vehicles]
