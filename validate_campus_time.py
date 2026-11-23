"""
Sanity check that the backend's clock is Boston time whatever zone the host runs in.

    python validate_campus_time.py

The host runs in UTC, and for a long time every clock time shown to riders was
five hours ahead. This forces the process into UTC and asserts that:
  - campus_now() is Boston wall-clock time, not the host's
  - DST is applied (a July instant is UTC-4, a January one UTC-5)
  - campus_iso() carries the Boston offset
  - a browser's Z-suffixed time is read as the same instant
  - learned travel times are bucketed by the Boston hour
"""

import os
import time

os.environ["TZ"] = "UTC"
time.tzset()

from datetime import datetime, timezone  # noqa: E402

from campus_time import CAMPUS_TZ, campus_iso, campus_now, to_campus_naive  # noqa: E402
import arrivals  # noqa: E402
import reminders  # noqa: E402

utc_now = datetime.now(timezone.utc)
boston = utc_now.astimezone(CAMPUS_TZ)
assert abs((campus_now() - boston.replace(tzinfo=None)).total_seconds()) < 5, "campus_now is not Boston time"
assert datetime.now().hour == utc_now.hour, "test setup: the process should be in UTC"

july = datetime(2026, 7, 1, 16, 0, tzinfo=timezone.utc)
jan = datetime(2026, 1, 15, 16, 0, tzinfo=timezone.utc)
assert to_campus_naive(july).hour == 12, "July should be UTC-4"
assert to_campus_naive(jan).hour == 11, "January should be UTC-5"
assert campus_iso(to_campus_naive(jan)).endswith("-05:00")
assert campus_iso(to_campus_naive(july)).endswith("-04:00")

parsed = reminders.parse_iso("2026-01-15T16:00:00Z")
assert parsed == jan and parsed.astimezone(CAMPUS_TZ).hour == 11

# Thursday 2026-01-15 11:00 Boston is weekday 3, hour 11.
assert arrivals._time_bucket(jan.timestamp()) == 3 * 24 + 11, "travel-time bucket should use the Boston hour"

print("validate_campus_time: OK")
