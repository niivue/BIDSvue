import { describe, expect, test } from 'bun:test'
import {
  MAX_ISSUE_URL_BYTES,
  PROJECT_REPO_URL,
  buildIssueUrl,
  releaseTagUrl,
} from './issueUrl'

const SHORT_REPORT = '## diagnostic\n- App version: 0.1.0\n- Platform: macos\n'

describe('buildIssueUrl', () => {
  test('short report yields untruncated URL targeting issues/new', () => {
    const { url, truncated } = buildIssueUrl(SHORT_REPORT)
    expect(truncated).toBe(false)
    expect(
      url.startsWith('https://github.com/niivue/BIDSvue/issues/new?body='),
    ).toBe(true)
    expect(url.length).toBeLessThan(MAX_ISSUE_URL_BYTES)
  })

  test('body is URL-encoded so newlines round-trip', () => {
    const { url } = buildIssueUrl(SHORT_REPORT)
    const body = decodeURIComponent(url.split('?body=')[1] ?? '')
    expect(body).toContain('<details><summary>Diagnostic report</summary>')
    expect(body).toContain('## diagnostic')
    expect(body).toContain('App version: 0.1.0')
  })

  test('hint comment precedes the diagnostic block', () => {
    const { url } = buildIssueUrl(SHORT_REPORT)
    const body = decodeURIComponent(url.split('?body=')[1] ?? '')
    // The HTML-comment prompt should be near the top of the body so
    // the user sees an actionable cursor position when GitHub renders
    // the prefilled form.
    expect(body.startsWith('<!--')).toBe(true)
    const commentEnd = body.indexOf('-->')
    const detailsStart = body.indexOf('<details>')
    expect(commentEnd).toBeGreaterThan(-1)
    expect(detailsStart).toBeGreaterThan(commentEnd)
  })

  test('oversize report is truncated and marked', () => {
    const huge = 'X'.repeat(50_000)
    const { url, truncated } = buildIssueUrl(huge)
    expect(truncated).toBe(true)
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_BYTES)
    const body = decodeURIComponent(url.split('?body=')[1] ?? '')
    expect(body).toContain('truncated')
    expect(body).toContain('About > Copy report')
  })

  test('truncation preserves the leading hint comment', () => {
    const huge = 'Y'.repeat(50_000)
    const { url } = buildIssueUrl(huge)
    const body = decodeURIComponent(url.split('?body=')[1] ?? '')
    expect(body.startsWith('<!--')).toBe(true)
  })

  test('empty report still composes a URL', () => {
    const { url, truncated } = buildIssueUrl('')
    expect(truncated).toBe(false)
    expect(url).toContain('issues/new?body=')
  })
})

describe('releaseTagUrl + PROJECT_REPO_URL', () => {
  test('releaseTagUrl points at the versioned tag', () => {
    expect(releaseTagUrl('0.1.20260517')).toBe(
      'https://github.com/niivue/BIDSvue/releases/tag/v0.1.20260517',
    )
  })

  test('PROJECT_REPO_URL points at the project repo', () => {
    expect(PROJECT_REPO_URL).toBe('https://github.com/niivue/BIDSvue')
  })
})
