<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import BracketBoard from '../components/BracketBoard.vue'
import StandingsTable from '../components/StandingsTable.vue'
import RoundRobinCrossTable from '../components/RoundRobinCrossTable.vue'
import GroupStageBoard from '../components/GroupStageBoard.vue'
import DoubleElimBoard from '../components/DoubleElimBoard.vue'
import LiveScoreViewerModal from '../components/LiveScoreViewerModal.vue'
import RegistrationForm from '../components/RegistrationForm.vue'
import { entryMemberNames } from '../lib/entryDisplay'
import { getSportConfig } from '../lib/sportConfig'
import { supabase } from '../lib/supabase'

const props = defineProps({
  slug: {
    type: String,
    required: true,
  },
})

const { t } = useI18n()

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
const groupMatches = computed(() => matches.value.filter((m) => m.stage === 'group'))
const playoffMatches = computed(() =>
  matches.value.filter((m) => ['winners', 'grand_final', 'third_place'].includes(m.stage)),
)
const groupsView = computed(() =>
  [...groups.value]
    .sort((a, b) => a.group_index - b.group_index)
    .map((g) => {
      const gMatches = groupMatches.value
        .filter((m) => m.group_id === g.id)
        .sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number)
      const rounds = new Map()
      for (const m of gMatches) {
        if (!rounds.has(m.round_number)) rounds.set(m.round_number, [])
        rounds.get(m.round_number).push(m)
      }
      return {
        id: g.id,
        name: g.name,
        standings: groupStandings.value[g.id] || [],
        rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, list]) => ({ round, list })),
      }
    }),
)
const matchSets = ref([])
const liveScores = ref([])
const selectedLiveMatchId = ref(null)

const loading = ref(false)
const errorText = ref('')
const activeTab = ref('registration')

let channel = null
let activeTournamentId = null
let loadVersion = 0

const entriesMap = computed(() => {
  return entries.value.reduce((acc, entry) => {
    acc[entry.id] = entry
    return acc
  }, {})
})

const approvedEntries = computed(() => entries.value.filter((entry) => entry.status === 'approved'))
/** Shown only after organizer approval; register_entry creates `pending` rows in `entries`. */
const pendingEntries = computed(() => entries.value.filter((entry) => entry.status === 'pending'))

const setsByMatch = computed(() => {
  return matchSets.value.reduce((acc, set) => {
    if (!acc[set.match_id]) {
      acc[set.match_id] = []
    }
    acc[set.match_id].push(set)
    return acc
  }, {})
})

const liveScoresByMatch = computed(() => {
  return liveScores.value.reduce((acc, item) => {
    acc[item.match_id] = item
    return acc
  }, {})
})

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
  if (s === 'registration_open') {
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
}

function sortEntries(list) {
  return [...list].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
}

function sortMatches(list) {
  return [...list].sort((a, b) => (
    a.round_number - b.round_number || a.match_number - b.match_number
  ))
}

function sortMatchSets(list) {
  return [...list].sort((a, b) => (
    String(a.match_id).localeCompare(String(b.match_id)) || a.set_index - b.set_index
  ))
}

function teardownRealtime() {
  if (channel) {
    supabase.removeChannel(channel)
    channel = null
  }
  activeTournamentId = null
}

function applyTournamentMissing(message = t('errors.notFound')) {
  errorText.value = message
  resetTournamentData()
  teardownRealtime()
}

async function loadEntryWithMembers(entryId) {
  const { data: entryData, error: entryError } = await supabase
    .from('entries')
    .select('id, display_name, entry_type, status, created_at')
    .eq('id', entryId)
    .maybeSingle()

  if (entryError) {
    throw entryError
  }

  if (!entryData) {
    return null
  }

  const { data: members, error: membersError } = await supabase
    .from('entry_members')
    .select('entry_id, member_name, member_order')
    .eq('entry_id', entryId)
    .order('member_order', { ascending: true })

  if (membersError) {
    throw membersError
  }

  return {
    ...entryData,
    entry_members: members || [],
  }
}

