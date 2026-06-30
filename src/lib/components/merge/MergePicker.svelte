<script lang="ts">
  /**
   * Merge step 1: pick the recipient + donor datasets and set the batch
   * policies, then trigger plan computation. Presentational — the parent
   * MergeWindow owns the merge state and the prepare/compute calls.
   */
  import { _ } from 'svelte-i18n'
  import { pickMergeDonor, pickMergeRecipient } from '$lib/state/actions'
  import type { MergePolicy } from '$lib/merge/types'

  interface Props {
    recipient: string | null
    donors: string[]
    policy: MergePolicy
    busy: boolean
    onComputePlan: () => void
  }
  let {
    recipient = $bindable(),
    donors = $bindable(),
    policy = $bindable(),
    busy,
    onComputePlan,
  }: Props = $props()

  let pickError = $state<string | null>(null)

  async function pickRecipient(): Promise<void> {
    pickError = null
    try {
      const path = await pickMergeRecipient()
      if (path !== null) recipient = path
    } catch (err) {
      pickError = err instanceof Error ? err.message : String(err)
    }
  }

  async function addDonor(): Promise<void> {
    pickError = null
    try {
      const path = await pickMergeDonor()
      if (path !== null && !donors.includes(path)) donors = [...donors, path]
    } catch (err) {
      pickError = err instanceof Error ? err.message : String(err)
    }
  }

  function removeDonor(path: string): void {
    donors = donors.filter((d) => d !== path)
  }

  const canCompute = $derived(recipient !== null && donors.length > 0 && !busy)
</script>

<div class="picker">
  <section>
    <h2>{$_('merge.recipientHeading')}</h2>
    <p class="hint">{$_('merge.recipientHint')}</p>
    {#if recipient !== null}
      <p class="path">{recipient}</p>
    {/if}
    <button type="button" onclick={pickRecipient} disabled={busy}>
      {recipient === null ? $_('merge.pickRecipient') : $_('merge.changeRecipient')}
    </button>
  </section>

  <section>
    <h2>{$_('merge.donorsHeading')}</h2>
    <p class="hint">{$_('merge.donorsHint')}</p>
    {#if donors.length === 0}
      <p class="empty">{$_('merge.noDonors')}</p>
    {:else}
      <ul class="donor-list">
        {#each donors as donor (donor)}
          <li>
            <span class="path">{donor}</span>
            <button
              type="button"
              class="remove"
              onclick={() => removeDonor(donor)}
              disabled={busy}
              aria-label={$_('merge.removeDonor')}>✕</button
            >
          </li>
        {/each}
      </ul>
    {/if}
    <button type="button" onclick={addDonor} disabled={busy}>
      {$_('merge.addDonor')}
    </button>
  </section>

  <section>
    <h2>{$_('merge.policyHeading')}</h2>
    <div class="policy-grid">
      <label>
        {$_('merge.policy.subjectCollision')}
        <select bind:value={policy.subjectCollision} disabled={busy}>
          <option value="ask">{$_('merge.opt.ask')}</option>
          <option value="distinct">{$_('merge.opt.distinct')}</option>
          <option value="same">{$_('merge.opt.same')}</option>
        </select>
      </label>
      <label>
        {$_('merge.policy.sessionCollision')}
        <select bind:value={policy.sessionCollision} disabled={busy}>
          <option value="renumber">{$_('merge.opt.renumber')}</option>
          <option value="ask">{$_('merge.opt.ask')}</option>
        </select>
      </label>
      <label>
        {$_('merge.policy.metadataConflict')}
        <select bind:value={policy.metadataConflict} disabled={busy}>
          <option value="ask">{$_('merge.opt.ask')}</option>
          <option value="keep-recipient">{$_('merge.opt.keepRecipient')}</option>
          <option value="keep-donor">{$_('merge.opt.keepDonor')}</option>
        </select>
      </label>
      <label>
        {$_('merge.policy.defaceOriginals')}
        <select bind:value={policy.defaceOriginals} disabled={busy}>
          <option value="carry">{$_('merge.opt.carry')}</option>
          <option value="defaced-only">{$_('merge.opt.defacedOnly')}</option>
        </select>
      </label>
      <label>
        {$_('merge.policy.derivativesScope')}
        <select bind:value={policy.derivativesScope} disabled={busy}>
          <option value="with-subject">{$_('merge.opt.withSubject')}</option>
          <option value="skip-derivatives">{$_('merge.opt.skipDerivatives')}</option>
          <option value="bids-only">{$_('merge.opt.bidsOnly')}</option>
        </select>
      </label>
      <label>
        {$_('merge.policy.validation')}
        <select bind:value={policy.validation} disabled={busy}>
          <option value="changed-subjects">{$_('merge.opt.changedSubjects')}</option>
          <option value="dataset">{$_('merge.opt.dataset')}</option>
          <option value="skip">{$_('merge.opt.skipValidation')}</option>
        </select>
      </label>
    </div>
    {#if policy.defaceOriginals === 'carry'}
      <p class="privacy">{$_('merge.privacyNotice')}</p>
    {/if}
  </section>

  {#if pickError !== null}
    <p class="error">{pickError}</p>
  {/if}

  <div class="actions">
    <button type="button" class="primary" onclick={onComputePlan} disabled={!canCompute}>
      {busy ? $_('merge.computing') : $_('merge.computePlan')}
    </button>
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 720px;
  }
  section h2 {
    font-size: 0.95rem;
    margin: 0 0 0.25rem 0;
  }
  .hint {
    margin: 0 0 0.5rem 0;
    color: var(--fg-muted);
    font-size: 0.85rem;
  }
  .path {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.8rem;
    word-break: break-all;
    margin: 0.25rem 0;
  }
  .empty {
    color: var(--fg-muted);
    font-style: italic;
    margin: 0.25rem 0;
  }
  .donor-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.5rem 0;
  }
  .donor-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: space-between;
  }
  .remove {
    flex: 0 0 auto;
    padding: 0.1rem 0.4rem;
  }
  .policy-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
  }
  select,
  button {
    font-family: inherit;
    font-size: 0.9rem;
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--border-strong);
    background: var(--bg-elevated);
    color: inherit;
    cursor: pointer;
  }
  button[disabled] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  button.primary {
    background: var(--selection-bg);
    color: var(--selection-text);
    border-color: transparent;
  }
  .privacy {
    margin: 0.5rem 0 0 0;
    font-size: 0.8rem;
    color: #b8860b;
  }
  .error {
    color: #c43838;
    font-size: 0.85rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
