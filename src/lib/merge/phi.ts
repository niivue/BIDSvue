// PHI-like sidecar key detection (pure). Merge design history in git log §8.4: before
// writing durable provenance, preflight warns when donor/recipient
// sidecars carry common DICOM-derived re-identifying fields. v1 only
// WARNS — it never copies the sensitive values into provenance and
// never edits the donor/recipient metadata.

/**
 * Common PHI-like keys seen in DICOM-derived BIDS sidecars. Matched
 * case-insensitively against JSON object keys at any nesting depth.
 * Conservative list — false positives are cheap (a warning), false
 * negatives are the dangerous direction.
 */
export const PHI_KEYS: ReadonlySet<string> = new Set(
  [
    'PatientName',
    'PatientID',
    'PatientBirthDate',
    'PatientBirthTime',
    'PatientAge',
    'PatientSex',
    'PatientWeight',
    'PatientAddress',
    'PatientTelephoneNumbers',
    'AccessionNumber',
    'InstitutionName',
    'InstitutionAddress',
    'InstitutionalDepartmentName',
    'ReferringPhysicianName',
    'PerformingPhysicianName',
    'OperatorsName',
    'StudyDate',
    'StudyTime',
    'SeriesDate',
    'AcquisitionDate',
    'ContentDate',
    'DeviceSerialNumber',
    'StationName',
  ].map((k) => k.toLowerCase()),
)

/**
 * Walk a parsed sidecar/JSON value and return the original-cased keys
 * that match `PHI_KEYS`. Recurses into nested objects and arrays.
 * Returns each matched key once (deduped, sorted) so the warning is
 * stable. The VALUES are intentionally never returned — only the key
 * names — so a caller can't accidentally leak PHI into provenance.
 */
export function findPhiKeys(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item)
      return
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (PHI_KEYS.has(k.toLowerCase())) found.add(k)
        visit(child)
      }
    }
  }
  visit(value)
  return [...found].sort()
}
