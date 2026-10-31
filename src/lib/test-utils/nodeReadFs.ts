// Test helper: node:fs-backed PostPassFs adapter for bun:test suites and
// scripts. Never imported by production code.

import { promises as nodeFs } from 'node:fs'
import type { PostPassDirEntry, PostPassFs } from '$lib/util/readFs'

export const nodeFsPostPassAdapter: PostPassFs = {
  async exists(path: string): Promise<boolean> {
    try {
      await nodeFs.access(path)
      return true
    } catch {
      return false
    }
  },

  async readDir(path: string): Promise<PostPassDirEntry[]> {
    const entries = await nodeFs.readdir(path, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
    }))
  },

  async readTextFile(path: string): Promise<string> {
    return nodeFs.readFile(path, 'utf8')
  },
}
