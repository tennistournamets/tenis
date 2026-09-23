<script setup>
import { tennisRulesRows } from '../lib/tennisRules'
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

import BracketBoard from '../components/BracketBoard.vue'
import StandingsTable from '../components/StandingsTable.vue'
import RoundRobinCrossTable from '../components/RoundRobinCrossTable.vue'
import GroupStageBoard from '../components/GroupStageBoard.vue'
import DoubleElimBoard from '../components/DoubleElimBoard.vue'
import LiveScoreViewerModal from '../components/LiveScoreViewerModal.vue'
import RegistrationForm from '../components/RegistrationForm.vue'
import RegistrationConditions from '../components/RegistrationConditions.vue'
import TournamentUnlock from '../components/TournamentUnlock.vue'
import TournamentMatchList from '../components/TournamentMatchList.vue'
import { entryMemberNames } from '../lib/entryDisplay'
import { getSportConfig } from '../lib/sportConfig'
import { useNarrowLayout } from '../lib/useNarrowLayout'
import { useHeaderTitle } from '../lib/headerTitle'
import { onTabKeydown } from '../lib/tabNavigation'
import { supabase } from '../lib/supabase'
import { createSnapshotRefresh, subscribeTournament, subscribeRefreshTriggers } from '../lib/tournamentSync'
import { createPublicTournamentReader, probeTournamentAccess, readProtectedTournamentSnapshot } from '../lib/tournamentRepository'
import { indexEntries, groupSetsByMatch, indexLiveScores, buildGroupsView } from '../lib/tournamentProjections'
import { registrationDisplayState, closedReasonKey } from '../lib/registrationRules'
import { currentPlatform, hasVenue, venueRouteLinks } from '../lib/venue'
import { effectiveSchedule, timezoneOf } from '../lib/schedule'
import { clearAccessToken, isAccessExpiredError, readAccessToken, setRobotsMeta, storeAccessToken, visibilityOf } from '../lib/access'

const props = defineProps({
  slug: {
    type: String,
    required: true,
  },
})

const { t } = useI18n()
// The fallback keeps isolated component previews functional; routed product
// pages always receive the real Vue Router instances.
const route = useRoute() || { query: {}, hash: '' }
const router = useRouter() || {
  push: () => Promise.resolve(),
  replace: () => Promise.resolve(),
  back: () => {},
}
const isNarrowLayout = useNarrowLayout()
const PUBLIC_MOBILE_SURFACES = ['matches', 'overview']
const queryValue = value => Array.isArray(value) ? value[0] : value
const publicSurfaceFromQuery = value => PUBLIC_MOBILE_SURFACES.includes(queryValue(value))
  ? queryValue(value)
  : 'matches'
const mobileSurface = ref(publicSurfaceFromQuery(route.query.view))

const tournament = ref(null)
useHeaderTitle(() => tournament.value?.name)
const entries = ref([])
const matches = ref([])
const standings = ref([])
const registration = ref(null)
const courts = ref([])
const schedule = ref([])
// Spectators only ever receive published rows; organizers viewing the public page get the same.
provide('matchScheduleView', computed(() => ({
  byMatch: effectiveSchedule(schedule.value, false),
  courtsById: Object.fromEntries(courts.value.map(c => [c.id, c])),
  timeZone: timezoneOf(tournament.value),
  draftIds: new Set(),
})))
// Re-evaluated every 30 s so a deadline reached between snapshots closes the form locally.
const nowTick = ref(Date.now())
let nowTimer = null
const regState = computed(() => registrationDisplayState(registration.value, nowTick.value, tournament.value))
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
// Password pages: the grant lives in this tab; RLS still hides the rows, so there is no Realtime and the page polls.
const accessGrant = ref(readAccessToken(props.slug))
const accessMode = ref(null)
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

let pushedLiveMatchId = null

function routeLocation(query) {
  return { query, hash: route.hash }
}

