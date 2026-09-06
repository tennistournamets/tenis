<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TennisRulesSettings from '../TennisRulesSettings.vue'
import { getSportConfig } from '../../lib/sportConfig'
import { scoringError } from '../../lib/tennisRules'
import { useFormDraft, cloneForm, matchVersions } from '../../lib/formDraft'
import { confirmDialog } from '../../lib/confirmDialog'
import { useUnsavedChanges, confirmDiscard } from '../../lib/unsavedChanges'
import { supabase } from '../../lib/supabase'

const props = defineProps({
  tournament: { type: Object, required: true },
  matches: { type: Array, default: () => [] },
  busy: Boolean,
  canManage: Boolean,
  refresh: { type: Function, required: true },
})
const emit = defineEmits(['update:saving', 'saved'])
const { t } = useI18n()
function settingsFields(data) {
  return { name: data.name, slug: data.slug || '', description: data.description || '', category: data.category,
    set_format: data.set_format, scoring_config: cloneForm(data.scoring_config || {}),
    doubles_pairing_mode: data.doubles_pairing_mode || 'pre_agreed', status: data.status, is_public: Boolean(data.is_public) }
}
const settingsDraft = useFormDraft(settingsFields(props.tournament))
const settingsForm = settingsDraft.form
const settingsSaving = settingsDraft.saving
const settingsConflict = settingsDraft.conflict
const hasTournamentSettingsChanges = settingsDraft.dirty
const settingsError = ref('')
const statusValue = computed({ get: () => settingsForm.status, set: value => { settingsForm.status = value } })
const isTournamentActive = computed(() => props.tournament.status === 'in_progress')
const isTournamentFinished = computed(() => props.tournament.status === 'completed')
const fieldsDisabled = computed(() => isTournamentActive.value || isTournamentFinished.value || settingsSaving.value || props.busy || !props.canManage)
const sportCfg = computed(() => getSportConfig(props.tournament.sport || 'tennis'))
// Server snapshots cannot overwrite local edits or silently rebase revisions.
watch(() => props.tournament, data => settingsDraft.receive(settingsFields(data), data.settings_revision), { immediate: true })
watch(settingsSaving, value => emit('update:saving', value), { flush: 'sync' })
useUnsavedChanges(() => hasTournamentSettingsChanges.value, () => settingsSaving.value)

async function reloadSettings() {
  if (settingsSaving.value || props.busy || !(await confirmDiscard(t, hasTournamentSettingsChanges.value))) return
  settingsSaving.value = true
  try {
    await props.refresh()
    await nextTick()
    settingsDraft.discard()
    settingsError.value = ''
  } catch (error) { settingsError.value = error.message || t('drafts.unavailable') }
  finally { settingsSaving.value = false }
}

async function saveTournamentSettings() {
  if (settingsSaving.value || props.busy || !props.canManage || !hasTournamentSettingsChanges.value) return
  if (settingsConflict.value) { settingsError.value = t('drafts.conflict'); return }
  const submitted = cloneForm(settingsForm)
  const revision = settingsDraft.revision.value
  const categoryChanged = submitted.category !== settingsDraft.baseline.value.category
  const expectedMatches = matchVersions(props.matches)
  if (categoryChanged && props.matches.length && !(await confirmDialog(t('drafts.categoryReset'), { danger: true }))) return
  settingsSaving.value = true
  settingsError.value = ''
  try {
    const { slug, ...patch } = submitted
    patch.description = patch.description || null
    patch.doubles_pairing_mode = patch.category === 'doubles' ? patch.doubles_pairing_mode : null
    const { data, error } = await supabase.rpc('update_tournament_settings', {
      p_tournament_id: props.tournament.id, p_patch: patch, p_expected_revision: revision,
      p_expected_matches: categoryChanged ? expectedMatches : null,
    })
    if (error) throw error
    settingsDraft.accepted(settingsFields(data), data.settings_revision, submitted)
    emit('saved', data)
    if (categoryChanged) await props.refresh()
  } catch (error) {
    settingsError.value = scoringError(error.message, t)
    try { await props.refresh() } catch { /* Keep the draft and original error. */ }
  } finally { settingsSaving.value = false }
}
</script>

