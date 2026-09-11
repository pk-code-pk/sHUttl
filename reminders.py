"""
Web Push "leave now" reminders.

A rider tells us when they need to be somewhere (a class at 10:30 in the
Science Center). Every minute the scheduler asks the arrival planner which
shuttle gets them there, and once the clock reaches `be_at_stop_by` minus a
lead time it pushes a notification to the phone — even with the site closed,
because the browser's service worker receives it, not the page.

Storage
-------
Subscriptions and reminders live in Redis when `REDIS_URL` is set (the same
connection main.py uses for caching), otherwise in `data/reminders.json`.

The JSON fallback is EPHEMERAL ON RENDER: the filesystem is wiped on every
deploy and restart, so subscriptions vanish and the phone silently stops
getting reminders. It exists so local development and the validator work
without Redis. Production must set REDIS_URL.

Planner dependency
------------------
The tick imports `arrival_plan_for` from main lazily, because that function is
being built in parallel and may not exist yet. If the import fails we log once
and skip — a missing planner must never take the API down with it.
"""

import asyncio
import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

DATA_DIR = os.getenv("SHUTTL_DATA_DIR", "data")
REMINDERS_PATH = os.path.join(DATA_DIR, "reminders.json")

# Two Redis hashes keyed by client_id. A hash (rather than one key per client)
# keeps "iterate every client" a single HGETALL on each tick.
REDIS_SUBS_KEY = "push:subscriptions"
REDIS_REMINDERS_KEY = "push:reminders"

SCHEDULER_INTERVAL_S = 60
DEFAULT_LEAD_MINUTES = 10

VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY")
VAPID_CLAIMS_EMAIL = os.getenv("VAPID_CLAIMS_EMAIL")


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def parse_iso(value: Any) -> Optional[datetime]:
    """ISO string -> aware datetime, or None if unparseable.

    Browsers send `Z`-suffixed UTC; the planner in main.py works in naive local
    time. Treat naive as local so both compare correctly.
    """
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt


def now_aware() -> datetime:
    return datetime.now().astimezone()


def _clock(dt: datetime, tz) -> str:
    # "10:04" not "10:04:00" — this is a phone notification, not a log line.
    local = dt.astimezone(tz)
    return f"{local.hour}:{local.minute:02d}"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

class Store:
    """Subscriptions + reminders, in Redis or a JSON file.

    Every method is synchronous and safe to call from a thread; the scheduler
    wraps the tick in asyncio.to_thread so the event loop never blocks on I/O.
    """

    def __init__(self, redis_client=None, path: str = REMINDERS_PATH):
        self._redis = redis_client
        self._path = path
        self._lock = threading.Lock()
        if self._redis is None:
            logger.info(
                "Reminder store using JSON file (ephemeral on Render)",
                extra={"path": path},
            )

    @property
    def backend(self) -> str:
        return "redis" if self._redis is not None else "json"

    # -- file backend --------------------------------------------------------

    def _read_file(self) -> dict:
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return {"subscriptions": {}, "reminders": {}}
        except (json.JSONDecodeError, OSError) as e:
            # A half-written file after a crash should not brick reminders
            # forever; start over rather than raise on every tick.
            logger.warning("Reminder file unreadable; starting empty", exc_info=e)
            return {"subscriptions": {}, "reminders": {}}
        data.setdefault("subscriptions", {})
        data.setdefault("reminders", {})
        return data

    def _write_file(self, data: dict) -> None:
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        # rename is atomic, so a reader never sees a truncated file.
        os.replace(tmp, self._path)

    # -- generic helpers -----------------------------------------------------

    def _hget(self, key: str, field: str, section: str) -> Any:
        if self._redis is not None:
            raw = self._redis.hget(key, field)
            return json.loads(raw) if raw else None
        with self._lock:
            return self._read_file()[section].get(field)

    def _hset(self, key: str, field: str, value: Any, section: str) -> None:
        if self._redis is not None:
            self._redis.hset(key, field, json.dumps(value))
            return
        with self._lock:
            data = self._read_file()
            data[section][field] = value
            self._write_file(data)

    def _hdel(self, key: str, field: str, section: str) -> None:
        if self._redis is not None:
            self._redis.hdel(key, field)
            return
        with self._lock:
            data = self._read_file()
            data[section].pop(field, None)
            self._write_file(data)

    def _hgetall(self, key: str, section: str) -> dict[str, Any]:
        if self._redis is not None:
            raw = self._redis.hgetall(key) or {}
            out = {}
            for k, v in raw.items():
                k = k.decode() if isinstance(k, bytes) else k
                try:
                    out[k] = json.loads(v)
                except (json.JSONDecodeError, TypeError):
                    continue
            return out
        with self._lock:
            return dict(self._read_file()[section])

    # -- subscriptions -------------------------------------------------------

    def get_subscription(self, client_id: str) -> Optional[dict]:
        return self._hget(REDIS_SUBS_KEY, client_id, "subscriptions")

    def set_subscription(self, client_id: str, subscription: dict) -> None:
        self._hset(REDIS_SUBS_KEY, client_id, subscription, "subscriptions")

    def delete_subscription(self, client_id: str) -> None:
        self._hdel(REDIS_SUBS_KEY, client_id, "subscriptions")

    # -- reminders -----------------------------------------------------------

    def get_reminders(self, client_id: str) -> list[dict]:
        return self._hget(REDIS_REMINDERS_KEY, client_id, "reminders") or []

    def set_reminders(self, client_id: str, reminders: list[dict]) -> None:
        if reminders:
            self._hset(REDIS_REMINDERS_KEY, client_id, reminders, "reminders")
        else:
            # An empty list is a delete; otherwise ticks iterate dead clients forever.
            self._hdel(REDIS_REMINDERS_KEY, client_id, "reminders")

    def all_reminders(self) -> dict[str, list[dict]]:
        return self._hgetall(REDIS_REMINDERS_KEY, "reminders")

    def mark_sent(self, client_id: str, reminder_id: str, when: Optional[datetime] = None) -> None:
        when = when or now_aware()
        reminders = self.get_reminders(client_id)
        for r in reminders:
            if r.get("id") == reminder_id:
                r["sent_at"] = when.isoformat(timespec="seconds")
        self.set_reminders(client_id, reminders)