function setMobileSurface(surface) {
  if (!PUBLIC_MOBILE_SURFACES.includes(surface)) return
  mobileSurface.value = surface
  if (queryValue(route.query.view) === surface) return
  void router.replace(routeLocation({ ...route.query, view: surface }))
}

function openPublicLive(match) {
  const current = matches.value.find(row => row.id === match?.id)
  if (!current || !liveScoresByMatch.value[current.id]) return
  selectedLiveMatchId.value = current.id
  if (queryValue(route.query.live) === current.id) return
  pushedLiveMatchId = current.id
  void router.push(routeLocation({ ...route.query, live: current.id })).catch(() => {
    if (pushedLiveMatchId === current.id) pushedLiveMatchId = null
    selectedLiveMatchId.value = null
  })
}

function replaceWithoutLiveQuery() {
  const { live, ...query } = route.query
  if (live === undefined) return
  void router.replace(routeLocation(query))
}

function closePublicLive() {
  const matchId = selectedLiveMatchId.value || queryValue(route.query.live)
  const shouldGoBack = Boolean(matchId && pushedLiveMatchId === matchId && queryValue(route.query.live) === matchId)
  selectedLiveMatchId.value = null
  pushedLiveMatchId = null
  if (shouldGoBack) router.back()
  else replaceWithoutLiveQuery()
}

function syncPublicLiveFromRoute() {
  const matchId = queryValue(route.query.live)
  if (!matchId) {
    selectedLiveMatchId.value = null
    pushedLiveMatchId = null
    return
  }
  const exists = matches.value.some(match => match.id === matchId)
  if (exists && liveScoresByMatch.value[matchId]) {
    selectedLiveMatchId.value = matchId
    return
  }
  selectedLiveMatchId.value = null
  if (tournament.value && !loading.value) replaceWithoutLiveQuery()
}

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
const heroIcon = computed(() => SPORT_ICONS[tournament.value?.sport] || '🏆')
const heroChips = computed(() => {
  if (!tournament.value) return []
  const chips = [
    t(`sport.${tournament.value.sport}`),
    t(`tournamentFormat.${tournament.value.format}`),
  ]
  if (sportCfg.value.supportsCategory) chips.push(t(`tournament.${tournament.value.category}`))
  if (approvedEntries.value.length) {
    const reg = registration.value
    const total = reg?.capacity && reg.capacity_public !== false ? ` / ${reg.capacity}` : ''
    chips.push(`${t('tournament.participants')}: ${approvedEntries.value.length}${total}`)
  }
  return chips
})

const venueLinks = computed(() => (tournament.value
  ? venueRouteLinks(tournament.value, { platform: currentPlatform() })
  : []))
const showVenue = computed(() => hasVenue(tournament.value))

const rulesRows = computed(() => {
  const tr = tournament.value
  if (!tr) return []
  const rows = []
  if (sportCfg.value.supportsSetFormat && tr.set_format) {
    rows.push({ label: t('admin.setFormat'), value: t(`format.${tr.set_format}`) })
  }
  if (tr.sport === 'tennis') rows.push(...tennisRulesRows(tr.scoring_config, t))
  return rows
})

// The public page keeps one tab bar for every stage: registration while it is
// open, the bracket once there is something to draw, and the roster whenever
// entries exist — the roster used to vanish the moment the tournament started.
const hasBracketContent = computed(() => matches.value.length > 0 || groups.value.length > 0)
const showRegistrationTab = computed(() =>
  tournament.value?.status === 'registration_open' || registrationDirty.value,
)
const hasParticipants = computed(() => approvedEntries.value.length > 0 || pendingEntries.value.length > 0)

