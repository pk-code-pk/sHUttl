// src/config.ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

if (!API_BASE_URL) {
    // eslint-disable-next-line no-console
    console.warn(
        'VITE_API_BASE_URL is not set. Frontend will not be able to reach the backend API.'
    )
}

export { API_BASE_URL }
