// Port of pypet2bids.helper_functions.get_recon_method plus the
// ConvolutionKernel parser embedded in pypet2bids.dcm2niix4pet. Both
// pull structured ReconMethodName / ReconFilterType / ReconFilterSize /
// ReconMethodParameter* fields out of dcm2niix's free-text
// ReconstructionMethod and ConvolutionKernel.

interface ReconstructionNamesTable {
  readonly description: string
  readonly names: ReadonlyArray<{ value: string; name: string }>
}

import reconstructionMethodsJson from '$lib/../../resources/common/pet2bids/reconstructionMethods.json' with {
  type: 'json',
}

const NAMES_TABLE = reconstructionMethodsJson as ReconstructionNamesTable

const NAMES_SORTED = [...NAMES_TABLE.names].sort(
  (a, b) => b.value.length - a.value.length,
)

const ITER_FIRST_PATTERNS = [
  /\d\di\ds/,
  /\d\di\d\ds/,
  /\di\ds/,
  /\di\d\ds/,
  /i\d\ds\d/,
  /i\d\ds\d\d/,
  /i\ds\d/,
  /i\ds\d\d/,
].map((re) => new RegExp(re.source))

const SUB_FIRST_PATTERNS = [
  /\d\ds\di/,
  /\d\ds\d\di/,
  /\ds\di/,
  /\ds\d\di/,
  /s\d\di\d/,
  /s\d\di\d\d/,
  /s\di\d/,
  /s\di\d\d/,
].map((re) => new RegExp(re.source))

export interface ReconMethodFields {
  ReconMethodName: string
  ReconMethodParameterLabels: string[]
  ReconMethodParameterUnits: Array<string | null>
  ReconMethodParameterValues?: number[]
}

/**
 * Parse a free-text reconstruction-method string (DICOM
 * ReconstructionMethod or dcm2niix's ConvolutionKernel) into the
 * BIDS-PET structured fields.
 *
 * Heuristic: scan the (whitespace-stripped) string for
 * iterations-and-subsets tokens like `3i21s` or `21s3i`, pick the
 * longest match, strip it, then expand any acronym tokens
 * (OSEM, PSF, ...) using the published reconstruction_names table.
 */
export function parseReconMethod(
  reconstructionMethodString: string,
): ReconMethodFields {
  const contents = reconstructionMethodString.replace(/\s/g, '')

  // Find iter/subset tokens. Same algorithm as
  // helper_functions.get_recon_method.
  let order: 'iter_first' | 'sub_first' | null = null
  const candidates: string[] = []

  for (const pattern of ITER_FIRST_PATTERNS) {
    const match = contents.match(pattern)
    if (match) {
      order = 'iter_first'
      candidates.push(match[0])
    }
  }
  for (const pattern of SUB_FIRST_PATTERNS) {
    const match = contents.match(pattern)
    if (match) {
      // sub_first wins only if no iter_first matched; tie goes to the
      // longest overall match anyway via the sort below.
      if (order === null) order = 'sub_first'
      candidates.push(match[0])
    }
  }

  let iterSubString: string | null = null
  let iterations: number | null = null
  let subsets: number | null = null
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.length - b.length)
    iterSubString = candidates[candidates.length - 1]
    const digits = iterSubString
      .replace(/[A-Za-z]/g, ' ')
      .trim()
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10))
    if (digits.length === 2 && digits.every((n) => Number.isFinite(n))) {
      if (order === 'iter_first') {
        iterations = digits[0]
        subsets = digits[1]
      } else {
        iterations = digits[1]
        subsets = digits[0]
      }
    }
  }

  let reconMethodName =
    iterSubString === null ? contents : contents.replace(iterSubString, '')

  // Trim non-alphanumeric leading/trailing junk left behind by the
  // strip. Replicates the two re.sub calls in get_recon_method.
  reconMethodName = reconMethodName.replace(/[^a-zA-Z0-9]+$/, '')
  reconMethodName = reconMethodName.replace(/^[^a-zA-Z0-9]+/, '')

  // Pull out a 1D/2D/3D/4D dimension token if present (the Python uses
  // [1-4][D-d] so the leading "3D" in "3D-OSEM..." survives the
  // acronym substitution).
  const dimensionMatch = reconMethodName.match(/[1-4][Dd]/)
  const dimension = dimensionMatch ? dimensionMatch[0] : ''

  // Expand any acronym tokens in name order, longest first.
  let expandedName = ''
  let remaining = reconMethodName
  for (const entry of NAMES_SORTED) {
    if (remaining.includes(entry.value)) {
      expandedName += `${entry.name} `
      // Python uses re.sub which removes the FIRST match by default.
      // .replace(string, string) in JS already does this.
      remaining = remaining.replace(entry.value, '')
    }
  }

  if (expandedName !== '') {
    reconMethodName =
      dimension + ' '.repeat(dimension.length) + expandedName.trimEnd()
    reconMethodName = reconMethodName.split(/\s+/).filter(Boolean).join(' ')
  }

  if (
    reconMethodName === 'Filtered Back Projection' ||
    reconMethodName === '3D Reprojection'
  ) {
    return {
      ReconMethodName: reconMethodName,
      ReconMethodParameterLabels: [],
      ReconMethodParameterUnits: [],
      ReconMethodParameterValues: [],
    }
  }

  const haveBoth = iterations !== null && subsets !== null
  if (!haveBoth) {
    return {
      ReconMethodName: reconMethodName,
      ReconMethodParameterLabels: ['none', 'none'],
      ReconMethodParameterUnits: ['none', 'none'],
    }
  }

  return {
    ReconMethodName: reconMethodName,
    ReconMethodParameterLabels: ['subsets', 'iterations'],
    ReconMethodParameterUnits: [null, null],
    ReconMethodParameterValues: [subsets as number, iterations as number],
  }
}

export interface ConvolutionKernelFields {
  ReconFilterType?: string
  ReconFilterSize?: number
}

/**
 * Try to split a dcm2niix ConvolutionKernel string into ReconFilterType
 * + ReconFilterSize. Mirrors the inline regex in dcm2niix4pet.py:
 * pull the first \d+.\d+ float as the size, sanitise the rest as the
 * type. Returns an empty object if no float is present.
 */
export function parseConvolutionKernel(
  convolutionKernel: string,
): ConvolutionKernelFields {
  // Note: the Python regex `\d+.\d+` (where `.` is the regex
  // metacharacter, not a literal dot) is deliberately broad — it
  // matches `4.000` but also `4Xany0` etc. We preserve that behaviour
  // for diff-parity with pypet2bids. A future cleanup could tighten
  // to `\d+\.\d+`.
  const sizeMatch = convolutionKernel.match(/\d+.\d+/)
  const out: ConvolutionKernelFields = {}
  let withoutSize = convolutionKernel
  if (sizeMatch) {
    const raw = sizeMatch[0]
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed)) {
      out.ReconFilterSize = parsed
      withoutSize = convolutionKernel.replace(raw, '')
    }
  }

  let filterType = withoutSize.replace(/[^a-zA-Z0-9]/g, ' ')
  filterType = filterType.replace(/ +/g, ' ').trim()
  if (filterType !== '') {
    out.ReconFilterType = filterType
  }
  return out
}
