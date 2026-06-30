// Pure helpers behind diagnosticsStore. Lives in a non-`.svelte.ts` file
// so bun:test can import them without triggering the module-level
// `new DiagnosticsStore()` (which evaluates `$state(...)` and crashes
// outside a Svelte 5 component context).

import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'
import type { Issue } from '$lib/validation/runValidator'

export interface IssueGroup {
  path: string
  issues: Issue[]
}

/**
 * Group issues by path for an explicit set of file paths. Paths with no
 * entry in `byPath` or with an empty issue list are skipped. Within each
 * group, errors sort before warnings.
 */
export function groupedIssuesForPaths(
  byPath: ReadonlyMap<string, readonly Issue[]>,
  paths: readonly string[],
): IssueGroup[] {
  const out: IssueGroup[] = []
  for (const path of paths) {
    const issues = byPath.get(path)
    if (issues === undefined || issues.length === 0) continue
    out.push({ path, issues: sortBySeverity(issues) })
  }
  return out
}

/**
 * Issues anywhere at or under `root`, grouped by absolute path and sorted
 * by path. `root` matches itself (dataset-level issues without a location
 * land under the dataset root path) and any path that starts with
 * `root + separator`. Separator is autodetected by checking `root` for
 * backslashes -- the dataset's native separator is what the rest of the
 * app uses, so prefix matches need to follow the same convention.
 */
export function groupedIssuesUnderRoot(
  byPath: ReadonlyMap<string, readonly Issue[]>,
  root: string,
): IssueGroup[] {
  const trimmed = stripTrailingSeparators(root)
  const prefix = `${trimmed}${detectSeparator(root)}`
  const out: IssueGroup[] = []
  for (const [path, issues] of byPath) {
    if (path !== trimmed && !path.startsWith(prefix)) continue
    if (issues.length === 0) continue
    out.push({ path, issues: sortBySeverity(issues) })
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

function sortBySeverity(issues: readonly Issue[]): Issue[] {
  return [...issues].sort((a, b) => severityRank(a) - severityRank(b))
}

function severityRank(issue: Issue): number {
  return issue.severity === 'error' ? 0 : 1
}

/**
 * Render a list of issue groups as Markdown for clipboard export. Used by
 * the Validator messages panel's header-button affordance so the user can
 * paste the currently-displayed diagnostics into a bug report, a chat
 * window, or this tool's audit. Pure / deterministic / locale-agnostic
 * (BIDS diagnostic codes and rule paths stay canonical English per
 * spec §9).
 *
 * Each group is one `### filename` heading followed by a bullet list, one
 * bullet per issue. Severity, code, and subCode appear on the same line so
 * a long list scans as a table; message / suggestion / rule wrap onto
 * indented continuation lines.
 *
 * Returns an empty string for an empty `groups` array (caller decides
 * whether to skip the clipboard write or paste a header on its own).
 */
export function formatIssueGroupsAsMarkdown(
  groups: readonly IssueGroup[],
  options: { showPathHeadings: boolean; basename: (path: string) => string },
): string {
  if (groups.length === 0) return ''
  const out: string[] = []
  for (const group of groups) {
    if (options.showPathHeadings) {
      out.push(`### ${options.basename(group.path)}`)
      out.push('')
    }
    for (const issue of group.issues) {
      // Title-case severity labels: the validator's own
      // `Issue.severity` is the lowercase `'error' | 'warning'`; we
      // pick the casing for the human-readable export. ALL-CAPS reads
      // as shouting in pasted bug reports — Title Case matches GitHub
      // / Markdown convention for emphasis labels.
      const sev = issue.severity === 'error' ? '**Error**' : '**Warning**'
      const subCode = issue.subCode ? ` (${issue.subCode})` : ''
      out.push(`- ${sev} \`${issue.code}\`${subCode}`)
      if (issue.issueMessage) out.push(`  ${issue.issueMessage}`)
      if (issue.suggestion) out.push(`  *Suggestion:* ${issue.suggestion}`)
      if (issue.rule) out.push(`  *Rule:* \`${issue.rule}\``)
      // Blank line between issues so each entry's wrapped continuation
      // lines don't visually run into the next entry's lead bullet.
      out.push('')
    }
  }
  // Drop the final trailing blank line so the export ends with a newline
  // exactly once.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return `${out.join('\n')}\n`
}

/**
 * Path of the next file with at least one error-severity diagnostic, in
 * alphabetical path order. Wraps around: passing the lexicographically-last
 * error path returns the first one again. Passing `currentPath = null`
 * returns the first error path. Returns `null` when no errors exist anywhere
 * in the diagnostics. Used by the StatusBar's Next-error affordance.
 *
 * Why alphabetical instead of tree-display order: it doesn't need the
 * scanner's flatRows, the tree's expanded set, or the show-full-filenames
 * preference -- just the bare diagnostics map. For sorted folders the
 * lexicographic walk lines up closely with the visual walk users do
 * top-to-bottom anyway.
 */
export function nextErrorPath(
  byPath: ReadonlyMap<string, readonly Issue[]>,
  currentPath: string | null,
): string | null {
  const errorPaths: string[] = []
  for (const [path, issues] of byPath) {
    if (issues.some((i) => i.severity === 'error')) errorPaths.push(path)
  }
  if (errorPaths.length === 0) return null
  errorPaths.sort()
  if (currentPath === null) return errorPaths[0] ?? null
  for (const p of errorPaths) {
    if (p > currentPath) return p
  }
  return errorPaths[0] ?? null
}
