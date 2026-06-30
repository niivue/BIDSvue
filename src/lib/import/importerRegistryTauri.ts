// Production-side `ImporterReader` backed by Tauri's resource plugin
// (resolveResource) + plugin-fs::readTextFile. Kept in its own module
// so the pure-TS `importerRegistry.ts` and its bun:test suite never
// pull in @tauri-apps/* at parse time.

import { resolveResource } from '@tauri-apps/api/path'
import { readTextFile } from '@tauri-apps/plugin-fs'
import type { ImporterReader } from './importerRegistry'

export const tauriImporterReader: ImporterReader = {
  async readJson(name: string): Promise<unknown> {
    const absPath = await resolveResource(`common/importers/${name}`)
    const text = await readTextFile(absPath)
    return JSON.parse(text)
  },
}
