/**
 * The system share sheet, for the iOS app.
 *
 * On the website "share" copies the link, because that is the one thing every
 * browser can do. In the app the rider expects the sheet — Messages, AirDrop,
 * Copy — and copying silently to the clipboard would look like the button did
 * nothing.
 */

import { Share } from '@capacitor/share';
import { isNativeApp } from '@/lib/platform';

/**
 * `dismissed` is its own outcome because closing the sheet is a choice, not a
 * fault: the plugin reports it as a rejection, and treating that as a failure
 * would show the "copy this link by hand" fallback to someone who just changed
 * their mind.
 */
export type NativeShareOutcome = 'shared' | 'dismissed' | 'failed';

export async function shareLinkNatively(url: string): Promise<NativeShareOutcome> {
    // A browser has its own share path (the clipboard); reporting failure
    // sends the caller down it.
    if (!isNativeApp()) return 'failed';
    try {
        // The URL alone: with a text item as well, Messages sends two bubbles
        // and Copy puts both on the clipboard.
        await Share.share({ url });
        return 'shared';
    } catch (err) {
        // The iOS plugin rejects with "Share canceled" when the sheet is
        // closed without choosing anything, and with "Can't share while
        // sharing is in progress" on a double tap. Neither is an error the
        // rider needs to hear about.
        const message = err instanceof Error ? err.message : String(err);
        return /cancel|in progress/i.test(message) ? 'dismissed' : 'failed';
    }
}
