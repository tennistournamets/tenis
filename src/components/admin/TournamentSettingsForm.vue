<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { tennisRulesSummary } from '../../lib/tennisRules'
import TennisRulesSettings from '../TennisRulesSettings.vue'
import InfoTip from '../InfoTip.vue'
import RegistrationRulesFields from './RegistrationRulesFields.vue'
import VenueFields from './VenueFields.vue'
import { getSportConfig } from '../../lib/sportConfig'
import { REGISTRATION_DRAFT_KEYS, formatDeadline, pickRegistrationDraft, registrationDraftFields, registrationPatch, validateRegistrationForm } from '../../lib/registrationRules'
import { COMMON_TIMEZONES, browserTimezone } from '../../lib/schedule'
import { VISIBILITY_MODES, accessError, visibilityOf } from '../../lib/access'
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
const { t, locale } = useI18n()
function settingsFields(data) {
  return { name: data.name, slug: data.slug || '', description: data.description || '', category: data.category,
    set_format: data.set_format, scoring_config: cloneForm(data.scoring_config || {}),
    doubles_pairing_mode: data.doubles_pairing_mode || 'pre_agreed', status: data.status, visibility: visibilityOf(data),
    contact_phone: data.contact_phone || '', contact_email: data.contact_email || '', publish_contact: Boolean(data.publish_contact),
    venue_address: data.venue_address || '', venue_lat: data.venue_lat ?? null, venue_lng: data.venue_lng ?? null,
    ...registrationDraftFields(data),
    schedule_min_rest: data.schedule_config?.min_rest_minutes == null ? '' : String(data.schedule_config.min_rest_minutes),
    schedule_timezone: data.schedule_config?.timezone || '' }
}
const settingsDraft = useFormDraft(settingsFields(props.tournament))
const settingsForm = settingsDraft.form
const settingsSaving = settingsDraft.saving
const settingsConflict = settingsDraft.conflict
const hasTournamentSettingsChanges = settingsDraft.dirty
const settingsError = ref('')
// The password is never part of the draft or the snapshot; only whether one
// exists. The code itself is read on demand through an organizer-only RPC.
const passwordDraft = ref('')
const passwordSet = computed(() => props.tournament.access_password_set === true)
const currentPassword = ref('')
const passwordShown = ref(false)
const passwordCopied = ref(false)
const passwordCopyFailed = ref(false)
// Codes set before the page could show them were only ever stored as a hash.
const passwordUnreadable = computed(() => passwordSet.value && !currentPassword.value)
const maskedPassword = computed(() => '•'.repeat(Math.min(currentPassword.value.length, 24)))

async function loadCurrentPassword() {
  passwordShown.value = false
  if (!passwordSet.value) { currentPassword.value = ''; return }
  const { data, error } = await supabase.rpc('tournament_password', { p_tournament_id: props.tournament.id })
  currentPassword.value = error ? '' : (data || '')
}
watch(passwordSet, loadCurrentPassword, { immediate: true })

async function copyPassword() {
  passwordCopied.value = false
  passwordCopyFailed.value = false
  try {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') throw new Error('unavailable')
    await navigator.clipboard.writeText(currentPassword.value)
    passwordCopied.value = true
    setTimeout(() => { passwordCopied.value = false }, 2000)
  } catch {
    // Without the clipboard the organizer can still reveal and select the code.
    passwordCopyFailed.value = true
    passwordShown.value = true
  }
}
const canSaveSettings = computed(() => hasTournamentSettingsChanges.value || Boolean(passwordDraft.value.trim()))
const statusValue = computed({ get: () => settingsForm.status, set: value => { settingsForm.status = value } })
const isTournamentActive = computed(() => props.tournament.status === 'in_progress')
const isTournamentFinished = computed(() => props.tournament.status === 'completed')
const formDisabled = computed(() => settingsSaving.value || props.busy || !props.canManage)
const structureDisabled = computed(() => isTournamentActive.value || isTournamentFinished.value || formDisabled.value)
const sportCfg = computed(() => getSportConfig(props.tournament.sport || 'tennis'))

