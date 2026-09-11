"""
Sanity check for the reminder scheduler without VAPID keys or a browser.

    python validate_push.py

Stores a fake subscription + reminder in a temp JSON store, runs one tick with
push sending mocked and a stub planner, and asserts:
  - before the lead window opens, nothing is sent and nothing is marked
  - inside the window, exactly one push goes out and the reminder is marked sent
  - a second tick does not re-send
  - a dead endpoint (410) removes the subscription
  - a reminder whose arrive_by has passed is dropped
  - a missing planner is a no-op, not a crash
"""

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import reminders as rm


def _planner_for(be_at_stop_by: datetime, depart_at: datetime, arrive_at: datetime):
    def planner(dest, arrive_by, lat=None, lng=None, origin_stop_id=None):
        return {
            "recommended": {
                "route_id": "qye",
                "route_name": "QYE",
                "board_stop": {"name": "Widener Gate"},
                "be_at_stop_by": be_at_stop_by.isoformat(),
                "depart_at": depart_at.isoformat(),
                "arrive_at": arrive_at.isoformat(),
                "alight_stop": {"name": "Science Center"},
            }
        }
    return planner


def main() -> int:
    tmpdir = tempfile.mkdtemp(prefix="shuttl_push_")
    store = rm.Store(redis_client=None, path=os.path.join(tmpdir, "reminders.json"))

    now = datetime(2026, 9, 10, 9, 50, tzinfo=timezone.utc)
    arrive_by = now + timedelta(minutes=40)   # class at 10:30
    be_at = now + timedelta(minutes=14)       # be at stop 10:04
    depart = be_at + timedelta(minutes=2)
    arrive = depart + timedelta(minutes=8)
    planner = _planner_for(be_at, depart, arrive)

    fake_sub = {
        "endpoint": "https://push.example/abc",
        "keys": {"p256dh": "BFAKE", "auth": "FAKE"},
    }
    store.set_subscription("c1", fake_sub)
    store.set_reminders("c1", [rm.normalize_reminder({
        "id": "r1",
        "title": "CS50",
        "arrive_by": arrive_by.isoformat(),
        "dest": "Science Center",
        "lead_minutes": 10,
    })])

    sent: list[tuple[dict, dict]] = []

    def fake_send(sub, payload):
        sent.append((sub, payload))

    # 1. Too early: fire_at = 10:04 - 10 = 9:54, now is 9:50.
    stats = rm.run_tick(store, now=now, send=fake_send, planner=planner)
    assert stats["sent"] == 0 and not sent, stats
    assert store.get_reminders("c1")[0].get("sent_at") is None, "marked sent too early"

    # 2. Inside the window: 9:55.
    later = now + timedelta(minutes=5)
    stats = rm.run_tick(store, now=later, send=fake_send, planner=planner)
    assert stats["sent"] == 1 and len(sent) == 1, stats
    sub, payload = sent[0]
    assert sub == fake_sub
    assert payload["title"] == "Leave now for QYE", payload["title"]
    assert payload["data"] == {"url": "/", "reminder_id": "r1"}, payload["data"]
    assert "Widener Gate" in payload["body"] and "CS50" in payload["body"], payload["body"]
    assert store.get_reminders("c1")[0].get("sent_at"), "reminder not marked sent"
    print("body:", payload["body"])

    # 3. Same tick again must not double-send.
    stats = rm.run_tick(store, now=later, send=fake_send, planner=planner)
    assert stats["sent"] == 0 and len(sent) == 1, "re-sent a reminder already marked sent"

    # 4. Dead endpoint removes the subscription.
    store.set_reminders("c1", [rm.normalize_reminder({
        "id": "r2", "title": "Math 21a", "arrive_by": arrive_by.isoformat(), "dest": "Science Center",
    })])

    def gone_send(sub, payload):
        raise rm.SubscriptionGone("410")

    stats = rm.run_tick(store, now=later, send=gone_send, planner=planner)
    assert stats["gone"] == 1, stats
    assert store.get_subscription("c1") is None, "410 subscription not removed"
    assert store.get_reminders("c1")[0].get("sent_at") is None, "marked sent despite failed delivery"

    # 5. Expired reminders are dropped.
    store.set_reminders("c2", [rm.normalize_reminder({
        "id": "old", "title": "Yesterday", "arrive_by": (now - timedelta(hours=1)).isoformat(), "dest": "x",
    })])
    stats = rm.run_tick(store, now=now, send=fake_send, planner=planner)
    assert stats["expired"] == 1 and store.get_reminders("c2") == [], stats

    # 6. No planner available: nothing sent, nothing raised.
    rm._planner_warned = False
    stats = rm.run_tick(store, now=later, send=fake_send, planner=None)
    assert stats["sent"] == 0

    # 7. normalize_reminder rejects garbage.
    assert rm.normalize_reminder({"id": "x", "arrive_by": "not a date"}) is None
    assert rm.normalize_reminder({"arrive_by": arrive_by.isoformat()}) is None

    print("validate_push: OK (store backend =", store.backend + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())
