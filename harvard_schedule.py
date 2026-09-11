"""
Harvard's published shuttle timetable, as headway blocks.

Ride Systems serves live ETAs only — the tracker has no schedule endpoint —
so a question about a bus two hours from now has nothing to ask it. Harvard
Transportation publishes the timetable as prose ("buses leave approximately
every 20 minutes from 7:40 a.m. to 3:10 p.m."), route by route, on
transportation.harvard.edu/harvard-shuttle/shuttle-schedule-and-routes. This
module is that page transcribed: for each route, the windows it runs, the
headway inside each window, the stop the headway is anchored at, and the gaps
the page calls out.

What it is good for: telling a rider at 8:00 which bus gets them to a 10:30
class, and letting a reminder be planned before the operator has an ETA for
the bus in question. What it is not: exact. The page says "approximately", and
it means it — a scheduled departure here is the middle of a headway window,
and the planner marks anything derived from it `eta_source: "schedule"` so
the UI can say so. When the operator has a live ETA for the same trip, the
live number wins.

Transcribed 2026-09-10 from the 2025-26 academic-year schedule. Last year's
GTFS feed (google_transit/, deleted, still in git history at e8da6a7^) was
used to fill the one window the page leaves out (Quad-SEC) and to sanity
check the rest; where they disagreed — Quad Express is every 10 minutes now,
20 then — the page won.

Times are minutes after local midnight of the day the departure happens.
Values >= 1440 mean "after midnight, into the next calendar day", the GTFS
convention, so an evening service that runs to 12:20 a.m. is one block.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

WEEKDAYS = frozenset({0, 1, 2, 3, 4})  # Monday..Friday, datetime.weekday()
WEEKENDS = frozenset({5, 6})
EVERY_DAY = WEEKDAYS | WEEKENDS


def _hm(h: int, m: int = 0) -> int:
    return h * 60 + m


@dataclass(frozen=True)
class Block:
    route_id: str
    days: frozenset[int]          # weekday() values the departures fall on
    start: int                    # first anchor departure, minutes after midnight
    end: int                      # last anchor departure (inclusive)
    headway: int                  # minutes between anchor departures
    anchor_stop_id: str           # the stop the page's times refer to
    gaps: tuple[tuple[int, int], ...] = ()   # (start, end) windows with no departures
    note: str = ""


# Ride Systems platform ids for the anchors the page names.
SEC = "18"
QUAD = "28"          # Radcliffe Quad
MATHER = "10"        # Mather and Dunster House

BLOCKS: list[Block] = [
    # ---- Allston Loop. The page carries two descriptions of this route; the
    # 40/20-minute one matches what the operator's ETAs show in the evening
    # (~20-minute spacing), so that is the one transcribed. The other ("every
    # 15 minutes from 7:30 a.m. to 10:45 p.m.") looks like an older copy.
    Block("AL", WEEKDAYS, _hm(7), _hm(15), 40, SEC, gaps=((_hm(11, 20), _hm(12, 10)),)),
    Block("AL", WEEKDAYS, _hm(15), _hm(22, 30), 20, SEC,
          note="reduced frequency 7-8 p.m."),
    Block("AL", WEEKENDS, _hm(17, 15), _hm(20), 30, SEC),

    # ---- Mather Express.
    Block("ME", WEEKDAYS, _hm(7, 40), _hm(15, 10), 20, MATHER,
          note="8:40 and 2:40 depart five minutes late; no service 3:20-4:30"),
    Block("ME", WEEKDAYS, _hm(16, 30), _hm(21), 40, MATHER),

    # ---- All Cambridge. Weekday evenings it is the second line of the
    # "Mather Express, All Cambridge, Overnight" section; weekends all day.
    Block("AC", WEEKDAYS, _hm(21, 40), _hm(24, 20), 20, QUAD),
    Block("AC", WEEKENDS, _hm(8, 15), _hm(16, 30), 35, QUAD),
    Block("AC", WEEKENDS, _hm(16, 20), _hm(24, 25), 20, QUAD,
          note="reduced service 9-10:10 p.m."),

    # ---- Quad Express.
    Block("QE", WEEKDAYS, _hm(7, 50), _hm(15, 50), 10, QUAD,
          gaps=((_hm(12), _hm(13)),),
          note="every 20 minutes 12-1 p.m.; 3:40 only runs to Mass & Garden"),
    Block("QE", WEEKDAYS, _hm(12), _hm(13), 20, QUAD),

    # ---- Quad - SEC Direct. Window from last year's GTFS; the page gives the
    # headway but not the hours.
    Block("QSEC", WEEKDAYS, _hm(7), _hm(19), 20, QUAD,
          note="reduced frequency 3:20-4:40 p.m."),

    # ---- Quad Stadium (weekday early morning) and its Saturday variant, which
    # the page lists as explicit times rather than a headway.
    Block("QSTA", WEEKDAYS, _hm(5, 20), _hm(7, 40), 30, QUAD),
    Block("QSTA", frozenset({5}), _hm(5, 50), _hm(5, 50), 1, QUAD),
    Block("QSTA", frozenset({5}), _hm(6, 35), _hm(6, 35), 1, QUAD),
    Block("QSTA", frozenset({5}), _hm(7), _hm(7), 1, QUAD),
    Block("QSTA", frozenset({5}), _hm(7, 35), _hm(7, 35), 1, QUAD),

    # ---- SEC Express.
    Block("XSEC", WEEKDAYS, _hm(7, 30), _hm(15, 45), 15, SEC,
          note="reduced frequency 11:30-12:30"),

    # ---- Quad Yard Express.
    Block("QYE", WEEKDAYS, _hm(16, 20), _hm(19, 50), 25, QUAD),
    Block("QYE", WEEKDAYS, _hm(20), _hm(24, 20), 20, QUAD),

    # ---- Overnight. "12:40 a.m. to 3:40 a.m. Sunday through Thursday" means
    # the nights that begin on those days, so the departures land on
    # Monday..Friday mornings; Friday and Saturday nights run to 4:50 (the
    # page says p.m., which is a typo).
    Block("OVNT", frozenset({0, 1, 2, 3, 4}), _hm(0, 40), _hm(3, 40), 35, QUAD),
    Block("OVNT", frozenset({5, 6}), _hm(0, 40), _hm(4, 50), 35, QUAD),
]

ROUTES_WITH_SCHEDULE = frozenset(b.route_id for b in BLOCKS)


def anchor_stop_for(route_id: str) -> str | None:
    """The stop the page's times for this route refer to."""
    for b in BLOCKS:
        if b.route_id == route_id:
            return b.anchor_stop_id
    return None