// Секции-аккордеон: по умолчанию раскрыто только «Основное». Состояние живёт в компоненте,
// свёрнутая секция показывает короткую сводку своих значений.
const openSections = reactive(new Set(['basics']))
function toggleSection(key, event) {
  if (event.target.open) openSections.add(key)
  else openSections.delete(key)
}
const joinMeta = (...parts) => parts.filter(Boolean).join(' · ')
const sectionMeta = computed(() => {
  const f = settingsForm
  const fee = f.entry_fee_mode === 'paid'
    ? `${f.entry_fee_amount || ''} ${f.entry_fee_currency || ''}`.trim()
    : f.entry_fee_mode === 'free' ? t('registrationRules.feeModeFree') : ''
  return {
    contacts: joinMeta(f.contact_phone, f.contact_email),
    venue: joinMeta(f.venue_address, f.venue_lat != null ? t('venue.pointSet') : ''),
    registration: joinMeta(
      f.registration_capacity ? `${t('registrationRules.capacity')}: ${f.registration_capacity}` : '',
      f.registration_deadline ? formatDeadline(f.registration_deadline, locale.value) : '',
      fee,
    ),
    schedule: joinMeta(f.schedule_timezone, f.schedule_min_rest ? `${f.schedule_min_rest} ${t('schedule.minRestUnit')}` : ''),
    game: joinMeta(
      sportCfg.value.supportsCategory ? t('tournament.' + f.category) : '',
      sportCfg.value.supportsSetFormat && f.set_format ? t('format.' + f.set_format) : '',
    ),
    rules: props.tournament.sport === 'tennis' ? tennisRulesSummary(f.scoring_config, t) : '',
    access: joinMeta(t('tournament.' + f.status), t('access.visibility.' + f.visibility)),
  }
})
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

async function removePassword() {
  if (settingsSaving.value || props.busy || !props.canManage) return
  if (settingsForm.visibility === 'password' || props.tournament.visibility === 'password') { settingsError.value = t('access.errors.passwordRequired'); return }
  if (!(await confirmDialog(t('access.password.removeConfirm'), { danger: true }))) return
  settingsSaving.value = true
  settingsError.value = ''
  try {
    const { data, error } = await supabase.rpc('set_tournament_password', {
      p_tournament_id: props.tournament.id, p_password: null, p_expected_revision: settingsDraft.revision.value,
    })
    if (error) throw error
    currentPassword.value = ''
    passwordShown.value = false
    emit('saved', { ...props.tournament, settings_revision: data.settings_revision, access_password_set: false })
    await props.refresh()
  } catch (error) {
    settingsError.value = accessError(error.message, t, 'drafts.unavailable')
  } finally { settingsSaving.value = false }
}

async function saveTournamentSettings() {
  if (settingsSaving.value || props.busy || !props.canManage || !canSaveSettings.value) return
  if (settingsConflict.value) { settingsError.value = t('drafts.conflict'); return }
  const submitted = cloneForm(settingsForm)
  let revision = settingsDraft.revision.value
  const newPassword = passwordDraft.value.trim()
  if (submitted.visibility === 'password' && !passwordSet.value && !newPassword) { settingsError.value = t('access.errors.passwordRequired'); return }
  if (newPassword && (newPassword.length < 4 || newPassword.length > 72)) { settingsError.value = t('access.errors.passwordTooShort'); return }
  const categoryChanged = submitted.category !== settingsDraft.baseline.value.category
  const expectedMatches = matchVersions(props.matches)
  const regForm = pickRegistrationDraft(submitted)
  const regError = validateRegistrationForm(regForm)
  if (regError) { settingsError.value = t(regError); return }
  const minRest = String(submitted.schedule_min_rest ?? '').trim()
  if (minRest !== '' && !/^\d+$/.test(minRest)) { settingsError.value = t('schedule.errors.invalidConfig'); return }
  const deadlineChanged = regForm.registration_deadline !== settingsDraft.baseline.value.registration_deadline
  settingsSaving.value = true
  settingsError.value = ''
  try {
    if (categoryChanged && props.matches.length && !(await confirmDialog(t('drafts.categoryReset'), { danger: true }))) return
    const { slug, ...patch } = submitted
    if (newPassword) {
      const { data: pw, error: pwError } = await supabase.rpc('set_tournament_password', {
        p_tournament_id: props.tournament.id, p_password: newPassword, p_expected_revision: revision,
      })
      if (pwError) throw pwError
      revision = pw.settings_revision
      passwordDraft.value = ''
      currentPassword.value = newPassword
      passwordShown.value = false
    }
    for (const key of REGISTRATION_DRAFT_KEYS) delete patch[key]
    Object.assign(patch, registrationPatch(regForm, props.tournament))
    delete patch.schedule_min_rest; delete patch.schedule_timezone
    patch.schedule_config = {}
    if (minRest !== '') patch.schedule_config.min_rest_minutes = Number(minRest)
    if (submitted.schedule_timezone.trim()) patch.schedule_config.timezone = submitted.schedule_timezone.trim()
    if (deadlineChanged && patch.registration_deadline && new Date(patch.registration_deadline).getTime() <= Date.now()
      && !(await confirmDialog(t('registrationRules.deadlinePastConfirm')))) return
    patch.description = patch.description || null
    patch.contact_phone = patch.contact_phone?.trim() || null
    patch.contact_email = patch.contact_email?.trim() || null
    patch.publish_contact = Boolean(patch.publish_contact && (patch.contact_phone || patch.contact_email))
    patch.venue_address = patch.venue_address?.trim() || null
    patch.venue_lat = patch.venue_lat ?? null
    patch.venue_lng = patch.venue_lng ?? null
    patch.doubles_pairing_mode = patch.category === 'doubles' ? patch.doubles_pairing_mode : null
    const { data, error } = await supabase.rpc('update_tournament_settings', {
      p_tournament_id: props.tournament.id, p_patch: patch, p_expected_revision: revision,
      p_expected_matches: categoryChanged ? expectedMatches : null,
    })
    if (error) throw error
    settingsDraft.accepted(settingsFields(data), data.settings_revision, submitted)
    emit('saved', { ...data, access_password_set: newPassword ? true : props.tournament.access_password_set })
    if (categoryChanged) await props.refresh()
  } catch (error) {
    settingsError.value = accessError(error.message, t, 'drafts.unavailable')
    try { await props.refresh() } catch { /* Keep the draft and original error. */ }
  } finally { settingsSaving.value = false }
}
</script>

