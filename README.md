<div align="center">
    <img src="logo.svg" height="120" alt="sHUttl Logo" />
    <br/>
    <h1>sHUttl</h1>
    <br/>
    High-precision, real-time shuttle navigation platform.
    <br/><br/>
    <a href="#about">About</a>
    &nbsp;&bull;&nbsp;
    <a href="#architecture">Architecture</a>
    &nbsp;&bull;&nbsp;
    <a href="#research">Research</a>
    &nbsp;&bull;&nbsp;
    <a href="#eta-accuracy">ETA Accuracy</a>
    &nbsp;&bull;&nbsp;
    <a href="#tech-stack">Tech Stack</a>
    &nbsp;&bull;&nbsp;
    <a href="#running">Running</a>
</div>

## About

sHUttl is a navigation system for university transit networks. It provides
door-to-door routing for the Harvard University shuttle system by combining live
vehicle telemetry with the operator's published route structure.

The platform is not a vehicle tracker. It implements a routing engine that plans
multi-leg journeys, handles transfers, and accounts for live service conditions,
then reports how accurate its own arrival predictions are.

## Data source

Harvard retired PassioGO on 2026-07-01 and moved rider-facing tracking to
Citymapper. The system behind it is a Ride Systems tracker at
`shuttle.harvard.edu`, and that is what sHUttl reads. The migration is described
in [`ridesystems_client.py`](ridesystems_client.py); the short version is three
undocumented, keyless JSON endpoints:

| Endpoint | Provides |
| :--- | :--- |
| `api/transit/MapData` | Platforms, routes, per-route pattern geometry |
| `api/transit/RoutePosition` | Live vehicle positions, one request per route |
| `api/transit/PlatformET` | The operator's own arrival predictions |

The previous Passio feed now reports zero vehicles, and its GTFS export contains
no service active after 2026-08-21 despite advertising a rolling validity
window — so there is no static timetable for Harvard shuttles in any machine
readable form. Harvard publishes schedules as PDF only. sHUttl is therefore
live-data-only; the "scheduled" fallback tier it used to have has no source.

## Architecture

### Backend

A **FastAPI** service holding the routing engine.

*   **Routing Engine**: builds a directed graph of stops and routes and searches
    it with a bounded BFS, weighting candidates by live vehicle availability,
    walking distance and predicted arrival rather than by geometric distance.
*   **Reconstructing route order**: the operator's feed lists each route's stops
    **alphabetically by name**, not in travel order. Building a graph from that
    array directly produces edges between stops in alphabetical sequence. The
    pattern geometry is the only statement of real sequence in the feed, so
    stops are projected onto it and ordered by arc length.

### Frontend

A single-page app in **React** and **TypeScript**.

*   **Visualization**: **Leaflet**, with custom layers for the "Crimson Pulse"
    effect that highlights active routes.
*   **Performance**: heavy components are memoized to hold 60fps during map
    interaction.

### Infrastructure

*   **Dockerization**: the stack is containerized with **Docker Compose**.
*   **Resilience**: health checks, rate limiting via `fastapi-limiter`, and
    degradation that keeps the API answering when upstream does not. A failed
    route-structure refresh serves the previous snapshot; a failed vehicle poll
    for one route drops that route rather than the batch.

## Research

### Recovering structure from an undocumented feed

The Ride Systems tracker exposes no GTFS and no documentation. Everything the
routing engine needs had to be recovered from the map application's own
requests, and two of the three problems were silent ones:

1.  **Two coordinate systems.** Vehicle positions arrive as EPSG:3857 metres
    with a negated Y axis; platforms and route geometry arrive in the schematic
    map's pixel space and need an affine transform to reach lat/lng. Both paths
    are validated against the coordinates Harvard used to publish through
    Passio, and land within 5–23 m.
2.  **Alphabetical stop order.** Described above. This one produces no error and
    no warning — it just quietly makes every along-route distance meaningless.
3.  **Route variants.** A Ride Systems route carries several patterns: direction
    variants, short-turns, detours. Allston Loop has nine, and no single one
    serves all of its stops. Picking the longest draws polylines that miss
    stops by 150 m, so segments are sliced against the variant that actually
    serves both of their endpoints.

### Hierarchical scoring model

Transit routing is not shortest-path: the best trip is the most reliable one,
not the geometrically shortest. Candidates are ranked by tier:

1.  **Direct & live** — a tracked vehicle on a single route.
2.  **Transfer & live** — a multi-leg trip with live vehicles on each leg.
3.  **Walk-modified** — walking to a different boarding stop when that beats
    waiting.

The scheduled tier the earlier design had is gone with the timetable feed.

## ETA Accuracy

The operator publishes its own arrival predictions. sHUttl deliberately does not
route on them, and the goal is to be measurably more accurate than they are.

### Ground truth

Beating another predictor requires knowing what actually happened, and neither
side publishes that. sHUttl observes it directly. The position poller sees every
vehicle every 10 s, so a bus passing a stop is an event that can be timestamped
— which makes observed arrivals ground truth that both predictors can be scored
against.

Detection is by **arc crossing**, not proximity. At a 10 s interval a bus covers
roughly 50 m, so a 30 m circle around a stop is missed more often than hit.
Instead each fix is projected to an arc length along the route geometry, and any
stop whose own arc position falls between the previous fix and the current one
has been passed. The arrival time is interpolated within the step, which removes
most of the polling quantisation from the timestamp. See
[`arrivals.py`](arrivals.py).

