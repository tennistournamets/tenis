<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import BracketBoard from '../components/BracketBoard.vue'
import StandingsTable from '../components/StandingsTable.vue'
import RoundRobinCrossTable from '../components/RoundRobinCrossTable.vue'
import RoundRobinStandings from '../components/RoundRobinStandings.vue'
import MatchScoreModal from '../components/MatchScoreModal.vue'
import FootballScoreEditor from '../components/FootballScoreEditor.vue'
import GroupStageBoard from '../components/GroupStageBoard.vue'
import DoubleElimBoard from '../components/DoubleElimBoard.vue'
import { scoringFamily, getSportConfig } from '../lib/sportConfig'
import { scoringAccess, matchScoringAction } from '../lib/scoringAccess'
import LiveScoringModal from '../components/LiveScoringModal.vue'
import TournamentQrModal from '../components/TournamentQrModal.vue'
import ScoreEditor from '../components/ScoreEditor.vue'
import ManualEntryForm from '../components/admin/ManualEntryForm.vue'
import TournamentSettingsForm from '../components/admin/TournamentSettingsForm.vue'
import TournamentMatchList from '../components/TournamentMatchList.vue'
import { scoringError } from '../lib/tennisRules'
import { sameForm, cloneForm, matchVersions } from '../lib/formDraft'
import { useUnsavedChanges, confirmDiscard, withApprovedDeparture } from '../lib/unsavedChanges'
import { entryMemberNames } from '../lib/entryDisplay'
import { confirmDialog } from '../lib/confirmDialog'
import { supabase } from '../lib/supabase'
import { createSnapshotRefresh, subscribeTournament } from '../lib/tournamentSync'
import { readAdminTournamentSnapshot } from '../lib/tournamentRepository'
import { indexEntries, groupSetsByMatch, indexLiveScores, buildGroupsView } from '../lib/tournamentProjections'
import CopyTournamentLink from '../components/CopyTournamentLink.vue'
import { useAuthStore } from '../stores/auth'
import { useNarrowLayout } from '../lib/useNarrowLayout'
import { useHeaderTitle } from '../lib/headerTitle'
import { onTabKeydown as onSurfaceTabKeydown } from '../lib/tabNavigation'

