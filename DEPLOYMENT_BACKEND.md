# Backend Deployment Guide - sHUttl

This guide provides instructions for deploying the Crimson Shuttle FastAPI backend as a containerized service on any Docker-compatible cloud platform (e.g., Render, Railway, Fly.io, AWS ECS).

## 1. Environment Variables

Configure these variables in your deployment platform's dashboard:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RIDESYSTEMS_BASE_URL` | `https://shuttle.harvard.edu/rtt/public` | Live data source. Harvard retired PassioGO on 2026-07-01. |
| `RIDESYSTEMS_PROJECT_TAG` | `1` | Ride Systems project id for the Harvard system. |
| `RIDESYSTEMS_MAPDATA_TTL_S` | `900` | How long route structure and geometry are cached. |
| `PASSIO_SYSTEM_ID` | `831` | Legacy id, kept so existing `?system_id=` links and cache keys keep working. |
| `REDIS_URL` | *(Optional)* | Redis connection string (e.g., `redis://:pass@host:6379/0`). |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed frontend domains. |
| `ENV` | `development` | Set to `production` for production environments. |
| `ENABLE_DOCS` | `true` | Set to `false` to disable Swagger/OpenAPI docs in production. |
| `PORT` | `8000` | The port the container will listen on. |

## 2. Deployment Steps

### Standard Docker Build
Most platforms will automatically detect the `Dockerfile` and build the image.

1.  Connect your GitHub repository to the platform.
2.  Ensure build context is the backend root directory.
3.  Set the environment variables listed above.

### Dynamic Port Binding
If your platform requires the service to listen on a dynamic `$PORT` (like Render or Fly.io), the `Dockerfile` is already configured to respect this:

`CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]`

## 3. Health Checks & Verification

- **Health Endpoint**: `GET /health` should return `{"status": "ok"}`.
- **Verification**:
    - `https://your-backend-url/stops`
    - `https://your-backend-url/vehicles`
    - `https://your-backend-url/stop_etas?stop_id=1` (ours alongside the operator's)

Note that `/vehicles` legitimately returns `[]` when no shuttles are running,
which on the Harvard calendar includes overnight gaps and recess periods. To
tell "no service" apart from "integration broken", run
`python validate_ridesystems.py`, which checks the route structure and
coordinate transforms independently of whether any bus is moving.

## 4. Local Development (Docker Compose)
To run everything locally with Redis:

```bash
docker compose up --build
```
The backend will be available at `http://localhost:8000`.
