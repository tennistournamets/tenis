<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { normalizeTournamentSlug } from '../lib/tournamentSlug'
import { tournamentShareUrl } from '../lib/shareLink'
import { supabase } from '../lib/supabase'
import { confirmDiscard, useUnsavedChanges, withApprovedDeparture } from '../lib/unsavedChanges'
import { cloneForm, sameForm } from '../lib/formDraft'
import { clearSessionDraft, readSessionDraft, userDraftKey, writeSessionDraft } from '../lib/sessionDraft'
import { useAuthStore } from '../stores/auth'
import { SPORTS, defaultPointsTarget, getSportConfig, isIndividualFormat, isPointsFormat, pointsTargetOptions, resolveCategory } from '../lib/sportConfig'
import { useFeatureFlagsStore } from '../stores/featureFlags'
import SportPicker from '../components/SportPicker.vue'
import AppIcon from '../components/AppIcon.vue'
import FormatPicker from '../components/FormatPicker.vue'
import TennisRulesSettings from '../components/TennisRulesSettings.vue'
import RegistrationRulesFields from '../components/admin/RegistrationRulesFields.vue'
import { hasRegistrationRules, pickRegistrationDraft, registrationDraftFields, registrationPatch, validateRegistrationForm, organizerContactError } from '../lib/registrationRules'
import { CREATE_VISIBILITY_MODES } from '../lib/access'
import { DEFAULT_TENNIS_RULES, tennisRulesSummary } from '../lib/tennisRules'
import VenueFields from '../components/admin/VenueFields.vue'
import { restoreDraftFields, deadlineInPast } from '../lib/wizardDraft'
import { track } from '../lib/analytics'
import { errorMessage } from '../lib/errorMessages'
import { confirmDialog } from '../lib/confirmDialog'
import AiCreatePanel from '../components/admin/AiCreatePanel.vue'
import ParticipantImportPreview from '../components/admin/ParticipantImportPreview.vue'
import { useAiFeature } from '../lib/aiFeatures'
import { entryShape, importRow, importRowProblem, rowsForShape } from '../lib/aiSchemas'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const flags = useFeatureFlagsStore()

const saving = ref(false)
const errorText = ref('')
const nameError = ref('')
const nameInput = ref(null)
const stepHeading = ref(null)
const wizardRoot = ref(null)
const slugInput = ref(null)
const formError = ref(null)
const slugError = ref('')
const fallbackSlug = `tournament-${crypto.randomUUID().slice(0, 8)}`
// 1 спорт · 2 формат · 3 правила игры · 4 о чемпионате · 5 регистрация · 6 публикация
const TOTAL_STEPS = 6
const step = ref(1)
const draftKey = ref('')
const draftReady = ref(false)
const draftRestored = ref(false)

const form = reactive({
  name: '',
  slug: '',
  description: '',
  sport: 'tennis',
  format: 'single_elimination',
  category: 'singles',
  set_format: 'best_of_3',
  tiebreak_to: 7,
  scoring_config: { tennis: { ...DEFAULT_TENNIS_RULES } },
  gender: 'men',
  contact_phone: '',
  contact_email: '',
  venue_address: '',
  venue_lat: null,
  venue_lng: null,
  is_public: true,
  visibility: 'link',
  generate_qr: false,
  doubles_pairing_random: false,
  // Groups + playoff: how many leave each group; checked against the group sizes when groups are drawn.
  advance_per_group: 2,
  // Padel points formats: the two scores of a match add up to this total.
  points_per_match: 24,
  ...registrationDraftFields({}),
  // "Describe the tournament" (AI): which fields it filled, the participant list from the text
  // (added as pending after the tournament is created), emails for them, and its remarks.
  ai_filled: [],
  ai_participants: [],
  ai_notify: false,
  ai_notes: { notices: [], remarks: [], unparsed: [] },
})
// is_public stays derived for the QR gate and the preview badge.
watch(() => form.visibility, mode => { form.is_public = mode !== 'private' }, { immediate: true })

const initialForm = cloneForm(form)
const hasDraftChanges = () => step.value !== 1 || !sameForm(form, initialForm)
function clearWizardDraft() {
  clearSessionDraft(draftKey.value)
}
const unregisterDraft = useUnsavedChanges(hasDraftChanges, () => saving.value, clearWizardDraft)

watch([form, step], () => {
  if (!draftReady.value) return
  if (!hasDraftChanges()) {
    clearWizardDraft()
    draftRestored.value = false
    return
  }
  writeSessionDraft(draftKey.value, { step: step.value, form: cloneForm(form) })
}, { deep: true })

