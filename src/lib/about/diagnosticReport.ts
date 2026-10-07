// Build the markdown diagnostic report the About dialog's "Copy report"
// button writes to the clipboard. Pure function over `AppInfo` so it
// runs under bun:test without any Tauri / DOM dependency; the dialog
// wires the Tauri-side reads in `appInfo.ts` separately.
//
// Privacy: deliberately ships ONLY environment metadata (versions,
// platform). Dataset paths, recently-opened paths, and any user data
// are excluded. If we ever add a "include selected dataset path"
// toggle, gate it behind explicit opt-in.

import type { AppInfo } from './types'

/**
 * Render `info` as a fenced-markdown block users can paste into a
 * GitHub issue. Stable shape — adding a new section means a new
 * bullet, not a layout change, so issue templates can `grep` for
 * known headings.
 */
export function buildDiagnosticReport(info: AppInfo): string {
  const lines: string[] = [
    '## BIDSvue diagnostic report',
    '',
    `- App version: ${info.version}`,
    `- Platform: ${info.platform} (${info.arch})`,
    `- OS: ${info.osVersion}`,
    '',
    '### Bundled tools',
    '',
    `- BIDS validator: ${info.bundledTools.bidsValidator} schema ${info.bundledTools.bidsSchema}`,
    `- dcm2niix: ${info.bundledTools.dcm2niix}`,
    `- niimath: ${info.bundledTools.niimath}`,
    `- mindgrab: ${info.bundledTools.mindgrab}`,
    `- DataLad: ${info.bundledTools.dataladNative}`,
  ]
  if (info.externalTools.length > 0) {
    lines.push('', '### Detected external tools', '')
    for (const t of info.externalTools) {
      const status = t.available
        ? (t.version ?? 'installed (version unknown)')
        : 'not detected on PATH'
      lines.push(`- ${t.name}: ${status}`)
    }
  }
  return `${lines.join('\n')}\n`
}
