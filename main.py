from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from collections import defaultdict, deque
import datetime
from datetime import datetime 
from datetime import timedelta
import math 
from passio_client import get_stops, get_vehicles, get_routes, DEFAULT_SYSTEM_ID, get_all_systems
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
def api_nearest_stop(lat: float, lng: float, system_id: int = DEFAULT_SYSTEM_ID):
    ##given any lat and lng, return the closest shuttle stop and its dist in meters 
    stop, dist = find_nearest_stop(lat, lng, system_id)
    if not stop:
        return {"stop": None, "distance_m": None}
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
            result.append({
                "route_id": rid,
                "route_name": route.name,
                "short_name": getattr(route, "shortName", None),
                "color": getattr(route, "groupColor", None),
            })
        else: 
            result.append({
                "route_id": rid,
                "route_name": None,
                "short_name": None, 
                "color": None, 
            })
    return result 


def enrich_routes_with_next_bus(routes, origin_stop, system_id: int = DEFAULT_SYSTEM_ID):
    vehicles = get_vehicles(system_id)
    result = [] 
    for route in routes:
        rid = route["route_id"]
        best_dist = float("inf")
        best_vehicle = None 
        for vehicle in vehicles: 
            if (getattr(vehicle, "routeId", None) == rid and getattr(vehicle, "latitude", None) is not None and getattr(vehicle, "longitude", None) is not None):
                raw_lat, raw_lng = float(getattr(vehicle, "latitude", None)), float(getattr(vehicle, "longitude", None))
                curr_dist = distance_m(origin_stop.latitude, origin_stop.longitude, raw_lat, raw_lng)
                if(curr_dist < best_dist):
                    best_vehicle = vehicle 
                    best_dist = curr_dist
        if(best_vehicle is None):
            r = dict(route)
            r["next_bus"] = None
            result.append(r)
            continue 
        if(best_vehicle is not None):
            key = (system_id, best_vehicle.id)
            prev_states = VEHICLE_STATE.get(key, [])
            v_lat = float(getattr(best_vehicle, "latitude", None))
            v_lng = float(getattr(best_vehicle, "longitude", None))

            prev_states.append({"lat": v_lat, "lng": v_lng, "t": datetime.now()})

            if(len(prev_states) > 4):
                prev_states = prev_states[-4:] 
            VEHICLE_STATE[key] = prev_states 
            est_s = None

            if (len(prev_states) >=2):
                total_dist = 0.0 
                total_dt = 0.0 
                i=0
                for i in range(len(prev_states) - 1):
                    p1 = prev_states[i] 
                    p2 = prev_states[i+1] 

                    prev_lat = p1["lat"]
                    prev_lng = p1["lng"]
                    next_lat = p2["lat"]
                    next_lng = p2["lng"]
                    prev_t = p1["t"]
                    t = p2["t"]
                    dt = t - prev_t 
                    d = distance_m(prev_lat, prev_lng, next_lat, next_lng)
                    if (dt.total_seconds() > 1.0 and 20 >= d/dt.total_seconds() >= 1) : 
                        total_dist += distance_m(prev_lat, prev_lng, next_lat, next_lng)
                        total_dt += dt.total_seconds()
                if total_dist > 0: 
                    est_s = total_dist/total_dt
            avg_speed_ms = 6.0
            eta_s = avg_speed_ms / best_dist ## fallback speed in case     
            if est_s is not None: ## if we have a real speed
                eta_prob = best_dist / est_s 
                if(0.5 * eta_s < eta_prob < 2.0 * eta_s ): ## if our real speed isn't invalid 
                    avg_speed_ms = est_s 
            eta_s = best_dist / avg_speed_ms if avg_speed_ms > 0 else None 

            eta_min = eta_s/60.0 if eta_s is not None else None  

            r = dict(route)
            r["next_bus"] = {
            "vehicle_id": best_vehicle.id,
            "lat": v_lat,
            "lng": v_lng,
            "distance_to_origin_stop": best_dist,
            "eta_to_origin_stop": eta_s,
            "eta_to_origin_stop_minutes": eta_min
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
            if isinstance(pos, (list, tuple)) and len(pos) >= 2:
                pos_id = pos[1]
            else:
                pos_id = 0
            routes_to_stops[rid].append((sid, s, pos_id))
    graph = defaultdict(list)

    for rid, lst in routes_to_stops.items():
        lst_sorted = sorted(lst, key=lambda x:x[2])
        for i in range(len(lst_sorted) - 1):
            sid1, s1, _ = lst_sorted[i]
            sid2, s2, _ = lst_sorted[i+1]

            d = distance_m(s1.latitude, s1.longitude, s2.latitude, s2.longitude) 

            graph[sid1].append({"to": sid2, "route_id": rid, "distance_m": d})
            graph[sid2].append({"to": sid1, "route_id": rid, "distance_m": d})

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


def compress_path_by_route(path_stop_ids, edges):
    segments = [] 
    if not edges:
        return segments 
    current_route = edges[0][2]
    segment_start_idx = 0 

    
    for edge_idx, (_, _, rid) in enumerate(edges):
        if rid != current_route:
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


def build_trip_segments(path_stop_ids, segments, stop_by_id, system_id: int = DEFAULT_SYSTEM_ID):
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

        enriched_list = enrich_routes_with_next_bus([chosen_route], start_stop, system_id)
        enriched_route = enriched_list[0] if enriched_list else chosen_route

        trip_segments.append({
            "route_id": route_id,
            "route_name": enriched_route.get("route_name"),
            "short_name": enriched_route.get("short_name"),
            "color": enriched_route.get("color"),
            "start_stop": stopdict(start_stop),
            "end_stop": stopdict(end_stop),
            "stops": leg_stops,
            "next_bus": enriched_route.get("next_bus"),
        })

    return trip_segments









@app.get("/trip")
def api_trip(
    lat: float,
    lng: float,
    lat2: float,
    lng2: float,
    system_id: int = DEFAULT_SYSTEM_ID,
):
    # snaps user loc to nearest stops 
    base, origin_stop, dest_stop = match_stops(lat, lng, lat2, lng2, system_id)

    graph, stop_by_id = get_route_graph(system_id)
    origin_id = str(origin_stop.id)
    dest_id = str(dest_stop.id)

    path_stop_ids, edges = shortest_stop_path(graph, origin_id, dest_id)

    if path_stop_ids is None or edges is None:
        base["system_id"] = system_id
        base["segments"] = []
        base["error"] = "No path found between these stops in this system."
        return base

    segments = compress_path_by_route(path_stop_ids, edges)
    trip_segments = build_trip_segments(path_stop_ids, segments, stop_by_id, system_id)
    trip_segments = merge_segments_for_display(trip_segments)

    base["system_id"] = system_id
    base["segments"] = trip_segments
   

    return base


@app.get("/vehicles_raw")
def list_vehicles_raw(system_id: int = DEFAULT_SYSTEM_ID):
    vehicles = get_vehicles(system_id)
    # vars(v) turns the Python object into its __dict__ so you see real fields
    return [vars(v) for v in vehicles]