const publicTabs = computed(() => {
  if (!tournament.value) return []
  const tabs = []
  if (showRegistrationTab.value) {
    tabs.push({ id: 'registration', label: t('tournament.tabRegistration') })
  }
  if (hasBracketContent.value || showRegistrationTab.value) {
    tabs.push({
      id: 'bracket',
      label: t('tournament.tabBracket'),
      disabled: !hasBracketContent.value,
      tooltip: hasBracketContent.value ? '' : t('tournament.bracketLockedTooltip'),
    })
  }
  if (hasParticipants.value) {
    tabs.push({ id: 'participants', label: `${t('tournament.participants')} (${approvedEntries.value.length})` })
  }
  return tabs
})

function syncDefaultTab() {
  const s = tournament.value?.status
  if (s === 'registration_open' || registrationDirty.value) activeTab.value = 'registration'
  else if (hasBracketContent.value) activeTab.value = 'bracket'
  else if (hasParticipants.value) activeTab.value = 'participants'
  else activeTab.value = 'bracket'
}

// A tab can disappear under the reader: registration closes, the bracket is
// rebuilt away. Fall back to the first tab that can actually be opened.
watch(publicTabs, tabs => {
  if (!tabs.length) return
  if (tabs.some(tab => tab.id === activeTab.value && !tab.disabled)) return
  activeTab.value = (tabs.find(tab => !tab.disabled) || tabs[0]).id
})

function resetTournamentData() {
  tournament.value = null
  entries.value = []
  matches.value = []
  matchSets.value = []
  liveScores.value = []
  selectedLiveMatchId.value = null
  standings.value = []; groups.value = []; groupStandings.value = {}
  registration.value = null
  courts.value = []; schedule.value = []
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
  registration.value = data.registration || null
  courts.value = data.courts || []
  schedule.value = data.schedule || []
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
  const grant = accessGrant.value
  const read = grant
    ? () => readProtectedTournamentSnapshot(supabase, grant.tournament_id, grant.token)
    : createPublicTournamentReader(supabase, slug, {
      onResolve: id => {
        if (request !== loadVersion) return
        stopRealtime?.(); stopRealtime = null
        if (id) setupRealtime(id)
        else applySnapshot(null)
      },
    })
  refreshQueue = createSnapshotRefresh({
    read,
    apply: data => {
      applySnapshot(data)
      loading.value = false
      if (!data && !grant) void probeAccess(slug, request)
    },
    onError: error => {
      if (grant && isAccessExpiredError(error)) { expireAccess(); return }
      syncFailed.value = true
      if (!tournament.value) loadError.value = 'failed'
      loading.value = false
    },
  })
  stopRecovery = subscribeRefreshTriggers({ refresh: () => refreshQueue?.request() })
  await refreshQueue.refresh()
  if (request === loadVersion) { loading.value = false; syncDefaultTab() }
}

async function probeAccess(slug, request) {
  try {
    const mode = await probeTournamentAccess(supabase, slug)
    if (request === loadVersion) accessMode.value = mode
  } catch { /* the not-found state stays */ }
}

function expireAccess() {
  clearAccessToken(props.slug)
  accessGrant.value = null
  accessMode.value = 'password'
  loadVersion++
  teardownRealtime()
  resetTournamentData()
  loadError.value = ''
  loading.value = false
}

function onUnlocked(grant) {
  storeAccessToken(props.slug, grant)
  accessGrant.value = grant
  accessMode.value = null
  loadVersion++
  teardownRealtime()
  loadError.value = ''
  void initialLoad()
}

function setupRealtime(id) {
  stopRealtime = subscribeTournament({
    client: supabase, id, name: 'public', recover: false,
    getState: () => ({ entries: entries.value, matches: matches.value, sets: matchSets.value, live: liveScores.value, groups: groups.value }),
    refresh: () => refreshQueue?.request(),
    onStatus: status => { if (status !== 'SUBSCRIBED') syncFailed.value = true },
  })
}

watch(() => route.query.view, value => {
  mobileSurface.value = publicSurfaceFromQuery(value)
})

watch(
  [() => route.query.live, matches, liveScores, loading, () => tournament.value?.id],
  syncPublicLiveFromRoute,
  { immediate: true },
)

