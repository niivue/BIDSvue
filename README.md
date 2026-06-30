## Introduction

BIDSvue is a desktop application for browsing, curating, de-identifying, and importing BIDS neuroimaging datasets — entirely on your local machine. It combines best-in-class tools (dcm2niix, bids-validator, niimath, NiiVue, mindgrab) into a single workflow for creating reproducible, shareable datasets.

BIDSvue addresses a common problem in neuroimaging workflows: automated analysis tools depend on carefully curated data, but preparing datasets for sharing often requires stitching together CLIs, manual metadata edits, ad hoc defacing scripts, and separate validation steps. At the same time, de-identification must happen locally before data can be safely aggregated or shared.

BIDSvue brings dataset management, sidecar editing, validation, NIfTI visualization, importing, defacing, and DataLad fetch/save operations into one interface. All processing happens locally: data only leaves the machine when you explicitly initiate a fetch, or share through the cloud-share modal.

Cloud-share is an alpha track, not a near-term focus. The `Share…` modal has paste-token flows for OpenNeuro, EBRAINS, and brainlife.io: OpenNeuro supports incremental push, EBRAINS publishes Knowledge Graph metadata only and requires an out-of-band Repository IRI for file bytes, and brainlife uploads a tar.gz archive. All backends use local `share.json` / `share.pending.json` state for linked-state and crash recovery. See [ROADMAP.md](ROADMAP.md) and [NOTICE.md](NOTICE.md).

## Quick Start

```bash
bun install
bun tauri dev
```

Prereqs: [Bun](https://bun.sh), the [Rust toolchain](https://www.rust-lang.org/tools/install), and Tauri 2's platform tools — Xcode CLT on macOS, MSVC + WebView2 on Windows, `webkit2gtk-4.1` on Linux ([Tauri prereqs](https://v2.tauri.app/start/prerequisites/)). The first `tauri dev` builds the Rust shell (~few minutes); subsequent runs are fast.

## More

- [AGENTS.md](AGENTS.md) — working guide for AI coding (stack, build, domain rules)
- [ARCHITECTURE.md](ARCHITECTURE.md) — current architecture and design rationale
- [DEVELOP.md](DEVELOP.md) — developer and release notes
- [LIMITATIONS.md](LIMITATIONS.md) — what the shipped code can't do (inherent vs fixable)
- [ROADMAP.md](ROADMAP.md) — v0.2 priorities, backlog, wishlist
- [PRIVACY.md](PRIVACY.md) — what does and doesn't leave your machine
- [LICENSE](LICENSE) — BSD 2-Clause. Bundled tools keep their own permissive licenses (see [NOTICE.md](NOTICE.md)).

## Core Tools

BIDSvue is a wrapper for several popular tools and technologies.

- AI wrappers for Claude, Codex, and Gemini
- [niimath](https://github.com/rordenlab/niimath) backs CPU defacing via `allineate` (12-DOF affine `-deface`) on macOS/Linux/Windows, and the mindgrab mask-dilation pass. BSD-2 build on every platform.
- [bids-validator-rs](https://github.com/rordenlab/bids-validator-rs) — a Rust implementation of the [bids-validator](https://github.com/bids-standard/bids-validator)
- DataLad / git-annex distributed datasets — fetched and saved via the native in-binary [datalad-rs](https://github.com/rordenlab/datalad-rs) engine (`gix`-based, vendored as a submodule and compiled in), so no external [datalad](https://github.com/datalad/datalad) / git-annex install is required
- [Dcm2Bids](https://github.com/UNFmontreal/Dcm2Bids) from the Python environment for DICOM to BIDS
- [dcm2niix](https://github.com/rordenlab/dcm2niix/tree/master) for DICOM → BIDS conversion ([reproin](https://github.com/ReproNim/reproin/) and non-reproin DICOMs, including JPEG2000-encoded series via OpenJPEG and JPEG-LS-encoded PET frames via CharLS — v1.0.20260627 dev build)
- [ezbids](https://github.com/brainlife/ezbids) for MEG to BIDS conversion
- [heudiconv](https://github.com/nipy/heudiconv) from the Python environment for DICOM to BIDS
- [mindgrab brainchop model](https://github.com/neuroneural/brainchop)
- [mne-bids](https://github.com/mne-tools/mne-bids) from the Python environment for MEG/EEG/fNIRS to BIDS (`.fif` / `.edf` / `.bdf` / `.snirf`)
- [NiiVue](https://niivue.com/) visualization
- [pet2bids](https://github.com/openneuropet/PET2BIDS) to import PET data