const props = defineProps({
  id: {
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
const auth = useAuthStore()
const isNarrowLayout = useNarrowLayout()
const ADMIN_MOBILE_SURFACES = ['matches', 'overview']
const queryValue = value => Array.isArray(value) ? value[0] : value
const adminSurfaceFromQuery = value => ADMIN_MOBILE_SURFACES.includes(queryValue(value))
  ? queryValue(value)
  : 'matches'
const adminMobileBracketSurface = ref(adminSurfaceFromQuery(route.query.surface))

function adminRouteLocation(query) {
  return { query, hash: window.location.hash || route.hash }
}

function setAdminMobileBracketSurface(surface) {
  if (!ADMIN_MOBILE_SURFACES.includes(surface)) return
  adminMobileBracketSurface.value = surface
  if (queryValue(route.query.surface) === surface) return
  void router.replace(adminRouteLocation({ ...route.query, surface }))
}

const tournament = ref(null)
useHeaderTitle(() => tournament.value?.name)
const entries = ref([])
const matches = ref([])
const standings = ref([])
const groups = ref([])
const groupStandings = ref({}) // group_id -> standings rows
const groupCount = ref(2)
const matchSets = ref([])
const liveScores = ref([])
const admins = ref([])
const currentUserRole = ref(null)

const loading = ref(false)
const actionLoading = ref(false)
const errorText = ref('')
const qrModalOpen = ref(false)

const settingsSaving = ref(false)
function acceptTournament(data) {
  if (tournament.value && data.settings_revision < tournament.value.settings_revision) return
  tournament.value = data
}
const drawMode = ref('auto-random')
const bracketEditing = ref(false)
const localMatches = ref([])
const selectedLiveMatch = ref(null)

const addAdminForm = reactive({
  email: '',
  role: 'editor',
})

const manualPairingOpen = ref(false)
const pairingBaseline = ref(null)
const pairingInitialSlots = ref([])
const slotIds = slots => slots.map(s => [s.playerA?.memberId || null, s.playerB?.memberId || null])
const pairingDirty = computed(() => manualPairingOpen.value && !sameForm(slotIds(manualPairSlots.value), pairingInitialSlots.value))
const pairingConflict = computed(() => manualPairingOpen.value && pairingBaseline.value && (
  isTournamentActive.value || isTournamentFinished.value ||
  !sameForm(pairingBaseline.value.entries, entryEditState.value?.entries) ||
  !sameForm(pairingBaseline.value.matches, matchVersions(matches.value)) ||
  pairingBaseline.value.settings_revision !== tournament.value?.settings_revision))
const manualPairSlots = ref([])
const manualPairingDragOver = ref(null)
const selectedPairPlayer = ref(null)
const pairingEditMode = ref(false)
const editModePlayers = ref([])

let stopRealtime = null
let disposed = false
const syncFailed = ref(false)

const entriesMap = computed(() => indexEntries(entries.value))
const setsByMatch = computed(() => groupSetsByMatch(matchSets.value))
const liveScoresByMatch = computed(() => indexLiveScores(liveScores.value))

const pendingEntries = computed(() => entries.value.filter((entry) => entry.status === 'pending'))
const rejectedEntries = computed(() => entries.value.filter((entry) => entry.status === 'rejected'))
const approvedEntries = computed(() => entries.value.filter((entry) => entry.status === 'approved'))

const unpairedEntries = computed(() => {
  if (!isPickRandomDoubles.value) return []
  return approvedEntries.value.filter(
    (e) => !e.entry_members || e.entry_members.length < 2
  )
})

const unpairedCount = computed(() => unpairedEntries.value.length)

const isPickRandomDoubles = computed(() =>
  tournament.value?.category === 'doubles' && tournament.value?.doubles_pairing_mode === 'pick_random'
)

const allPairingPlayers = computed(() =>
  pairingEditMode.value ? editModePlayers.value : unpairedEntries.value
)

const unassignedPlayers = computed(() => {
  const assigned = new Set()
  for (const slot of manualPairSlots.value) {
    if (slot.playerA) assigned.add(slot.playerA.id)
    if (slot.playerB) assigned.add(slot.playerB.id)
  }
  return allPairingPlayers.value.filter((e) => !assigned.has(e.id))
})

const completePairsCount = computed(() =>
  manualPairSlots.value.filter((s) => s.playerA && s.playerB).length
)

const hasPairedEntries = computed(() => {
  if (!isPickRandomDoubles.value) return false
  return approvedEntries.value.some((e) => e.entry_members && e.entry_members.length >= 2)
})

function entryLabel(entry) {
  const names = entryMemberNames(entry)
  return names.length ? names.join(' / ') : entry.display_name
}

function entryInitials(entry) {
  const label = entryLabel(entry) || '?'
  return label
    .split(/[\s/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

function teamLabel(entryId) {
  if (!entryId) {
    return t('bracket.tbd')
  }
  const entry = entriesMap.value[entryId]
  if (!entry) {
    return t('bracket.tbd')
  }
  return entryLabel(entry)
}

const showPublicShareActions = computed(() => {
  return tournament.value?.status !== 'draft'
})

const canStartTournament = computed(
  () => tournament.value?.status === 'registration_closed' && matches.value.length > 0,
)
const isTournamentActive = computed(() => tournament.value?.status === 'in_progress')
const isTournamentFinished = computed(() => tournament.value?.status === 'completed')
const showAdminBracketOverview = computed(() => !isNarrowLayout.value || !isTournamentActive.value || adminMobileBracketSurface.value === 'overview')
const scoreAccess = computed(() => scoringAccess(tournament.value, currentUserRole.value))
const canManageTournament = computed(() => scoreAccess.value.manager)
const canLiveScoreRole = computed(() => ['owner', 'editor', 'counter'].includes(currentUserRole.value))
const canEditScores = computed(() => scoreAccess.value.scores)
const canUseLiveScoring = computed(() => scoreAccess.value.live)
const canEditFinalScores = computed(() => scoreAccess.value.final)

const showStartButton = computed(() => {
  const s = tournament.value?.status
  return canManageTournament.value && (s === 'draft' || s === 'registration_open' || s === 'registration_closed')
})

// Concrete reason why "Start tournament" is disabled (shown as tooltip).
const startBlockReason = computed(() => {
  if (canStartTournament.value) return null
  if (tournament.value?.status !== 'registration_closed') return t('admin.startNeedRegClosed')
  return t('admin.startNeedBracket')
})

async function startTournament() {
  if (actionLoading.value || settingsSaving.value) return
  const revision = tournament.value.settings_revision
  actionLoading.value = true
  errorText.value = ''
  try {
    if (!(await confirmDialog(t('admin.startTournamentConfirm')))) return
    const { data, error } = await supabase.rpc('update_tournament_settings', {
      p_tournament_id: props.id, p_patch: { status: 'in_progress' }, p_expected_revision: revision,
    })
    if (error) throw error
    acceptTournament(data)
    await loadAll(true)
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    try { await loadTournament() } catch { /* Keep the actionable mutation error. */ }
  } finally { actionLoading.value = false }
}

async function finishTournament() {
  if (actionLoading.value || settingsSaving.value) return
  const revision = tournament.value.settings_revision
  actionLoading.value = true
  errorText.value = ''
  try {
    if (!(await confirmDialog(t('admin.finishTournamentConfirm')))) return
    const { data, error } = await supabase.rpc('update_tournament_settings', {
      p_tournament_id: props.id, p_patch: { status: 'completed' }, p_expected_revision: revision,
    })
    if (error) throw error
    acceptTournament(data)
    await loadAll(true)
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    try { await loadTournament() } catch { /* Keep the actionable mutation error. */ }
  } finally { actionLoading.value = false }
}

async function stopTournament() {
  if (actionLoading.value || settingsSaving.value) return
  const revision = tournament.value.settings_revision
  actionLoading.value = true
  errorText.value = ''
  try {
    if (!(await confirmDialog(t('admin.stopTournamentConfirm')))) return
    const { data, error } = await supabase.rpc('update_tournament_settings', {
      p_tournament_id: props.id, p_patch: { status: 'registration_closed' }, p_expected_revision: revision,
    })
    if (error) throw error
    acceptTournament(data)
    await loadAll(true)
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    try { await loadTournament() } catch { /* Keep the actionable mutation error. */ }
  } finally { actionLoading.value = false }
}

const entryEditState = ref(null)
let adminListStale = true
const snapshotRefresh = createSnapshotRefresh({
  read: () => readAdminTournamentSnapshot(supabase, props.id, { includeAdmins: adminListStale }),
  apply: ({ data, role, adminRows }) => {
    currentUserRole.value = role
    if (!data || !role) {
      syncFailed.value = true
      errorText.value = t('errors.noAccess')
      throw new Error(t('errors.noAccess'))
    }
    if (errorText.value === t('errors.noAccess')) errorText.value = ''
    if (adminRows) { admins.value = adminRows; adminListStale = false }
    acceptTournament(data.tournament)
    entries.value = data.entries
    matches.value = data.matches
    matchSets.value = data.sets
    liveScores.value = data.live
    if (selectedLiveMatch.value && !data.matches.some(m => m.id === selectedLiveMatch.value.id)) selectedLiveMatch.value = null
    groups.value = data.groups
    standings.value = data.standings
    groupStandings.value = data.group_standings
    entryEditState.value = { entries: [...data.entries].sort((a,b) => a.id.localeCompare(b.id)),
      matches: matchVersions(data.matches), settings_revision: data.tournament.settings_revision }
    syncFailed.value = false
  },
  onError: error => {
    syncFailed.value = true
    if (!tournament.value) errorText.value = error.message || t('errors.generic')
  },
})

async function refreshScoreData() { return snapshotRefresh.refresh() }
function scheduleScoreReload() { snapshotRefresh.request() }
async function loadMatchesAndSets() {
  if (!(await refreshScoreData())) throw new Error(t('sync.unavailable'))
}
async function loadTournament() { return loadMatchesAndSets() }
async function loadEntries() { return loadMatchesAndSets() }

async function loadAll() {
  if (!auth.user || disposed) return
  if (!tournament.value) loading.value = true
  if (!stopRealtime) setupRealtime()
  adminListStale = true
  try {
    await refreshScoreData()
  } finally { if (!disposed) loading.value = false }
}

function setupRealtime() {
  stopRealtime?.()
  stopRealtime = subscribeTournament({
    client: supabase, id: props.id, name: 'admin',
    getState: () => ({ entries: entries.value, matches: matches.value, sets: matchSets.value, live: liveScores.value, groups: groups.value }),
    refresh: payload => {
      if (!payload || payload.table === 'tournament_admins') adminListStale = true
      snapshotRefresh.request()
    },
    onStatus: status => { if (status !== 'SUBSCRIBED') syncFailed.value = true },
  })
}

async function updateEntryStatus(entryId, status) {
  if (actionLoading.value) return
  actionLoading.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.from('entries').update({ status }).eq('id', entryId)
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function approveAllPending() {
  if (actionLoading.value) return
  if (pendingEntries.value.length < 2) {
    return
  }
  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('admin.approveAllConfirm')))) return
    errorText.value = ''
    const { error } = await supabase
      .from('entries')
      .update({ status: 'approved' })
      .eq('tournament_id', props.id)
      .eq('status', 'pending')
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

const hasBracket = computed(() => matches.value.length > 0)
const tournamentFormat = computed(() => tournament.value?.format || 'single_elimination')
const isRoundRobin = computed(() => tournamentFormat.value === 'round_robin')
const isGroupsPlayoff = computed(() => tournamentFormat.value === 'groups_playoff')
const isDoubleElim = computed(() => tournamentFormat.value === 'double_elimination')
const tournamentScoringFamily = computed(() => scoringFamily(tournament.value?.sport || 'tennis'))
const isGoalsSport = computed(() => tournamentScoringFamily.value === 'goals')
const sportCfg = computed(() => getSportConfig(tournament.value?.sport || 'tennis'))

const groupMatches = computed(() => matches.value.filter((m) => m.stage === 'group'))
const playoffMatches = computed(() =>
  matches.value.filter((m) => ['winners', 'grand_final', 'third_place'].includes(m.stage)),
)
const hasGroups = computed(() => groups.value.length > 0)
const hasPlayoff = computed(() => playoffMatches.value.length > 0)
const allGroupMatchesFinished = computed(
  () => groupMatches.value.length > 0 && groupMatches.value.every((m) => m.status === 'finished'),
)
const groupsView = computed(() =>
  buildGroupsView(groups.value, matches.value, groupStandings.value),
)
const selectedRrMatch = ref(null)

function openRrMatch(match) {
  const current = matches.value.find(row => row.id === match?.id)
  if (!current || !matchScoringAction(tournament.value, currentUserRole.value, current)) return
  if (!canEditFinalScores.value) return openLiveScoring(current)
  openAdminScoreRoute(current, 'result')
}

function startLiveFromRrModal(match) {
  const current = matches.value.find(row => row.id === match?.id)
  if (matchScoringAction(tournament.value, currentUserRole.value, current) !== 'live') return
  replaceAdminScoreRoute(current, 'live')
}

async function formRandomPairs() {
  if (actionLoading.value) return
  if (unpairedCount.value % 2 !== 0) {
    errorText.value = t('admin.oddUnpairedWarning', { count: unpairedCount.value })
    return
  }

  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('admin.formPairsConfirm')))) return
    errorText.value = ''
    const { error } = await supabase.rpc('form_random_pairs', {
      p_tournament_id: props.id,
    })
    if (error) throw error
    await loadEntries()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

function openManualPairing() {
  if (manualPairingOpen.value || actionLoading.value || isTournamentActive.value || isTournamentFinished.value || !isPickRandomDoubles.value) return
  const count = unpairedEntries.value.length
  const slotCount = Math.ceil(count / 2)
  manualPairSlots.value = Array.from({ length: slotCount }, (_, i) => ({
    slotIndex: i,
    playerA: null,
    playerB: null,
  }))
  pairingBaseline.value = cloneForm(entryEditState.value)
  pairingInitialSlots.value = slotIds(manualPairSlots.value)
  manualPairingOpen.value = true
}

async function closeManualPairing(force = false) {
  if (force !== true && !(await confirmDiscard(t, pairingDirty.value, actionLoading.value))) return
  manualPairingOpen.value = false
  manualPairSlots.value = []
  manualPairingDragOver.value = null
  selectedPairPlayer.value = null
  pairingEditMode.value = false
  editModePlayers.value = []
  pairingBaseline.value = null
  pairingInitialSlots.value = []
}

function findEntryById(id) {
  const entry = allPairingPlayers.value.find(e => e.id === id)
  return entry ? { ...entry, memberId: entry.memberId || entry.entry_members?.[0]?.id } : null
}

const isDragging = ref(false)

function onPlayerDragStart(event, entry, fromSlot, fromPosition) {
  if (actionLoading.value) { event.preventDefault(); return }
  event.dataTransfer.setData(
    'application/json',
    JSON.stringify({
      entryId: entry.id,
      fromSlot: fromSlot ?? null,
      fromPosition: fromPosition ?? null,
    }),
  )
  event.dataTransfer.effectAllowed = 'move'
  isDragging.value = true
}

function onPlayerDragEnd() {
  isDragging.value = false
  manualPairingDragOver.value = null
}

function onSlotDragOver(event, slotIndex, position) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  manualPairingDragOver.value = `${slotIndex}-${position}`
}

function onSlotDragLeave(event, slotIndex, position) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  if (manualPairingDragOver.value === `${slotIndex}-${position}`) {
    manualPairingDragOver.value = null
  }
}

function onSlotDrop(event, slotIndex, position) {
  event.preventDefault()
  if (actionLoading.value) return
  manualPairingDragOver.value = null
  isDragging.value = false

  let payload
  try {
    payload = JSON.parse(event.dataTransfer.getData('application/json') || '{}')
  } catch {
    return
  }
  movePairPlayer(payload, slotIndex, position)
}

function movePairPlayer(payload, slotIndex, position) {
  if (!payload?.entryId || actionLoading.value) return

  const entry = findEntryById(payload.entryId)
  if (!entry) return

  const isSameSlot = payload.fromSlot === slotIndex && payload.fromPosition === position
  if (isSameSlot) return

  const slot = manualPairSlots.value[slotIndex]
  const targetKey = position === 'A' ? 'playerA' : 'playerB'
  const existing = slot[targetKey]

  if (payload.fromSlot !== null && payload.fromSlot !== undefined) {
    const srcSlot = manualPairSlots.value[payload.fromSlot]
    const srcKey = payload.fromPosition === 'A' ? 'playerA' : 'playerB'
    srcSlot[srcKey] = existing || null
  }

  slot[targetKey] = entry
}

function selectPairPlayer(entry, fromSlot = null, fromPosition = null) {
  if (actionLoading.value) return
  const current = selectedPairPlayer.value
  if (current?.entryId === entry.id && current?.fromSlot === fromSlot && current?.fromPosition === fromPosition) {
    selectedPairPlayer.value = null
    return
  }
  selectedPairPlayer.value = { entryId: entry.id, fromSlot, fromPosition }
}

function assignSelectedPlayer(slotIndex, position) {
  if (!selectedPairPlayer.value) return
  movePairPlayer(selectedPairPlayer.value, slotIndex, position)
  selectedPairPlayer.value = null
}

function activatePairSlot(entry, slotIndex, position) {
  if (selectedPairPlayer.value) assignSelectedPlayer(slotIndex, position)
  else if (entry) selectPairPlayer(entry, slotIndex, position)
}

function removeFromSlot(slotIndex, position) {
  if (actionLoading.value) return
  const key = position === 'A' ? 'playerA' : 'playerB'
  manualPairSlots.value[slotIndex][key] = null
  selectedPairPlayer.value = null
}

async function reloadPairingDraft() {
  if (!(await confirmDiscard(t, pairingDirty.value, actionLoading.value))) return
  const edit = pairingEditMode.value
  actionLoading.value = true
  try { await loadMatchesAndSets() }
  catch { errorText.value = t('drafts.unavailable'); return }
  finally { actionLoading.value = false }
  await closeManualPairing(true)
  if (edit) openEditPairing(); else openManualPairing()
}
async function saveManualPairs() {
  if (actionLoading.value || !pairingDirty.value) return
  if (pairingConflict.value) { errorText.value = t('drafts.structureConflict'); return }
  const pairs = manualPairSlots.value.filter(s => s.playerA && s.playerB).map(s => [s.playerA.memberId,s.playerB.memberId])
  if (!pairs.length) return
  const baseline = cloneForm(pairingBaseline.value)
  actionLoading.value = true
  errorText.value = ''
  try {
    if (matches.value.length && !(await confirmDialog(t('drafts.pairingReset'), { danger: true }))) return
    const { error } = await supabase.rpc('save_tournament_pairs', {
      p_tournament_id: props.id, p_pairs: pairs, p_replace: pairingEditMode.value,
      p_expected_entries: baseline.entries, p_expected_matches: baseline.matches,
      p_expected_revision: baseline.settings_revision,
    })
    if (error) throw error
    await closeManualPairing(true)
    await loadAll(true)
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    try { await loadEntries() } catch { /* Preserve the local pairing draft. */ }
  } finally { actionLoading.value = false }
}

function openEditPairing() {
  if (manualPairingOpen.value || actionLoading.value || isTournamentActive.value || isTournamentFinished.value || !isPickRandomDoubles.value) return
  const players = []
  const slots = []
  let virtualId = 0

  for (const entry of approvedEntries.value) {
    const members = entry.entry_members || []
    const m1 = members.find((m) => m.member_order === 1)
    const m2 = members.find((m) => m.member_order === 2)

    if (m1 && m2) {
      const playerA = { id: `edit-${virtualId++}`, display_name: m1.member_name, memberId: m1.id, _sourceEntryId: entry.id, _memberName: m1.member_name, entry_members: [m1] }
      const playerB = { id: `edit-${virtualId++}`, display_name: m2.member_name, memberId: m2.id, _sourceEntryId: entry.id, _memberName: m2.member_name, entry_members: [{ ...m2, member_order: 1 }] }
      players.push(playerA, playerB)
      slots.push({ slotIndex: slots.length, playerA, playerB })
    } else if (m1) {
      const playerA = { id: entry.id, display_name: m1.member_name, memberId: m1.id, _sourceEntryId: entry.id, _memberName: m1.member_name, entry_members: [m1] }
      players.push(playerA)
    }
  }

  const unslotted = players.filter((p) => !slots.some((s) => s.playerA === p || s.playerB === p))
  const totalSlotCount = Math.max(slots.length, Math.ceil(players.length / 2))
  while (slots.length < totalSlotCount) {
    const next = unslotted.shift() || null
    slots.push({ slotIndex: slots.length, playerA: next, playerB: null })
  }

  editModePlayers.value = players
  manualPairSlots.value = slots
  pairingEditMode.value = true
  pairingBaseline.value = cloneForm(entryEditState.value)
  pairingInitialSlots.value = slotIds(manualPairSlots.value)
  manualPairingOpen.value = true
  nextTick(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  })
}

