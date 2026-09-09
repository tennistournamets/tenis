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
import { getSportConfig, resolveCategory } from '../lib/sportConfig'
import SportPicker from '../components/SportPicker.vue'
import FormatPicker from '../components/FormatPicker.vue'
import TennisRulesSettings from '../components/TennisRulesSettings.vue'
import { DEFAULT_TENNIS_RULES, tennisRulesSummary } from '../lib/tennisRules'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const saving = ref(false)
const errorText = ref('')
const stepHeading = ref(null)
const wizardRoot = ref(null)
const slugInput = ref(null)
const formError = ref(null)
const slugError = ref('')
const fallbackSlug = `tournament-${crypto.randomUUID().slice(0, 8)}`
const step = ref(1) // 1 = sport, 2 = format, 3 = details
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
  generate_qr: false,
  doubles_pairing_random: false,
})

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

const SPORT_ICONS = { tennis: '🎾', padel: '🏸', football: '⚽' }

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
  if (form.slug.trim() && !normalizeTournamentSlug(form.slug)) {
    slugError.value = t('mobile.invalidSlug')
    await showCreateError(slugInput)
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
    clearWizardDraft()
    unregisterDraft()
    const query = form.is_public && form.generate_qr ? { qr: '1' } : undefined
    await router.replace({ name: 'admin-tournament', params: { id: newId }, query })
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
  await auth.init()
  draftKey.value = userDraftKey('create-tournament', auth.user?.id)
  const stored = readSessionDraft(draftKey.value)
  if (stored?.form && Number.isInteger(stored.step) && stored.step >= 1 && stored.step <= 3) {
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
    if (!['tennis', 'padel', 'football'].includes(form.sport)) form.sport = initialForm.sport
    if (!getSportConfig(form.sport).allowedFormats.includes(form.format)) form.format = initialForm.format
    if (!['singles', 'doubles'].includes(form.category)) form.category = initialForm.category
    if (!['best_of_3', 'best_of_5'].includes(form.set_format)) form.set_format = initialForm.set_format
    if (!['men', 'women'].includes(form.gender)) form.gender = initialForm.gender
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
          <span>{{ SPORT_ICONS[form.sport] }}</span>
          {{ t('sport.' + form.sport) }}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
      </div>
      <div class="wizard__progress-wrap" role="status" aria-live="polite">
        <div class="wizard__progress" aria-hidden="true">
          <span v-for="i in 3" :key="i" class="wizard__seg" :class="{ 'wizard__seg--on': step >= i }" />
        </div>
        <span class="wizard__step-count">{{ t('admin.wizardStepOf', { n: step, total: 3 }) }}</span>
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

    <!-- Step 3: details + live preview -->
    <div v-else class="wizard__body wizard__body--split">
      <form id="wizard-form" class="wizard__form" @submit.prevent="createTournament">
        <fieldset :disabled="saving" style="display: contents">
        <div class="wizard__lead">
          <h1 ref="stepHeading" class="wizard__heading" tabindex="-1">{{ t('admin.stepDetails') }}</h1>
          <p class="muted">{{ t('admin.wizardPreviewHint') }}</p>
        </div>

        <section class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardBasics') }}</h2>

          <div class="form-field">
            <label for="create-name">{{ t('admin.name') }}</label>
            <input id="create-name" v-model="form.name" class="input" type="text" required />
          </div>

          <div class="form-field">
            <label for="create-desc">{{ t('admin.description') }}</label>
            <textarea id="create-desc" v-model="form.description" class="input" rows="2" />
          </div>

          <div class="form-field">
            <label for="create-slug">{{ t('admin.slug') }}</label>
            <input id="create-slug" ref="slugInput" v-model="form.slug" class="input" type="text" maxlength="80"
              autocapitalize="none" spellcheck="false" placeholder="summer-cup-2026"
              :aria-invalid="Boolean(slugError)" aria-describedby="create-slug-preview create-slug-error" />
            <p class="wizard__field-hint">{{ t('admin.slugHint') }}</p>
            <p id="create-slug-preview" class="wizard__link-preview"><span>{{ t('mobile.linkPreview') }}</span><br />{{ publicLink }}</p>
            <p v-if="slugError" id="create-slug-error" class="error-text" role="alert">{{ slugError }}</p>
          </div>
        </section>

        <section v-if="cfg.supportsCategory || cfg.supportsSetFormat" class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardRules') }}</h2>

          <div class="wizard__grid2">
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

          <TennisRulesSettings v-if="form.sport === 'tennis'" v-model="form.scoring_config" id-prefix="create-tennis" :disabled="saving" />

          <label v-if="effectiveCategory === 'doubles' && cfg.supportsDoublesPairing" class="wizard__toggle">
            <input v-model="form.doubles_pairing_random" type="checkbox" />
            <span class="wizard__toggle-body">
              <span class="wizard__toggle-title">{{ t('admin.pickRandomPairs') }}</span>
            </span>
          </label>
        </section>

        <section class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardContacts') }}</h2>

          <div class="wizard__grid2">
            <div class="form-field">
              <label for="create-phone">{{ t('admin.contactPhone') }}</label>
              <input id="create-phone" v-model="form.contact_phone" class="input" type="tel" placeholder="+370 600 00000" />
            </div>

            <div class="form-field">
              <label for="create-email">{{ t('admin.contactEmail') }}</label>
              <input id="create-email" v-model="form.contact_email" class="input" type="email" placeholder="info@example.com" />
            </div>
          </div>
        </section>

        <section class="wizard__group">
          <h2 class="wizard__eyebrow">{{ t('admin.wizardPublish') }}</h2>

          <label class="wizard__toggle">
            <input v-model="form.is_public" type="checkbox" />
            <span class="wizard__toggle-body">
              <span class="wizard__toggle-title">{{ t('admin.isPublic') }}</span>
              <span class="wizard__toggle-hint">{{ t('admin.isPublicHint') }}</span>
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

        <p v-if="errorText" ref="formError" class="error-text" role="alert" tabindex="-1">{{ errorText }}</p>
      </fieldset>
      </form>

      <aside class="wizard__preview" aria-hidden="true">
        <div class="wizard__preview-card">
          <div class="wizard__preview-top">
            <span class="wizard__preview-emoji">{{ SPORT_ICONS[form.sport] }}</span>
            <span v-if="form.is_public" class="wizard__preview-badge">{{ t('admin.wizardRegOpen') }}</span>
          </div>
          <h2 class="wizard__preview-name">{{ form.name || t('admin.wizardUntitled') }}</h2>
          <p class="wizard__preview-meta">{{ previewMeta }}</p>
          <p v-if="form.description" class="wizard__preview-desc">{{ form.description }}</p>
          <p v-if="form.sport === 'tennis'" class="wizard__preview-desc">{{ tennisRulesSummary(form.scoring_config, t) }}</p>
        </div>
      </aside>
    </div>

    <!-- Footer action bar -->
    <footer class="wizard__foot">
      <button
        v-if="step > 1"
        class="btn btn--outline"
        type="button"
        :disabled="saving"
        @click="step -= 1"
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
        {{ t('admin.create') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.wizard {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  max-width: 1060px;
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

.wizard__body--split {
  display: grid;
  grid-template-columns: minmax(0, 460px) minmax(0, 1fr);
  gap: var(--space-6);
  align-items: start;
}

.wizard__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.wizard__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
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

.wizard__preview {
  position: sticky;
  top: var(--space-5);
}

.wizard__preview-card {
  padding: var(--space-5);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
}

.wizard__preview-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.wizard__preview-emoji {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  border-radius: 10px;
  background: var(--surface-row);
  border: 1px solid var(--border);
}

.wizard__preview-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--success-text);
  background: var(--success-bg);
  border-radius: 999px;
}

.wizard__preview-name {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 1.6rem;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
}

.wizard__preview-meta {
  font-size: 0.9rem;
  color: var(--muted);
  margin: 0;
}

.wizard__preview-desc {
  margin: var(--space-3) 0 0;
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--text-muted);
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
  .wizard__body--split { grid-template-columns: 1fr; }
  .wizard__preview { position: static; }
  .wizard { padding: 16px; }
  .wizard__head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }
  .wizard__brand { min-width: 0; flex-wrap: wrap; gap: 8px; }
  .wizard__head > .btn { min-height: 44px; }
  .wizard__progress-wrap { display: flex; grid-column: 1 / -1; grid-row: 2; width: 100%; justify-content: space-between; margin: 0; }
  .wizard__sport-pill { min-height: 44px; }
  .wizard__step-count { white-space: nowrap; }
}
.wizard__link-preview { font-size: .8125rem; line-height: 1.6; overflow-wrap: anywhere; color: var(--muted); }
.wizard__link-preview span { font-weight: 600; }
#create-slug { scroll-margin-top: 96px; }
</style>
