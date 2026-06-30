// MNE-BIDS importer: build the structured options Rust validates +
// writes to the runner JSON, and the 3-element runner argv. See
// MNE-BIDS design history in git log decisions 6 + 9. The renderer NEVER writes the
// JSON itself — it sends `MneBidsRunnerOptions` to Rust, which validates
// and owns the temp file. The argv shape is asserted in tests + re-checked
// in Rust before spawn.

import { validateBidsLabel, validateImportPath } from './tools'

/** Wizard field values for the mne-bids importer. */
export interface MneBidsFormValues {
  rawFile: string
  subject: string
  task: string
  session?: string
  run?: string
  acquisition?: string
  powerLineFrequency?: number
}

/** Structured options sent to Rust (snake_case = runner JSON keys). */
export interface MneBidsRunnerOptions {
  raw: string
  subject: string
  task: string
  session?: string
  run?: string
  acq?: string
  line_freq?: number
  events?: string
  event_id?: Record<string, number>
  // convert_mne_sample.py extras (all optional).
  empty_room?: string
  calibration?: string
  crosstalk?: string
  authors?: string[]
  data_license?: string
  dataset_name?: string
  /**
   * Rust OWNS the staging dir — it generates one under $APPCACHE and
   * overwrites whatever lands here (decision 6). The renderer omits it.
   */
  staging_root?: string
}

export interface MneBidsExtras {
  eventsFile?: string | null
  eventId?: Record<string, number>
  /** convert_mne_sample.py extras (user-picked files + dataset_description). */
  emptyRoom?: string | null
  calibration?: string | null
  crosstalk?: string | null
  authors?: ReadonlyArray<string>
  dataLicense?: string | null
  datasetName?: string | null
}

/**
 * Build the structured options from wizard values + (optional) detected
 * events. Throws on missing required fields or invalid labels/paths — the
 * first-line guard before the Rust validator (decision 6). The wizard
 * blocks Run on the same conditions; this keeps forged callers honest.
 * `staging_root` is intentionally absent: Rust generates and owns it.
 */
export function buildMneBidsOptions(
  values: MneBidsFormValues,
  extras: MneBidsExtras = {},
): MneBidsRunnerOptions {
  const rawErr = validateImportPath(values.rawFile, 'Raw file')
  if (rawErr) throw new Error(rawErr)
  const subErr =
    values.subject === ''
      ? 'Subject ID is required'
      : validateBidsLabel(values.subject, 'Subject ID')
  if (subErr) throw new Error(subErr)
  const taskErr =
    values.task === ''
      ? 'Task name is required'
      : validateBidsLabel(values.task, 'Task name')
  if (taskErr) throw new Error(taskErr)
  for (const [k, v] of [
    ['Session', values.session],
    ['Run number', values.run],
    ['Acquisition', values.acquisition],
  ] as const) {
    const err = validateBidsLabel(v ?? '', k)
    if (err) throw new Error(err)
  }
  const opts: MneBidsRunnerOptions = {
    raw: values.rawFile,
    subject: values.subject,
    task: values.task,
  }
  if (values.session) opts.session = values.session
  if (values.run) opts.run = values.run
  if (values.acquisition) opts.acq = values.acquisition
  const lf = values.powerLineFrequency
  if (typeof lf === 'number' && lf > 0) opts.line_freq = lf
  if (extras.eventsFile) opts.events = extras.eventsFile
  if (extras.eventId && Object.keys(extras.eventId).length > 0)
    opts.event_id = extras.eventId
  // convert_mne_sample.py extras.
  for (const [field, value, label] of [
    ['empty_room', extras.emptyRoom, 'Empty-room file'],
    ['calibration', extras.calibration, 'Calibration file'],
    ['crosstalk', extras.crosstalk, 'Crosstalk file'],
  ] as const) {
    if (value) {
      const err = validateImportPath(value, label)
      if (err) throw new Error(err)
      opts[field] = value
    }
  }
  if (extras.authors && extras.authors.length > 0)
    opts.authors = [...extras.authors]
  if (extras.dataLicense && extras.dataLicense !== 'none')
    opts.data_license = extras.dataLicense
  if (extras.datasetName) opts.dataset_name = extras.datasetName
  return opts
}