async function generateBracket() {
  if (actionLoading.value) return
  const fn = hasBracket.value ? 'rebuild_bracket' : 'generate_bracket'

  actionLoading.value = true
  try {
    if (hasBracket.value && !(await confirmDialog(t('admin.rebuildConfirm')))) return
    errorText.value = ''
    const { error } = await supabase.rpc(fn, {
      p_tournament_id: props.id,
      p_mode: drawMode.value,
      p_manual_order: null,
    })
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function generateGroups() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (hasGroups.value && !(await confirmDialog(t('admin.rebuildConfirm')))) return
    errorText.value = ''
    const { error } = await supabase.rpc('generate_groups', {
      p_tournament_id: props.id,
      p_group_count: Number(groupCount.value) || 2,
    })
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function startPlayoff() {
  if (actionLoading.value) return
  actionLoading.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('generate_group_playoff', {
      p_tournament_id: props.id,
    })
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function generateSchedule() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (hasBracket.value && !(await confirmDialog(t('admin.rebuildConfirm')))) return
    errorText.value = ''
    const { error } = await supabase.rpc('generate_round_robin', {
      p_tournament_id: props.id,
    })
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function resetBracket() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('admin.resetBracketConfirm'), { danger: true }))) return
    errorText.value = ''
    const { error } = await supabase
      .from('matches')
      .delete()
      .eq('tournament_id', props.id)
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

const displayMatches = computed(() =>
  bracketEditing.value ? localMatches.value : matches.value
)

const bracketBaseline = ref([])
const bracketHasChanges = computed(() => bracketEditing.value && !sameForm(
  localMatches.value.map(m => [m.id,m.side_a_entry_id,m.side_b_entry_id]),
  bracketBaseline.value.map(m => [m.id,m.side_a_entry_id,m.side_b_entry_id])))
const bracketConflict = computed(() => bracketEditing.value && (isTournamentActive.value || isTournamentFinished.value || !sameForm(matchVersions(bracketBaseline.value),matchVersions(matches.value))))
function startBracketEditing() {
  if (bracketEditing.value) return
  bracketBaseline.value = cloneForm(matches.value)
  localMatches.value = cloneForm(matches.value)
  bracketEditing.value = true
}
async function cancelBracketEditing(force = false) {
  if (force !== true && !(await confirmDiscard(t, bracketHasChanges.value, actionLoading.value))) return
  bracketEditing.value = false
  localMatches.value = []
  bracketBaseline.value = []
}
async function reloadBracketDraft() {
  if (!(await confirmDiscard(t, bracketHasChanges.value, actionLoading.value))) return
  actionLoading.value = true
  try { await loadMatchesAndSets() }
  catch { errorText.value = t('drafts.unavailable'); return }
  finally { actionLoading.value = false }
  await cancelBracketEditing(true)
  startBracketEditing()
}

function swapBracketSlots(payload) {
  if (actionLoading.value || isTournamentActive.value || isTournamentFinished.value) return
  if (!payload?.fromMatchId || !payload?.toMatchId || !payload?.fromSide || !payload?.toSide) {
    return
  }

  if (!bracketEditing.value) {
    startBracketEditing()
  }

  const arr = localMatches.value
  const fromMatch = arr.find((m) => m.id === payload.fromMatchId)
  const toMatch = arr.find((m) => m.id === payload.toMatchId)
  if (!fromMatch || !toMatch) return

  const fromKey = payload.fromSide === 'a' ? 'side_a_entry_id' : 'side_b_entry_id'
  const toKey = payload.toSide === 'a' ? 'side_a_entry_id' : 'side_b_entry_id'

  const tmp = fromMatch[fromKey]
  fromMatch[fromKey] = toMatch[toKey]
  toMatch[toKey] = tmp
}

