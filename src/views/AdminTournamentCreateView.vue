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
  <div class="stack" style="max-width: 640px">
    <h1 class="page-title">{{ t('admin.createPageTitle') }}</h1>
    <p class="muted">{{ t('admin.createPageHint') }}</p>

    <!-- Step 1: sport -->
    <div v-if="step === 1" class="card stack stack--sm">
      <h2 class="section-title">{{ t('admin.stepSport') }}</h2>
      <SportPicker v-model="form.sport" />
      <div class="inline-actions" style="margin-top: var(--space-2)">
        <button class="btn btn--primary" type="button" @click="step = 2">
          {{ t('admin.next') }}
        </button>
        <button class="btn btn--ghost" type="button" @click="cancel">
          {{ t('actions.cancel') }}
        </button>
      </div>
    </div>

    <!-- Step 2: format -->
    <div v-else-if="step === 2" class="card stack stack--sm">
      <h2 class="section-title">{{ t('admin.stepFormat') }}</h2>
      <FormatPicker v-model="form.format" :sport="form.sport" />
      <div class="inline-actions" style="margin-top: var(--space-2)">
        <button class="btn btn--primary" type="button" @click="step = 3">
          {{ t('admin.next') }}
        </button>
        <button class="btn btn--ghost" type="button" @click="step = 1">
          {{ t('admin.back') }}
        </button>
      </div>
    </div>

    <!-- Step 3: details -->
    <form v-else class="card stack stack--sm" @submit.prevent="createTournament">
      <h2 class="section-title">{{ t('admin.stepDetails') }}</h2>

      <p class="muted" style="font-size: var(--font-sm)">
        {{ t('sport.' + form.sport) }} · {{ t('tournamentFormat.' + form.format) }}
      </p>

      <div class="form-field">
        <label for="create-name">{{ t('admin.name') }}</label>
        <input id="create-name" v-model="form.name" class="input" type="text" required />
      </div>

      <div class="form-field">
        <label for="create-slug">{{ t('admin.slug') }}</label>
        <input id="create-slug" v-model="form.slug" class="input" type="text" placeholder="summer-cup-2026" />
      </div>

      <div class="form-field">
        <label for="create-desc">{{ t('admin.description') }}</label>
        <textarea id="create-desc" v-model="form.description" class="input" rows="3" />
      </div>

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

      <label v-if="effectiveCategory === 'doubles' && cfg.supportsDoublesPairing" class="checkbox-row">
        <input v-model="form.doubles_pairing_random" type="checkbox" />
        {{ t('admin.pickRandomPairs') }}
      </label>

      <label class="checkbox-row">
        <input v-model="form.is_public" type="checkbox" />
        {{ t('admin.isPublic') }}
      </label>

      <div class="inline-actions" style="margin-top: var(--space-2)">
        <button class="btn btn--primary" type="submit" :disabled="saving">
          {{ t('admin.create') }}
        </button>
        <button class="btn btn--ghost" type="button" :disabled="saving" @click="step = 2">
          {{ t('admin.back') }}
        </button>
      </div>

      <p v-if="errorText" class="error-text">{{ errorText }}</p>
    </form>
  </div>
</template>
