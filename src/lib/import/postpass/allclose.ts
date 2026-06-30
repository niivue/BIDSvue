// Numpy-style allclose, ported from reproinx.py for the fmap-pairing
// post-pass. Two values are "close" when |a - b| <= atol + rtol * max(|a|, |b|);
// the comparison is symmetric in a/b. Recurses into nested arrays.
//
// NaN is never close to anything (including another NaN), matching numpy.
//
// paramsMatch is the higher-level wrapper reproinx.py exposes: if both
// inputs are arrays of strings, compare them with string equality (used
// for ShimSetting, which dcm2niix emits as a list of strings); else fall
// through to allclose at 5% rtol (used for ImagingVolume affine + shape).

type AllcloseInput = number | readonly AllcloseInput[]

export function allclose(
  a: AllcloseInput,
  b: AllcloseInput,
  rtol = 0.05,
  atol = 1e-8,
): boolean {
  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!allclose(a[i], b[i], rtol, atol)) return false
    }
    return true
  }
  if (aIsArray !== bIsArray) return false
  // Leaf comparison. Match reproinx.py's fallthrough: when either side
  // isn't a finite number (NaN, Infinity, or a value that snuck through
  // the AllcloseInput cast at the paramsMatch boundary), drop to strict
  // equality instead of coercing through Math.abs. NaN === NaN is false,
  // which also matches numpy's NaN rule.
  const x = a as unknown
  const y = b as unknown
  const aIsNum = typeof x === 'number' && Number.isFinite(x)
  const bIsNum = typeof y === 'number' && Number.isFinite(y)
  if (!aIsNum || !bIsNum) return x === y
  return Math.abs(x - y) <= atol + rtol * Math.max(Math.abs(x), Math.abs(y))
}

/**
 * Heudiconv's compatibility test used by the fmap-pairing pass:
 *
 *   - both inputs arrays of strings → element-wise string equality
 *   - otherwise → allclose at 5% rtol
 *
 * Returns false on length mismatch or when either input is null /
 * undefined. Mirrors reproinx.py's `_params_match`, which treats a
 * missing key-info as "incompatible" (the caller has already decided
 * the parameter is in scope).
 */
export function paramsMatch(
  a: readonly unknown[] | null | undefined,
  b: readonly unknown[] | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false
  }
  if (a.length !== b.length) return false
  const aAllStrings = a.every((x) => typeof x === 'string')
  const bAllStrings = b.every((x) => typeof x === 'string')
  if (aAllStrings && bAllStrings) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }
  for (let i = 0; i < a.length; i++) {
    if (!allclose(a[i] as AllcloseInput, b[i] as AllcloseInput, 0.05)) {
      return false
    }
  }
  return true
}
