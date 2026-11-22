/**
 * Web or the iOS app?
 *
 * The same build ships to shuttl.live and inside the Capacitor shell. Anything
 * that differs between them — push transport, the location prompt, the share
 * sheet — branches on this, so the web path stays exactly what it was.
 */

import { Capacitor } from '@capacitor/core';

/** True inside the native iOS shell, false in any browser. */
export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

/**
 * The public site. Inside the app `window.location.origin` is
 * `capacitor://localhost`, which is useless in a link meant for someone else.
 */
export const PUBLIC_WEB_ORIGIN = 'https://shuttl.live';
