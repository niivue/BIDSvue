// Esbuild entry point for @bids/validator@2.4.1.
//
// This file is the input to scripts/bundle-validator.ts, which emits a
// self-contained ESM bundle at src/lib/validation/_validator.bundle.js
// (gitignored). The renderer dynamic-imports that bundle at runtime via
// runValidator.ts. The hand-written `ValidationResult` / `Issue` /
// `SummaryOutput` types below also serve as the type surface that
// _validator.bundle.d.ts re-exports for callers.
//
// Why not import @bids/validator/main directly?
//
//   1. The package's "." and "./main" exports transitively pull in
//      ./files/deno.js (Deno-only -- node:fs via @std/fs). We never call
//      those paths but the import chain bundles them, errors on
//      externalised node:fs.
//
//   2. The validator's own source uses Deno-style JSR interop patterns
//      (`{ default as X } from "cjs-pkg"`, `with { type: "json" }` on
//      JSON imports) that Vite's per-file CJS-to-ESM shim layer can't
//      load in WebKit -- it produces a star-re-export chain V8 rejects
//      with "Importing binding name 'default' cannot be resolved by
//      star export entries". The patches in scripts/patch-validator-
//      imports.ts cover the patterns themselves, but Vite still serves
//      each file individually with shim wrappers that re-introduce the
//      issue.
//
// Esbuild handles both cleanly: alias the validator's internals to the
// browser-friendly path, exclude @jsr/libs__xml's WASM data-URI parser
// via the local stub, and emit a single ESM file the WebView loads in
// one request. See scripts/bundle-validator.ts.

// NOTE: these must be value imports (not `import type`) so esbuild
// walks the validator's source graph when bundling. The ambient
// declarations in _validator.d.ts type them as `any`; the real
// runtime values get inlined into _validator.bundle.js.
import { fileListToTree as _fileListToTree } from '@bids/validator/internal/files/browser.js'
import { filesToTree as _filesToTree } from '@bids/validator/internal/files/filetree.js'
import {
  FileIgnoreRules as _FileIgnoreRules,
  readBidsIgnore as _readBidsIgnore,
} from '@bids/validator/internal/files/ignore.js'
import {
  BIDSFile as _BIDSFile,
  FileTree as _FileTree,
} from '@bids/validator/internal/types/filetree.js'
import { validate as _validate } from '@bids/validator/internal/validators/bids.js'

export type IssueSeverity = 'error' | 'warning'

/**
 * Single diagnostic emitted by the validator. Fields mirror the upstream
 * `Issue` type captured in the Phase A spike.
 */
export interface Issue {
  /** Stable code like `"MISSING_DATASET_DESCRIPTION"`. */
  code: string
  /** Sub-code for field-specific issues (e.g. the field name). */
  subCode?: string
  severity: IssueSeverity
  /** Dataset-relative POSIX path, e.g. `/sub-01/anat/sub-01_T1w.nii.gz`. */
  location?: string
  /** Human-readable detail; the validator returns this canonical English. */
  issueMessage?: string
  suggestion?: string
  /** Multi-file scope, e.g. `["/dataset_description.json"]`. */
  affects?: string[]
  /** BIDS schema rule path, e.g. `rules.checks.hints.TooFewAuthors`. */
  rule?: string
  /** For JSON/TSV line-specific issues. */
  line?: number
  character?: number
}

/**
 * Validator's `DatasetIssues` instance. Map-shaped (with `.size`) plus
 * a public `issues` array. We never construct it directly; we read off
 * what the validator returns.
 */
export interface DatasetIssues {
  issues: Issue[]
  size: number
  codeMessages: Map<string, string>
  entries(): Iterable<[string, Issue]>
}

export interface SubjectMetadata {
  participantId: string
  age?: number | '89+' | null
  sex?: string
}

export interface SummaryOutput {
  sessions: string[]
  subjects: string[]
  subjectMetadata: SubjectMetadata[]
  tasks: string[]
  modalities: string[]
  secondaryModalities: string[]
  totalFiles: number
  size: number
  dataProcessed: boolean
  pet: Record<string, unknown>
  dataTypes: string[]
  schemaVersion: string
}

export interface ValidationResult {
  issues: DatasetIssues
  summary: SummaryOutput
  derivativesSummary?: Record<string, ValidationResult>
}

/**
 * Subset of ValidatorOptions we actually pass. The full type has a pile
 * of CLI-shaped fields (verbose, color, format, ...) that the library
 * accepts but doesn't require at the validate() call site.
 */
export interface ValidatorRunOptions {
  datasetPath: string
  debug: 'NOTSET' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'
  datasetTypes: string[]
  blacklistModalities: string[]
}

// The validator's FileTree / BIDSFile etc. are opaque from our
// perspective — TypeScript only sees `unknown` / `any`. Callers
// build BIDSFile[] via the exported constructor, hand it to
// `filesToTree`, and pass the resulting FileTree back to `validate`.
export type FileTree = unknown
export type BIDSFile = unknown
export type FileIgnoreRules = unknown
export interface FileOpener {
  size: number
  text(): Promise<string>
  stream(): Promise<ReadableStream<Uint8Array>>
  readBytes(size: number, offset?: number): Promise<Uint8Array>
}

export const validate = _validate as (
  fileTree: FileTree,
  options: ValidatorRunOptions,
) => Promise<ValidationResult>

export const fileListToTree = _fileListToTree as (
  files: File[],
) => Promise<FileTree>

// Lower-level building blocks the runValidator.ts adapter uses to
// build a FileTree from lazy `BIDSFile[]` instead of eager `File[]`.
// This is the cure for the M-6 audit / Codex `ram.md` finding: the
// validator only needs small header reads from NIfTI files but the
// eager adapter was reading the entire image payload into WebView
// memory before the validator ever saw the bytes. Re-export the
// constructors + helpers from the bundle so the runtime path can
// build a memory-light tree.
export const BIDSFile = _BIDSFile as unknown as new (
  path: string,
  opener: FileOpener,
  ignore?: FileIgnoreRules | boolean,
  parent?: FileTree,
) => BIDSFile
export const FileTreeCtor = _FileTree as unknown as new (
  path: string,
  name: string,
  parent?: FileTree,
  ignore?: FileIgnoreRules,
) => FileTree
export const FileIgnoreRules = _FileIgnoreRules as unknown as new (
  patterns: string[],
) => FileIgnoreRules & { add(patterns: string[]): void }
export const filesToTree = _filesToTree as (
  files: BIDSFile[],
  ignore?: FileIgnoreRules,
) => FileTree
export const readBidsIgnore = _readBidsIgnore as (
  file: BIDSFile,
) => Promise<string[]>
