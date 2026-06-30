// GitHub-issue URL builder for the Help > "Report an issue…" menu item
// and the AboutDialog's "Report issue" button (Day-4 Goal 4.2).
//
// Composes a `https://github.com/<owner>/<repo>/issues/new?body=...` URL
// with the existing markdown diagnostic report prefilled inside a
// <details> block. Trims the report (not the user-visible hint) if the
// composed URL would exceed GitHub's practical query-string limit and
// adds a truncation marker so the reporter still has actionable copy.
//
// The repo target is hard-coded -- this is BIDSvue's own bug tracker on
// `niivue/BIDSvue`. Forks that want to point elsewhere fork the
// constant.

const GITHUB_REPO = 'niivue/BIDSvue'

/**
 * Practical limit for the composed URL. GitHub silently truncates query
 * strings past ~8 KiB on the issue-new endpoint and some browsers cap
 * around 8 KiB as well. 6 KiB leaves headroom for the URL structure
 * (scheme, host, path, body= key, encoded markdown overhead) and the
 * "...truncated" marker.
 */
export const MAX_ISSUE_URL_BYTES = 6 * 1024

const BODY_TEMPLATE_HEADER =
  '<!-- Describe what happened, what you expected, and any steps to reproduce. -->\n\n'

const TRUNCATION_MARKER =
  '\n\n…[diagnostic report truncated — copy the full report from About > Copy report and paste it here]'

export interface BuiltIssueUrl {
  url: string
  /** True when the diagnostic report had to be trimmed to fit the URL cap. */
  truncated: boolean
}

/**
 * Wrap the diagnostic-report markdown inside a collapsible <details>
 * block so the body's leading lines stay reserved for the user's own
 * description.
 */
function wrapReport(report: string, truncated: boolean): string {
  const summary = truncated
    ? 'Diagnostic report (truncated)'
    : 'Diagnostic report'
  return `<details><summary>${summary}</summary>\n\n${report}\n</details>\n`
}

/**
 * Build the prefilled issue URL. Returns the URL plus a `truncated`
 * flag the caller can use to warn the user before opening it.
 *
 * The body has two pieces: a one-line HTML comment prompting the
 * reporter for their own description, followed by a collapsed
 * `<details>` block with the diagnostic report. The user opens the
 * URL in their browser, the GitHub form lands prefilled, they fill
 * in title + description, and submit.
 *
 * Truncation strategy: if the composed URL exceeds MAX_ISSUE_URL_BYTES,
 * keep shrinking the report's tail until it fits, then append the
 * truncation marker. The marker itself is small enough to leave room
 * for the remaining URL overhead. The user-visible hint at the top of
 * the body is never trimmed -- losing it would degrade the prompt for
 * the reporter to add their own description.
 */
export function buildIssueUrl(diagnosticReport: string): BuiltIssueUrl {
  const base = `https://github.com/${GITHUB_REPO}/issues/new`
  const compose = (body: string): string =>
    `${base}?body=${encodeURIComponent(body)}`

  const fullBody = BODY_TEMPLATE_HEADER + wrapReport(diagnosticReport, false)
  const fullUrl = compose(fullBody)
  if (fullUrl.length <= MAX_ISSUE_URL_BYTES) {
    return { url: fullUrl, truncated: false }
  }

  // Binary-search-ish shrink: start from the full report and halve the
  // remaining tail until the encoded URL fits. Stops at length 0 if
  // even the empty-report case still overflows (would only happen if
  // BODY_TEMPLATE_HEADER + TRUNCATION_MARKER themselves blow the cap).
  let lo = 0
  let hi = diagnosticReport.length
  let best = 0
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const trimmed = diagnosticReport.slice(0, mid) + TRUNCATION_MARKER
    const body = BODY_TEMPLATE_HEADER + wrapReport(trimmed, true)
    const url = compose(body)
    if (url.length <= MAX_ISSUE_URL_BYTES) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const trimmedReport = diagnosticReport.slice(0, best) + TRUNCATION_MARKER
  const trimmedBody = BODY_TEMPLATE_HEADER + wrapReport(trimmedReport, true)
  return { url: compose(trimmedBody), truncated: true }
}

/** Public URL to the project's GitHub repo. */
export const PROJECT_REPO_URL = `https://github.com/${GITHUB_REPO}`

/**
 * Public URL to a specific release tag. Used by the Help > "What's
 * new" item to land the user on the release notes for the version
 * they're actually running.
 */
export function releaseTagUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/tag/v${version}`
}