# ---------------------------------------------------------------------------
# Reminder normalization
# ---------------------------------------------------------------------------

def normalize_reminder(raw: dict) -> Optional[dict]:
    """Coerce a client-supplied reminder into the stored shape; None to drop it.

    Dropped when the id or arrive_by is missing/invalid. Callers drop the
    already-past ones separately, so this stays pure.
    """
    rid = raw.get("id")
    arrive_by = parse_iso(raw.get("arrive_by"))
    if not rid or arrive_by is None:
        return None
    try:
        lead = int(raw.get("lead_minutes") or DEFAULT_LEAD_MINUTES)
    except (TypeError, ValueError):
        lead = DEFAULT_LEAD_MINUTES
    lead = max(0, min(lead, 180))

    def _float_or_none(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    return {
        "id": str(rid),
        "title": str(raw.get("title") or "").strip() or "Class",
        "arrive_by": arrive_by.isoformat(timespec="seconds"),
        "dest": str(raw.get("dest") or "").strip(),
        "origin_lat": _float_or_none(raw.get("origin_lat")),
        "origin_lng": _float_or_none(raw.get("origin_lng")),
        "origin_stop_id": (str(raw["origin_stop_id"]) if raw.get("origin_stop_id") else None),
        "lead_minutes": lead,
        # Preserved on PUT so re-saving the same set does not re-fire a reminder.
        "sent_at": raw.get("sent_at"),
    }


def is_expired(reminder: dict, now: datetime) -> bool:
    arrive_by = parse_iso(reminder.get("arrive_by"))
    return arrive_by is None or arrive_by <= now


# ---------------------------------------------------------------------------
# Push sending
# ---------------------------------------------------------------------------

class SubscriptionGone(Exception):
    """The push service says this endpoint no longer exists (404/410)."""


def vapid_configured() -> bool:
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY and VAPID_CLAIMS_EMAIL)


def send_push(subscription: dict, payload: dict) -> None:
    """Deliver one notification. Raises SubscriptionGone for dead endpoints."""
    if not vapid_configured():
        raise RuntimeError("VAPID keys not configured")
    from pywebpush import WebPushException, webpush
    from py_vapid import Vapid

    email = VAPID_CLAIMS_EMAIL if VAPID_CLAIMS_EMAIL.startswith("mailto:") else f"mailto:{VAPID_CLAIMS_EMAIL}"
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload),
            vapid_private_key=Vapid.from_string(VAPID_PRIVATE_KEY),
            vapid_claims={"sub": email},
            # A "leave now" nudge is useless an hour later; let the push
            # service drop it rather than deliver it stale.
            ttl=15 * 60,
            timeout=10,
        )
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            raise SubscriptionGone(str(e)) from e
        raise


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

_planner_warned = False


def _resolve_planner() -> Optional[Callable[..., dict]]:
    """Find main.arrival_plan_for, or None (logged once) if it is not there yet."""
    global _planner_warned
    try:
        from main import arrival_plan_for  # type: ignore
        return arrival_plan_for
    except (ImportError, AttributeError):
        if not _planner_warned:
            logger.warning("arrival_plan_for not available; reminder ticks will skip until it is")
            _planner_warned = True
        return None