const aiCreateOn = useAiFeature('create')
// Wizard step and label of each field the AI may fill (shown as "Filled by AI: …" on that step).
const AI_FIELD_STEPS = {
  sport: [2, 'admin.wizardStepSport'], format: [2, 'admin.wizardStepFormat'], advance_per_group: [2, 'groupsFlow.advance'],
  name: [3, 'admin.name'], description: [3, 'admin.description'], venue_address: [3, 'venue.section'],
  contact_phone: [3, 'admin.contactPhone'], contact_email: [3, 'admin.contactEmail'],
  category: [4, 'admin.category'], set_format: [4, 'admin.setFormat'], tiebreak_to: [4, 'admin.tiebreakTo'],
  points_per_match: [4, 'pointsFormat.targetLabel'], gender: [4, 'admin.divisionLabel'], doubles_pairing_random: [4, 'admin.pickRandomPairs'],
  registration_capacity: [5, 'registrationRules.capacity'], registration_deadline: [5, 'registrationRules.deadlineField'],
  entry_fee_mode: [5, 'registrationRules.feeSection'], waitlist_enabled: [5, 'registrationRules.waitlistSetting'],
}
const aiStepNote = computed(() => {
  const labels = form.ai_filled.filter(key => AI_FIELD_STEPS[key]?.[0] === step.value).map(key => t(AI_FIELD_STEPS[key][1]))
  return labels.length ? t('ai.create.stepFilled', { fields: labels.join(', ') }) : ''
})

function applyAi(result) {
  // Sport first: its watcher keeps the format valid, and the AI format was checked for it.
  if (result.fields.sport) form.sport = result.fields.sport
  Object.assign(form, result.fields)
  form.ai_filled = Object.keys(result.fields)
  form.ai_participants = result.participants.entries.map((entry, index) => ({ ...entry, key: `p${index}`, error: '' }))
  form.ai_notes = { notices: result.notices, remarks: result.remarks, unparsed: result.participants.unparsed }
  errorText.value = ''
  step.value = 2
}

const cfg = computed(() => getSportConfig(form.sport))
const effectiveCategory = computed(() => resolveCategory(form.sport, form.category))
const pointsFormat = computed(() => isPointsFormat(form.format))
// Americano, Mexicano, King of the Court: players sign up alone, pairs change every round.
const individualFormat = computed(() => isIndividualFormat(form.format))
const pointsOptions = computed(() => pointsTargetOptions(form.format))
// King of the Court needs an odd total; switching formats keeps a valid value.
watch(() => form.format, format => {
  if (isPointsFormat(format) && !pointsTargetOptions(format).includes(Number(form.points_per_match))) {
    form.points_per_match = defaultPointsTarget(format)
  }
})
// Mixed (man + woman) needs fixed pairs: individual formats rotate partners every round.
const mixedAllowed = computed(() => effectiveCategory.value === 'doubles' && !individualFormat.value)
// Like the category, the organizer's choice survives a look at singles; the payload sees the valid value.
const gender = computed({
  get: () => (form.gender === 'mixed' && !mixedAllowed.value ? initialForm.gender : form.gender),
  set: value => { form.gender = value },
})
const pairingMode = computed(() => (individualFormat.value || form.doubles_pairing_random ? 'pick_random' : 'pre_agreed'))
// The participant list from the text, in the shape the tournament takes after the organizer's choices.
const aiShape = computed(() => entryShape({ format: form.format, category: effectiveCategory.value, doubles_pairing_mode: pairingMode.value }))
const aiTeam = computed(() => getSportConfig(form.sport).scoringFamily === 'goals')
const AI_PARTICIPANTS_MAX = 128

const previewMeta = computed(() => {
  const parts = [
    t('sport.' + form.sport),
    t('tournament.' + effectiveCategory.value),
    t('tournamentFormat.' + form.format),
  ]
  if (pointsFormat.value) parts.push(t('pointsFormat.target', { n: form.points_per_match }))
  else if (cfg.value.supportsSetFormat) {
    parts.push(t('format.' + form.set_format))
  }
  return parts.join(' · ')
})

// A sport switched off by the super-admin must not stay selected.
watch(() => flags.enabledSports, (enabled) => {
  if (!flags.loaded || enabled.length === 0) return
  if (!enabled.includes(form.sport)) form.sport = enabled[0]
})

// Keep format valid for the chosen sport. A forced category (padel doubles, football
// singles) is applied through effectiveCategory only, so looking at padel and going
// back to tennis keeps the organizer's own choice.
watch(() => form.sport, (sport) => {
  const c = getSportConfig(sport)
  if (!c.allowedFormats.includes(form.format)) {
    form.format = c.allowedFormats[0]
  }
})

