#!/bin/bash
# Smoke test the M12 PET importer prototype against every example case
# under $PET2BIDS_IMAGES_DIR (default: ../../pet2bids-images/In). For each case:
#
#   1. Run pet2bids_prototype.py with NO metadata file (the "what does
#      a user with no operator metadata see?" path).
#   2. Run bids-validator against the output.
#   3. Record: did conversion succeed? did validator pass (errors == 0)?
#      how many warnings? which BIDS-PET fields were missing?
#
# Output: smoke-results.md
set -uo pipefail
cd "$(dirname "$0")"

IN_DIR="${PET2BIDS_IMAGES_DIR:-../../pet2bids-images/In}"
OUT_DIR="out/smoke"
REPORT="smoke-results.md"

mkdir -p "$OUT_DIR"
: > "$REPORT"

{
  echo "# M12 PET importer — smoke test results"
  echo
  echo "Run: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "Each case is run through the BIDSvue M12 prototype with NO operator-supplied metadata file — the 'baseline experience' for a user importing PET DICOMs without any operator JSON. The dcm2niix sidecar is resolved from PATH."
  echo
  echo "| Case | Convert | Validate | Errors | Warnings |"
  echo "| --- | --- | --- | --- | --- |"
} >> "$REPORT"

PASS_CONVERT=0
PASS_VALIDATE=0
TOTAL=0

for in_subdir in "$IN_DIR"/*/; do
  case_name="$(basename "$in_subdir")"
  out_case="$OUT_DIR/$case_name"
  rm -rf "$out_case"

  TOTAL=$((TOTAL + 1))

  # Step 1: convert
  convert_log="$OUT_DIR/$case_name.convert.log"
  if uv run --active pet2bids_prototype.py \
       --input "$in_subdir" \
       --subject "$case_name" \
       --output "$out_case" \
       >"$convert_log" 2>&1; then
    convert_status="pass"
    PASS_CONVERT=$((PASS_CONVERT + 1))
  else
    convert_status="FAIL"
    echo "| $case_name | $convert_status | -- | -- | -- |" >> "$REPORT"
    continue
  fi

  # Step 2: validate
  validate_log="$OUT_DIR/$case_name.validate.log"
  if bids-validator "$out_case" >"$validate_log" 2>&1; then
    validate_status="pass"
    PASS_VALIDATE=$((PASS_VALIDATE + 1))
  else
    validate_status="FAIL"
  fi

  # Step 3: count errors + warnings from the validator output
  errors=$(grep -c "\[ERR\]" "$validate_log" 2>/dev/null || true)
  warnings=$(grep -c "\[WARN\]" "$validate_log" 2>/dev/null || true)

  echo "| $case_name | $convert_status | $validate_status | $errors | $warnings |" >> "$REPORT"
done

{
  echo
  echo "## Summary"
  echo
  echo "- Convert: $PASS_CONVERT / $TOTAL"
  echo "- Validate (errors == 0): $PASS_VALIDATE / $TOTAL"
} >> "$REPORT"

echo "Wrote $REPORT"
cat "$REPORT"
