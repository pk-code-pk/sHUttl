/**
 * A link to the privacy policy, shown in the iOS app only.
 *
 * App Review expects the policy to be reachable from inside the app, not only
 * from the store listing (guideline 5.1.1). The policy is a page of the
 * website, so the link leaves the app: Capacitor hands any navigation away
 * from the bundled page to the system, which opens it in Safari, and the web
 * view itself never moves off the app.
 *
 * It renders nothing in a browser. The website has never carried this link,
 * and adding one there is a change to the site rather than part of wrapping
 * it; removing the isNativeApp() check is all it would take.
 */

import { PUBLIC_WEB_ORIGIN, isNativeApp } from '@/lib/platform';
import { cn } from './ui/styles';

export const PrivacyLink = ({ className }: { className?: string }) => {
    if (!isNativeApp()) return null;
    return (
        <a
            href={`${PUBLIC_WEB_ORIGIN}/privacy.html`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('text-[10px] text-neutral-400 underline underline-offset-2', className)}
        >
            Privacy policy
        </a>
    );
};
