"""
Push "leave now" reminders.

A rider tells us when they need to be somewhere (a class at 10:30 in the
Science Center). Every minute the scheduler asks the arrival planner which
shuttle gets them there, and once the clock reaches `be_at_stop_by` minus a
lead time it pushes a notification to the phone — even with the site closed,
because the browser's service worker receives it, not the page.

Two transports
--------------
A browser is reached through Web Push (VAPID). The iOS app is a WKWebView,
which has no service worker and no PushManager, so it is reached through
Apple Push Notification service with the device token iOS hands the app.
Both kinds of subscription live in the same per-client slot — a client is one
install, and it has exactly one way to be reached — and the native one is a
dict tagged `"type": "apns"` so the tick can tell them apart.

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
import base64
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from campus_time import CAMPUS_TZ, campus_aware, campus_now_aware
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

# Token-based APNs auth: one key from the Apple Developer account signs a short
# JWT that is good for every device, so there is no certificate to renew each
# year. APNS_AUTH_KEY is the *contents* of the .p8 file, not a path — Render
# has environment variables, not a place to mount files.
APNS_KEY_ID = (os.getenv("APNS_KEY_ID") or "").strip() or None
APNS_TEAM_ID = (os.getenv("APNS_TEAM_ID") or "").strip() or None
APNS_AUTH_KEY = os.getenv("APNS_AUTH_KEY")
APNS_BUNDLE_ID = (os.getenv("APNS_BUNDLE_ID") or "").strip() or "live.shuttl.app"
APNS_ENVIRONMENT = os.getenv("APNS_ENVIRONMENT") or "production"

APNS_HOSTS = {
    "production": "https://api.push.apple.com",
    "sandbox": "https://api.sandbox.push.apple.com",
}

# A "leave now" nudge is useless an hour later; let the push service drop it
# rather than deliver it stale. Shared by both transports.
PUSH_TTL_S = 15 * 60

# Apple rejects a provider token older than 60 minutes and throttles a server
# that mints a new one more often than every 20. Forty is comfortably inside
# both, including a few minutes of clock drift in either direction.
APNS_JWT_REFRESH_S = 40 * 60
APNS_JWT_MIN_AGE_S = 20 * 60

# A device token is raw bytes in hex: 32 bytes today, and Apple says not to
# assume that stays true, hence the generous upper bound. Either case is
# accepted; apns_subscription() lowercases before anything is stored.
_APNS_TOKEN_RE = re.compile(r"(?:[0-9a-fA-F]{2}){32,100}")


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def parse_iso(value: Any) -> Optional[datetime]:
    """ISO string -> aware datetime, or None if unparseable.

    Browsers send `Z`-suffixed UTC; the planner in main.py works in naive
    Boston time (campus_time). Treat naive as Boston so both compare correctly.
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
    return campus_aware(dt)


def now_aware() -> datetime:
    return campus_now_aware()


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
        # Where the rider is coming from, in words — the previous class's
        # room, when one ends shortly before this one starts. The planner
        # resolves it the same way it resolves a destination.
        "origin_place": (str(raw["origin_place"]).strip() or None) if raw.get("origin_place") else None,
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
    """The push service says this endpoint or device token no longer exists."""


class ApnsError(RuntimeError):
    """APNs refused a notification for a reason that is ours, not the device's.

    Bad credentials, throttling, an outage: none of them say anything about
    the subscription, so the tick must keep it and try again next minute.
    """

    def __init__(self, status: int, reason: str, environment: str):
        self.status = status
        self.reason = reason
        self.environment = environment
        super().__init__(f"APNs {environment} answered {status} {reason or '(no reason)'}")


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
            ttl=PUSH_TTL_S,
            timeout=10,
        )
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            raise SubscriptionGone(str(e)) from e
        raise


# ---------------------------------------------------------------------------
# APNs sending
# ---------------------------------------------------------------------------

def is_apns_subscription(subscription: Any) -> bool:
    """Whether a stored subscription is a native device token.

    A browser's PushSubscription always has an `endpoint` and the native dict
    never does, so asking for the tag *and* the absence of an endpoint means
    nothing a browser stores — or someone posting as one — can be steered
    down the APNs path.
    """
    return (
        isinstance(subscription, dict)
        and subscription.get("type") == "apns"
        and "endpoint" not in subscription
    )


def valid_apns_token(token: Any) -> bool:
    return isinstance(token, str) and _APNS_TOKEN_RE.fullmatch(token) is not None