async function saveBracketLayout() {
  if (actionLoading.value) return
  if (bracketConflict.value) { errorText.value = t('drafts.structureConflict'); return }
  const changed = localMatches.value.filter((lm) => {
    const orig = bracketBaseline.value.find((m) => m.id === lm.id)
    if (!orig) return false
    return orig.side_a_entry_id !== lm.side_a_entry_id || orig.side_b_entry_id !== lm.side_b_entry_id
  })

  if (!changed.length) {
    cancelBracketEditing()
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const layout = changed.map((m) => ({
    match_id: m.id,
    side_a_entry_id: m.side_a_entry_id || null,
    side_b_entry_id: m.side_b_entry_id || null,
  }))

  try {
    const { error } = await supabase.rpc('save_bracket_layout', {
      p_tournament_id: props.id,
      p_layout: layout,
      p_expected_matches: matchVersions(bracketBaseline.value),
    })
    if (error) throw error
    await cancelBracketEditing(true)
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    try { await loadMatchesAndSets() } catch { /* Keep the local layout draft and original error. */ }
  } finally { actionLoading.value = false }
}

async function addAdmin() {
  if (actionLoading.value) return
  if (!addAdminForm.email) {
    return
  }

  actionLoading.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('add_tournament_admin_by_email', {
      p_tournament_id: props.id,
      p_email: addAdminForm.email,
      p_role: addAdminForm.role,
    })
    if (error) throw error
    addAdminForm.email = ''
    addAdminForm.role = 'editor'
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function removeAdmin(adminId) {
  if (actionLoading.value) return
  actionLoading.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('remove_tournament_admin', {
      p_tournament_id: props.id,
      p_admin_id: adminId,
    })
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function deleteTournament() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('admin.deleteTournamentConfirm'), { danger: true }))) return
    errorText.value = ''
    stopRealtime?.(); stopRealtime = null
    const { error } = await supabase.from('tournaments').delete().eq('id', props.id)
    if (error) throw error
    unregisterDrafts()
    await withApprovedDeparture(() => router.replace({ name: 'admin-tournaments' }))
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    if (!stopRealtime) setupRealtime()
  } finally { actionLoading.value = false }
}

function statusBadgeClass(status) {
  if (status === 'completed') {
    return 'badge--done'
  }
  if (status === 'in_progress') {
    return 'badge--live'
  }
  if (status === 'registration_open') {
    return 'badge--success'
  }
  return 'badge--neutral'
}

const TABS = ['entries', 'bracket', 'scores', 'settings']

function isTabEnabled(tab) {
  if (tab === 'bracket') return true
  if (tab === 'scores') return canEditScores.value
  return canManageTournament.value
}

const enabledTabs = computed(() => TABS.filter(isTabEnabled))
const defaultTab = () => canManageTournament.value ? 'entries' : canEditScores.value ? 'scores' : 'bracket'

function readHashTab() {
  const h = window.location.hash.replace('#', '')
  const fallback = defaultTab()
  if (!TABS.includes(h)) return fallback
  return isTabEnabled(h) ? h : fallback
}

const activeTab = ref(readHashTab())

function setTab(tab) {
  if (!TABS.includes(tab) || !isTabEnabled(tab)) {
    return
  }
  activeTab.value = tab
  history.replaceState(null, '', `#${tab}`)
}

function syncTabFromHash() {
  const requestedTab = window.location.hash.replace('#', '')
  const nextTab = readHashTab()
  if (requestedTab && requestedTab !== nextTab) {
    setTab(nextTab)
    return
  }
  activeTab.value = nextTab
}

function onHashChange() {
  syncTabFromHash()
}

function onTabKeydown(event) {
  const tabs = enabledTabs.value
  if (!tabs.length) return
  const idx = Math.max(tabs.indexOf(activeTab.value), 0)
  let next = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    next = (idx + 1) % tabs.length
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    next = (idx - 1 + tabs.length) % tabs.length
  } else if (event.key === 'Home') {
    next = 0
  } else if (event.key === 'End') {
    next = tabs.length - 1
  }
  if (next >= 0) {
    event.preventDefault()
    setTab(tabs[next])
    nextTick(() => {
      const btn = document.getElementById(`tab-${tabs[next]}`)
      btn?.focus()
    })
  }
}

watch(canEditScores, () => {
  if (!isTabEnabled(activeTab.value)) {
    setTab(defaultTab())
  }
})

watch(canManageTournament, () => {
  if (!isTabEnabled(activeTab.value)) {
    setTab(defaultTab())
  }
})

function openLiveScoring(match) {
  const current = matches.value.find(row => row.id === match?.id)
  const action = matchScoringAction(tournament.value, currentUserRole.value, current)
  if (action === 'live' || action === 'result') openAdminScoreRoute(current, action)
}

const selectedLiveScore = computed(() => (
  selectedLiveMatch.value ? liveScoresByMatch.value[selectedLiveMatch.value.id] : null
))

let pushedScoreRouteKey = null
const scoreRouteKey = (matchId, mode) => matchId && mode ? `${mode}:${matchId}` : null

function setSelectedScoreMatch(match, mode) {
  selectedLiveMatch.value = mode === 'live' ? match : null
  selectedRrMatch.value = mode === 'result' ? match : null
}

function openAdminScoreRoute(match, mode) {
  if (!match?.id) return
  const key = scoreRouteKey(match.id, mode)
  setSelectedScoreMatch(match, mode)
  if (scoreRouteKey(queryValue(route.query.match), queryValue(route.query.score)) === key) return
  pushedScoreRouteKey = key
  void router.push(adminRouteLocation({ ...route.query, match: match.id, score: mode })).catch(() => {
    if (pushedScoreRouteKey === key) pushedScoreRouteKey = null
    setSelectedScoreMatch(null, null)
  })
}

function replaceAdminScoreRoute(match, mode) {
  if (!match?.id) return
  const previousKey = scoreRouteKey(queryValue(route.query.match), queryValue(route.query.score))
  const nextKey = scoreRouteKey(match.id, mode)
  if (pushedScoreRouteKey === previousKey) pushedScoreRouteKey = nextKey
  setSelectedScoreMatch(match, mode)
  void router.replace(adminRouteLocation({ ...route.query, match: match.id, score: mode }))
}

function replaceWithoutAdminScoreQuery() {
  const { match, score, ...query } = route.query
  if (match === undefined && score === undefined) return
  void router.replace(adminRouteLocation(query))
}

function closeAdminScoreModal() {
  const key = scoreRouteKey(queryValue(route.query.match), queryValue(route.query.score))
  const shouldGoBack = Boolean(key && pushedScoreRouteKey === key)
  setSelectedScoreMatch(null, null)
  pushedScoreRouteKey = null
  if (shouldGoBack) router.back()
  else replaceWithoutAdminScoreQuery()
}

function syncAdminScoreFromRoute() {
  const matchId = queryValue(route.query.match)
  const mode = queryValue(route.query.score)
  const key = scoreRouteKey(matchId, mode)
  if (!matchId && !mode) {
    setSelectedScoreMatch(null, null)
    pushedScoreRouteKey = null
    return
  }
  const current = matches.value.find(row => row.id === matchId)
  const action = current ? matchScoringAction(tournament.value, currentUserRole.value, current) : null
  const modeAllowed = mode === 'live'
    ? action === 'live'
    : mode === 'result' && canEditFinalScores.value && current?.side_a_entry_id && current?.side_b_entry_id
  if (key && modeAllowed) {
    setSelectedScoreMatch(current, mode)
    if (pushedScoreRouteKey && pushedScoreRouteKey !== key) pushedScoreRouteKey = null
    return
  }
  setSelectedScoreMatch(null, null)
  if (tournament.value && !loading.value) {
    pushedScoreRouteKey = null
    replaceWithoutAdminScoreQuery()
  }
}

watch(() => route.query.surface, value => {
  adminMobileBracketSurface.value = adminSurfaceFromQuery(value)
})

watch(
  [() => route.query.match, () => route.query.score, matches, currentUserRole, loading, () => tournament.value?.id],
  syncAdminScoreFromRoute,
  { immediate: true },
)

const hasOtherDrafts = computed(() => Boolean(addAdminForm.email) || addAdminForm.role !== 'editor')
const unregisterDrafts = useUnsavedChanges(() => hasOtherDrafts.value || bracketHasChanges.value || pairingDirty.value,
  () => actionLoading.value || settingsSaving.value)

