import type { CapacitorConfig } from '@capacitor/cli';

// The iOS app is the same Vite build, bundled into the binary and served from
// capacitor://localhost. Nothing is loaded from shuttl.live at runtime except
// API responses, so the UI appears before the network does.
const config: CapacitorConfig = {
    appId: 'live.shuttl.app',
    appName: 'sHUttl',
    webDir: 'dist',
    backgroundColor: '#0a0a0a',
    ios: {
        contentInset: 'never',
        backgroundColor: '#0a0a0a',
    },
    plugins: {
        SplashScreen: {
            launchAutoHide: false,
            backgroundColor: '#0a0a0a',
            showSpinner: false,
        },
        // Read natively when the plugin loads, before any of the page's script
        // has run: light status-bar text over the dark launch screen even on a
        // phone in light mode. nativeShell.ts takes over once the map is up.
        StatusBar: {
            style: 'DARK',
        },
        PushNotifications: {
            // How a reminder shows while the app is open. 'banner' + 'list' is
            // what the plugin turns the deprecated 'alert' into on iOS.
            presentationOptions: ['badge', 'sound', 'banner', 'list'],
        },
    },
};

export default config;
