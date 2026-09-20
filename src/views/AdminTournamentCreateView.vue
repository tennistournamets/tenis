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
import { SPORTS, getSportConfig, resolveCategory } from '../lib/sportConfig'
import { useFeatureFlagsStore } from '../stores/featureFlags'
import SportPicker from '../components/SportPicker.vue'
import AppIcon from '../components/AppIcon.vue'
import FormatPicker from '../components/FormatPicker.vue'
import TennisRulesSettings from '../components/TennisRulesSettings.vue'
import RegistrationRulesFields from '../components/admin/RegistrationRulesFields.vue'
import { hasRegistrationRules, pickRegistrationDraft, registrationDraftFields, registrationPatch, validateRegistrationForm } from '../lib/registrationRules'
import { CREATE_VISIBILITY_MODES } from '../lib/access'
import { DEFAULT_TENNIS_RULES, tennisRulesSummary } from '../lib/tennisRules'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const flags = useFeatureFlagsStore()

const saving = ref(false)
const errorText = ref('')
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
  is_public: true,
  visibility: 'link',
  generate_qr: false,
  doubles_pairing_random: false,
  ...registrationDraftFields({}),
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

const cfg = computed(() => getSportConfig(form.sport))
const effectiveCategory = computed(() => resolveCategory(form.sport, form.category))

const previewMeta = computed(() => {
  const parts = [
    t('sport.' + form.sport),
    t('tournament.' + effectiveCategory.value),
    t('tournamentFormat.' + form.format),
  ]
  if (cfg.value.supportsSetFormat) {
    parts.push(t('format.' + form.set_format))
  }
  return parts.join(' · ')
})

// A sport switched off by the super-admin must not stay selected.
watch(() => flags.enabledSports, (enabled) => {
  if (!flags.loaded || enabled.length === 0) return
  if (!enabled.includes(form.sport)) form.sport = enabled[0]
})

// Keep format valid for the chosen sport; apply forced category.
watch(() => form.sport, (sport) => {
  const c = getSportConfig(sport)
  if (!c.allowedFormats.includes(form.format)) {
    form.format = c.allowedFormats[0]
  }
  if (c.forcedCategory) {
    form.category = c.forcedCategory
  }
})

