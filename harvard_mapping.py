"""
Harvard Mapping Module

Maps between PassioGO stop IDs and GTFS stop IDs for Harvard (system_id = 831).
Uses location proximity (haversine distance) to match stops.
"""

import math
import logging
import threading
from typing import Optional

from harvard_gtfs import get_harvard_gtfs, Stop as GTFSStop

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Maximum distance in meters to consider a match
MAX_MATCH_DISTANCE_M = 100

# ---------------------------------------------------------------------------
# Haversine Distance Calculation
# ---------------------------------------------------------------------------

def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate the great-circle distance between two points on Earth in meters.
    """
    R = 6371000  # Earth's radius in meters
    
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    
    a = (math.sin(delta_phi / 2) ** 2 +
         math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    return R * c


# ---------------------------------------------------------------------------
# Stop Mapping Functions
# ---------------------------------------------------------------------------

def map_passiogo_stop_to_gtfs_id(p_stop) -> Optional[str]:
    """
    Map a PassioGO stop object to the closest GTFS stop_id.
    
    Args:
        p_stop: PassioGO stop object with attributes `latitude`, `longitude`, and optionally `name`.
    
    Returns:
        GTFS stop_id if a match is found within MAX_MATCH_DISTANCE_M, else None.
    """
    gtfs = get_harvard_gtfs()
    
    p_lat = getattr(p_stop, "latitude", None)
    p_lon = getattr(p_stop, "longitude", None)
    p_name = getattr(p_stop, "name", "") or ""
    
    if p_lat is None or p_lon is None:
        logger.warning(f"PassioGO stop missing lat/lon: {p_stop}")
        return None
    
    best_gtfs_id = None
    best_distance = float("inf")
    best_name_match = False
    
    p_name_lower = p_name.lower().strip()
    
    for gtfs_stop_id, gtfs_stop in gtfs.stops_by_id.items():
        distance = haversine_distance_m(p_lat, p_lon, gtfs_stop.lat, gtfs_stop.lon)
        
        if distance > MAX_MATCH_DISTANCE_M:
            continue
        
        # Check for name similarity (case-insensitive substring match)
        gtfs_name_lower = gtfs_stop.stop_name.lower().strip()
        name_match = (
            p_name_lower in gtfs_name_lower or 
            gtfs_name_lower in p_name_lower
        )
        
        # Prefer name matches, then shortest distance
        if name_match and not best_name_match:
            best_gtfs_id = gtfs_stop_id
            best_distance = distance
            best_name_match = True
        elif name_match == best_name_match and distance < best_distance:
            best_gtfs_id = gtfs_stop_id
            best_distance = distance
            best_name_match = name_match
    
    if best_gtfs_id is None:
        logger.debug(
            f"No GTFS match for PassioGO stop: id={getattr(p_stop, 'id', '?')}, "
            f"name={p_name}, lat={p_lat}, lon={p_lon}"
        )
    
    return best_gtfs_id


def build_harvard_passio_to_gtfs_map(passiogo_stops: list) -> dict[str, str]:
    """
    Build a mapping from PassioGO stop.id -> GTFS stop_id for all provided stops.
    
    Args:
        passiogo_stops: List of PassioGO stop objects.
    
    Returns:
        Dict mapping passiogo_stop.id (str) -> gtfs_stop_id (str)
    """
    mapping = {}
    matched = 0
    unmatched = 0
    
    for p_stop in passiogo_stops:
        p_id = str(getattr(p_stop, "id", ""))
        if not p_id:
            continue
        
        gtfs_id = map_passiogo_stop_to_gtfs_id(p_stop)
        if gtfs_id:
            mapping[p_id] = gtfs_id
            matched += 1
        else:
            unmatched += 1
    
    logger.info(
        f"Harvard PassioGO->GTFS mapping: {matched} matched, {unmatched} unmatched, "
        f"{len(mapping)} total mappings"
    )
    
    return mapping


# ---------------------------------------------------------------------------
# Cached Mapping (Thread-Safe)
# ---------------------------------------------------------------------------

_passio_to_gtfs_cache: Optional[dict[str, str]] = None
_gtfs_to_passio_cache: Optional[dict[str, str]] = None
_passio_stops_cache: Optional[list] = None
_mapping_lock = threading.Lock()


def get_harvard_passio_to_gtfs_map(passiogo_stops: Optional[list] = None) -> dict[str, str]:
    """
    Get the PassioGO -> GTFS stop ID mapping, building it on first call.
    
    Args:
        passiogo_stops: List of PassioGO stop objects. Required on first call.
    
    Returns:
        Dict mapping passiogo_stop.id -> gtfs_stop_id
    """
    global _passio_to_gtfs_cache, _passio_stops_cache
    
    if _passio_to_gtfs_cache is not None:
        return _passio_to_gtfs_cache
    
    with _mapping_lock:
        if _passio_to_gtfs_cache is not None:
            return _passio_to_gtfs_cache
        
        if passiogo_stops is None:
            raise ValueError(
                "passiogo_stops must be provided on first call to build the mapping"
            )
        
        _passio_stops_cache = passiogo_stops
        _passio_to_gtfs_cache = build_harvard_passio_to_gtfs_map(passiogo_stops)
        return _passio_to_gtfs_cache


def get_gtfs_to_passio_map(passiogo_stops: Optional[list] = None) -> dict[str, str]:
    """
    Get the GTFS -> PassioGO stop ID mapping (reverse of passio_to_gtfs).
    
    Returns:
        Dict mapping gtfs_stop_id -> passiogo_stop.id
    """
    global _gtfs_to_passio_cache
    
    if _gtfs_to_passio_cache is not None:
        return _gtfs_to_passio_cache
    
    with _mapping_lock:
        if _gtfs_to_passio_cache is not None:
            return _gtfs_to_passio_cache
        
        passio_to_gtfs = get_harvard_passio_to_gtfs_map(passiogo_stops)
        _gtfs_to_passio_cache = {v: k for k, v in passio_to_gtfs.items()}
        return _gtfs_to_passio_cache


def get_passio_stop_by_id(passio_stop_id: str, passiogo_stops: Optional[list] = None):
    """
    Get a PassioGO stop object by its ID from the cached stop list.
    """
    global _passio_stops_cache
    
    # Ensure mapping is built (which caches the stops)
    get_harvard_passio_to_gtfs_map(passiogo_stops)
    
    if _passio_stops_cache is None:
        return None
    
    for stop in _passio_stops_cache:
        if str(getattr(stop, "id", "")) == str(passio_stop_id):
            return stop
    return None


# ---------------------------------------------------------------------------
# Debug Functions
# ---------------------------------------------------------------------------

def debug_harvard_mapping(passiogo_stops: Optional[list] = None) -> dict:
    """
    Return the full mapping for inspection.
    """
    mapping = get_harvard_passio_to_gtfs_map(passiogo_stops)
    gtfs = get_harvard_gtfs()
    
    result = {}
    for passio_id, gtfs_id in mapping.items():
        gtfs_stop = gtfs.stops_by_id.get(gtfs_id)
        result[passio_id] = {
            "gtfs_id": gtfs_id,
            "gtfs_name": gtfs_stop.stop_name if gtfs_stop else "Unknown",
        }
    
    return result


    with _mapping_lock:
        _passio_to_gtfs_cache = None
        _gtfs_to_passio_cache = None
        _passio_stops_cache = None


# ---------------------------------------------------------------------------
# Route Mapping Functions
# ---------------------------------------------------------------------------

_route_name_map_cache: Optional[dict[str, str]] = None
_route_map_lock = threading.Lock()

def get_gtfs_route_id_by_name(passio_route_name: str) -> Optional[str]:
    """
    Map a PassioGO route name to a GTFS Route ID using matching against 
    GTFS long_name and short_name.
    """
    global _route_name_map_cache
    
    if not passio_route_name:
        return None
        
    if _route_name_map_cache is None:
        with _route_map_lock:
            if _route_name_map_cache is None:
                _build_route_name_map()
    
    # Try exact match (normalized)
    normalized = passio_route_name.lower().strip()
    match = _route_name_map_cache.get(normalized)
    
    if match:
        return match
        
    # Try fuzzy containment as fallback
    # (e.g. "Quad Sec" matches "Quad Sec Direct" or vice versa)
    for name, route_id in _route_name_map_cache.items():
        if name in normalized or normalized in name:
            # Avoid matching very short strings aliases
            if len(name) > 3 and len(normalized) > 3:
                return route_id
                
    return None

def _build_route_name_map():
    global _route_name_map_cache
    gtfs = get_harvard_gtfs()
    mapping = {}
    
    for r in gtfs.routes_by_id.values():
        if r.long_name:
            mapping[r.long_name.lower().strip()] = r.route_id
        if r.short_name:
            mapping[r.short_name.lower().strip()] = r.route_id
            
    _route_name_map_cache = mapping
    logger.info(f"Built GTFS route name map with {len(mapping)} entries")