def apns_subscription(token: str, previous: Optional[dict] = None) -> dict:
    """The dict stored for a native client. `token` must pass valid_apns_token.

    `previous` is whatever the client had stored before. The app re-registers
    on every launch, as Apple asks, and almost always with the token it
    already had; carrying the learned environment across keeps that from
    costing a wasted request to the wrong APNs host on the next reminder.
    """
    # One spelling per device: the plugin reports uppercase hex, Apple's own
    # tooling lowercase.
    token = token.lower()
    subscription = {"type": "apns", "token": token}
    if (
        is_apns_subscription(previous)
        and previous.get("token") == token
        and previous.get("environment") in APNS_HOSTS
    ):
        subscription["environment"] = previous["environment"]
    return subscription


_apns_environment_warned = False


def _apns_default_environment() -> str:
    global _apns_environment_warned
    env = (APNS_ENVIRONMENT or "").strip().lower()
    if env in APNS_HOSTS:
        return env
    if not _apns_environment_warned:
        logger.warning("APNS_ENVIRONMENT=%r is neither 'production' nor 'sandbox'; using production", APNS_ENVIRONMENT)
        _apns_environment_warned = True
    return "production"


# (raw env value, parsed key or None). Keyed on the raw value so a bad key is
# reported once rather than on every /push/config request.
_apns_key_cache: Optional[tuple[str, Any]] = None


def _apns_signing_key():
    """The parsed .p8 key, or None when it is missing or unusable."""
    global _apns_key_cache
    raw = APNS_AUTH_KEY
    if not raw:
        return None
    if _apns_key_cache is not None and _apns_key_cache[0] == raw:
        return _apns_key_cache[1]
    key = None
    try:
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import load_pem_private_key

        # A .p8 is a multi-line PEM, and most dashboards and .env files only
        # hold one line, so the usual way to paste it is with literal "\n"
        # where the line breaks were — sometimes with the quotes that kept it
        # on one line still attached. A key that went through a Windows editor
        # first arrives with "\r\n" instead, and the stray "\r" would be read
        # as part of the base64.
        pem = raw.strip().strip("'\"").replace("\\r", "").replace("\\n", "\n").strip()
        loaded = load_pem_private_key(pem.encode("ascii"), password=None)
        if isinstance(loaded, ec.EllipticCurvePrivateKey) and isinstance(loaded.curve, ec.SECP256R1):
            key = loaded
        else:
            logger.error("APNS_AUTH_KEY is not a P-256 key; APNs is disabled. It should be the .p8 file from Apple, unmodified.")
    except Exception as e:
        # Only the exception's type: the message could quote part of a secret.
        logger.error(
            "APNS_AUTH_KEY could not be read as a PEM private key (%s); APNs is disabled. "
            "It should be the whole .p8 file, BEGIN/END lines included.",
            type(e).__name__,
        )
    _apns_key_cache = (raw, key)
    return key


def apns_configured() -> bool:
    # Parsing the key, not just checking it is set: a client that is told APNs
    # works will offer the reminder toggle, and a toggle that can never
    # deliver is worse than no toggle.
    return bool(APNS_KEY_ID and APNS_TEAM_ID and _apns_signing_key() is not None)


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


_apns_jwt_lock = threading.Lock()
_apns_jwt_cache: Optional[dict] = None


def apns_jwt(now: Optional[float] = None) -> str:
    """The provider token for the authorization header. `now` is epoch seconds.

    Signed by hand rather than with PyJWT because the whole format is three
    base64url segments and cryptography is already here for VAPID.
    """
    global _apns_jwt_cache
    now = time.time() if now is None else now
    fingerprint = (APNS_KEY_ID, APNS_TEAM_ID, APNS_AUTH_KEY)
    with _apns_jwt_lock:
        cached = _apns_jwt_cache
        if cached is not None and cached["fingerprint"] == fingerprint:
            age = now - cached["issued_at"]
            # A token Apple has called expired (our clock and theirs disagree)
            # is replaced early, but still never inside the 20-minute floor:
            # minting one per send would trade one rejection for a throttle.
            max_age = APNS_JWT_MIN_AGE_S if cached["rejected"] else APNS_JWT_REFRESH_S
            if 0 <= age < max_age:
                return cached["token"]

        key = _apns_signing_key()
        if key is None or not (APNS_KEY_ID and APNS_TEAM_ID):
            raise RuntimeError("APNs credentials not configured")
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

        header = {"alg": "ES256", "kid": APNS_KEY_ID}
        claims = {"iss": APNS_TEAM_ID, "iat": int(now)}
        signing_input = ".".join(
            _b64url(json.dumps(part, separators=(",", ":")).encode("utf-8"))
            for part in (header, claims)
        )
        # cryptography returns the signature DER-encoded; a JWT wants the two
        # 32-byte integers back to back.
        r, s = decode_dss_signature(key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256())))
        token = f"{signing_input}.{_b64url(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
        _apns_jwt_cache = {
            "token": token,
            "issued_at": now,
            "fingerprint": fingerprint,
            "rejected": False,
        }
        return token


