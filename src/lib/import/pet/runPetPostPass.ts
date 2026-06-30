// M12 PET-importer post-pass. Walks the freshly-imported BIDS root,
// finds every `_pet.json` sidecar, applies `enrichPetSidecar` (with
// the optional operator-supplied metadata overlay), and writes the
// result back through the `OperationContext` so it participates in
// the import's atomicity + undo.
//
// Failure model (mirrors the M8-A2 reproin post-pass): per-file
// try/catch. One bad sidecar -> one failure entry in the result; the
// rest of the walk continues so the import as a whole succeeds.
// Cross-file invariants (which the reproin pass DOES care about via
// `_scans.tsv` aggregation) don't apply here: each `_pet.json` is
// edited independently.

import type { PostPassFs } from '$lib/import/postpass/fs'
import { walkSessions } from '$lib/import/postpass/walkSessions'
import type { OperationContext } from '$lib/mutate/backup'
import { parseSidecar, serializeSidecar } from '$lib/sidecar/parse'
import { type SidecarJson, enrichPetSidecar } from './enrich'

export interface PetPostPassResult {
  /** Number of `_pet.json` sidecars successfully enriched. */
  sidecarsEnriched: number
  failures: ReadonlyArray<{ sidecarPath: string; error: string }>
}

export interface RunPetPostPassOptions {
  /**
   * Optional operator-supplied PET sidecar fields. Overlaid onto every
   * `_pet.json` the walk finds (operator wins on conflict, same as
   * pypet2bids). When absent, the enricher only does the
   * dcm2niix-output normalisation pass.
   */
  metadata?: SidecarJson | null
}

export async function runPetPostPass(
  rootDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
  options: RunPetPostPassOptions = {},
): Promise<PetPostPassResult> {
  const sidecars = await findPetSidecars(rootDir, fs)
  const metadata = options.metadata ?? undefined
  const failures: Array<{ sidecarPath: string; error: string }> = []
  let sidecarsEnriched = 0

  for (const sidecarPath of sidecars) {
    try {
      const text = await fs.readTextFile(sidecarPath)
      const parsed = parseSidecar(text)
      if (!isPlainObject(parsed.value)) {
        throw new Error(
          `PET sidecar root is not a JSON object (got ${typeof parsed.value})`,
        )
      }
      const enriched = enrichPetSidecar(parsed.value as SidecarJson, {
        metadata,
      })
      const body = serializeSidecar(enriched, parsed.format)
      await ctx.writeText(sidecarPath, body, {
        kind: 'pet-postpass-sidecar',
      })
      sidecarsEnriched++
    } catch (err) {
      failures.push({
        sidecarPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { sidecarsEnriched, failures }
}

async function findPetSidecars(
  rootDir: string,
  fs: PostPassFs,
): Promise<string[]> {
  const sessions = await walkSessions(rootDir, fs)
  const out: string[] = []
  for (const sessionDir of sessions) {
    const petDir = `${sessionDir}/pet`
    if (!(await fs.exists(petDir))) continue
    let entries: Awaited<ReturnType<PostPassFs['readDir']>>
    try {
      entries = await fs.readDir(petDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile) continue
      if (entry.name.endsWith('_pet.json')) {
        out.push(`${petDir}/${entry.name}`)
      }
    }
  }
  out.sort()
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
