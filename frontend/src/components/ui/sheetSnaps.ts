/**
 * Sheet heights as fractions of the viewport, tallest first.
 *
 * The middle value is the resting position and the important one: at 0.45 the
 * map keeps 55% of the screen. This is a map app, so at rest it should show
 * where the buses are — the sheet only needs the mode switch and the first few
 * departures, and dragging up is what asks for the rest.
 */
export const SNAP_FRACTIONS = [0.92, 0.45, 0.12];
export const SNAP_EXPANDED = 0;
export const SNAP_DEFAULT = 1;
export const SNAP_MINIMISED = 2;

/** The fraction of the screen the sheet covers at rest. The map uses it to
 * keep fitted routes clear of the panel. */
export const SHEET_RESTING_FRACTION = SNAP_FRACTIONS[SNAP_DEFAULT];