def _apns_jwt_rejected(token: str) -> None:
    with _apns_jwt_lock:
        if _apns_jwt_cache is not None and _apns_jwt_cache["token"] == token:
            _apns_jwt_cache["rejected"] = True


_apns_client = None
_apns_client_lock = threading.Lock()


def _apns_http_client():
    """One shared HTTP/2 client; APNs speaks nothing older."""
    global _apns_client
    with _apns_client_lock:
        if _apns_client is None:
            import httpx

            # httpx's default keep-alive (a few seconds) is left alone on
            # purpose. Every send in a tick shares one connection, and the
            # next tick opens a fresh one instead of writing into a socket
            # Apple may have dropped during the idle minute.
            _apns_client = httpx.Client(http2=True, timeout=10)
        return _apns_client


def apns_payload(payload: dict) -> dict:
    """build_notification()'s payload in the shape APNs wants.

    iOS draws the banner itself from `aps`. Everything the service worker
    would have read from `data` goes beside it at the top level, which is
    where the app finds it when the notification is tapped.
    """
    out: dict[str, Any] = {
        "aps": {
            "alert": {"title": payload.get("title"), "body": payload.get("body")},
            "sound": "default",
        }
    }
    for key, value in (payload.get("data") or {}).items():
        if key != "aps":
            out[key] = value
    return out


def _apns_collapse_id(payload: dict) -> Optional[str]:
    """The reminder id, when Apple and an HTTP header can both carry it.

    With it, a reminder that somehow goes out twice replaces its own banner
    instead of stacking. Apple caps the value at 64 bytes and ids are
    client-supplied, so one that does not fit simply goes without.
    """
    rid = (payload.get("data") or {}).get("reminder_id")
    if not isinstance(rid, str) or not rid:
        return None
    if not (rid.isascii() and rid.isprintable()) or rid != rid.strip() or len(rid) > 64:
        return None
    return rid


def _apns_post(client, environment: str, token: str, headers: dict, body: bytes) -> tuple[int, str]:
    """POST one notification; returns (status, reason). 200 is delivered."""
    resp = client.post(f"{APNS_HOSTS[environment]}/3/device/{token}", headers=headers, content=body)
    if resp.status_code == 200:
        return 200, ""
    # Failures carry {"reason": "..."}. Anything else — a proxy's error page —
    # just leaves the reason blank.
    try:
        reason = resp.json().get("reason")
    except (ValueError, AttributeError):
        reason = None
    return resp.status_code, reason if isinstance(reason, str) else ""


def _apns_token_dead(status: int, reason: str) -> bool:
    # Not DeviceTokenNotForTopic. Apple sends that when the token belongs to
    # a different bundle id than the topic we named, which for tokens our own
    # app registered means APNS_BUNDLE_ID is wrong: every device would answer
    # the same way, and treating it as a dead token would quietly delete
    # every native subscription over one mistyped variable.
    return status == 410 or (status == 400 and reason == "BadDeviceToken")


def _apns_failure(status: int, reason: str, environment: str, jwt: str) -> ApnsError:
    """Log a failure that is the server's to fix, and build the error to raise."""
    if status == 403:
        if reason == "ExpiredProviderToken":
            _apns_jwt_rejected(jwt)
            hint = "Apple thinks our token is over an hour old; check the server clock."
        else:
            hint = (
                "Check APNS_KEY_ID, APNS_TEAM_ID and APNS_AUTH_KEY, and that the key "
                "has Apple Push Notifications service enabled."
            )
        # ERROR, not the tick's WARNING: until someone fixes this, no reminder
        # reaches any iOS device.
        logger.error("APNs %s rejected our credentials (403 %s). %s", environment, reason or "no reason given", hint)
    elif status == 400 and reason in ("BadTopic", "MissingTopic", "TopicDisallowed", "DeviceTokenNotForTopic"):
        logger.error(
            "APNs %s rejected the topic %r (%s). APNS_BUNDLE_ID must be the app's bundle id.",
            environment, APNS_BUNDLE_ID, reason,
        )
    return ApnsError(status, reason, environment)


