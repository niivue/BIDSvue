// Packaging-consistency tests for the importer manifest.
//
// Catches the failure mode from round-7 audit H1: `manifest.json`
// listed an importer (heudiconv) whose JSON descriptor wasn't
// included in `tauri.conf.json :: bundle.resources`, so the packaged
// app couldn't load the wizard. The fix (commit `bd2f344`) was to
// glob `resources/common/importers/*.json` in bundle.resources.
//
// These tests check the invariants that fix relies on:
//
//   1. Every importer id in manifest.json has a matching `<id>.json`
//      file on disk in resources/common/importers/.
//   2. `tauri.conf.json bundle.resources` covers `*.json` under that
//      directory — either via the glob entry or per-file. We accept
//      both shapes; a future regression that drops the glob without
//      adding explicit entries fails this test.

import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const IMPORTERS_DIR = join(REPO_ROOT, 'resources', 'common', 'importers')
const TAURI_CONF = join(REPO_ROOT, 'src-tauri', 'tauri.conf.json')

describe('importer packaging consistency', () => {
  test('every importer id in manifest.json has a matching <id>.json on disk', async () => {
    const manifest = JSON.parse(
      await readFile(join(IMPORTERS_DIR, 'manifest.json'), 'utf8'),
    ) as { importers: string[] }
    const onDisk = new Set(await readdir(IMPORTERS_DIR))
    for (const id of manifest.importers) {
      expect(onDisk.has(`${id}.json`)).toBe(true)
    }
  })

  test('tauri.conf.json bundles every importer JSON', async () => {
    // Accept either:
    //   - a glob entry `"../resources/common/importers/*.json"`, OR
    //   - explicit per-file entries for every importer.
    //
    // Round-7 audit H1 (heudiconv.json not bundled) was the failure
    // mode this guards against — bd2f344 switched to the glob to
    // make new importer JSONs auto-bundle.
    const conf = JSON.parse(await readFile(TAURI_CONF, 'utf8')) as {
      bundle: { resources: Record<string, string> }
    }
    const resourceKeys = Object.keys(conf.bundle.resources)
    const hasGlob = resourceKeys.some(
      (k) => k.includes('resources/common/importers/') && k.endsWith('*.json'),
    )

    if (hasGlob) {
      // The glob covers everything; nothing further to assert.
      expect(hasGlob).toBe(true)
      return
    }

    // Fallback: every importer JSON must be listed explicitly.
    const manifest = JSON.parse(
      await readFile(join(IMPORTERS_DIR, 'manifest.json'), 'utf8'),
    ) as { importers: string[] }
    const required = [
      'manifest.json',
      ...manifest.importers.map((i) => `${i}.json`),
    ]
    for (const name of required) {
      const found = resourceKeys.some((k) =>
        k.endsWith(`resources/common/importers/${name}`),
      )
      expect(found).toBe(true)
    }
  })
})
