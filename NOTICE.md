# Licensing

## BIDSvue

BIDSvue itself is distributed under the **BSD 2-Clause License**. The
canonical text is in [LICENSE](LICENSE).

## Third-party attributions

This document lists upstream projects whose code, schemas, or
documentation BIDSvue has ported, mirrored, or referenced. Each entry
includes the upstream license, the affected files in BIDSvue, and a
short note on what was reused. The full upstream license texts are
not re-bundled here; the upstream repositories carry them in
canonical form.

### brainlife / cli (MIT)

Upstream: <https://github.com/brainlife/cli> (MIT-licensed)

The cloud-share pipeline at [src/lib/share/brainlife/](src/lib/share/brainlife/)
ports the auth + project-create + per-candidate upload flow that
brainlife's CLI implements in JS. Files most directly informed by
the upstream:

- [`auth.ts`](src/lib/share/brainlife/auth.ts) — shape mirrors `util.js#loadJwt`
- [`api.ts`](src/lib/share/brainlife/api.ts) — `/api/auth/profile/list`,
  `/api/auth/refresh`, warehouse + amaretti endpoints from `config.js`
- [`bidsWalker.ts`](src/lib/share/brainlife/bidsWalker.ts) — ported from
  `bids-walker.js`
- [`upload.ts`](src/lib/share/brainlife/upload.ts) — ported from
  `bl-bids-upload.js`

No upstream code is copied verbatim — the TS implementation is a fresh
write that targets the same HTTP shape.

### OpenNeuro / openneuro (MIT)

Upstream: <https://github.com/OpenNeuroOrg/openneuro> (MIT-licensed)

The cloud-share pipeline at [src/lib/share/openneuro/](src/lib/share/openneuro/)
ports the **web-UI HTTPS path** — `createDataset` → `prepareUpload` →
per-file POST → `finishUpload` — that the OpenNeuro web app uses for
drag-and-drop uploads. Files most directly informed by the upstream:

- [`api.ts`](src/lib/share/openneuro/api.ts) — GraphQL mutations match
  `packages/openneuro-app/src/scripts/uploader/upload-mutation.js`; the
  per-file POST URL shape matches `file-upload.js#encodeFilePath`;
  parallelism heuristic from `file-upload-parallel.ts`
- [`hash.ts`](src/lib/share/openneuro/hash.ts) — Java-`hashCode`-based
  uploadId computation ports `uploader/hash-file-list.ts` byte-for-byte
  so resume sessions interoperate with the web UI
- [`walker.ts`](src/lib/share/openneuro/walker.ts) — dotfile filter
  matches the OpenNeuro CLI's `commands/upload.ts#addGitFiles`

The Rust-side `openneuro_upload_file` command at
[`src-tauri/src/share.rs`](src-tauri/src/share.rs) bypasses the
WebView's CORS rejection on `/uploads/...`; it has no upstream parallel
(the web UI runs in the openneuro.org origin so it's not affected by
the same-origin policy).

### bids2ebrains (MIT)

Upstream: <https://gitlab.ebrains.eu/cpernet/bids2ebrains> (MIT-licensed)
Copyright (c) 2025 EBRAINS / bids2ebrains contributors

The EBRAINS share backend at [src/lib/share/ebrains/](src/lib/share/ebrains/)
mirrors `bids2ebrains/uploader.py:upload_dir` end-to-end: walk the
BIDS tree, convert to openMINDS JSON-LD, apply user-supplied patches
(license / accessibility / version / hostedBy default), optionally
rewrite `File.iri` / `FileRepository.iri` to a user-supplied
`repositoryIri` (the upstream `--repo-iri` flag), mint KG instance
IRIs, and POST each node to
`https://core.kg.ebrains.eu/v3/instances?space=…` with PUT-on-409
fallback. File bytes are NOT uploaded — same as the upstream tool.

