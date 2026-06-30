// Vendor-agnostic MEG recording shape. Every per-vendor parser
// (`formats/ctf`, `formats/fif`, `formats/kit`, `formats/bti`)
// populates this same interface so the sidecar writers in
// `writers/sidecars.ts` are shared. Adding a new vendor means writing
// a parser that fills `MegRecording`; nothing else changes downstream.
//
// Fields that are vendor-specific (e.g. CTF's `SoftwareFilters.SpatialCompensation.GradientOrder`,
// Elekta's `DewarPosition`, KIT's `DigitizedHeadPoints`) flow through
// `vendorMeta` -- the writer copies them into `_meg.json` verbatim
// without per-vendor branches. The empty `{}` default emits no extra
// keys.
//
// Per the BIDS-MEG spec the raw vendor file is passed through
// unchanged; this struct describes the SIDECAR contents only.

/**
 * BIDS-MEG channel-type vocabulary. Only the values we actually emit
 * today are typed; the full BIDS-MEG list is wider (MEGGRADPLANAR,
 * MEGOTHER, EYEGAZE, PUPIL, ...). Add new strings here as the
 * per-vendor classifiers grow.
 */
export type MegChannelType =
  | 'MEGMAG'
  | 'MEGGRADAXIAL'
  | 'MEGGRADPLANAR'
  | 'MEGREFMAG'
  | 'MEGREFGRADAXIAL'
  | 'MEGREFGRADPLANAR'
  | 'EEG'
  | 'EOG'
  | 'ECG'
  | 'EMG'
  | 'TRIG'
  | 'MISC'
  | 'SYSCLOCK'
  | 'OTHER'

/**
 * A single row in `_channels.tsv`. Field names match the BIDS-MEG
 * spec's column headers exactly (snake_case); the writer converts the
 * struct to a tab-separated line.
 */
export interface MegChannel {
  name: string
  type: MegChannelType
  /** SI unit (e.g. `"T"`, `"V"`, `"V/m"`). BIDS allows `"n/a"`. */
  units: string
  /** Hz; usually equals `MegRecording.samplingFrequency`. */
  samplingFrequency: number
  /**
   * Hz. `null` is written as the BIDS sentinel `"n/a"`; in practice
   * the M10-B-2 default is 0.0 (no high-pass filter) -- matches the
   * spm_face_ctf golden fixture.
   */
  lowCutoff: number | null
  /**
   * Hz. `null` is written as `"n/a"`; the M10-B-2 default is sfreq/2
   * (Nyquist) -- matches the golden.
   */
  highCutoff: number | null
  /** Free-form description column (e.g. `"Trigger"`, `"Axial Gradiometer"`). */
  description: string
  /** Channel state. v1 emits `"good"` for every channel; `BadChannels` parsing is deferred. */
  status: 'good' | 'bad'
  /** Free-form description of why the channel is bad. v1 emits `"n/a"`. */
  statusDescription: string
}

/**
 * MEG recording metadata that flows into `_meg.json`. Only the fields
 * required by BIDS-MEG plus the recommended-and-commonly-emitted ones
 * are typed; vendor-specific extras ride along in `vendorMeta` and
 * the writer copies them verbatim.
 */
export interface MegRecordingMeta {
  /** `_meg.json.TaskName`. Comes from the wizard, not the header. */
  taskName: string
  /**
   * `_meg.json.Manufacturer`. BIDS-MEG vocabulary values (see the
   * BIDS spec's "Manufacturer" table):
   *  - `"CTF"`         -- CTF systems
   *  - `"Elekta"`      -- Elekta / MEGIN / Neuromag (Vectorview, Triux)
   *  - `"KIT/Yokogawa"` -- Kanazawa Institute of Technology / Yokogawa / Ricoh
   *  - `"4D/BTi"`      -- 4D Neuroimaging / BTi
   *  - `"Other"`       -- anything else (fall-through)
   */
  manufacturer: 'CTF' | 'Elekta' | 'KIT/Yokogawa' | '4D/BTi' | 'Other'
  /** Hz. `null` writes as the BIDS sentinel `"n/a"`. */
  powerLineFrequency: number | null
  /** Hz. */
  samplingFrequency: number
  /** Seconds. */
  recordingDuration: number
  /** `_meg.json.RecordingType`. */
  recordingType: 'continuous' | 'epoched'
  /**
   * Vendor-specific extras that go directly into the JSON sidecar
   * after the typed fields above. Insertion order is preserved by the
   * writer. Use this for fields like `SoftwareFilters`,
   * `DewarPosition`, `DigitizedLandmarks`, `ContinuousHeadLocalization`,
   * etc. -- one place to add fields without touching the writer.
   */
  vendorMeta: Record<string, unknown>
  /**
   * Channel-count fields. Computed by the per-vendor recording
   * builder by tallying `channels` so the writer doesn't have to
   * re-count.
   */
  megChannelCount: number
  megrefChannelCount: number
  eegChannelCount: number
  eogChannelCount: number
  ecgChannelCount: number
  emgChannelCount: number
  miscChannelCount: number
  triggerChannelCount: number
}

/**
 * Complete recording: metadata + per-channel table + (optional) head
 * coordinate data. The orchestrator (`runMegImport.ts`) builds one of
 * these per source file, then hands it to the writers.
 */
export interface MegRecording {
  meta: MegRecordingMeta
  channels: MegChannel[]
  /**
   * Head-coil + anatomical-landmark coordinates for `_coordsystem.json`.
   * `null` when the vendor header doesn't carry them (or when the
   * dataset doesn't include the relevant side-file -- CTF requires
   * `.hc`, FIF carries digitization in the FIFF stream, etc.).
   */
  coordinates: MegCoordinates | null
  /**
   * Acquisition timestamp -- ISO 8601 if known. `null` when the
   * vendor header doesn't record one. Currently consumed by
   * `_scans.tsv` aggregation in the orchestrator, not by the sidecar
   * writers.
   */
  acquisitionDateTime: string | null
}

/** 3D position as [x, y, z]. Units are recorded in `MegCoordinates.units`. */
export type Point3 = readonly [number, number, number]

/**
 * Head-coil + anatomical-landmark coordinates for `_coordsystem.json`.
 *
 * BIDS-MEG splits coordinate metadata into TWO families that often
 * carry the same values for systems where the head-coils ARE the
 * anatomical landmarks (CTF, KIT). For systems that digitise the
 * landmarks separately, the two sets diverge -- the writer emits
 * each family with its own coordinate-system / units fields.
 *
 * Values are in `units`. `system` is one of the BIDS-MEG vocabulary
 * tokens (`"CTF"`, `"Neuromag"`, `"ALS"`, `"RAS"`, ...).
 */
export interface MegCoordinates {
  /** Coordinate system tag (e.g. `"CTF"`). */
  system: string
  /** Free-form description (e.g. `"ALS orientation and the origin between the ears"`). */
  systemDescription: string | null
  /** Unit string (e.g. `"cm"`, `"m"`, `"mm"`). */
  units: 'cm' | 'm' | 'mm'
  /** Head-coil (HPI) positions. Keys are vendor-specific tokens like `NAS` / `LPA` / `RPA`. */
  headCoils: Record<string, Point3>
  /** Anatomical-landmark positions. Same shape as `headCoils`. */
  anatomicalLandmarks: Record<string, Point3>
}
