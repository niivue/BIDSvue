// PET-specific JSON-sidecar enrichment, ported from
// pypet2bids.dcm2niix4pet's post-dcm2niix pipeline (around lines
// 660-880 of dcm2niix4pet.py) plus pypet2bids.update_json_pet_file
// (check_meta_radio_inputs + ConvolutionKernel parsing + the
// BQML/Bq/mL normalisation and ScanDate strip).
//
// The TS port consumes dcm2niix's already-extracted JSON sidecar
// (not the DICOM bytes themselves — dcm2niix did that), overlays the
// operator-supplied metadata, applies the same BIDS-PET normalisations
// pypet2bids applies, and emits an enriched sidecar.
//
// Deliberate divergences from pypet2bids:
//   - ConversionSoftware / ConversionSoftwareVersion are left as
//     dcm2niix-written strings (NOT tagged as `[..., "pypet2bids"]`).
//     BIDSvue's operation log carries provenance instead.
//   - We never re-read DICOM tags. The validator's `is PET` check
//     remains the orchestrator's responsibility (Phase C).

import { deriveRadioInputs } from './radioInputs'
import { parseConvolutionKernel, parseReconMethod } from './reconMethod'

export type SidecarJson = Record<string, unknown>

export interface EnrichOptions {
  /** Operator-supplied PET sidecar fields. Wins on conflict. */
  metadata?: SidecarJson
}

const SCALAR_ARRAY_FIELDS = [
  'FrameDuration',
  'ScatterFraction',
  'FrameTimesStart',
  'DecayCorrectionFactor',
  'ReconFilterSize',
] as const

/**
 * Enrich a dcm2niix-produced PET JSON sidecar to BIDS-PET form.
 *
 * The result is a NEW object; inputs are not mutated.
 */
