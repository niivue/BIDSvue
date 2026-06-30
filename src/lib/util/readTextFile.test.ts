import { describe, expect, test } from 'bun:test'
import {
  type ReadFileDeps,
  type ReadTextFileDeps,
  readFileWithSymlinkResolve,
  readTextFileWithRustFallback,
  resolveSymlinkIfPresent,
} from './readTextFile'

/**
 * Helper: build a deps stub from per-test behaviour. Both functions
 * default to throwing so a test that forgets to wire a branch fails
 * loudly instead of silently exercising the wrong path.
 */
function makeDeps(
  opts: {
    pluginFs?: (path: string) => Promise<string>
    rust?: (path: string) => Promise<string | null>
  } = {},
): ReadTextFileDeps {
  return {
    pluginFsReadTextFile:
      opts.pluginFs ??
      (async () => {
        throw new Error('test did not configure pluginFsReadTextFile')
      }),
    invokeReadAuthorizedTextFile:
      opts.rust ??
      (async () => {
        throw new Error('test did not configure invokeReadAuthorizedTextFile')
      }),
  }
}

describe('readTextFileWithRustFallback', () => {
  test('happy path: plugin-fs succeeds, Rust fallback never invoked', async () => {
    let invokeCount = 0
    const deps = makeDeps({
      pluginFs: async (path) => `plugin-fs:${path}`,
      rust: async () => {
        invokeCount++
        return null
      },
    })
    expect(
      await readTextFileWithRustFallback('/root/sub-01/anat/x.json', deps),
    ).toBe('plugin-fs:/root/sub-01/anat/x.json')
    // Zero IPC cost when plugin-fs is satisfied — the core perf
    // promise of the fallback wrapper.
    expect(invokeCount).toBe(0)
  })

  test('plugin-fs rejects (forbidden path) + Rust returns string -> returns Rust value', async () => {
    // Track invocations in an array — TypeScript can't follow the
    // async-callback assignment for a let-rebinding (CFA loses
    // track), but a const Array<string> with push is unambiguous.
    const invokedWith: string[] = []
    const deps = makeDeps({
      pluginFs: async () => {
        throw new Error(
          "Couldn't read the file: forbidden path: /root/.reproin_provenance.tsv",
        )
      },
      rust: async (path) => {
        invokedWith.push(path)
        return 'rust-bytes'
      },
    })
    const result = await readTextFileWithRustFallback(
      '/root/.reproin_provenance.tsv',
      deps,
    )
    expect(result).toBe('rust-bytes')
    expect(invokedWith).toEqual(['/root/.reproin_provenance.tsv'])
  })

  test('plugin-fs rejects + Rust returns null (ENOENT) -> rethrows ORIGINAL plugin-fs error', async () => {
    // When the file genuinely doesn't exist, the original error
    // ("forbidden path" is what plugin-fs reports for both ENOENT
    // AND scope-rejected dotfiles) is the more actionable signal;
    // surfacing the Rust ENOENT-as-null would lose that.
    const pluginErr = new Error('forbidden path: /root/missing.tsv')
    const deps = makeDeps({
      pluginFs: async () => {
        throw pluginErr
      },
      rust: async () => null,
    })
    let caught: unknown
    try {
      await readTextFileWithRustFallback('/root/missing.tsv', deps)
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(pluginErr)
  })

  test('plugin-fs rejects + Rust ALSO throws -> rethrows ORIGINAL plugin-fs error', async () => {
    // If Rust rejects too (e.g. path is not under any runtime-
    // authorized root, which would be a renderer bug), the
    // plugin-fs error is still the more useful one for the user.
    const pluginErr = new Error('forbidden path: /elsewhere/foo')
    const deps = makeDeps({
      pluginFs: async () => {
        throw pluginErr
      },
      rust: async () => {
        throw new Error('read_authorized_text_file: not under runtime root')
      },
    })
    let caught: unknown
    try {
      await readTextFileWithRustFallback('/elsewhere/foo', deps)
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(pluginErr)
  })
})

describe('readFileWithSymlinkResolve', () => {
  function makeBytesDeps(
    opts: {
      readFile?: (path: string) => Promise<Uint8Array>
      readLink?: (path: string) => Promise<string>
    } = {},
  ): ReadFileDeps {
    return {
      pluginFsReadFile:
        opts.readFile ??
        (async () => {
          throw new Error('test did not configure pluginFsReadFile')
        }),
      invokeReadLink:
        opts.readLink ??
        (async () => {
          throw new Error('readLink failed (not a symlink)')
        }),
    }
  }

  test('regular file (not a symlink): read_link throws, plugin-fs reads the original path', async () => {
    const readPaths: string[] = []
    const deps = makeBytesDeps({
      readFile: async (path) => {
        readPaths.push(path)
        return new Uint8Array([1, 2, 3])
      },
      readLink: async () => {
        throw new Error('EINVAL: not a symlink')
      },
    })
    const out = await readFileWithSymlinkResolve(
      '/root/sub-01/anat/sub-01_T1w.nii.gz',
      deps,
    )
    expect(out).toEqual(new Uint8Array([1, 2, 3]))
    expect(readPaths).toEqual(['/root/sub-01/anat/sub-01_T1w.nii.gz'])
  })

  test('relative annex symlink: pre-resolved to absolute before plugin-fs read', async () => {
    // Canonical DataLad / git-annex shape: a fetched pointer is a
    // RELATIVE symlink reaching back to `.git/annex/objects/...`.
    // Without pre-resolution, plugin-fs's scope check would
    // canonicalize via `path.exists()` from CWD and fail.
    const readPaths: string[] = []
    const deps = makeBytesDeps({
      readFile: async (path) => {
        readPaths.push(path)
        return new Uint8Array([42])
      },
      readLink: async (path) => {
        expect(path).toBe('/root/sub-01/anat/sub-01_T1w.nii.gz')
        return '../../.git/annex/objects/MD/5E/abc/sub-01_T1w.nii.gz'
      },
    })
    const out = await readFileWithSymlinkResolve(
      '/root/sub-01/anat/sub-01_T1w.nii.gz',
      deps,
    )
    expect(out).toEqual(new Uint8Array([42]))
    // The crucial assertion: plugin-fs sees the resolved absolute
    // path (which matches the `<root>/.git/annex/objects/**` scope
    // carve-out), NOT the original symlink path.
    expect(readPaths).toEqual([
      '/root/.git/annex/objects/MD/5E/abc/sub-01_T1w.nii.gz',
    ])
  })

  test('absolute symlink target: passed through verbatim to plugin-fs', async () => {
    const readPaths: string[] = []
    const deps = makeBytesDeps({
      readFile: async (path) => {
        readPaths.push(path)
        return new Uint8Array([7])
      },
      readLink: async () => '/elsewhere/storage/foo.nii.gz',
    })
    await readFileWithSymlinkResolve('/root/sub-01/anat/foo.nii.gz', deps)
    // resolveRelativePosix sees an absolute path → returns it
    // unchanged. The caller is responsible for the scope correctness
    // of absolute symlink targets (we don't restrict them here
    // because legitimate use cases exist — e.g. user-mounted
    // shared storage).
    expect(readPaths).toEqual(['/elsewhere/storage/foo.nii.gz'])
  })

  test('plugin-fs failure propagates (caller sees the error)', async () => {
    const pluginErr = new Error('forbidden path: /root/x')
    const deps = makeBytesDeps({
      readFile: async () => {
        throw pluginErr
      },
      readLink: async () => {
        throw new Error('not a symlink')
      },
    })
    let caught: unknown
    try {
      await readFileWithSymlinkResolve('/root/x', deps)
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(pluginErr)
  })
})

describe('resolveSymlinkIfPresent', () => {
  test('regular file (read_link throws): returns original path', async () => {
    const result = await resolveSymlinkIfPresent(
      '/root/sub-01/anat/sub-01_T1w.nii.gz',
      async () => {
        throw new Error('EINVAL: not a symlink')
      },
    )
    expect(result).toBe('/root/sub-01/anat/sub-01_T1w.nii.gz')
  })

  test('relative annex symlink: resolved against the parent dir', async () => {
    const result = await resolveSymlinkIfPresent(
      '/root/sub-01/anat/sub-01_T1w.nii.gz',
      async () => '../../.git/annex/objects/MD/5E/abc/sub-01_T1w.nii.gz',
    )
    // Cross-check: the resolved path lands in the
    // `<root>/.git/annex/objects/**` carve-out plugin-fs already
    // knows about, so a follow-up plugin-fs call against it
    // succeeds where one against the original symlink would have
    // failed with "forbidden path".
    expect(result).toBe('/root/.git/annex/objects/MD/5E/abc/sub-01_T1w.nii.gz')
  })

  test('absolute symlink target: returned verbatim', async () => {
    const result = await resolveSymlinkIfPresent(
      '/root/sub-01/anat/foo.nii.gz',
      async () => '/elsewhere/storage/foo.nii.gz',
    )
    expect(result).toBe('/elsewhere/storage/foo.nii.gz')
  })

  test('readLink invokeReadLink errors flat-fall to the original path', async () => {
    // ENOENT, permission denied, etc — anything that throws from
    // read_link should hand back the original path so plugin-fs can
    // either succeed (real file in scope) or fail with its own
    // diagnostic. Helps non-symlink paths and surprising IO errors
    // share the same "no-op pass-through" branch.
    let calls = 0
    const result = await resolveSymlinkIfPresent(
      '/root/foo.nii.gz',
      async () => {
        calls++
        throw new Error('EACCES: permission denied')
      },
    )
    expect(result).toBe('/root/foo.nii.gz')
    expect(calls).toBe(1)
  })
})