<template>
  <section class="card admin-settings-card stack" aria-labelledby="adm-settings-heading">
    <div class="admin-settings-card__head">
      <h2 id="adm-settings-heading" class="section-title" style="margin: 0">{{ t('admin.tournamentSettings') }}</h2>
      <p v-if="hasTournamentSettingsChanges && !settingsConflict" class="muted admin-settings-card__status" role="status">{{ t('drafts.unsaved') }}</p>
    </div>

    <div v-if="settingsConflict" class="alert alert--info" role="status">
      {{ t('drafts.conflict') }}
      <button class="btn btn--ghost btn--sm" type="button" @click="reloadSettings">{{ t('drafts.reload') }}</button>
    </div>
    <p v-if="settingsError && (!settingsConflict || settingsError !== t('drafts.conflict'))" class="error-text" role="alert">{{ settingsError }}</p>

    <div class="settings-accordion">
    <!-- Основное -->
    <details class="settings-section" :open="openSections.has('basics')" @toggle="toggleSection('basics', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('admin.wizardBasics') }}</h3>
        <span class="settings-section__meta">{{ settingsForm.name }}</span>
      </summary>
      <div class="settings-section__body">
        <div class="form-field">
          <label for="adm-name">{{ t('admin.name') }}</label>
          <input id="adm-name" v-model="settingsForm.name" class="input" type="text" required :disabled="formDisabled" />
        </div>
        <div class="form-field">
          <label for="adm-desc">{{ t('admin.description') }}</label>
          <textarea id="adm-desc" v-model="settingsForm.description" class="input" rows="3" :disabled="formDisabled" />
        </div>
      </div>
    </details>
    <!-- Контакты -->
    <details class="settings-section" :open="openSections.has('contacts')" @toggle="toggleSection('contacts', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('mobile.organizerContacts') }}</h3>
        <span class="settings-section__meta">{{ sectionMeta.contacts }}</span>
      </summary>
      <fieldset class="settings-section__body settings-fieldset" :disabled="formDisabled" :aria-label="t('mobile.organizerContacts')">
        <div class="grid-2">
          <div class="form-field">
            <label for="adm-contact-phone">{{ t('admin.contactPhone') }}</label>
            <input id="adm-contact-phone" v-model="settingsForm.contact_phone" class="input" type="tel" autocomplete="tel" />
          </div>
          <div class="form-field">
            <label for="adm-contact-email">{{ t('admin.contactEmail') }}</label>
            <input id="adm-contact-email" v-model="settingsForm.contact_email" class="input" type="email" autocomplete="email" />
          </div>
        </div>
        <label class="checkbox-row" for="adm-publish-contact">
          <input id="adm-publish-contact" v-model="settingsForm.publish_contact" type="checkbox" :disabled="!settingsForm.contact_phone && !settingsForm.contact_email" />
          {{ t('mobile.publishContacts') }}
        </label>
      </fieldset>
    </details>
    <!-- Место проведения -->
    <details class="settings-section" :open="openSections.has('venue')" @toggle="toggleSection('venue', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('venue.section') }}</h3>
        <span class="settings-section__meta">{{ sectionMeta.venue }}</span>
      </summary>
      <fieldset class="settings-section__body settings-fieldset" :disabled="formDisabled" :aria-label="t('venue.section')">
        <VenueFields
          v-model:address="settingsForm.venue_address"
          v-model:lat="settingsForm.venue_lat"
          v-model:lng="settingsForm.venue_lng"
          :disabled="formDisabled"
        />
      </fieldset>
    </details>
    <!-- Регистрация и взнос -->
    <details class="settings-section" :open="openSections.has('registration')" @toggle="toggleSection('registration', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('registrationRules.settingsTitle') }}</h3>
        <span class="settings-section__meta">{{ sectionMeta.registration }}</span>
      </summary>
      <div class="settings-section__body">
        <RegistrationRulesFields :form="settingsForm" :tournament="tournament" :disabled="formDisabled" id-prefix="adm-reg" variant="plain" />
      </div>
    </details>
    <!-- Расписание -->
    <details class="settings-section" :open="openSections.has('schedule')" @toggle="toggleSection('schedule', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('schedule.settingsTitle') }}</h3>
        <span class="settings-section__meta">{{ sectionMeta.schedule }}</span>
      </summary>
      <fieldset class="settings-section__body settings-fieldset" :disabled="formDisabled" :aria-label="t('schedule.settingsTitle')">
        <div class="grid-2">
          <div class="form-field">
            <span class="label-row">
              <label for="adm-min-rest">{{ t('schedule.minRest') }}</label>
              <InfoTip id="adm-min-rest-hint" :text="t('schedule.minRestHint')" />
            </span>
            <input id="adm-min-rest" v-model="settingsForm.schedule_min_rest" class="input" type="number" min="0" step="1" inputmode="numeric" aria-describedby="adm-min-rest-hint" />
          </div>
          <div class="form-field">
            <span class="label-row">
              <label for="adm-timezone">{{ t('schedule.timezone') }}</label>
              <InfoTip id="adm-timezone-hint" :text="t('schedule.timezoneHint')" />
            </span>
            <input id="adm-timezone" v-model="settingsForm.schedule_timezone" class="input" type="text" list="adm-timezone-list" autocomplete="off" :placeholder="browserTimezone()" aria-describedby="adm-timezone-hint" />
            <datalist id="adm-timezone-list">
              <option v-for="zone in COMMON_TIMEZONES" :key="zone" :value="zone" />
            </datalist>
          </div>
        </div>
      </fieldset>
    </details>
    <!-- Формат игры -->
    <details class="settings-section" :open="openSections.has('game')" @toggle="toggleSection('game', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('admin.settingsGame') }}</h3>
        <span class="settings-section__meta">{{ t('sport.' + (tournament.sport || 'tennis')) }} · {{ t('tournamentFormat.' + (tournament.format || 'single_elimination')) }}<template v-if="sectionMeta.game"> · {{ sectionMeta.game }}</template></span>
      </summary>
      <div class="settings-section__body">
        <div v-if="sportCfg.supportsCategory || sportCfg.supportsSetFormat" class="grid-2">
          <div v-if="sportCfg.supportsCategory" class="form-field">
            <label for="adm-cat">{{ t('admin.category') }}</label>
            <select id="adm-cat" v-model="settingsForm.category" class="input" :disabled="structureDisabled">
              <option value="singles">{{ t('tournament.singles') }}</option>
              <option value="doubles">{{ t('tournament.doubles') }}</option>
            </select>
          </div>
          <div v-if="sportCfg.supportsSetFormat" class="form-field">
            <label for="adm-format">{{ t('admin.setFormat') }}</label>
            <select id="adm-format" v-model="settingsForm.set_format" class="input" :disabled="structureDisabled">
              <option value="best_of_3">{{ t('format.best_of_3') }}</option>
              <option value="best_of_5">{{ t('format.best_of_5') }}</option>
            </select>
          </div>
        </div>
        <label v-if="sportCfg.supportsDoublesPairing && settingsForm.category === 'doubles'" class="checkbox-row">
          <input v-model="settingsForm.doubles_pairing_mode" type="checkbox" true-value="pick_random" false-value="pre_agreed" :disabled="structureDisabled" />
          {{ t('admin.pickRandomPairs') }}
        </label>
      </div>
    </details>
    <!-- Правила счёта -->
    <details v-if="tournament.sport === 'tennis'" class="settings-section" :open="openSections.has('rules')" @toggle="toggleSection('rules', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('tennisRules.title') }}</h3>
        <span class="settings-section__meta">{{ sectionMeta.rules }}</span>
      </summary>
      <div class="settings-section__body">
        <TennisRulesSettings v-model="settingsForm.scoring_config" id-prefix="settings-tennis" :disabled="structureDisabled" variant="plain" />
      </div>
    </details>
    <!-- Статус и доступ -->
    <details class="settings-section" :open="openSections.has('access')" @toggle="toggleSection('access', $event)">
      <summary class="settings-section__head">
        <svg class="settings-section__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="eyebrow">{{ t('admin.settingsAccess') }}</h3>
        <span class="settings-section__meta">{{ sectionMeta.access }}</span>
      </summary>
      <div class="settings-section__body">
        <div class="admin-settings-fields">
          <div class="form-field admin-settings-fields__status">
            <label for="adm-status">{{ t('admin.status') }}</label>
            <select id="adm-status" v-model="statusValue" class="input" :disabled="structureDisabled">
              <option value="draft" :disabled="structureDisabled">{{ t('tournament.draft') }}</option>
              <option value="registration_open" :disabled="structureDisabled">{{ t('tournament.registration_open') }}</option>
              <option value="registration_closed" :disabled="structureDisabled">{{ t('tournament.registration_closed') }}</option>
              <option v-if="isTournamentActive" value="in_progress" disabled>{{ t('tournament.in_progress') }}</option>
              <option v-if="isTournamentFinished" value="completed" disabled>{{ t('tournament.completed') }}</option>
            </select>
          </div>

          <fieldset class="visibility-modes admin-settings-fields__public" :disabled="formDisabled">
            <legend class="visibility-modes__legend">{{ t('access.whoSees') }}</legend>
            <div class="visibility-modes__list">
              <label v-for="mode in VISIBILITY_MODES" :key="mode" class="visibility-modes__option" :class="{ 'visibility-modes__option--on': settingsForm.visibility === mode }" :for="`adm-visibility-${mode}`">
                <input :id="`adm-visibility-${mode}`" v-model="settingsForm.visibility" type="radio" name="adm-visibility" :value="mode" />
                <span class="visibility-modes__title">{{ t(`access.visibility.${mode}`) }}</span>
                <InfoTip :text="t(`access.visibility.${mode}Hint`)" />
              </label>
            </div>

            <div v-if="settingsForm.visibility === 'password' || passwordSet" class="visibility-modes__password">
              <p v-if="!passwordSet" class="muted" style="margin: 0">{{ t('access.password.notSet') }}</p>
              <div v-else class="page-password">
                <span id="adm-page-password-current" class="page-password__label">{{ t('access.password.current') }}</span>
                <output v-if="!passwordUnreadable" class="page-password__value" :class="{ 'page-password__value--hidden': !passwordShown }" aria-labelledby="adm-page-password-current">
                  {{ passwordShown ? currentPassword : maskedPassword }}
                </output>
                <span v-else class="page-password__legacy muted">{{ t('access.password.unreadable') }}</span>
                <div v-if="!passwordUnreadable" class="page-password__actions">
                  <button
                    class="page-password__btn" type="button"
                    :aria-label="t(passwordShown ? 'access.password.hide' : 'access.password.show')"
                    :title="t(passwordShown ? 'access.password.hide' : 'access.password.show')"
                    :aria-pressed="passwordShown"
                    @click="passwordShown = !passwordShown"
                  >
                    <svg v-if="passwordShown" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.1 9.1 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m2 2 20 20"/></svg>
                    <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z"/><circle cx="12" cy="12" r="3"/></svg>
                  </button>
                  <button
                    class="page-password__btn" type="button"
                    :aria-label="t('access.password.copy')" :title="t('access.password.copy')"
                    @click="copyPassword"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
                  </button>
                  <span class="tooltip-wrapper" :data-tooltip="settingsForm.visibility === 'password' ? t('access.password.removeBlocked') : undefined">
                    <button
                      class="page-password__btn page-password__btn--danger" type="button"
                      :aria-label="t('access.password.remove')" :title="t('access.password.remove')"
                      :disabled="formDisabled || settingsForm.visibility === 'password'"
                      @click="removePassword"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>
                    </button>
                  </span>
                </div>
                <p v-if="passwordCopied" class="page-password__note success-text" role="status">{{ t('access.password.copied') }}</p>
                <p v-else-if="passwordCopyFailed" class="page-password__note error-text" role="status">{{ t('access.password.copyFailed') }}</p>
              </div>
              <div class="form-field">
                <span class="label-row">
                  <label for="adm-page-password">{{ t(passwordSet ? 'access.password.changeLabel' : 'access.password.newLabel') }}</label>
                  <InfoTip id="adm-page-password-hint" :text="t('access.password.hint')" />
                </span>
                <input id="adm-page-password" v-model="passwordDraft" class="input" type="password" autocomplete="new-password" minlength="4" maxlength="72" aria-describedby="adm-page-password-hint" />
              </div>
            </div>
          </fieldset>
        </div>
      </div>
    </details>
    </div>

    <footer class="admin-settings-card__footer">
      <button v-if="hasTournamentSettingsChanges && !settingsConflict" class="btn btn--ghost" type="button" :disabled="settingsSaving || busy" @click="reloadSettings">{{ t('drafts.reload') }}</button>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="busy || settingsSaving || !canManage || settingsConflict || !canSaveSettings"
        @click="saveTournamentSettings"
      >
        {{ t('admin.saveStatus') }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.admin-settings-card { gap: var(--space-5); }
.admin-settings-card__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.admin-settings-card__status { margin: 0; font-size: 0.85rem; }
.settings-fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }

/* Аккордеон: отступы живут в summary, поэтому вся полоса заголовка кликабельна */
.settings-accordion { display: flex; flex-direction: column; }
.settings-accordion > .settings-section { display: block; padding-top: 0; }
.settings-accordion > .settings-section:first-child { border-top: 0; }
.settings-section > summary { list-style: none; cursor: pointer; margin: 0; padding: 20px 12px; min-height: 64px; user-select: none; border-radius: 10px; transition: background .15s; }
.settings-section > summary::-webkit-details-marker { display: none; }
/* Свёрнутая секция: подсвечивается вся полоса между разделителями; раскрытая — только строка заголовка */
.settings-section:not([open]):hover > summary,
.settings-section[open] > summary:hover { background: var(--surface-row); }
.settings-section > summary:hover .eyebrow { color: var(--text); }
.settings-section:not([open]) > summary { border-radius: 0; }
.settings-section__chevron { flex: none; color: var(--muted); transition: transform .2s; }
.settings-section[open] .settings-section__chevron { transform: rotate(90deg); }
.settings-section__meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
.settings-section[open] > summary .settings-section__meta { display: none; }
.settings-section__body { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-2) var(--space-6) var(--space-6) calc(12px + 16px + var(--space-2)); }
@media (max-width: 640px) { .settings-section__body { padding-left: var(--space-3); padding-right: var(--space-3); } }
@media (prefers-reduced-motion: reduce) { .settings-section__chevron { transition: none; } }