async function loadEntriesAndMatches(tournamentId, expectedVersion = loadVersion) {
  const [{ data: entriesData, error: entriesError }, { data: matchesData, error: matchesError }] = await Promise.all([
    supabase
      .from('entries')
      .select('id, display_name, entry_type, status, created_at')
      .eq('tournament_id', tournamentId)
      .order('created_at', { ascending: true }),
    supabase
      .from('matches')
      .select('id, tournament_id, stage, group_id, round_number, match_number, side_a_entry_id, side_b_entry_id, winner_entry_id, side_a_score, side_b_score, side_a_pens, side_b_pens, status, next_match_id, next_slot, loser_next_match_id, loser_next_slot')
      .eq('tournament_id', tournamentId)
      .order('round_number', { ascending: true })
      .order('match_number', { ascending: true }),
  ])

  if (entriesError) {
    throw entriesError
  }

  if (matchesError) {
    throw matchesError
  }

  if (expectedVersion !== loadVersion) {
    return
  }

  const entryRows = entriesData || []
  const ids = entryRows.map((e) => e.id)

  if (ids.length) {
    const { data: members } = await supabase
      .from('entry_members')
      .select('entry_id, member_name, member_order')
      .in('entry_id', ids)
      .order('member_order', { ascending: true })

    const byEntry = {}
    for (const m of members || []) {
      ;(byEntry[m.entry_id] ??= []).push(m)
    }
    for (const entry of entryRows) {
      entry.entry_members = byEntry[entry.id] || []
    }
  }

  if (expectedVersion !== loadVersion) {
    return
  }

  entries.value = sortEntries(entryRows)
  matches.value = sortMatches(matchesData || [])

  if (isRoundRobin.value) {
    const { data: standingsData } = await supabase.rpc('get_standings', {
      p_tournament_id: tournamentId,
      p_group_id: null,
    })
    if (expectedVersion === loadVersion) {
      standings.value = standingsData ?? []
    }
  } else {
    standings.value = []
  }

  if (isGroupsPlayoff.value) {
    const { data: groupRows } = await supabase
      .from('groups')
      .select('id, name, group_index')
      .eq('tournament_id', tournamentId)
      .order('group_index', { ascending: true })
    const rows = groupRows ?? []
    const map = {}
    await Promise.all(
      rows.map(async (g) => {
        const { data } = await supabase.rpc('get_standings', {
          p_tournament_id: tournamentId,
          p_group_id: g.id,
        })
        map[g.id] = data ?? []
      }),
    )
    if (expectedVersion === loadVersion) {
      groups.value = rows
      groupStandings.value = map
    }
  } else {
    groups.value = []
    groupStandings.value = {}
  }

  if (!matches.value.length) {
    matchSets.value = []
    liveScores.value = []
    return
  }

  const matchIds = matches.value.map((match) => match.id)

  const { data: setsData, error: setsError } = await supabase
    .from('match_sets')
    .select('id, match_id, set_index, side_a_games, side_b_games')
    .in('match_id', matchIds)
    .order('set_index', { ascending: true })

  if (setsError) {
    throw setsError
  }

  if (expectedVersion !== loadVersion) {
    return
  }

  matchSets.value = sortMatchSets(setsData || [])

  const { data: liveData, error: liveError } = await supabase
    .from('live_scores')
    .select('id, match_id, tournament_id, status, state, history, revision, created_at, updated_at')
    .eq('tournament_id', tournamentId)

  if (liveError) {
    throw liveError
  }

  if (expectedVersion !== loadVersion) {
    return
  }

  liveScores.value = liveData || []
}

async function initialLoad() {
  const requestVersion = ++loadVersion
  loading.value = true
  errorText.value = ''

  try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('id, name, slug, description, sport, format, category, status, set_format, doubles_pairing_mode, format_config, scoring_config')
      .eq('slug', props.slug)
      .maybeSingle()

    if (error) {
      throw error
    }

    if (requestVersion !== loadVersion) {
      return
    }

    if (!data) {
      applyTournamentMissing()
      return
    }

    tournament.value = data
    await loadEntriesAndMatches(data.id, requestVersion)
    if (requestVersion !== loadVersion) {
      return
    }
    syncDefaultTab()
    setupRealtime(data.id)
  } catch (error) {
    if (requestVersion !== loadVersion) {
      return
    }
    resetTournamentData()
    errorText.value = error.message || t('errors.generic')
    teardownRealtime()
  } finally {
    if (requestVersion === loadVersion) {
      loading.value = false
    }
  }
}

function upsertById(list, row, sorter) {
  const idx = list.findIndex((item) => item.id === row.id)
  const next = idx >= 0
    ? list.map((item, index) => (index === idx ? { ...item, ...row } : item))
    : [...list, row]
  return sorter ? sorter(next) : next
}

function removeById(list, rowId) {
  return list.filter((item) => item.id !== rowId)
}

function onTournamentChange(payload) {
  const tournamentId = payload.new?.id || payload.old?.id
  if (tournamentId !== activeTournamentId) {
    return
  }

  if (payload.eventType === 'DELETE') {
    applyTournamentMissing()
    return
  }

  if (!payload.new?.id) {
    return
  }

  tournament.value = tournament.value
    ? { ...tournament.value, ...payload.new }
    : payload.new
  errorText.value = ''
  syncDefaultTab()
}