onMounted(async () => {
  window.addEventListener('hashchange', onHashChange)
  await auth.init()
  await loadAll()
  syncTabFromHash()

  // Wizard redirect with ?qr=1 opens the QR modal once; strip the flag so refresh doesn't reopen it.
  if (route.query.qr === '1') {
    if (tournament.value?.slug) {
      qrModalOpen.value = true
    }
    const { qr, ...rest } = route.query
    router.replace(adminRouteLocation(rest))
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  disposed = true
  snapshotRefresh.dispose()
  stopRealtime?.(); stopRealtime = null

})
</script>

<template>
  <div class="stack">
    <RouterLink class="admin-back-link" :to="{ name: 'admin-tournaments' }">
      {{ t('admin.backToList') }}
    </RouterLink>

    <section v-if="loading" class="card">
      <p class="muted">{{ t('actions.loading') }}</p>
    </section>

    <section v-else-if="errorText && !tournament" class="card">
      <p class="error-text">{{ errorText }}</p>
    </section>

    <template v-else-if="tournament && !loading">
      <p v-if="syncFailed" class="alert alert--error" role="status">{{ t('sync.unavailable') }}</p>
      <div v-if="errorText" class="alert alert--error admin-page-alert" role="alert">
        {{ errorText }}
      </div>

      <section class="card card--elevated admin-tournament-overview stack stack--sm" aria-labelledby="adm-tournament-title">
        <div class="admin-tournament-overview__top">
          <div class="admin-tournament-overview__title-block stack stack--sm">
            <div class="admin-tournament-overview__title-row">
              <h1 id="adm-tournament-title" class="page-title" style="margin: 0">{{ tournament.name }}</h1>
              <span class="badge" :class="statusBadgeClass(tournament.status)">
                {{ t(`tournament.${tournament.status}`) }}
              </span>
            </div>
            <div class="badge-row">
              <span v-if="tournament.sport" class="badge badge--neutral">{{ t(`sport.${tournament.sport}`) }}</span>
              <span v-if="tournament.format" class="badge badge--neutral">{{ t(`tournamentFormat.${tournament.format}`) }}</span>
              <span v-if="sportCfg.supportsCategory" class="badge badge--neutral">{{ t(`tournament.${tournament.category}`) }}</span>
              <span v-if="sportCfg.supportsSetFormat && tournament.set_format" class="badge badge--neutral">{{ t(`format.${tournament.set_format}`) }}</span>
            </div>
            <p v-if="tournament.description" class="muted">{{ tournament.description }}</p>
          </div>
          <div v-if="canManageTournament" class="admin-tournament-overview__actions">
            <CopyTournamentLink
              v-if="showPublicShareActions"
              :slug="tournament.slug"
              :name="tournament.name"
            />

            <button
              v-if="showPublicShareActions"
              class="btn btn--outline btn--sm"
              type="button"
              @click="qrModalOpen = true"
            >
              {{ t('share.qrButton') }}
            </button>

            <span
              v-if="showStartButton"
              class="tooltip-wrapper"
              :data-tooltip="startBlockReason || undefined"
            >
              <button
                class="btn btn--success btn--sm"
                type="button"
                :disabled="!canStartTournament || actionLoading"
                @click="startTournament"
              >
                {{ t('admin.startTournament') }}
              </button>
            </span>

            <p v-if="showStartButton && startBlockReason" class="admin-start-reason" role="status">
              {{ startBlockReason }}
            </p>

            <button
              v-if="isTournamentActive"
              class="btn btn--ghost btn--sm"
              type="button"
              :disabled="actionLoading"
              @click="stopTournament"
            >
              {{ t('admin.stopTournament') }}
            </button>
          </div>
        </div>

      </section>

      <p v-if="currentUserRole === 'counter' && isGoalsSport" class="alert alert--info" role="status">{{ t('mobile.finalScoreRole') }}</p>

      <div role="tablist" class="tab-group" @keydown="onTabKeydown">
        <button
          v-if="canManageTournament"
          id="tab-entries"
          role="tab"
          class="tab"
          :class="{ 'tab--active': activeTab === 'entries' }"
          :aria-selected="activeTab === 'entries'"
          :tabindex="activeTab === 'entries' ? 0 : -1"
          aria-controls="panel-entries"
          @click="setTab('entries')"
        >
          {{ isTournamentActive ? t('admin.tabParticipants') : t('admin.tabEntries') }}
          <span v-if="pendingEntries.length" class="tab__badge">{{ pendingEntries.length }}</span>
        </button>
        <button
          id="tab-bracket"
          role="tab"
          class="tab"
          :class="{ 'tab--active': activeTab === 'bracket' }"
          :aria-selected="activeTab === 'bracket'"
          :tabindex="activeTab === 'bracket' ? 0 : -1"
          aria-controls="panel-bracket"
          @click="setTab('bracket')"
        >
          {{ t('admin.tabBracket') }}
        </button>
        <span class="tooltip-wrapper" :data-tooltip="!canEditScores ? t('admin.scoresLockedTooltip') : undefined">
          <button
            id="tab-scores"
            role="tab"
            class="tab"
            :class="{ 'tab--active': activeTab === 'scores' }"
            :aria-selected="activeTab === 'scores'"
            :aria-disabled="!canEditScores"
            :tabindex="activeTab === 'scores' ? 0 : -1"
            :disabled="!canEditScores"
            aria-controls="panel-scores"
            @click="setTab('scores')"
          >
            {{ t('admin.tabScores') }}
          </button>
        </span>
        <button
          v-if="canManageTournament"
          id="tab-settings"
          role="tab"
          class="tab"
          :class="{ 'tab--active': activeTab === 'settings' }"
          :aria-selected="activeTab === 'settings'"
          :tabindex="activeTab === 'settings' ? 0 : -1"
          aria-controls="panel-settings"
          @click="setTab('settings')"
        >
          {{ t('admin.tabSettings') }}
        </button>
      </div>

      <div
        v-show="canManageTournament"
        id="panel-entries"
        role="tabpanel"
        aria-labelledby="tab-entries"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'entries' }"
      >
        <section class="card stack stack--sm">
          <h2 class="section-title">
            {{ isTournamentActive ? t('admin.participantsList') : `${t('tournament.registration')} — ${t('admin.entriesSection')}` }}
          </h2>

          <ManualEntryForm
            :tournament="tournament"
            :busy="actionLoading || settingsSaving"
            :can-manage="canManageTournament"
            @update:busy="actionLoading = $event"
            @saved="refreshScoreData"
          />

          <div v-if="!isTournamentActive" class="divider" />

          <div v-if="!isTournamentActive">
            <div class="admin-list-header" style="margin-bottom: var(--space-3)">
              <h3 class="section-title" style="font-size: 1rem; margin: 0">
                {{ t('admin.pendingEntries') }}
                <span v-if="pendingEntries.length" class="badge badge--warn">{{ pendingEntries.length }}</span>
              </h3>
              <button
                v-if="pendingEntries.length > 1"
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="approveAllPending"
              >
                {{ t('admin.approveAll') }}
              </button>
            </div>
            <div v-if="pendingEntries.length" class="stack stack--sm">
              <div v-for="entry in pendingEntries" :key="entry.id" class="participant-item">
                <span class="entry-avatar">{{ entryInitials(entry) }}</span>
                <strong class="entry-name">{{ entryLabel(entry) }}</strong>
                <div class="entry-actions">
                  <button
                    class="entry-icon-btn entry-icon-btn--approve"
                    type="button"
                    :disabled="actionLoading"
                    :aria-label="t('admin.approve')"
                    :title="t('admin.approve')"
                    @click="updateEntryStatus(entry.id, 'approved')"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                  </button>
                  <button
                    class="entry-icon-btn entry-icon-btn--reject"
                    type="button"
                    :disabled="actionLoading"
                    :aria-label="t('admin.reject')"
                    :title="t('admin.reject')"
                    @click="updateEntryStatus(entry.id, 'rejected')"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <p v-else class="muted">{{ t('admin.noPending') }}</p>

            <details v-if="rejectedEntries.length" class="rejected-entries">
              <summary>
                {{ t('mobile.rejectedEntries') }}
                <span class="badge badge--neutral">{{ rejectedEntries.length }}</span>
              </summary>
              <div class="stack stack--sm rejected-entries__list">
                <div v-for="entry in rejectedEntries" :key="entry.id" class="participant-item">
                  <span class="entry-avatar">{{ entryInitials(entry) }}</span>
                  <strong class="entry-name">{{ entryLabel(entry) }}</strong>
                  <button class="btn btn--ghost btn--sm" type="button" :disabled="actionLoading" @click="updateEntryStatus(entry.id, 'pending')">
                    {{ t('mobile.restoreEntry') }}
                  </button>
                </div>
              </div>
            </details>
          </div>

          <div v-if="!isTournamentActive" class="divider" />

          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem">
              <h3 class="section-title" style="font-size: 1rem; margin: 0">
                {{ t('admin.approvedList') }}
                <span v-if="approvedEntries.length" class="badge badge--success">{{ approvedEntries.length }}</span>
              </h3>
              <button
                v-if="hasPairedEntries"
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="actionLoading || manualPairingOpen || isTournamentActive || isTournamentFinished"
                @click="openEditPairing"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                {{ t('admin.editPairs') }}
              </button>
            </div>
            <div v-if="approvedEntries.length" class="stack stack--sm">
              <div v-for="entry in approvedEntries" :key="entry.id" class="participant-item">
                <span class="entry-avatar entry-avatar--ok">{{ entryInitials(entry) }}</span>
                <strong class="entry-name">{{ entryLabel(entry) }}</strong>
                <button
                  v-if="!isTournamentActive && !isTournamentFinished"
                  class="btn btn--ghost btn--sm"
                  type="button"
                  :disabled="actionLoading"
                  @click="updateEntryStatus(entry.id, 'pending')"
                >
                  {{ t('admin.reopen') }}
                </button>
              </div>
            </div>
            <p v-else class="muted">{{ t('admin.noApproved') }}</p>
          </div>

          <template v-if="!pairingEditMode && ((isPickRandomDoubles && unpairedCount > 0) || manualPairingOpen)">
            <div class="divider" />
            <div class="pairing-banner">
              <div class="pairing-banner__info">
                <svg class="pairing-banner__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <span>
                  {{ t('admin.unpairedCount', { count: unpairedCount }) }}
                  <strong v-if="unpairedCount % 2 !== 0" class="pairing-banner__warning">
                    {{ t('admin.oddUnpairedWarning', { count: unpairedCount }) }}
                  </strong>
                </span>
              </div>
              <div class="pairing-banner__actions">
                <button
                  class="btn btn--primary btn--sm"
                  type="button"
                  :disabled="actionLoading || unpairedCount < 2 || unpairedCount % 2 !== 0 || isTournamentActive || isTournamentFinished"
                  @click="formRandomPairs"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
                  {{ t('admin.formPairs') }}
                </button>
                <button
                  class="btn btn--sm"
                  type="button"
                  :disabled="actionLoading || (!manualPairingOpen && (isTournamentActive || isTournamentFinished))"
                  @click="manualPairingOpen ? closeManualPairing() : openManualPairing()"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"/></svg>
                  {{ t('admin.formPairsManually') }}
                </button>
              </div>
            </div>

            <div v-if="manualPairingOpen" class="manual-pairing" :class="{ 'manual-pairing--dragging': isDragging }">
              <div v-if="pairingConflict" class="alert alert--info" role="status">
                {{ t('drafts.structureConflict') }}
                <button class="btn btn--ghost btn--sm" type="button" :disabled="actionLoading" @click="reloadPairingDraft">{{ t('drafts.reload') }}</button>
              </div>
              <div class="manual-pairing-pool">
                <h4 class="manual-pairing-pool__title">{{ t('admin.manualPairingPool') }}</h4>
                <p class="pairing-tap-hint" role="status">
                  {{ selectedPairPlayer ? t('mobile.selectedPlayer', { name: entryLabel(findEntryById(selectedPairPlayer.entryId)) }) : t('mobile.selectPlayerHint') }}
                </p>
                <div v-if="unassignedPlayers.length" class="manual-pairing-pool__list">
                  <button
                    v-for="entry in unassignedPlayers"
                    :key="entry.id"
                    type="button"
                    class="manual-pairing-pool__chip"
                    :class="{ 'manual-pairing-pool__chip--selected': selectedPairPlayer?.entryId === entry.id && selectedPairPlayer?.fromSlot == null }"
                    :aria-pressed="selectedPairPlayer?.entryId === entry.id && selectedPairPlayer?.fromSlot == null"
                    draggable="true"
                    @dragstart="onPlayerDragStart($event, entry, null, null)"
                    @dragend="onPlayerDragEnd"
                    @click="selectPairPlayer(entry)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    {{ entryLabel(entry) }}
                  </button>
                </div>
                <p v-else class="muted" style="font-size: 0.875rem">{{ t('admin.allPlayersAssigned') }}</p>
              </div>

              <div class="manual-pairing-grid">
                <div v-for="(slot, idx) in manualPairSlots" :key="idx" class="pair-slot" :class="{ 'pair-slot--complete': slot.playerA && slot.playerB }">
                  <span class="pair-slot__label">{{ t('admin.pairSlot', { n: idx + 1 }) }}</span>
                  <div
                    class="pair-slot__zone"
                    :class="{
                      'pair-slot__zone--filled': slot.playerA,
                      'pair-slot__zone--drag-over': manualPairingDragOver === `${idx}-A`,
                    }"
                    :draggable="!!slot.playerA"
                    role="button"
                    tabindex="0"
                    :aria-label="t('mobile.selectBracketSlot', { name: slot.playerA ? entryLabel(slot.playerA) : t('admin.emptySlot') })"
                    @dragstart="slot.playerA && onPlayerDragStart($event, slot.playerA, idx, 'A')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'A')"
                    @dragleave="onSlotDragLeave($event, idx, 'A')"
                    @drop="onSlotDrop($event, idx, 'A')"
                    @click="activatePairSlot(slot.playerA, idx, 'A')"
                    @keydown.enter="activatePairSlot(slot.playerA, idx, 'A')"
                    @keydown.space.prevent="activatePairSlot(slot.playerA, idx, 'A')"
                  >
                    <template v-if="slot.playerA">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerA) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click.stop="removeFromSlot(idx, 'A')"
                      >&times;</button>
                    </template>
                    <span v-else class="pair-slot__placeholder">{{ t('admin.emptySlot') }}</span>
                  </div>
                  <div
                    class="pair-slot__zone"
                    :class="{
                      'pair-slot__zone--filled': slot.playerB,
                      'pair-slot__zone--drag-over': manualPairingDragOver === `${idx}-B`,
                    }"
                    :draggable="!!slot.playerB"
                    role="button"
                    tabindex="0"
                    :aria-label="t('mobile.selectBracketSlot', { name: slot.playerB ? entryLabel(slot.playerB) : t('admin.emptySlot') })"
                    @dragstart="slot.playerB && onPlayerDragStart($event, slot.playerB, idx, 'B')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'B')"
                    @dragleave="onSlotDragLeave($event, idx, 'B')"
                    @drop="onSlotDrop($event, idx, 'B')"
                    @click="activatePairSlot(slot.playerB, idx, 'B')"
                    @keydown.enter="activatePairSlot(slot.playerB, idx, 'B')"
                    @keydown.space.prevent="activatePairSlot(slot.playerB, idx, 'B')"
                  >
                    <template v-if="slot.playerB">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerB) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click.stop="removeFromSlot(idx, 'B')"
                      >&times;</button>
                    </template>
                    <span v-else class="pair-slot__placeholder">{{ t('admin.emptySlot') }}</span>
                  </div>
                </div>
              </div>

              <div class="manual-pairing__footer">
                <button
                  class="btn btn--primary btn--sm"
                  type="button"
                  :disabled="actionLoading || !pairingDirty || pairingConflict || completePairsCount === 0"
                  @click="saveManualPairs"
                >
                  {{ t('admin.savePairs') }} ({{ completePairsCount }})
                </button>
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  :disabled="actionLoading"
                  @click="closeManualPairing"
                >
                  {{ t('actions.cancel') }}
                </button>
              </div>
            </div>
          </template>

          <div v-if="manualPairingOpen && pairingEditMode" class="manual-pairing" :class="{ 'manual-pairing--dragging': isDragging }">
              <div v-if="pairingConflict" class="alert alert--info" role="status">
                {{ t('drafts.structureConflict') }}
                <button class="btn btn--ghost btn--sm" type="button" :disabled="actionLoading" @click="reloadPairingDraft">{{ t('drafts.reload') }}</button>
              </div>
              <div class="manual-pairing-pool">
                <h4 class="manual-pairing-pool__title">{{ t('admin.manualPairingPool') }}</h4>
                <p class="pairing-tap-hint" role="status">
                  {{ selectedPairPlayer ? t('mobile.selectedPlayer', { name: entryLabel(findEntryById(selectedPairPlayer.entryId)) }) : t('mobile.selectPlayerHint') }}
                </p>
                <div v-if="unassignedPlayers.length" class="manual-pairing-pool__list">
                  <button
                    v-for="entry in unassignedPlayers"
                    :key="entry.id"
                    type="button"
                    class="manual-pairing-pool__chip"
                    :class="{ 'manual-pairing-pool__chip--selected': selectedPairPlayer?.entryId === entry.id && selectedPairPlayer?.fromSlot == null }"
                    :aria-pressed="selectedPairPlayer?.entryId === entry.id && selectedPairPlayer?.fromSlot == null"
                    draggable="true"
                    @dragstart="onPlayerDragStart($event, entry, null, null)"
                    @dragend="onPlayerDragEnd"
                    @click="selectPairPlayer(entry)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    {{ entryLabel(entry) }}
                  </button>
                </div>
                <p v-else class="muted" style="font-size: 0.875rem">{{ t('admin.allPlayersAssigned') }}</p>
              </div>

              <div class="manual-pairing-grid">
                <div v-for="(slot, idx) in manualPairSlots" :key="idx" class="pair-slot" :class="{ 'pair-slot--complete': slot.playerA && slot.playerB }">
                  <span class="pair-slot__label">{{ t('admin.pairSlot', { n: idx + 1 }) }}</span>
                  <div
                    class="pair-slot__zone"
                    :class="{
                      'pair-slot__zone--filled': slot.playerA,
                      'pair-slot__zone--drag-over': manualPairingDragOver === `${idx}-A`,
                    }"
                    :draggable="!!slot.playerA"
                    role="button"
                    tabindex="0"
                    :aria-label="t('mobile.selectBracketSlot', { name: slot.playerA ? entryLabel(slot.playerA) : t('admin.emptySlot') })"
                    @dragstart="slot.playerA && onPlayerDragStart($event, slot.playerA, idx, 'A')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'A')"
                    @dragleave="onSlotDragLeave($event, idx, 'A')"
                    @drop="onSlotDrop($event, idx, 'A')"
                    @click="activatePairSlot(slot.playerA, idx, 'A')"
                    @keydown.enter="activatePairSlot(slot.playerA, idx, 'A')"
                    @keydown.space.prevent="activatePairSlot(slot.playerA, idx, 'A')"
                  >
                    <template v-if="slot.playerA">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerA) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click.stop="removeFromSlot(idx, 'A')"
                      >&times;</button>
                    </template>
                    <span v-else class="pair-slot__placeholder">{{ t('admin.emptySlot') }}</span>
                  </div>
                  <div
                    class="pair-slot__zone"
                    :class="{
                      'pair-slot__zone--filled': slot.playerB,
                      'pair-slot__zone--drag-over': manualPairingDragOver === `${idx}-B`,
                    }"
                    :draggable="!!slot.playerB"
                    role="button"
                    tabindex="0"
                    :aria-label="t('mobile.selectBracketSlot', { name: slot.playerB ? entryLabel(slot.playerB) : t('admin.emptySlot') })"
                    @dragstart="slot.playerB && onPlayerDragStart($event, slot.playerB, idx, 'B')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'B')"
                    @dragleave="onSlotDragLeave($event, idx, 'B')"
                    @drop="onSlotDrop($event, idx, 'B')"
                    @click="activatePairSlot(slot.playerB, idx, 'B')"
                    @keydown.enter="activatePairSlot(slot.playerB, idx, 'B')"
                    @keydown.space.prevent="activatePairSlot(slot.playerB, idx, 'B')"
                  >
                    <template v-if="slot.playerB">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerB) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click.stop="removeFromSlot(idx, 'B')"
                      >&times;</button>
                    </template>
                    <span v-else class="pair-slot__placeholder">{{ t('admin.emptySlot') }}</span>
                  </div>
                </div>
              </div>

              <div class="manual-pairing__footer">
                <button
                  class="btn btn--primary btn--sm"
                  type="button"
                  :disabled="actionLoading || !pairingDirty || pairingConflict || completePairsCount === 0"
                  @click="saveManualPairs"
                >
                  {{ t('admin.savePairs') }} ({{ completePairsCount }})
                </button>
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  :disabled="actionLoading"
                  @click="closeManualPairing"
                >
                  {{ t('actions.cancel') }}
                </button>
              </div>
            </div>
        </section>
      </div>

      <div
        v-if="canManageTournament || canLiveScoreRole"
        id="panel-bracket"
        role="tabpanel"
        aria-labelledby="tab-bracket"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'bracket' }"
      >
        <template v-if="isNarrowLayout && isTournamentActive && matches.length">
          <div class="admin-mobile-surface" role="tablist" :aria-label="t('tournament.tabsLabel')" @keydown="onSurfaceTabKeydown">
            <button id="admin-surface-matches" type="button" role="tab" aria-controls="admin-mobile-panel" :tabindex="adminMobileBracketSurface === 'matches' ? 0 : -1" :aria-selected="adminMobileBracketSurface === 'matches'" :class="{ active: adminMobileBracketSurface === 'matches' }" @click="setAdminMobileBracketSurface('matches')">{{ t('mobile.matches') }}</button>
            <button id="admin-surface-overview" type="button" role="tab" aria-controls="admin-mobile-panel" :tabindex="adminMobileBracketSurface === 'overview' ? 0 : -1" :aria-selected="adminMobileBracketSurface === 'overview'" :class="{ active: adminMobileBracketSurface === 'overview' }" @click="setAdminMobileBracketSurface('overview')">{{ t('mobile.overview') }}</button>
          </div>
        </template>
        <div id="admin-mobile-panel" :role="isNarrowLayout && isTournamentActive && matches.length ? 'tabpanel' : undefined" :aria-labelledby="isNarrowLayout && isTournamentActive && matches.length ? `admin-surface-${adminMobileBracketSurface}` : undefined">
          <section v-if="isNarrowLayout && isTournamentActive && matches.length && adminMobileBracketSurface === 'matches'" class="card mobile-score-center" style="margin-top: var(--space-3)">
            <TournamentMatchList :matches="matches" :entries-map="entriesMap" :sets-by-match="setsByMatch" :live-scores-by-match="liveScoresByMatch" :can-edit-final="canEditFinalScores" :can-live-score="canUseLiveScoring" @edit-result="openRrMatch" @view-live="openLiveScoring" />
          </section>
        <!-- Round-robin: schedule + standings + fixtures -->
        <template v-if="isRoundRobin">
          <section v-if="canManageTournament && !isTournamentActive" class="card stack stack--sm">
            <h2 class="section-title">{{ t('standings.title') }}</h2>
            <div class="inline-actions">
              <button
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="generateSchedule"
              >
                {{ hasBracket ? t('standings.regenerateSchedule') : t('standings.generateSchedule') }}
              </button>
            </div>
          </section>

          <section v-if="standings.length && showAdminBracketOverview" class="card stack stack--sm" style="margin-top: var(--space-4)">
            <h2 class="section-title">{{ t('standings.title') }}</h2>
            <RoundRobinStandings
              :rows="standings"
              :matches="matches"
              :entries-map="entriesMap"
              :family="tournamentScoringFamily"
              :live-scores-by-match="liveScoresByMatch"
              @view-live="openLiveScoring"
            />
          </section>
        </template>

        <!-- Groups + playoff -->
        <template v-else-if="isGroupsPlayoff">
          <section v-if="canManageTournament && !isTournamentActive" class="card stack stack--sm">
            <h2 class="section-title">{{ t('admin.groupStage') }}</h2>
            <div v-if="!hasGroups" class="form-field" style="max-width: 200px">
              <label for="grp-count">{{ t('admin.groupCount') }}</label>
              <input id="grp-count" v-model.number="groupCount" class="input" type="number" min="2" />
            </div>
            <div class="inline-actions">
              <button
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="generateGroups"
              >
                {{ hasGroups ? t('admin.regenerateGroups') : t('admin.generateGroups') }}
              </button>
              <button
                v-if="hasGroups && allGroupMatchesFinished && !hasPlayoff"
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="startPlayoff"
              >
                {{ t('admin.startPlayoff') }}
              </button>
            </div>
          </section>

          <section v-if="hasGroups && showAdminBracketOverview" class="card stack stack--sm" style="margin-top: var(--space-4)">
            <h2 class="section-title">{{ t('admin.groupStage') }}</h2>
            <GroupStageBoard :groups="groupsView" :entries-map="entriesMap" :family="tournamentScoringFamily" />
          </section>

          <section v-if="hasPlayoff && showAdminBracketOverview" class="card stack stack--sm" style="margin-top: var(--space-4)">
            <h2 class="section-title">{{ t('admin.playoff') }}</h2>
            <BracketBoard
              :matches="playoffMatches"
              :sets-by-match="setsByMatch"
              :entries-map="entriesMap"
              :live-scores-by-match="liveScoresByMatch"
              :can-live-score="canEditScores"
              @view-live="openLiveScoring"
            />
          </section>
        </template>

        <section v-if="!isRoundRobin && !isGroupsPlayoff && canManageTournament && !isTournamentActive" class="card stack stack--sm">
          <h2 class="section-title">{{ t('tournament.bracket') }} — {{ t('admin.drawSection') }}</h2>

          <div class="form-field" style="max-width: 280px">
            <label for="adm-draw">{{ t('admin.drawMode') }}</label>
            <select id="adm-draw" v-model="drawMode" class="input">
              <option value="auto-random">{{ t('admin.drawRandom') }}</option>
              <option value="manual">{{ t('admin.drawManual') }}</option>
            </select>
          </div>

          <template v-if="!hasBracket">
            <div class="inline-actions">
              <button
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="generateBracket"
              >
                {{ drawMode === 'manual' ? t('admin.generateManual') : t('admin.generateRandom') }}
              </button>
            </div>

            <p v-if="drawMode === 'manual'" class="muted">{{ t('admin.manualBracketDnDHint') }}</p>
          </template>

          <template v-else>
            <div class="inline-actions">
              <button
                class="btn btn--danger btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="generateBracket"
              >
                {{ t('admin.rebuild') }}
              </button>
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="resetBracket"
              >
                {{ t('admin.resetBracket') }}
              </button>
            </div>
          </template>
        </section>

        <section v-if="!isRoundRobin && !isGroupsPlayoff && showAdminBracketOverview" class="card stack stack--sm" style="margin-top: var(--space-4)">
          <DoubleElimBoard
            v-if="isDoubleElim"
            :matches="displayMatches"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :live-scores-by-match="liveScoresByMatch"
            :can-live-score="canEditScores"
            @view-live="openLiveScoring"
          />
          <BracketBoard
            v-else
            :matches="displayMatches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          :editable-slots="canManageTournament && drawMode === 'manual' && !actionLoading && !isTournamentActive && !isTournamentFinished"
          :can-live-score="canEditScores"
          @swap-slots="swapBracketSlots"
          @view-live="openLiveScoring"
        />
          <div v-if="bracketConflict" class="alert alert--info" role="status">
            {{ t('drafts.structureConflict') }}
            <button class="btn btn--ghost btn--sm" type="button" :disabled="actionLoading" @click="reloadBracketDraft">{{ t('drafts.reload') }}</button>
          </div>
          <div v-if="bracketEditing" class="inline-actions" style="margin-top: var(--space-2)">
            <button
              class="btn btn--primary btn--sm"
              type="button"
              :disabled="actionLoading || bracketConflict || !bracketHasChanges"
              @click="saveBracketLayout"
            >
              {{ t('admin.saveBracketLayout') }}
            </button>
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              :disabled="actionLoading"
              @click="cancelBracketEditing"
            >
              {{ t('actions.cancel') }}
            </button>
          </div>
        </section>
      </div>

      </div>

      <div
        id="panel-scores"
        role="tabpanel"
        aria-labelledby="tab-scores"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'scores' }"
      >
        <section v-if="isNarrowLayout" class="card mobile-score-center">
          <TournamentMatchList
            :matches="matches"
            :entries-map="entriesMap"
            :sets-by-match="setsByMatch"
            :live-scores-by-match="liveScoresByMatch"
            :can-edit-final="canEditFinalScores"
            :can-live-score="canUseLiveScoring"
            @edit-result="openRrMatch"
            @view-live="openLiveScoring"
          />
        </section>
        <!-- Round-robin: same crosstable as the bracket tab (no artificial rounds) -->
        <template v-else-if="isRoundRobin">
          <section class="card stack stack--sm rr-cross-card">
            <h2 class="section-title">{{ t('standings.crossTable') }}</h2>
            <p class="muted">{{ t('standings.clickToScore') }}</p>
            <RoundRobinCrossTable
              :matches="matches"
              :entries-map="entriesMap"
              :standings="standings"
              :family="tournamentScoringFamily"
              :clickable="canEditFinalScores || canEditScores"
              :live-scores-by-match="liveScoresByMatch"
              @select-match="openRrMatch"
              @view-live="openLiveScoring"
            />
          </section>

          <section v-if="standings.length" class="card stack stack--sm" style="margin-top: var(--space-4)">
            <h2 class="section-title">{{ t('standings.title') }}</h2>
            <StandingsTable :rows="standings" :family="tournamentScoringFamily" />
          </section>
        </template>
        <FootballScoreEditor
          v-else-if="isGoalsSport"
          :matches="matches"
          :entries-map="entriesMap"
          :disabled="!canEditFinalScores"
          @saved="refreshScoreData"
        />
        <ScoreEditor
          v-else
          :matches="matches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :set-format="tournament.set_format"
          :scoring-config="tournament.scoring_config || {}"
          :category="tournament.category"
          :disabled="!canEditFinalScores"
          :can-live-score="canUseLiveScoring"
          :live-scores-by-match="liveScoresByMatch"
          @saved="refreshScoreData"
          @start-live="openLiveScoring"
        />
      </div>

      <div
        v-show="canManageTournament"
        id="panel-settings"
        role="tabpanel"
        aria-labelledby="tab-settings"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'settings' }"
      >
        <TournamentSettingsForm
          :tournament="tournament"
          :matches="matches"
          :busy="actionLoading"
          :can-manage="canManageTournament"
          :refresh="loadTournament"
          v-model:saving="settingsSaving"
          @saved="acceptTournament"
        />

        <section class="card stack stack--sm" style="margin-top: var(--space-4)">
          <h2 class="section-title">{{ t('admin.admins') }}</h2>
          <div class="stack stack--sm">
            <div v-for="admin in admins" :key="admin.id" class="participant-item">
              <span class="entry-avatar">{{ (admin.email || '?').slice(0, 2).toUpperCase() }}</span>
              <div class="entry-name" style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap">
                <span style="font-size: 0.875rem">{{ admin.email }}</span>
                <span class="badge badge--neutral">{{ t(`admin.${admin.role}`) }}</span>
              </div>
              <button
                v-if="admin.user_id !== auth.user?.id"
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="removeAdmin(admin.id)"
              >
                {{ t('actions.remove') }}
              </button>
            </div>
          </div>

          <div class="grid-2" style="margin-top: var(--space-3)">
            <div class="form-field">
              <label for="adm-email">{{ t('admin.adminEmail') }}</label>
              <input id="adm-email" :disabled="actionLoading" v-model="addAdminForm.email" class="input" type="email" :placeholder="t('admin.adminEmailPlaceholder')" />
            </div>
            <div class="form-field">
              <label for="adm-role">{{ t('admin.role') }}</label>
              <select id="adm-role" :disabled="actionLoading" v-model="addAdminForm.role" class="input">
                <option value="editor">{{ t('admin.editor') }}</option>
                <option value="counter">{{ t('admin.counter') }}</option>
                <option value="owner">{{ t('admin.owner') }}</option>
              </select>
            </div>
          </div>
          <div class="inline-actions">
            <button class="btn btn--primary btn--sm" type="button" :disabled="actionLoading || !addAdminForm.email" @click="addAdmin">
              {{ t('admin.add') }}
            </button>
          </div>
        </section>

        <section class="admin-delete-zone">
          <button
            v-if="isTournamentActive"
            class="btn btn--danger btn--sm"
            type="button"
            :disabled="actionLoading"
            @click="finishTournament"
          >
            {{ t('admin.finishTournament') }}
          </button>
          <button
            class="btn btn--danger btn--sm"
            type="button"
            :disabled="actionLoading"
            @click="deleteTournament"
          >
            {{ t('admin.deleteTournament') }}
          </button>
        </section>
      </div>

      <LiveScoringModal
        v-if="selectedLiveMatch && canUseLiveScoring"
        :match="matches.find(m => m.id === selectedLiveMatch.id) || selectedLiveMatch"
        :can-stop-live="canManageTournament"
        :live-score="selectedLiveScore"
        :scoring-config="tournament.scoring_config || {}"
        :team-a="teamLabel(selectedLiveMatch.side_a_entry_id)"
        :team-b="teamLabel(selectedLiveMatch.side_b_entry_id)"
        @close="closeAdminScoreModal"
        @changed="scheduleScoreReload"
      />

      <TournamentQrModal
        v-if="qrModalOpen && tournament.slug"
        :slug="tournament.slug"
        :name="tournament.name"
        @close="qrModalOpen = false"
      />

      <MatchScoreModal
        v-if="selectedRrMatch"
        :exists="matches.some(m => m.id === selectedRrMatch.id)"
        :match="matches.find(m => m.id === selectedRrMatch.id) || selectedRrMatch"
        :entries-map="entriesMap"
        :family="tournamentScoringFamily"
        :set-format="tournament.set_format || 'best_of_3'"
        :scoring-config="tournament.scoring_config || {}"
        :sets="setsByMatch[selectedRrMatch.id] || []"
        :can-edit-final="canEditFinalScores"
        :can-live-score="canUseLiveScoring"
        :live-status="liveScoresByMatch[selectedRrMatch.id]?.status || null"
        @close="closeAdminScoreModal"
        @saved="refreshScoreData"
        @start-live="startLiveFromRrModal"
      />
    </template>
  </div>
</template>

<style scoped>
/* Entry rows (approve / roster) */
.participant-item { gap: var(--space-3); }

.entry-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
}

.entry-avatar--ok {
  color: var(--primary);
  background: var(--primary-muted);
  border-color: transparent;
}

.entry-name {
  flex: 1;
  min-width: 0;
  font-size: 0.9375rem;
}

.entry-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.entry-icon-btn {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  transition: filter 0.15s, transform 0.1s;
}

.entry-icon-btn:active { transform: scale(0.94); }
.entry-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.entry-icon-btn--approve {
  color: var(--primary-contrast, #fff);
  background: var(--primary);
}

.entry-icon-btn--approve:hover { background: var(--primary-hover); }

.entry-icon-btn--reject {
  color: var(--danger);
  background: var(--danger-bg);
}

.entry-icon-btn--reject:hover { filter: brightness(0.97); }
</style>
