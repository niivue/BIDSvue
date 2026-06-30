#!/usr/bin/env bun
// Fetch the Linux + Windows bundled sidecars from AppVeyor and write them
// to the committed source-of-truth at `resources/{linux,windows}/<basename>`.
//
// Why this exists: unlike the macOS arm64 sidecars (built locally by the
// maintainer), the Linux/Windows binaries come from AppVeyor CI. This script
// is the single source of truth for WHICH build each one comes from. Run it
// when bumping a sidecar version, then commit the refreshed binaries:
//
//   bun run scripts/fetch-sidecars.ts && git add resources/linux resources/windows
//
// It is NOT part of the build/CI path — the binaries are committed, so a
// fresh clone + `bun install` stages them via `stage-sidecars.ts` without any
// network access. This keeps cross-platform builds reproducible and AppVeyor
// uptime off the critical path.
//
// Each AppVeyor artifact is a zip containing exactly one correctly-named
// binary (verified 2026-06-28), so extraction is a straight unzip.
//
// Two URL forms exist on AppVeyor:
//   - pinned (a specific build, reproducible):
//       https://ci.appveyor.com/api/buildjobs/<jobId>/artifacts/<file>
//   - latest-on-branch (auto-tracks releases):
//       https://ci.appveyor.com/api/projects/<acct>/<proj>/artifacts/<file>?branch=master&job=<linux|win>
// We pin every entry below so a re-fetch reproduces the exact bytes we
// validated. dcm2niix MUST stay pinned (we track a dev build, not a release);
// niimath + bids-validator-rs can move to the latest-on-branch form once they
// cut releases matching the macOS binary.

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Sidecar {
  /** `resources/<platform>/` subdir. */
  platform: 'linux' | 'windows'
  /** AppVeyor build job id (the `buildjobs/<jobId>` segment). */
  jobId: string
  /** Artifact file name AND the single binary inside the zip. */
  file: string
  /** Expected basename written under resources/<platform>/. */
  binary: string
  /** Expected SHA-256 of the extracted binary. */
  sha256: string
}

// Pinned builds (verified 2026-06-28):
//   bids-validator-rs 28-Jun-2026_g321ac30
//   niimath           28-Jun-2026_g169c563
//   dcm2niix (dev)    28-Jun-2026_gb07bfe2
const SIDECARS: Sidecar[] = [
  // bids-validator-rs (neurolabusc/bids-validator-rs)
  {
    platform: 'linux',
    jobId: '25w2p4xfkhpl22dt',
    file: 'bids-validator_lnx.zip',
    binary: 'bids-validator',
    sha256: 'e3d3b1dce9fdac76904e8271aeb92a85e00339ede8e93c3c2df4fb353a1ea2a1',
  },
  {
    platform: 'windows',
    jobId: 'qquliuyr55c94pq5',
    file: 'bids-validator_win.zip',
    binary: 'bids-validator.exe',
    sha256: 'a953b08dbbcd6786d60af033245e322b2d58deb4f0afc109a1f8ff0fd93f2504',
  },
  // niimath (neurolabusc/niimath)
  {
    platform: 'linux',
    jobId: '7n2chnwj6bsf0762',
    file: 'niimath_lnx.zip',
    binary: 'niimath',
    sha256: '1425ffd26fdd072a639f045e5590229580f3db79d675e8d1003eca065c259d7a',
  },
  {
    platform: 'windows',
    jobId: '8v7xxda61th65ep3',
    file: 'niimath_win.zip',
    binary: 'niimath.exe',
    sha256: '7d9ae54892ee1e2c522b068a81ede1f42b8dd24256dec256950b85ef2c9cc337',
  },
  // dcm2niix DEV build (chrisfilo/dcm2niix) — keep pinned, not latest-on-branch
  {
    platform: 'linux',
    jobId: 't47t99lk6gx0i1x0',
    file: 'dcm2niix_lnx.zip',
    binary: 'dcm2niix',
    sha256: 'a08f50fb259650adc039c8008984a1c25814540446f479a6ae0b631f2a08a306',
  },
  {
    platform: 'windows',
    jobId: 'yjmgu6n24an7b64x',
    file: 'dcm2niix_win.zip',
    binary: 'dcm2niix.exe',
    sha256: 'c5c0310ba6b84b0059a0245d6eb3d5aae6e3c1a1c209b6c75056d69abc31982d',
  },
]

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    )
  })
}

async function fetchOne(s: Sidecar, scratch: string): Promise<void> {
  const url = `https://ci.appveyor.com/api/buildjobs/${s.jobId}/artifacts/${s.file}`
  const destDir = join('resources', s.platform)
  await mkdir(destDir, { recursive: true })

  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`)
  const zipPath = join(scratch, s.file)
  await Bun.write(zipPath, await res.arrayBuffer())

  // Each zip holds exactly one file named `s.binary`. `unzip -o -j` flattens
  // and overwrites into destDir; `unzip` ships on macOS + Linux.
  await run('unzip', ['-o', '-j', zipPath, s.binary, '-d', destDir])
  const out = join(destDir, s.binary)
  if (!(await Bun.file(out).exists())) {
    throw new Error(`expected ${out} after extracting ${s.file}`)
  }
  const actualSha256 = createHash('sha256')
    .update(Buffer.from(await Bun.file(out).arrayBuffer()))
    .digest('hex')
  if (actualSha256 !== s.sha256) {
    throw new Error(
      `sha256 mismatch for ${out}: expected ${s.sha256}, got ${actualSha256}`,
    )
  }
  console.log(`[fetch-sidecars] ${url} -> ${out}`)
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'bidsvue-fetch-sidecars-'))
  try {
    for (const s of SIDECARS) await fetchOne(s, scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  console.log(
    `[fetch-sidecars] ${SIDECARS.length} binaries written. Review + commit resources/{linux,windows}/.`,
  )
}

main().catch((err) => {
  console.error(
    `[fetch-sidecars] failed: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
})
