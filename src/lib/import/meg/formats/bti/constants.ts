// BTi / 4D Neuroimaging on-disk constants. Mirrors the values our
// parser depends on from `mne/io/bti/constants.py` (BSD-3); not a
// full port (we ignore most user-block kinds and channel
// type-specific payload structures since v1 only needs metadata
// for BIDS sidecars). See decisions/M10-meg-importer.md for the
// minimum-scope rationale.

/** Mask used on the PDF trailer's int64 "header position" pointer to
 *  match MNE's value semantics. Real-world PDFs encode the absolute
 *  header offset in the lower 31 bits. */
export const BTI_FILE_MASK = 0x7fffffff

/** PDF trailer length: the last 8 bytes hold the i64 BE pointer to
 *  the start of the trailing header block. */
export const BTI_PDF_TRAILER_BYTES = 8

/** Offset within `hs_file` of the `n_dig_points` field. The first
 *  three int32s before it are version / timestamp / checksum. */
export const BTI_HS_N_DIG_POINTS_OFFSET = 12

/** Number of "named" cardinal/HPI points in `hs_file`. MNE labels
 *  these as [LPA, RPA, NAS, HPI1, HPI2]; for BIDS we use the first
 *  three only. */
export const BTI_HS_N_IDX_POINTS = 5

/** Channel-type tag values stored in the config file's per-channel
 *  record. We don't use these for type classification today (name
 *  prefix is more reliable -- MNE itself classifies by prefix), but
 *  keep them for documentation + future use when the variable-length
 *  per-channel payload parser arrives. */
export const BTI_CHTYPE = Object.freeze({
  MEG: 1,
  EEG: 2,
  REFERENCE: 3,
  EXTERNAL: 4,
  TRIGGER: 5,
  UTILITY: 6,
  DERIVED: 7,
  SHORTED: 8,
})
