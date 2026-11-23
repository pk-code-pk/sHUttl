// Refuses to build the iOS bundle without a usable backend address.
//
// On the website a missing or relative VITE_API_BASE_URL is at least visible:
// requests go to the page's own host and fail where someone will look. Inside
// the app the page's own address is capacitor://localhost, the build succeeds
// either way, and what ships is an app that opens to a map with no buses and
// no way to tell why. `npm run ios:sync` runs this first so the mistake is a
// failed command on the Mac rather than a broken binary in TestFlight.
//
// loadEnv reads the same files and the same process environment that
// `vite build` is about to, so what is checked is what gets built.

import { loadEnv } from 'vite';

const value = loadEnv('production', process.cwd(), 'VITE_').VITE_API_BASE_URL;

let problem = null;
if (!value) {
    problem = 'VITE_API_BASE_URL is not set.';
} else {
    let url = null;
    try {
        url = new URL(value);
    } catch {
        // Handled below: a value that is not a URL has no protocol to accept.
    }
    // https only. iOS refuses plain http from an app unless the project opts
    // out of App Transport Security, which this one deliberately does not.
    if (url?.protocol !== 'https:') {
        problem = `VITE_API_BASE_URL is "${value}", which is not a full https:// address.`;
    }
}

if (problem) {
    console.error(
        `\n${problem}\n\n` +
        'The iOS app cannot reach the backend without it. Create the file\n' +
        'frontend/.env.production containing one line, for example\n\n' +
        '    VITE_API_BASE_URL=https://your-service.onrender.com\n\n' +
        'using the same backend address the website is built with, then run\n' +
        'this command again.\n',
    );
    process.exit(1);
}

console.log(`iOS bundle will talk to ${value}`);
