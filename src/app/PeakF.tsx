/**
 * The F of "Peak Forge", drawn to match the supplied wordmark.
 *
 * Vector rather than part of the logo PNG, because this letter has to change
 * colour with the theme — white on the dark bar, black on the light one — and a
 * baked raster cannot. `currentColor` inherits `--text` from the page, so it
 * tracks the theme with no second asset and no swap logic.
 *
 * **The geometry is measured, not eyeballed.** There was no licence to the
 * typeface and no vector original, so the numbers below come from decoding the
 * supplied PNG: in this face an F is the wordmark's own E with its bottom bar
 * removed, and that E turns out to be three axis-aligned rectangles with
 * single-pixel antialiasing. Sub-pixel values are the measured edges — the stem
 * ends at 22.6 because alpha at x=22 is 151/255, not because 22.6 looked right.
 *
 * Coordinates are in the artwork's own space, 187 units to the cap height, so
 * this sits beside the PNG at any size without a scale factor in between. The
 * leading 6 units are the wordmark's own letterspacing, carried inside the
 * viewBox so the two elements simply butt together.
 */

/** Letterspacing of the supplied wordmark, in artwork units. */
const GAP = 6;
/** Vertical stroke. */
const STEM_W = 22.6;
/** Horizontal bars — the full width of the letter. */
const BAR_W = 50.1;
const TOP_BAR_H = 18.8;
const MID_BAR_TOP = 61.9;
const MID_BAR_BOTTOM = 80.9;
const CAP_H = 187;

export function PeakF() {
  return (
    <svg
      className="topbar__f"
      viewBox={`0 0 ${GAP + BAR_W} ${CAP_H}`}
      height={CAP_H}
      fill="currentColor"
      /* The wordmark's alt text already says "Peak Forge", so announcing this
         letter again would read the brand out twice. */
      aria-hidden
      focusable="false"
    >
      <rect x={GAP} y={0} width={STEM_W} height={CAP_H} />
      <rect x={GAP} y={0} width={BAR_W} height={TOP_BAR_H} />
      <rect x={GAP} y={MID_BAR_TOP} width={BAR_W} height={MID_BAR_BOTTOM - MID_BAR_TOP} />
    </svg>
  );
}
