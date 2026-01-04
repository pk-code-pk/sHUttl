# Deploying Crimson Shuttle Frontend

## Build

- Local development: `npm install` then `npm run dev`.
- Production build: `npm run build` then `npm run preview`.

## Hosting (Vercel example)

1. Push the repo to GitHub.

2. In Vercel:
   - Create a new project from this repo.
   - Framework preset: **Vite**.
   - Build command: `npm run build`.
   - Output directory: `dist`.

3. Environment Variables:
   - Add `VITE_API_BASE_URL` and set it to your deployed backend URL, for example:
     `https://crimson-shuttle-backend.onrender.com`.

4. Deploy.

5. After deployment, open the Vercel URL:
   - Confirm the map loads.
   - Confirm system selection, trip planning, and ETAs all work against the live backend.

## Hosting (Netlify example)

1. New site → Import from Git.
2. Build command: `npm run build`.
3. Publish directory: `dist`.
4. Add `VITE_API_BASE_URL` in Site Settings → Environment.
5. Deploy and test as above.
