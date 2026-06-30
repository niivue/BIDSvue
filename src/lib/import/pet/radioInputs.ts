// Port of pypet2bids.update_json_pet_file.check_meta_radio_inputs.
//
// Given any two of {InjectedRadioactivity, InjectedMass,
// SpecificRadioactivity, MolarActivity, MolecularWeight}, derive the
// remaining values + their units using PET-standard conversion
// formulas. Returns the OVERRIDES (subset of fields the caller should
// patch onto the sidecar); fields the caller already supplied are
// preserved with their original value.
//
// Unit conventions, matching the Python:
//   InjectedRadioactivity:  MBq
//   InjectedMass:           ug
//   SpecificRadioactivity:  Bq/g  (or MBq/ug, when paired with MolarActivity)
//   MolarActivity:          GBq/umol
//   MolecularWeight:        g/mol

export interface RadioInputs {
  InjectedRadioactivity?: number | string
  InjectedRadioactivityUnits?: string
  InjectedMass?: number | string
  InjectedMassUnits?: string
  SpecificRadioactivity?: number | string
  SpecificRadioactivityUnits?: string
  MolarActivity?: number | string
  MolarActivityUnits?: string
  MolecularWeight?: number | string
  MolecularWeightUnits?: string
}

const isNumeric = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

export function deriveRadioInputs(input: RadioInputs): RadioInputs {
  const InjectedRadioactivity = input.InjectedRadioactivity
  const InjectedMass = input.InjectedMass
  const SpecificRadioactivity = input.SpecificRadioactivity
  const MolarActivity = input.MolarActivity
  const MolecularWeight = input.MolecularWeight

  const out: RadioInputs = {}

  if (InjectedRadioactivity != null && InjectedMass != null) {
    out.InjectedRadioactivity = InjectedRadioactivity
    out.InjectedRadioactivityUnits = 'MBq'
    out.InjectedMass = InjectedMass
    out.InjectedMassUnits = 'ug'
    if (!isNumeric(InjectedRadioactivity) || !isNumeric(InjectedMass)) {
      out.InjectedMass = 'n/a'
      out.InjectedMassUnits = 'n/a'
    } else {
      const tmp = (InjectedRadioactivity * 10 ** 6) / (InjectedMass * 10 ** 6)
      if (SpecificRadioactivity != null) {
        out.SpecificRadioactivity = SpecificRadioactivity
        out.SpecificRadioactivityUnits =
          input.SpecificRadioactivityUnits ?? 'n/a'
      } else {
        out.SpecificRadioactivity = tmp
        out.SpecificRadioactivityUnits = 'Bq/g'
      }
    }
  }

  if (InjectedRadioactivity != null && SpecificRadioactivity != null) {
    out.InjectedRadioactivity = InjectedRadioactivity
    out.InjectedRadioactivityUnits = 'MBq'
    out.SpecificRadioactivity = SpecificRadioactivity
    out.SpecificRadioactivityUnits = 'Bq/g'
    if (
      !isNumeric(InjectedRadioactivity) ||
      !isNumeric(SpecificRadioactivity)
    ) {
      out.InjectedMass = 'n/a'
      out.InjectedMassUnits = 'n/a'
    } else {
      const tmp =
        ((InjectedRadioactivity * 10 ** 6) / SpecificRadioactivity) * 10 ** 6
      if (InjectedMass != null) {
        out.InjectedMass = InjectedMass
        out.InjectedMassUnits = input.InjectedMassUnits ?? 'n/a'
      } else {
        out.InjectedMass = tmp
        out.InjectedMassUnits = 'ug'
      }
    }
  }

  if (InjectedMass != null && SpecificRadioactivity != null) {
    out.InjectedMass = InjectedMass
    out.InjectedMassUnits = 'ug'
    out.SpecificRadioactivity = SpecificRadioactivity
    out.SpecificRadioactivityUnits = 'Bq/g'
    if (!isNumeric(SpecificRadioactivity) || !isNumeric(InjectedMass)) {
      out.InjectedRadioactivity = 'n/a'
      out.InjectedRadioactivityUnits = 'n/a'
    } else {
      const tmp = ((InjectedMass / 10 ** 6) * SpecificRadioactivity) / 10 ** 6
      if (InjectedRadioactivity != null) {
        out.InjectedRadioactivity = InjectedRadioactivity
        out.InjectedRadioactivityUnits =
          input.InjectedRadioactivityUnits ?? 'n/a'
      } else {
        out.InjectedRadioactivity = tmp
        out.InjectedRadioactivityUnits = 'MBq'
      }
    }
  }

  if (MolarActivity != null && MolecularWeight != null) {
    out.MolarActivity = MolarActivity
    out.MolarActivityUnits = 'GBq/umol'
    out.MolecularWeight = MolecularWeight
    out.MolecularWeightUnits = 'g/mol'
    if (!isNumeric(MolarActivity) || !isNumeric(MolecularWeight)) {
      out.SpecificRadioactivity = 'n/a'
      out.SpecificRadioactivityUnits = 'n/a'
    } else {
      const tmp = (MolarActivity * 10 ** 3) / MolecularWeight
      if (SpecificRadioactivity != null) {
        out.SpecificRadioactivity = SpecificRadioactivity
        out.SpecificRadioactivityUnits =
          input.SpecificRadioactivityUnits ?? 'n/a'
      } else {
        out.SpecificRadioactivity = tmp
        out.SpecificRadioactivityUnits = 'Bq/g'
      }
    }
  }

  if (MolarActivity != null && SpecificRadioactivity != null) {
    out.SpecificRadioactivity = SpecificRadioactivity
    out.SpecificRadioactivityUnits = 'MBq/ug'
    out.MolarActivity = MolarActivity
    out.MolarActivityUnits = 'GBq/umol'
    if (!isNumeric(SpecificRadioactivity) || !isNumeric(MolarActivity)) {
      out.MolecularWeight = 'n/a'
      out.MolecularWeightUnits = 'n/a'
    } else {
      const tmp = (MolarActivity * 1000) / SpecificRadioactivity
      if (MolecularWeight != null) {
        // Preserve the user-supplied MolecularWeight. pypet2bids
        // overwrites it with `tmp` here (the computed value) -- a
        // second instance of the same parity bug we caught at the
        // `MolecularWeight + SpecificRadioactivity` branch below.
        // We diverge for correctness, not parity.
        out.MolecularWeight = MolecularWeight
        out.MolecularWeightUnits = input.MolecularWeightUnits ?? 'g/mol'
      } else {
        out.MolecularWeight = tmp
        out.MolecularWeightUnits = 'g/mol'
      }
    }
  }

  if (MolecularWeight != null && SpecificRadioactivity != null) {
    out.SpecificRadioactivity = SpecificRadioactivity
    out.SpecificRadioactivityUnits = 'MBq/ug'
    // pypet2bids has an upstream bug here:
    // `data_out["MolecularWeight"] = MolarActivity` overwrites the
    // user-supplied MolecularWeight with MolarActivity (which is
    // often `None`). We deliberately DIVERGE: preserve the user's
    // MolecularWeight unchanged. The cost is loss of diff-parity in
    // this corner case; the gain is a scientifically-correct sidecar.
    out.MolecularWeight = MolecularWeight
    out.MolecularWeightUnits = 'g/mol'
    if (!isNumeric(SpecificRadioactivity) || !isNumeric(MolecularWeight)) {
      out.MolarActivity = 'n/a'
      out.MolarActivityUnits = 'n/a'
    } else {
      const tmp = MolecularWeight * (SpecificRadioactivity / 1000)
      if (MolarActivity != null) {
        out.MolarActivity = MolarActivity
        out.MolarActivityUnits = input.MolarActivityUnits ?? 'n/a'
      } else {
        out.MolarActivity = tmp
        out.MolarActivityUnits = 'GBq/umol'
      }
    }
  }

  return out
}
