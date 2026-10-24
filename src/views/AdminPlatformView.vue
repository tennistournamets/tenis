<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { SPORTS, sportFlagKey } from '../lib/sportConfig'
import { useFeatureFlagsStore } from '../stores/featureFlags'
import AppIcon from '../components/AppIcon.vue'
import { onTabKeydown } from '../lib/tabNavigation'
import SponsorshipRequestsPanel from '../components/admin/SponsorshipRequestsPanel.vue'
import { SPONSORSHIP_FLAG } from '../lib/sponsorshipRequests'
import { AI_FEATURES, AI_FLAG, aiFlagKey } from '../lib/aiFeatures'
import { supabase } from '../lib/supabase'

const { t, locale } = useI18n()
const flags = useFeatureFlagsStore()

const loading = ref(true)

// Tabs: sponsorship requests (the daily work) and platform feature flags.
const TABS = ['sponsorship', 'features']
const readHashTab = () => {
  const hash = window.location.hash.replace('#', '')
  return TABS.includes(hash) ? hash : TABS[0]
}
const activeTab = ref(readHashTab())
const pendingRequests = ref(0)
const syncTabFromHash = () => { activeTab.value = readHashTab() }
window.addEventListener('hashchange', syncTabFromHash)
onBeforeUnmount(() => window.removeEventListener('hashchange', syncTabFromHash))
function setTab(tab) {
  activeTab.value = tab
  const url = `${window.location.pathname}${window.location.search}#${tab}`
  history.replaceState({ ...(history.state || {}), current: url }, '', url)
}
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

// Platform features with their own switch (row may not exist yet = off).
const FEATURES = [{ key: SPONSORSHIP_FLAG, name: 'sponsorship' }]
const featureRows = computed(() => FEATURES.map((feature) => {
  const row = flags.flags[feature.key]
  return { ...feature, enabled: Boolean(row?.enabled), updatedAt: row?.updated_at ?? null, missing: !row }
}))

// AI: the master switch and one switch per feature; a feature works only while both are on.
const flagRow = (key) => {
  const row = flags.flags[key]
  return { key, enabled: Boolean(row?.enabled), updatedAt: row?.updated_at ?? null, missing: !row }
}
const aiMasterRow = computed(() => flagRow(AI_FLAG))
const aiFeatureRows = computed(() => AI_FEATURES.map((name) => ({ name, ...flagRow(aiFlagKey(name)) })))
const aiWorkingCount = computed(() => (aiMasterRow.value.enabled ? aiFeatureRows.value.filter((r) => r.enabled).length : 0))
const isAiKey = (key) => key === AI_FLAG || key.startsWith(`${AI_FLAG}.`)

// Non-sport flags (anything else the platform may gate later).
const otherRows = computed(() => Object.values(flags.flags)
  .filter((row) => !row.key.startsWith('sport.') && !isAiKey(row.key) && !FEATURES.some((f) => f.key === row.key))
  .sort((a, b) => a.key.localeCompare(b.key)))

// AI usage over the last days (ai_usage_summary, platform admin only).
const USAGE_DAYS = 7
const aiUsage = ref(null)
const aiUsageError = ref('')
const aiUsageTotal = computed(() => (aiUsage.value?.tasks ?? []).reduce((sum, row) => ({
  calls: sum.calls + row.calls,
  failed: sum.failed + row.failed,
  tokens_in: sum.tokens_in + row.tokens_in,
  tokens_out: sum.tokens_out + row.tokens_out,
}), { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0 }))

async function loadAiUsage() {
  aiUsageError.value = ''
  const { data, error } = await supabase.rpc('ai_usage_summary', { p_days: USAGE_DAYS })
  if (error) aiUsageError.value = t('ai.platform.usage.loadError')
  else aiUsage.value = data
}