const resolvedSlug = computed(() => normalizeTournamentSlug(form.slug.trim() || form.name) || fallbackSlug)
const publicLink = computed(() => tournamentShareUrl(resolvedSlug.value))
watch(() => form.slug, () => { slugError.value = '' })
watch(() => form.name, () => { nameError.value = '' })
// The slug field shows the address the name will produce, not an unrelated example.
const slugPlaceholder = computed(() => normalizeTournamentSlug(form.name) || 'summer-cup-2026')
// Step names for the progress bar; finished steps can be revisited.
const STEP_KEYS = ['wizardStepSport', 'wizardStepFormat', 'wizardStepDetails', 'wizardStepRules', 'wizardStepRegistration', 'wizardStepPublish']
const stepName = i => t(`admin.${STEP_KEYS[i - 1]}`)
function goToStep(i) {
  if (i < step.value && !saving.value) { errorText.value = ''; slugError.value = ''; step.value = i }
}
const recapLink = computed(() => publicLink.value)
const recapRegistration = computed(() => {
  const parts = []
  if (form.registration_capacity) parts.push(t('admin.wizardRecapCapacity', { n: form.registration_capacity }))
  if (form.registration_deadline) parts.push(t('admin.wizardRecapDeadline'))
  if (form.entry_fee_mode === 'paid') parts.push(t('admin.wizardRecapFee'))
  return parts.length ? parts.join(' · ') : t('admin.wizardRecapNoRules')
})
watch(step, async () => {
  await nextTick()
  stepHeading.value?.focus({ preventScroll: true })
  // The app header wraps on narrow phones. Show the progress and the new heading
  // below its actual height instead of scrolling the heading behind a fixed offset.
  const headerHeight = document.querySelector('.app-header')?.getBoundingClientRect().height || 0
  const top = (wizardRoot.value?.getBoundingClientRect().top || 0) + window.scrollY - headerHeight - 12
  window.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
})

// Каждый шаг проверяет только свои поля; финальная проверка остаётся в createTournament.
async function nextStep() {
  errorText.value = ''
  slugError.value = ''
  if (step.value === 3) {
    if (!form.name.trim()) {
      nameError.value = t('admin.wizardNameRequired')
      await showCreateError(nameInput)
      return
    }
    if (form.slug.trim() && !normalizeTournamentSlug(form.slug)) {
      slugError.value = t('mobile.invalidSlug')
      await showCreateError(slugInput)
      return
    }
    const contactError = organizerContactError(form.contact_phone, form.contact_email)
    if (contactError) {
      errorText.value = t(contactError)
      await showCreateError(formError)
      return
    }
  }
  if (step.value === 5) {
    const regError = validateRegistrationForm(pickRegistrationDraft(form))
    if (regError) {
      errorText.value = t(regError)
      await showCreateError(formError)
      return
    }
    // Same warning as in the tournament settings: intake would close right away.
    if (deadlineInPast(form.registration_deadline) && !(await confirmDialog(t('registrationRules.deadlinePastConfirm')))) return
  }
  step.value += 1
}

function prevStep() {
  errorText.value = ''
  slugError.value = ''
  step.value -= 1
}

// Enter в поле формы ведёт на следующий шаг, а не создаёт чемпионат раньше времени.
function onSubmit() {
  return step.value < TOTAL_STEPS ? nextStep() : createTournament()
}

async function showCreateError(target) {
  await nextTick()
  target.value?.focus({ preventScroll: true })
  target.value?.scrollIntoView({ block: 'center', behavior: 'instant' })
}

