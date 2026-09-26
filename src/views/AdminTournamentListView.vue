<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { supabase } from '../lib/supabase'
import CopyTournamentLink from '../components/CopyTournamentLink.vue'
import AppIcon from '../components/AppIcon.vue'
import { categoryLabelKey } from '../lib/sportConfig'
import { useAuthStore } from '../stores/auth'
import { displayStatus, statusBadgeClass } from '../lib/tournamentStatus'
import { errorMessage } from '../lib/errorMessages'

const { t, locale } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const loading = ref(false)
const loadError = ref('')

const tournaments = ref([])
const statusFilter = ref('active')

const hasManagerTournament = computed(() =>
  tournaments.value.some((item) => item.currentRole === 'owner' || item.currentRole === 'editor'),
)

const hasCounterOnlyTournaments = computed(() =>
  tournaments.value.length > 0 && tournaments.value.every((item) => item.currentRole === 'counter'),
)

const canCreateTournament = computed(
  () => !hasCounterOnlyTournaments.value,
)

const pageTitle = computed(() =>
  hasCounterOnlyTournaments.value ? t('admin.counterTournamentsListTitle') : t('admin.tournamentsListTitle'),
)

const pageHint = computed(() =>
  hasCounterOnlyTournaments.value ? t('admin.counterTournamentsListHint') : t('admin.tournamentsListHint'),
)

const filteredTournaments = computed(() => {
  if (hasCounterOnlyTournaments.value) return tournaments.value
  const list = tournaments.value
  if (statusFilter.value === 'all') {
    return list
  }
  if (statusFilter.value === 'completed') {
    return list.filter((t) => t.status === 'completed')
  }
  return list.filter((t) => t.status !== 'completed')
})

// Running tournaments first, then the ones that need the organizer's next step.
const STATUS_ORDER = { in_progress: 0, registration_closed: 1, registration_open: 2, draft: 3, completed: 4 }
// Per-tournament counts behind each card's next step. Best effort: without
// them the card falls back to the status-only hint.
const progress = ref({})
async function loadProgress(ids) {
  if (!ids.length) { progress.value = {}; return }
  try {
    const [entries, matchRows, live] = await Promise.all([
      supabase.from('entries').select('tournament_id,status').in('tournament_id', ids),
      supabase.from('matches').select('tournament_id').in('tournament_id', ids),
      supabase.from('live_scores').select('tournament_id,status').in('tournament_id', ids).eq('status', 'active'),
    ])
    const next = Object.fromEntries(ids.map(id => [id, { approved: 0, pending: 0, matches: 0, live: 0 }]))
    for (const e of entries.data || []) if (next[e.tournament_id] && (e.status === 'approved' || e.status === 'pending')) next[e.tournament_id][e.status] += 1
    for (const m of matchRows.data || []) if (next[m.tournament_id]) next[m.tournament_id].matches += 1
    for (const l of live.data || []) if (next[l.tournament_id]) next[l.tournament_id].live += 1
    progress.value = next
  } catch { progress.value = {} }
}

async function loadTournaments() {
  if (!auth.user) {
    tournaments.value = []
    return
  }

  loading.value = true
  loadError.value = ''

  try {
    const { data, error } = await supabase
      .from('tournament_admins')
      .select(
        `
        tournament_id,
        role,
        tournaments (
          id,
          name,
          slug,
          sport,
          format,
          category,
          status,
          set_format,
          doubles_pairing_mode,
          visibility,
          registration_deadline,
          created_at
        )
      `,
      )
      .eq('user_id', auth.user.id)

    if (error) {
      loadError.value = errorMessage(error, t, 'drafts.unavailable')
      tournaments.value = []
      return
    }

    const rows = data || []
    const list = rows
      .map((row) => row.tournaments ? { ...row.tournaments, currentRole: row.role } : null)
      .filter((t) => t != null)
    list.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || new Date(b.created_at) - new Date(a.created_at))
    tournaments.value = list
    await loadProgress(list.map(item => item.id))
  } catch (error) {
    loadError.value = errorMessage(error, t, 'drafts.unavailable')
    tournaments.value = []
  } finally {
    loading.value = false
  }
}

