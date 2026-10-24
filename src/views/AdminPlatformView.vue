<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { SPORTS, sportFlagKey } from '../lib/sportConfig'
import { useFeatureFlagsStore } from '../stores/featureFlags'
import AppIcon from '../components/AppIcon.vue'
import PlatformFlagRow from '../components/admin/PlatformFlagRow.vue'
import { onTabKeydown } from '../lib/tabNavigation'
import SponsorshipRequestsPanel from '../components/admin/SponsorshipRequestsPanel.vue'
import { SPONSORSHIP_FLAG } from '../lib/sponsorshipRequests'
import { AI_FEATURES, AI_FLAG, aiFlagKey } from '../lib/aiFeatures'
import { supabase } from '../lib/supabase'

const { t, locale } = useI18n()
const flags = useFeatureFlagsStore()

const loading = ref(true)
const loadError = ref('')
const saveError = ref('')
const pending = ref(new Set())

const flagRow = (key) => {
  const row = flags.flags[key]
  return { key, enabled: Boolean(row?.enabled), updatedAt: row?.updated_at ?? null, missing: !row }
}

// Sponsorship: the platform switch for the whole feature; the requests list sits under it.
const sponsorshipRow = computed(() => flagRow(SPONSORSHIP_FLAG))

// AI: the master switch and one switch per feature; a feature works only while both are on.
const aiMasterRow = computed(() => flagRow(AI_FLAG))
const aiFeatureRows = computed(() => AI_FEATURES.map((name) => ({ name, ...flagRow(aiFlagKey(name)) })))
const aiWorkingCount = computed(() => (aiMasterRow.value.enabled ? aiFeatureRows.value.filter((r) => r.enabled).length : 0))
const isAiKey = (key) => key === AI_FLAG || key.startsWith(`${AI_FLAG}.`)

// Every sport known to the frontend registry, whether or not the DB has a row yet.
const sportRows = computed(() => SPORTS.map((sport) => ({ sport, ...flagRow(sportFlagKey(sport)) })))
const enabledSportCount = computed(() => sportRows.value.filter((r) => r.enabled).length)

// Flags no section knows about (anything the platform may gate later).
const otherRows = computed(() => Object.values(flags.flags)
  .filter((row) => !row.key.startsWith('sport.') && !isAiKey(row.key) && row.key !== SPONSORSHIP_FLAG)
  .sort((a, b) => a.key.localeCompare(b.key)))

