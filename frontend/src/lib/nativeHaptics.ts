/**
 * Haptics, for the iOS app only.
 *
 * Used sparingly on purpose. A tap that accompanies everything stops meaning
 * anything, and on a control that gets pressed as often as the mode switch a
 * heavy one would be tiresome. So there is exactly one kind — the lightest
 * impact — and it marks the few moments where something physically lands: the
 * sheet arriving at a position, the mode switch moving, a trip being asked
 * for.
 */

import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { isNativeApp } from '@/lib/platform';

/**
 * A light tap. Does nothing in a browser, and never throws or rejects: this is
 * called from inside gesture and click handlers, where a failure to buzz must
 * not become a failure to respond.
 */
export function tapHaptic(): void {
    if (!isNativeApp()) return;
    try {
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => { /* no Taptic Engine */ });
    } catch {
        // as above
    }
}
