// BIDS-MEG sidecar writers. Pure functions producing strings from a
// vendor-agnostic `MegRecording`.
//
// Output byte-by-byte goals:
//   - `_meg.json`: 4-space indent, trailing newline, key order matches
//     MNE-BIDS's output for the spm_face_ctf golden fixture.
//   - `_channels.tsv`: UTF-8 BOM at file start, tab-separated, LF line
//     endings including a trailing LF. Numeric columns format integers
//     as `<n>.0` (e.g. `480.0` not `480`) to match MNE-BIDS's pandas-
//     style float rendering.
//
// Both writers are vendor-agnostic. CTF-specific extras flow through
// `MegRecording.meta.vendorMeta`; the writer inserts them between the
// fixed `RecordingType` and `*ChannelCount` fields in their map's
// iteration order. This is the single insertion point per writer --
// no per-vendor branches.

import { toLfEol } from '$lib/util/eol'
import type { MegChannel, MegCoordinates, MegRecording } from '../recording'

/**
 * Render a number the way MNE-BIDS does in the JSON sidecar: integers
 * with no decimal as integers (e.g. `3`), floats with `.0` if their
 * value is integer-equal (e.g. `480.0`). Python's `json.dumps` writes
 * `480.0` for a `float` and `3` for an `int`; we mirror that by
 * passing through the bare value -- JS's `JSON.stringify` already
 * does this if we tag the "should look like a float" values manually.
 *
 * Special-cases `Number.isInteger` because JS has only one numeric
 * type. Both 480 and 480.0 are the same Number value, but the golden
 * writes `480.0` for SamplingFrequency. We solve this with a Symbol-
 * tagged wrapper (see `_FloatMark` below) so the JSON-stringify
 * replacer can recognise "this is a float, render as N.0" without
 * affecting genuine integers like GradientOrder = 3.
 */

const FLOAT_TAG = '__bidsvueFloatTag__'

interface FloatTagged {
  readonly [FLOAT_TAG]: true
  readonly value: number
}

/**
 * Tag a number so the JSON writer renders integer-valued floats with
 * `.0` (e.g. `480.0` not `480`). Vendor recording builders import
 * this when stashing typed floats in `vendorMeta` so the byte-level
 * output matches MNE-BIDS's Python-`json.dumps` formatting.
 */
export function floatVal(n: number): FloatTagged {
  return { [FLOAT_TAG]: true, value: n }
}

/** Render the `_meg.json` body for a `MegRecording`. */
export function writeMegJson(rec: MegRecording): string {
  const m = rec.meta
  // Build the object in insertion order:
  //   1. Fixed prefix (TaskName .. SamplingFrequency)
  //   2. vendorMeta verbatim -- the per-vendor builder chooses the
  //      order and can interleave channel-count keys to match the
  //      MNE-BIDS layout exactly (CTF does this; the golden has
  //      MEG/MEGREF before HeadCoilFrequency and EEG/EOG/.../TRIG
  //      after).
  //   3. RecordingDuration + RecordingType, unless vendorMeta already
  //      set them.
  //   4. Any *ChannelCount keys vendorMeta DIDN'T set, in the BIDS
  //      canonical order.
  //
  // The vendorMeta loop refuses to re-emit the typed fields above so a
  // vendor that double-sets `TaskName` or `Manufacturer` can't sneak
  // an override past the writer.
  const out: Record<string, unknown> = {
    TaskName: m.taskName,
    Manufacturer: m.manufacturer,
    PowerLineFrequency: m.powerLineFrequency ?? 'n/a',
    SamplingFrequency: floatVal(m.samplingFrequency),
  }
  const RESERVED = new Set([
    'TaskName',
    'Manufacturer',
    'PowerLineFrequency',
    'SamplingFrequency',
  ])
  const vendorKeys = new Set<string>()
  for (const [k, v] of Object.entries(m.vendorMeta)) {
    if (RESERVED.has(k)) continue
    out[k] = v
    vendorKeys.add(k)
  }
  if (!vendorKeys.has('RecordingDuration')) {
    out.RecordingDuration = floatVal(m.recordingDuration)
  }
  if (!vendorKeys.has('RecordingType')) {
    out.RecordingType = m.recordingType
  }
  // *ChannelCount keys -- only emit the ones vendorMeta didn't already
  // place. The typed values on `meta` are the source of truth; vendor-
  // supplied values would have come from the same builder anyway.
  const tailCount = (key: string, value: number): void => {
    if (!vendorKeys.has(key)) out[key] = value
  }
  tailCount('MEGChannelCount', m.megChannelCount)
  tailCount('MEGREFChannelCount', m.megrefChannelCount)
  tailCount('EEGChannelCount', m.eegChannelCount)
  tailCount('EOGChannelCount', m.eogChannelCount)
  tailCount('ECGChannelCount', m.ecgChannelCount)
  tailCount('EMGChannelCount', m.emgChannelCount)
  tailCount('MiscChannelCount', m.miscChannelCount)
  tailCount('TriggerChannelCount', m.triggerChannelCount)

  // Stringify with the float-tag replacer, 4-space indent, trailing newline.
  return `${jsonStringifyTagged(out, 4)}\n`
}

/**
 * `JSON.stringify` replacement that recognises the `floatVal()` tag and
 * renders the wrapped number with a `.0` suffix when the value is an
 * integer Number. Indented per `space`. Mirrors Python's `json.dumps`
 * with `indent=4`.
 */
