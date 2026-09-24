<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { SPORTS, sportFlagKey } from '../lib/sportConfig'
import { useFeatureFlagsStore } from '../stores/featureFlags'
import AppIcon from '../components/AppIcon.vue'

const { t, locale } = useI18n()
const flags = useFeatureFlagsStore()

const loading = ref(true)
const loadError = ref('')
const saveError = ref('')
const pending = ref(new Set())


// Every sport known to the frontend registry, whether or not the DB has a row yet.
const sportRows = computed(() => SPORTS.map((sport) => {
  const key = sportFlagKey(sport)
  const row = flags.flags[key]
  return {
    sport,
    key,
    enabled: Boolean(row?.enabled),
    updatedAt: row?.updated_at ?? null,
    missing: !row,
  }
}))

// Non-sport flags (anything else the platform may gate later).
const otherRows = computed(() => Object.values(flags.flags)
  .filter((row) => !row.key.startsWith('sport.'))
  .sort((a, b) => a.key.localeCompare(b.key)))

const enabledSportCount = computed(() => sportRows.value.filter((r) => r.enabled).length)

function isPending(key) {
  return pending.value.has(key)
}

function formatDate(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return ''
  }
}

async function toggle(key, enabled) {
  if (isPending(key)) return
  saveError.value = ''
  pending.value = new Set([...pending.value, key])
  try {
    await flags.setFlag(key, enabled)
  } catch {
    saveError.value = t('admin.platformSaveError')
  } finally {
    const next = new Set(pending.value)
    next.delete(key)
    pending.value = next
  }
}

onMounted(async () => {
  try {
    await flags.load({ force: true })
  } catch {
    loadError.value = t('sync.loadFailed')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="stack" style="max-width: 720px">
    <div>
      <RouterLink class="admin-back-link" :to="{ name: 'admin-tournaments' }">
      {{ t('admin.backToList') }}
    </RouterLink>
    <h1 class="page-title">{{ t('admin.platformTitle') }}</h1>
      <p class="muted">{{ t('admin.platformIntro') }}</p>
    </div>

    <div v-if="loadError" class="alert alert--error" role="alert">{{ loadError }}</div>
    <div v-if="saveError" class="alert alert--error" role="alert">{{ saveError }}</div>

    <section class="card stack stack--sm">
      <div class="platform-section__head">
        <h2 class="section-title">{{ t('admin.platformSports') }}</h2>
        <span class="badge badge--neutral">{{ t('admin.platformEnabledCount', { n: enabledSportCount, total: sportRows.length }) }}</span>
      </div>
      <p class="muted platform-hint">{{ t('admin.platformSportsHint') }}</p>
      <p v-if="!loading && enabledSportCount === 0" class="alert alert--warn" role="status">{{ t('admin.platformNoSportsWarning') }}</p>

      <ul class="flag-list" :aria-busy="loading">
        <li v-for="row in sportRows" :key="row.key" class="flag-row">
          <span class="flag-row__icon" aria-hidden="true"><AppIcon :name="row.sport" :size="22" /></span>
          <div class="flag-row__text">
            <span class="flag-row__name">{{ t('sport.' + row.sport) }}</span>
            <span class="flag-row__meta">
              <code>{{ row.key }}</code>
              <template v-if="row.updatedAt"> · {{ t('admin.platformUpdated', { date: formatDate(row.updatedAt) }) }}</template>
              <template v-else-if="row.missing"> · {{ t('admin.platformNoRow') }}</template>
            </span>
          </div>
          <label class="switch" :class="{ 'switch--busy': isPending(row.key) }">
            <input
              type="checkbox"
              :checked="row.enabled"
              :disabled="loading || isPending(row.key)"
              :aria-label="t('admin.platformToggleSport', { sport: t('sport.' + row.sport) })"
              @change="toggle(row.key, $event.target.checked)"
            />
            <span class="switch__track"><span class="switch__thumb"></span></span>
            <span class="switch__label">{{ row.enabled ? t('admin.platformOn') : t('admin.platformOff') }}</span>
          </label>
        </li>
      </ul>
    </section>

    <section v-if="otherRows.length" class="card stack stack--sm">
      <h2 class="section-title">{{ t('admin.platformOtherFlags') }}</h2>
      <ul class="flag-list">
        <li v-for="row in otherRows" :key="row.key" class="flag-row">
          <div class="flag-row__text">
            <span class="flag-row__name"><code>{{ row.key }}</code></span>
            <span v-if="row.description" class="flag-row__meta">{{ row.description }}</span>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              :checked="row.enabled"
              :disabled="isPending(row.key)"
              :aria-label="row.key"
              @change="toggle(row.key, $event.target.checked)"
            />
            <span class="switch__track"><span class="switch__thumb"></span></span>
            <span class="switch__label">{{ row.enabled ? t('admin.platformOn') : t('admin.platformOff') }}</span>
          </label>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.platform-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
}
.platform-hint {
  margin: 0;
  font-size: var(--font-sm, 0.9rem);
}
.flag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.flag-row {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.flag-row:first-child {
  border-top: none;
}
.flag-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  flex: none;
  color: var(--primary);
  background: var(--primary-soft);
}
.flag-row__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.flag-row__name {
  font-weight: 600;
}
.flag-row__meta {
  font-size: 0.75rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.flag-row__meta code,
.flag-row__name code {
  font-size: 0.75rem;
}
.switch--busy {
  opacity: 0.6;
}
</style>