async function onEntriesChange(payload) {
  const tournamentId = payload.new?.tournament_id || payload.old?.tournament_id
  if (tournamentId !== activeTournamentId) {
    return
  }

  if (payload.eventType === 'DELETE') {
    if (!payload.old?.id) return
    entries.value = removeById(entries.value, payload.old.id)
    return
  }

  if (!payload.new?.id) {
    return
  }

  try {
    const entry = await loadEntryWithMembers(payload.new.id)
    if (tournamentId !== activeTournamentId) {
      return
    }
    if (!entry) {
      entries.value = removeById(entries.value, payload.new.id)
      return
    }
    entries.value = upsertById(entries.value, entry, sortEntries)
  } catch (error) {
    console.warn('public entries realtime:', error.message || error)
  }
}

function onMatchesChange(payload) {
  const tournamentId = payload.new?.tournament_id || payload.old?.tournament_id
  if (tournamentId !== activeTournamentId) {
    return
  }

  if (payload.eventType === 'DELETE') {
    if (!payload.old?.id) return
    matches.value = removeById(matches.value, payload.old.id)
    matchSets.value = matchSets.value.filter((set) => set.match_id !== payload.old.id)
    liveScores.value = liveScores.value.filter((score) => score.match_id !== payload.old.id)
    return
  }

  if (!payload.new?.id) {
    return
  }

  matches.value = upsertById(matches.value, payload.new, sortMatches)
}

function onMatchSetsChange(payload) {
  if (payload.eventType === 'DELETE') {
    // DELETE payloads may only carry the row id — remove by id, no
    // tournament check (ids of other tournaments are simply not in the list).
    if (!payload.old?.id) return
    matchSets.value = removeById(matchSets.value, payload.old.id)
    return
  }

  const row = payload.new
  if (!row?.id || !row.match_id || !matches.value.some((match) => match.id === row.match_id)) {
    return
  }

  // Drop any stale row occupying the same (match, set) slot before upserting.
  const cleaned = matchSets.value.filter(
    (item) => item.id === row.id || !(item.match_id === row.match_id && item.set_index === row.set_index),
  )
  matchSets.value = upsertById(cleaned, row, sortMatchSets)
}

function onLiveScoresChange(payload) {
  const tournamentId = payload.new?.tournament_id || payload.old?.tournament_id
  if (tournamentId !== activeTournamentId) {
    return
  }

  if (payload.eventType === 'DELETE') {
    if (!payload.old?.id) return
    liveScores.value = removeById(liveScores.value, payload.old.id)
    return
  }

  if (!payload.new?.id) {
    return
  }

  liveScores.value = upsertById(liveScores.value, payload.new)
}

function setupRealtime(tournamentId) {
  if (activeTournamentId === tournamentId && channel) {
    return
  }

  teardownRealtime()
  activeTournamentId = tournamentId

  channel = supabase
    .channel(`public-${tournamentId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${tournamentId}` }, onTournamentChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries', filter: `tournament_id=eq.${tournamentId}` }, onEntriesChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${tournamentId}` }, onMatchesChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_sets' }, onMatchSetsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_scores', filter: `tournament_id=eq.${tournamentId}` }, onLiveScoresChange)

  channel.subscribe()
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
}, { deep: true })

onMounted(initialLoad)

watch(
  () => props.slug,
  () => {
    initialLoad()
  },
)

watch(
  () => tournament.value?.status,
  () => {
    syncDefaultTab()
  },
)

onBeforeUnmount(() => {
  teardownRealtime()
})
</script>

<template>
  <div class="stack">
    <section v-if="loading" class="card">
      <p class="muted">{{ t('actions.loading') }}</p>
    </section>

    <section v-else-if="errorText && !tournament" class="card empty-state">
      <svg class="empty-state__icon" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="20"/><path d="M16 16l16 16"/><path d="M32 16L16 32"/></svg>
      <p class="empty-state__title">{{ errorText }}</p>
      <p class="empty-state__hint">{{ t('errors.checkLink') }}</p>
    </section>

    <template v-else-if="tournament">
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
          <p v-if="tournament.description" class="pub-hero__desc">{{ tournament.description }}</p>
        </div>
      </section>

      <template v-if="tournament.status === 'registration_open'">
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
                :tournament="tournament"
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

@media (max-width: 560px) {
  .pub-hero { flex-direction: column; align-items: flex-start; gap: var(--space-3); }
}
</style>
