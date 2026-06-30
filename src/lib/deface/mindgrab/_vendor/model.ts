// Vendored mindgrab orchestrator.
//
// Trimmed from @niivue/nv-ext-brain2print/src/index.ts (the brain2print
// package is an unpublished tech demo; we copy only what mindgrab-as-deface
// needs and drop subcortical / tissue_fast / mesh / colormap / NVImage
// glue). Upstream lives in github.com/niivue/niivue's mono workspace
// `packages/nv-ext-brain2print/`. When upstream changes the loader
// signature, refresh this file alongside `mindgrab.ts`.
//
// Public surface:
//   - `loadMindgrab(device, weights)`            — warm up the GPU pipeline
//   - `MindgrabInferer`                          — callable inferer + dispose
//   - `transposeToModel` / `transposeFromModel`  — NIfTI <-> z-fastest mem order
//   - `MINDGRAB_DIM`, `MINDGRAB_VOXEL_COUNT`     — model input grid (256³)
//   - `REQUIRED_BUFFER_BYTES`                    — re-export from probe.ts

import { REQUIRED_BUFFER_BYTES } from '../probe'
import mindgrabImpl from './mindgrab'

export { REQUIRED_BUFFER_BYTES }

/** Input grid edge length. The model is hard-coded for 256³ 1 mm. */
export const MINDGRAB_DIM = 256
/** Total voxels in the model's input grid. */
export const MINDGRAB_VOXEL_COUNT = MINDGRAB_DIM * MINDGRAB_DIM * MINDGRAB_DIM

/**
 * Callable inference closure. Pass a normalized 256³ Float32 volume (in
 * z-fastest memory order — use {@link transposeToModel} to convert from
 * NIfTI order) and receive the per-class output tensors. `results[0]` is
 * the argmax label volume — for mindgrab that's a binary brain mask
 * (0 = non-brain, 1 = brain).
 *
 * Inference calls are NOT internally serialised — the underlying tinygrad
 * pipeline shares input/output buffers across calls and would race on
 * writes if invoked concurrently. Callers must serialise their own calls.
 *
 * Always `await dispose()` when tearing down: drains the in-flight
 * inference and destroys every `GPUBuffer` allocated during `load`.
 * Awaiting before destroying the parent `GPUDevice` keeps
 * `buffer.destroy()` off a dead device. Idempotent.
 */
export type MindgrabInferer = {
  (img32: Float32Array): Promise<Float32Array[]>
  dispose: () => Promise<void>
}

type GeneratedInferer = (img32: Float32Array) => Promise<Float32Array[]>
type ModelImpl = {
  load: (device: GPUDevice, weights: Uint8Array) => Promise<GeneratedInferer>
}
type TrackingDevice = Pick<
  GPUDevice,
  | 'createBindGroup'
  | 'createBindGroupLayout'
  | 'createBuffer'
  | 'createCommandEncoder'
  | 'createComputePipelineAsync'
  | 'createPipelineLayout'
  | 'createShaderModule'
  | 'queue'
>

function destroyBuffers(buffers: GPUBuffer[]): void {
  for (const buffer of buffers) {
    try {
      buffer.destroy()
    } catch {
      // Device loss or double-destroy should not mask caller cleanup.
    }
  }
  buffers.length = 0
}

function createTrackingDevice(
  device: GPUDevice,
  buffers: GPUBuffer[],
): GPUDevice {
  const trackingDevice: TrackingDevice = {
    createBindGroup: device.createBindGroup.bind(device),
    createBindGroupLayout: device.createBindGroupLayout.bind(device),
    createBuffer: (descriptor: GPUBufferDescriptor): GPUBuffer => {
      const buffer = device.createBuffer(descriptor)
      buffers.push(buffer)
      return buffer
    },
    createCommandEncoder: device.createCommandEncoder.bind(device),
    createComputePipelineAsync: device.createComputePipelineAsync.bind(device),
    createPipelineLayout: device.createPipelineLayout.bind(device),
    createShaderModule: device.createShaderModule.bind(device),
    queue: device.queue,
  }
  return trackingDevice as unknown as GPUDevice
}

