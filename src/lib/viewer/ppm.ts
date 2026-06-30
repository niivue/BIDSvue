// ppm-range bounds + parsing for the spectroscopy viewer (M-SVS2).
//
// Extracted from SpectroscopyViewer.svelte so the clamp + NaN-fallback
// rule is testable without a Svelte component. The defaults match the
// upstream NiiVue svs.html demo; the [0, 8] domain covers the ppm
// window for every recognised NIfTI-MRS signal at 1.5T / 3T / 7T.

/** Lower bound of the ppm domain. */
export const PPM_MIN = 0
/** Upper bound of the ppm domain. */
export const PPM_MAX = 8
/** Step size for the ppm inputs — matches the upstream demo. */
export const PPM_STEP = 0.1
/** Default ppm low (centred on Cr / NAA region). */
export const PPM_LOW_DEFAULT = 1.9
/** Default ppm high (just above Cho). */
export const PPM_HIGH_DEFAULT = 3.3

/**
 * Parse a ppm input value and clamp it to the [PPM_MIN, PPM_MAX]
 * domain. Returns `fallback` when the value is NaN / Infinity so a
 * half-typed digit or a programmatic NaN cannot bake into setSignal.
 *
 * The clamp is defence-in-depth: the `<input type="number">` element
 * declares `min` / `max` and most browsers honour them, BUT keyboard
 * arrow-keys + a step of 0.1 starting near a boundary CAN drive
 * `valueAsNumber` past the declared range in WebKit. The JS clamp
 * stops that from reaching `setSignal`.
 */
export function clampPpm(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  if (value < PPM_MIN) return PPM_MIN
  if (value > PPM_MAX) return PPM_MAX
  return value
}
