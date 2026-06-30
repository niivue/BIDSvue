// Vite alias target for `@jsr/libs__xml`.
//
// The validator's `files/tiff.ts` imports `@jsr/libs__xml` and calls
// `XML.parse(imageDescription)` to extract OME-TIFF metadata. The
// underlying package loads its parser via a WebAssembly data URI
// (`data:application/wasm;base64,...`), which Rollup -- Vite's
// production bundler -- refuses to handle:
//
//   > data URI with non-JavaScript mime type is not supported.
//
// We don't validate microscopy / OME-TIFF data in BIDSvue today, and
// `parseTIFF` itself is gated by an `.tif`/`.btf` extension check and
// further wrapped in `.catch()` (see schema/context.ts::loadTIFF). So
// the stub fires only for TIFF files BIDSvue isn't targeting, and even
// then the validator swallows the throw and continues with
// `{ tiff: undefined, ome: undefined }`. Safe-fail by design.
//
// If/when BIDSvue grows microscopy support, replace this stub with a
// real browser-friendly XML parser -- either a Vite plugin that loads
// the upstream WASM properly, or a hand-rolled minimal parser for the
// OME-TIFF subset the validator actually inspects.

export function parse(_xml: string): never {
  throw new Error(
    "[bidsvue] @jsr/libs__xml is stubbed: BIDSvue's renderer build doesn't include the upstream WASM XML parser. OME-TIFF metadata parsing is intentionally unsupported.",
  )
}
