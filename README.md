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
    <a href="#performance">Performance</a>
    &nbsp;&bull;&nbsp;
    <a href="#tech-stack">Tech Stack</a>
    &nbsp;&bull;&nbsp;
    <a href="#running">Running</a>
</div>

## About

sHUttl is a comprehensive navigation system engineered to address the specific challenges of university transit networks. It provides reliable, door-to-door routing for the Harvard University shuttle system by synthesizing real-time telemetry with static schedule data.

The platform was designed to transcend simple vehicle tracking. Instead, it implements an intelligent routing engine capable of planning multi-leg journeys, handling complex transfers, and accounting for live service interruptions that static schedules fail to predict. By integrating disparately structured data sources, sHUttl offers a navigation experience comparable to major commercial platforms but tailored to the nuances of campus mobility.

## Architecture

The system employs a decoupled, containerized architecture designed for high scalability and fault tolerance.

### Backend

The core logic resides in a high-performance REST API built with **FastAPI**.
*   **Routing Engine**: A custom implementation of a Directed Graph algorithm tailored for transit networks. It constructs a dynamic graph of stops and routes, weighing edges based on real-time factors such as current traffic conditions and vehicle ETA, rather than relying solely on static distance metrics.
*   **Data Fusion**: A specialized module responsible for normalizing and merging conflicting data streams. It reconciles high-frequency vehicle updates from the PassioGO API with the structured route definitions from the GTFS feed.

### Frontend

The user interface is a single-page application built with **React** and **TypeScript**.
*   **Visualization**: Geospatial data is rendered using **Leaflet**. Custom layers manage the "Crimson Pulse" effect—an interactive visualization technique that highlights active routes with a pulsating animation, allowing users to verify route identity with a simple toggle interaction.
*   **Performance**: To maintain 60fps rendering during complex map interactions, heavy components are memoized and vector rendering cycles are optimized.

### Infrastructure

*   **Dockerization**: The entire stack is containerized using **Docker Compose**, ensuring consistent behavior across development and production environments.
*   **Resilience**: The system implements automated health checks, rate limiting via `fastapi-limiter`, and graceful degradation strategies. If live data becomes unavailable, the system automatically falls back to scheduled data without interrupting service.

## Research

### Unifying Disparate Data Streams

A primary engineering challenge was the "Ghost Bus" phenomenon, caused by the discrepancy between live API data and static schedule feeds. The live feed provided vehicle coordinates but lacked route shape data, while the GTFS feed contained precise shapes but lacked real-time awareness. Furthermore, the two systems used incompatible identifiers.

To resolve this, a **dynamic mapping layer** was engineered. Upon startup, the system analyzes route names and spatial proximity to deterministically link live routes to their static GTFS counterparts. This allows the backend to inject high-resolution GTFS polylines into live trip plans, ensuring users see the verified path of the bus colored by its real-time status.

### Hierarchical Scoring Model

Standard shortest-path algorithms often fail in transit contexts where the "best" path is defined by reliability rather than theoretical distance. sHUttl utilizes a **hierarchical scoring algorithm** to prioritize trip candidates:

1.  **Direct & Live**: Confirmed vehicle tracking on a direct route.
2.  **Transfer & Live**: Multi-leg trip where all connections are verified active.
3.  **Scheduled**: Fallback to timetable data when live telemetry is absent.

This tiered approach ensures that users are guided toward routes with the highest confidence of arrival.

## Performance

*   **Caching Strategy**: **Redis** is utilized as a multi-layer cache. It handles high-velocity data (vehicle positions updated every 3 seconds) with short TTLs to ensure freshness, while caching static assets (route definitions) for longer durations to minimize upstream API load.
*   **Graph Optimization**: The routing engine uses a modified Breadth-First Search (BFS) algorithm optimized for the specific constraints of the campus network (<100 nodes). This provides O(V+E) performance, which is negligible at this scale, while avoiding the complexity overhead of enterprise-grade algorithms like RAPTOR.

## Tech Stack

### Core
*   **Python 3.11**: Backend logic and data processing.
*   **TypeScript 5**: Type-safe frontend development.

### Frameworks
*   **FastAPI**: High-performance async web framework.
*   **React 18**: Component-based UI library.
*   **Tailwind CSS**: Utility-first styling framework.

### Data & Infrastructure
*   **Redis**: In-memory data structure store.
*   **Docker**: Containerization platform.
*   **PassioGO API**: Real-time transit data source.
*   **GTFS**: General Transit Feed Specification.

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

## Contributing

Contributions are welcome. Please ensure that any pull requests maintain the existing code style and include test coverage for new features.

## License

This project is open-source and available for educational and non-commercial use.
