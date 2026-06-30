// Unit tests for the native DataLad runner. The Rust side is covered
// by `cargo test --lib datalad_native::*` (URL construction, hashdir,
// SHA-256 verify, journal write); here we verify the renderer-side
// invoke wiring without spawning Rust.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const invokeCalls: Array<{ cmd: string; args: unknown }> = []
let invokeImpl: (cmd: string, args: unknown) => Promise<unknown> = async () =>
  undefined

class MockChannel {
  onmessage: ((msg: unknown) => void) | null = null
}

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown) => {
    invokeCalls.push({ cmd, args })
    return invokeImpl(cmd, args)
  },
  Channel: MockChannel,
}))

/**
 * Strip the opaque Channel reference from a captured invoke args
 * record so tests can `toEqual` against the data-only shape. The
 * channel identity is unstable across calls.
 */
function withoutChannel(args: unknown): unknown {
  if (args === null || typeof args !== 'object') return args
  const { onProgress: _drop, ...rest } = args as Record<string, unknown>
  return rest
}

// Imported AFTER the mock so the SUT picks up the stub.
const {
  bidsvueAnnexRunner,
  dataladRunner,
  probeDataladNative,
  readDataladNativeBackend,
} = await import('./native')

beforeEach(() => {
  invokeCalls.length = 0
  invokeImpl = async () => ({})
})

afterEach(() => {
  invokeCalls.length = 0
})

