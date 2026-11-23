"""
The one clock the backend reads: Boston wall-clock time.

The planner, the timetable and the learned travel times all work in naive
"local" datetimes, and for a long time "local" meant whatever zone the server
ran in. On the host that is UTC, so every clock time shown to riders was five
hours ahead (four in summer), the published timetable was compared against
the wrong hour, and travel-time buckets were filed under the wrong hour of
the day.

Everything now asks this module instead. Naive datetimes everywhere in the
backend mean Boston wall-clock time, so the existing arithmetic is unchanged;
what leaves the server (JSON, notification text) carries the offset.

The zone comes from zoneinfo, with the `tzdata` package as a fallback for
hosts that ship no system time-zone database, so it does not depend on how the
host is configured.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

CAMPUS_TZ = ZoneInfo("America/New_York")


def campus_now() -> datetime:
    """Now, as naive Boston wall-clock time (the convention inside the backend)."""
    return datetime.now(CAMPUS_TZ).replace(tzinfo=None)


def campus_now_aware() -> datetime:
    """Now, as an aware datetime in Boston time."""
    return datetime.now(CAMPUS_TZ)


def to_campus_naive(dt: datetime) -> datetime:
    """Any datetime as naive Boston time. A naive input is taken to be Boston time already."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(CAMPUS_TZ).replace(tzinfo=None)


def campus_aware(dt: datetime) -> datetime:
    """Any datetime as an aware Boston datetime. A naive input is taken to be Boston time."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=CAMPUS_TZ)
    return dt.astimezone(CAMPUS_TZ)


def campus_iso(dt: datetime) -> str:
    """ISO 8601 with the Boston offset, for anything a client will parse."""
    return campus_aware(dt).isoformat(timespec="seconds")


def campus_from_timestamp(ts: float) -> datetime:
    """A Unix timestamp as an aware Boston datetime."""
    return datetime.fromtimestamp(ts, CAMPUS_TZ)