def anchor_departures(route_id: str, day: date) -> list[tuple[datetime, Block]]:
    """Every scheduled departure from the route's anchor stop on `day`.

    A block whose times run past midnight contributes departures dated the
    next calendar day; a block on the previous day can therefore spill into
    `day`'s small hours, which is why the caller should ask for a window and
    not a single date (see departures_in_window).
    """
    out: list[tuple[datetime, Block]] = []
    midnight = datetime(day.year, day.month, day.day)
    for b in BLOCKS:
        if b.route_id != route_id or day.weekday() not in b.days:
            continue
        t = b.start
        while t <= b.end:
            if not any(g0 <= t < g1 for g0, g1 in b.gaps):
                out.append((midnight + timedelta(minutes=t), b))
            t += b.headway
    return out


def departures_in_window(route_id: str, start: datetime, end: datetime) -> list[tuple[datetime, Block]]:
    """Anchor departures for a route between two datetimes, in order.

    Looks at the day before `start` as well, so a service that began the
    previous evening and runs past midnight is not lost.
    """
    if route_id not in ROUTES_WITH_SCHEDULE:
        return []
    out: list[tuple[datetime, Block]] = []
    day = (start - timedelta(days=1)).date()
    last = end.date()
    while day <= last:
        for dep, b in anchor_departures(route_id, day):
            if start <= dep <= end:
                out.append((dep, b))
        day += timedelta(days=1)
    out.sort(key=lambda x: x[0])
    return out