async function readWeights(
  weights: ArrayBuffer | Uint8Array | string,
): Promise<Uint8Array> {
  if (typeof weights !== 'string') {
    return new Uint8Array(weights)
  }
  const response = await fetch(weights)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch mindgrab weights from ${weights}: ${response.status} ${response.statusText}`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Warm up the mindgrab tinygrad pipeline and return a `MindgrabInferer`.
 * `weights` can be a `.safetensors` URL string (`convertFileSrc()` of the
 * bundled resource), an `ArrayBuffer`, or a `Uint8Array`.
 *
 * GPU buffers allocated during `load` are tracked so `inferer.dispose()`
 * can release them deterministically.
 */
export async function loadMindgrab(
  device: GPUDevice,
  weights: ArrayBuffer | Uint8Array | string,
): Promise<MindgrabInferer> {
  const trackedBuffers: GPUBuffer[] = []
  const bytes = await readWeights(weights)
  let generatedInferer: GeneratedInferer
  try {
    generatedInferer = await (mindgrabImpl as unknown as ModelImpl).load(
      createTrackingDevice(device, trackedBuffers),
      bytes,
    )
  } catch (err) {
    destroyBuffers(trackedBuffers)
    throw err
  }

  let disposed = false
  // Tracks in-flight inferences so `dispose()` waits for ALL of them to
  // settle before destroying tracked GPU buffers. Stores a *void-fulfilled*
  // mirror, NOT the original `run` promise, so the Set doesn't pin each
  // result's `Float32Array[]` (~64 MB per call) until dispose.
  const inflight = new Set<Promise<void>>()

  const inferer = ((img32: Float32Array): Promise<Float32Array[]> => {
    if (disposed) {
      return Promise.reject(new Error('Mindgrab inferer has been disposed'))
    }
    if (img32.length !== MINDGRAB_VOXEL_COUNT) {
      return Promise.reject(
        new Error(
          `Mindgrab expected ${MINDGRAB_VOXEL_COUNT} voxels, got ${img32.length}`,
        ),
      )
    }
    const run = generatedInferer(img32)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    inflight.add(settled)
    settled.finally(() => inflight.delete(settled))
    return run
  }) as MindgrabInferer

  inferer.dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await Promise.allSettled(inflight)
    destroyBuffers(trackedBuffers)
  }

  return inferer
}

// ---------------------------------------------------------------------------
// NIfTI <-> model memory-order transpose helpers
// ---------------------------------------------------------------------------
//
// NIfTI memory order is x-fastest: `index = x + y*size + z*size²`. The
// tinygrad model expects z-fastest: `index = z + y*size + x*size²`. Both
// directions are needed: forward before inference, inverse after. Without
// this the mask voxels land on the wrong axes — visually plausible but
// anatomically misaligned. Two specialised functions instead of one with
// a `direction` flag to keep the per-iteration branch out of a 16 M-element
// inner loop.

/**
 * Transpose a NIfTI-ordered Float32 volume into the z-fastest order the
 * tinygrad model expects. Caller-supplied `size` must equal
 * `MINDGRAB_DIM` (256); we don't assert to keep the helper allocation-free.
 */
export function transposeToModel(
  data: Float32Array,
  size: number,
): Float32Array {
  const out = new Float32Array(data.length)
  let it = 0
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        out[it++] = data[x + y * size + z * size * size]
      }
    }
  }
  return out
}

/**
 * Transpose model-ordered Float32 labels into NIfTI-ordered Uint8 labels
 * in a single pass — avoids a 64 MB Float32 transient. Values are clamped
 * to `[0, 255]`. For mindgrab the labels are binary (0 / 1), well within
 * the byte range.
 */
export function transposeFromModelAsLabels(
  data: Float32Array,
  size: number,
): Uint8Array {
  const out = new Uint8Array(data.length)
  let it = 0
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      for (let z = 0; z < size; z++) {
        const v = data[it++]
        out[x + y * size + z * size * size] =
          v > 0 ? (v < 255 ? Math.round(v) : 255) : 0
      }
    }
  }
  return out
}