onMounted(() => {
  nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30_000)
  return initialLoad()
})

watch(
  () => props.slug,
  () => {
    loadVersion++
    teardownRealtime()
    registrationDirty.value = false
    loadError.value = ''
    pushedLiveMatchId = null
    accessGrant.value = readAccessToken(props.slug)
    accessMode.value = null
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

// Only explicitly public tournaments may be indexed; link-only pages ask crawlers to stay away.
watch(() => (tournament.value ? visibilityOf(tournament.value) : null), mode => setRobotsMeta(mode === 'public'), { immediate: true })

onBeforeUnmount(() => {
  loadVersion++
  clearInterval(nowTimer); nowTimer = null
  teardownRealtime()
  setRobotsMeta(true)
})
</script>

<template>
  <div class="stack">
    <section v-if="loading" class="card">
      <p class="muted">{{ t('actions.loading') }}</p>
    </section>

    <section v-else-if="accessMode === 'password' && !tournament" class="stack">
      <TournamentUnlock :slug="slug" @unlocked="onUnlocked" />
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
      <p v-if="accessGrant" class="muted" role="status" style="margin: 0">{{ t('access.unlock.polling') }}</p>
      <section class="card card--elevated pub-hero">
        <span class="pub-hero__icon" aria-hidden="true">{{ heroIcon }}</span>
        <div class="pub-hero__body">
          <div class="pub-hero__title-row">
            <h1 class="page-title" style="margin: 0">{{ tournament.name }}</h1>
            <span class="badge" :class="statusBadgeClass(tournament.status)">
              {{ t(`tournament.${tournament.status}`) }}
            </span>
          </div>
          <div class="pub-chips">
            <span v-for="(chip, i) in heroChips" :key="i" class="pub-chip">{{ chip }}</span>
          </div>
          <details
            v-if="tournament.description"
            class="pub-hero__details"
            :open="!isNarrowLayout"
          >
            <summary>{{ t('mobile.tournamentDetails') }}</summary>
            <p class="pub-hero__desc">{{ tournament.description }}</p>
          </details>
          <div v-if="showVenue" class="pub-venue">
            <svg class="pub-venue__pin" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z" />
              <circle cx="12" cy="10" r="2.6" />
            </svg>
            <span v-if="tournament.venue_address" class="pub-venue__address">{{ tournament.venue_address }}</span>
            <span v-if="venueLinks.length" class="pub-venue__links">
              <a
                v-for="link in venueLinks"
                :key="link.id"
                class="pub-venue__link"
                :href="link.url"
                target="_blank"
                rel="noopener noreferrer"
              >{{ t(`venue.map.${link.id}`) }}</a>
            </span>
          </div>
          <div v-if="tournament.publish_contact && (tournament.contact_phone || tournament.contact_email)" class="pub-contact">
            <strong>{{ t('mobile.organizerContacts') }}</strong>
            <a v-if="tournament.contact_phone" :href="`tel:${tournament.contact_phone}`">{{ tournament.contact_phone }}</a>
            <a v-if="tournament.contact_email" :href="`mailto:${tournament.contact_email}`">{{ tournament.contact_email }}</a>
          </div>
        </div>
      </section>

      <details v-if="rulesRows.length" class="card pub-rules">
        <summary class="pub-rules__summary">
          <span class="pub-rules__title">{{ t('tournament.rulesSection') }}</span>
          <span class="pub-rules__hint">{{ t('tournament.rulesSectionHint') }}</span>
        </summary>
        <dl class="pub-rules__list">
          <div v-for="(row, i) in rulesRows" :key="i" class="pub-rules__row" :class="{ 'pub-rules__row--note': !row.label }">
            <dt v-if="row.label">{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
      </details>

      <div v-if="publicTabs.length > 1" class="tab-group" role="tablist" :aria-label="t('tournament.tabsLabel')" @keydown="onTabKeydown">
        <template v-for="tab in publicTabs" :key="tab.id">
          <span v-if="tab.disabled" class="tooltip-wrapper" :data-tooltip="tab.tooltip">
            <button type="button" class="tab tab--disabled" role="tab" :aria-selected="false" :aria-disabled="true" disabled>
              {{ tab.label }}
            </button>
          </span>
          <button
            v-else
            type="button"
            class="tab"
            :class="{ 'tab--active': activeTab === tab.id }"
            role="tab"
            :id="`pub-tab-${tab.id}`"
            :aria-controls="`pub-${tab.id}-panel`"
            :aria-selected="activeTab === tab.id"
            :tabindex="activeTab === tab.id ? 0 : -1"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </template>
      </div>

      <div
        v-if="activeTab === 'registration' && showRegistrationTab"
        id="pub-registration-panel"
        role="tabpanel"
        aria-labelledby="pub-tab-registration"
      >
        <div class="pub-reg-split">
          <aside class="stack stack--sm pub-reg-side">
            <RegistrationConditions :registration="registration" :tournament="tournament" />
            <div v-if="hasParticipants" class="card pub-entries">
              <div class="pub-entries__head">
                <h3 class="section-title" style="margin: 0">{{ t('tournament.entriesSummary') }}</h3>
                <button class="pub-entries__link" type="button" @click="activeTab = 'participants'">
                  {{ t('tournament.viewParticipants') }}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
              <dl class="pub-entries__stats">
                <div class="pub-entries__stat">
                  <dd>{{ approvedEntries.length }}</dd>
                  <dt>{{ t('tournament.statApproved') }}</dt>
                </div>
                <div v-if="pendingEntries.length" class="pub-entries__stat pub-entries__stat--soft">
                  <dd>{{ pendingEntries.length }}</dd>
                  <dt>{{ t('tournament.statPending') }}</dt>
                </div>
              </dl>
            </div>
          </aside>
          <RegistrationForm
            v-if="regState.accepting || regState.waitlistOpen || registrationDirty"
            :key="tournament.id"
            :tournament="tournament"
            :registration="registration"
            :now="nowTick"
            :access-token="accessGrant?.token || ''"
            @dirty="registrationDirty = $event"
            @submitted="initialLoad"
          />
          <section v-else class="card">
            <p class="alert alert--info" role="status" style="margin: 0">{{ t(closedReasonKey(regState.reason)) }}</p>
          </section>
        </div>
      </div>

      <div
        v-else-if="activeTab === 'participants' && hasParticipants"
        id="pub-participants-panel"
        role="tabpanel"
        aria-labelledby="pub-tab-participants"
        class="card stack stack--sm"
      >
        <h3 class="section-title">{{ t('tournament.participants') }}</h3>
        <div v-if="approvedEntries.length" class="participant-list">
          <div v-for="entry in approvedEntries" :key="entry.id" class="participant-item">
            <strong>{{ entry.display_name }}</strong>
            <span class="badge badge--success">{{ t('tournament.approved') }}</span>
          </div>
        </div>
        <p v-else class="alert alert--info" style="margin: 0">
          {{ t('tournament.pendingParticipantsHint', { count: pendingEntries.length }) }}
        </p>
        <p v-if="approvedEntries.length && pendingEntries.length" class="muted" style="margin: 0">
          {{ t('tournament.pendingCount', { count: pendingEntries.length }) }}
        </p>
      </div>

      <div v-else id="pub-bracket-panel" role="tabpanel" aria-labelledby="pub-tab-bracket">
      <div v-if="!matches.length && !groups.length" class="card empty-state" role="status">
        <p>{{ t('bracket.empty') }}</p>
      </div>

      <template v-else-if="isNarrowLayout">
        <div class="mobile-surface-switch" role="tablist" :aria-label="t('tournament.tabsLabel')" @keydown="onTabKeydown">
          <button id="pub-tab-matches" type="button" role="tab" aria-controls="pub-mobile-panel" :tabindex="mobileSurface === 'matches' ? 0 : -1" :aria-selected="mobileSurface === 'matches'" :class="{ active: mobileSurface === 'matches' }" @click="setMobileSurface('matches')">
            {{ t('mobile.matches') }}
          </button>
          <button id="pub-tab-overview" type="button" role="tab" aria-controls="pub-mobile-panel" :tabindex="mobileSurface === 'overview' ? 0 : -1" :aria-selected="mobileSurface === 'overview'" :class="{ active: mobileSurface === 'overview' }" @click="setMobileSurface('overview')">
            {{ t('mobile.overview') }}
          </button>
        </div>

        <div id="pub-mobile-panel" role="tabpanel" :aria-labelledby="`pub-tab-${mobileSurface}`">
        <div v-if="mobileSurface === 'matches'" class="card mobile-match-card">
          <TournamentMatchList
            :matches="matches"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :live-scores-by-match="liveScoresByMatch"
            @view-live="openPublicLive"
          />
        </div>

        <template v-else-if="isRoundRobin">
          <div v-if="standings.length" class="card">
            <h3 class="section-title">{{ t('standings.title') }}</h3>
            <StandingsTable :rows="standings" :family="sportCfg.scoringFamily" />
          </div>
          <div v-if="matches.length" class="card rr-cross-card" style="margin-top: var(--space-4)">
            <h3 class="section-title">{{ t('standings.crossTable') }}</h3>
            <RoundRobinCrossTable :matches="matches" :entries-map="entriesMap" :standings="standings" :family="sportCfg.scoringFamily" :live-scores-by-match="liveScoresByMatch" @view-live="openPublicLive" />
          </div>
        </template>
        <template v-else-if="isGroupsPlayoff">
          <div v-if="groups.length" class="card"><h3 class="section-title">{{ t('admin.groupStage') }}</h3><GroupStageBoard :groups="groupsView" :entries-map="entriesMap" :family="sportCfg.scoringFamily" /></div>
          <div v-if="playoffMatches.length" class="card" style="margin-top: var(--space-4)"><h3 class="section-title">{{ t('admin.playoff') }}</h3><BracketBoard :matches="playoffMatches" :sets-by-match="setsByMatch" :entries-map="entriesMap" :live-scores-by-match="liveScoresByMatch" @view-live="openPublicLive" /></div>
        </template>
        <div v-else-if="isDoubleElim" class="card">
          <DoubleElimBoard :matches="matches" :sets-by-match="setsByMatch" :entries-map="entriesMap" :live-scores-by-match="liveScoresByMatch" @view-live="openPublicLive" />
        </div>
        <div v-else class="card">
          <BracketBoard :matches="matches" :sets-by-match="setsByMatch" :entries-map="entriesMap" :live-scores-by-match="liveScoresByMatch" @view-live="openPublicLive" />
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
            @view-live="openPublicLive"
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
            @view-live="openPublicLive"
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
          @view-live="openPublicLive"
        />
      </div>

      <div v-else class="card">
        <h3 class="section-title">{{ t('tournament.bracket') }}</h3>
        <BracketBoard
          :matches="matches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          @view-live="openPublicLive"
        />
      </div>
      </div>

      <LiveScoreViewerModal
        v-if="selectedLiveMatch && selectedLiveScore"
        :live-score="selectedLiveScore"
        :team-a="teamLabel(selectedLiveMatch.side_a_entry_id)"
        :team-b="teamLabel(selectedLiveMatch.side_b_entry_id)"
        @close="closePublicLive"
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
  padding: 4px 11px;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  white-space: nowrap;
}

.pub-rules {
  padding: 0;
  overflow: hidden;
}

.pub-rules__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 14px 18px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.pub-rules__summary::-webkit-details-marker { display: none; }

.pub-rules__summary::after {
  content: '';
  width: 7px;
  height: 7px;
  margin-left: auto;
  border-right: 2px solid var(--text-muted);
  border-bottom: 2px solid var(--text-muted);
  transform: rotate(45deg) translate(-2px, -2px);
  transition: transform .15s ease;
}

.pub-rules[open] .pub-rules__summary::after { transform: rotate(-135deg) translate(-2px, -2px); }

.pub-rules__summary:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}

.pub-rules__title { font-size: .92rem; font-weight: 750; color: var(--text); }
.pub-rules__hint { font-size: .8rem; color: var(--text-muted); }

.pub-rules__list {
  display: grid;
  gap: 1px;
  margin: 0;
  padding: 0 18px 14px;
  background: transparent;
}

.pub-rules__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  padding: 9px 0;
  border-top: 1px solid var(--border);
}

