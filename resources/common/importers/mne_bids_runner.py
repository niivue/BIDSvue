"""BIDSvue-owned runner: convert one raw recording to a STAGING BIDS root.

Runs on the detected interpreter. Owns the event_id mapping the broken
`mne_bids raw_to_bids --event_id` CLI cannot. Reads a single JSON FILE
(path in argv[1]) to avoid argv-size/quoting pitfalls.

stdout is exactly ONE machine-readable JSON object. MNE / mne-bids log
chatter goes to stdout by default, so we point sys.stdout at sys.stderr
for the whole conversion and write the result JSON only to the REAL
stdout fd captured up front (decision 6 output budget). The spawner
parses stdout.trim() as a single JSON object; any leak would break it.

See docs/mne_bids_plan.md (decisions 6 + 9 + 10).
"""
import json
import sys
import traceback


def main() -> int:
    real_stdout = sys.stdout
    # Everything the conversion prints/logs goes to stderr from here on.
    sys.stdout = sys.stderr
    result = {"ok": False, "error": "runner did not complete"}
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            opts = json.load(fh)

        import mne
        mne.set_log_level("ERROR")  # belt: silence MNE chatter too
        from mne_bids import BIDSPath, write_raw_bids

        # Optional extras (convert_mne_sample.py parity). Imported lazily so
        # a missing symbol on an older mne-bids only fails if that feature
        # was requested.
        from mne_bids.read import _read_raw  # private; version-gated (decision 10)

        line_freq = opts.get("line_freq")

        def read_one(path):
            # `_read_raw` + line_freq, shared by the raw + empty-room reads.
            allow_maxshield = "yes" if str(path).lower().endswith(".fif") else False
            r = _read_raw(path, allow_maxshield=allow_maxshield)
            if line_freq:  # 0 / None / "" => leave as n/a
                r.info["line_freq"] = float(line_freq)
            return r

        raw = read_one(opts["raw"])
        empty_room = read_one(opts["empty_room"]) if opts.get("empty_room") else None

        bids_path = BIDSPath(
            subject=opts["subject"],
            session=opts.get("session") or None,
            task=opts["task"],
            run=opts.get("run") or None,
            acquisition=opts.get("acq") or None,
            datatype="meg" if opts.get("calibration") or opts.get("crosstalk") else None,
            root=opts["staging_root"],  # an EMPTY dir BIDSvue created
        )
        write_raw_bids(
            raw,
            bids_path,
            events=opts.get("events") or None,
            event_id=opts.get("event_id") or None,
            empty_room=empty_room,
            overwrite=True,  # safe: staging_root is empty (decision 9)
            verbose=False,
        )

        # MEGIN fine-calibration + crosstalk (Elekta/MEGIN only).
        if opts.get("calibration"):
            from mne_bids import write_meg_calibration

            write_meg_calibration(opts["calibration"], bids_path, verbose=False)
        if opts.get("crosstalk"):
            from mne_bids import write_meg_crosstalk

            write_meg_crosstalk(opts["crosstalk"], bids_path, verbose=False)

        # dataset_description authoring (name + license + authors). Run
        # when the user supplied ANY authoring field — including a dataset
        # name on its own; otherwise write_raw_bids' default
        # dataset_description.json stands (unchanged v1 behaviour).
        authors = opts.get("authors") or None
        data_license = opts.get("data_license") or None
        dataset_name = opts.get("dataset_name") or None
        if authors or data_license or dataset_name:
            from mne_bids import make_dataset_description

            make_dataset_description(
                path=opts["staging_root"],
                name=dataset_name or opts["task"],
                data_license=data_license,
                authors=authors,
                overwrite=True,
                verbose=False,
            )

        result = {"ok": True, "staging_root": opts["staging_root"]}
        rc = 0
    except Exception as exc:  # noqa: BLE001 -- report ANY failure as structured JSON
        traceback.print_exc()  # full traceback -> stderr (capped by the spawner)
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        rc = 1
    json.dump(result, real_stdout)
    return rc


if __name__ == "__main__":
    sys.exit(main())
