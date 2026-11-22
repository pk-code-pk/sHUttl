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
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed frontend domains. The iOS app's origin, `capacitor://localhost`, is always allowed in addition to whatever is listed here. |
| `ENV` | `development` | Set to `production` for production environments. |
| `ENABLE_DOCS` | `true` | Set to `false` to disable Swagger/OpenAPI docs in production. |
| `PORT` | `8000` | The port the container will listen on. |
| `VAPID_PUBLIC_KEY` | *(Optional)* | Web Push public key. All three `VAPID_*` are needed for browser reminders; generate them with `python gen_vapid.py`. |
| `VAPID_PRIVATE_KEY` | *(Optional)* | Web Push private key. **Secret.** |
| `VAPID_CLAIMS_EMAIL` | *(Optional)* | Contact address sent to push services, e.g. `mailto:you@example.com`. |
| `APNS_KEY_ID` | *(Optional)* | 10-character Key ID of the APNs auth key. See [Push reminders](#2-push-reminders). |
| `APNS_TEAM_ID` | *(Optional)* | 10-character Apple Developer Team ID. |
| `APNS_AUTH_KEY` | *(Optional)* | Contents of the `.p8` key file. **Secret.** |
| `APNS_BUNDLE_ID` | `live.shuttl.app` | The iOS app's bundle identifier. |
| `APNS_ENVIRONMENT` | `production` | `production` or `sandbox`: which APNs host a new device token is tried against first. |

## 2. Push reminders

"Leave now" reminders reach browsers through Web Push and the iOS app through
Apple Push Notification service (APNs). The two are configured separately and
either works without the other; with neither set the API runs normally and
clients are not offered reminders. `GET /push/config` reports what is live:

```json
{"web_push": true, "vapid_public_key": "B...", "apns": true}
```

Subscriptions are stored in Redis. Without `REDIS_URL` they fall back to a
file that Render wipes on every deploy, so production needs Redis for
reminders to survive a restart.

### APNs credentials

The server authenticates to Apple with a signing key rather than a
certificate, so there is nothing to renew each year.

1.  Sign in at [developer.apple.com/account](https://developer.apple.com/account)
    and open **Certificates, Identifiers & Profiles > Keys**.
2.  Add a key (**+**), tick **Apple Push Notifications service (APNs)**, and
    register it. If Apple asks which environment the key is for, choose
    **Sandbox & Production** so the one key covers builds run from Xcode as
    well as TestFlight and the App Store.
3.  Download the `.p8` file. **Apple offers the download once**; if it is
    lost, revoke the key and create another.
4.  Set the variables:
    - `APNS_KEY_ID`: the 10-character Key ID shown on the key's page (it is
      also in the file name, `AuthKey_<KEY ID>.p8`).
    - `APNS_TEAM_ID`: the 10-character Team ID under **Membership details**.
    - `APNS_AUTH_KEY`: the full contents of the `.p8` file, including the
      `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines. Paste
      it with its line breaks if the dashboard takes multi-line values, or on
      one line with each line break written as `\n`; both are accepted.
    - `APNS_BUNDLE_ID`: only if the app's bundle id is not `live.shuttl.app`.
      It must match `appId` in `frontend/capacitor.config.ts`, and the App ID
      must have the Push Notifications capability enabled.

`APNS_AUTH_KEY` is a secret. Anyone who has it can send notifications to every
install of the app. Keep it in the platform's secret store, never in the
repository or a Docker image, and revoke it in the same Keys page if it leaks.

`APNS_ENVIRONMENT` rarely needs setting. Device tokens belong to one APNs
environment: a build run from Xcode gets a sandbox token, TestFlight and the
App Store a production one. The server tries the configured environment first,
retries a rejected token against the other, and remembers which one worked,
so a single deployment serves both kinds of build.

To check the configuration, `GET /push/config` should show `"apns": true`. If
it shows `false` with all three variables set, the key could not be parsed;
the log says why. A `403` from APNs in the log at send time means the Key ID,
Team ID and key do not belong together. A line saying APNs rejected the topic
(`DeviceTokenNotForTopic`, `BadTopic`, `TopicDisallowed`) means
`APNS_BUNDLE_ID` is not the bundle id the app was built with; subscriptions
are kept, and reminders start arriving once the variable is corrected.

## 3. Deployment Steps

### Standard Docker Build
Most platforms will automatically detect the `Dockerfile` and build the image.

1.  Connect your GitHub repository to the platform.
2.  Ensure build context is the backend root directory.
3.  Set the environment variables listed above.

### Dynamic Port Binding
If your platform requires the service to listen on a dynamic `$PORT` (like Render or Fly.io), the `Dockerfile` is already configured to respect this:

`CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]`

## 4. Health Checks & Verification

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

## 5. Local Development (Docker Compose)
To run everything locally with Redis:

```bash
docker compose up --build
```
The backend will be available at `http://localhost:8000`.