export function enrichPetSidecar(
  dcm2niixJson: SidecarJson,
  options: EnrichOptions = {},
): SidecarJson {
  const out: SidecarJson = { ...dcm2niixJson }
  const metadata = options.metadata ?? {}

  // 1. BQML -> Bq/mL normalisation (dcm2niix is mostly consistent but
  // older versions emit BQML).
  if (out.Units === 'BQML') {
    out.Units = 'Bq/mL'
  }

  // 2. ScanStart / InjectionStart default to 0 when missing.
  if (out.ScanStart === undefined) out.ScanStart = 0
  if (
    out.InjectionStart === undefined &&
    metadata.InjectionStart === undefined
  ) {
    // pypet2bids only sets InjectionStart=0 when missing from BOTH
    // dcm2niix and the user inputs. We mirror that.
    out.InjectionStart = 0
  }

  // 3. TimeZero fallback to AcquisitionTime / SeriesTime if missing.
  if (out.TimeZero === undefined && metadata.TimeZero === undefined) {
    const fallback = out.AcquisitionTime ?? out.SeriesTime
    if (typeof fallback === 'string') {
      out.TimeZero = parseTimeOfDay(fallback)
      removeKey(out, 'AcquisitionTime')
    }
  }

  // 4. Parse ReconstructionMethod into structured fields ONLY when
  // ReconMethodName isn't already present from dcm2niix or the
  // operator. pypet2bids has the same condition (the regex_cases
  // branch in update_json_with_dicom_value only fires when the BIDS
  // field is in `missing_values`, which respects spreadsheet_metadata).
  const reconMethodNameAlreadyKnown =
    out.ReconMethodName !== undefined || metadata.ReconMethodName !== undefined
  if (
    typeof out.ReconstructionMethod === 'string' &&
    !reconMethodNameAlreadyKnown
  ) {
    const parsed = parseReconMethod(out.ReconstructionMethod)
    out.ReconMethodName = parsed.ReconMethodName
    if (parsed.ReconMethodParameterLabels.length > 0) {
      out.ReconMethodParameterLabels = parsed.ReconMethodParameterLabels
    }
    if (parsed.ReconMethodParameterUnits.length > 0) {
      out.ReconMethodParameterUnits = parsed.ReconMethodParameterUnits
    }
    if (parsed.ReconMethodParameterValues !== undefined) {
      out.ReconMethodParameterValues = parsed.ReconMethodParameterValues
    }
    removeKey(out, 'ReconstructionMethod')
  }

  // 5. Overlay operator metadata (operator wins on conflict).
  // ScanDate / AcquisitionDateTime stripping happens at step 12
  // (after every overlay) so operator metadata can't sneak them
  // back in. Audit round 13 security agent flagged the previous
  // strip-before-overlay order as a PHI re-injection vector.
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = value
  }

  // 7. Cross-fill missing radio inputs from the supplied ones.
  // Caller-supplied units / values are preserved.
  const radioDelta = deriveRadioInputs({
    InjectedRadioactivity: out.InjectedRadioactivity as
      | number
      | string
      | undefined,
    InjectedRadioactivityUnits: out.InjectedRadioactivityUnits as
      | string
      | undefined,
    InjectedMass: out.InjectedMass as number | string | undefined,
    InjectedMassUnits: out.InjectedMassUnits as string | undefined,
    SpecificRadioactivity: out.SpecificRadioactivity as
      | number
      | string
      | undefined,
    SpecificRadioactivityUnits: out.SpecificRadioactivityUnits as
      | string
      | undefined,
    MolarActivity: out.MolarActivity as number | string | undefined,
    MolarActivityUnits: out.MolarActivityUnits as string | undefined,
    MolecularWeight: out.MolecularWeight as number | string | undefined,
    MolecularWeightUnits: out.MolecularWeightUnits as string | undefined,
  })
  Object.assign(out, radioDelta)

  // 8. Re-overlay operator metadata so any field they explicitly set
  // wins over the radio-inputs cross-fill (matches pypet2bids' final
  // sidecar_json.update(self.spreadsheet_metadata) pass).
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = value
  }

  // 9. Wrap remaining scalar fields that the BIDS-PET spec requires
  // as arrays.
  for (const field of SCALAR_ARRAY_FIELDS) {
    const value = out[field]
    if (value !== undefined && !Array.isArray(value)) {
      out[field] = [value]
    }
  }

  // 10. If ConvolutionKernel is present and ReconFilter* fields are
  // missing, derive them from it; then drop ConvolutionKernel.
  if (typeof out.ConvolutionKernel === 'string') {
    if (
      out.ReconFilterType === undefined ||
      out.ReconFilterSize === undefined
    ) {
      const derived = parseConvolutionKernel(out.ConvolutionKernel)
      if (
        out.ReconFilterType === undefined &&
        derived.ReconFilterType !== undefined
      ) {
        out.ReconFilterType = derived.ReconFilterType
      }
      if (
        out.ReconFilterSize === undefined &&
        derived.ReconFilterSize !== undefined
      ) {
        // Wrap to array to match the BIDS-PET spec.
        out.ReconFilterSize = [derived.ReconFilterSize]
      }
    }
    removeKey(out, 'ConvolutionKernel')
  }

  // 11. ModeOfAdministration is canonical lowercase ("infusion",
  // "bolus", "bolus-infusion").
  if (typeof out.ModeOfAdministration === 'string') {
    out.ModeOfAdministration = out.ModeOfAdministration.toLowerCase()
  }

  // 12. Strip date-shaped fields AFTER every overlay. BIDS-PET uses
  // ScanStart relative to TimeZero; AcquisitionDateTime is a
  // dcm2niix DICOM passthrough that an operator-supplied metadata
  // file should NOT be able to re-inject. Doing this last means the
  // strip is the final word regardless of what the operator wrote.
  // Audit round 13 (security agent): the previous step-5 strip
  // BEFORE the step-6 overlay was a PHI re-injection vector.
  removeKey(out, 'ScanDate')
  removeKey(out, 'AcquisitionDateTime')

  return out
}

function removeKey(target: SidecarJson, key: string): void {
  if (key in target) delete target[key]
}

function parseTimeOfDay(input: string): string {
  // dcm2niix and DICOM emit acquisition times as HHMMSS[.fff] or
  // HH:MM:SS[.fff]. pypet2bids parses with dateutil and reformats to
  // HH:MM:SS. We mirror the truncation to HH:MM:SS.
  const colonForm = input.match(/^(\d{2}):(\d{2}):(\d{2})/)
  if (colonForm) return `${colonForm[1]}:${colonForm[2]}:${colonForm[3]}`
  const packed = input.match(/^(\d{2})(\d{2})(\d{2})/)
  if (packed) return `${packed[1]}:${packed[2]}:${packed[3]}`
  return input
}
