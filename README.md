# sHUttl 

A real-time, Google Maps–style shuttle routing app built on top of the PassioGO API. Custom logo/branding by me. 

Plan trips from “where I am” to “where I need to go” using campus shuttles, with live vehicle locations, ETAs, and clean visual routes.

## Features

- **Door-to-door routing**: Enter any origin/destination; the backend snaps to nearest stops and calculates walking legs.
- **Multi-segment trips**: Supports complex routes with transfers across multiple shuttle lines.
- **Real-time vehicles & ETAs**:
  - Live vehicle positions shown on the map.
  - ETAs calculated using distance and smoothed recent movement history.
- **Multi-system support**:
  - Defaults to Harvard Shuttles (`PASSIO_SYSTEM_ID=831`).
  - Configure to work with any PassioGO system.
- **Modern UI**:
  - Polished interface with splash screen, system picker, and interactive map.
  - Mobile-friendly trip planner with scrollable itinerary.
- **Performance & Safety**:
  - Redis-backed caching for stops and vehicles.
  - Rate limiting to protect the upstream PassioGO API.

## Tech Stack

**Backend**
- **FastAPI** (Python)
- **PassioGO Client** (Custom Python wrapper)
- **Redis** (Caching & Rate Limiting)
- **fastapi-limiter**
- **Docker** (Containerization)

**Frontend**
- **React** + **Vite** + **TypeScript**
- **Tailwind CSS**
- **Framer Motion** (Animations)
- **Leaflet** (Map visualization)

**Infra / Deployment**
- **Docker Compose** (Local development)
- **Render** (Suggested for Backend)
- **Vercel** or **Netlify** (Suggested for Frontend)

## High-Level Architecture

- The **Frontend** communicates with the Backend via a configurable `VITE_API_BASE_URL`.
- The **Backend** exposes RESTful endpoints:
  - `GET /stops` – Fetch all stops for a system.
  - `GET /vehicles` – specific system's live vehicle positions.
  - `GET /nearest_stop` – Geospacial lookup for stops.
  - `GET /trip` – Complex pathfinding logic for door-to-door shuttle routing.
- **Data Flow**:
  - The backend polls PassioGO for live data.
  - Redis caches this data to minimize upstream calls.
  - An in-memory store helps smooth vehicle ETA predictions.
- **User Interface**:
  - Visualizes stops and vehicles on a Leaflet map.
  - Provides autocomplete for location search.
  - Displays detailed, segment-by-segment itineraries.

## Getting Started (Local Development)

### Backend

1. **Prerequisites**: Python 3.11+, Redis.
2. **Setup**:
   ```bash
   # assuming you are at repo root
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. **Environment**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Ensure variables are set:
   ```env
   PASSIO_SYSTEM_ID=831
   REDIS_URL=redis://localhost:6379/0
   CORS_ALLOWED_ORIGINS=http://localhost:5173
   ```
4. **Run Redis**:
   ```bash
   redis-server
   # OR via Docker
   docker run -p 6379:6379 redis:7
   ```
5. **Start Server**:
   ```bash
   python -m uvicorn main:app --reload
   ```
   Check health at `http://localhost:8000/health`.

### Frontend

1. **Prerequisites**: Node.js (LTS).
2. **Setup**:
   ```bash
   cd frontend
   npm install
   ```
3. **Environment**:
   Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
   Set the API URL:
   ```env
   VITE_API_BASE_URL=http://localhost:8000
   ```
4. **Run**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` to verify map rendering and trip planning.

## Running with Docker

Run the full stack (Backend + Redis) with Docker Compose:

```bash
docker-compose up --build
```

- **Backend**: `http://localhost:8000`
- **Redis**: `localhost:6379`

Point your frontend (running locally) to the Dockerized backend:
```env
VITE_API_BASE_URL=http://localhost:8000
```

## Deployment

### Backend (Render)

The backend is containerized and ready for PaaS deployment.

See [`DEPLOYMENT_BACKEND.md`](./DEPLOYMENT_BACKEND.md) for details on:
- Deploying the Docker image.
- Configuring environment variables (`REDIS_URL`, `PASSIO_SYSTEM_ID`, `CORS_ALLOWED_ORIGINS`).

### Frontend (Vercel / Netlify)

The frontend is a static single-page application.

See [`FRONTEND_DEPLOYMENT.md`](./frontend/FRONTEND_DEPLOYMENT.md) for details on:
- Building the project (`npm run build`).
- Setting `VITE_API_BASE_URL` for production.

## Security and Reliability Notes

- **Input Validation**: Strict validation on lat/lng and IDs; clean error responses.
- **Rate Limiting**: Protects endpoints using `fastapi-limiter` + Redis.
- **Caching**: Minimizes load on PassioGO APIs.
- **Error Handling**: Graceful degradation when upstream services are unavailable.
- **CORS**: Configured via `CORS_ALLOWED_ORIGINS` to limit which frontends can call the API in production.

## Future Work

- [ ] User favorites (stops, locations).
- [ ] Scheduled trip reminders.
- [ ] Advanced pathfinding (time-based costs).
- [ ] Offline caching for static data (stops/routes).

## Disclaimer

**Crimson Shuttle** is an independent, student-built project.

- It is **not** affiliated with, endorsed by, or officially supported by **Harvard University** or **Passio Technologies**.
- Shuttle data is retrieved from the public PassioGO API.
- ETAs and routes are **estimates** and may not reflect official schedules or real-time traffic conditions perfectly.
- Always verify critical travel times with official sources.