def build_notification(reminder: dict, recommended: dict, tz) -> dict:
    """The payload the service worker turns into showNotification()."""
    route = recommended.get("route_name") or recommended.get("route_id") or "shuttle"
    board = (recommended.get("board_stop") or {}).get("name") or "the stop"
    be_at = parse_iso(recommended.get("be_at_stop_by"))
    depart = parse_iso(recommended.get("depart_at"))
    # Not in the agreed interface; used only if the planner happens to
    # provide them, otherwise the body falls back to the reminder's dest.
    arrive = parse_iso(recommended.get("arrive_at") or recommended.get("arrival_at"))
    alight = (recommended.get("alight_stop") or {}).get("name") or reminder.get("dest") or "your stop"
    arrive_by = parse_iso(reminder.get("arrive_by"))

    body = f"Be at {board}"
    if be_at:
        body += f" by {_clock(be_at, tz)}"
    body += f" — {route}"
    if depart:
        body += f" departs {_clock(depart, tz)}"
    body += f", arrives {alight}"
    if arrive:
        body += f" {_clock(arrive, tz)}"
    body += f" for {reminder.get('title') or 'class'}"
    if arrive_by:
        body += f" at {_clock(arrive_by, tz)}"

    return {
        "title": f"Leave now for {route}",
        "body": body,
        "data": {"url": "/", "reminder_id": reminder.get("id")},
    }


def run_tick(
    store: Store,
    now: Optional[datetime] = None,
    send: Callable[[dict, dict], None] = send_push,
    planner: Optional[Callable[..., dict]] = None,
) -> dict:
    """One pass over every reminder. Returns counters for logging/tests.

    `send` and `planner` are injectable so validate_push.py can run a tick
    without VAPID keys or the live planner.
    """
    now = now or now_aware()
    planner = planner or _resolve_planner()
    stats = {"clients": 0, "checked": 0, "sent": 0, "expired": 0, "gone": 0, "errors": 0}

    for client_id, reminders in store.all_reminders().items():
        stats["clients"] += 1
        live = [r for r in reminders if not is_expired(r, now)]
        if len(live) != len(reminders):
            stats["expired"] += len(reminders) - len(live)
            store.set_reminders(client_id, live)
        if planner is None:
            continue

        subscription = store.get_subscription(client_id)
        for r in live:
            if r.get("sent_at"):
                continue
            stats["checked"] += 1
            arrive_by = parse_iso(r["arrive_by"])
            try:
                plan = planner(
                    dest=r.get("dest"),
                    arrive_by=arrive_by,
                    lat=r.get("origin_lat"),
                    lng=r.get("origin_lng"),
                    origin_stop_id=r.get("origin_stop_id"),
                ) or {}
            except Exception as e:
                stats["errors"] += 1
                logger.warning("arrival_plan_for failed", exc_info=e, extra={"reminder_id": r.get("id")})
                continue

            recommended = plan.get("recommended")
            if not recommended:
                continue
            be_at = parse_iso(recommended.get("be_at_stop_by"))
            if be_at is None:
                continue
            fire_at = be_at - timedelta(minutes=int(r.get("lead_minutes") or DEFAULT_LEAD_MINUTES))
            if now < fire_at:
                continue

            if subscription is None:
                # Nothing to deliver to, but mark it so we stop re-planning it
                # every minute until the class starts.
                store.mark_sent(client_id, r["id"], now)
                continue

            payload = build_notification(r, recommended, arrive_by.tzinfo)
            try:
                send(subscription, payload)
            except SubscriptionGone:
                stats["gone"] += 1
                logger.info("Push subscription gone; removing", extra={"client_id": client_id})
                store.delete_subscription(client_id)
                subscription = None
                continue
            except Exception as e:
                stats["errors"] += 1
                logger.warning("Push send failed", exc_info=e, extra={"client_id": client_id})
                continue
            store.mark_sent(client_id, r["id"], now)
            stats["sent"] += 1

    return stats


async def reminder_scheduler(store: Store, interval_s: int = SCHEDULER_INTERVAL_S):
    """Background loop; start with asyncio.create_task at app startup."""
    while True:
        try:
            stats = await asyncio.to_thread(run_tick, store)
            if stats["sent"] or stats["gone"] or stats["errors"]:
                logger.info("Reminder tick", extra=stats)
        except Exception as e:
            logger.warning("Reminder scheduler error", exc_info=e)
        await asyncio.sleep(interval_s)
