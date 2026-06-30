// Apply a binary mask to a NIfTI image payload in native space.
//
// The mask is 0 / 1 per voxel (Uint8); the image is whatever typed array
// the source NIfTI datatypeCode dictates (int16, float32, uint8, …).
// "Apply" means: REPLACE every voxel where the mask is 0 with the image's
// own raw-minimum value, leave the rest unchanged. We return a NEW typed
// array of the same constructor as the input — the source's `vol.img`
// should NOT be mutated because the `NiftiVolume.header.toArrayBuffer()`
// round-trip depends on the constructor (datatypeCode) staying consistent
// with what we serialize.
//
// Type-preserving: an Int16 input produces an Int16 output (not a
// promoted Float32). This preserves `header.scl_slope` / `scl_inter`
// semantics — they're stored on the header and reinterpret the raw
// integer voxel values; promoting to float would mean the multiplier no
// longer applies cleanly on a re-read.
//
// Why raw-min instead of literal 0: the displayed intensity of a voxel
// is `raw * scl_slope + scl_inter`. For a T1 with `scl_inter=776` (e.g.
// ds005016/sub-7537), raw 0 maps to a bright-gray display value, so a
// zero-padded background looks gray. For CT scans (Hounsfield), raw 0
// maps to 0 HU which is dense tissue — outside-the-FOV is conventionally
// −1024 HU. Using the input's actual raw-min makes the background match
// the darkest voxel in the image regardless of header scaling, which is
// what users expect "masked out" to look like. (`brainchop -m mindgrab`
// solves this by rewriting `scl_inter=0` and translating every voxel,
// which is also valid but rewrites the intensity calibration; we keep
// the calibration intact and adjust the fill value instead.)

/**
 * Replace every voxel of `img` where the corresponding mask value is 0
 * with the minimum raw value in `img`, and return the result as a new
 * typed array of the same constructor. The mask length must match
 * `img.length`.
 *
 * For float arrays, NaN/Infinity in `img` is preserved as-is *when the
 * mask is 1* and is excluded from the min computation. If every voxel
 * is non-finite (or the input is empty), the background falls back to
 * 0 — defensive only; real conformed inputs are bounded.
 */
export function applyMaskToImage<
  T extends
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array,
>(img: T, mask: Uint8Array): T {
  if (img.length !== mask.length) {
    throw new Error(
      `applyMaskToImage: img.length (${img.length}) !== mask.length (${mask.length})`,
    )
  }
  // Scan for the raw min. Skip non-finite values (relevant only for
  // Float32 / Float64 inputs — integer typed arrays can't store them).
  let bg = Number.POSITIVE_INFINITY
  for (let i = 0; i < img.length; i++) {
    const v = img[i] as number
    if (Number.isFinite(v) && v < bg) bg = v
  }
  if (!Number.isFinite(bg)) bg = 0

  const Ctor = img.constructor as new (length: number) => T
  const out = new Ctor(img.length)
  for (let i = 0; i < img.length; i++) {
    out[i] = (mask[i] > 0 ? img[i] : bg) as T[number]
  }
  return out
}