<template>
  <section class="card admin-settings-card stack stack--sm" aria-labelledby="adm-settings-heading">
    <div>
      <h2 id="adm-settings-heading" class="section-title" style="margin-bottom: var(--space-2)">
        {{ t('admin.tournamentSettings') }}
      </h2>
    </div>

    <div v-if="settingsConflict" class="alert alert--info" role="status">
      {{ t('drafts.conflict') }}
      <button class="btn btn--ghost btn--sm" type="button" @click="reloadSettings">{{ t('drafts.reload') }}</button>
    </div>
    <p v-else-if="hasTournamentSettingsChanges" class="muted" role="status">{{ t('drafts.unsaved') }}</p>
    <p v-if="settingsError && (!settingsConflict || settingsError !== t('drafts.conflict'))" class="error-text" role="alert">{{ settingsError }}</p>
    <div class="form-field">
      <label for="adm-name">{{ t('admin.name') }}</label>
      <input
        id="adm-name"
        v-model="settingsForm.name"
        class="input"
        type="text"
        required
        :disabled="fieldsDisabled"
      />
    </div>

    <div class="form-field">
      <label for="adm-desc">{{ t('admin.description') }}</label>
      <textarea
        id="adm-desc"
        v-model="settingsForm.description"
        class="input"
        rows="3"
        :disabled="fieldsDisabled"
      />
    </div>

    <p class="muted" style="font-size: var(--font-sm)">
      {{ t('sport.' + (tournament.sport || 'tennis')) }} · {{ t('tournamentFormat.' + (tournament.format || 'single_elimination')) }}
    </p>

    <div v-if="sportCfg.supportsCategory || sportCfg.supportsSetFormat" class="grid-2">
      <div v-if="sportCfg.supportsCategory" class="form-field">
        <label for="adm-cat">{{ t('admin.category') }}</label>
        <select id="adm-cat" v-model="settingsForm.category" class="input" :disabled="fieldsDisabled">
          <option value="singles">{{ t('tournament.singles') }}</option>
          <option value="doubles">{{ t('tournament.doubles') }}</option>
        </select>
      </div>

      <div v-if="sportCfg.supportsSetFormat" class="form-field">
        <label for="adm-format">{{ t('admin.setFormat') }}</label>
        <select id="adm-format" v-model="settingsForm.set_format" class="input" :disabled="fieldsDisabled">
          <option value="best_of_3">{{ t('format.best_of_3') }}</option>
          <option value="best_of_5">{{ t('format.best_of_5') }}</option>
        </select>
      </div>
    </div>

    <TennisRulesSettings v-if="tournament.sport === 'tennis'" v-model="settingsForm.scoring_config" id-prefix="settings-tennis" :disabled="fieldsDisabled" />

    <label v-if="sportCfg.supportsDoublesPairing && settingsForm.category === 'doubles'" class="checkbox-row">
      <input
        v-model="settingsForm.doubles_pairing_mode"
        type="checkbox"
        true-value="pick_random"
        false-value="pre_agreed"
        :disabled="fieldsDisabled"
      />
      {{ t('admin.pickRandomPairs') }}
    </label>

    <div class="admin-settings-fields">
      <div class="form-field admin-settings-fields__status">
        <label for="adm-status">{{ t('admin.status') }}</label>
        <select id="adm-status" v-model="statusValue" class="input" :disabled="fieldsDisabled">
          <option value="draft" :disabled="fieldsDisabled">{{ t('tournament.draft') }}</option>
          <option value="registration_open" :disabled="fieldsDisabled">{{ t('tournament.registration_open') }}</option>
          <option value="registration_closed" :disabled="fieldsDisabled">{{ t('tournament.registration_closed') }}</option>
          <option v-if="isTournamentActive" value="in_progress" disabled>{{ t('tournament.in_progress') }}</option>
          <option v-if="isTournamentFinished" value="completed" disabled>{{ t('tournament.completed') }}</option>
        </select>
      </div>

      <label class="checkbox-row admin-settings-fields__public" for="adm-public">
        <input id="adm-public" v-model="settingsForm.is_public" type="checkbox" :disabled="fieldsDisabled" />
        {{ t('admin.isPublic') }}
      </label>
    </div>

    <footer class="admin-settings-card__footer">
      <button
        class="btn btn--primary"
        type="button"
        :disabled="busy || settingsSaving || !canManage || settingsConflict || !hasTournamentSettingsChanges"
        @click="saveTournamentSettings"
      >
        {{ t('admin.saveStatus') }}
      </button>
      <button v-if="hasTournamentSettingsChanges && !settingsConflict" class="btn btn--ghost" type="button" :disabled="settingsSaving || busy" @click="reloadSettings">{{ t('drafts.reload') }}</button>
    </footer>
  </section>
</template>
