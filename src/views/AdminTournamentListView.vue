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
      supabase.from('matches').select('tournament_id,status,side_a_entry_id,side_b_entry_id').in('tournament_id', ids),
      supabase.from('live_scores').select('tournament_id,status').in('tournament_id', ids).eq('status', 'active'),
    ])
    const next = Object.fromEntries(ids.map(id => [id, { approved: 0, pending: 0, matches: 0, played: 0, byes: 0, live: 0 }]))
    for (const e of entries.data || []) if (next[e.tournament_id] && (e.status === 'approved' || e.status === 'pending')) next[e.tournament_id][e.status] += 1
    for (const m of matchRows.data || []) {
      const p = next[m.tournament_id]
      if (!p) continue
      p.matches += 1
      // A finished match with an empty side is a BYE: not a match to play.
      if (m.status === 'finished' && (!m.side_a_entry_id || !m.side_b_entry_id)) p.byes += 1
      else if (m.status === 'finished') p.played += 1
    }
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
          registration_capacity,
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

// The figure on the right: seats while registering, matches once the draw exists.
function itemProgress(item) {
  const p = progress.value[item.id]
  const status = displayStatus(item)
  if (!p) return null
  const toPlay = p.matches - p.byes
  if ((status === 'in_progress' || status === 'completed') && toPlay > 0) {
    return { value: p.played / toPlay, n: p.played, total: toPlay, label: t('admin.listProgressMatches'), text: t('admin.listMetaMatches', { n: p.played, total: toPlay }) }
  }
  if (item.registration_capacity && status !== 'completed') {
    return { value: p.approved / item.registration_capacity, n: p.approved, total: item.registration_capacity, label: t('admin.listProgressSeats'), text: t('admin.listMetaSeats', { n: p.approved, total: item.registration_capacity }) }
  }
  return null
}

const progressWidth = item => `${Math.round(Math.min(Math.max(itemProgress(item)?.value || 0, 0), 1) * 100)}%`

// One quiet line of facts under the name; the progress figure has its own column.
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
        :class="`t-card--${displayStatus(item)}`"
        tabindex="0"
        role="link"
        @click="router.push(tournamentTarget(item))"
        @keydown.enter="router.push(tournamentTarget(item))"
      >
        <span class="t-card__icon" aria-hidden="true"><AppIcon :name="item.sport" :size="20" /></span>
        <div class="t-card__info">
          <div class="t-card__title-row">
            <h2 class="t-card__title">{{ item.name }}</h2>
            <span class="t-card__status"><i aria-hidden="true"></i>{{ t(`tournament.${displayStatus(item)}`) }}</span>
            <span v-if="item.currentRole && item.currentRole !== 'owner'" class="badge badge--neutral">{{ t(`admin.${item.currentRole}`) }}</span>
            <span v-if="item.visibility && item.visibility !== 'link'" class="badge badge--neutral">{{ t(`access.visibility.${item.visibility}`) }}</span>
          </div>
          <p class="t-card__meta"><span class="sr-only">{{ t(`sport.${item.sport}`) }} · </span>{{ itemMeta(item) }}</p>
          <p v-if="nextStep(item)" class="t-card__next" :class="`t-card__next--${nextStep(item).tone}`">
            <span v-if="nextStep(item).tone === 'live' && progress[item.id]?.live" class="live-dot" aria-hidden="true"></span>
            <span class="t-card__next-text">{{ nextStep(item).text }}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </p>
        </div>
        <div v-if="itemProgress(item)" class="t-card__progress" :aria-label="itemProgress(item).text" role="img">
          <span class="t-card__figure" aria-hidden="true">{{ itemProgress(item).n }}/{{ itemProgress(item).total }}</span>
          <span class="t-card__figure-label" aria-hidden="true">{{ itemProgress(item).label }}</span>
          <span class="t-card__bar" aria-hidden="true"><span :style="{ width: progressWidth(item) }"></span></span>
        </div>
        <CopyTournamentLink
          v-if="item.currentRole !== 'counter' && hasPublicShareLink(item.status)"
          class="t-card__copy"
          :slug="item.slug"
          :name="item.name"
          compact
        />
        <svg class="t-card__chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
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
/* Status as a thin left accent and a dot, one quiet line of facts, the
   progress as a figure read at a glance, the next step as a coloured link. */
.t-card {
  --tone: var(--muted);
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 18px var(--space-4) 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.t-card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--tone); }
.t-card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.t-card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
/* Same colours as the status badges (lib/tournamentStatus.js). */
.t-card--registration_open, .t-card--registration_closed { --tone: var(--warning); }
.t-card--in_progress { --tone: var(--success); }
.t-card--completed { --tone: var(--done-dot); }

.t-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  background: var(--surface-row);
  color: var(--tone);
}
.t-card__info { min-width: 0; }
.t-card__title-row { display: flex; align-items: center; gap: var(--space-2) 10px; flex-wrap: wrap; }
.t-card__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.0625rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--heading);
  overflow-wrap: anywhere;
}
.t-card__status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8125rem; font-weight: 600; color: var(--tone); }
.t-card--registration_open .t-card__status, .t-card--registration_closed .t-card__status { color: var(--warning-text); }
.t-card--in_progress .t-card__status { color: var(--success-text); }
.t-card__status i { width: 6px; height: 6px; border-radius: 50%; background: var(--tone); }
.t-card__meta { margin: 3px 0 0; font-size: 0.875rem; color: var(--muted); }
.t-card__next { margin: var(--space-2) 0 0; font-size: 0.875rem; font-weight: 600; line-height: 1.45; }
/* Dot and arrow ride the text, so a wrapped hint keeps its arrow at the end. */
.t-card__next .live-dot { display: inline-block; margin-right: 6px; vertical-align: 1px; }
.t-card__next svg { display: inline; margin-left: 6px; vertical-align: -2px; }
.t-card__next--warn { color: var(--warning-text); }
.t-card__next--live { color: var(--success-text); }
.t-card__next--setup { color: var(--primary); }

.t-card__progress { display: grid; justify-items: end; gap: 2px; min-width: 84px; }
.t-card__figure { font-family: var(--font-mono); font-size: 1.25rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--text); }
.t-card__figure-label { font-size: 0.75rem; color: var(--muted); }
.t-card__bar { width: 84px; height: 4px; margin-top: 4px; border-radius: 999px; background: var(--border); overflow: hidden; }
.t-card__bar span { display: block; height: 100%; border-radius: inherit; background: var(--tone); }
.t-card__copy { flex-shrink: 0; }
.t-card__chevron { color: var(--muted); }

@media (max-width: 560px) {
  /* Phone: the text gets the full width; progress and the link share a row below. */
  .t-card {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'icon info info' '. progress copy';
    align-items: start;
    gap: var(--space-3);
    padding-left: 16px;
  }
  .t-card__icon { grid-area: icon; }
  .t-card__info { grid-area: info; }
  .t-card__progress { grid-area: progress; display: flex; align-items: center; align-self: center; gap: var(--space-2); min-width: 0; }
  .t-card__figure { font-size: 1rem; }
  .t-card__bar { flex: 1; width: auto; max-width: 120px; margin-top: 0; }
  .t-card__copy { grid-area: copy; }
  .t-card__chevron { display: none; }
}
@media (prefers-reduced-motion: reduce) { .t-card { transition: none; } }
</style>
