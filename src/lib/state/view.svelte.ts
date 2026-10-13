// Session-scoped UI view state. Today this just tracks whether the
// M8-B import wizard is open; the Launch / Explorer split is still
// derived from `datasetStore.dataset === null`. Kept in its own
// module so the wizard's lifecycle isn't tangled with dataset
// lifecycle (the wizard can be opened from Launch when no dataset
// is open, and a successful import transitions through `open`
// dataset → Explorer naturally without the wizard needing to push
// state into datasetStore).
//
// No persistence: closing/reopening the app drops the user back at
// Launch or Explorer (per datasetStore), never the wizard.

/**
 * Prefill payload handed to the import wizard when BIDSvue is launched
 * as a NeuroFlow "ingest stage" tool. Set by the boot path
 * (`+layout.svelte`) from the session `context.json`; consumed by
 * `Import.svelte` on mount to pre-populate the source + destination and
 * (when `autoRun`) kick the import without a manual Run click.
 */
export interface NeuroflowImportPrefill {
  /** Source DICOM directory (`context.inputs.dicom_dir`). */
  srcDir: string
  /** Import destination (`context.outputDir` == `$NEUROFLOW_OUTPUT_DIR`). */
  outputDir: string
  /** Absolute `NEUROFLOW_SESSION` directory (for the provenance append). */
  sessionDir: string
  /** Workflow step id, threaded into the handoff + provenance records. */
  step?: string
  /** Drive the import automatically once the wizard mounts + prefills. */
  autoRun: boolean
}

class AppView {
  importWizardOpen = $state(false)
  /**
   * When set, the import wizard prefills its source/destination from a
   * NeuroFlow launch context and (if `autoRun`) runs the import, then
   * writes the NeuroFlow handoff + provenance on success. `null` in
   * every non-NeuroFlow launch, so the wizard behaves exactly as before.
   * Cleared by the wizard once it has consumed the prefill so re-opening
   * the wizard manually doesn't re-trigger the NeuroFlow flow.
   */
  neuroflowPrefill = $state<NeuroflowImportPrefill | null>(null)
  /**
   * True while the cohort Dashboard window is shown over Explorer.
   * No persistence — closing the app drops back to Explorer next
   * launch. Kept here (rather than in datasetStore) because it's a
   * pure UI/view flag with no dataset-lifecycle coupling: opening
   * the dashboard doesn't change the open dataset, and closing it
   * doesn't reset selection.
   */
  dashboardOpen = $state(false)
  /**
   * True while the cloud-share modal (`Share…`) is shown over Explorer.
   * Same lifecycle posture as `dashboardOpen` — pure UI flag, no
   * dataset-lifecycle coupling, no persistence.
   */
  shareOpen = $state(false)
  /**
   * True while the AI panel (M-AI1+ alpha track) is shown over
   * Explorer. Same lifecycle posture as `dashboardOpen` / `shareOpen`
   * — pure UI flag, no dataset-lifecycle coupling, no persistence.
   * Only flips to `true` from the toolbar tile, which itself only
   * renders when `aiFeatureEnabled` is true (M-AI1 compile-time
   * gate), so the field is structurally unreachable in stock builds.
   */
  aiOpen = $state(false)
  /**
   * True while the "Minimize dataset" dialog is shown — BIDS-minimize
   * entity removal (collapse single session, drop redundant run/acq).
   * Pure UI flag, no persistence.
   */
  minimizeOpen = $state(false)
  /**
   * True while the "Merge datasets" window is shown. Opened from the
   * Launch screen (no dataset open) — combines donor datasets into a
   * recipient. Same lifecycle posture as the other workspace flags:
   * pure UI, no persistence. See Merge design history in git log.
   */
  mergeOpen = $state(false)

  openImportWizard(): void {
    this.importWizardOpen = true
  }

  /**
   * Open the import wizard prefilled (and optionally auto-run) from a
   * NeuroFlow launch context. Used only by the boot path when
   * `NEUROFLOW_SESSION` is set.
   */
  openImportWizardForNeuroflow(prefill: NeuroflowImportPrefill): void {
    this.neuroflowPrefill = prefill
    this.importWizardOpen = true
  }

  closeImportWizard(): void {
    this.importWizardOpen = false
  }

  openDashboard(): void {
    this.dashboardOpen = true
  }

  closeDashboard(): void {
    this.dashboardOpen = false
  }

  openShare(): void {
    this.shareOpen = true
  }

  closeShare(): void {
    this.shareOpen = false
  }

  openAi(): void {
    this.aiOpen = true
  }

  closeAi(): void {
    this.aiOpen = false
  }

  openMinimize(): void {
    this.minimizeOpen = true
  }

  closeMinimize(): void {
    this.minimizeOpen = false
  }

  openMerge(): void {
    this.mergeOpen = true
  }

  closeMerge(): void {
    this.mergeOpen = false
  }
}

export const appView = new AppView()
