import { describe, expect, test } from 'bun:test'
import { OP_TYPES } from './backup'
import type { MutateFs, OpType, OperationLogEntry } from './backup'
import { readOperationsLog } from './operationsLog'

/** In-memory fs adapter scoped to a single log path; avoids tmpdir setup. */
function makeFs(initial: Record<string, string>): MutateFs {
  const files = new Map<string, string>(Object.entries(initial))
  return {
    async exists(path) {
      return files.has(path)
    },
    async readTextFile(path) {
      const v = files.get(path)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async readFile() {
      throw new Error('unused')
    },
    async readDir() {
      throw new Error('unused')
    },
    async stat() {
      throw new Error('unused')
    },
    async chmod() {
      throw new Error('unused')
    },
    async mkdir() {
      /* unused */
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async appendLogLine(path, line) {
      files.set(path, `${files.get(path) ?? ''}${line}\n`)
    },
    async writeTextAtomicAppData(path, contents) {
      files.set(path, contents)
    },
    async writeFile() {
      throw new Error('unused')
    },
    async copyFile() {
      throw new Error('unused')
    },
    async rename() {
      throw new Error('unused')
    },
    async finalizeNewFileNoReplace() {
      throw new Error('unused')
    },
    async remove(path) {
      files.delete(path)
    },
  }
}

const sampleEntry = (
  id: string,
  opType: OpType = 'sidecarEdit',
): OperationLogEntry => ({
  id,
  timestamp: '2026-05-11T20:00:00.000Z',
  opType,
  summary: `op ${id}`,
  children: [
    { kind: 'write', target: 'a.json', backupRelPath: `${id}/a.json` },
  ],
})

describe('readOperationsLog', () => {
  test('returns empty array when the log file does not exist', async () => {
    const fs = makeFs({})
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result).toEqual([])
  })

  test('parses one well-formed entry', async () => {
    const entry = sampleEntry('A')
    const fs = makeFs({
      '/state/operations.log': `${JSON.stringify(entry)}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(entry)
  })

  // Guards against the 2026-06-28 P1: a new OpType (then `'merge'`) added
  // to the union but NOT to the reader's allowlist silently dropped every
  // entry of that type from History / Undo. KNOWN_OP_TYPES is now derived
  // from OP_TYPES, so every op type MUST survive the reader.
  test('every OP_TYPES member round-trips through the reader', async () => {
    for (const opType of OP_TYPES) {
      const entry = sampleEntry(`op-${opType}`, opType)
      const fs = makeFs({
        '/state/operations.log': `${JSON.stringify(entry)}\n`,
      })
      const result = await readOperationsLog('/state/operations.log', fs)
      expect(result, `op type "${opType}" must survive the reader`).toEqual([
        entry,
      ])
    }
  })

  test('returns entries in chronological order (the on-disk order)', async () => {
    const a = sampleEntry('A')
    const b = sampleEntry('B')
    const c = sampleEntry('C')
    const fs = makeFs({
      '/state/operations.log': `${[a, b, c].map((e) => JSON.stringify(e)).join('\n')}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result.map((e) => e.id)).toEqual(['A', 'B', 'C'])
  })

  test('drops malformed JSON lines, keeps well-formed ones', async () => {
    const a = sampleEntry('A')
    const fs = makeFs({
      '/state/operations.log': `${JSON.stringify(a)}\n{not json\n${JSON.stringify(sampleEntry('B'))}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result.map((e) => e.id)).toEqual(['A', 'B'])
  })

  test('drops entries missing required fields', async () => {
    const a = sampleEntry('A')
    const fs = makeFs({
      '/state/operations.log': `${JSON.stringify(a)}\n${JSON.stringify({ id: 'x', timestamp: 't' })}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result.map((e) => e.id)).toEqual(['A'])
  })

  test('drops entries with malformed children', async () => {
    const a = sampleEntry('A')
    const bad = {
      id: 'B',
      timestamp: 't',
      opType: 'sidecarEdit',
      summary: 's',
      children: [{ kind: 'write', target: 42 }], // target should be a string
    }
    const fs = makeFs({
      '/state/operations.log': `${JSON.stringify(a)}\n${JSON.stringify(bad)}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result.map((e) => e.id)).toEqual(['A'])
  })

  test('drops entries with malformed child details', async () => {
    const a = sampleEntry('A')
    const bad = {
      id: 'B',
      timestamp: 't',
      opType: 'datalad-save',
      summary: 's',
      children: [
        {
          kind: 'datalad-commit',
          hash: 'abc123',
          message: 'Save BIDSvue edits',
          details: 'stale-shape',
        },
      ],
    }
    const fs = makeFs({
      '/state/operations.log': `${JSON.stringify(a)}\n${JSON.stringify(bad)}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result.map((e) => e.id)).toEqual(['A'])
  })

  test('accepts each ChildStep kind', async () => {
    const entry: OperationLogEntry = {
      id: 'X',
      timestamp: 't',
      opType: 'datalad-save',
      summary: 's',
      children: [
        { kind: 'write', target: 'a.json', backupRelPath: null },
        { kind: 'rename', from: 'a', to: 'b' },
        { kind: 'delete', target: 'b.json', backupRelPath: 'X/b.json' },
        { kind: 'created-tree', target: '' },
        { kind: 'removed-tree', target: 'imports/run-1' },
        {
          kind: 'datalad-commit',
          hash: 'abc123',
          message: 'Save BIDSvue edits',
        },
      ],
    }
    const fs = makeFs({
      '/state/operations.log': `${JSON.stringify(entry)}\n`,
    })
    const result = await readOperationsLog('/state/operations.log', fs)
    expect(result).toHaveLength(1)
    expect(result[0].children).toHaveLength(6)
  })
})
