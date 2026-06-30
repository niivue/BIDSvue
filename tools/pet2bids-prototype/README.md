# pet2bids-prototype

Reference oracle for the BIDSvue M12 PET importer. This is a Python wrapper
around the upstream [pypet2bids](https://github.com/openneuropet/PET2BIDS)
1.4.6 package that converts a single PET DICOM directory into a valid
BIDS-PET dataset and confirms `bids-validator` passes.

The purpose is not to be production code in BIDSvue — it is the correctness
oracle the TypeScript port (Phase B and beyond) is validated against. If the
TS port's output diverges from this prototype's output on the golden
fixture, one of them is wrong.

## Prerequisites

- `uv` >= 0.9 (for the venv)
- The dev-build `dcm2niix` on `PATH` (v1.0.20260416 or newer, which has
  much broader PET-tag coverage than older releases). The prototype
  detects which `dcm2niix` is in use and points pypet2bids at it.
- `bids-validator` on `PATH` (e.g. `brew install bids-validator`).
- The PET2BIDS example dataset outside this repo.

## One-time setup

```sh
cd tools/pet2bids-prototype
uv venv
uv sync
```

## Usage

```sh
uv run pet2bids_prototype.py \
    --input  <pet2bids-images>/In/GeneralElectricAdvanceNIMH \
    --subject GEAdvanceNIMH \
    --metadata metadata/GeneralElectricAdvanceNIMH.json \
    --output  out/GeneralElectricAdvanceNIMH \
    --validate
```

The script will:

1. Run `dcm2niix` (via `pypet2bids.Dcm2niix4PET`) against the input
   directory, applying PET-specific JSON-sidecar enrichment.
2. Lay the output into a minimal BIDS project:
   `<out>/sub-<label>/pet/sub-<label>_pet.{nii.gz,json}` plus
   `dataset_description.json` and `README` at the root.
3. With `--validate`, run `bids-validator` against the result and exit
   non-zero on any error.

## Per-field provenance

The output JSON sidecar's fields come from one of four sources, in
priority order (later wins on conflict):

1. **DICOM tags** — dcm2niix derives ~70% of fields directly from DICOM.
2. **DICOM tags + dcm2niix4pet enrichment** — pypet2bids' `update_json_pet_file`
   pulls additional PET-specific tags (e.g. `RadionuclideCodeSequence`).
3. **Metadata file** — operator-supplied overrides via `--metadata`.
4. **`--kwargs key=value`** — single-field overrides on the CLI.

Fields that aren't in DICOM at all (e.g. `InjectedRadioactivity`,
`ModeOfAdministration`, `TimeZero`) MUST come from the metadata file
or kwargs.

## What is NOT ported in M12

- ECAT (.v) input — covered separately in M13.
- Blood metadata (PMOD spreadsheets → `_blood.tsv`).
- Multi-subject spreadsheet batch import.
- pypet2bids telemetry (BIDSvue doesn't phone home).
