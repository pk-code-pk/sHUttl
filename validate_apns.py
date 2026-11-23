"""
Sanity check for the APNs half of reminders, without Apple, a phone or a network.

    python validate_apns.py

Signs with a throwaway P-256 key generated here and answers Apple's side of
the conversation from a mock HTTP transport, then asserts:
  - the provider JWT has the header and claims Apple wants, verifies against
    the key's public half, and is reused rather than re-minted on every send
  - the request goes to the right host with the right headers and payload
  - 410 drops the subscription; DeviceTokenNotForTopic, which is a wrong
    APNS_BUNDLE_ID and not a dead device, keeps it and says so in the log
  - BadDeviceToken tries the other environment once, and a tick stores the one
    that worked so the next send goes straight there
  - 403 / 429 / 5xx / a network error never drop the subscription
  - /push/subscribe takes a native body, refuses malformed ones, and still
    takes a browser's exactly as before
  - /push/config says what is configured
  - PUT /reminders keeps a reminder's origin_place all the way to the planner
  - the app's origin passes CORS even when the allow-list does not name it
"""

import base64
import json
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

# Both must be decided before main is imported. No REDIS_URL, so nothing here
# can touch a real store; and an explicit CORS list that leaves the app's
# origin out, which is the production case the CORS check is about.
os.environ.pop("REDIS_URL", None)
os.environ["CORS_ALLOWED_ORIGINS"] = "https://shuttl.live"

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

import reminders as rm

KEY_ID = "ABC123DEFG"
TEAM_ID = "TEAM123456"
BUNDLE_ID = "live.shuttl.app"
TOKEN = "0123456789abcdef" * 4  # 32 bytes, as iOS hands out today
PROD = "api.push.apple.com"
SANDBOX = "api.sandbox.push.apple.com"
T0 = 1_800_000_000.0  # any fixed epoch second


class _Capture(logging.Handler):
    """Collects reminders.py's log records so the expected errors can be
    asserted on instead of scrolling past as noise."""

    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record):
        self.records.append(record)

    def errors(self) -> list[str]:
        return [r.getMessage() for r in self.records if r.levelno >= logging.ERROR]