.pub-rules__row dt {
  font-size: .82rem;
  color: var(--text-muted);
}

.pub-rules__row dd {
  margin: 0;
  font-size: .86rem;
  font-weight: 600;
  text-align: right;
  color: var(--text);
}

.pub-rules__row--note dd {
  font-weight: 400;
  text-align: left;
  color: var(--text-muted);
}

.pub-reg-solo {
  max-width: 560px;
  margin: 0 auto;
}

/* Registration tab: terms on the left, the form on the right. The form is the
   taller column, so the side column stays at the top instead of stretching. */
.pub-reg-split {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}

.pub-reg-split > * { min-width: 0; }

@media (min-width: 900px) {
  .pub-reg-split {
    grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr);
    gap: var(--space-5);
  }

  /* The form leads on wide screens; the terms stay first in the DOM so the
     narrow layout still reads terms → entries → form. */
  .pub-reg-side { order: 2; }
}

.pub-entries {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pub-entries__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.pub-entries__link {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: .82rem;
  font-weight: 600;
  color: var(--primary);
  cursor: pointer;
  white-space: nowrap;
}

.pub-entries__link span { transition: transform .15s ease; }
.pub-entries__link:hover span { transform: translateX(2px); }
.pub-entries__link:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; border-radius: 4px; }