function formatNumber(value) {
  return new Intl.NumberFormat(locale.value).format(value ?? 0)
}

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
  loadAiUsage()
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
  <div class="stack" style="max-width: 960px">
    <div>
      <RouterLink class="admin-back-link" :to="{ name: 'admin-tournaments' }">
      {{ t('admin.backToList') }}
    </RouterLink>
    <h1 class="page-title">{{ t('admin.platformTitle') }}</h1>
      <p class="muted">{{ t('admin.platformIntro') }}</p>
    </div>

    <div v-if="loadError" class="alert alert--error" role="alert">{{ loadError }}</div>
    <div v-if="saveError" class="alert alert--error" role="alert">{{ saveError }}</div>

    <div class="tab-group" role="tablist" :aria-label="t('admin.platformTitle')" @keydown="onTabKeydown">
      <button
        v-for="tab in TABS"
        :id="`platform-tab-${tab}`"
        :key="tab"
        type="button"
        role="tab"
        class="tab"
        :class="{ 'tab--active': activeTab === tab }"
        :aria-selected="activeTab === tab"
        :aria-controls="`platform-panel-${tab}`"
        :tabindex="activeTab === tab ? 0 : -1"
        @click="setTab(tab)"
      >
        {{ t(`admin.platformTabs.${tab}`) }}
        <span v-if="tab === 'sponsorship' && pendingRequests" class="tab__badge">{{ pendingRequests }}</span>
      </button>
    </div>

    <div
      v-show="activeTab === 'sponsorship'"
      id="platform-panel-sponsorship"
      role="tabpanel"
      aria-labelledby="platform-tab-sponsorship"
    >
      <SponsorshipRequestsPanel @pending-count="pendingRequests = $event" />
    </div>

    <div
      v-show="activeTab === 'features'"
      id="platform-panel-features"
      role="tabpanel"
      aria-labelledby="platform-tab-features"
      class="stack"
    >
    <section class="card stack stack--sm">
      <div class="platform-section__head">
        <h2 class="section-title">{{ t('admin.platformFeatures') }}</h2>
      </div>
      <p class="muted platform-hint">{{ t('admin.platformFeaturesHint') }}</p>
      <ul class="flag-list" :aria-busy="loading">
        <li v-for="row in featureRows" :key="row.key" class="flag-row">
          <span class="flag-row__icon" aria-hidden="true"><AppIcon name="trophy" :size="22" /></span>
          <div class="flag-row__text">
            <span class="flag-row__name">{{ t(`admin.platformFeature.${row.name}.title`) }}</span>
            <span class="flag-row__meta">{{ t(`admin.platformFeature.${row.name}.hint`) }}</span>
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
              :aria-label="t(`admin.platformFeature.${row.name}.title`)"
              @change="toggle(row.key, $event.target.checked)"
            />
            <span class="switch__track"><span class="switch__thumb"></span></span>
            <span class="switch__label">{{ row.enabled ? t('admin.platformOn') : t('admin.platformOff') }}</span>
          </label>
        </li>
      </ul>
    </section>

    <section class="card stack stack--sm">
      <div class="platform-section__head">
        <h2 class="section-title">{{ t('ai.platform.title') }}</h2>
        <span class="badge badge--neutral">{{ t('admin.platformEnabledCount', { n: aiWorkingCount, total: aiFeatureRows.length }) }}</span>
      </div>
      <p class="muted platform-hint">{{ t('ai.platform.hint') }}</p>
      <ul class="flag-list" :aria-busy="loading">
        <li class="flag-row">
          <span class="flag-row__icon" aria-hidden="true"><AppIcon name="sparkles" :size="22" /></span>
          <div class="flag-row__text">
            <span class="flag-row__name">{{ t('ai.platform.master.title') }}</span>
            <span class="flag-row__meta">{{ t('ai.platform.master.hint') }}</span>
            <span class="flag-row__meta">
              <code>{{ aiMasterRow.key }}</code>
              <template v-if="aiMasterRow.updatedAt"> · {{ t('admin.platformUpdated', { date: formatDate(aiMasterRow.updatedAt) }) }}</template>
              <template v-else-if="aiMasterRow.missing"> · {{ t('admin.platformNoRow') }}</template>
            </span>
          </div>
          <label class="switch" :class="{ 'switch--busy': isPending(aiMasterRow.key) }">
            <input
              type="checkbox"
              :checked="aiMasterRow.enabled"
              :disabled="loading || isPending(aiMasterRow.key)"
              :aria-label="t('ai.platform.master.title')"
              @change="toggle(aiMasterRow.key, $event.target.checked)"
            />
            <span class="switch__track"><span class="switch__thumb"></span></span>
            <span class="switch__label">{{ aiMasterRow.enabled ? t('admin.platformOn') : t('admin.platformOff') }}</span>
          </label>
        </li>
        <li
          v-for="row in aiFeatureRows"
          :key="row.key"
          class="flag-row flag-row--nested"
          :class="{ 'flag-row--held': row.enabled && !aiMasterRow.enabled }"
        >
          <div class="flag-row__text">
            <span class="flag-row__name">{{ t(`ai.platform.features.${row.name}.title`) }}</span>
            <span class="flag-row__meta">{{ t(`ai.platform.features.${row.name}.hint`) }}</span>
            <span class="flag-row__meta">
              <code>{{ row.key }}</code>
              <template v-if="row.enabled && !aiMasterRow.enabled"> · {{ t('ai.platform.masterOff') }}</template>
              <template v-else-if="row.updatedAt"> · {{ t('admin.platformUpdated', { date: formatDate(row.updatedAt) }) }}</template>
              <template v-else-if="row.missing"> · {{ t('admin.platformNoRow') }}</template>
            </span>
          </div>
          <label class="switch" :class="{ 'switch--busy': isPending(row.key) }">
            <input
              type="checkbox"
              :checked="row.enabled"
              :disabled="loading || isPending(row.key)"
              :aria-label="t(`ai.platform.features.${row.name}.title`)"
              @change="toggle(row.key, $event.target.checked)"
            />
            <span class="switch__track"><span class="switch__thumb"></span></span>
            <span class="switch__label">{{ row.enabled ? t('admin.platformOn') : t('admin.platformOff') }}</span>
          </label>
        </li>
      </ul>

      <div class="ai-usage stack stack--sm">
        <h3 class="ai-usage__title">{{ t('ai.platform.usage.title', { days: USAGE_DAYS }) }}</h3>
        <p v-if="aiUsageError" class="alert alert--error" role="alert">{{ aiUsageError }}</p>
        <p v-else-if="aiUsage && !aiUsage.tasks.length" class="muted platform-hint">{{ t('ai.platform.usage.empty') }}</p>
        <div v-else-if="aiUsage" class="ai-usage__scroll">
          <table class="ai-usage__table">
            <thead>
              <tr>
                <th scope="col">{{ t('ai.platform.usage.feature') }}</th>
                <th scope="col">{{ t('ai.platform.usage.calls') }}</th>
                <th scope="col">{{ t('ai.platform.usage.failed') }}</th>
                <th scope="col">{{ t('ai.platform.usage.users') }}</th>
                <th scope="col">{{ t('ai.platform.usage.tokens') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in aiUsage.tasks" :key="row.task">
                <th scope="row">{{ t(`ai.platform.features.${row.task}.title`) }}</th>
                <td>{{ formatNumber(row.calls) }}</td>
                <td>{{ formatNumber(row.failed) }}</td>
                <td>{{ formatNumber(row.users) }}</td>
                <td>{{ formatNumber(row.tokens_in) }} / {{ formatNumber(row.tokens_out) }}</td>
              </tr>
            </tbody>
            <tfoot v-if="aiUsage.tasks.length > 1">
              <tr>
                <th scope="row">{{ t('ai.platform.usage.total') }}</th>
                <td>{{ formatNumber(aiUsageTotal.calls) }}</td>
                <td>{{ formatNumber(aiUsageTotal.failed) }}</td>
                <td></td>
                <td>{{ formatNumber(aiUsageTotal.tokens_in) }} / {{ formatNumber(aiUsageTotal.tokens_out) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>

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
/* AI feature switches sit under the master switch, aligned with its text. */
.flag-row--nested {
  padding-left: calc(36px + var(--space-3, 12px));
}
.flag-row--held .flag-row__name {
  color: var(--muted);
}
.ai-usage {
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.ai-usage__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}
.ai-usage__scroll {
  overflow-x: auto;
}
.ai-usage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}
.ai-usage__table th,
.ai-usage__table td {
  padding: 6px 8px;
  text-align: right;
  white-space: nowrap;
  border-top: 1px solid var(--border);
}
.ai-usage__table th:first-child {
  text-align: left;
  font-weight: 500;
}
.ai-usage__table thead th {
  border-top: none;
  color: var(--muted);
  font-weight: 500;
  font-size: 0.75rem;
}
.ai-usage__table tfoot th,
.ai-usage__table tfoot td {
  font-weight: 600;
}
</style>
