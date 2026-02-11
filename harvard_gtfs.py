"""
Harvard GTFS Loader Module

Parses Harvard's GTFS data from the local google_transit/ folder and exposes
in-memory structures for trip planning.

Covers:
- Prompt 1: GTFS data loading and parsing
- Prompt 2: Directed graph construction from stop_times
- Prompt 5: Shape polylines for route directions
"""

import csv
import os
import logging
import threading
from dataclasses import dataclass
from typing import NamedTuple, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Default path to the GTFS folder (relative to project root)
HARVARD_GTFS_LOCAL_PATH = os.getenv("HARVARD_GTFS_LOCAL_PATH", "google_transit")

# ---------------------------------------------------------------------------
# Dataclasses for GTFS entities
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Stop:
    """GTFS stop entity."""
    stop_id: str
    stop_name: str
    lat: float
    lon: float


@dataclass(frozen=True)
class Route:
    """GTFS route entity."""
    route_id: str
    short_name: str
    long_name: str
    color: Optional[str]


@dataclass(frozen=True)
class Trip:
    """GTFS trip entity."""
    trip_id: str
    route_id: str
    service_id: str
    direction_id: Optional[int]
    shape_id: Optional[str]


@dataclass(frozen=True)
class StopTime:
    """GTFS stop_time entity."""
    trip_id: str
    stop_id: str
    stop_sequence: int
    arrival_time: str
    departure_time: str


# ---------------------------------------------------------------------------
# HarvardGTFS Container
# ---------------------------------------------------------------------------

class HarvardGTFS:
    """
    Container holding all parsed GTFS data for Harvard shuttle.
    """
    def __init__(
        self,
        stops_by_id: dict[str, Stop],
        routes_by_id: dict[str, Route],
        trips_by_id: dict[str, Trip],
        stop_times_by_trip: dict[str, list[StopTime]],
        shapes_by_id: dict[str, list[tuple[float, float]]],
    ):
        self.stops_by_id = stops_by_id
        self.routes_by_id = routes_by_id
        self.trips_by_id = trips_by_id
        self.stop_times_by_trip = stop_times_by_trip
        self.shapes_by_id = shapes_by_id


# ---------------------------------------------------------------------------
# Parsing Functions
# ---------------------------------------------------------------------------

def _parse_stops(gtfs_path: str) -> dict[str, Stop]:
    """Parse stops.txt into a dict keyed by stop_id."""
    stops = {}
    filepath = os.path.join(gtfs_path, "stops.txt")
    
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stop_id = row["stop_id"].strip()
            stops[stop_id] = Stop(
                stop_id=stop_id,
                stop_name=row.get("stop_name", "").strip(),
                lat=float(row["stop_lat"]),
                lon=float(row["stop_lon"]),
            )
    return stops


def _parse_routes(gtfs_path: str) -> dict[str, Route]:
    """Parse routes.txt into a dict keyed by route_id."""
    routes = {}
    filepath = os.path.join(gtfs_path, "routes.txt")
    
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            route_id = row["route_id"].strip()
            color = row.get("route_color", "").strip() or None
            routes[route_id] = Route(
                route_id=route_id,
                short_name=row.get("route_short_name", "").strip(),
                long_name=row.get("route_long_name", "").strip(),
                color=color,
            )
    return routes


def _parse_trips(gtfs_path: str) -> dict[str, Trip]:
    """Parse trips.txt into a dict keyed by trip_id."""
    trips = {}
    filepath = os.path.join(gtfs_path, "trips.txt")
    
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            trip_id = row["trip_id"].strip()
            direction_id_raw = row.get("direction_id", "").strip()
            direction_id = int(direction_id_raw) if direction_id_raw else None
            shape_id = row.get("shape_id", "").strip() or None
            
            trips[trip_id] = Trip(
                trip_id=trip_id,
                route_id=row["route_id"].strip(),
                service_id=row["service_id"].strip(),
                direction_id=direction_id,
                shape_id=shape_id,
            )
    return trips


def _parse_stop_times(gtfs_path: str) -> dict[str, list[StopTime]]:
    """Parse stop_times.txt into a dict keyed by trip_id, sorted by stop_sequence."""
    stop_times_by_trip: dict[str, list[StopTime]] = {}
    filepath = os.path.join(gtfs_path, "stop_times.txt")
    
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            trip_id = row["trip_id"].strip()
            st = StopTime(
                trip_id=trip_id,
                stop_id=row["stop_id"].strip(),
                stop_sequence=int(row["stop_sequence"]),
                arrival_time=row.get("arrival_time", "").strip(),
                departure_time=row.get("departure_time", "").strip(),
            )
            if trip_id not in stop_times_by_trip:
                stop_times_by_trip[trip_id] = []
            stop_times_by_trip[trip_id].append(st)
    
    # Sort each trip's stop_times by stop_sequence
    for trip_id in stop_times_by_trip:
        stop_times_by_trip[trip_id].sort(key=lambda x: x.stop_sequence)
    
    return stop_times_by_trip


