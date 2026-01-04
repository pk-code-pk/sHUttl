# Backend Deployment Guide - Crimson Shuttle

This guide provides instructions for deploying the Crimson Shuttle FastAPI backend as a containerized service on any Docker-compatible cloud platform (e.g., Render, Railway, Fly.io, AWS ECS).

## 1. Environment Variables

Configure these variables in your deployment platform's dashboard:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PASSIO_SYSTEM_ID` | `831` | The PassioGO system ID (default is Harvard). |
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

## 4. Local Development (Docker Compose)
To run everything locally with Redis:

```bash
docker compose up --build
```
The backend will be available at `http://localhost:8000`.
