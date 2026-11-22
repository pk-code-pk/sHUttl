/**
 * Renders the source images that `capacitor-assets generate --ios` reads.
 *
 * The app icon and launch image are derived from the same logo the website
 * uses, so they are generated rather than drawn. Run this only when the logo
 * changes, then regenerate the Xcode asset catalog:
 *
 *     node assets/render.mjs
 *     npx capacitor-assets generate --ios
 *
 * sharp is not a dependency of this project; it is here because
 * @capacitor/assets depends on it, which is the only reason this can run.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const LOGO = join(here, '../public/favicon_package/favicon-source-square.svg');

// The splash ground: the same near-black as the React splash screen
// (bg-neutral-950) and capacitor.config.ts, so the hand-off between the
// launch screen and the page is the logo and nothing else.
const GROUND = '#0a0a0a';

/** The square logo art at `size` pixels, transparent around the wordmark. */
const logo = (size) =>
    sharp(LOGO, { density: 300 })
        .resize(size, size)
        .png()
        .toBuffer();

/**
 * `layers` composited on an opaque square. Compositing hands back an alpha
 * channel even over an RGB canvas, and a fully opaque alpha channel is still
 * an alpha channel to App Store Connect, so it is dropped before encoding.
 */
const onGround = (size, background, layers) =>
    sharp({ create: { width: size, height: size, channels: 3, background } })
        .composite(layers)
        .removeAlpha()
        .png();

// App icon. Apple rejects an icon with an alpha channel, and iOS applies its
// own corner mask, so this is a full-bleed opaque square. White, because the
// wordmark's grey and crimson are drawn for a light ground: on the app's
// near-black the crimson all but disappears at home-screen size. The wordmark
// spans the full width of its art, so it is inset to keep it off the edges.
const ICON = 1024;
const ICON_LOGO = 860;
await onGround(ICON, '#ffffff', [{ input: await logo(ICON_LOGO), gravity: 'centre' }])
    .toFile(join(here, 'icon-only.png'));

// Launch image. The storyboard aspect-fills this square into a portrait
// screen, so 2732px spans the screen's height and only the middle strip is
// seen. The numbers put the wordmark where the React splash screen draws it
// (216pt wide, 22pt above centre) on a ~874pt-tall iPhone, so the logo does
// not jump when one replaces the other.
const SPLASH = 2732;
const SPLASH_LOGO = 708;
const SPLASH_LIFT = 70;
const offset = Math.round((SPLASH - SPLASH_LOGO) / 2);
const splash = await onGround(SPLASH, GROUND, [
    { input: await logo(SPLASH_LOGO), left: offset, top: offset - SPLASH_LIFT },
]).toBuffer();

// The app is dark whatever the system appearance is, so both variants are
// the same image; capacitor-assets wants the dark one to exist regardless.
await sharp(splash).toFile(join(here, 'splash.png'));
await sharp(splash).toFile(join(here, 'splash-dark.png'));

console.log('wrote icon-only.png, splash.png, splash-dark.png');
