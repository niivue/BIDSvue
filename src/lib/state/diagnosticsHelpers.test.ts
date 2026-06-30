import { describe, expect, test } from 'bun:test'
import type { Issue } from '$lib/validation/runValidator'
import {
  formatIssueGroupsAsMarkdown,
  groupedIssuesForPaths,
  groupedIssuesUnderRoot,
  nextErrorPath,
} from './diagnosticsHelpers'

function issue(severity: 'error' | 'warning', code: string): Issue {
  return { code, severity }
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx === -1 ? path : path.slice(idx + 1)
}

describe('groupedIssuesForPaths', () => {
  test('skips paths with no issues', () => {
    const byPath = new Map<string, Issue[]>([
      ['/a.json', [issue('error', 'A')]],
    ])
    expect(groupedIssuesForPaths(byPath, ['/a.json', '/b.json'])).toEqual([
      { path: '/a.json', issues: [issue('error', 'A')] },
    ])
  })

  test('sorts errors before warnings within a group', () => {
    const byPath = new Map<string, Issue[]>([
      [
        '/a.json',
        [issue('warning', 'W1'), issue('error', 'E1'), issue('warning', 'W2')],
      ],
    ])
    const out = groupedIssuesForPaths(byPath, ['/a.json'])
    expect(out[0].issues.map((i) => i.code)).toEqual(['E1', 'W1', 'W2'])
  })

  test('preserves emit order among same-severity issues', () => {
    // The comparator must return 0 for equal severities, otherwise
    // V8/JSC's stable-sort guarantee silently slips for error/error and
    // warning/warning pairs. Regression test for the M3 audit finding.
    const byPath = new Map<string, Issue[]>([
      [
        '/a.json',
        [
          issue('error', 'E1'),
          issue('error', 'E2'),
          issue('error', 'E3'),
          issue('warning', 'W1'),
          issue('warning', 'W2'),
          issue('warning', 'W3'),
        ],
      ],
    ])
    const out = groupedIssuesForPaths(byPath, ['/a.json'])
    expect(out[0].issues.map((i) => i.code)).toEqual([
      'E1',
      'E2',
      'E3',
      'W1',
      'W2',
      'W3',
    ])
  })

  test('preserves the caller-supplied path order', () => {
    const byPath = new Map<string, Issue[]>([
      ['/z.json', [issue('error', 'Z')]],
      ['/a.json', [issue('error', 'A')]],
    ])
    expect(
      groupedIssuesForPaths(byPath, ['/z.json', '/a.json']).map((g) => g.path),
    ).toEqual(['/z.json', '/a.json'])
  })
})

describe('groupedIssuesUnderRoot', () => {
  test('includes dataset-level issues stored at the root key', () => {
    const byPath = new Map<string, Issue[]>([
      ['/data/ds', [issue('error', 'MISSING_DATASET_DESCRIPTION')]],
      ['/data/ds/sub-01/anat/sub-01_T1w.nii.gz', [issue('warning', 'W')]],
    ])
    const out = groupedIssuesUnderRoot(byPath, '/data/ds')
    expect(out.map((g) => g.path)).toEqual([
      '/data/ds',
      '/data/ds/sub-01/anat/sub-01_T1w.nii.gz',
    ])
  })

  test('rejects sibling paths that share only a prefix string', () => {
    const byPath = new Map<string, Issue[]>([
      ['/data/ds', [issue('error', 'A')]],
      ['/data/ds-other/sub-01/x.json', [issue('error', 'B')]],
    ])
    const out = groupedIssuesUnderRoot(byPath, '/data/ds')
    expect(out.map((g) => g.path)).toEqual(['/data/ds'])
  })

  test('sorts result paths alphabetically', () => {
    const byPath = new Map<string, Issue[]>([
      ['/r/z.json', [issue('error', 'Z')]],
      ['/r/a.json', [issue('error', 'A')]],
      ['/r/m.json', [issue('error', 'M')]],
    ])
    expect(groupedIssuesUnderRoot(byPath, '/r').map((g) => g.path)).toEqual([
      '/r/a.json',
      '/r/m.json',
      '/r/z.json',
    ])
  })

  test('handles Windows-style backslash paths', () => {
    const byPath = new Map<string, Issue[]>([
      ['C:\\data\\ds', [issue('error', 'A')]],
      ['C:\\data\\ds\\sub-01\\x.json', [issue('warning', 'B')]],
      ['C:\\data\\other\\y.json', [issue('error', 'C')]],
    ])
    const out = groupedIssuesUnderRoot(byPath, 'C:\\data\\ds')
    expect(out.map((g) => g.path)).toEqual([
      'C:\\data\\ds',
      'C:\\data\\ds\\sub-01\\x.json',
    ])
  })

  test('tolerates a trailing separator on the root argument', () => {
    const byPath = new Map<string, Issue[]>([
      ['/r/a.json', [issue('error', 'A')]],
    ])
    expect(groupedIssuesUnderRoot(byPath, '/r/').map((g) => g.path)).toEqual([
      '/r/a.json',
    ])
  })

  test('returns an empty array when nothing is under the root', () => {
    const byPath = new Map<string, Issue[]>([
      ['/elsewhere/a.json', [issue('error', 'A')]],
    ])
    expect(groupedIssuesUnderRoot(byPath, '/r')).toEqual([])
  })
})