async function createTournament() {
  if (!auth.user || saving.value) {
    return
  }

  errorText.value = ''
  slugError.value = ''
  // Поле названия живёт на шаге 3 — на финальном шаге браузерный required его не видит.
  if (!form.name.trim()) {
    step.value = 3
    nameError.value = t('admin.wizardNameRequired')
    await showCreateError(nameInput)
    return
  }
  if (form.slug.trim() && !normalizeTournamentSlug(form.slug)) {
    step.value = 3
    slugError.value = t('mobile.invalidSlug')
    await showCreateError(slugInput)
    return
  }
  const contactError = organizerContactError(form.contact_phone, form.contact_email)
  if (contactError) {
    step.value = 3
    errorText.value = t(contactError)
    await showCreateError(formError)
    return
  }
  const regForm = pickRegistrationDraft(form)
  const regError = validateRegistrationForm(regForm)
  if (regError) {
    step.value = 5
    errorText.value = t(regError)
    await showCreateError(formError)
    return
  }
  // Participants from the text: checked here, added after the tournament exists.
  const aiRows = rowsForShape(form.ai_participants, aiShape.value)
  if (aiRows.length > AI_PARTICIPANTS_MAX) {
    step.value = TOTAL_STEPS
    errorText.value = t('ai.import.tooMany')
    await showCreateError(formError)
    return
  }
  const aiProblems = aiRows.map(row => importRowProblem(row, { shape: aiShape.value, team: aiTeam.value }))
  if (aiProblems.some(Boolean)) {
    form.ai_participants = aiRows.map((row, index) => ({ ...row, error: aiProblems[index] ? t(aiProblems[index]) : '' }))
    step.value = TOTAL_STEPS
    errorText.value = t('ai.create.participantsInvalid', { n: aiProblems.filter(Boolean).length })
    await showCreateError(formError)
    return
  }
  saving.value = true
  const slug = resolvedSlug.value
  const category = effectiveCategory.value

  try {
    const { data: newId, error } = await supabase.rpc('create_tournament', {
      p_name: form.name,
      p_slug: slug,
      p_description: form.description || null,
      p_sport: form.sport,
      p_format: form.format,
      p_category: category,
      p_set_format: cfg.value.supportsSetFormat && !pointsFormat.value ? form.set_format : null,
      p_is_public: form.is_public,
      p_doubles_pairing_mode:
        category === 'doubles' && cfg.value.supportsDoublesPairing ? pairingMode.value : null,
      p_format_config: form.format === 'groups_playoff' ? { advance_per_group: Number(form.advance_per_group) || 2 } : {},
      p_scoring_config: pointsFormat.value
        ? { points_per_match: Number(form.points_per_match), gender: gender.value }
        : form.sport === 'tennis'
        ? { ...form.scoring_config, gender: gender.value }
        : cfg.value.supportsSetFormat ? { tiebreak_to: Number(form.tiebreak_to), gender: gender.value } : { gender: gender.value },
      p_contact_phone: form.contact_phone.trim() || null,
      p_contact_email: form.contact_email.trim() || null,
      p_venue_address: form.venue_address.trim() || null,
      p_venue_lat: form.venue_lat,
      p_venue_lng: form.venue_lng,
    })

    if (error) {
      if (error.code === '23505') {
        // The slug field lives on step 3; showing the error on the final step left it invisible.
        saving.value = false
        step.value = 3
        await nextTick()
        slugError.value = t('mobile.slugTaken')
        await showCreateError(slugInput)
      } else {
        errorText.value = errorMessage(error, t, 'mobile.createFailed')
        await showCreateError(formError)
      }
      return
    }

    if (!newId) throw new Error('Missing tournament ID')
    track('tournament_created', { sport: form.sport, format: form.format, category, visibility: form.visibility })
    // Conditions are a settings patch on the fresh row (revision 0); a failure
    // is reported on the tournament page instead of blocking the created tournament.
    let rulesFailed = false
    const extraPatch = {
      ...(hasRegistrationRules(regForm) ? registrationPatch(regForm, { sport: form.sport, category }) : {}),
      ...(form.visibility === 'public' ? { visibility: 'public' } : {}),
    }
    if (Object.keys(extraPatch).length) {
      const { error: rulesError } = await supabase.rpc('update_tournament_settings', {
        p_tournament_id: newId,
        p_patch: extraPatch,
        p_expected_revision: 0,
      })
      rulesFailed = Boolean(rulesError)
    }
    // Participants from the text wait for approval, like any registration.
    let aiFailed = 0
    if (aiRows.length) {
      const { data: added, error: addError } = await supabase.rpc('add_manual_entries', {
        p_tournament_id: newId,
        p_entries: aiRows.map(importRow),
        p_status: 'pending',
        p_notify: form.ai_notify,
      })
      aiFailed = addError ? aiRows.length : (Array.isArray(added) ? added.filter(row => !row.ok).length : 0)
      track('ai_create_participants', { rows: aiRows.length, failed: aiFailed })
    }
    clearWizardDraft()
    unregisterDraft()
    const query = {}
    if (form.is_public && form.generate_qr) query.qr = '1'
    // Registration is open from the start: offer to send the link right away.
    else if (form.is_public) query.created = '1'
    if (rulesFailed) query.regfail = '1'
    if (aiFailed) query.aifail = String(aiFailed)
    await router.replace({ name: 'admin-tournament', params: { id: newId }, query: Object.keys(query).length ? query : undefined })
  } catch (error) {
    errorText.value = errorMessage(error, t, 'mobile.createFailed')
    await showCreateError(formError)
  } finally {
    saving.value = false
  }
}

async function cancel() {
  if (!(await confirmDiscard(t, hasDraftChanges(), saving.value))) return
  clearWizardDraft()
  unregisterDraft()
  await withApprovedDeparture(() => router.push({ name: 'admin-tournaments' }))
}

function discardStoredDraft() {
  Object.assign(form, cloneForm(initialForm))
  step.value = 1
  errorText.value = ''
  slugError.value = ''
  draftRestored.value = false
  clearWizardDraft()
}

onMounted(async () => {
  await Promise.all([auth.init(), flags.load().catch(() => {})])
  if (flags.loaded && flags.enabledSports.length && !flags.enabledSports.includes(form.sport)) {
    form.sport = flags.enabledSports[0]
    initialForm.sport = form.sport
  }
  draftKey.value = userDraftKey('create-tournament', auth.user?.id)
  const stored = readSessionDraft(draftKey.value)
  if (stored?.form && Number.isInteger(stored.step) && stored.step >= 1 && stored.step <= TOTAL_STEPS) {
    Object.assign(form, restoreDraftFields(initialForm, stored.form))
    if (!SPORTS.includes(form.sport)) form.sport = initialForm.sport
    if (flags.loaded && flags.enabledSports.length && !flags.enabledSports.includes(form.sport)) form.sport = initialForm.sport
    if (!getSportConfig(form.sport).allowedFormats.includes(form.format)) form.format = initialForm.format
    if (!['singles', 'doubles'].includes(form.category)) form.category = initialForm.category
    if (!['best_of_3', 'best_of_5'].includes(form.set_format)) form.set_format = initialForm.set_format
    if (!['men', 'women', 'mixed'].includes(form.gender)) form.gender = initialForm.gender
    if (!CREATE_VISIBILITY_MODES.includes(form.visibility)) form.visibility = initialForm.visibility
    step.value = stored.step
    draftRestored.value = hasDraftChanges()
  }
  draftReady.value = true
  track('create_started', { step: step.value })
})