function jsonStringifyTagged(value: unknown, space: number): string {
  const pad = (n: number) => ' '.repeat(n)
  const enc = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      const items = v.map(
        (item) => `${pad((depth + 1) * space)}${enc(item, depth + 1)}`,
      )
      return `[\n${items.join(',\n')}\n${pad(depth * space)}]`
    }
    if (typeof v === 'object') {
      const tagged = v as Partial<FloatTagged>
      if (tagged[FLOAT_TAG] === true && typeof tagged.value === 'number') {
        return renderFloat(tagged.value)
      }
      const entries = Object.entries(v as Record<string, unknown>)
      if (entries.length === 0) return '{}'
      const rows = entries.map(
        ([k, val]) =>
          `${pad((depth + 1) * space)}${JSON.stringify(k)}: ${enc(val, depth + 1)}`,
      )
      return `{\n${rows.join(',\n')}\n${pad(depth * space)}}`
    }
    return 'null'
  }
  return enc(value, 0)
}

/**
 * Render a Number with the Python-`json.dumps`-of-a-`float` convention:
 * integer-valued floats get `.0`, others use the same default
 * `Number.prototype.toString()` JS gives us. Python writes
 * `1.6046192152785466e-17` for tiny floats -- JS's default `toString`
 * already produces the same exponential form for the same value.
 */
function renderFloat(n: number): string {
  if (!Number.isFinite(n)) return 'null'
  const s = n.toString()
  if (Number.isInteger(n) && !s.includes('.') && !s.includes('e')) {
    return `${s}.0`
  }
  return s
}

// ---------------------------------------------------------------------------
// _channels.tsv writer.
// ---------------------------------------------------------------------------

/** UTF-8 BOM (`\xEF\xBB\xBF`) -- prepended by MNE-BIDS to channels.tsv. */
const BOM = '﻿'

const CHANNELS_HEADER = [
  'name',
  'type',
  'units',
  'low_cutoff',
  'high_cutoff',
  'description',
  'sampling_frequency',
  'status',
  'status_description',
] as const

/**
 * Render the `_channels.tsv` body for a `MegRecording`. Includes the
 * UTF-8 BOM, tab separators, and a trailing LF after the final row --
 * byte-equal to MNE-BIDS's spm_face_ctf output.
 */
export function writeChannelsTsv(rec: MegRecording): string {
  const lines: string[] = []
  lines.push(CHANNELS_HEADER.join('\t'))
  for (const ch of rec.channels) {
    lines.push(channelRow(ch))
  }
  // Defense-in-depth (audit 2026-05-27 P3): the join is `\n`-only so
  // the writer is LF-canonical by construction today, but a future
  // channel field carrying a CR (e.g. a Windows-authored MEG channel
  // description merged in by a future MEG importer) would leak
  // mid-line. Route the whole body through `toLfEol` so the LF
  // guarantee is end-to-end. See the "Importer-authored text files
  // use LF line endings" Domain rule in CLAUDE.md.
  return toLfEol(`${BOM}${lines.join('\n')}\n`)
}

function channelRow(ch: MegChannel): string {
  return [
    ch.name,
    ch.type,
    ch.units,
    formatTsvFloat(ch.lowCutoff),
    formatTsvFloat(ch.highCutoff),
    ch.description,
    formatTsvFloat(ch.samplingFrequency),
    ch.status,
    ch.statusDescription,
  ].join('\t')
}

/**
 * Format a numeric cell with the `<n>.0` integer-as-float convention
 * MNE-BIDS uses for channels.tsv. `null` writes as the BIDS sentinel
 * `"n/a"`.
 */
function formatTsvFloat(n: number | null): string {
  if (n === null) return 'n/a'
  return renderFloat(n)
}

// ---------------------------------------------------------------------------
// _coordsystem.json writer.
// ---------------------------------------------------------------------------

/**
 * Render the `_coordsystem.json` body for a `MegCoordinates`.
 *
 * **Deviation from MNE-BIDS:** values are emitted in the SAME
 * coordinate frame they were parsed from (`MegCoordinates.system` /
 * `.units` -- for CTF that's `"CTF"` / `"cm"`), so the file is
 * internally consistent. MNE-BIDS instead converts CTF .hc values
 * through its `t_ctf_head_head` transform into a Neuromag-head frame
 * (meters) while keeping `MEGCoordinateSystem: "CTF"` and
 * `MEGCoordinateUnits: "cm"` -- the resulting golden file has values
 * that don't match its declared units. We choose internal
 * consistency over byte-equality with MNE-BIDS; the BIDS-MEG
 * validator accepts either. See decisions/M10-meg-importer.md.
 */
export function writeCoordsystemJson(coords: MegCoordinates): string {
  const out: Record<string, unknown> = {
    MEGCoordinateSystem: coords.system,
    MEGCoordinateUnits: coords.units,
  }
  if (coords.systemDescription !== null) {
    out.MEGCoordinateSystemDescription = coords.systemDescription
  }
  out.HeadCoilCoordinates = pointsToObject(coords.headCoils)
  out.HeadCoilCoordinateSystem = coords.system
  out.HeadCoilCoordinateUnits = coords.units
  out.AnatomicalLandmarkCoordinates = pointsToObject(coords.anatomicalLandmarks)
  out.AnatomicalLandmarkCoordinateSystem = coords.system
  out.AnatomicalLandmarkCoordinateUnits = coords.units
  return `${jsonStringifyTagged(out, 4)}\n`
}

/**
 * Convert a `{NAS: [x,y,z], ...}` map into a plain object suitable
 * for the JSON writer. Each coordinate is wrapped via `floatVal` so
 * integer-valued positions (e.g. `z = 0`) render as `0.0` to match
 * MNE-BIDS's pandas float rendering.
 */
function pointsToObject(
  points: Record<string, readonly [number, number, number]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, [x, y, z]] of Object.entries(points)) {
    out[k] = [floatVal(x), floatVal(y), floatVal(z)]
  }
  return out
}