describe('nextErrorPath', () => {
  test('returns null when no paths have errors', () => {
    const byPath = new Map<string, Issue[]>([
      ['/a.json', [issue('warning', 'W')]],
    ])
    expect(nextErrorPath(byPath, null)).toBeNull()
  })

  test('skips warning-only paths', () => {
    const byPath = new Map<string, Issue[]>([
      ['/w.json', [issue('warning', 'W')]],
      ['/e.json', [issue('error', 'E')]],
    ])
    expect(nextErrorPath(byPath, null)).toBe('/e.json')
  })

  test('returns the first error path when currentPath is null', () => {
    const byPath = new Map<string, Issue[]>([
      ['/z.json', [issue('error', 'Z')]],
      ['/a.json', [issue('error', 'A')]],
      ['/m.json', [issue('error', 'M')]],
    ])
    expect(nextErrorPath(byPath, null)).toBe('/a.json')
  })

  test('returns the next path strictly greater than currentPath', () => {
    const byPath = new Map<string, Issue[]>([
      ['/a.json', [issue('error', 'A')]],
      ['/m.json', [issue('error', 'M')]],
      ['/z.json', [issue('error', 'Z')]],
    ])
    expect(nextErrorPath(byPath, '/a.json')).toBe('/m.json')
    expect(nextErrorPath(byPath, '/m.json')).toBe('/z.json')
  })

  test('wraps around at the last error path', () => {
    const byPath = new Map<string, Issue[]>([
      ['/a.json', [issue('error', 'A')]],
      ['/z.json', [issue('error', 'Z')]],
    ])
    expect(nextErrorPath(byPath, '/z.json')).toBe('/a.json')
  })

  test('treats currentPath that does not contain an error as a cursor only', () => {
    // A user might be selecting a clean file when they press Next error;
    // we should advance to the first error past it, not error out.
    const byPath = new Map<string, Issue[]>([
      ['/m.json', [issue('error', 'M')]],
      ['/z.json', [issue('error', 'Z')]],
    ])
    expect(nextErrorPath(byPath, '/a.json')).toBe('/m.json')
  })
})

describe('formatIssueGroupsAsMarkdown', () => {
  test('returns empty string for empty groups', () => {
    expect(
      formatIssueGroupsAsMarkdown([], { showPathHeadings: true, basename }),
    ).toBe('')
  })

  test('omits path headings when showPathHeadings is false', () => {
    const out = formatIssueGroupsAsMarkdown(
      [
        {
          path: '/r/sub-01/anat/sub-01_T1w.json',
          issues: [
            { code: 'SIDECAR_KEY_MISSING', severity: 'error', subCode: 'X' },
          ],
        },
      ],
      { showPathHeadings: false, basename },
    )
    expect(out).not.toContain('### ')
    expect(out).toContain('**Error** `SIDECAR_KEY_MISSING` (X)')
  })

  test('emits one heading per group when showPathHeadings is true', () => {
    const out = formatIssueGroupsAsMarkdown(
      [
        {
          path: '/r/a.json',
          issues: [{ code: 'C1', severity: 'error' }],
        },
        {
          path: '/r/b.json',
          issues: [{ code: 'C2', severity: 'warning' }],
        },
      ],
      { showPathHeadings: true, basename },
    )
    expect(out).toContain('### a.json')
    expect(out).toContain('### b.json')
    expect(out).toContain('**Error** `C1`')
    expect(out).toContain('**Warning** `C2`')
  })

  test('renders message, suggestion, and rule when present', () => {
    const out = formatIssueGroupsAsMarkdown(
      [
        {
          path: '/r/x.json',
          issues: [
            {
              code: 'SIDECAR_RECOMMENDED',
              severity: 'warning',
              subCode: 'SliceTiming',
              issueMessage: 'Field description: SliceTiming is the…',
              suggestion: 'Add it',
              rule: 'rules.sidecars.mri.SliceTimingMRI',
            },
          ],
        },
      ],
      { showPathHeadings: false, basename },
    )
    expect(out).toContain('**Warning** `SIDECAR_RECOMMENDED` (SliceTiming)')
    expect(out).toContain('Field description: SliceTiming is the…')
    expect(out).toContain('*Suggestion:* Add it')
    expect(out).toContain('*Rule:* `rules.sidecars.mri.SliceTimingMRI`')
  })

  test('ends with exactly one trailing newline', () => {
    const out = formatIssueGroupsAsMarkdown(
      [
        {
          path: '/r/x.json',
          issues: [{ code: 'C', severity: 'error' }],
        },
      ],
      { showPathHeadings: true, basename },
    )
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  test('separates consecutive issues with a blank line', () => {
    const out = formatIssueGroupsAsMarkdown(
      [
        {
          path: '/r/x.json',
          issues: [
            {
              code: 'A',
              severity: 'warning',
              subCode: 'one',
              issueMessage: 'first message',
            },
            {
              code: 'B',
              severity: 'warning',
              subCode: 'two',
              issueMessage: 'second message',
            },
          ],
        },
      ],
      { showPathHeadings: false, basename },
    )
    // The two issues should be separated by a blank line so a pasted
    // bug report can be skim-read without the second issue running
    // visually into the first issue's continuation lines.
    expect(out).toContain('first message\n\n- **Warning** `B`')
  })
})
