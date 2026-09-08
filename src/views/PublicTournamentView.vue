<script setup>
import { tennisRulesSummary } from '../lib/tennisRules'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import BracketBoard from '../components/BracketBoard.vue'
import StandingsTable from '../components/StandingsTable.vue'
import RoundRobinCrossTable from '../components/RoundRobinCrossTable.vue'
import GroupStageBoard from '../components/GroupStageBoard.vue'
import DoubleElimBoard from '../components/DoubleElimBoard.vue'
import LiveScoreViewerModal from '../components/LiveScoreViewerModal.vue'
import RegistrationForm from '../components/RegistrationForm.vue'
import TournamentMatchList from '../components/TournamentMatchList.vue'
import { entryMemberNames } from '../lib/entryDisplay'
import { getSportConfig } from '../lib/sportConfig'
import { useNarrowLayout } from '../lib/useNarrowLayout'
import { supabase } from '../lib/supabase'
import { createSnapshotRefresh, subscribeTournament, subscribeRefreshTriggers } from '../lib/tournamentSync'
import { createPublicTournamentReader } from '../lib/tournamentRepository'
import { indexEntries, groupSetsByMatch, indexLiveScores, buildGroupsView } from '../lib/tournamentProjections'

const props = defineProps({
  slug: {
    type: String,
    required: true,
  },
})

const { t } = useI18n()
const isNarrowLayout = useNarrowLayout()
const mobileSurface = ref('matches')

const tournament = ref(null)
const entries = ref([])
const matches = ref([])
const standings = ref([])
const isRoundRobin = computed(() => tournament.value?.format === 'round_robin')
const isGroupsPlayoff = computed(() => tournament.value?.format === 'groups_playoff')
const isDoubleElim = computed(() => tournament.value?.format === 'double_elimination')
const sportCfg = computed(() => getSportConfig(tournament.value?.sport || 'tennis'))
const groups = ref([])
const groupStandings = ref({})
const playoffMatches = computed(() =>
  matches.value.filter((m) => ['winners', 'grand_final', 'third_place'].includes(m.stage)),
)
const groupsView = computed(() =>
  buildGroupsView(groups.value, matches.value, groupStandings.value),
)
const matchSets = ref([])
const liveScores = ref([])
const selectedLiveMatchId = ref(null)

const loading = ref(false)
const loadError = ref('')
const activeTab = ref('registration')
const registrationDirty = ref(false)

let stopRealtime = null
let stopRecovery = null
let refreshQueue = null
let loadVersion = 0
const syncFailed = ref(false)

const entriesMap = computed(() => indexEntries(entries.value))

const approvedEntries = computed(() => entries.value.filter((entry) => entry.status === 'approved'))
/** Shown only after organizer approval; register_entry creates `pending` rows in `entries`. */
const pendingEntries = computed(() => entries.value.filter((entry) => entry.status === 'pending'))

const setsByMatch = computed(() => groupSetsByMatch(matchSets.value))
const liveScoresByMatch = computed(() => indexLiveScores(liveScores.value))

const selectedLiveMatch = computed(() => (
  selectedLiveMatchId.value ? matches.value.find((match) => match.id === selectedLiveMatchId.value) || null : null
))

const selectedLiveScore = computed(() => (
  selectedLiveMatch.value ? liveScoresByMatch.value[selectedLiveMatch.value.id] || null : null
))