describe('readDataladNativeBackend', () => {
  test('returns the version record from the Rust command', async () => {
    invokeImpl = async (cmd) => {
      if (cmd === 'datalad_native_version') {
        return {
          name: 'bidsvue-annex',
          version: '0.1.20260606',
          gix: '0.84',
          dataladCompat: '1.5.0',
        }
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const result = await readDataladNativeBackend()
    expect(result).toEqual({
      name: 'bidsvue-annex',
      version: '0.1.20260606',
      gix: '0.84',
      dataladCompat: '1.5.0',
    })
    expect(invokeCalls).toEqual([
      { cmd: 'datalad_native_version', args: undefined },
    ])
  })

  test('returns null when the command is missing (older binary)', async () => {
    invokeImpl = async () => {
      throw new Error('Command datalad_native_version not found')
    }
    const result = await readDataladNativeBackend()
    expect(result).toBeNull()
  })
})

describe('probeDataladNative', () => {
  test('returns the probe shape from Rust', async () => {
    invokeImpl = async (cmd, args) => {
      expect(cmd).toBe('datalad_native_probe')
      expect(args).toEqual({ datasetRoot: '/data/ds005016' })
      return {
        capable: true,
        remotes: [
          {
            uuid: 'ed1038db-e747-436b-ba6c-b431d0dbba4a',
            name: 's3-PUBLIC',
            kind: 's3-exporttree',
            supported: true,
            reason: null,
          },
        ],
        annexUuid: '69fd1860-1bac-4f87-8469-5a78f00b744d',
      }
    }
    const result = await probeDataladNative({ datasetRoot: '/data/ds005016' })
    expect(result?.capable).toBe(true)
    expect(result?.remotes[0].supported).toBe(true)
    expect(result?.annexUuid).toBe('69fd1860-1bac-4f87-8469-5a78f00b744d')
  })

  test('refuses an empty dataset root', async () => {
    await expect(probeDataladNative({ datasetRoot: '' })).rejects.toThrow(
      'datasetRoot is required',
    )
  })
})

describe('bidsvueAnnexRunner.get', () => {
  test('routes through datalad_native_get and returns the summary stdout', async () => {
    invokeImpl = async (cmd, args) => {
      expect(cmd).toBe('datalad_native_get')
      expect(withoutChannel(args)).toEqual({
        datasetRoot: '/data/ds005016',
        paths: ['/data/ds005016/sub-01/T1w.nii'],
        cancelHandle: undefined,
      })
      return {
        fetchedCount: 1,
        fetchedBytes: 1234,
        items: [
          {
            path: '/data/ds005016/sub-01/T1w.nii',
            key: 'SHA256E-s1234--abcd',
            url: 'https://s3.amazonaws.com/.../T1w.nii',
            objectPath: '/data/ds005016/.git/annex/objects/xx/3Q/...',
            bytes: 1234,
            contentHashHex: 'abcd',
            error: null,
          },
        ],
      }
    }
    const result = await bidsvueAnnexRunner.get({
      datasetRoot: '/data/ds005016',
      paths: ['/data/ds005016/sub-01/T1w.nii'],
    })
    expect(result.stdout).toBe('get(ok): /data/ds005016/sub-01/T1w.nii')
    expect(result.stderr).toBe('')
  })

  test('mints a cancel handle when signal is provided and dispatches cancel_datalad_op on abort', async () => {
    const ac = new AbortController()
    let capturedHandle: string | undefined
    invokeImpl = async (cmd, args) => {
      if (cmd === 'datalad_native_get') {
        const a = args as Record<string, unknown>
        capturedHandle = a.cancelHandle as string
        // Hold the promise open so we can abort before it resolves;
        // resolving immediately would race the abort listener.
        await new Promise<void>((resolve) => {
          ac.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return {
          fetchedCount: 0,
          fetchedBytes: 0,
          items: [
            {
              path: '/d/x',
              key: 'SHA256E-s1--00',
              url: null,
              objectPath: null,
              bytes: null,
              contentHashHex: null,
              error: 'cancelled by user',
            },
          ],
        }
      }
      if (cmd === 'cancel_datalad_op') {
        // Fired by the abort listener — must carry the same handle
        // that was minted at invoke time so the Rust registry can
        // route it to the right Notify.
        const a = args as Record<string, unknown>
        expect(a.handle).toBe(capturedHandle)
        return null
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const promise = bidsvueAnnexRunner.get({
      datasetRoot: '/data/x',
      paths: ['/data/x/y'],
      signal: ac.signal,
    })
    // Allow the invoke to begin so capturedHandle is set.
    await new Promise((r) => setTimeout(r, 0))
    expect(typeof capturedHandle).toBe('string')
    ac.abort()
    await expect(promise).rejects.toThrow('0/1 fetched')
    const cancelCalls = invokeCalls.filter((c) => c.cmd === 'cancel_datalad_op')
    expect(cancelCalls).toHaveLength(1)
  })

  test('throws when every item fails', async () => {
    invokeImpl = async () => ({
      fetchedCount: 0,
      fetchedBytes: 0,
      items: [
        {
          path: '/data/ds005016/sub-01/T1w.nii',
          key: 'SHA256E-s1--00',
          url: null,
          objectPath: null,
          bytes: null,
          contentHashHex: null,
          error: 'HTTP 404',
        },
      ],
    })
    await expect(
      bidsvueAnnexRunner.get({
        datasetRoot: '/data/ds005016',
        paths: ['/data/ds005016/sub-01/T1w.nii'],
      }),
    ).rejects.toThrow('0/1 fetched')
  })

  test('aborts before issuing the invoke when signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      bidsvueAnnexRunner.get({
        datasetRoot: '/data/ds005016',
        paths: ['/data/ds005016/x'],
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/)
    expect(invokeCalls).toEqual([])
  })

  test('routes noContent=true through the native subdataset install command', async () => {
    // M-DL4: `noContent` (the CLI's `-n` flag) maps to
    // `datalad_native_install_subdataset` rather than the bulk fetch.
    invokeImpl = async (cmd, args) => {
      if (cmd === 'datalad_native_install_subdataset') {
        expect(args).toEqual({
          datasetRoot: '/data/ds005016',
          subpath: 'sub-XX',
          cancelHandle: undefined,
        })
        return {
          name: 'sub-XX',
          path: 'sub-XX',
          moduleDir: '/data/ds005016/.git/modules/sub-XX',
          worktreeDir: '/data/ds005016/sub-XX',
          head: 'abc1234',
        }
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const result = await bidsvueAnnexRunner.get({
      datasetRoot: '/data/ds005016',
      paths: ['/data/ds005016/sub-XX'],
      noContent: true,
    })
    expect(result.stdout).toBe('install(ok): sub-XX (sub-XX) head=abc1234')
    expect(invokeCalls[0].cmd).toBe('datalad_native_install_subdataset')
  })
})

describe('bidsvueAnnexRunner.probe', () => {
  test('returns the native backend identity as a synthesised probe result', async () => {
    invokeImpl = async (cmd) => {
      if (cmd === 'datalad_native_version') {
        return {
          name: 'bidsvue-annex',
          version: '0.1.20260606',
          gix: '0.84',
          dataladCompat: '1.5.0',
        }
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const result = await bidsvueAnnexRunner.probe()
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DataLad 1.5.0 (bidsvue-annex 0.1.20260606, gix 0.84)',
      stderr: '',
    })
  })
})

describe('bidsvueAnnexRunner.update', () => {
  test('routes through datalad_native_update with default remote omitted', async () => {
    invokeImpl = async (cmd, args) => {
      if (cmd === 'datalad_native_update') {
        const a = args as Record<string, unknown>
        // When the caller omits remoteName, we forward `undefined`
        // and the Rust side defaults to `origin`. Don't fabricate a
        // string here — that would silently mask a future change in
        // the default at the Rust layer.
        expect(a.remoteName).toBeUndefined()
        expect(a.datasetRoot).toBe('/data/ds005016')
        expect(a.cancelHandle).toBeUndefined()
        return {
          remote: 'origin',
          from: 'a'.repeat(40),
          to: 'b'.repeat(40),
          incomingCommits: 1,
          indexRewriteWarning: null,
          bytesTransferred: 4096,
          backend: {
            name: 'bidsvue-annex',
            version: '0.1.20260615',
            gix: '0.84',
            dataladCompat: '1.5.0',
          },
        }
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const result = await bidsvueAnnexRunner.update({
      datasetRoot: '/data/ds005016',
    })
    expect(result.remote).toBe('origin')
    expect(result.incomingCommits).toBe(1)
    expect(result.bytesTransferred).toBe(4096)
    expect(result.indexRewriteWarning).toBeNull()
    expect(result.from).not.toBe(result.to)
    expect(result.backend?.name).toBe('bidsvue-annex')
    expect(result.stdout).toContain('fast-forwarded')
  })

  test('surfaces indexRewriteWarning when Rust reports the post-apply rewrite failed', async () => {
    // Audit round 3 P2.1: previously the index-rewrite failure was
    // logged to stderr only; the renderer saw a clean `update(ok)`
    // even though external `git status` would report dirty. The
    // field is plumbed through both the typed result + the
    // onProgress channel as `update(warn): ...`.
    invokeImpl = async () => ({
      remote: 'origin',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      incomingCommits: 1,
      indexRewriteWarning:
        'worktree + HEAD advanced to bbbb but index rewrite failed: lock contention. External `git status` will report dirty until you run `git reset HEAD`.',
      bytesTransferred: 0,
      backend: {
        name: 'bidsvue-annex',
        version: '0.1.0',
        gix: '0.84',
        dataladCompat: '1.5.0',
      },
    })
    const captured: string[] = []
    const result = await bidsvueAnnexRunner.update({
      datasetRoot: '/data/x',
      onProgress: (line) => captured.push(`${line.kind}: ${line.line}`),
    })
    expect(result.indexRewriteWarning).toContain('index rewrite failed')
    expect(result.stderr).toContain('index rewrite failed')
    expect(captured.some((l) => l.startsWith('stderr: update(warn):'))).toBe(
      true,
    )
  })

  test('normalises a missing indexRewriteWarning field to null without emitting a warning', async () => {
    // Audit round 5 P3.1: an older Rust binary or a serde transform
    // that drops the field could send `undefined`. The runner MUST
    // collapse that to `null` so callers branching on `result
    // .indexRewriteWarning === null` see the no-warning case as
    // expected, AND must NOT emit `update(warn): undefined` on the
    // progress stream. The mock omits the field entirely (simulates
    // the older-binary wire shape).
    invokeImpl = async () => ({
      remote: 'origin',
      from: 'f'.repeat(40),
      to: 'g'.repeat(40),
      incomingCommits: 1,
      // indexRewriteWarning intentionally missing
      bytesTransferred: 100,
      backend: {
        name: 'bidsvue-annex',
        version: '0.1.0',
        gix: '0.84',
        dataladCompat: '1.5.0',
      },
    })
    const captured: string[] = []
    const result = await bidsvueAnnexRunner.update({
      datasetRoot: '/data/x',
      onProgress: (line) => captured.push(`${line.kind}: ${line.line}`),
    })
    // Typed contract: `string | null`, not `undefined`. Strict
    // equality so a future regression that returns `undefined` here
    // fails LOUDLY.
    expect(result.indexRewriteWarning).toBeNull()
    expect(result.stderr).toBe('')
    expect(captured.some((l) => l.startsWith('stderr: update(warn):'))).toBe(
      false,
    )
  })

  test('emits a no-op summary when from === to', async () => {
    invokeImpl = async () => ({
      remote: 'origin',
      from: 'c'.repeat(40),
      to: 'c'.repeat(40),
      incomingCommits: 0,
      indexRewriteWarning: null,
      bytesTransferred: 0,
      backend: {
        name: 'bidsvue-annex',
        version: '0.1.0',
        gix: '0.84',
        dataladCompat: '1.5.0',
      },
    })
    const captured: string[] = []
    const result = await bidsvueAnnexRunner.update({
      datasetRoot: '/data/x',
      onProgress: (line) => captured.push(line.line),
    })
    expect(result.incomingCommits).toBe(0)
    expect(result.stdout).toContain('already up to date')
    expect(captured.join('\n')).toContain('already up to date')
  })

  test('forwards an explicit remoteName', async () => {
    invokeImpl = async (cmd, args) => {
      if (cmd === 'datalad_native_update') {
        const a = args as Record<string, unknown>
        expect(a.remoteName).toBe('upstream')
        return {
          remote: 'upstream',
          from: 'd'.repeat(40),
          to: 'e'.repeat(40),
          incomingCommits: 2,
          indexRewriteWarning: null,
          bytesTransferred: 1234,
          backend: {
            name: 'bidsvue-annex',
            version: '0.1.0',
            gix: '0.84',
            dataladCompat: '1.5.0',
          },
        }
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const result = await bidsvueAnnexRunner.update({
      datasetRoot: '/data/x',
      remoteName: 'upstream',
    })
    expect(result.remote).toBe('upstream')
    expect(result.incomingCommits).toBe(2)
  })

  test('mints a cancel handle when signal is provided and dispatches cancel_datalad_op on abort', async () => {
    const ac = new AbortController()
    let capturedHandle: string | undefined
    invokeImpl = async (cmd, args) => {
      if (cmd === 'datalad_native_update') {
        const a = args as Record<string, unknown>
        capturedHandle = a.cancelHandle as string
        await new Promise<void>((resolve) => {
          ac.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        // Simulate a Rust-side cancellation rejection — same shape the
        // command currently surfaces ("cancelled by user").
        throw new Error('datalad_native_update: cancelled by user')
      }
      if (cmd === 'cancel_datalad_op') {
        const a = args as Record<string, unknown>
        expect(a.handle).toBe(capturedHandle)
        return null
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const promise = bidsvueAnnexRunner.update({
      datasetRoot: '/data/x',
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(typeof capturedHandle).toBe('string')
    ac.abort()
    await expect(promise).rejects.toThrow('cancelled by user')
    const cancelCalls = invokeCalls.filter((c) => c.cmd === 'cancel_datalad_op')
    expect(cancelCalls).toHaveLength(1)
  })

  test('aborts before issuing the invoke when signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      bidsvueAnnexRunner.update({
        datasetRoot: '/data/x',
        signal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/)
    expect(invokeCalls).toEqual([])
  })

  test('throws when datasetRoot is missing', async () => {
    await expect(
      bidsvueAnnexRunner.update({ datasetRoot: '' }),
    ).rejects.toThrow('datasetRoot is required')
  })

  test('preserves the refusal=<wire> token in the Rust error message', async () => {
    // The renderer's typed-error mapper switches on the
    // `refusal=<wire>` substring; the runner MUST NOT mangle that
    // string en route. This test guards against a future refactor
    // that "tidies" the error or swallows the suffix.
    invokeImpl = async () => {
      throw new Error(
        'update_dataset: local branch `main` has diverged from `origin/main`; resolve outside BIDSvue (force-pull is out of scope) [refusal=diverged-history]',
      )
    }
    await expect(
      bidsvueAnnexRunner.update({ datasetRoot: '/data/x' }),
    ).rejects.toThrow('refusal=diverged-history')
  })
})

describe('dataladRunner', () => {
  test('is the bidsvueAnnexRunner singleton', () => {
    // M-DL8 closure: there is no CLI fallback, so the export is always
    // the native runner. Identity check guards against accidental
    // re-introduction of a selector that varies by env.
    expect(dataladRunner).toBe(bidsvueAnnexRunner)
  })
})
