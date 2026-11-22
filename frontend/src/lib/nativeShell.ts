/**
 * The parts of the iOS shell that the page has to drive itself.
 *
 * A browser paints its own chrome and takes its loading indicator away when
 * the page is ready. Inside the app there is no browser to do either: the
 * launch screen stays up until the page says it has rendered
 * (capacitor.config.ts sets `launchAutoHide: false`), and the status bar is
 * drawn over the page with whatever text colour it was last told to use.
 *
 * Everything here is a no-op outside the app, and nothing here can throw —
 * a failed plugin call costs a detail of polish, never the page.
 */

import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { isNativeApp } from '@/lib/platform';

/**
 * Mark the document as running inside the app.
 *
 * index.css scopes its app-only rules — no text selection on chrome, no tap
 * highlight, no page zoom — to this class, because every one of them would be
 * wrong on the website, where people do select a stop name or zoom the page.
 */
export function markNativeApp(): void {
    if (!isNativeApp()) return;
    document.documentElement.classList.add('native-app');
}

/**
 * Take the launch screen down, once the page has something to show under it.
 *
 * Called from SplashScreen's mount effect, which React may run before the
 * browser has painted the commit it belongs to. Two animation frames later
 * that paint has happened, so the launch screen fades to the React splash —
 * the same near-black ground — rather than to whatever the web view held
 * before it.
 *
 * index.html carries a timer that does the same thing unconditionally, for
 * the case where the bundle never gets this far.
 */
export function hideNativeSplash(): void {
    if (!isNativeApp()) return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            SplashScreen.hide().catch(() => { /* already down */ });
        });
    });
}

/**
 * The safe-area insets in CSS pixels, for the layout that is done in JS.
 *
 * CSS reads these itself, with env(). The sheet's snap positions and the
 * map's fit padding are computed in script, though, and env() has no script
 * API — so a throwaway element is given the insets as padding and measured.
 *
 * Zero in a browser on purpose, not because a browser has none: the website's
 * sheet has always sat where it sits, and this is not the change to move it.
 */
export function nativeSafeArea(): { top: number; bottom: number } {
    if (!isNativeApp()) return { top: 0, bottom: 0 };
    try {
        const probe = document.createElement('div');
        probe.style.cssText =
            'position:fixed;visibility:hidden;pointer-events:none;' +
            'padding-top:env(safe-area-inset-top,0px);' +
            'padding-bottom:env(safe-area-inset-bottom,0px)';
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const insets = {
            top: parseFloat(style.paddingTop) || 0,
            bottom: parseFloat(style.paddingBottom) || 0,
        };
        probe.remove();
        return insets;
    } catch {
        return { top: 0, bottom: 0 };
    }
}

export type Ground = 'dark' | 'light';

// What is behind the status bar. The map runs edge to edge, so this is the
// basemap — except while the React splash is up, which is near-black whatever
// the basemap under it is.
let mapGround: Ground = 'dark';
let splashUp = false;

function applyStatusBar(): void {
    if (!isNativeApp()) return;
    const ground: Ground = splashUp ? 'dark' : mapGround;
    // The plugin names a style after the background it is for: Dark is light
    // text for a dark ground.
    StatusBar.setStyle({ style: ground === 'dark' ? Style.Dark : Style.Light })
        .catch(() => { /* the status bar keeps its previous style */ });
}

/** Tell the status bar which basemap it is sitting on. */
export function setStatusBarGround(ground: Ground): void {
    mapGround = ground;
    applyStatusBar();
}

/** The React splash covers the map; while it does, the ground is dark. */
export function setStatusBarUnderSplash(covered: boolean): void {
    splashUp = covered;
    applyStatusBar();
}
