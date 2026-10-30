// Manual parity gate for the reproin-core bridge + TS apply path (not in CI:
// needs DICOM fixtures, dcm2niix on PATH and reproin-rs's compare.py).
//
//   bun scripts/reproin-e2e.ts <dicomDir | --raw=<tree>> <refTree> <compare.py>
//
// 1. dcm2niix -f %H -z y -ba o <dicomDir> into a temp dir (or copy an
//    existing dcm2niix output tree given as --raw=<tree>);
// 2. plan with the bridge (src-tauri `reproin_bridge` example: the Tauri
//    command bodies minus the trust gate), apply via runReproinPostPass +
//    nodeMutateFs, commit; compare.py against <refTree> must print nothing;
// 3. undo that operation, then a fresh run with an injected mid-apply
//    failure + rollback: both must restore the raw dcm2niix tree.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ReproinBridge, runReproinPostPass } from '$lib/import/reproin'
import { type MutateFs, beginOperation } from '$lib/mutate/backup'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs } from '$lib/mutate/testFs'
import { undoOperation } from '$lib/mutate/undo'

const [dicom, ref, compare] = process.argv.slice(2)
if (!compare) throw new Error('usage: <dicomDir> <refTree> <compare.py>')

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.error) throw r.error
  if (
    r.status !== 0 &&
    !(cmd === 'dcm2niix' && [8, 10].includes(r.status ?? 0))
  )
    throw new Error(`${cmd} exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

const manifest = join(import.meta.dir, '../src-tauri/Cargo.toml')
run('cargo', [
  'build',
  '-q',
  '--example',
  'reproin_bridge',
  '--manifest-path',
  manifest,
])
const bin = join(
  import.meta.dir,
  '../src-tauri/target/debug/examples/reproin_bridge',
)
const bridge: ReproinBridge = {
  plan: async (root, exclude, options) =>
    JSON.parse(run(bin, ['plan', root, JSON.stringify(options), ...exclude])),
  dropVolumes: async (path, indices) =>
    run(bin, ['drop', path, indices.join(',')]).trim(),
}

const work = mkdtempSync(join(tmpdir(), 'bidsvue-reproin-e2e-'))
const raw = join(work, 'raw')
if (dicom.startsWith('--raw=')) cpSync(dicom.slice(6), raw, { recursive: true })
else {
  mkdirSync(raw)
  run('dcm2niix', ['-f', '%H', '-z', 'y', '-ba', 'o', '-o', raw, dicom])
}

function statePaths(name: string) {
  const s = join(work, `state-${name}`)
  return {
    stateDir: s,
    prefsPath: join(s, 'prefs.json'),
    operationsLogPath: join(s, 'operations.log'),
    originalsDir: join(s, 'originals'),
    metaPath: join(s, 'meta.json'),
  }
}

function diff(a: string, b: string): string {
  return spawnSync('python3', ['-I', compare, a, b], { encoding: 'utf8' })
    .stdout
}

let failed = false
function report(label: string, d: string) {
  console.log(`${label}: ${d === '' ? 'identical' : `DIFFERENT\n${d}`}`)
  if (d !== '') failed = true
}

// Parity + undo.
const out = join(work, 'out')
cpSync(raw, out, { recursive: true })
const sp = statePaths('out')
const ctx = beginOperation(
  out,
  sp,
  { opType: 'import', summary: 'e2e' },
  nodeMutateFs,
)
const res = await runReproinPostPass(out, ctx, bridge, { producedFiles: [] })
await ctx.commit()
console.log(
  `ops=${res.opsApplied} roots=${res.bidsRoots.length} failures=${res.failures.length}`,
)
cpSync(out, join(work, 'applied'), { recursive: true }) // kept for manual compare.py
report(`compare ${ref} ${work}/applied`, diff(ref, out))
const [entry] = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
await undoOperation(out, sp, entry, nodeMutateFs)
// mkdir is not journaled (in-app, an import's undo removes its created
// tree), so empty directories are the only allowed undo residue.
const undoDiff = diff(raw, out)
  .split('\n')
  .filter((l) => l !== '' && !/^only in output: +\S.*\/$/.test(l))
  .join('\n')
report('undo vs raw (files; empty dirs ignored)', undoDiff)

// Rollback after an injected failure halfway through the journaled steps.
const rb = join(work, 'rollback')
cpSync(raw, rb, { recursive: true })
let steps = 0
const failAt = Math.max(1, Math.floor(entry.children.length / 2))
const once =
  <A extends unknown[]>(f: (...a: A) => Promise<void>) =>
  async (...a: A) => {
    if (++steps === failAt) throw new Error('injected failure')
    return f(...a)
  }
const flaky: MutateFs = {
  ...nodeMutateFs,
  writeTextFile: once(nodeMutateFs.writeTextFile),
  renameNoReplace: once(async (f: string, t: string) =>
    nodeMutateFs.renameNoReplace?.(f, t),
  ),
  finalizeNewFileNoReplace: once(nodeMutateFs.finalizeNewFileNoReplace),
  copyFile: once(nodeMutateFs.copyFile),
}
const ctx2 = beginOperation(
  rb,
  statePaths('rb'),
  { opType: 'import', summary: 'e2e' },
  flaky,
)
const err = await runReproinPostPass(rb, ctx2, bridge).then(
  () => null,
  (e) => e,
)
if (err === null) throw new Error('injected failure did not fire')
await ctx2.rollback(err)
report(`rollback after mutation #${failAt} vs raw`, diff(raw, rb))

console.log(`work dir: ${work}`)
process.exit(failed ? 1 : 0)
