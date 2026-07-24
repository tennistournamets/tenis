<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/auth'
import { getSportConfig, resolveCategory } from '../lib/sportConfig'
import SportPicker from '../components/SportPicker.vue'
import FormatPicker from '../components/FormatPicker.vue'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const saving = ref(false)
const errorText = ref('')
const step = ref(1) // 1 = sport, 2 = format, 3 = details

const form = reactive({
  name: '',
  slug: '',
  description: '',
  sport: 'tennis',
  format: 'single_elimination',
  category: 'singles',
  set_format: 'best_of_3',
  is_public: true,
  doubles_pairing_random: false,
})

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

function slugify(value) {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  if (normalized) {
    return normalized
  }

  return `tournament-${Date.now()}`
}

async function createTournament() {
  if (!auth.user) {
    return
  }

  saving.value = true
  errorText.value = ''

  const slug = slugify(form.slug || form.name)
  const category = effectiveCategory.value

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
    p_scoring_config: {},
  })

  saving.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  if (newId) {
    await router.replace({ name: 'admin-tournament', params: { id: newId } })
  } else {
    await router.replace({ name: 'admin-tournaments' })
  }
}

function cancel() {
  router.push({ name: 'admin-tournaments' })
}

onMounted(async () => {
  await auth.init()
})
</script>

<template>
  <div class="wizard">
    <!-- Wizard chrome header -->
    <header class="wizard__head">
      <div class="wizard__brand">
        <span class="wizard__title">{{ t('admin.wizardTitle') }}</span>
        <button v-if="step > 1" type="button" class="wizard__sport-pill" @click="step = 1">
          <span>{{ SPORT_ICONS[form.sport] }}</span>
          {{ t('sport.' + form.sport) }}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
      </div>
      <div class="wizard__progress-wrap">
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
        <h1 class="wizard__heading">{{ t('admin.stepSport') }}</h1>
        <p class="muted">{{ t('admin.wizardSportHint') }}</p>
      </div>
      <SportPicker v-model="form.sport" />
    </div>

    <!-- Step 2: format -->
    <div v-else-if="step === 2" class="wizard__body">
      <div class="wizard__lead">
        <h1 class="wizard__heading">{{ t('admin.stepFormat') }}</h1>
        <p class="muted">{{ t('admin.wizardFormatHint') }}</p>
      </div>
      <FormatPicker v-model="form.format" :sport="form.sport" />
    </div>

    <!-- Step 3: details + live preview -->
    <div v-else class="wizard__body wizard__body--split">
      <form id="wizard-form" class="wizard__form" @submit.prevent="createTournament">
        <div class="wizard__lead">
          <h1 class="wizard__heading">{{ t('admin.stepDetails') }}</h1>
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
            <input id="create-slug" v-model="form.slug" class="input" type="text" placeholder="summer-cup-2026" />
            <p class="wizard__field-hint">{{ t('admin.slugHint') }}</p>
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
          </div>

          <label v-if="effectiveCategory === 'doubles' && cfg.supportsDoublesPairing" class="wizard__toggle">
            <input v-model="form.doubles_pairing_random" type="checkbox" />
            <span class="wizard__toggle-body">
              <span class="wizard__toggle-title">{{ t('admin.pickRandomPairs') }}</span>
            </span>
          </label>
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
        </section>

        <p v-if="errorText" class="error-text">{{ errorText }}</p>
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
  background: #101512;
  color: #F2F5F1;
  border: 1px solid transparent;
  box-shadow: var(--shadow-lg);
}

:root[data-theme='dark'] .wizard__preview-card {
  background: var(--surface-raised);
  border-color: var(--border-strong);
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
  background: rgba(255, 255, 255, 0.08);
}

.wizard__preview-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--lime);
  background: rgba(198, 242, 78, 0.14);
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
  color: #96A39A;
  margin: 0;
}

.wizard__preview-desc {
  margin: var(--space-3) 0 0;
  font-size: 0.9rem;
  line-height: 1.6;
  color: #C7CCC6;
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
  .wizard__progress-wrap { display: none; }
}
</style>
