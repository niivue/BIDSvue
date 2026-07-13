# Deface resource provenance

`avg152T1.nii.gz` and `avg152T1mask.nii.gz` are a matched template/mask pair copied byte-for-byte from [`niivue/deface` commit `a27d54264256531db1cb17019a01319e78506e76`](https://github.com/niivue/deface/commit/a27d54264256531db1cb17019a01319e78506e76). That revision migrated the reference application to the BSD niimath modern-allineate `-deface` engine: FAST by default and AFNI-style Hellinger with `-cost hel`.

| Asset | Git blob | SHA-256 |
| --- | --- | --- |
| `avg152T1.nii.gz` | `4c3c34608791bc697c5c7b3b21d0294c83529738` | `e8f5440f0dcec1a4d44384acbdf19c8e6cf94c032c3356ef91c4441fee3aaea8` |
| `avg152T1mask.nii.gz` | `87fc7c75ea95e453b7f3829ae8b83747b13b056f` | `adc275e26e5217189d70acfd43311bc3f66f316321ac61defc88505d2f91a0aa` |

Treat the pair as one semantic asset. A replacement must record its upstream revision and checksums here, retain identical geometry between template and mask, and pass the upstream niimath deface regression suite before release.
