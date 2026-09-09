"""
Ride Systems client for Harvard Transportation Services.

Harvard retired PassioGO on 2026-07-01 and moved shuttle tracking to Citymapper,
which is fed by a Ride Systems real-time tracker at shuttle.harvard.edu. Passio's
system 831 now returns zero vehicles and its GTFS export, while still downloadable,
contains no service active after 2026-08-21.

This module replaces passio_client.py. It exposes the same duck-typed surface
(get_stops / get_routes / get_vehicles / get_all_systems returning objects with
.id, .name, .latitude, .longitude, .routesAndPositions, .myid, .routeId, ...) so
the routing engine in main.py keeps working unchanged.

Three endpoints are involved, none of them documented and none requiring a key:

  api/transit/MapData?BuildNo=0
      Bounds + platforms + routes. Routes carry their ordered platform chain and
      SVG pattern geometry. This single response replaces everything the old
      Passio/GTFS reconciliation layer had to stitch together.

  api/transit/RoutePosition?ProjectTag=&No=&Name=
      Live vehicle positions, one request per route.

  api/transit/PlatformET?Tag=
      The operator's own arrival predictions for one platform. We do not route on
      these; see eta_compare.py for why they are more useful as a test set.

Coordinate handling is the one genuinely fiddly part:

  * Vehicle positions arrive as EPSG:3857 metres with the Y axis negated
    (screen-style, north-negative), so latitude comes from -y.
  * Platforms and pattern geometry arrive in the schematic map's pixel space and
    have to be pushed through an affine map from Projects[0].Bounds (pixels) to
    Bounds (Web Mercator metres).

Both paths are validated in validate_ridesystems.py against the stop coordinates
Harvard published through Passio: SEC lands within 6 m, Law School within 23 m.
"""

import logging
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Optional

import requests
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Kept at 831 purely for continuity: the frontend, Redis cache keys and every
# ?system_id= query param in the wild still use Harvard's old Passio id. Ride
# Systems has no equivalent concept, so this is now just "Harvard".
DEFAULT_SYSTEM_ID = 831

RIDESYSTEMS_BASE_URL = os.getenv(
    "RIDESYSTEMS_BASE_URL", "https://shuttle.harvard.edu/rtt/public"
)

# Ride Systems labels the whole Harvard system "project 1". MapData confirms it,
# but allow an override in case they add a second project.
RIDESYSTEMS_PROJECT_TAG = int(os.getenv("RIDESYSTEMS_PROJECT_TAG", "1"))

HTTP_TIMEOUT_S = float(os.getenv("RIDESYSTEMS_TIMEOUT_S", "10"))

# MapData changes when Harvard edits routes, i.e. a couple of times a semester.
MAPDATA_TTL_S = float(os.getenv("RIDESYSTEMS_MAPDATA_TTL_S", "900"))

# Vehicle positions: the upstream Expires header is ~5 s out, so this is a floor
# rather than a target. The background poller in main.py drives the real cadence.
VEHICLES_TTL_S = float(os.getenv("RIDESYSTEMS_VEHICLES_TTL_S", "5"))

PLATFORM_ET_TTL_S = float(os.getenv("RIDESYSTEMS_PLATFORM_ET_TTL_S", "20"))

USER_AGENT = os.getenv(
    "RIDESYSTEMS_USER_AGENT",
    "sHUttl/2.0 (Harvard shuttle trip planner; +https://shuttl.live)",
)

EARTH_RADIUS_M = 6378137.0  # WGS84 semi-major axis, as used by EPSG:3857


# ---------------------------------------------------------------------------
# Passio-compatible models
#
# main.py reads these by attribute, and in a few places by .dict(), so they
# deliberately mirror the passiogo object shapes rather than being cleaned up.
# ---------------------------------------------------------------------------

@dataclass
class RSStop:
    """A Ride Systems platform, shaped like a passiogo Stop."""

    id: str
    name: str
    latitude: float
    longitude: float
    # {route_id: [direction, sequence_index]} — same contract main.py already
    # walks in route_paths_for_system() and build_trip_indexes().
    routesAndPositions: dict[str, list[int]] = field(default_factory=dict)
    # Ride Systems' own integer tag, needed to ask for this platform's ETAs.
    tag: Optional[int] = None
    # The rider-facing stop number ("#14"), when the feed supplies one.
    code: Optional[str] = None

    def dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "routesAndPositions": self.routesAndPositions,
            "tag": self.tag,
            "code": self.code,
        }


@dataclass
class RSRoute:
    """A Ride Systems route, shaped like a passiogo Route.

    `myid` is what main.py keys routes by; we use the operator's short code
    ("AL", "QSEC") because Ride Systems has no numeric route id and the code is
    what RoutePosition and PlatformET both echo back.
    """

    id: str
    myid: str
    name: str
    shortName: str
    color: Optional[str]
    groupColor: Optional[str]
    # Ordered platform ids for the route's canonical chain.
    platform_ids: list[str] = field(default_factory=list)
    # Pattern tags, in the order MapData returned them.
    pattern_tags: list[int] = field(default_factory=list)

    def dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "myid": self.myid,
            "name": self.name,
            "shortName": self.shortName,
            "color": self.color,
            "groupColor": self.groupColor,
        }

    def getStops(self) -> list["RSStop"]:
        """This route's stops in travel order.

        Named for the passiogo Route method it replaces: enrich_trip_skeleton()
        calls it to build the full loop that vehicle projection measures along,
        and falls back to a two-stop chain when it is missing, which makes every
        along-route distance wrong.
        """
        by_id = {s.id: s for s in get_mapdata().stops}
        return [by_id[pid] for pid in self.platform_ids if pid in by_id]