def _parse_shapes(gtfs_path: str) -> dict[str, list[tuple[float, float]]]:
    """Parse shapes.txt into a dict keyed by shape_id, sorted by sequence."""
    shapes_raw: dict[str, list[tuple[int, float, float]]] = {}
    filepath = os.path.join(gtfs_path, "shapes.txt")
    
    with open(filepath, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            shape_id = row["shape_id"].strip()
            seq = int(row["shape_pt_sequence"])
            lat = float(row["shape_pt_lat"])
            lon = float(row["shape_pt_lon"])
            
            if shape_id not in shapes_raw:
                shapes_raw[shape_id] = []
            shapes_raw[shape_id].append((seq, lat, lon))
    
    # Sort by sequence and extract just (lat, lon)
    shapes: dict[str, list[tuple[float, float]]] = {}
    for shape_id, points in shapes_raw.items():
        points.sort(key=lambda x: x[0])
        shapes[shape_id] = [(lat, lon) for (_, lat, lon) in points]
    
    return shapes


def _load_harvard_gtfs() -> HarvardGTFS:
    """Load and parse all GTFS data from the configured path."""
    gtfs_path = HARVARD_GTFS_LOCAL_PATH
    
    logger.info(f"Loading Harvard GTFS from: {gtfs_path}")
    
    stops = _parse_stops(gtfs_path)
    routes = _parse_routes(gtfs_path)
    trips = _parse_trips(gtfs_path)
    stop_times = _parse_stop_times(gtfs_path)
    shapes = _parse_shapes(gtfs_path)
    
    gtfs = HarvardGTFS(
        stops_by_id=stops,
        routes_by_id=routes,
        trips_by_id=trips,
        stop_times_by_trip=stop_times,
        shapes_by_id=shapes,
    )
    
    # Log summary
    logger.info(
        f"Harvard GTFS loaded: {len(stops)} stops, {len(routes)} routes, "
        f"{len(trips)} trips, {len(shapes)} shapes"
    )
    
    return gtfs


# ---------------------------------------------------------------------------
# Cached GTFS Instance (Thread-Safe)
# ---------------------------------------------------------------------------

_gtfs_cache: Optional[HarvardGTFS] = None
_gtfs_lock = threading.Lock()


def get_harvard_gtfs() -> HarvardGTFS:
    """
    Get the Harvard GTFS data, loading it on first call.
    Thread-safe and idempotent.
    """
    global _gtfs_cache
    
    if _gtfs_cache is not None:
        return _gtfs_cache
    
    with _gtfs_lock:
        # Double-check after acquiring lock
        if _gtfs_cache is not None:
            return _gtfs_cache
        
        _gtfs_cache = _load_harvard_gtfs()
        return _gtfs_cache


def debug_print_harvard_gtfs_summary(gtfs: Optional[HarvardGTFS] = None) -> dict:
    """
    Return a summary dict of the GTFS data for debugging.
    """
    if gtfs is None:
        gtfs = get_harvard_gtfs()
    
    return {
        "stops": len(gtfs.stops_by_id),
        "routes": len(gtfs.routes_by_id),
        "trips": len(gtfs.trips_by_id),
        "shapes": len(gtfs.shapes_by_id),
        "stop_times_trips": len(gtfs.stop_times_by_trip),
    }


# ---------------------------------------------------------------------------
# Prompt 2: Directed Graph from GTFS stop_times
# ---------------------------------------------------------------------------

class HarvardEdge(NamedTuple):
    """Edge in the Harvard GTFS directed graph."""
    next_stop_id: str
    route_id: str
    trip_id: str
    direction_id: Optional[int]


_harvard_graph_cache: Optional[dict[str, list[HarvardEdge]]] = None
_graph_lock = threading.Lock()


def _build_harvard_graph(gtfs: HarvardGTFS) -> dict[str, list[HarvardEdge]]:
    """
    Build a directed adjacency list from GTFS stop_times.
    
    For each trip, iterate through consecutive stop pairs and add directed edges.
    """
    graph: dict[str, list[HarvardEdge]] = {}
    
    for trip_id, trip in gtfs.trips_by_id.items():
        stop_times = gtfs.stop_times_by_trip.get(trip_id, [])
        
        if len(stop_times) < 2:
            continue
        
        route_id = trip.route_id
        direction_id = trip.direction_id
        
        for i in range(len(stop_times) - 1):
            from_stop = stop_times[i].stop_id
            to_stop = stop_times[i + 1].stop_id
            
            edge = HarvardEdge(
                next_stop_id=to_stop,
                route_id=route_id,
                trip_id=trip_id,
                direction_id=direction_id,
            )
            
            if from_stop not in graph:
                graph[from_stop] = []
            
            # Avoid duplicate edges (same from->to on same route)
            # We keep track of unique (next_stop_id, route_id) pairs
            existing = {(e.next_stop_id, e.route_id) for e in graph[from_stop]}
            if (to_stop, route_id) not in existing:
                graph[from_stop].append(edge)
    
    # Log graph stats
    total_edges = sum(len(edges) for edges in graph.values())
    logger.info(
        f"HARVARD_GRAPH built: {len(graph)} stops with outgoing edges, "
        f"{total_edges} total edges"
    )
    
    return graph


def get_harvard_graph() -> dict[str, list[HarvardEdge]]:
    """
    Get the Harvard GTFS directed graph, building it on first call.
    Thread-safe and cached.
    """
    global _harvard_graph_cache
    
    if _harvard_graph_cache is not None:
        return _harvard_graph_cache
    
    with _graph_lock:
        if _harvard_graph_cache is not None:
            return _harvard_graph_cache
        
        gtfs = get_harvard_gtfs()
        _harvard_graph_cache = _build_harvard_graph(gtfs)
        return _harvard_graph_cache


def harvard_neighbors(stop_id: str) -> list[HarvardEdge]:
    """
    Get all outgoing edges from a given GTFS stop_id.
    """
    graph = get_harvard_graph()
    return graph.get(stop_id, [])


def debug_harvard_paths_example() -> dict:
    """
    Sanity check: return out-degree and sample neighbors for a few known stops.
    """
    graph = get_harvard_graph()
    gtfs = get_harvard_gtfs()
    
    # Pick some known stop IDs from the GTFS
    sample_stops = ["58343", "5051", "6248", "5049"]  # SEC, Winthrop, Science Center, Quad
    
    results = {}
    for stop_id in sample_stops:
        edges = graph.get(stop_id, [])
        stop_info = gtfs.stops_by_id.get(stop_id)
        stop_name = stop_info.stop_name if stop_info else "Unknown"
        
        results[stop_id] = {
            "name": stop_name,
            "out_degree": len(edges),
            "neighbors": [
                {
                    "to": e.next_stop_id,
                    "to_name": gtfs.stops_by_id.get(e.next_stop_id, Stop("", "Unknown", 0, 0)).stop_name,
                    "route_id": e.route_id,
                }
                for e in edges[:5]  # Limit to 5 for readability
            ],
        }
    
    return results


# ---------------------------------------------------------------------------
# Prompt 5: Shape Polylines for Route Directions
# ---------------------------------------------------------------------------

def get_harvard_shape_for_route_direction(
    route_id: str, 
    direction_id: Optional[int] = None
) -> Optional[list[tuple[float, float]]]:
    """
    Return a polyline (list of (lat, lon) tuples) for a given route and direction.
    
    Strategy:
    - Find all trips matching route_id and direction_id
    - Pick one with a valid shape_id
    - Return the shape coordinates
    """
    gtfs = get_harvard_gtfs()
    
    # Find matching trips
    matching_trips = [
        t for t in gtfs.trips_by_id.values()
        if t.route_id == route_id and (direction_id is None or t.direction_id == direction_id)
    ]
    
    if not matching_trips:
        return None
    
    # Collect all valid shape IDs from matching trips
    shape_counts = {}
    for trip in matching_trips:
        sid = trip.shape_id
        if sid and sid in gtfs.shapes_by_id:
            shape_counts[sid] = shape_counts.get(sid, 0) + 1
            
    if not shape_counts:
        return None
        
    # Return the most frequent shape ID
    best_shape_id = max(shape_counts, key=shape_counts.get)
    return gtfs.shapes_by_id[best_shape_id]


def get_stop_coords_for_route(
    route_id: str,
    direction_id: Optional[int] = None,
) -> list[tuple[float, float]]:
    """Return the ordered (lat, lon) coordinates of stops for a route's canonical trip.

    Uses the trip with the most stop_times entries (the most complete trip).
    """
    gtfs = get_harvard_gtfs()

    matching_trips = [
        t for t in gtfs.trips_by_id.values()
        if t.route_id == route_id and (direction_id is None or t.direction_id == direction_id)
    ]
    if not matching_trips:
        return []

    # Pick the trip with the most stop_times (most complete)
    best_trip = max(
        matching_trips,
        key=lambda t: len(gtfs.stop_times_by_trip.get(t.trip_id, [])),
    )
    stop_times = gtfs.stop_times_by_trip.get(best_trip.trip_id, [])
    coords = []
    for st in stop_times:
        stop = gtfs.stops_by_id.get(st.stop_id)
        if stop:
            coords.append((stop.lat, stop.lon))
    return coords


# ---------------------------------------------------------------------------
# Module-level initialization (optional eager loading)
# ---------------------------------------------------------------------------

def init_harvard_gtfs():
    """
    Optionally call this at startup to eagerly load GTFS data.
    """
    get_harvard_gtfs()
    get_harvard_graph()
    logger.info("Harvard GTFS initialized")