The mandatory-field schema in
[`bids2ebrains/scanner.py`](https://gitlab.ebrains.eu/cpernet/bids2ebrains/-/blob/main/bids2ebrains/scanner.py)
will inform a future BIDSvue-side "fill required openMINDS fields"
panel; nothing from it is ported yet.

### bids2openminds (Apache-2.0)

Upstream: <https://github.com/openMetadataInitiative/bids2openminds>
(Apache License 2.0)
Copyright (c) Open Metadata Initiative / bids2openminds contributors

The BIDS → openMINDS conversion at
[src/lib/share/ebrains/openminds/](src/lib/share/ebrains/openminds/)
is a TypeScript port (in shape — no source copied verbatim) of the
upstream Python package's `main.py:bids2openminds` flow. Covers
Dataset, DatasetVersion, Person, DOI, Subject, SubjectState, File,
FileBundle, FileRepository, Hash, plus the controlled-vocabulary
maps (license, accessibility, ageCategory, species, biologicalSex,
handedness, technique, semanticDataType, dataType, contentType).
The reference output fixture used to calibrate the port is the
upstream `test/bids_examples_ds005.jsonld`.

### dcm2niix (BSD-3-Clause)

Upstream: <https://github.com/rordenlab/dcm2niix> (BSD-3-Clause)

BIDSvue ships the `dcm2niix` binary as a Tauri sidecar, committed under
[`resources/<platform>/`](resources/) for macOS arm64, Linux x86_64, and
Windows x86_64. The binary is unmodified; no source is vendored.

### bids-validator (MIT)

Upstream: <https://github.com/bids-standard/bids-validator> (MIT)

BIDSvue ships both the JS validator (`@bids/validator` 2.4.1, JSR
`@jsr/bids__validator`) and a Rust parity sidecar (committed under
[`resources/<platform>/`](resources/) for macOS arm64, Linux x86_64, and
Windows x86_64). The JS bundle is pre-built offline by
[`scripts/bundle-validator.ts`](scripts/bundle-validator.ts) (esbuild)
from the unmodified upstream sources.

### niimath (BSD-2-Clause — the bundled deface binary)

Upstream: <https://github.com/rordenlab/niimath> (BSD-2-Clause)

BIDSvue ships the `niimath` binary as a Tauri sidecar, committed under
[`resources/<platform>/`](resources/) for macOS arm64, Linux x86_64, and
Windows x86_64. It backs the `allineate` CPU deface tool (the
`-robustfov -deface` 12-DOF affine path) and the mindgrab mask-dilation
pass (`niimath_dilate`).

The binary is niimath's **default BSD-2-Clause build** (compiled with
`OMP=0 ZSTD=0` to keep the notarized macOS bundle self-contained; recipe
in [src-tauri/AGENTS.md](src-tauri/AGENTS.md)). BIDSvue does **not** pass
`GPL=1` — the optional GPL `spm_coreg` module from the `src/GPL` submodule
is not compiled in, so the redistributed binary carries no GPL obligation.
It is built from unmodified upstream sources; no niimath source is vendored
into this repository.

### datalad-rs (MIT — first-party, vendored)

Repository: <https://github.com/rordenlab/datalad-rs> (MIT)

The native DataLad / git-annex engine is the `datalad-rs` crate,
vendored as a git submodule at `src-tauri/crates/datalad-rs` and
compiled into the BIDSvue binary (not a separate sidecar). It is a
BIDSvue-authored crate (`Copyright (c) 2026 Chris Rorden`); no upstream
DataLad source is vendored — see the crate's own `LICENSE`.

### NiiVue (BSD-2-Clause)

Upstream: <https://github.com/niivue/niivue> (BSD-2-Clause)

BIDSvue depends on `@niivue/niivue` (1.0.0-rc.8) for in-app NIfTI
visualisation. No source is vendored. During the M-PHY0 dev cycle the
dependency is a local `file:` spec against an in-tree rc.8 build; it is
re-pinned to the npm-published tag before any release DMG (the release
script blocks notarisation while any `file:` dep remains).

### mindgrab (BSD-2-Clause)

Upstream: bundled WebGPU mindgrab model. The model weights and
runtime code ship under BSD-2-Clause per their committed sidecar
manifest. See [resources/](resources/) for the staged binaries.

### Other dependencies

The remaining dependencies (Tauri 2 + plugins, Svelte 5, reqwest,
dcm2bids, etc.) carry their own permissive licenses (MIT
/ Apache-2.0 / BSD). The full set is enumerated by `bun install` /
`cargo tree`; the bundled installer redistributes only the binaries
we explicitly stage under [`resources/<platform>/`](resources/), all of
which are permissively licensed (BSD / MIT / Apache-2.0).
