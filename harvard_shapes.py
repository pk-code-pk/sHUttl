"""
Route geometry for Harvard, backed by Ride Systems.

This replaces the shape half of harvard_gtfs.py. It keeps the function names
main.py already calls so the polyline-slicing code in enrich_trip_skeleton() and
route_paths_for_system() did not have to be rewritten around a new vocabulary —
only the source of the geometry changed.

What changed underneath:

  * GTFS shapes came from shapes.txt, keyed by a GTFS route id that had to be
    recovered from a route name. Ride Systems ships geometry inline with the
    route, so the name-to-id indirection is now a direct lookup.
  * A GTFS route had one shape per direction. A Ride Systems route has several
    patterns, and picking the wrong one draws a line that never reaches the
    stop, so segment-aware lookup is available through
    get_shape_for_segment().
"""

import logging
from typing import Optional

import ridesystems_client as rs

logger = logging.getLogger(__name__)


def get_route_id_by_name(route_name: str) -> Optional[str]:
    """Resolve a display name or short code to a route id.

    Replaces harvard_mapping.get_gtfs_route_id_by_name. That function existed to
    bridge two vendors' incompatible route identifiers by fuzzy-matching names;
    here the id and the name come from the same response, so this is only a
    convenience for call sites that carry a name and no id.
    """
    return rs.get_route_id_by_name(route_name)


def get_shape_for_route(route_id: str, direction=None) -> Optional[list[tuple[float, float]]]:
    """Polyline for a route as [(lat, lng), ...], or None.

    `direction` is accepted and ignored: it was a GTFS direction_id, and Ride
    Systems expresses the same idea as separate patterns instead. Keeping the
    parameter means the call sites in main.py stay unchanged.
    """
    return rs.get_route_shape(route_id)


def get_shape_for_segment(
    route_id: str, start_stop_id: str, end_stop_id: str
) -> Optional[list[tuple[float, float]]]:
    """Polyline of the route variant that actually serves this segment."""
    return rs.get_pattern_shape_for_segment(route_id, start_stop_id, end_stop_id)


def get_stop_coords_for_route(route_id: str) -> Optional[list[tuple[float, float]]]:
    """Ordered stop coordinates for a route, used for direction-aware slicing.

    slice_shape_to_segment() needs these to decide which way round a loop the
    bus travels between two stops; without them a loop can be sliced the long
    way round.
    """
    return rs.get_route_stop_coords(route_id)
