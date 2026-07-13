# Signing the Windows release with SignPath (free OSS plan)

Plan to code-sign ("certify") BIDSvue's Windows NSIS installer via the **SignPath Foundation** free open-source program. Linux/Windows installers are built by CI (`.github/workflows/crossplatform-bundles.yml`); macOS is a locally notarized DMG. This adds Authenticode signing to the Windows `.exe`.

## Set expectations first

- **It's free for OSS, but gated by a one-time application + approval.** You apply to the SignPath Foundation; they review that BIDSvue is a genuine, notable open-source project (OSI license, public GitHub, real usage). Approval isn't instant — factor in a few days. This is the long pole, so start it now.
- **The signature's publisher will typically read "SignPath Foundation," not your institution.** The Foundation's certificate is **OV**, but it has years of accrued SmartScreen reputation across many OSS projects, so signed builds are usually *not* flagged. (If you ever need your *own* publisher identity or guaranteed instant-EV trust, that's the Azure Trusted Signing / EV route — but for BIDSvue the Foundation plan is exactly right.)
- Signing is a **post-build** step: CI uploads the unsigned `.exe`, SignPath signs it and hands it back, and the release attaches the signed one. No change to how you build.

## Onboarding checklist (only the maintainer can do these)

1. **Apply:** <https://signpath.org/apply> — register BIDSvue (repo URL `github.com/niivue/BIDSvue`, OSI license, describe the project). Wait for approval.
2. Once approved, in the SignPath web console:
   - Create a **Project** for BIDSvue → note its **project slug**.
   - Add an **Artifact Configuration** for the NSIS installer (Authenticode; you can make it *recursive* later to also sign the bundled `dcm2niix.exe` / `niimath.exe` / `bids-validator.exe`, but sign the installer first).
   - Create a **Signing Policy** (e.g. `release-signing`) bound to the Foundation certificate → note its **signing-policy-slug**.
   - Under **Trusted Build Systems**, enable the **GitHub Actions** connector.
   - Create a **CI User** and generate an **API token**.
   - Note your **Organization ID** (a GUID).

## Values needed to wire CI

| Value | Where it goes |
|---|---|
| API token | GitHub repo **secret** `SIGNPATH_API_TOKEN` (Settings → Secrets → Actions) |
| Organization ID | GitHub repo **variable** `SIGNPATH_ORGANIZATION_ID` |
| Project slug | GitHub repo **variable** `SIGNPATH_PROJECT_SLUG` |
| Signing-policy slug | GitHub repo **variable** `SIGNPATH_SIGNING_POLICY_SLUG` |

Only the token is secret; the rest are non-sensitive variables.

## The CI change (once approved)

A new **`sign-windows`** job between the existing `bundle` and `release` jobs in `.github/workflows/crossplatform-bundles.yml`:

- The Windows leg uploads its NSIS `.exe` as today and exposes the upload's `artifact-id`.
- `sign-windows` (needs `bundle`, tag builds only) runs the SignPath action **pinned to a reviewed commit SHA** (NOT the mutable `@v1` tag — a moved tag could run unreviewed code with our signing token; look up the SHA for the release tag of `SignPath/github-action-submit-signing-request` and pin `@<sha>`) with `api-token`, `organization-id`, `project-slug`, `signing-policy-slug`, `github-artifact-id: <the windows artifact id>`, `wait-for-completion: true`, `output-artifact-directory: signed/`, then re-uploads the **signed** `.exe` under the name the release job consumes.
- `release` then attaches the **signed** Windows installer alongside the (unsigned) Linux ones.
- **Fail-closed once signing is enabled.** The interim "if `SIGNPATH_*` isn't configured, still produce an unsigned release" gate is only acceptable BEFORE Foundation approval. Once the secret + variables exist (signing is live), a **version-tag** (`v*`) build MUST FAIL if signing fails or is skipped — never silently publish an unsigned installer to a release tag. Keep the unsigned-fallback path only for `workflow_dispatch`/main verify builds, gated on `github.ref` not being a `v*` tag.

### SignPath GitHub Action inputs (reference)

`SignPath/github-action-submit-signing-request` (inspect the reviewed release, then pin its full commit SHA in the workflow):

| Input | Required | Default | Notes |
|---|---|---|---|
| `connector-url` | yes | `https://githubactions.connectors.signpath.io` | SignPath cloud default; leave as-is |
| `api-token` | yes | — | from `secrets.SIGNPATH_API_TOKEN` |
| `organization-id` | yes | — | GUID |
| `project-slug` | yes | — | |
| `signing-policy-slug` | yes | — | e.g. `release-signing` |
| `artifact-configuration-slug` | no | — | which artifact config to apply |
| `github-artifact-id` | yes | — | id from the `upload-artifact` step output |
| `github-token` | no | `${{ github.token }}` | reads job details + downloads artifact |
| `wait-for-completion` | no | `true` | block until signed |
| `output-artifact-directory` | no | — | where the signed artifact is written |
| `skip-decompress` | no | `false` | keep archive as-is |

## Open questions before wiring

- Apply under the **niivue org** or the maintainer's institution? (Decides the application details; the published signer is still "SignPath Foundation".)
- Draft the workflow change now with `SIGNPATH_*` placeholders (ready to activate once the secret/variables are set), or wait until Foundation approval + real slugs are in hand?

## Alternatives (not chosen, for the record)

- **Azure Trusted Signing** (~$10/mo) — your own/institutional publisher identity, CI-friendly, needs an eligible org (≈3+ yr legal entity).
- **SSL.com eSigner / DigiCert KeyLocker** — cloud HSM, OV (~$200–400/yr) or EV (~$400–700/yr, instant SmartScreen).
- **EV cert on a USB token** — instant SmartScreen but local-signing only (like the macOS DMG), not cloud-CI automatable.

Note: Windows has **no notarization step** like macOS — Authenticode signing + a timestamp is the whole story; SmartScreen reputation is a separate axis (accrues over time for OV, instant for EV).
