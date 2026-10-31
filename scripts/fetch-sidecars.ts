#!/usr/bin/env bun
// Fetch the Linux + Windows bundled sidecars (GitHub releases) and write them
// to the committed source-of-truth at `resources/{linux,windows}/<basename>`.
//
// Why this exists: unlike the macOS arm64 sidecars (built locally by the
// maintainer), the Linux/Windows binaries come from upstream CI releases. This script
// is the single source of truth for WHICH build each one comes from. Run it
// when bumping a sidecar version, then commit the refreshed binaries:
//
//   bun run scripts/fetch-sidecars.ts && git add resources/linux resources/windows
//
// It is NOT part of the build/CI path — the binaries are committed, so a
// fresh clone + `bun install` stages them via `stage-sidecars.ts` without any
// network access. This keeps cross-platform builds reproducible and network
// uptime off the critical path.
//
// Pins are GitHub release assets: durable, unlike AppVeyor artifacts, which
// expire. The sha256 check guarantees a re-fetch reproduces the bytes we
// validated. Release zips may carry extras
// (LICENSE, MSVC DLLs the static exe doesn't need); only `binary` is taken.

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
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

// Pinned builds (GitHub releases):
//   niimath           v1.0.20261016
//   dcm2niix          v1.0.20261029
//   bids-validator-rs v0.1.20261031 (BIDS Validator 3.0.2, schema 1.2.7)
const GH = 'https://github.com/rordenlab'
const NIIMATH = `${GH}/niimath/releases/download/v1.0.20261016`
const DCM2NIIX = `${GH}/dcm2niix/releases/download/v1.0.20261029`
const VALIDATOR = `${GH}/bids-validator-rs/releases/download/v0.1.20261031`

const SIDECARS: Sidecar[] = [
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
  // bids-validator-rs (rordenlab/bids-validator-rs)
  {
    platform: 'linux',
    url: `${VALIDATOR}/bids-validator_lnx.zip`,
    binary: 'bids-validator',
    sha256: 'da9c68fa40399fcfb071e74a715cb3b0cb7e2d5a78297731b53b6eefab55b9f1',
  },
  {
    platform: 'windows',
    url: `${VALIDATOR}/bids-validator_win.zip`,
    binary: 'bids-validator.exe',
    sha256: '9b36ff0449266e1de19ff948e7ce8b9ddb145b6398e1791dae55cb6ba041d926',
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
  const { url } = s
  const destDir = join('resources', s.platform)
  await mkdir(destDir, { recursive: true })

  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`)
  const zipPath = join(scratch, `${s.platform}-${s.binary}.zip`)
  await Bun.write(zipPath, await res.arrayBuffer())

  // Extract + verify in scratch; only verified bytes reach resources/.
  // `unzip` ships on macOS + Linux.
  const unpacked = join(scratch, s.platform)
  await run('unzip', ['-o', '-j', zipPath, s.binary, '-d', unpacked])
  const bytes = Buffer.from(
    await Bun.file(join(unpacked, s.binary)).arrayBuffer(),
  )
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== s.sha256) {
    throw new Error(
      `sha256 mismatch for ${url}: expected ${s.sha256}, got ${actualSha256}`,
    )
  }
  const out = join(destDir, s.binary)
  await copyFile(join(unpacked, s.binary), out)
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
