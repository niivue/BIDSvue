/**
 * Normalize a text body to LF (Unix) line endings. Used by BIDSvue's
 * importer writers (dcm2niix-reproin, ezBIDS-MEG, pet2bids) so every
 * TSV / README / CHANGES / `.bidsignore` we author lands on disk with
 * LF endings — the BIDS-canonical convention, matches what OpenNeuro
 * ingest normalises text files to anyway (so a freshly-uploaded
 * dataset doesn't trip the post-commit text-shrink warning), and what
 * cross-platform diff tools expect.
 *
 * Replaces every `\r\n` and standalone `\r` with `\n`. Idempotent on
 * already-LF input. Does NOT touch BOMs or trailing-newline policy —
 * those are caller decisions.
 *
 * Use this at the boundary where text bodies are constructed for
 * writing (typically immediately before returning from a "build the
 * content string" helper). User-edited files routed through
 * `saveSidecar` / `TextEditor` are deliberately NOT normalised — they
 * preserve the user's chosen line-ending style. The contract is
 * specific to files we generate.
 */
export function toLfEol(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}