@dataclass
class RSVehicle:
    """A live vehicle, shaped like a passiogo Vehicle.

    Ride Systems gives no heading, so we derive one from the previous fix for
    this vehicle. `route_progress` is their own fraction along the pattern; we
    keep it because it is a free sanity check on our own projection.
    """

    id: str
    latitude: float
    longitude: float
    routeId: str
    routeName: str
    heading: Optional[float] = None
    pattern_tag: Optional[int] = None
    route_progress: Optional[float] = None

    def dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "routeId": self.routeId,
            "routeName": self.routeName,
            "heading": self.heading,
            "pattern_tag": self.pattern_tag,
            "route_progress": self.route_progress,
        }


@dataclass
class RSSystem:
    """Stands in for a passiogo TransportationSystem in /systems."""

    id: int
    name: str
    username: Optional[str] = None
    homepage: Optional[str] = None


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

_session_local = threading.local()


def _session() -> requests.Session:
    """One Session per thread. The poller fans out across a thread pool and
    requests.Session is not documented as thread-safe."""
    s = getattr(_session_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        _session_local.session = s
    return s


def _get_json(path: str, params: Optional[dict] = None) -> Any:
    url = f"{RIDESYSTEMS_BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    try:
        resp = _session().get(url, params=params, timeout=HTTP_TIMEOUT_S)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning("Ride Systems request failed", exc_info=e, extra={"url": url})
        raise HTTPException(
            status_code=503, detail="Upstream shuttle provider unavailable"
        )

    # The tracker is an ASP.NET app with a catch-all route: unknown paths return
    # the SPA's HTML with a 200. Fail loudly instead of handing main.py garbage.
    ctype = resp.headers.get("Content-Type", "")
    if "json" not in ctype.lower():
        logger.error(
            "Ride Systems returned non-JSON; endpoint may have moved",
            extra={"url": url, "content_type": ctype},
        )
        raise HTTPException(
            status_code=503, detail="Upstream shuttle provider returned unexpected data"
        )

    try:
        return resp.json()
    except ValueError as e:
        logger.error("Ride Systems returned malformed JSON", exc_info=e, extra={"url": url})
        raise HTTPException(
            status_code=503, detail="Upstream shuttle provider returned unexpected data"
        )


# ---------------------------------------------------------------------------
# Coordinate conversion
# ---------------------------------------------------------------------------

def mercator_to_latlng(x: float, y: float) -> tuple[float, float]:
    """EPSG:3857 metres -> (lat, lng). Expects a north-positive y."""
    lng = x / EARTH_RADIUS_M * 180.0 / math.pi
    lat = math.degrees(2.0 * math.atan(math.exp(y / EARTH_RADIUS_M)) - math.pi / 2.0)
    return lat, lng


def vehicle_pos_to_latlng(x: float, y: float) -> tuple[float, float]:
    """Convert a RoutePosition `pos` to (lat, lng).

    Ride Systems negates the mercator Y so that it increases downward like a
    screen axis, so the sign has to come back before the inverse projection.
    """
    return mercator_to_latlng(x, -y)


class _PixelProjector:
    """Affine map from the schematic map's pixel space to lat/lng.

    Platforms and pattern geometry are expressed in the pixel coordinate system
    of Projects[0].Bounds; the world extent of that rectangle is the top-level
    Bounds, in negated-Y mercator metres.
    """

    def __init__(self, world_bounds: dict, pixel_bounds: dict):
        self.wx0 = float(world_bounds["X0"])
        self.wy0 = float(world_bounds["Y0"])
        self.wx1 = float(world_bounds["X1"])
        self.wy1 = float(world_bounds["Y1"])
        self.px0 = float(pixel_bounds["X0"])
        self.py0 = float(pixel_bounds["Y0"])
        self.px1 = float(pixel_bounds["X1"])
        self.py1 = float(pixel_bounds["Y1"])

        if self.px1 == self.px0 or self.py1 == self.py0:
            raise ValueError("Degenerate pixel bounds in MapData")

    def to_latlng(self, px: float, py: float) -> tuple[float, float]:
        fx = (px - self.px0) / (self.px1 - self.px0)
        fy = (py - self.py0) / (self.py1 - self.py0)
        mx = self.wx0 + fx * (self.wx1 - self.wx0)
        my = self.wy0 + fy * (self.wy1 - self.wy0)
        return mercator_to_latlng(mx, -my)


# ---------------------------------------------------------------------------
# SVG pattern geometry
# ---------------------------------------------------------------------------

_SVG_TOKEN_RE = re.compile(r"([MmLlHhVvZz])|(-?\d+(?:\.\d+)?)")


def parse_svg_path(d: str) -> list[tuple[float, float]]:
    """Parse the subset of SVG path syntax Ride Systems emits into pixel points.

    Every pattern observed uses only an absolute `M` followed by relative `l`
    runs, but `L/H/V/h/v/m` are handled too so a feed change degrades into a
    slightly wrong polyline rather than an exception. Curve commands are not
    supported; if one ever appears we log and return what we have, because a
    truncated polyline is easier to notice than a silently mangled one.
    """
    points: list[tuple[float, float]] = []
    x = y = 0.0
    cmd: Optional[str] = None
    pending: list[float] = []

    def flush() -> None:
        nonlocal x, y, pending
        if cmd is None:
            pending = []
            return

        if cmd in ("M", "L", "m", "l"):
            # These consume coordinate pairs; a repeated pair continues the
            # command, and per the SVG spec a repeated `M` pair means lineto.
            for i in range(0, len(pending) - 1, 2):
                dx, dy = pending[i], pending[i + 1]
                if cmd in ("M", "L"):
                    x, y = dx, dy
                else:
                    x, y = x + dx, y + dy
                points.append((x, y))
        elif cmd in ("H", "h"):
            for dx in pending:
                x = dx if cmd == "H" else x + dx
                points.append((x, y))
        elif cmd in ("V", "v"):
            for dy in pending:
                y = dy if cmd == "V" else y + dy
                points.append((x, y))
        pending = []

    for m in _SVG_TOKEN_RE.finditer(d):
        token_cmd, token_num = m.group(1), m.group(2)
        if token_cmd is not None:
            flush()
            if token_cmd in ("Z", "z"):
                if points:
                    x, y = points[0]
                    points.append((x, y))
                cmd = None
            else:
                cmd = token_cmd
        else:
            pending.append(float(token_num))
    flush()

    if re.search(r"[CcSsQqTtAa]", d):
        logger.warning(
            "Ride Systems pattern geometry contains curve commands we do not parse; "
            "polyline is truncated at the first curve"
        )

    return points


# ---------------------------------------------------------------------------
# MapData: stops, routes, geometry
# ---------------------------------------------------------------------------

@dataclass
class RSPattern:
    """One variant of a route: a polyline plus the stops it actually serves,
    in the order a bus running it reaches them."""

    tag: int
    route_id: str
    shape: list[tuple[float, float]]
    # Stop ids in travel order along `shape`.
    stop_ids: list[str]


@dataclass
class _MapData:
    stops: list[RSStop]
    routes: list[RSRoute]
    # route_id -> [(lat, lng), ...] for the pattern that best covers the route
    route_shapes: dict[str, list[tuple[float, float]]]
    # route_id -> every usable pattern, so a segment can be sliced against, and
    # a vehicle projected onto, the variant it is actually running
    route_patterns: dict[str, list[RSPattern]]
    # route_id -> [(lat, lng), ...] of its platforms in travel order
    route_stop_coords: dict[str, list[tuple[float, float]]]
    project_tag: int
    fetched_at: float


# A stop this far from a polyline is not served by it. Chosen from the observed
# spread: correctly matched stops sit within ~25 m, the worst genuine mismatch
# (Allston Loop vs Widener Gate) is 148 m, and nothing falls in between.
_STOP_ON_SHAPE_M = 60.0


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class _ShapeIndex:
    """A polyline in local metres, with cumulative arc length per vertex.

    Exists because route ordering has to be recovered geometrically. Ride
    Systems returns each route's `Platforms` array sorted **alphabetically by
    stop name**, not in travel order — verified across all nine Harvard routes.
    Trusting that array would have produced a routing graph whose edges connect
    stops in alphabetical sequence, and an along-chain vehicle projection
    measuring distance through a nonsense path. The pattern geometry is the only
    statement of real sequence in the feed, so stops are projected onto it and
    ordered by arc length.
    """

    # Local equirectangular projection: over a 3 km campus the distortion is
    # far below the 60 m threshold this feeds, and it makes the ~350k point-to-
    # segment projections per refresh cheap.
    def __init__(self, shape: list[tuple[float, float]]):
        self.shape = shape
        self.ref_lat, self.ref_lng = shape[0]
        self.cos_ref = math.cos(math.radians(self.ref_lat))
        self.xy = [self._to_xy(la, lo) for la, lo in shape]

        self.cum = [0.0]
        for i in range(len(self.xy) - 1):
            ax, ay = self.xy[i]
            bx, by = self.xy[i + 1]
            self.cum.append(self.cum[-1] + math.hypot(bx - ax, by - ay))
        self.length = self.cum[-1]

    def _to_xy(self, lat: float, lng: float) -> tuple[float, float]:
        m_per_deg = 111320.0
        return ((lng - self.ref_lng) * m_per_deg * self.cos_ref,
                (lat - self.ref_lat) * m_per_deg)

    def _segment_projection(self, i: int, px: float, py: float) -> tuple[float, float]:
        """(arc, squared distance) of a point projected onto segment i."""
        ax, ay = self.xy[i]
        bx, by = self.xy[i + 1]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        if seg2 <= 0:
            return self.cum[i], (px - ax) ** 2 + (py - ay) ** 2
        t = ((px - ax) * dx + (py - ay) * dy) / seg2
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        cx, cy = ax + t * dx, ay + t * dy
        return self.cum[i] + t * math.sqrt(seg2), (px - cx) ** 2 + (py - cy) ** 2

    def project(self, lat: float, lng: float) -> tuple[float, float]:
        """Return (arc length along the shape, perpendicular distance), metres.

        Globally nearest. Ambiguous on a route that drives the same street
        twice: both passes are equally near, and which one wins is arbitrary.
        Use project_near() when a previous position is known.
        """
        px, py = self._to_xy(lat, lng)
        best_d2 = float("inf")
        best_arc = 0.0

        for i in range(len(self.xy) - 1):
            arc, d2 = self._segment_projection(i, px, py)
            if d2 < best_d2:
                best_d2 = d2
                best_arc = arc

        return best_arc, math.sqrt(best_d2)

    def project_near(
        self, lat: float, lng: float, prev_arc: float, window_m: float
    ) -> tuple[float, float]:
        """Project, preferring the pass closest to `prev_arc` along the shape.

        Several Harvard routes cover the same road twice in one lap — All
        Cambridge and Overnight both do. On those, globally nearest projection
        makes a vehicle's arc position jump between the two passes from one fix
        to the next, which registers as driving backwards or teleporting. That
        produced duplicated and out-of-order arrivals, and segment durations of
        nearly zero.

        Restricting the search to the stretch of shape just ahead of and behind
        the last known position resolves the ambiguity, because a bus's next fix
        really is near its last one. Falls back to a global projection when
        nothing in the window is close, which is what happens on the first fix
        after a vehicle is reassigned.
        """
        px, py = self._to_xy(lat, lng)
        best_d2 = float("inf")
        best_arc = None

        for i in range(len(self.xy) - 1):
            # Cheap arc-window test before the projection maths. Wraps, since
            # a bus near the end of a loop is also near its start.
            mid = self.cum[i]
            delta = abs(mid - prev_arc)
            if self.length > 0:
                delta = min(delta, self.length - delta)
            if delta > window_m:
                continue

            arc, d2 = self._segment_projection(i, px, py)
            if d2 < best_d2:
                best_d2 = d2
                best_arc = arc

        if best_arc is None:
            return self.project(lat, lng)
        return best_arc, math.sqrt(best_d2)

    def local_minima(
        self, lat: float, lng: float, max_offset_m: float, min_separation_m: float
    ) -> list[float]:
        """Arc positions where the shape makes a distinct pass by a point.

        A stop served twice in one lap has two arc positions, and treating it as
        one means the second pass is never detected as an arrival.

        `min_separation_m` is what separates a real second pass from the shape
        doubling back on itself. Terminals are the reason it is needed: the SEC
        loop brings the geometry back within metres of the same stop a hundred
        metres later, and without a separation floor that registered as two
        arrivals two seconds apart.
        """
        px, py = self._to_xy(lat, lng)
        candidates = []
        for i in range(len(self.xy) - 1):
            arc, d2 = self._segment_projection(i, px, py)
            if d2 <= max_offset_m * max_offset_m:
                candidates.append((arc, d2))

        if not candidates:
            return []

        candidates.sort()
        # Group approaches that are too close together to be separate passes,
        # keeping the nearest arc within each group.
        minima = []
        run = [candidates[0]]
        for arc, d2 in candidates[1:]:
            if arc - run[-1][0] <= min_separation_m:
                run.append((arc, d2))
            else:
                minima.append(min(run, key=lambda c: c[1])[0])
                run = [(arc, d2)]
        minima.append(min(run, key=lambda c: c[1])[0])
        return minima


def _is_subsequence(needle: list[str], haystack: list[str]) -> bool:
    """True when `needle` appears as a contiguous run inside `haystack`.

    Used to discard short-turn patterns. Contiguity matters: a pattern that hits
    the same stops in the same order but skips one in the middle is a genuinely
    different service and has to be kept.
    """
    n, h = len(needle), len(haystack)
    if n == 0 or n > h:
        return False
    return any(haystack[i : i + n] == needle for i in range(h - n + 1))


def _order_stops_along_shape(
    stops: list[RSStop], shape: list[tuple[float, float]]
) -> list[str]:
    """Stop ids that lie on `shape`, in travel order along it."""
    index = _ShapeIndex(shape)
    on_shape = []
    for s in stops:
        arc, offset = index.project(s.latitude, s.longitude)
        if offset <= _STOP_ON_SHAPE_M:
            on_shape.append((arc, s.id))
    on_shape.sort()
    return [sid for _, sid in on_shape]


_mapdata_cache: Optional[_MapData] = None
_mapdata_lock = threading.Lock()


def _pick_project(payload: dict) -> dict:
    projects = payload.get("Projects") or []
    if not projects:
        raise HTTPException(
            status_code=503, detail="Upstream shuttle provider returned no routes"
        )
    for p in projects:
        if int(p.get("Tag", -1)) == RIDESYSTEMS_PROJECT_TAG:
            return p
    logger.warning(
        "Configured project tag not present in MapData; using first project",
        extra={"want": RIDESYSTEMS_PROJECT_TAG},
    )
    return projects[0]


# Route colours, overriding the operator's.
#
# Theirs are unusable on a dark map: Allston Loop is #730000, a maroon that
# reads as black, and Quad Express and Quad Yard Express are both #136D1C —
# the same dark green for two different routes, which no legend can fix.
#
# These are the only colours on screen that are not grey or crimson, so they
# are chosen to sit inside that style rather than against it: muted, near-equal
# in lightness, warm on one side and cool on the other, with Allston Loop kept
# red so the busiest route agrees with the app's accent.
#
# Two constraints set the values:
#
#   Lightness has a floor — this is the mistake Harvard's own palette makes.
#   Below roughly L* 50 a 4px line disappears into the dark basemap.
#
#   Chroma stays restrained. Nine full-brightness hues is a rainbow: every line
#   shouts, none looks like it belongs to the same product, and the crimson
#   interface ends up competing with all of them.
#
# Hue tracks the operator's where theirs was meaningful, so riders who know
# "the purple one" still recognise it.
ROUTE_COLOR_OVERRIDES = {
    "AL": "#C04B42",    # brick red — agrees with the crimson accent
    "XSEC": "#BE7B3C",  # ochre
    "QYE": "#8C9A3E",   # olive, kept green-leaning so it separates from XSEC
    "QSTA": "#55935C",  # green
    "QE": "#3F8A8A",    # teal — was identical to QYE
    "ME": "#4374B0",    # steel blue
    "QSEC": "#7360A8",  # indigo violet, as theirs was purple
    "AC": "#A25C88",    # plum, close to their magenta
    "OVNT": "#6E7A8C",  # slate — the quiet overnight route
}


def _normalize_color(color: Optional[str]) -> Optional[str]:
    if not color:
        return None
    color = color.strip()
    if not color:
        return None
    return color if color.startswith("#") else f"#{color}"


def route_color(route_id: str, upstream: Optional[str]) -> Optional[str]:
    """Our colour for a route, falling back to the operator's.

    A route Harvard adds later still gets a colour — theirs — rather than no
    colour at all, and the override table is the only thing to edit.
    """
    override = ROUTE_COLOR_OVERRIDES.get(str(route_id).upper())
    return override or _normalize_color(upstream)


def _build_mapdata() -> _MapData:
    payload = _get_json("api/transit/MapData", {"BuildNo": 0})

    world_bounds = payload.get("Bounds")
    project = _pick_project(payload)
    pixel_bounds = project.get("Bounds")
    if not world_bounds or not pixel_bounds:
        raise HTTPException(
            status_code=503, detail="Upstream shuttle provider returned no map bounds"
        )

    projector = _PixelProjector(world_bounds, pixel_bounds)
    project_tag = int(project.get("Tag", RIDESYSTEMS_PROJECT_TAG))

    # --- platforms ---------------------------------------------------------
    stops_by_tag: dict[str, RSStop] = {}
    for p in payload.get("Platforms") or []:
        tag = p.get("Tag")
        if tag is None:
            continue
        try:
            lat, lng = projector.to_latlng(float(p["X"]), float(p["Y"]))
        except (KeyError, TypeError, ValueError):
            logger.warning("Skipping platform with unusable coordinates", extra={"tag": tag})
            continue
        sid = str(tag)
        stops_by_tag[sid] = RSStop(
            id=sid,
            name=(p.get("Name") or f"Stop {tag}").strip(),
            latitude=lat,
            longitude=lng,
            routesAndPositions={},
            tag=int(tag),
            # Not every platform carries a rider-facing number.
            code=(p.get("No") or None),
        )

    # --- routes ------------------------------------------------------------
    routes: list[RSRoute] = []
    route_shapes: dict[str, list[tuple[float, float]]] = {}
    all_route_patterns: dict[str, list[RSPattern]] = {}
    route_stop_coords: dict[str, list[tuple[float, float]]] = {}

    for r in project.get("Routes") or []:
        code = (r.get("No") or "").strip()
        name = (r.get("Name") or "").strip()
        if not code and not name:
            continue
        rid = code or name

        platform_ids = [str(t) for t in (r.get("Platforms") or [])]
        # Drop references to platforms MapData did not describe; a stop chain
        # with holes would corrupt both the routing graph and the ETA
        # projection, and it is better to plan on a shorter honest chain.
        known_ids = [pid for pid in platform_ids if pid in stops_by_tag]
        if len(known_ids) != len(platform_ids):
            logger.warning(
                "Route references unknown platforms; dropping them",
                extra={"route": rid, "missing": len(platform_ids) - len(known_ids)},
            )
        route_stops = [stops_by_tag[pid] for pid in known_ids]

        # A route has several patterns: direction variants, short-turns and
        # seasonal detours. Allston Loop has nine. Decode each one and recover
        # the stop order along it, since the feed's own ordering is alphabetical.
        patterns: list[RSPattern] = []
        for pat in r.get("Patterns") or []:
            geometry = pat.get("Geometry")
            if not geometry:
                continue
            pixels = parse_svg_path(geometry)
            if len(pixels) < 2:
                continue
            shape = [projector.to_latlng(px, py) for px, py in pixels]
            ordered = _order_stops_along_shape(route_stops, shape)
            if len(ordered) < 2:
                # A pattern serving fewer than two of the route's stops cannot
                # contribute an edge or an ETA. Usually a deadhead leg.
                continue
            patterns.append(
                RSPattern(
                    tag=int(pat.get("Tag") or 0),
                    route_id=rid,
                    shape=shape,
                    stop_ids=ordered,
                )
            )

        if not patterns:
            logger.warning(
                "Route has no usable pattern geometry; skipping it entirely, "
                "since without geometry its stop order is unknown",
                extra={"route": rid},
            )
            continue

        # Drop patterns whose stop sequence is a contiguous sub-run of a longer
        # one: they are short-turns that add no edge the longer variant lacks,
        # and keeping them only multiplies the work in the ETA projection.
        patterns.sort(key=lambda p: len(p.stop_ids), reverse=True)
        kept: list[RSPattern] = []
        for p in patterns:
            if not any(_is_subsequence(p.stop_ids, k.stop_ids) for k in kept):
                kept.append(p)
        patterns = kept

        # The canonical chain — what the routing graph and the polyline use — is
        # the pattern serving the most stops. Any stop only reachable on a
        # narrower variant stays available through that variant's own edges.
        canonical = patterns[0]
        chain_ids = canonical.stop_ids
        unserved = [
            stops_by_tag[pid].name for pid in known_ids if pid not in set(chain_ids)
        ]
        if unserved:
            logger.info(
                "Route's canonical pattern does not serve every listed stop; "
                "those stops are reachable on this route only via its variants",
                extra={"route": rid, "stops": unserved},
            )

        color = route_color(rid, r.get("Color"))
        routes.append(
            RSRoute(
                id=rid,
                myid=rid,
                name=name or code,
                shortName=code or name,
                color=color,
                groupColor=color,
                platform_ids=chain_ids,
                pattern_tags=[p.tag for p in patterns],
            )
        )

        # Attach the route to its stops in true travel order. Ride Systems has
        # no direction concept at route level, so direction is always 0.
        for seq, pid in enumerate(chain_ids):
            stops_by_tag[pid].routesAndPositions[rid] = [0, seq]

        route_shapes[rid] = canonical.shape
        all_route_patterns[rid] = patterns
        route_stop_coords[rid] = [
            (stops_by_tag[pid].latitude, stops_by_tag[pid].longitude) for pid in chain_ids
        ]

    if not routes:
        raise HTTPException(
            status_code=503, detail="Upstream shuttle provider returned no routes"
        )

    logger.info(
        "Loaded Ride Systems map data",
        extra={
            "stops": len(stops_by_tag),
            "routes": len(routes),
            "patterns": sum(len(v) for v in all_route_patterns.values()),
        },
    )

    return _MapData(
        stops=list(stops_by_tag.values()),
        routes=routes,
        route_shapes=route_shapes,
        route_patterns=all_route_patterns,
        route_stop_coords=route_stop_coords,
        project_tag=project_tag,
        fetched_at=time.time(),
    )


def get_mapdata(force: bool = False) -> _MapData:
    """Return cached MapData, refetching when the TTL has passed.

    On a refresh failure the previous snapshot is served instead: stale stops
    and routes still plan a usable trip, whereas a hard failure takes the whole
    API down for a change that happens twice a semester.
    """
    global _mapdata_cache

    cached = _mapdata_cache
    if not force and cached is not None and time.time() - cached.fetched_at < MAPDATA_TTL_S:
        return cached

    with _mapdata_lock:
        cached = _mapdata_cache
        if not force and cached is not None and time.time() - cached.fetched_at < MAPDATA_TTL_S:
            return cached
        try:
            _mapdata_cache = _build_mapdata()
        except Exception as e:
            if _mapdata_cache is not None:
                logger.warning(
                    "MapData refresh failed; serving previous snapshot", exc_info=e
                )
                return _mapdata_cache
            raise
        return _mapdata_cache


# ---------------------------------------------------------------------------
# Live vehicles
# ---------------------------------------------------------------------------

# vehicle_id -> (lat, lng) of the previous distinct fix, used to derive heading.
_last_vehicle_fix: dict[str, tuple[float, float]] = {}
_last_vehicle_fix_lock = threading.Lock()

_vehicles_cache: tuple[list[RSVehicle], float] = ([], 0.0)
_vehicles_lock = threading.Lock()

# One request per route, so the fan-out is bounded by the route count (9 today).
_VEHICLE_POOL_SIZE = int(os.getenv("RIDESYSTEMS_VEHICLE_POOL_SIZE", "9"))


def _bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lng2 - lng1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _fetch_route_vehicles(route: RSRoute, project_tag: int) -> list[RSVehicle]:
    payload = _get_json(
        "api/transit/RoutePosition",
        {"ProjectTag": project_tag, "No": route.myid, "Name": route.name},
    )

    out: list[RSVehicle] = []
    for trip in payload.get("trips") or []:
        pos = trip.get("pos") or {}
        tag = trip.get("tag")
        if tag is None or "x" not in pos or "y" not in pos:
            continue
        try:
            lat, lng = vehicle_pos_to_latlng(float(pos["x"]), float(pos["y"]))
        except (TypeError, ValueError):
            continue

        vid = str(tag)
        rpos = trip.get("rpos") or {}
        out.append(
            RSVehicle(
                id=vid,
                latitude=lat,
                longitude=lng,
                routeId=route.myid,
                routeName=route.name,
                heading=None,  # filled in below, once we know the previous fix
                pattern_tag=rpos.get("tag"),
                route_progress=rpos.get("rp"),
            )
        )
    return out


def _apply_headings(vehicles: list[RSVehicle]) -> None:
    """Derive a heading per vehicle from its previous distinct position.

    Ride Systems omits heading entirely. Anything under 5 m of movement is GPS
    jitter, so we hold the previous fix rather than spinning the map icon.
    """
    with _last_vehicle_fix_lock:
        for v in vehicles:
            prev = _last_vehicle_fix.get(v.id)
            if prev is not None:
                plat, plng = prev
                # ~5 m in degrees, good enough as a jitter gate at this latitude.
                if abs(plat - v.latitude) > 4.5e-5 or abs(plng - v.longitude) > 6.1e-5:
                    v.heading = _bearing_deg(plat, plng, v.latitude, v.longitude)
                    _last_vehicle_fix[v.id] = (v.latitude, v.longitude)
                else:
                    v.heading = _bearing_deg(plat, plng, v.latitude, v.longitude) if prev != (
                        v.latitude,
                        v.longitude,
                    ) else None
            else:
                _last_vehicle_fix[v.id] = (v.latitude, v.longitude)

        # Vehicle tags are per-trip and churn daily; without a cap this grows
        # for the lifetime of the process.
        if len(_last_vehicle_fix) > 500:
            live = {v.id for v in vehicles}
            for stale in [k for k in _last_vehicle_fix if k not in live]:
                del _last_vehicle_fix[stale]


# ---------------------------------------------------------------------------
# Public API — the passio_client-compatible surface
# ---------------------------------------------------------------------------

def get_stops(system_id: Optional[int] = None) -> list[RSStop]:
    return get_mapdata().stops


def get_routes(system_id: Optional[int] = None) -> list[RSRoute]:
    return get_mapdata().routes


def get_vehicles(system_id: Optional[int] = None) -> list[RSVehicle]:
    """Live vehicles across every route.

    Each route needs its own request, so they are fetched in parallel and the
    result briefly cached. A route that fails is skipped rather than failing the
    batch: a partial vehicle list still yields live ETAs for the routes that did
    answer, which is the whole point of the live tier.
    """
    global _vehicles_cache

    cached, ts = _vehicles_cache
    if time.time() - ts < VEHICLES_TTL_S:
        return cached

    with _vehicles_lock:
        cached, ts = _vehicles_cache
        if time.time() - ts < VEHICLES_TTL_S:
            return cached

        md = get_mapdata()
        vehicles: list[RSVehicle] = []
        failures = 0

        with ThreadPoolExecutor(max_workers=max(1, _VEHICLE_POOL_SIZE)) as pool:
            futures = {
                pool.submit(_fetch_route_vehicles, r, md.project_tag): r for r in md.routes
            }
            for fut, route in futures.items():
                try:
                    vehicles.extend(fut.result())
                except Exception as e:
                    failures += 1
                    logger.warning(
                        "Failed to fetch vehicles for route",
                        exc_info=e,
                        extra={"route": route.myid},
                    )

        if failures and not vehicles:
            # Every route failed. Serve the last known list if it is recent
            # enough to still be meaningful, otherwise report upstream down.
            if cached and time.time() - ts < 60:
                logger.warning("All route position fetches failed; serving stale vehicles")
                return cached
            raise HTTPException(
                status_code=503, detail="Upstream shuttle provider unavailable"
            )

        _apply_headings(vehicles)
        _vehicles_cache = (vehicles, time.time())
        return vehicles


def get_all_systems() -> list[RSSystem]:
    """Ride Systems' tracker serves exactly one system.

    The old Passio-backed /systems endpoint listed thousands of universities and
    the frontend's system picker read from it. Returning a single entry keeps
    that response shape valid while making the collapse in scope explicit.
    """
    md = get_mapdata()
    return [
        RSSystem(
            id=DEFAULT_SYSTEM_ID,
            name="Harvard Transportation Services",
            username="harvard",
            homepage="https://transportation.harvard.edu/harvard-shuttle",
        )
    ] if md.routes else []


def get_system(system_id: Optional[int] = None):
    """Compatibility shim for passio_client.get_system."""
    systems = get_all_systems()
    return systems[0] if systems else None


# ---------------------------------------------------------------------------
# Geometry accessors (consumed by harvard_shapes.py)
# ---------------------------------------------------------------------------

def get_route_shape(route_id: str) -> Optional[list[tuple[float, float]]]:
    """Highest-resolution polyline for a route, as [(lat, lng), ...]."""
    return get_mapdata().route_shapes.get(str(route_id))


def get_route_stop_coords(route_id: str) -> Optional[list[tuple[float, float]]]:
    """Ordered platform coordinates for a route, for direction-aware slicing."""
    return get_mapdata().route_stop_coords.get(str(route_id))


def get_route_patterns(route_id: str) -> list[RSPattern]:
    """Every usable variant of a route, widest first."""
    return get_mapdata().route_patterns.get(str(route_id), [])


def get_pattern_shape_for_segment(
    route_id: str, start_stop_id: str, end_stop_id: str
) -> Optional[list[tuple[float, float]]]:
    """Polyline of the variant that serves this segment, start before end.

    The canonical pattern covers most segments, but not all: Allston Loop's
    widest variant skips Widener Gate, which a narrower variant serves. Slicing
    such a segment against the canonical shape would draw a line that never
    passes the stop, so pick the variant that actually contains both endpoints
    in the right order and fall back to the canonical shape otherwise.
    """
    start_id, end_id = str(start_stop_id), str(end_stop_id)
    for pattern in get_route_patterns(route_id):
        ids = pattern.stop_ids
        if start_id in ids and end_id in ids:
            # Loops wrap, so "start before end" only has to hold cyclically.
            return pattern.shape
    return get_route_shape(route_id)


def get_route_stop_ids(route_id: str) -> list[str]:
    """Canonical stop chain for a route, in travel order."""
    md = get_mapdata()
    for r in md.routes:
        if r.myid == str(route_id):
            return r.platform_ids
    return []


_shape_index_cache: dict[str, "_ShapeIndex"] = {}
_shape_index_lock = threading.Lock()

# A shape whose ends are farther apart than this is not a closed loop, so
# wrapping past its end is a guess rather than geometry.
_LOOP_CLOSURE_M = 200.0


def _shape_index_for_route(route_id: str) -> Optional["_ShapeIndex"]:
    rid = str(route_id)
    with _shape_index_lock:
        cached = _shape_index_cache.get(rid)
        if cached is not None:
            return cached

    shape = get_route_shape(rid)
    if not shape or len(shape) < 2:
        return None

    index = _ShapeIndex(shape)
    with _shape_index_lock:
        # Route structure refreshes every 15 minutes; drop the whole cache
        # rather than tracking generations, since it rebuilds in microseconds.
        if len(_shape_index_cache) > 64:
            _shape_index_cache.clear()
        _shape_index_cache[rid] = index
    return index


def distance_along_route_m(
    route_id: str,
    from_lat: float,
    from_lng: float,
    to_lat: float,
    to_lng: float,
) -> Optional[float]:
    """Forward driving distance along a route's geometry, in metres.

    Replaces measuring along the stop chain. The chain sums straight lines
    between consecutive stops, which understates how far a bus actually drives —
    and the ETA engine then reports buses arriving sooner than they do. The
    error is worst exactly where it matters most, on the curved river-crossing
    legs. Route geometry carries ~460 vertices, so this measures the road.

    Returns None when the route has no geometry, or when the target is behind
    the origin on a shape that is not a closed loop, since wrapping around an
    open shape would invent a return trip the feed does not describe.
    """
    index = _shape_index_for_route(route_id)
    if index is None or index.length <= 0:
        return None

    from_arc, from_off = index.project(from_lat, from_lng)
    to_arc, to_off = index.project(to_lat, to_lng)

    # Neither end should be far off its own route.
    if from_off > 250.0 or to_off > 250.0:
        return None

    forward = to_arc - from_arc
    if forward >= 0:
        return forward

    closure = _haversine_m(*index.shape[0], *index.shape[-1])
    if closure <= _LOOP_CLOSURE_M:
        return forward + index.length
    return None


def get_route_id_by_name(route_name: str) -> Optional[str]:
    """Resolve a display name or short code to a route id.

    Kept because main.py falls back to name-based lookup when a segment's
    route_id is missing.
    """
    if not route_name:
        return None
    target = route_name.strip().lower()
    for r in get_mapdata().routes:
        if target in ((r.name or "").lower(), (r.myid or "").lower(), (r.shortName or "").lower()):
            return r.myid
    return None


# ---------------------------------------------------------------------------
# Operator ETAs (PlatformET)
# ---------------------------------------------------------------------------

@dataclass
class VendorEta:
    """One operator-published arrival prediction for a platform."""

    route_id: str
    route_name: str
    destination: str
    eta_minutes: int
    # Present when the prediction comes from a timetable rather than a vehicle.
    scheduled: Optional[str] = None


_platform_et_cache: dict[str, tuple[list[VendorEta], float]] = {}
_platform_et_lock = threading.Lock()


def get_platform_etas(stop_id: str) -> list[VendorEta]:
    """Operator arrival predictions for one stop, soonest first.

    These are not used for routing. main.py's own projection engine still
    produces the ETAs the app shows; this exists so the two can be compared.
    See eta_compare.py.
    """
    sid = str(stop_id)

    with _platform_et_lock:
        entry = _platform_et_cache.get(sid)
        if entry is not None and time.time() - entry[1] < PLATFORM_ET_TTL_S:
            return entry[0]

    stop = next((s for s in get_mapdata().stops if s.id == sid), None)
    if stop is None or stop.tag is None:
        return []

    payload = _get_json("api/transit/PlatformET", {"Tag": stop.tag})

    etas: list[VendorEta] = []
    for project in payload.get("Projects") or []:
        for route in project.get("Routes") or []:
            rid = (route.get("No") or "").strip()
            rname = (route.get("Name") or "").strip()
            for dest in route.get("Destinations") or []:
                dname = (dest.get("Name") or "").strip()
                for trip in dest.get("Trips") or []:
                    et = trip.get("ET")
                    if et is None:
                        continue
                    try:
                        et_min = int(et)
                    except (TypeError, ValueError):
                        continue
                    etas.append(
                        VendorEta(
                            route_id=rid,
                            route_name=rname,
                            destination=dname,
                            eta_minutes=et_min,
                            scheduled=trip.get("ST"),
                        )
                    )

    etas.sort(key=lambda e: e.eta_minutes)

    with _platform_et_lock:
        _platform_et_cache[sid] = (etas, time.time())
        if len(_platform_et_cache) > 200:
            _platform_et_cache.clear()

    return etas


def get_service_alerts() -> list[dict]:
    """Operator service alerts. Empty list when service is running normally."""
    payload = _get_json("api/transit/ServiceAlert")
    return payload.get("Projects") or []