// Funnel: which wizard step people reach before they leave. Draft restores jump steps and are skipped.
watch(step, (next, prev) => { if (draftReady.value && next === prev + 1) track('create_step', { step: next }) })
</script>

<template>
  <div ref="wizardRoot" class="wizard">
    <div v-if="draftRestored" class="alert alert--info wizard__draft" role="status">
      <span>{{ t('drafts.restored') }}</span>
      <button type="button" class="btn btn--ghost btn--sm" :disabled="saving" @click="discardStoredDraft">
        {{ t('drafts.discardStored') }}
      </button>
    </div>
    <!-- Wizard chrome header -->
    <header class="wizard__head">
      <div class="wizard__brand">
        <span class="wizard__title">{{ t('admin.wizardTitle') }}</span>
        <button v-if="step > 1" type="button" class="wizard__sport-pill" :disabled="saving" @click="step = 1">
          <AppIcon :name="form.sport" :size="14" />
          {{ t('sport.' + form.sport) }}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
      </div>
      <div class="wizard__progress-wrap" role="status" aria-live="polite">
        <div class="wizard__progress">
          <button
            v-for="i in TOTAL_STEPS"
            :key="i"
            type="button"
            class="wizard__seg"
            :class="{ 'wizard__seg--on': step >= i, 'wizard__seg--link': i < step }"
            :title="stepName(i)"
            :aria-label="t('admin.wizardGoToStep', { n: i, name: stepName(i) })"
            :disabled="i >= step || saving"
            @click="goToStep(i)"
          />
        </div>
        <span class="wizard__step-count">{{ t('admin.wizardStepOf', { n: step, total: TOTAL_STEPS }) }} · {{ stepName(step) }}</span>
      </div>
      <button type="button" class="btn btn--ghost btn--sm" @click="cancel">{{ t('admin.wizardExit') }}</button>
    </header>

    <!-- Step 1: sport -->
    <div v-if="step === 1" class="wizard__body">
      <div class="wizard__lead">
        <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.stepSport') }}</h1>
        <p class="muted">{{ t('admin.wizardSportHint') }}</p>
      </div>
      <AiCreatePanel
        v-if="aiCreateOn()"
        :sport="form.sport"
        :enabled-sports="flags.enabledSports"
        @apply="applyAi"
      />
      <SportPicker v-model="form.sport" />
    </div>

    <!-- Step 2: format -->
    <div v-else-if="step === 2" class="wizard__body">
      <div class="wizard__lead">
        <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.stepFormat') }}</h1>
        <p class="muted">{{ t('admin.wizardFormatHint') }}</p>
      </div>
      <div v-if="form.ai_filled.length || form.ai_participants.length" class="alert alert--info wizard__ai" role="status">
        <p class="wizard__ai-title">{{ t('ai.create.filledTitle') }}</p>
        <p>{{ t('ai.create.filledHint') }}</p>
        <p v-if="aiStepNote">{{ aiStepNote }}</p>
        <p v-if="form.ai_participants.length">{{ t('ai.create.participantsFound', { n: form.ai_participants.length }) }}</p>
        <ul v-if="form.ai_notes.notices.length || form.ai_notes.remarks.length" class="wizard__ai-list">
          <li v-for="code in form.ai_notes.notices" :key="code">{{ t(`ai.create.notices.${code}`) }}</li>
          <li v-for="(line, index) in form.ai_notes.remarks" :key="`r${index}`">{{ line }}</li>
        </ul>
      </div>
      <FormatPicker v-model="form.format" :sport="form.sport" />
      <div v-if="form.format === 'groups_playoff'" class="form-field form-field--narrow">
        <label for="create-advance">{{ t('groupsFlow.advance') }}</label>
        <select id="create-advance" v-model.number="form.advance_per_group" class="input" aria-describedby="create-advance-hint">
          <option v-for="n in [1, 2, 3, 4]" :key="n" :value="n">{{ n }}</option>
        </select>
        <p id="create-advance-hint" class="field-hint">{{ t('groupsFlow.advanceHint') }}</p>
      </div>
    </div>

    <!-- Steps 3–6: настройки как продолжение степпера + живое превью -->
    <form v-else id="wizard-form" class="wizard__body wizard__body--form" @submit.prevent="onSubmit">
      <fieldset :disabled="saving" style="display: contents">
      <div class="wizard__form">
        <!-- Step 3: о чемпионате — название, ссылка, контакты -->
        <template v-if="step === 3">
        <div class="wizard__lead">
          <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.stepDetails') }}</h1>
        </div>
        <p v-if="aiStepNote" class="alert alert--info wizard__ai" role="status">{{ aiStepNote }}</p>
        <section class="wizard__group wizard__group--plain">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardBasics') }}</h2>

          <div class="form-field">
            <label for="create-name">{{ t('admin.name') }}</label>
            <input id="create-name" ref="nameInput" v-model="form.name" class="input input--lg" :class="{ 'input--error': nameError }" type="text" required autocomplete="off"
              :aria-invalid="Boolean(nameError)" :aria-describedby="nameError ? 'create-name-error' : undefined" />
            <p v-if="nameError" id="create-name-error" class="error-text" role="alert">{{ nameError }}</p>
          </div>

          <div class="form-field">
            <label for="create-desc">{{ t('admin.description') }}</label>
            <textarea id="create-desc" v-model="form.description" class="input" rows="3" />
          </div>
        </section>

        <section class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardLink') }}</h2>

          <div class="form-field">
            <label for="create-slug">{{ t('admin.slug') }}</label>
            <input id="create-slug" ref="slugInput" v-model="form.slug" class="input" type="text" maxlength="80"
              autocapitalize="none" spellcheck="false" :placeholder="slugPlaceholder"
              :aria-invalid="Boolean(slugError)" aria-describedby="create-slug-preview create-slug-error" />
            <p id="create-slug-preview" class="wizard__link-preview">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
              <span class="sr-only">{{ t('mobile.linkPreview') }}</span>{{ publicLink }}
            </p>
            <p v-if="slugError" id="create-slug-error" class="error-text" role="alert">{{ slugError }}</p>
          </div>
        </section>

        <section class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardContacts') }}</h2>

          <div class="wizard__grid2">
            <div class="form-field">
              <label for="create-phone">{{ t('admin.contactPhone') }}</label>
              <input id="create-phone" v-model="form.contact_phone" class="input" type="tel" placeholder="+370 600 00000" autocomplete="tel" />
            </div>

            <div class="form-field">
              <label for="create-email">{{ t('admin.contactEmail') }}</label>
              <input id="create-email" v-model="form.contact_email" class="input" type="email" placeholder="info@example.com" autocomplete="email" />
            </div>
          </div>
        </section>

        <section class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('venue.section') }}</h2>
          <VenueFields
            v-model:address="form.venue_address"
            v-model:lat="form.venue_lat"
            v-model:lng="form.venue_lng"
          />
        </section>
        </template>

        <!-- Step 4: правила игры -->
        <template v-else-if="step === 4">
        <div class="wizard__lead">
          <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.wizardRules') }}</h1>
        </div>
        <p v-if="aiStepNote" class="alert alert--info wizard__ai" role="status">{{ aiStepNote }}</p>
        <section class="wizard__group wizard__group--plain">
          <p class="wizard__eyebrow">{{ t('admin.wizardBasics') }}</p>
          <div class="wizard__grid3">
            <div v-if="cfg.supportsCategory" class="form-field">
              <label for="create-cat">{{ t('admin.category') }}</label>
              <select id="create-cat" v-model="form.category" class="input">
                <option value="singles">{{ t('tournament.singles') }}</option>
                <option value="doubles">{{ t('tournament.doubles') }}</option>
              </select>
            </div>

            <div v-if="pointsFormat" class="form-field">
              <label for="create-points">{{ t('pointsFormat.targetLabel') }}</label>
              <select id="create-points" v-model.number="form.points_per_match" class="input" aria-describedby="create-points-hint">
                <option v-for="n in pointsOptions" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>

            <div v-if="cfg.supportsSetFormat && !pointsFormat" class="form-field">
              <label for="create-format">{{ t('admin.setFormat') }}</label>
              <select id="create-format" v-model="form.set_format" class="input">
                <option value="best_of_3">{{ t('format.best_of_3') }}</option>
                <option value="best_of_5">{{ t('format.best_of_5') }}</option>
              </select>
            </div>

            <div v-if="form.sport === 'padel' && !pointsFormat" class="form-field">
              <label for="create-tiebreak">{{ t('admin.tiebreakTo') }}</label>
              <select id="create-tiebreak" v-model.number="form.tiebreak_to" class="input">
                <option :value="7">{{ t('admin.tiebreakTo7') }}</option>
                <option :value="10">{{ t('admin.tiebreakTo10') }}</option>
              </select>
            </div>

            <div class="form-field">
              <label for="create-gender">{{ t('admin.divisionLabel') }}</label>
              <select id="create-gender" v-model="gender" class="input">
                <option value="men">{{ t('admin.genderMen') }}</option>
                <option value="women">{{ t('admin.genderWomen') }}</option>
                <option v-if="mixedAllowed" value="mixed">{{ t('admin.genderMixed') }}</option>
              </select>
            </div>
          </div>
          <p v-if="pointsFormat" id="create-points-hint" class="field-hint">
            {{ t(form.format === 'king_of_court' ? 'pointsFormat.targetHintKotc' : 'pointsFormat.targetHint') }}
          </p>

        </section>

        <section v-if="form.sport === 'tennis'" class="wizard__group">
          <p class="wizard__eyebrow">{{ t('tennisRules.title') }}</p>
          <TennisRulesSettings v-model="form.scoring_config" id-prefix="create-tennis" :disabled="saving" variant="plain" />
        </section>

        <section v-if="individualFormat" class="wizard__group">
          <p class="muted">{{ t('pointsFormat.individualHint') }}</p>
        </section>
        <section v-else-if="effectiveCategory === 'doubles' && cfg.supportsDoublesPairing" class="wizard__group">
          <label class="wizard__toggle">
            <input v-model="form.doubles_pairing_random" type="checkbox" />
            <span class="wizard__toggle-body">
              <span class="wizard__toggle-title">{{ t('admin.pickRandomPairs') }}</span>
            </span>
          </label>
        </section>
        </template>

        <!-- Step 5: регистрация -->
        <template v-else-if="step === 5">
        <div class="wizard__lead">
          <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('registrationRules.wizardSection') }}</h1>
          <p class="muted">{{ t('registrationRules.wizardHint') }}</p>
        </div>
        <p v-if="aiStepNote" class="alert alert--info wizard__ai" role="status">{{ aiStepNote }}</p>
        <section class="wizard__group wizard__group--plain">
          <RegistrationRulesFields
            :form="form"
            :tournament="{ sport: form.sport, format: form.format, category: effectiveCategory, doubles_pairing_mode: pairingMode }"
            :disabled="saving"
            id-prefix="create-reg"
            hide-main-legend
          />
        </section>
        </template>

        <!-- Step 6: публикация -->
        <template v-else>
        <div class="wizard__lead">
          <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.wizardPublish') }}</h1>
          <p class="muted">{{ t('admin.wizardPublishHint') }}</p>
        </div>
        <div class="wizard__recap" aria-live="polite">
          <span class="wizard__recap-icon"><AppIcon :name="form.sport" :size="20" /></span>
          <div class="wizard__recap-body">
            <span class="wizard__recap-name">{{ form.name || t('admin.wizardUntitled') }}</span>
            <span class="wizard__recap-meta">{{ previewMeta }}</span>
            <span v-if="form.sport === 'tennis'" class="wizard__recap-rules">{{ tennisRulesSummary(form.scoring_config, t) }}</span>
            <span class="wizard__recap-rules">{{ recapRegistration }}</span>
            <span class="wizard__recap-rules wizard__recap-link">{{ recapLink }}</span>
          </div>
        </div>
        <section v-if="form.ai_participants.length" class="wizard__group wizard__ai-participants" aria-labelledby="create-ai-participants">
          <div class="wizard__ai-head">
            <h2 id="create-ai-participants" class="wizard__eyebrow">{{ t('ai.create.participantsTitle', { n: form.ai_participants.length }) }}</h2>
            <button type="button" class="btn btn--ghost btn--sm" @click="form.ai_participants = []">{{ t('ai.create.removeList') }}</button>
          </div>
          <p class="field-hint">{{ t('ai.create.participantsHint') }}</p>
          <p v-if="aiShape === 'single' && form.ai_participants.some(row => row.members.filter(Boolean).length > 1)" class="alert alert--info">{{ t('ai.import.notices.splitPairs') }}</p>
          <ParticipantImportPreview v-model="form.ai_participants" :shape="aiShape" :team="aiTeam" :disabled="saving" />
          <ul v-if="form.ai_notes.unparsed.length" class="wizard__ai-list">
            <li v-for="(line, index) in form.ai_notes.unparsed" :key="`u${index}`">{{ t('ai.create.unparsed', { line }) }}</li>
          </ul>
          <label class="checkbox-row" for="create-ai-notify">
            <input id="create-ai-notify" v-model="form.ai_notify" type="checkbox" />
            <span>{{ t('ai.import.notify') }} <span class="field-hint">{{ t('ai.import.notifyHint') }}</span></span>
          </label>
        </section>
        <section class="wizard__group wizard__group--plain">

          <label v-for="mode in CREATE_VISIBILITY_MODES" :key="mode" class="wizard__toggle">
            <input v-model="form.visibility" type="radio" name="create-visibility" :value="mode" />
            <span class="wizard__toggle-body">
              <span class="wizard__toggle-title">{{ t(`access.visibility.${mode}`) }}</span>
              <span class="wizard__toggle-hint">{{ t(`access.visibility.${mode}Hint`) }}</span>
            </span>
          </label>

          <label class="wizard__toggle" :class="{ 'wizard__toggle--disabled': !form.is_public }">
            <input v-model="form.generate_qr" type="checkbox" :disabled="!form.is_public" />
            <span class="wizard__toggle-body">
              <span class="wizard__toggle-title">{{ t('admin.wizardQr') }}</span>
              <span class="wizard__toggle-hint">{{ t('admin.wizardQrHint') }}</span>
            </span>
          </label>
        </section>
        </template>

        <p v-if="errorText" ref="formError" class="error-text" role="alert" tabindex="-1">{{ errorText }}</p>
      </div>
      </fieldset>
    </form>

    <!-- Footer action bar -->
    <footer class="wizard__foot">
      <button
        v-if="step > 1"
        class="btn btn--outline"
        type="button"
        :disabled="saving"
        @click="prevStep"
      >
        {{ t('admin.back') }}
      </button>
      <span class="wizard__foot-spacer" />
      <button v-if="step < 3" class="btn btn--primary" type="button" @click="step += 1">
        {{ t('admin.next') }}
      </button>
      <button
        v-else
        class="btn btn--primary"
        type="submit"
        form="wizard-form"
        :disabled="saving"
      >
        {{ step < TOTAL_STEPS ? t('admin.next') : t('admin.create') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.wizard__ai {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wizard__ai p {
  margin: 0;
}
.wizard__ai-title {
  font-weight: 600;
}
.wizard__ai-list {
  margin: 4px 0 0;
  padding-left: 18px;
}
.wizard__ai-participants {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
}
.wizard__ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
}
.wizard__ai-head .wizard__eyebrow {
  margin: 0;
}
.wizard {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  max-width: 880px;
  margin: 0 auto;
  padding: var(--space-5) var(--space-6) var(--space-6);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
}

.wizard__draft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0;
}

.wizard__head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.wizard__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.wizard__title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 1.1rem;
  letter-spacing: -0.02em;
  color: var(--text);
}