.pub-entries__stats {
  display: flex;
  gap: 10px;
  margin: 0;
}

.pub-entries__stat {
  flex: 1 1 0;
  min-width: 0;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--primary-muted);
}

.pub-entries__stat--soft { background: var(--surface-2); }

.pub-entries__stat dd {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.pub-entries__stat dt {
  margin-top: 6px;
  font-size: .72rem;
  font-weight: 600;
  letter-spacing: .03em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.pub-hero__desc {
  margin: var(--space-3) 0 0;
  color: var(--text);
  line-height: 1.6;
}

.pub-hero__details summary { display: none; }
/* Venue: the address plus one route link per navigator the viewer may have. */
.pub-venue {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-top: 12px;
  font-size: .86rem;
}

.pub-venue__pin { width: 16px; height: 16px; flex-shrink: 0; fill: none; stroke: var(--text-muted); stroke-width: 1.8; }
.pub-venue__address { overflow-wrap: anywhere; }

.pub-venue__links { display: inline-flex; flex-wrap: wrap; gap: 6px; }

.pub-venue__link {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: .78rem;
  font-weight: 600;
  color: var(--primary);
  white-space: nowrap;
}

.pub-venue__link:hover { background: var(--primary-muted); border-color: var(--primary-muted); }

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
  .pub-chip { padding: 3px 9px; font-size: .74rem; }
  .pub-rules__summary { padding: 12px 14px; }
  .pub-rules__list { padding: 0 14px 12px; }
  .pub-rules__row { flex-direction: column; gap: 2px; padding: 8px 0; }
  .pub-rules__row dd { text-align: left; }
  .pub-hero__details { margin-top: 8px; }
  .pub-hero__details summary { display: list-item; color: var(--primary); font-size: .84rem; font-weight: 750; cursor: pointer; }
  .pub-hero__desc { margin-top: 8px; font-size: .9rem; line-height: 1.45; }
  .mobile-match-card { padding: 14px; }
}
</style>