const resolvedSlug = computed(() => normalizeTournamentSlug(form.slug.trim() || form.name) || fallbackSlug)
const publicLink = computed(() => tournamentShareUrl(resolvedSlug.value))
watch(() => form.slug, () => { slugError.value = '' })
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
      errorText.value = t('admin.wizardNameRequired')
      await showCreateError(formError)
      return
    }
    if (form.slug.trim() && !normalizeTournamentSlug(form.slug)) {
      slugError.value = t('mobile.invalidSlug')
      await showCreateError(slugInput)
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
    errorText.value = t('admin.wizardNameRequired')
    await showCreateError(formError)
    return
  }
  if (form.slug.trim() && !normalizeTournamentSlug(form.slug)) {
    step.value = 3
    slugError.value = t('mobile.invalidSlug')
    await showCreateError(slugInput)
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
      p_set_format: cfg.value.supportsSetFormat ? form.set_format : null,
      p_is_public: form.is_public,
      p_doubles_pairing_mode:
        category === 'doubles' && cfg.value.supportsDoublesPairing
          ? (form.doubles_pairing_random ? 'pick_random' : 'pre_agreed')
          : null,
      p_format_config: {},
      p_scoring_config: form.sport === 'tennis'
        ? { ...form.scoring_config, gender: form.gender }
        : cfg.value.supportsSetFormat ? { tiebreak_to: Number(form.tiebreak_to), gender: form.gender } : { gender: form.gender },
      p_contact_phone: form.contact_phone.trim() || null,
      p_contact_email: form.contact_email.trim() || null,
    })

    if (error) {
      if (error.code === '23505') {
        slugError.value = t('mobile.slugTaken')
        saving.value = false
        await showCreateError(slugInput)
      } else {
        errorText.value = t('mobile.createFailed')
        await showCreateError(formError)
      }
      return
    }

    if (!newId) throw new Error('Missing tournament ID')
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
    clearWizardDraft()
    unregisterDraft()
    const query = {}
    if (form.is_public && form.generate_qr) query.qr = '1'
    if (rulesFailed) query.regfail = '1'
    await router.replace({ name: 'admin-tournament', params: { id: newId }, query: Object.keys(query).length ? query : undefined })
  } catch {
    errorText.value = t('mobile.createFailed')
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
    const restored = {}
    for (const [key, fallback] of Object.entries(initialForm)) {
      const value = stored.form[key]
      if (value === undefined) continue
      if (fallback && typeof fallback === 'object') {
        if (value && typeof value === 'object' && !Array.isArray(value)) restored[key] = cloneForm(value)
      } else if (typeof value === typeof fallback) {
        restored[key] = value
      }
    }
    Object.assign(form, restored)
    if (!SPORTS.includes(form.sport)) form.sport = initialForm.sport
    if (flags.loaded && flags.enabledSports.length && !flags.enabledSports.includes(form.sport)) form.sport = initialForm.sport
    if (!getSportConfig(form.sport).allowedFormats.includes(form.format)) form.format = initialForm.format
    if (!['singles', 'doubles'].includes(form.category)) form.category = initialForm.category
    if (!['best_of_3', 'best_of_5'].includes(form.set_format)) form.set_format = initialForm.set_format
    if (!['men', 'women'].includes(form.gender)) form.gender = initialForm.gender
    if (!CREATE_VISIBILITY_MODES.includes(form.visibility)) form.visibility = initialForm.visibility
    step.value = stored.step
    draftRestored.value = hasDraftChanges()
  }
  draftReady.value = true
})
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
        <div class="wizard__progress" aria-hidden="true">
          <span v-for="i in TOTAL_STEPS" :key="i" class="wizard__seg" :class="{ 'wizard__seg--on': step >= i }" />
        </div>
        <span class="wizard__step-count">{{ t('admin.wizardStepOf', { n: step, total: TOTAL_STEPS }) }}</span>
      </div>
      <button type="button" class="btn btn--ghost btn--sm" @click="cancel">{{ t('admin.wizardExit') }}</button>
    </header>

    <!-- Step 1: sport -->
    <div v-if="step === 1" class="wizard__body">
      <div class="wizard__lead">
        <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.stepSport') }}</h1>
        <p class="muted">{{ t('admin.wizardSportHint') }}</p>
      </div>
      <SportPicker v-model="form.sport" />
    </div>

    <!-- Step 2: format -->
    <div v-else-if="step === 2" class="wizard__body">
      <div class="wizard__lead">
        <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.stepFormat') }}</h1>
        <p class="muted">{{ t('admin.wizardFormatHint') }}</p>
      </div>
      <FormatPicker v-model="form.format" :sport="form.sport" />
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
        <section class="wizard__group wizard__group--plain">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardBasics') }}</h2>

          <div class="form-field">
            <label for="create-name">{{ t('admin.name') }}</label>
            <input id="create-name" v-model="form.name" class="input input--lg" type="text" required autocomplete="off" />
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
              autocapitalize="none" spellcheck="false" placeholder="summer-cup-2026"
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
        </template>

        <!-- Step 4: правила игры -->
        <template v-else-if="step === 4">
        <div class="wizard__lead">
          <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.wizardRules') }}</h1>
        </div>
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

            <div v-if="cfg.supportsSetFormat" class="form-field">
              <label for="create-format">{{ t('admin.setFormat') }}</label>
              <select id="create-format" v-model="form.set_format" class="input">
                <option value="best_of_3">{{ t('format.best_of_3') }}</option>
                <option value="best_of_5">{{ t('format.best_of_5') }}</option>
              </select>
            </div>

            <div v-if="form.sport === 'padel'" class="form-field">
              <label for="create-tiebreak">{{ t('admin.tiebreakTo') }}</label>
              <select id="create-tiebreak" v-model.number="form.tiebreak_to" class="input">
                <option :value="7">{{ t('admin.tiebreakTo7') }}</option>
                <option :value="10">{{ t('admin.tiebreakTo10') }}</option>
              </select>
            </div>

            <div class="form-field">
              <label for="create-gender">{{ t('admin.championshipGender') }}</label>
              <select id="create-gender" v-model="form.gender" class="input">
                <option value="men">{{ t('admin.genderMen') }}</option>
                <option value="women">{{ t('admin.genderWomen') }}</option>
              </select>
            </div>
          </div>

        </section>

        <section v-if="form.sport === 'tennis'" class="wizard__group">
          <p class="wizard__eyebrow">{{ t('tennisRules.title') }}</p>
          <TennisRulesSettings v-model="form.scoring_config" id-prefix="create-tennis" :disabled="saving" variant="plain" />
        </section>

        <section v-if="effectiveCategory === 'doubles' && cfg.supportsDoublesPairing" class="wizard__group">
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
        <section class="wizard__group wizard__group--plain">
          <RegistrationRulesFields
            :form="form"
            :tournament="{ sport: form.sport, category: effectiveCategory, doubles_pairing_mode: form.doubles_pairing_random ? 'pick_random' : 'pre_agreed' }"
            :disabled="saving"
            id-prefix="create-reg"
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
          </div>
        </div>
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
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  transition: background 0.2s;
}

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
  .wizard__head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }
  .wizard__brand { min-width: 0; flex-wrap: wrap; gap: 8px; }
  .wizard__head > .btn { min-height: 44px; }
  .wizard__progress-wrap { display: flex; grid-column: 1 / -1; grid-row: 2; width: 100%; justify-content: space-between; margin: 0; }
  .wizard__sport-pill { min-height: 44px; }
  .wizard__step-count { white-space: nowrap; }
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