.wizard__sport-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.wizard__sport-pill:hover { border-color: var(--primary); }
.wizard__sport-pill svg { color: var(--muted); }

.wizard__progress-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}

.wizard__progress {
  display: flex;
  gap: 6px;
}

.wizard__seg {
  width: 34px;
  height: 21px;
  padding: 8px 0;
  border: 0;
  border-radius: 3px;
  background: var(--border);
  background-clip: content-box;
  cursor: default;
  transition: background 0.2s;
}

.wizard__seg:disabled { opacity: 1; }
.wizard__seg--link { cursor: pointer; }
.wizard__seg--link:hover { background-color: var(--primary-hover); }
.wizard__seg:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.wizard__recap-link { font-family: var(--font-mono); overflow-wrap: anywhere; }

.wizard__seg--on { background: var(--primary); }

.wizard__step-count {
  font-size: 0.85rem;
  color: var(--muted);
}

.wizard__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.wizard__lead { display: flex; flex-direction: column; gap: 4px; }

.wizard__heading {
  scroll-margin-top: 96px;
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 1.5rem;
  letter-spacing: -0.02em;
  color: var(--text);
  margin: 0;
}

.wizard__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  width: 100%;
}

.wizard__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-5);
  border-top: 1px solid var(--border);
}

.wizard__group--plain {
  border-top: 0;
  padding-top: 0;
}

