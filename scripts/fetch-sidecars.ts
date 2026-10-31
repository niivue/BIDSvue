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
// Pins are either a GitHub release asset (tagged releases: dcm2niix,
// niimath) or an AppVeyor build job (bids-validator-rs, until it cuts a
// release). Release assets are durable; AppVeyor artifacts EXPIRE (the
// bids-validator-rs jobs already 404), so move it to a release asap. The
// sha256 check guarantees a re-fetch reproduces the bytes we validated. Release zips may carry extras
// (LICENSE, MSVC DLLs the static exe doesn't need); only `binary` is taken.

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Sidecar {
  /** `resources/<platform>/` subdir. */
  platform: 'linux' | 'windows'
  /** Zip download URL. */
  url: string
  /** Expected basename written under resources/<platform>/. */
  binary: string
  /** Expected SHA-256 of the extracted binary. */
  sha256: string
}

// Pinned builds:
//   bids-validator-rs 28-Jun-2026_g321ac30
//   niimath           v1.0.20261016 (GitHub release)
//   dcm2niix          v1.0.20261029 (GitHub release)
const APPVEYOR = 'https://ci.appveyor.com/api/buildjobs'
const GH = 'https://github.com/rordenlab'
const NIIMATH = `${GH}/niimath/releases/download/v1.0.20261016`
const DCM2NIIX = `${GH}/dcm2niix/releases/download/v1.0.20261029`

const SIDECARS: Sidecar[] = [
  // bids-validator-rs (neurolabusc/bids-validator-rs)
  {
    platform: 'linux',
    url: `${APPVEYOR}/25w2p4xfkhpl22dt/artifacts/bids-validator_lnx.zip`,
    binary: 'bids-validator',
    sha256: 'e3d3b1dce9fdac76904e8271aeb92a85e00339ede8e93c3c2df4fb353a1ea2a1',
  },
  {
    platform: 'windows',
    url: `${APPVEYOR}/qquliuyr55c94pq5/artifacts/bids-validator_win.zip`,
    binary: 'bids-validator.exe',
    sha256: 'a953b08dbbcd6786d60af033245e322b2d58deb4f0afc109a1f8ff0fd93f2504',
  },
  // niimath (neurolabusc/niimath)
  {
    platform: 'linux',
    url: `${NIIMATH}/niimath_lnx.zip`,
    binary: 'niimath',
    sha256: '19f6cbdf97d691cf7a867311960c9f760aa50ea860ed2feba16fc18fbbf6b4ce',
  },
  {
    platform: 'windows',
    url: `${NIIMATH}/niimath_win.zip`,
    binary: 'niimath.exe',
    sha256: '6d9f4ed705c2bf3bd58527dd1db0eb449b0116a267633ab959fb084fe7360e2c',
  },
  // dcm2niix (rordenlab/dcm2niix)
  {
    platform: 'linux',
    url: `${DCM2NIIX}/dcm2niix_lnx.zip`,
    binary: 'dcm2niix',
    sha256: 'a1aeea2a700fbc76d1233cbf17c78c7e63d40e821e03e9e01772e9cde1400429',
  },
  {
    platform: 'windows',
    url: `${DCM2NIIX}/dcm2niix_win.zip`,
    binary: 'dcm2niix.exe',
    sha256: '583b3066cdc961f33662562be15fbd925411b3ff6126aa822a8050550449cb0a',
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
  const url = s.url
  const destDir = join('resources', s.platform)
  await mkdir(destDir, { recursive: true })

  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`)
  const zipPath = join(scratch, `${s.platform}-${s.binary}.zip`)
  await Bun.write(zipPath, await res.arrayBuffer())

  // `unzip -o -j` extracts just `s.binary`, flattened, overwriting into
  // destDir; `unzip` ships on macOS + Linux.
  await run('unzip', ['-o', '-j', zipPath, s.binary, '-d', destDir])
  const out = join(destDir, s.binary)
  if (!(await Bun.file(out).exists())) {
    throw new Error(`expected ${out} after extracting ${url}`)
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