function teamLabel(entryId) {
  if (!entryId) {
    return t('bracket.tbd')
  }
  const names = entryMemberNames(entriesMap.value[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
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
  if (status === 'registration_closed') {
    return 'badge--warn'
  }
  return 'badge--neutral'
}

const SPORT_ICONS = { tennis: '🎾', padel: '🏸', football: '⚽' }
const FORMAT_ICONS = {
  single_elimination: '🏆',
  round_robin: '🔄',
  groups_playoff: '🗂️',
  double_elimination: '🔀',
}
const heroIcon = computed(() => SPORT_ICONS[tournament.value?.sport] || '🏆')
const heroChips = computed(() => {
  if (!tournament.value) return []
  const chips = [
    { icon: SPORT_ICONS[tournament.value.sport] || '🏆', label: t(`sport.${tournament.value.sport}`) },
    { icon: FORMAT_ICONS[tournament.value.format] || '🏆', label: t(`tournamentFormat.${tournament.value.format}`) },
  ]
  if (sportCfg.value.supportsCategory) {
    chips.push({
      icon: tournament.value.category === 'doubles' ? '👥' : '👤',
      label: t(`tournament.${tournament.value.category}`),
    })
  }
  if (sportCfg.value.supportsSetFormat && tournament.value.set_format) {
    chips.push({ icon: '⚙️', label: t(`format.${tournament.value.set_format}`) })
  }
  if (approvedEntries.value.length) {
    chips.push({
      icon: '🙌',
      label: `${t('tournament.participants')}: ${approvedEntries.value.length}`,
    })
  }
  return chips
})

function syncDefaultTab() {
  const s = tournament.value?.status
  if (s === 'registration_open' || registrationDirty.value) {
    activeTab.value = 'registration'
  } else {
    activeTab.value = 'bracket'
  }
}

function resetTournamentData() {
  tournament.value = null
  entries.value = []
  matches.value = []
  matchSets.value = []
  liveScores.value = []
  selectedLiveMatchId.value = null
  standings.value = []; groups.value = []; groupStandings.value = {}
}

function teardownRealtime() {
  stopRealtime?.(); stopRealtime = null
  stopRecovery?.(); stopRecovery = null
  refreshQueue?.dispose(); refreshQueue = null
}

function applySnapshot(data) {
  syncFailed.value = false
  if (!data) {
    loadError.value = 'notFound'
    resetTournamentData()
    return
  }
  tournament.value = data.tournament
  entries.value = data.entries
  matches.value = data.matches
  matchSets.value = data.sets
  liveScores.value = data.live
  groups.value = data.groups
  standings.value = data.standings
  groupStandings.value = data.group_standings
  loadError.value = ''
}

async function initialLoad() {
  // Registration callbacks refresh in place, preserving the mounted form.
  if (refreshQueue) {
    loading.value = !tournament.value
    return refreshQueue.refresh()
  }
  const request = ++loadVersion
  const slug = props.slug
  loading.value = !tournament.value
  const read = createPublicTournamentReader(supabase, slug, {
    onResolve: id => {
      if (request !== loadVersion) return
      stopRealtime?.(); stopRealtime = null
      if (id) setupRealtime(id)
      else applySnapshot(null)
    },
  })
  refreshQueue = createSnapshotRefresh({
    read,
    apply: data => { applySnapshot(data); loading.value = false },
    onError: () => {
      syncFailed.value = true
      if (!tournament.value) loadError.value = 'failed'
      loading.value = false
    },
  })
  stopRecovery = subscribeRefreshTriggers({ refresh: () => refreshQueue?.request() })
  await refreshQueue.refresh()
  if (request === loadVersion) { loading.value = false; syncDefaultTab() }
}

function setupRealtime(id) {
  stopRealtime = subscribeTournament({
    client: supabase, id, name: 'public', recover: false,
    getState: () => ({ entries: entries.value, matches: matches.value, sets: matchSets.value, live: liveScores.value, groups: groups.value }),
    refresh: () => refreshQueue?.request(),
    onStatus: status => { if (status !== 'SUBSCRIBED') syncFailed.value = true },
  })
}

watch(selectedLiveMatchId, (matchId) => {
  if (matchId && !matches.value.some((match) => match.id === matchId)) {
    selectedLiveMatchId.value = null
  }
})

watch(matches, () => {
  if (selectedLiveMatchId.value && !matches.value.some((match) => match.id === selectedLiveMatchId.value)) {
    selectedLiveMatchId.value = null
  }
})

onMounted(initialLoad)

watch(
  () => props.slug,
  () => {
    loadVersion++
    teardownRealtime()
    registrationDirty.value = false
    loadError.value = ''
    resetTournamentData()
    initialLoad()
  },
)

watch(
  () => [tournament.value?.status, registrationDirty.value],
  () => {
    syncDefaultTab()
  },
)

onBeforeUnmount(() => {
  loadVersion++
  teardownRealtime()
})
</script>

<template>
  <div class="stack">
    <section v-if="loading" class="card">
      <p class="muted">{{ t('actions.loading') }}</p>
    </section>

    <section v-else-if="loadError && !tournament" class="card empty-state" role="alert">
      <svg class="empty-state__icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="20"/><path d="M16 16l16 16"/><path d="M32 16L16 32"/></svg>
      <p class="empty-state__title">{{ t(loadError === 'failed' ? 'sync.loadFailed' : 'errors.notFound') }}</p>
      <p class="empty-state__hint">{{ t(loadError === 'failed' ? 'sync.loadFailedHint' : 'errors.checkLink') }}</p>
      <button class="btn btn--secondary" type="button" @click="initialLoad">{{ t('sync.retry') }}</button>
    </section>

    <template v-else-if="tournament">
      <div v-if="syncFailed" class="alert alert--error" role="status">
        {{ t('sync.unavailable') }}
        <button class="btn btn--secondary btn--sm" type="button" @click="initialLoad">{{ t('sync.retry') }}</button>
      </div>
      <section class="card card--elevated pub-hero">
        <span class="pub-hero__icon">{{ heroIcon }}</span>
        <div class="pub-hero__body">
          <div class="pub-hero__title-row">
            <h1 class="page-title" style="margin: 0">{{ tournament.name }}</h1>
            <span class="badge" :class="statusBadgeClass(tournament.status)">
              {{ t(`tournament.${tournament.status}`) }}
            </span>
          </div>
          <div class="pub-chips">
            <span v-for="(chip, i) in heroChips" :key="i" class="pub-chip">
              <span class="pub-chip__icon">{{ chip.icon }}</span>{{ chip.label }}
            </span>
          </div>
          <details
            v-if="tournament.description || tournament.sport === 'tennis'"
            class="pub-hero__details"
            :open="!isNarrowLayout"
          >
            <summary>{{ t('mobile.tournamentDetails') }}</summary>
            <p v-if="tournament.description" class="pub-hero__desc">{{ tournament.description }}</p>
            <p v-if="tournament.sport === 'tennis'" class="pub-hero__desc">{{ tennisRulesSummary(tournament.scoring_config, t) }}</p>
          </details>
          <div v-if="tournament.publish_contact && (tournament.contact_phone || tournament.contact_email)" class="pub-contact">
            <strong>{{ t('mobile.organizerContacts') }}</strong>
            <a v-if="tournament.contact_phone" :href="`tel:${tournament.contact_phone}`">{{ tournament.contact_phone }}</a>
            <a v-if="tournament.contact_email" :href="`mailto:${tournament.contact_email}`">{{ tournament.contact_email }}</a>
          </div>
        </div>
      </section>

      <template v-if="tournament.status === 'registration_open' || registrationDirty">
        <div class="tab-group" role="tablist" :aria-label="t('tournament.tabsLabel')">
          <button
            type="button"
            class="tab"
            :class="{ 'tab--active': activeTab === 'registration' }"
            role="tab"
            :aria-selected="activeTab === 'registration'"
            @click="activeTab = 'registration'"
          >
            {{ t('tournament.tabRegistration') }}
          </button>
          <span class="tooltip-wrapper" :data-tooltip="t('tournament.bracketLockedTooltip')">
            <button
              type="button"
              class="tab tab--disabled"
              role="tab"
              :aria-selected="false"
              :aria-disabled="true"
              disabled
            >
              {{ t('tournament.tabBracket') }}
            </button>
          </span>
        </div>

        <div role="tabpanel">
          <div :class="approvedEntries.length || pendingEntries.length ? 'grid-2' : 'pub-reg-solo'">
            <div class="stack stack--sm">
              <RegistrationForm
                :key="tournament.id"
                :tournament="tournament"
                @dirty="registrationDirty = $event"
                @submitted="initialLoad"
              />
            </div>

            <div v-if="approvedEntries.length || pendingEntries.length" class="card stack stack--sm">
              <h3 class="section-title">{{ t('tournament.participants') }} ({{ approvedEntries.length }})</h3>
              <div v-if="approvedEntries.length" class="participant-list">
                <div v-for="entry in approvedEntries" :key="entry.id" class="participant-item">
                  <strong>{{ entry.display_name }}</strong>
                  <span class="badge badge--success">{{ t('tournament.approved') }}</span>
                </div>
              </div>
              <p v-else class="alert alert--info">
                {{ t('tournament.pendingParticipantsHint', { count: pendingEntries.length }) }}
              </p>
            </div>
          </div>
        </div>
      </template>

      <div v-else-if="!matches.length && !groups.length" class="card empty-state" role="status">
        <p>{{ t('bracket.empty') }}</p>
      </div>

      <template v-else-if="isNarrowLayout">
        <div class="mobile-surface-switch" role="tablist" :aria-label="t('tournament.tabsLabel')">
          <button type="button" role="tab" :aria-selected="mobileSurface === 'matches'" :class="{ active: mobileSurface === 'matches' }" @click="mobileSurface = 'matches'">
            {{ t('mobile.matches') }}
          </button>
          <button type="button" role="tab" :aria-selected="mobileSurface === 'overview'" :class="{ active: mobileSurface === 'overview' }" @click="mobileSurface = 'overview'">
            {{ t('mobile.overview') }}
          </button>
        </div>

        <div v-if="mobileSurface === 'matches'" class="card mobile-match-card">
          <TournamentMatchList
            :matches="matches"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :live-scores-by-match="liveScoresByMatch"
            @view-live="selectedLiveMatchId = $event.id"
          />
        </div>

        <template v-else-if="isRoundRobin">
          <div v-if="standings.length" class="card">
            <h3 class="section-title">{{ t('standings.title') }}</h3>
            <StandingsTable :rows="standings" :family="sportCfg.scoringFamily" />
          </div>
          <div v-if="matches.length" class="card rr-cross-card" style="margin-top: var(--space-4)">
            <h3 class="section-title">{{ t('standings.crossTable') }}</h3>
            <RoundRobinCrossTable :matches="matches" :entries-map="entriesMap" :standings="standings" :family="sportCfg.scoringFamily" :live-scores-by-match="liveScoresByMatch" @view-live="selectedLiveMatchId = $event.id" />
          </div>
        </template>
        <template v-else-if="isGroupsPlayoff">
          <div v-if="groups.length" class="card"><h3 class="section-title">{{ t('admin.groupStage') }}</h3><GroupStageBoard :groups="groupsView" :entries-map="entriesMap" :family="sportCfg.scoringFamily" /></div>
          <div v-if="playoffMatches.length" class="card" style="margin-top: var(--space-4)"><h3 class="section-title">{{ t('admin.playoff') }}</h3><BracketBoard :matches="playoffMatches" :sets-by-match="setsByMatch" :entries-map="entriesMap" :live-scores-by-match="liveScoresByMatch" @view-live="selectedLiveMatchId = $event.id" /></div>
        </template>
        <div v-else-if="isDoubleElim" class="card">
          <DoubleElimBoard :matches="matches" :sets-by-match="setsByMatch" :entries-map="entriesMap" :live-scores-by-match="liveScoresByMatch" @view-live="selectedLiveMatchId = $event.id" />
        </div>
        <div v-else class="card">
          <BracketBoard :matches="matches" :sets-by-match="setsByMatch" :entries-map="entriesMap" :live-scores-by-match="liveScoresByMatch" @view-live="selectedLiveMatchId = $event.id" />
        </div>
      </template>

      <template v-else-if="isRoundRobin">
        <div v-if="standings.length" class="card">
          <h3 class="section-title">{{ t('standings.title') }}</h3>
          <StandingsTable :rows="standings" :family="sportCfg.scoringFamily" />
        </div>
        <div v-if="matches.length" class="card rr-cross-card" style="margin-top: var(--space-4)">
          <h3 class="section-title">{{ t('standings.crossTable') }}</h3>
          <RoundRobinCrossTable
            :matches="matches"
            :entries-map="entriesMap"
            :standings="standings"
            :family="sportCfg.scoringFamily"
            :live-scores-by-match="liveScoresByMatch"
            @view-live="selectedLiveMatchId = $event.id"
          />
        </div>      </template>

      <template v-else-if="isGroupsPlayoff">
        <div v-if="groups.length" class="card">
          <h3 class="section-title">{{ t('admin.groupStage') }}</h3>
          <GroupStageBoard :groups="groupsView" :entries-map="entriesMap" :family="sportCfg.scoringFamily" />
        </div>
        <div v-if="playoffMatches.length" class="card" style="margin-top: var(--space-4)">
          <h3 class="section-title">{{ t('admin.playoff') }}</h3>
          <BracketBoard
            :matches="playoffMatches"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :live-scores-by-match="liveScoresByMatch"
            @view-live="selectedLiveMatchId = $event.id"
          />
        </div>
      </template>

      <div v-else-if="isDoubleElim" class="card">
        <h3 class="section-title">{{ t('tournament.bracket') }}</h3>
        <DoubleElimBoard
          :matches="matches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          @view-live="selectedLiveMatchId = $event.id"
        />
      </div>

      <div v-else class="card">
        <h3 class="section-title">{{ t('tournament.bracket') }}</h3>
        <BracketBoard
          :matches="matches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          @view-live="selectedLiveMatchId = $event.id"
        />
      </div>

      <LiveScoreViewerModal
        v-if="selectedLiveMatch && selectedLiveScore"
        :live-score="selectedLiveScore"
        :team-a="teamLabel(selectedLiveMatch.side_a_entry_id)"
        :team-b="teamLabel(selectedLiveMatch.side_b_entry_id)"
        @close="selectedLiveMatchId = null"
      />
    </template>
  </div>
</template>

<style scoped>
.participant-item { flex-wrap: wrap; gap: 8px 12px; }
.participant-item strong { flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; }
.participant-item .badge { flex-shrink: 0; }

.pub-hero {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.pub-hero__icon {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.7rem;
  border-radius: 14px;
  background: var(--primary-muted);
}

.pub-hero__body { min-width: 0; }

.pub-hero__title-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.pub-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.pub-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text);
  background: var(--surface-2, var(--surface-row));
  border: 1px solid var(--border);
  border-radius: 999px;
  white-space: nowrap;
}

.pub-chip__icon {
  font-size: 0.9rem;
  line-height: 1;
}

.pub-reg-solo {
  max-width: 560px;
  margin: 0 auto;
}

.pub-hero__desc {
  margin: var(--space-3) 0 0;
  color: var(--text);
  line-height: 1.6;
}

.pub-hero__details summary { display: none; }
.pub-contact { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; font-size: .84rem; }
.pub-contact a { color: var(--primary); overflow-wrap: anywhere; }

.mobile-surface-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface-row);
}
.mobile-surface-switch button {
  min-height: 44px;
  padding: 8px 10px;
  border: 0;
  border-radius: 11px;
  color: var(--text-muted);
  background: transparent;
  font: inherit;
  font-size: .86rem;
  font-weight: 750;
}
.mobile-surface-switch button.active { color: var(--text); background: var(--surface); box-shadow: 0 3px 12px rgb(15 23 42 / 8%); }

@media (max-width: 560px) {
  .pub-hero { gap: var(--space-3); padding: 16px; }
  .pub-hero__icon { display: none; }
  .pub-hero__title-row { gap: 8px; }
  .pub-hero__title-row .page-title { font-size: clamp(1.45rem, 7vw, 1.85rem); line-height: 1.08; }
  .pub-chips { flex-wrap: nowrap; overflow-x: auto; margin-top: 8px; padding-bottom: 2px; scrollbar-width: none; }
  .pub-chips::-webkit-scrollbar { display: none; }
  .pub-chip { padding: 4px 9px; font-size: .76rem; }
  .pub-hero__details { margin-top: 8px; }
  .pub-hero__details summary { display: list-item; color: var(--primary); font-size: .84rem; font-weight: 750; cursor: pointer; }
  .pub-hero__desc { margin-top: 8px; font-size: .9rem; line-height: 1.45; }
  .mobile-match-card { padding: 14px; }
}
</style>