// One tab per area; "other" appears only when such flags exist. Old #features links open sports.
const TAB_ALIASES = { features: 'sports' }
const tabs = computed(() => ['sponsorship', 'ai', 'sports', ...(otherRows.value.length ? ['other'] : [])])
const readHashTab = () => {
  const hash = window.location.hash.replace('#', '')
  const tab = TAB_ALIASES[hash] ?? hash
  return ['sponsorship', 'ai', 'sports', 'other'].includes(tab) ? tab : 'sponsorship'
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
// A linked "other" tab without such flags falls back to the first tab once flags are known.
watch([loading, tabs], () => {
  if (!loading.value && !tabs.value.includes(activeTab.value)) setTab('sponsorship')
})

const tabCount = (tab) => {
  if (tab === 'ai') return `${aiWorkingCount.value}/${aiFeatureRows.value.length}`
  if (tab === 'sports') return `${enabledSportCount.value}/${sportRows.value.length}`
  return ''
}

// AI usage over the last days (ai_usage_summary, platform admin only); loaded with the AI tab.
const USAGE_DAYS = 7
const aiUsage = ref(null)
const aiUsageError = ref('')
const aiUsageLoading = ref(false)
// Voice rows count seconds of audio (tokens_in), not tokens: they stay out of the token total.
const aiUsageTotal = computed(() => (aiUsage.value?.tasks ?? []).reduce((sum, row) => ({
  calls: sum.calls + row.calls,
  failed: sum.failed + row.failed,
  tokens_in: sum.tokens_in + (row.task === 'voice' ? 0 : row.tokens_in),
  tokens_out: sum.tokens_out + (row.task === 'voice' ? 0 : row.tokens_out),
}), { calls: 0, failed: 0, tokens_in: 0, tokens_out: 0 }))

async function loadAiUsage() {
  if (aiUsageLoading.value) return
  aiUsageLoading.value = true
  aiUsageError.value = ''
  const { data, error } = await supabase.rpc('ai_usage_summary', { p_days: USAGE_DAYS })
  if (error) aiUsageError.value = t('ai.platform.usage.loadError')
  else aiUsage.value = data
  aiUsageLoading.value = false
}
watch(activeTab, (tab) => { if (tab === 'ai' && !aiUsage.value) loadAiUsage() }, { immediate: true })

function formatNumber(value) {
  return new Intl.NumberFormat(locale.value).format(value ?? 0)
}

function isPending(key) {
  return pending.value.has(key)
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
        v-for="tab in tabs"
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
        <span v-else-if="tabCount(tab) && !loading" class="tab__count">{{ tabCount(tab) }}</span>
      </button>
    </div>

    <!-- Sponsorship: the feature switch, then the requests to decide. -->
    <div
      v-show="activeTab === 'sponsorship'"
      id="platform-panel-sponsorship"
      role="tabpanel"
      aria-labelledby="platform-tab-sponsorship"
      class="stack"
    >
      <section class="card stack stack--sm">
        <p class="muted platform-hint">{{ t('admin.platformFeaturesHint') }}</p>
        <ul class="flag-list" :aria-busy="loading">
          <PlatformFlagRow
            :flag-key="sponsorshipRow.key"
            icon="trophy"
            :title="t('admin.platformFeature.sponsorship.title')"
            :hint="t('admin.platformFeature.sponsorship.hint')"
            :enabled="sponsorshipRow.enabled"
            :updated-at="sponsorshipRow.updatedAt"
            :missing="sponsorshipRow.missing"
            :busy="isPending(sponsorshipRow.key)"
            :disabled="loading"
            @toggle="toggle(sponsorshipRow.key, $event)"
          />
        </ul>
      </section>
      <SponsorshipRequestsPanel @pending-count="pendingRequests = $event" />
    </div>

    <!-- AI: master switch, the features under it, usage. -->
    <div
      v-show="activeTab === 'ai'"
      id="platform-panel-ai"
      role="tabpanel"
      aria-labelledby="platform-tab-ai"
      class="stack"
    >
      <section class="card stack stack--sm">
        <p class="muted platform-hint">{{ t('ai.platform.hint') }}</p>
        <ul class="flag-list" :aria-busy="loading">
          <PlatformFlagRow
            :flag-key="aiMasterRow.key"
            icon="sparkles"
            :title="t('ai.platform.master.title')"
            :hint="t('ai.platform.master.hint')"
            :enabled="aiMasterRow.enabled"
            :updated-at="aiMasterRow.updatedAt"
            :missing="aiMasterRow.missing"
            :busy="isPending(aiMasterRow.key)"
            :disabled="loading"
            @toggle="toggle(aiMasterRow.key, $event)"
          />
        </ul>
      </section>

      <section class="card stack stack--sm">
        <div class="platform-section__head">
          <h2 class="section-title">{{ t('ai.platform.featuresTitle') }}</h2>
          <span class="badge badge--neutral">{{ t('admin.platformEnabledCount', { n: aiWorkingCount, total: aiFeatureRows.length }) }}</span>
        </div>
        <p v-if="!loading && !aiMasterRow.enabled" class="alert alert--warning" role="status">{{ t('ai.platform.allOff') }}</p>
        <ul class="flag-list" :aria-busy="loading">
          <PlatformFlagRow
            v-for="row in aiFeatureRows"
            :key="row.key"
            :flag-key="row.key"
            :title="t(`ai.platform.features.${row.name}.title`)"
            :hint="t(`ai.platform.features.${row.name}.hint`)"
            :enabled="row.enabled"
            :updated-at="row.updatedAt"
            :missing="row.missing"
            :note="row.enabled && !aiMasterRow.enabled ? t('ai.platform.masterOff') : ''"
            :muted="!aiMasterRow.enabled"
            :busy="isPending(row.key)"
            :disabled="loading"
            @toggle="toggle(row.key, $event)"
          />
        </ul>
      </section>

      <section class="card stack stack--sm" :aria-busy="aiUsageLoading">
        <div class="platform-section__head">
          <h2 class="section-title">{{ t('ai.platform.usage.title', { days: USAGE_DAYS }) }}</h2>
          <button type="button" class="btn btn--ghost btn--sm" :disabled="aiUsageLoading" @click="loadAiUsage">
            {{ t('ai.platform.usage.refresh') }}
          </button>
        </div>
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
                <td v-if="row.task === 'voice'">{{ t('ai.platform.usage.seconds', { n: formatNumber(row.tokens_in) }) }}</td>
                <td v-else>{{ formatNumber(row.tokens_in) }} / {{ formatNumber(row.tokens_out) }}</td>
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
      </section>
    </div>

    <!-- Sports available in the create wizard. -->
    <div
      v-show="activeTab === 'sports'"
      id="platform-panel-sports"
      role="tabpanel"
      aria-labelledby="platform-tab-sports"
      class="stack"
    >
      <section class="card stack stack--sm">
        <div class="platform-section__head">
          <h2 class="section-title">{{ t('admin.platformSports') }}</h2>
          <span class="badge badge--neutral">{{ t('admin.platformEnabledCount', { n: enabledSportCount, total: sportRows.length }) }}</span>
        </div>
        <p class="muted platform-hint">{{ t('admin.platformSportsHint') }}</p>
        <p v-if="!loading && enabledSportCount === 0" class="alert alert--warning" role="status">{{ t('admin.platformNoSportsWarning') }}</p>
        <ul class="flag-list" :aria-busy="loading">
          <PlatformFlagRow
            v-for="row in sportRows"
            :key="row.key"
            :flag-key="row.key"
            :icon="row.sport"
            :title="t('sport.' + row.sport)"
            :aria-label="t('admin.platformToggleSport', { sport: t('sport.' + row.sport) })"
            :enabled="row.enabled"
            :updated-at="row.updatedAt"
            :missing="row.missing"
            :busy="isPending(row.key)"
            :disabled="loading"
            @toggle="toggle(row.key, $event)"
          />
        </ul>
      </section>
    </div>

    <!-- Flags no section knows about. -->
    <div
      v-if="otherRows.length"
      v-show="activeTab === 'other'"
      id="platform-panel-other"
      role="tabpanel"
      aria-labelledby="platform-tab-other"
      class="stack"
    >
      <section class="card stack stack--sm">
        <h2 class="section-title">{{ t('admin.platformOtherFlags') }}</h2>
        <ul class="flag-list">
          <PlatformFlagRow
            v-for="row in otherRows"
            :key="row.key"
            :flag-key="row.key"
            :title="row.key"
            :hint="row.description || ''"
            :enabled="row.enabled"
            :updated-at="row.updated_at"
            :busy="isPending(row.key)"
            @toggle="toggle(row.key, $event)"
          />
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
  flex-wrap: wrap;
  gap: var(--space-2, 8px);
}
.platform-section__head .section-title {
  margin: 0;
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
/* Neutral "on / total" next to a tab name; the warning badge stays for requests to decide. */
.tab__count {
  margin-left: var(--space-2, 8px);
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: var(--surface-row, var(--bg));
  border: 1px solid var(--border);
}
.tab--active .tab__count {
  color: var(--primary);
  border-color: currentColor;
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