function tournamentTarget(item) {
  return {
    name: 'admin-tournament',
    params: { id: item.id },
    hash: item.currentRole === 'counter' ? '#bracket' : '',
  }
}

function formatDate(iso) {
  if (!iso) {
    return '—'
  }
  try {
    return new Date(iso).toLocaleDateString(locale.value, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

function hasPublicShareLink(status) {
  // The public page is live for every non-draft tournament —
  // spectators need the link most while matches are running.
  return status !== 'draft'
}


function itemSubtitle(item) {
  const parts = [t(`tournamentFormat.${item.format}`)]
  // Padel is always doubles: say so, like tennis says its category.
  const category = categoryLabelKey(item.sport, item.category)
  if (category) parts.push(t(category))
  return parts.join(' · ')
}

// The card's call to action follows the real state, like the checklist on the
// tournament page: pending entries, then closing registration, the draw, the start.
function nextStep(item) {
  if (item.currentRole === 'counter') return null
  const p = progress.value[item.id]
  switch (item.status) {
    case 'registration_open':
      if (!p) return { text: t('admin.listHintRegOpen'), tone: 'warn' }
      if (p.pending) return { text: t('admin.listHintPending', { n: p.pending }), tone: 'warn' }
      if (p.approved < 2) return { text: t('admin.listHintNeedEntries'), tone: 'warn' }
      return { text: t(p.matches ? 'admin.listHintCloseOnly' : 'admin.listHintCloseRegistration'), tone: 'warn' }
    case 'registration_closed':
      if (p && !p.matches) return { text: t('admin.listHintBuild'), tone: 'setup' }
      if (p) return { text: t('admin.listHintReadyToStart'), tone: 'setup' }
      return { text: t('admin.listHintSetup'), tone: 'setup' }
    case 'in_progress':
      return { text: p?.live ? t('admin.listHintLive', { n: p.live }) : t('admin.listHintInProgress'), tone: 'live' }
    case 'draft':
      return { text: t('admin.listHintSetup'), tone: 'setup' }
    default:
      return null
  }
}

function itemMeta(item) {
  const parts = [itemSubtitle(item)]
  const p = progress.value[item.id]
  if (p?.approved) parts.push(t('admin.listMetaEntries', { n: p.approved }))
  parts.push(t('admin.listMetaCreated', { date: formatDate(item.created_at) }))
  return parts.join(' · ')
}

watch(
  () => auth.user?.id,
  async (id) => {
    if (id) {
      await loadTournaments()
    } else {
      tournaments.value = []
    }
  },
)

onMounted(async () => {
  await auth.init()
  await loadTournaments()
})
</script>

<template>
  <div class="stack">
    <div class="admin-list-header">
      <h1 class="page-title">{{ pageTitle }}</h1>
      <div class="admin-list-header__actions">
        <!-- <button class="btn btn--ghost btn--sm" type="button" @click="loadTournaments">
          {{ t('actions.refresh') }}
        </button> -->
        <RouterLink v-if="canCreateTournament" class="btn btn--primary btn--sm" :to="{ name: 'admin-tournament-new' }">
          {{ t('admin.createTournament') }}
        </RouterLink>
      </div>
    </div>
    <p v-if="hasCounterOnlyTournaments" class="muted">{{ pageHint }}</p>

    <div v-if="!hasCounterOnlyTournaments" class="filter-segment" role="group" :aria-label="t('admin.filterLabel')">
      <button
        type="button"
        class="filter-segment__btn"
        :class="{ 'filter-segment__btn--active': statusFilter === 'active' }"
        :aria-pressed="statusFilter === 'active'"
        @click="statusFilter = 'active'"
      >
        {{ t('admin.filterActive') }}
      </button>
      <button
        type="button"
        class="filter-segment__btn"
        :class="{ 'filter-segment__btn--active': statusFilter === 'completed' }"
        :aria-pressed="statusFilter === 'completed'"
        @click="statusFilter = 'completed'"
      >
        {{ t('admin.filterCompleted') }}
      </button>
      <button
        type="button"
        class="filter-segment__btn"
        :class="{ 'filter-segment__btn--active': statusFilter === 'all' }"
        :aria-pressed="statusFilter === 'all'"
        @click="statusFilter = 'all'"
      >
        {{ t('admin.filterAll') }}
      </button>
    </div>

    <p v-if="loading" class="muted">{{ t('actions.loading') }}</p>
    <p v-if="loadError" class="error-text">{{ loadError }}</p>

    <div v-if="!loading && filteredTournaments.length" class="stack stack--sm">
      <article
        v-for="item in filteredTournaments"
        :key="item.id"
        class="t-card"
        tabindex="0"
        role="link"
        @click="router.push(tournamentTarget(item))"
        @keydown.enter="router.push(tournamentTarget(item))"
      >
        <div class="t-card__main">
          <span class="t-card__icon"><AppIcon :name="item.sport" :size="22" /></span>
          <div class="t-card__info">
            <div class="t-card__title-row">
              <h2 class="t-card__title">{{ item.name }}</h2>
              <span class="badge" :class="statusBadgeClass(displayStatus(item))">
                {{ t(`tournament.${displayStatus(item)}`) }}
              </span>
              <span v-if="item.currentRole && item.currentRole !== 'owner'" class="badge badge--neutral">{{ t(`admin.${item.currentRole}`) }}</span>
              <span v-if="item.visibility && item.visibility !== 'link'" class="badge badge--neutral">{{ t(`access.visibility.${item.visibility}`) }}</span>
            </div>
            <p class="t-card__meta">{{ itemMeta(item) }}</p>
          </div>
          <CopyTournamentLink
            v-if="item.currentRole !== 'counter' && hasPublicShareLink(item.status)"
            class="t-card__copy"
            :slug="item.slug"
            :name="item.name"
            compact
          />
        </div>
        <div v-if="nextStep(item)" class="t-card__next" :class="`t-card__next--${nextStep(item).tone}`">
          <span class="t-card__next-text">{{ nextStep(item).text }}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        </div>
      </article>
    </div>

    <p v-else-if="!loading && !loadError && tournaments.length && !filteredTournaments.length" class="muted">
      {{ t('admin.noTournamentsInFilter') }}
    </p>
    <div v-else-if="!loading && !loadError && !tournaments.length" class="card empty-state">
      <svg class="empty-state__icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
      <p class="empty-state__title">{{ t('admin.noTournaments') }}</p>
      <RouterLink v-if="canCreateTournament" class="btn btn--primary" :to="{ name: 'admin-tournament-new' }">
        {{ t('admin.createTournament') }}
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.t-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
}

.t-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
}

.t-card:active { transform: scale(0.995); }

.t-card:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.t-card__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.t-card__icon {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  border-radius: 12px;
  background: var(--primary-muted);
}

.t-card__info { flex: 1; min-width: 0; }

.t-card__title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.t-card__title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.05rem;
  letter-spacing: -0.01em;
  color: var(--text);
  margin: 0;
}

.t-card__meta {
  margin: 4px 0 0;
  font-size: 0.85rem;
  color: var(--muted);
}

.t-card__copy { flex-shrink: 0; }

.t-card__next {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
  font-weight: 500;
}

.t-card__next--warn {
  color: var(--warning-text);
  background: var(--warning-bg);
}

.t-card__next--live {
  color: var(--success-text);
  background: var(--success-bg);
}

.t-card__next--setup {
  color: var(--primary);
  background: var(--primary-muted);
}

@media (max-width: 560px) {
  .t-card__main { align-items: flex-start; flex-wrap: wrap; }
  .t-card__copy { width: 100%; padding-left: 56px; }
  .t-card__copy :deep(.btn:not(.btn--icon)) { min-height: 44px; flex: 1 1 120px; }
}
</style>