.visibility-modes { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: var(--space-3); }
.visibility-modes__legend { padding: 0; font-size: 0.875rem; font-weight: 500; color: var(--text); margin-bottom: var(--space-2); float: left; width: 100%; }
.visibility-modes__list { clear: both; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-2); }
.visibility-modes__option {
  display: flex; align-items: center; gap: 8px; min-height: var(--touch-min); padding: 0 10px 0 12px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer;
  transition: border-color .15s, background .15s;
}
.visibility-modes__option:hover { border-color: var(--muted); }
.visibility-modes__option--on { border-color: var(--primary); background: var(--primary-soft); }
.visibility-modes__option input { margin: 0; flex: none; }
.visibility-modes__title { flex: 1; font-size: 0.9rem; font-weight: 600; }
.visibility-modes__password { display: grid; gap: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--border); }

.page-password { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.page-password__label { font-size: 0.84rem; color: var(--text-muted); }
.page-password__value { font-family: var(--font-mono); font-size: 0.95rem; letter-spacing: 0.04em; overflow-wrap: anywhere; }
.page-password__value--hidden { letter-spacing: 0.18em; }
.page-password__legacy { font-size: 0.84rem; flex: 1 1 100%; }
.page-password__actions { display: flex; align-items: center; gap: 2px; }
.page-password__btn {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
  border: 0; border-radius: 999px; background: transparent; color: var(--text-muted); cursor: pointer;
}
.page-password__btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
.page-password__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.page-password__btn--danger:hover:not(:disabled) { background: var(--danger-bg); color: var(--danger); }
.page-password__note { flex: 1 1 100%; margin: 0; font-size: 0.82rem; }
</style>