### Learned travel times

Observed arrivals are also training data. Consecutive arrivals by the same
vehicle give the measured duration of one stop-to-stop hop, bucketed by hour of
the week, and an ETA is the sum of the measured durations of the hops the bus
still has to make — with the current partial hop prorated by distance.

This is the substance of the accuracy claim. A per-hop measurement absorbs what
no global constant can: this segment's traffic lights, that left turn across
Mass Ave, this hour's congestion. On a route driven with a deliberately
non-uniform speed profile, the model recovered 207 s for a 614 m congested hop
and 19 s for a 155 m clear one — a 5x difference in effective speed between two
hops of the same route, which a single speed figure represents as one number and
therefore gets wrong in both places.

Segments with fewer than three observed traversals fall back to distance over
speed plus dwell, so a route works from the first request and improves as
history accumulates. `next_bus.eta_source` reports which model produced any
given ETA, and `/eta_model` reports how much of the network has enough history
to use the learned one. Expect the fallback to dominate for the first day or two
of running.

### Scoring

Two tools, answering different questions:

```bash
# Do we agree with the operator? (no ground truth needed, instant)
python eta_compare.py once
python eta_compare.py collect --minutes 30 && python eta_compare.py report

# Are we more accurate than the operator? (needs observed arrivals)
python eta_scoreboard.py collect --minutes 120
python eta_scoreboard.py score
```

[`eta_scoreboard.py`](eta_scoreboard.py) is the head-to-head: it logs both
predictors with timestamps, then scores each against the first observed arrival
that followed, reporting MAE, median, 90th percentile, bias, and how often each
side was closer on the same event. It breaks results down by ETA source, so the
learned model is checked against its own fallback rather than assumed better.

Two honest limits, both reported in the output: an arrival is inferred from
position fixes, so a bus passing while the poller is stalled produces no event;
and predictions with no matching arrival inside the horizon are dropped rather
than guessed at.

### What the comparison harness has already found

The first version of the distance model was **6 min optimistic**, with error
growing with distance. Three defects, in order of size:

1.  Distance was measured along the **stop chain** — straight lines between
    stops — rather than the route's actual geometry, understating how far the
    bus drives. Measuring along the 460-point polyline cut bias from
    -5.3 to -1.8 min on its own.
2.  No dwell time. A bus spends real time stopped, and charging nothing for it
    made every multi-stop prediction short.
3.  The fallback speed was 6.5 m/s (14.5 mph), a cruising speed rather than a
    stop-to-stop average. Fitted against the operator's predictions it is
    4.8 m/s (10.7 mph).

Speed and dwell cannot be separated cleanly from this data — Harvard's stops are
~800 m apart, so "slower bus" and "more time stopped" explain the same
observations, and MAE stays within 3.98-4.48 min across the whole plausible
range of the pair. Dwell is therefore pinned at a defensible 20 s and only speed
is fitted, rather than accepting the 85 s dwell and 20 mph bus that sit at the
edge of the search space. Both constants are documented as fitted values in
`main.py` with the sample size behind them (76 paired samples, one weekday
afternoon) — enough to correct a large bias, not enough to trust a second
decimal place.

## Performance

*   **Caching**: **Redis** for high-velocity data (vehicle positions, seconds)
    and slow-moving structure (routes and geometry, minutes), plus in-process
    caches for objects that do not survive serialization.
*   **Graph search**: BFS over a network of under 100 nodes, O(V+E), which at
    this scale is negligible and avoids the complexity of RAPTOR-class
    algorithms.
*   **Parallel polling**: live positions need one request per route, issued
    concurrently and cached behind a background poller so request latency does
    not depend on the operator's response time.

## Tech Stack

### Core
*   **Python 3.11**: backend logic and data processing.
*   **TypeScript 5**: type-safe frontend development.

### Frameworks
*   **FastAPI**: async web framework.
*   **React 19**: UI library.
*   **Tailwind CSS**: styling.

### Data & Infrastructure
*   **Redis**: in-memory cache.
*   **Docker**: containerization.
*   **Ride Systems** (`shuttle.harvard.edu`): live transit data source.

## Running

### Local Development

Run the full stack with Docker Compose:

```bash
docker-compose up --build
```

Access the application:
*   **Backend**: `http://localhost:8000`
*   **Frontend**: `http://localhost:5173`

To run the frontend independently:

```bash
cd frontend
npm install
npm run dev
```

### Verifying the data layer

The coordinate transforms and the recovered route order are the parts where a
silent error corrupts everything downstream, so they have their own check:

```bash
python validate_ridesystems.py
```

It compares platform positions against known coordinates, asserts each route's
stop order is geometric rather than alphabetical, and flags any consecutive-stop
hop too long to be real.

Arrival detection has its own check, which drives a synthetic vehicle around
each route's real geometry and asserts every stop is detected exactly once, in
travel order:

```bash
python validate_arrivals.py
```

## Contributing

Contributions are welcome. Please ensure that any pull requests maintain the
existing code style and include test coverage for new features.

## License

This project is open-source and available for educational and non-commercial use.
