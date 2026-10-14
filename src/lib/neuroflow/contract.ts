// NeuroFlow session contract — the parts that do not depend on a host.
//
// After an import run as a NeuroFlow step, BIDSvue writes two records:
//
//   - `<outputDir>/neuroflow.handoff.json`, the runtime's harvest signal
//   - one line of `<sessionDir>/provenance.jsonl`
//
// The headless ingest (`scripts/neuroflow-ingest.ts`) writes them through
// node:fs; this module builds their bodies with no host dependency, so they
// are unit-tested and any other host can write the same records.

/** File name of the handoff record, inside the step's output directory. */
export const HANDOFF_FILE = 'neuroflow.handoff.json'
/** File name of the session's append-only provenance log. */
export const PROVENANCE_FILE = 'provenance.jsonl'
/** File name of the launch context, inside `$NEUROFLOW_SESSION`. */
export const CONTEXT_FILE = 'context.json'
/** Tool id BIDSvue's ingest records under in provenance. */
export const BIDSVUE_TOOL_ID = 'neuroflow.gallery.tools/bidsvue'
/** Default `agent` stamped on handoff and provenance records. */
export const BIDSVUE_AGENT = 'bidsvue@neuroflow-aware'

/**
 * Parsed `context.json` launch intent for the current workflow step.
 * Mirrors the contract's schema; BIDSvue reads only the keys it
 * understands (`inputs.dicom_dir`, `outputDir`, `step`, `tool`,
 * `stage`). Unknown keys are tolerated — `inputs` in particular may
 * carry tool-specific resolved bindings BIDSvue ignores.
 */
export interface NeuroflowContext {
  /** Contract schema version, e.g. `"0.1.0"`. */
  neuroflow?: string
  /** Discriminator, e.g. `"neuroflow/session-context"`. */
  kind?: string
  /** The workflow step id being executed (e.g. `"ingest"`). */
  step?: string
  /** Fully-qualified tool id that was launched. */
  tool?: string
  /** The pipeline stage this step belongs to. */
  stage?: string
  /**
   * Already-resolved absolute input paths. For BIDSvue's ingest stage
   * the load-bearing key is `dicom_dir` (the source DICOM directory).
   */
  inputs?: {
    /** Absolute path to the source DICOM directory. */
    dicom_dir?: string
    [key: string]: unknown
  }
  /**
   * Absolute path where this step writes its declared outputs. Equals
   * `$NEUROFLOW_OUTPUT_DIR`. BIDSvue imports the DICOMs here.
   */
  outputDir?: string
  /** Absolute scratch directory (`$NEUROFLOW_WORK_DIR`). */
  workDir?: string
}

/** Parse a `context.json` body. Throws on invalid JSON or a non-object. */
export function parseNeuroflowContext(raw: string): NeuroflowContext {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `context.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('context.json must contain a JSON object at the top level')
  }
  return parsed as NeuroflowContext
}

/** Fields BIDSvue records when handing a finished ingest off to NeuroFlow. */
export interface HandoffDetails {
  /** Importer tool id used (e.g. `dcm2niix-reproin`). */
  tool: string
  /** The workflow step id from context.json. */
  step?: string
  /** Absolute path to the produced BIDS directory (the auto-open root). */
  bids_dir: string
  /** Number of NIfTI files the converter produced. */
  producedNiftiCount: number
  /** Converter warnings worth keeping (e.g. a dcm2niix partial conversion). */
  warnings?: ReadonlyArray<string>
}

/** The handoff file body, pretty-printed with a trailing newline. */
export function handoffJson(
  details: HandoffDetails,
  agent: string = BIDSVUE_AGENT,
  now: Date = new Date(),
): string {
  const body = {
    neuroflow: '0.1.0',
    kind: 'neuroflow/handoff',
    step: details.step ?? null,
    tool: details.tool,
    ts: now.toISOString(),
    outputs: {
      bids_dir: details.bids_dir,
    },
    stats: {
      producedNiftiCount: details.producedNiftiCount,
    },
    ...(details.warnings !== undefined && details.warnings.length > 0
      ? { warnings: [...details.warnings] }
      : {}),
    agent,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/**
 * One provenance record, before the ISO timestamp is stamped on. Matches
 * the contract's example shape: a `step` + `tool` + `action` plus an
 * `outputs` map. `ts` and `agent` are filled in by `provenanceLine`.
 */
export interface ProvenanceEntry {
  step?: string
  tool: string
  action: string
  outputs?: Record<string, string>
}

/** One provenance record serialized as a single JSON line (no newline). */
export function provenanceLine(
  entry: ProvenanceEntry,
  agent: string = BIDSVUE_AGENT,
  now: Date = new Date(),
): string {
  return JSON.stringify({
    ts: now.toISOString(),
    step: entry.step ?? null,
    tool: entry.tool,
    action: entry.action,
    outputs: entry.outputs ?? {},
    agent,
  })
}
