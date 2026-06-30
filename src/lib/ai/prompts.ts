// M-AI6 default prompts library.
//
// Six starter prompts pre-fill the textarea in `AIWindow.svelte`.
// Picking a preset replaces the textarea body with the localized
// prompt; the user edits before clicking Send. The Send wiring
// (M-AI3) streams the CLI's response into the transcript pane.
// Write tools (rename / save / delete) land alongside M-AI5's
// approval-gate IPC bridge.
//
// Each entry has:
//   - `id` — stable slug used for the dropdown <option value="">
//     and any future "last-selected-prompt" persistence.
//   - `labelKey` — i18n key under `prompts.*` for the dropdown
//     display name.
//   - `bodyKey` — i18n key for the prompt body that lands in the
//     textarea on selection.
//
// Why a key-pair instead of inline strings: AI prompts are user-
// facing copy that translators need to localise (Locked decision 12
// — every English key MUST land with `pt` + `es` entries in the
// same change). Inline strings would split the source of truth.

export interface DefaultPromptEntry {
  id: string
  labelKey: string
  bodyKey: string
}

export const DEFAULT_PROMPTS: ReadonlyArray<DefaultPromptEntry> = [
  {
    id: 'summarize-dataset',
    labelKey: 'prompts.summarizeLabel',
    bodyKey: 'prompts.summarizeBody',
  },
  {
    id: 'run-validator',
    labelKey: 'prompts.runValidatorLabel',
    bodyKey: 'prompts.runValidatorBody',
  },
  {
    id: 'find-missing-task-names',
    labelKey: 'prompts.findMissingTaskNamesLabel',
    bodyKey: 'prompts.findMissingTaskNamesBody',
  },
  {
    id: 'cleanup-stub-sidecars',
    labelKey: 'prompts.cleanupStubSidecarsLabel',
    bodyKey: 'prompts.cleanupStubSidecarsBody',
  },
  {
    id: 'check-participants-tsv',
    labelKey: 'prompts.checkParticipantsLabel',
    bodyKey: 'prompts.checkParticipantsBody',
  },
  {
    id: 'rename-subject',
    labelKey: 'prompts.renameSubjectLabel',
    bodyKey: 'prompts.renameSubjectBody',
  },
  {
    id: 'minimize-dataset',
    labelKey: 'prompts.minimizeLabel',
    bodyKey: 'prompts.minimizeBody',
  },
  {
    id: 'find-dates',
    labelKey: 'prompts.findDatesLabel',
    bodyKey: 'prompts.findDatesBody',
  },
  {
    id: 'author-events',
    labelKey: 'prompts.authorEventsLabel',
    bodyKey: 'prompts.authorEventsBody',
  },
] as const