.wizard__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
}

.wizard__grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.wizard__field-hint {
  margin: 4px 0 0;
  font-size: 0.78rem;
  color: var(--muted);
}

.wizard__toggle {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2, var(--surface-row));
  cursor: pointer;
  transition: border-color 0.15s;
}

.wizard__toggle:hover {
  border-color: var(--border-strong);
}

.wizard__toggle--disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wizard__toggle--disabled:hover {
  border-color: var(--border);
}

.wizard__toggle input {
  margin-top: 2px;
  accent-color: var(--primary);
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.wizard__toggle-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wizard__toggle-title {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text);
}

.wizard__toggle-hint {
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--muted);
}

@media (max-width: 560px) {
  .wizard__grid2 { grid-template-columns: 1fr; }
}

.wizard__grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
}

@media (max-width: 1000px) {
  .wizard__grid3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 560px) {
  .wizard__grid3 { grid-template-columns: 1fr; }
}

/* Recap on the publish step: what will be created */
.wizard__recap {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-row);
}

.wizard__recap-icon {
  width: 40px;
  height: 40px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  border-radius: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
}

.wizard__recap-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.wizard__recap-name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.05rem;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.wizard__recap-meta {
  font-size: 0.9rem;
  color: var(--text);
}

.wizard__recap-rules {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--muted);
}

