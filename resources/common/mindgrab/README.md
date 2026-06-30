# mindgrab weights

The M11 deface family (`mindgrab` and `mindgrab (8 mm)`) uses
**[brain2print's](https://github.com/niivue/niivue/tree/main/packages/nv-ext-brain2print) `mindgrab` skull-strip
model** — a tinygrad-generated WGSL pipeline that runs in-process via
WebGPU. The model itself is vendored at
[`src/lib/deface/mindgrab/_vendor/mindgrab.ts`](../../../src/lib/deface/mindgrab/_vendor/mindgrab.ts);
its weight blob lives here.

## Files

- `net_mindgrab.safetensors` (~576 KB, committed to git) — model weights.

The file is referenced from
[`src-tauri/tauri.conf.json`](../../../src-tauri/tauri.conf.json)'s
`bundle.resources` glob. Committing to git keeps `git clone &&
bun install && bun tauri dev` working on every machine without manual
asset wrangling; BSD-2-Clause (matches BIDSvue's license — see
[NiiVue's LICENSE](https://github.com/niivue/niivue/blob/main/LICENSE)
for the canonical text).

## Updating the weights

If brain2print ships a refreshed model, copy the new file into place
and commit:

```sh
cp ~/dcm/mono/apps/demo-ext-brain2print/public/net_mindgrab.safetensors \
   resources/common/mindgrab/
git commit resources/common/mindgrab/net_mindgrab.safetensors \
  -m "chore(mindgrab): refresh weights from brain2print"
```

## Required for release builds

`scripts/macos-release.sh` (`bun run release:macos`) hard-fails if the
weights are absent — shipping a DMG without them would silently drop
the WebGPU deface capability from the user-visible feature set.