class FakeApns:
    """Apple's side: answers per host, and remembers what it was asked."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.answers: dict[str, tuple[int, str | None]] = {}

    def answer(self, host: str, status: int, reason: str | None = None) -> None:
        self.answers[host] = (status, reason)

    def reset(self) -> None:
        self.requests.clear()
        self.answers.clear()

    def hosts(self) -> list[str]:
        return [r.url.host for r in self.requests]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        status, reason = self.answers.get(request.url.host, (200, None))
        if status == 200:
            return httpx.Response(200)
        return httpx.Response(status, json={"reason": reason} if reason else None)


def _unb64url(segment: str) -> bytes:
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _configure(pem: str | None, environment: str = "production") -> None:
    rm.APNS_KEY_ID = KEY_ID if pem else None
    rm.APNS_TEAM_ID = TEAM_ID if pem else None
    rm.APNS_AUTH_KEY = pem
    rm.APNS_BUNDLE_ID = BUNDLE_ID
    rm.APNS_ENVIRONMENT = environment
    rm._apns_jwt_cache = None


def _planner_for(be_at_stop_by: datetime):
    def planner(dest, arrive_by, lat=None, lng=None, origin_stop_id=None, **kwargs):
        return {
            "recommended": {
                "route_id": "qye",
                "route_name": "QYE",
                "board_stop": {"name": "Widener Gate"},
                "be_at_stop_by": be_at_stop_by.isoformat(),
                "alight_stop": {"name": "Science Center"},
            }
        }
    return planner


def check_jwt(private_key, pem: str, log: _Capture) -> None:
    _configure(None)
    assert not rm.apns_configured(), "configured with nothing set"

    # Set but not a key: must read as "not configured", loudly, not as a
    # server that will accept tokens it can never send to.
    _configure("-----BEGIN PRIVATE KEY-----\\nnot a key\\n-----END PRIVATE KEY-----")
    assert not rm.apns_configured(), "garbage key counted as configured"
    assert any("APNS_AUTH_KEY" in m for m in log.errors()), "unreadable key was not reported"

    # The way the key is actually pasted into a dashboard: one line, literal \n.
    _configure(pem.replace("\n", "\\n"))
    assert rm.apns_configured(), "key with literal \\n separators was not accepted"
    # The same, from a .p8 that passed through a Windows editor on the way.
    _configure(pem.replace("\n", "\\r\\n"))
    assert rm.apns_configured(), "key with literal \\r\\n separators was not accepted"
    _configure(pem)
    assert rm.apns_configured()

    token = rm.apns_jwt(T0)
    assert "=" not in token, "JWT segments must be unpadded base64url"
    header_b64, claims_b64, sig_b64 = token.split(".")
    assert json.loads(_unb64url(header_b64)) == {"alg": "ES256", "kid": KEY_ID}
    assert json.loads(_unb64url(claims_b64)) == {"iss": TEAM_ID, "iat": int(T0)}
    signature = _unb64url(sig_b64)
    assert len(signature) == 64, "ES256 signature must be raw r||s, not DER"
    r, s = int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
    try:
        private_key.public_key().verify(
            encode_dss_signature(r, s),
            f"{header_b64}.{claims_b64}".encode("ascii"),
            ec.ECDSA(hashes.SHA256()),
        )
    except InvalidSignature:
        raise AssertionError("JWT signature does not verify against the public key")

    # Reused inside the window; Apple throttles a server that re-mints per send.
    assert rm.apns_jwt(T0 + 19 * 60) == token
    assert rm.apns_jwt(T0 + 39 * 60) == token
    # ...and replaced well before Apple's 60-minute limit.
    fresh = rm.apns_jwt(T0 + 41 * 60)
    assert fresh != token
    assert json.loads(_unb64url(fresh.split(".")[1]))["iat"] == int(T0 + 41 * 60)
    assert rm.apns_jwt(T0 + 60 * 60) == fresh

    # A token Apple called expired is replaced early, but not inside 20 minutes.
    _configure(pem)
    token = rm.apns_jwt(T0)
    rm._apns_jwt_rejected(token)
    assert rm.apns_jwt(T0 + 19 * 60) == token, "re-minted inside Apple's 20-minute floor"
    assert rm.apns_jwt(T0 + 21 * 60) != token, "rejected token kept past the floor"


def check_request(apns: FakeApns, client: httpx.Client, pem: str) -> None:
    _configure(pem)
    reminder = rm.normalize_reminder({
        "id": "cs50-2026-09-10",
        "title": "CS50",
        "arrive_by": "2026-09-10T10:30:00+00:00",
        "dest": "Science Center",
    })
    recommended = _planner_for(datetime(2026, 9, 10, 10, 4, tzinfo=timezone.utc))(None, None)["recommended"]
    payload = rm.build_notification(reminder, recommended, timezone.utc)

    # The plugin reports uppercase hex; one device must not be stored twice.
    sub = rm.apns_subscription(TOKEN.upper())
    assert sub == {"type": "apns", "token": TOKEN}, sub

    assert rm.send_apns(sub, payload, client=client, now=T0) is None
    assert len(apns.requests) == 1
    req = apns.requests[0]
    assert req.method == "POST"
    assert str(req.url) == f"https://{PROD}/3/device/{TOKEN}", req.url
    assert req.headers["authorization"] == f"bearer {rm.apns_jwt(T0)}"
    assert req.headers["apns-topic"] == BUNDLE_ID
    assert req.headers["apns-push-type"] == "alert"
    assert req.headers["apns-priority"] == "10"
    assert req.headers["apns-expiration"] == str(int(T0) + 15 * 60)
    assert req.headers["apns-collapse-id"] == "cs50-2026-09-10"
    body = json.loads(req.content)
    assert body == {
        "aps": {
            "alert": {"title": payload["title"], "body": payload["body"]},
            "sound": "default",
        },
        "url": "/",
        "reminder_id": "cs50-2026-09-10",
    }, body
    assert body["aps"]["alert"]["title"] == "Leave now for QYE"
    print("apns body:", json.dumps(body))

    # APNS_ENVIRONMENT=sandbox goes to the sandbox host.
    apns.reset()
    _configure(pem, environment="sandbox")
    rm.send_apns(sub, payload, client=client, now=T0)
    assert apns.hosts() == [SANDBOX], apns.hosts()

    # An id Apple or an HTTP header cannot carry is left off, not sent broken.
    _configure(pem)
    for awkward in ("x" * 65, "café-101", "two\nlines"):
        apns.reset()
        rm.send_apns(sub, {**payload, "data": {"url": "/", "reminder_id": awkward}}, client=client, now=T0)
        assert "apns-collapse-id" not in apns.requests[0].headers, awkward
        assert json.loads(apns.requests[0].content)["reminder_id"] == awkward
    apns.reset()
    rm.send_apns(sub, {**payload, "data": {"url": "/", "reminder_id": "x" * 64}}, client=client, now=T0)
    assert apns.requests[0].headers["apns-collapse-id"] == "x" * 64

    # A record that could not have come from /push/subscribe never reaches a URL.
    apns.reset()
    try:
        rm.send_apns({"type": "apns", "token": "../../evil"}, payload, client=client, now=T0)
        raise AssertionError("malformed stored token was sent")
    except rm.SubscriptionGone:
        pass
    assert not apns.requests

    # The real client needs h2; building it is the check that httpx[http2] is
    # installed. Nothing is sent. How it is built is asserted too, because
    # every other check here talks to the mock transport: without these a
    # client that lost http2=True, or its timeout, would pass this file and
    # then fail every real send — APNs speaks nothing but HTTP/2 — or hang
    # the scheduler on one stuck connection.
    built: list[dict] = []
    real_client_class = httpx.Client

    def recording_client(*args, **kwargs):
        built.append(kwargs)
        return real_client_class(*args, **kwargs)

    rm._apns_client = None
    httpx.Client = recording_client
    try:
        real = rm._apns_http_client()
    finally:
        httpx.Client = real_client_class
    assert isinstance(real, httpx.Client)
    assert len(built) == 1 and built[0].get("http2") is True, f"APNs client must be built with http2=True: {built}"
    timeouts = real.timeout.as_dict()
    assert all(isinstance(t, (int, float)) and 0 < t <= 30 for t in timeouts.values()), \
        f"APNs client needs a finite timeout: {timeouts}"
    real.close()
    rm._apns_client = None


def check_errors(apns: FakeApns, client: httpx.Client, pem: str, log: _Capture) -> None:
    _configure(pem)
    sub = rm.apns_subscription(TOKEN)
    payload = {"title": "t", "body": "b", "data": {"url": "/", "reminder_id": "r1"}}

    def send(subscription=sub):
        return rm.send_apns(subscription, payload, client=client, now=T0)

    def assert_gone(what: str, expected_hosts: list[str]) -> None:
        try:
            send()
        except rm.SubscriptionGone:
            assert apns.hosts() == expected_hosts, (what, apns.hosts())
            return
        raise AssertionError(f"{what}: expected SubscriptionGone")

    def assert_kept(what: str, status: int) -> None:
        try:
            send()
        except rm.SubscriptionGone:
            raise AssertionError(f"{what}: a server-side failure must not drop the subscription")
        except rm.ApnsError as e:
            assert e.status == status, (what, e.status)
            return
        raise AssertionError(f"{what}: expected ApnsError")

    # Dead token: gone, and no second guess at the other environment.
    apns.reset()
    apns.answer(PROD, 410, "Unregistered")
    assert_gone("410", [PROD])


    # A debug build's sandbox token against a production server.
    apns.reset()
    apns.answer(PROD, 400, "BadDeviceToken")
    learned = send()
    assert apns.hosts() == [PROD, SANDBOX], apns.hosts()
    assert learned == {"type": "apns", "token": TOKEN, "environment": "sandbox"}, learned
    assert sub == {"type": "apns", "token": TOKEN}, "send_apns mutated its argument"

    # Once learned, straight there.
    apns.reset()
    apns.answer(PROD, 400, "BadDeviceToken")
    assert send(learned) is None
    assert apns.hosts() == [SANDBOX], apns.hosts()

    # And the other way round: a remembered environment that stopped being true.
    apns.reset()
    apns.answer(SANDBOX, 400, "BadDeviceToken")
    assert send(learned) == {"type": "apns", "token": TOKEN, "environment": "production"}
    assert apns.hosts() == [SANDBOX, PROD], apns.hosts()

    # Bad everywhere: gone, after exactly one retry.
    apns.reset()
    apns.answer(PROD, 400, "BadDeviceToken")
    apns.answer(SANDBOX, 400, "BadDeviceToken")
    assert_gone("BadDeviceToken in both", [PROD, SANDBOX])

    # The other environment being broken says nothing about the token.
    apns.reset()
    apns.answer(PROD, 400, "BadDeviceToken")
    apns.answer(SANDBOX, 503, "ServiceUnavailable")
    assert_kept("BadDeviceToken then 503", 503)

    # Ours to fix, never the device's.
    log.records.clear()
    apns.reset()
    apns.answer(PROD, 403, "InvalidProviderToken")
    assert_kept("403", 403)
    assert apns.hosts() == [PROD], "403 must not be retried against the other environment"
    assert any("APNS_KEY_ID" in m and "403" in m for m in log.errors()), "403 was not logged as a credentials problem"

    for status, reason in ((429, "TooManyRequests"), (500, "InternalServerError"), (503, None), (400, "BadTopic")):
        apns.reset()
        apns.answer(PROD, status, reason)
        assert_kept(f"{status} {reason}", status)

    # A token that is not for our topic is a wrong APNS_BUNDLE_ID: every
    # device answers the same way, so none of them may be dropped for it, and
    # the log has to name the variable or nobody will know why nothing sends.
    log.records.clear()
    apns.reset()
    apns.answer(PROD, 400, "DeviceTokenNotForTopic")
    assert_kept("DeviceTokenNotForTopic", 400)
    assert apns.hosts() == [PROD], "a topic mismatch must not be retried against the other environment"
    assert any("APNS_BUNDLE_ID" in m and "DeviceTokenNotForTopic" in m for m in log.errors()), \
        "DeviceTokenNotForTopic was not logged as a bundle id problem"

    # Apple saying our JWT is stale flags it for early replacement.
    _configure(pem)
    apns.reset()
    apns.answer(PROD, 403, "ExpiredProviderToken")
    assert_kept("ExpiredProviderToken", 403)
    assert rm._apns_jwt_cache["rejected"] is True

    # No answer at all is an error like any other, not a dead token.
    def unreachable(request):
        raise httpx.ConnectError("no route to Apple", request=request)

    with httpx.Client(transport=httpx.MockTransport(unreachable)) as offline:
        try:
            rm.send_apns(sub, payload, client=offline, now=T0)
            raise AssertionError("a network failure was swallowed")
        except rm.SubscriptionGone:
            raise AssertionError("a network failure must not drop the subscription")
        except httpx.HTTPError:
            pass

    _configure(None)
    try:
        send()
        raise AssertionError("sent without credentials")
    except rm.SubscriptionGone:
        raise AssertionError("missing credentials must not drop the subscription")
    except RuntimeError:
        pass


def check_tick(apns: FakeApns, client: httpx.Client, pem: str) -> None:
    _configure(pem)
    tmpdir = tempfile.mkdtemp(prefix="shuttl_apns_")
    store = rm.Store(redis_client=None, path=os.path.join(tmpdir, "reminders.json"))

    now = datetime(2026, 9, 10, 9, 55, tzinfo=timezone.utc)
    arrive_by = now + timedelta(minutes=35)
    planner = _planner_for(now + timedelta(minutes=9))  # lead 10 -> already due

    def add_reminder(rid: str) -> None:
        store.set_reminders("ios", [rm.normalize_reminder({
            "id": rid, "title": "CS50", "arrive_by": arrive_by.isoformat(), "dest": "Science Center",
        })])

    def send(sub, payload):
        return rm.send_apns(sub, payload, client=client, now=T0)

    store.set_subscription("ios", rm.apns_subscription(TOKEN))

    # 403: counted as an error, subscription kept, reminder left to retry.
    add_reminder("r1")
    apns.reset()
    apns.answer(PROD, 403, "InvalidProviderToken")
    stats = rm.run_tick(store, now=now, send=send, planner=planner)
    assert stats["errors"] == 1 and stats["sent"] == 0 and stats["gone"] == 0, stats
    assert store.get_subscription("ios") == {"type": "apns", "token": TOKEN}, "403 deleted the subscription"
    assert store.get_reminders("ios")[0].get("sent_at") is None, "marked sent despite a 403"

    # Wrong environment: delivered through the other one, and remembered.
    apns.reset()
    apns.answer(PROD, 400, "BadDeviceToken")
    stats = rm.run_tick(store, now=now, send=send, planner=planner)
    assert stats["sent"] == 1 and stats["gone"] == 0 and stats["errors"] == 0, stats
    assert apns.hosts() == [PROD, SANDBOX], apns.hosts()
    assert store.get_subscription("ios") == {"type": "apns", "token": TOKEN, "environment": "sandbox"}
    assert store.get_reminders("ios")[0].get("sent_at"), "reminder not marked sent"

    # The next reminder goes straight to the environment that worked.
    add_reminder("r2")
    apns.reset()
    apns.answer(PROD, 400, "BadDeviceToken")
    stats = rm.run_tick(store, now=now, send=send, planner=planner)
    assert stats["sent"] == 1, stats
    assert apns.hosts() == [SANDBOX], apns.hosts()

    # 410 removes it.
    add_reminder("r3")
    apns.reset()
    apns.answer(SANDBOX, 410, "Unregistered")
    stats = rm.run_tick(store, now=now, send=send, planner=planner)
    assert stats["gone"] == 1 and stats["sent"] == 0, stats
    assert store.get_subscription("ios") is None, "410 subscription not removed"

    # What a send learned must not overwrite a subscription that changed
    # while the notification was in flight.
    other_token = "f" * 64
    store.set_subscription("ios", rm.apns_subscription(TOKEN))
    add_reminder("r4")

    def send_then_reregister(sub, payload):
        store.set_subscription("ios", rm.apns_subscription(other_token))
        return {**sub, "environment": "sandbox"}

    stats = rm.run_tick(store, now=now, send=send_then_reregister, planner=planner)
    assert stats["sent"] == 1, stats
    assert store.get_subscription("ios") == {"type": "apns", "token": other_token}, "stale write clobbered a re-registration"

    # The default send picks the transport from the subscription. Swapped
    # here for recorders: the default is what production runs.
    calls: list[tuple[str, dict]] = []
    real_web, real_apns = rm.send_push, rm.send_apns
    rm.send_push = lambda sub, payload: calls.append(("web", sub))
    rm.send_apns = lambda sub, payload: calls.append(("apns", sub))
    try:
        web_sub = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "BFAKE", "auth": "FAKE"}}
        store.set_subscription("web", web_sub)
        store.set_reminders("web", [rm.normalize_reminder({
            "id": "w1", "title": "Math 21a", "arrive_by": arrive_by.isoformat(), "dest": "Science Center",
        })])
        store.set_subscription("ios", rm.apns_subscription(TOKEN))
        add_reminder("r5")
        stats = rm.run_tick(store, now=now, planner=planner)
        assert stats["sent"] == 2 and stats["errors"] == 0, stats
        assert sorted(kind for kind, _ in calls) == ["apns", "web"], calls
        assert dict(calls)["web"] == web_sub and dict(calls)["apns"]["token"] == TOKEN

        # A browser subscription dressed up as a native one still goes to Web
        # Push: only /push/subscribe's own dicts are ever sent to Apple.
        calls.clear()
        rm.send_notification({**web_sub, "type": "apns", "token": TOKEN}, {})
        assert [kind for kind, _ in calls] == ["web"], calls
    finally:
        rm.send_push, rm.send_apns = real_web, real_apns


def check_http(pem: str) -> None:
    import main
    from fastapi.testclient import TestClient

    tmpdir = tempfile.mkdtemp(prefix="shuttl_apns_http_")
    store = rm.Store(redis_client=None, path=os.path.join(tmpdir, "reminders.json"))
    real_store = main.REMINDER_STORE
    real_vapid = (rm.VAPID_PUBLIC_KEY, rm.VAPID_PRIVATE_KEY, rm.VAPID_CLAIMS_EMAIL)
    main.REMINDER_STORE = store
    # Not used as a context manager, so the startup pollers never run.
    http = TestClient(main.app)
    try:
        # -- /push/config ------------------------------------------------------
        rm.VAPID_PUBLIC_KEY = rm.VAPID_PRIVATE_KEY = rm.VAPID_CLAIMS_EMAIL = None
        _configure(None)
        res = http.get("/push/config")
        assert res.status_code == 200
        assert res.json() == {"web_push": False, "vapid_public_key": None, "apns": False}, res.json()

        _configure(pem)
        assert http.get("/push/config").json() == {"web_push": False, "vapid_public_key": None, "apns": True}
        # The web client's endpoint is untouched by any of this.
        assert http.get("/push/public_key").status_code == 404

        rm.VAPID_PUBLIC_KEY, rm.VAPID_PRIVATE_KEY, rm.VAPID_CLAIMS_EMAIL = "BPUBLIC", "private", "ops@example.com"
        assert http.get("/push/config").json() == {"web_push": True, "vapid_public_key": "BPUBLIC", "apns": True}
        assert http.get("/push/public_key").json() == {"public_key": "BPUBLIC"}
        _configure(None)
        assert http.get("/push/config").json() == {"web_push": True, "vapid_public_key": "BPUBLIC", "apns": False}

        # -- /push/subscribe, native -------------------------------------------
        res = http.post("/push/subscribe", json={"apns": {"token": TOKEN.upper()}, "client_id": "ios"})
        assert res.status_code == 200 and res.json() == {"ok": True}, res.text
        assert store.get_subscription("ios") == {"type": "apns", "token": TOKEN}
        assert http.get("/reminders", params={"client_id": "ios"}).json()["subscribed"] is True

        web_sub = {"endpoint": "https://push.example/abc", "expirationTime": None, "keys": {"p256dh": "BFAKE", "auth": "FAKE"}}
        bad_bodies = {
            "not hex": {"apns": {"token": "z" * 64}, "client_id": "bad"},
            "too short": {"apns": {"token": "a" * 62}, "client_id": "bad"},
            "too long": {"apns": {"token": "a" * 202}, "client_id": "bad"},
            "odd length": {"apns": {"token": "a" * 65}, "client_id": "bad"},
            "path in token": {"apns": {"token": "a" * 60 + "/../x"}, "client_id": "bad"},
            "trailing newline": {"apns": {"token": TOKEN + "\n"}, "client_id": "bad"},
            "empty token": {"apns": {"token": ""}, "client_id": "bad"},
            "no token": {"apns": {}, "client_id": "bad"},
            "token not a string": {"apns": {"token": 12345}, "client_id": "bad"},
            "apns not an object": {"apns": TOKEN, "client_id": "bad"},
            "both transports": {"apns": {"token": TOKEN}, "subscription": web_sub, "client_id": "bad"},
            "neither transport": {"client_id": "bad"},
            "no client_id": {"apns": {"token": TOKEN}},
        }
        for what, body in bad_bodies.items():
            res = http.post("/push/subscribe", json=body)
            assert res.status_code == 422, (what, res.status_code, res.text)
            assert store.get_subscription("bad") is None, what
        for edge in ("a" * 64, "A" * 200):
            assert http.post("/push/subscribe", json={"apns": {"token": edge}, "client_id": "edge"}).status_code == 200, len(edge)

        # -- one slot per client, whichever transport --------------------------
        res = http.post("/push/subscribe", json={"subscription": web_sub, "client_id": "ios"})
        assert res.status_code == 200 and res.json() == {"ok": True}, res.text
        assert store.get_subscription("ios") == web_sub, "web subscription must be stored verbatim"
        res = http.post("/push/subscribe", json={"subscription": {"endpoint": "https://push.example/abc"}, "client_id": "ios"})
        assert res.status_code == 400, "web validation changed"
        res = http.post("/push/subscribe", json={"apns": {"token": TOKEN}, "client_id": "ios"})
        assert res.status_code == 200
        assert store.get_subscription("ios") == {"type": "apns", "token": TOKEN}

        # The app re-registers on every launch; the same token keeps what a
        # send learned about it, a new token starts clean.
        store.set_subscription("ios", {"type": "apns", "token": TOKEN, "environment": "sandbox"})
        http.post("/push/subscribe", json={"apns": {"token": TOKEN}, "client_id": "ios"})
        assert store.get_subscription("ios") == {"type": "apns", "token": TOKEN, "environment": "sandbox"}
        http.post("/push/subscribe", json={"apns": {"token": "b" * 64}, "client_id": "ios"})
        assert store.get_subscription("ios") == {"type": "apns", "token": "b" * 64}

        res = http.delete("/push/subscribe", params={"client_id": "ios"})
        assert res.status_code == 200 and store.get_subscription("ios") is None

        # -- /reminders --------------------------------------------------------
        # A class reached straight from the previous one is sent with only the
        # previous room as its origin. If the request model drops that field
        # the stored reminder has no origin, the planner refuses it on every
        # tick, and the reminder never fires on either transport.
        chained = {
            "id": "chained", "title": "Ec 10", "dest": "Sanders Theatre",
            "arrive_by": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
            "origin_place": "Sever Hall", "origin_stop_id": None,
            "origin_lat": None, "origin_lng": None, "lead_minutes": 10,
        }
        res = http.put("/reminders", json={"client_id": "ios", "reminders": [chained]})
        assert res.status_code == 200, res.text
        stored = store.get_reminders("ios")
        assert len(stored) == 1 and stored[0]["origin_place"] == "Sever Hall", stored
        asked: list[dict] = []

        def planner(**kwargs):
            asked.append(kwargs)
            return {}

        rm.run_tick(store, send=lambda sub, payload: None, planner=planner)
        assert [a.get("origin_place") for a in asked] == ["Sever Hall"], asked
        store.set_reminders("ios", [])

        # -- CORS --------------------------------------------------------------
        # CORS_ALLOWED_ORIGINS was set to the website alone at the top of this
        # file; the app must get in anyway, and nobody else.
        def preflight(origin: str) -> httpx.Response:
            return http.options("/push/subscribe", headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            })

        for origin in ("capacitor://localhost", "https://shuttl.live"):
            res = preflight(origin)
            assert res.status_code == 200, (origin, res.status_code)
            assert res.headers.get("access-control-allow-origin") == origin, (origin, dict(res.headers))
        res = http.get("/push/config", headers={"Origin": "capacitor://localhost"})
        assert res.headers.get("access-control-allow-origin") == "capacitor://localhost"
        res = preflight("https://evil.example")
        assert res.status_code == 400 and "access-control-allow-origin" not in res.headers
    finally:
        main.REMINDER_STORE = real_store
        rm.VAPID_PUBLIC_KEY, rm.VAPID_PRIVATE_KEY, rm.VAPID_CLAIMS_EMAIL = real_vapid


def main() -> int:
    log = _Capture()
    rm.logger.addHandler(log)
    rm.logger.propagate = False

    # What Apple issues: an unencrypted PKCS#8 P-256 key in PEM (the .p8 file).
    private_key = ec.generate_private_key(ec.SECP256R1())
    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")

    apns = FakeApns()
    with httpx.Client(transport=httpx.MockTransport(apns.handler)) as client:
        check_jwt(private_key, pem, log)
        check_request(apns, client, pem)
        check_errors(apns, client, pem, log)
        check_tick(apns, client, pem)
    check_http(pem)

    print("validate_apns: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