.wizard__foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

.wizard__foot-spacer { flex: 1; }

@media (max-width: 760px) {
  .wizard { padding: 16px; }
  /* Long texts (translations, browser auto-translate, large system font) wrap instead of
     widening the page: the exit button moves under the title when both do not fit, the step
     name wraps and the segments shrink. */
  .wizard__head { flex-wrap: wrap; gap: 12px; }
  .wizard__brand { flex: 1 1 12rem; flex-wrap: wrap; gap: 8px; }
  .wizard__head > .btn { min-height: 44px; margin-left: auto; }
  .wizard__progress-wrap { order: 1; flex: 1 1 100%; display: flex; min-width: 0; justify-content: space-between; margin: 0; }
  .wizard__progress { flex: 1 1 auto; min-width: 0; max-width: calc(6 * 34px + 5 * 6px); }
  .wizard__seg { flex: 1 1 0; width: auto; min-width: 8px; }
  .wizard__sport-pill { min-height: 44px; }
  .wizard__step-count { flex: 0 1 auto; min-width: 0; text-align: right; overflow-wrap: anywhere; }
}
.wizard__link-preview {
  display: flex; align-items: center; gap: 6px; margin: 0;
  font-family: var(--font-mono); font-size: .78rem; line-height: 1.5; overflow-wrap: anywhere; min-width: 0;
  color: var(--muted);
}
.wizard__link-preview svg { flex: none; color: var(--primary); }
.wizard__form .input--lg { font-size: 1.05rem; font-weight: 600; min-height: 52px; }
#create-slug { scroll-margin-top: 96px; }
</style>