def send_apns(subscription: dict, payload: dict, client=None, now: Optional[float] = None) -> Optional[dict]:
    """Deliver one notification through APNs.

    Returns None normally, or the subscription to store in place of the one
    passed in when the send found out which environment its token belongs to.
    Raises SubscriptionGone when Apple says the token is dead, and ApnsError
    for everything that is not the device's fault.

    `client` (an httpx.Client) and `now` (epoch seconds) are injectable so
    validate_apns.py can run without a network or a real clock.
    """
    if not apns_configured():
        raise RuntimeError("APNs credentials not configured")
    token = subscription.get("token")
    if not valid_apns_token(token):
        # Only /push/subscribe writes these and it validates, so this is a
        # hand-edited or corrupted record. Apple would say BadDeviceToken.
        raise SubscriptionGone("stored APNs device token is malformed")
    client = client or _apns_http_client()
    now = time.time() if now is None else now

    jwt = apns_jwt(now)
    headers = {
        "authorization": f"bearer {jwt}",
        "apns-topic": APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        # 10 = deliver immediately. The whole point is "leave now".
        "apns-priority": "10",
        "apns-expiration": str(int(now) + PUSH_TTL_S),
        "content-type": "application/json",
    }
    collapse_id = _apns_collapse_id(payload)
    if collapse_id:
        headers["apns-collapse-id"] = collapse_id
    body = json.dumps(apns_payload(payload)).encode("utf-8")

    stored = subscription.get("environment")
    first = stored if stored in APNS_HOSTS else _apns_default_environment()
    status, reason = _apns_post(client, first, token, headers, body)
    if status == 200:
        return None

    if status == 400 and reason == "BadDeviceToken":
        # Tokens are per-environment: a build run from Xcode gets a sandbox
        # token, TestFlight and the App Store a production one, and each host
        # answers BadDeviceToken to the other's. The same key signs for both,
        # so ask the other host before concluding the token is dead.
        other = "sandbox" if first == "production" else "production"
        status, reason = _apns_post(client, other, token, headers, body)
        if status == 200:
            logger.info("APNs device token belongs to %s, not %s; remembering that", other, first)
            return {**subscription, "environment": other}
        if _apns_token_dead(status, reason):
            raise SubscriptionGone(f"APNs device token rejected by both environments (last: {status} {reason})")
        raise _apns_failure(status, reason, other, jwt)

    if _apns_token_dead(status, reason):
        raise SubscriptionGone(f"APNs {first} answered {status} {reason}")
    raise _apns_failure(status, reason, first, jwt)


def send_notification(subscription: dict, payload: dict) -> Optional[dict]:
    """Deliver through whichever transport the subscription belongs to.

    What run_tick calls by default. The return value is send_apns's: a
    replacement subscription to store, or None.
    """
    if is_apns_subscription(subscription):
        return send_apns(subscription, payload)
    send_push(subscription, payload)
    return None


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
    """The payload the service worker turns into showNotification().

    Transport-neutral: send_apns reshapes this same dict for iOS.
    """
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
    send: Callable[[dict, dict], Optional[dict]] = send_notification,
    planner: Optional[Callable[..., dict]] = None,
) -> dict:
    """One pass over every reminder. Returns counters for logging/tests.

    `send` and `planner` are injectable so validate_push.py can run a tick
    without VAPID keys or the live planner. `send` may return a dict: the
    subscription to store in place of the one it was given (see send_apns).
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
                    origin_place=r.get("origin_place"),
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

            # Clock times in the text are Boston times. arrive_by arrives from
            # the browser in UTC, so its own zone is the wrong one to show.
            payload = build_notification(r, recommended, CAMPUS_TZ)
            try:
                learned = send(subscription, payload)
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
            if isinstance(learned, dict) and learned != subscription:
                _remember_subscription(store, client_id, subscription, learned)
                subscription = learned

    return stats


def _remember_subscription(store: Store, client_id: str, sent_to: dict, learned: dict) -> None:
    """Store what a send learned about a subscription, unless it has moved on."""
    try:
        # The rider may have re-registered or switched reminders off while the
        # notification was in flight; what we learned was about a token that
        # is no longer theirs, and writing it back would undo their change.
        if store.get_subscription(client_id) != sent_to:
            return
        store.set_subscription(client_id, learned)
    except Exception as e:
        # The notification went out. Losing this only costs the next send one
        # wasted request; it must not turn a delivered reminder into an error.
        logger.warning("Could not update push subscription for %s", client_id, exc_info=e)


async def reminder_scheduler(store: Store, interval_s: int = SCHEDULER_INTERVAL_S):
    """Background loop; start with asyncio.create_task at app startup.

    Runs whichever transports are configured — either one alone is enough,
    and with neither the tick still expires old reminders.
    """
    logger.info("Reminder transports: web_push=%s apns=%s", vapid_configured(), apns_configured())
    while True:
        try:
            stats = await asyncio.to_thread(run_tick, store)
            if stats["sent"] or stats["gone"] or stats["errors"]:
                logger.info("Reminder tick", extra=stats)
        except Exception as e:
            logger.warning("Reminder scheduler error", exc_info=e)
        await asyncio.sleep(interval_s)
