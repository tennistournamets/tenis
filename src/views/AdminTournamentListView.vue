<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { supabase } from '../lib/supabase'
import { copyTournamentLink } from '../lib/shareLink'
import { getSportConfig } from '../lib/sportConfig'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()

const loading = ref(false)
const loadError = ref('')
const copySlug = ref('')
const copyFeedback = ref(false)

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

async function loadTournaments() {
  if (!auth.user) {
    tournaments.value = []
    return
  }

  loading.value = true
  loadError.value = ''

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
        created_at
      )
    `,
    )
    .eq('user_id', auth.user.id)

  loading.value = false

  if (error) {
    loadError.value = error.message
    tournaments.value = []
    return
  }

  const rows = data || []
  const list = rows
    .map((row) => row.tournaments ? { ...row.tournaments, currentRole: row.role } : null)
    .filter((t) => t != null)
  list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  tournaments.value = list
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
    return new Date(iso).toLocaleDateString(undefined, {
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

async function onCopyLink(slug, e) {
  e?.stopPropagation?.()
  try {
    await copyTournamentLink(slug)
    copySlug.value = slug
    copyFeedback.value = true
    setTimeout(() => {
      copyFeedback.value = false
    }, 2000)
  } catch {
    copySlug.value = slug
    copyFeedback.value = true
    setTimeout(() => {
      copyFeedback.value = false
    }, 2000)
  }
}

function statusBadgeClass(status) {
  if (status === 'completed') {
    return 'badge--done'
  }
  if (status === 'in_progress') {
    return 'badge--live'
  }
  if (status === 'registration_open') {
    return 'badge--warn'
  }
  return 'badge--neutral'
}

const SPORT_ICONS = { tennis: '🎾', padel: '🏸', football: '⚽' }

function itemSubtitle(item) {
  const parts = [t(`tournamentFormat.${item.format}`)]
  if (getSportConfig(item.sport).supportsCategory) {
    parts.push(t(`tournament.${item.category}`))
  }
  return parts.join(' · ')
}

function nextStep(item) {
  if (item.currentRole === 'counter') return null
  switch (item.status) {
    case 'registration_open':
      return { text: t('admin.listHintRegOpen'), tone: 'warn' }
    case 'in_progress':
      return { text: t('admin.listHintInProgress'), tone: 'live' }
    case 'draft':
    case 'registration_closed':
      return { text: t('admin.listHintSetup'), tone: 'setup' }
    default:
      return null
  }
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
      <h1 class="page-title" style="margin: 0">{{ pageTitle }}</h1>
      <div class="admin-list-header__actions">
        <!-- <button class="btn btn--ghost btn--sm" type="button" @click="loadTournaments">
          {{ t('actions.refresh') }}
        </button> -->
        <RouterLink v-if="canCreateTournament" class="btn btn--primary btn--sm" :to="{ name: 'admin-tournament-new' }">
          {{ t('admin.createTournament') }}
        </RouterLink>
      </div>
    </div>
    <p class="muted">{{ pageHint }}</p>

    <div v-if="!hasCounterOnlyTournaments" class="filter-segment" role="group" :aria-label="t('admin.filterLabel')">
      <button
        type="button"
        class="filter-segment__btn"
        :class="{ 'filter-segment__btn--active': statusFilter === 'active' }"
        @click="statusFilter = 'active'"
      >
        {{ t('admin.filterActive') }}
      </button>
      <button
        type="button"
        class="filter-segment__btn"
        :class="{ 'filter-segment__btn--active': statusFilter === 'completed' }"
        @click="statusFilter = 'completed'"
      >
        {{ t('admin.filterCompleted') }}
      </button>
      <button
        type="button"
        class="filter-segment__btn"
        :class="{ 'filter-segment__btn--active': statusFilter === 'all' }"
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
          <span class="t-card__icon">{{ SPORT_ICONS[item.sport] || '🏆' }}</span>
          <div class="t-card__info">
            <div class="t-card__title-row">
              <h2 class="t-card__title">{{ item.name }}</h2>
              <span class="badge" :class="statusBadgeClass(item.status)">
                {{ t(`tournament.${item.status}`) }}
              </span>
              <span v-if="item.currentRole && item.currentRole !== 'owner'" class="badge badge--neutral">{{ t(`admin.${item.currentRole}`) }}</span>
            </div>
            <p class="t-card__meta">{{ itemSubtitle(item) }} · {{ formatDate(item.created_at) }}</p>
          </div>
          <button
            v-if="item.currentRole !== 'counter' && hasPublicShareLink(item.status)"
            class="btn btn--outline btn--sm t-card__copy"
            type="button"
            @click.stop="onCopyLink(item.slug, $event)"
          >
            {{ copyFeedback && copySlug === item.slug ? t('share.copied') : t('share.copyLink') }}
          </button>
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
  font-size: 1.4rem;
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
  .t-card__copy { display: none; }
}
</style>
