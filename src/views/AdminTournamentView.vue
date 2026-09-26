<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from 'vue'
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
import EntryContact from '../components/admin/EntryContact.vue'
import { loadEntryContacts } from '../lib/entryContacts'
import TournamentSettingsForm from '../components/admin/TournamentSettingsForm.vue'
import ScheduleBoard from '../components/admin/ScheduleBoard.vue'
import CourtsEditor from '../components/admin/CourtsEditor.vue'
import MatchScheduleModal from '../components/admin/MatchScheduleModal.vue'
import AccessMatrix from '../components/admin/AccessMatrix.vue'
import TournamentNextStep from '../components/admin/TournamentNextStep.vue'
import TournamentChampion from '../components/TournamentChampion.vue'
import { finishConfirmation } from '../lib/tournamentChampion'
import KebabMenu from '../components/KebabMenu.vue'
import InfoTip from '../components/InfoTip.vue'
import AppModal from '../components/AppModal.vue'
import { accessError, assignableRoles, canEditMembership } from '../lib/access'
import { applyScheduleAction, draftDiff, effectiveSchedule, indexSchedule, scheduleError, timezoneOf } from '../lib/schedule'
import TournamentMatchList from '../components/TournamentMatchList.vue'
import { scoringError } from '../lib/tennisRules'
import { registrationDisplayState, registrationError } from '../lib/registrationRules'
import { sameForm, cloneForm, matchVersions } from '../lib/formDraft'
import { useUnsavedChanges, confirmDiscard, withApprovedDeparture } from '../lib/unsavedChanges'
import { entryMemberNames } from '../lib/entryDisplay'
import { confirmDialog } from '../lib/confirmDialog'
import { supabase } from '../lib/supabase'
import { createSnapshotRefresh, subscribeTournament } from '../lib/tournamentSync'
import { readAdminTournamentSnapshot } from '../lib/tournamentRepository'
import { indexEntries, groupSetsByMatch, indexLiveScores, buildGroupsView } from '../lib/tournamentProjections'
import CopyTournamentLink from '../components/CopyTournamentLink.vue'
import AppIcon from '../components/AppIcon.vue'
import { useAuthStore } from '../stores/auth'
import { useNarrowLayout } from '../lib/useNarrowLayout'
import { useHeaderTitle } from '../lib/headerTitle'
import { onTabKeydown as onSurfaceTabKeydown } from '../lib/tabNavigation'
import { statusBadgeClass } from '../lib/tournamentStatus'
import { errorMessage } from '../lib/errorMessages'
import { usePageAlerts } from '../lib/pageAlerts'
import { pluralParams } from '../lib/plural'
import { bracketPlan, groupCountOptions, groupPlan, roundRobinPlan } from '../lib/formatPlan'
import { isFedMatch, swapDraftSlots } from '../lib/bracketDisplay'
import { readDrawMode, writeDrawMode } from '../lib/drawModePreference'

const props = defineProps({
  id: {
    type: String,
    required: true,
  },
})

const { t, locale } = useI18n()
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
const registration = ref(null)
const noticeText = ref('')
const courts = ref([])
const schedule = ref([])
const scheduleMatch = ref(null)
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
// Remembered per tournament on this device, so a reload keeps a manual draw manual.
const drawMode = ref(readDrawMode(props.id))
watch(() => props.id, id => { drawMode.value = readDrawMode(id) })
watch(drawMode, mode => writeDrawMode(props.id, mode))
// Rearranging a built bracket is its own mode, switched on by a button (or right
// after a manual draw) — not by the draw-mode select, which resets on reload.
const arrangeMode = ref(false)
const bracketEditing = ref(false)
const localMatches = ref([])
const selectedLiveMatch = ref(null)

const addAdminOpen = ref(false)
// «Владелец» в модалке = со-владелец. Передача владения (вы становитесь редактором, событие в журнале)
// включается отдельным переключателем и идёт через transfer_tournament_ownership.
const transferMode = ref(false)
function openAddAdmin() { errorText.value = ''; transferMode.value = false; addAdminOpen.value = true }
function closeAddAdmin() { addAdminOpen.value = false; transferMode.value = false; addAdminForm.email = ''; addAdminForm.role = 'editor' }
function submitAddAdmin() { return transferMode.value && addAdminForm.role === 'owner' ? transferOwnership() : addAdmin() }
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
// Snapshot entries arrive ordered by created_at, so this is the queue order.
const waitlistedEntries = computed(() => entries.value.filter((entry) => entry.status === 'waitlisted'))
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

// Draw order: the manual draw and the group snake read seed_order first, then
// the application time — the same order the list shows and the menu edits.
const sortedApproved = computed(() => [...approvedEntries.value].sort((a, b) =>
  (a.seed_order ?? Number.MAX_SAFE_INTEGER) - (b.seed_order ?? Number.MAX_SAFE_INTEGER)
  || String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id)))
const seedPosition = entry => sortedApproved.value.findIndex(e => e.id === entry.id) + 1
const approvedQuery = ref('')
const filteredApproved = computed(() => {
  const q = approvedQuery.value.trim().toLowerCase()
  return q ? sortedApproved.value.filter(e => entryLabel(e).toLowerCase().includes(q)) : sortedApproved.value
})
// Seeding matters until the draw exists; a random bracket draw ignores it.
const canSeed = computed(() => canManageTournament.value && !hasBracket.value && !isTournamentActive.value && !isTournamentFinished.value)

async function moveSeed(entry, delta) {
  if (actionLoading.value) return
  const order = sortedApproved.value.map(e => e.id)
  const from = order.indexOf(entry.id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= order.length) return
  order.splice(to, 0, order.splice(from, 1)[0])
  actionLoading.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('set_entry_seed_order', { p_tournament_id: props.id, p_entry_ids: order })
    if (error) throw error
    await loadAll(true)
  } catch (error) {
    errorText.value = error?.code === 'PGRST202' ? t('seeding.unavailable') : errorMessage(error, t)
  } finally { actionLoading.value = false }
}

// One avatar per member: a pair shows both players, not the first one's initials.
function memberInitials(entry) {
  const names = entryMemberNames(entry)
  const list = names.length ? names : [entryLabel(entry) || '?']
  return list.slice(0, 2).map(name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?')
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
const regState = computed(() => registrationDisplayState(registration.value, Date.now(), tournament.value))
const showDeadlineHint = computed(() => canManageTournament.value && regState.value.deadlinePassed && tournament.value?.status === 'registration_open')
const waitlistSeatFree = computed(() => Boolean(registration.value?.capacity) && !registration.value.is_full && waitlistedEntries.value.length > 0)
// Applicants' contacts: owners and editors only, re-read when the entry list changes.
const entryContacts = ref({})
let entryContactsRead = 0
watch(() => (canManageTournament.value ? entries.value.map(e => e.id).join(',') : ''), async key => {
  const read = ++entryContactsRead
  if (!key) { entryContacts.value = {}; return }
  try {
    const contacts = await loadEntryContacts(supabase, props.id)
    if (read === entryContactsRead) entryContacts.value = contacts
  } catch { /* Contacts are an aid; the lists work without them. */ }
})
const scheduleIndex = computed(() => indexSchedule(schedule.value))
const scheduleDraftCount = computed(() => draftDiff(schedule.value).count)
// Organizers see their draft everywhere in the admin page; changed rows are marked.
provide('matchScheduleView', computed(() => ({
  byMatch: effectiveSchedule(schedule.value, true),
  courtsById: Object.fromEntries(courts.value.map(c => [c.id, c])),
  timeZone: timezoneOf(tournament.value),
  draftIds: new Set(draftDiff(schedule.value).changed),
})))
function rebuildConfirmText(key) {
  return schedule.value.length ? `${t(key)} ${t('schedule.rebuildLosesSchedule')}` : t(key)
}

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
    // Unplayed matches are listed explicitly before the tournament is closed for good.
    const finish = finishConfirmation({ format: tournament.value.format, matches: matches.value, label: teamLabel, t })
    if (!(await confirmDialog(finish.message, finish.options))) return
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

// Registration must be closed before the field turns into matches, otherwise
// a late entry is approved into a tournament that has no place for it.
async function patchStatus(status) {
  const { data, error } = await supabase.rpc('update_tournament_settings', {
    p_tournament_id: props.id, p_patch: { status }, p_expected_revision: tournament.value.settings_revision,
  })
  if (error) throw error
  acceptTournament(data)
}

async function closeRegistration() {
  if (actionLoading.value || settingsSaving.value) return
  actionLoading.value = true
  errorText.value = ''
  try {
    if (!(await confirmDialog(t('nextStep.closeRegistrationConfirm')))) return
    await patchStatus('registration_closed')
    await loadAll(true)
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
    try { await loadTournament() } catch { /* Keep the actionable mutation error. */ }
  } finally { actionLoading.value = false }
}

// Called inside a generation action (actionLoading already held). Returns false
// when the organizer keeps registration open and the generation must not run.
async function ensureRegistrationClosed() {
  if (tournament.value?.status !== 'registration_open' && tournament.value?.status !== 'draft') return true
  if (!(await confirmDialog(t('nextStep.closeBeforeGenerate')))) return false
  await patchStatus('registration_closed')
  return true
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
// A dropped card must land where it was dropped, not after a round trip. The
// move is applied locally and replayed over every snapshot until its own write
// has been confirmed, so a poll arriving mid-flight cannot pull the card back.
const pendingScheduleMoves = ref([])
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
    registration.value = data.registration || null
    matches.value = data.matches
    matchSets.value = data.sets
    liveScores.value = data.live
    if (selectedLiveMatch.value && !data.matches.some(m => m.id === selectedLiveMatch.value.id)) selectedLiveMatch.value = null
    groups.value = data.groups
    courts.value = data.courts || []
    schedule.value = pendingScheduleMoves.value.reduce(applyScheduleAction, data.schedule || [])
    if (scheduleMatch.value && !data.matches.some(m => m.id === scheduleMatch.value.id)) scheduleMatch.value = null
    standings.value = data.standings
    groupStandings.value = data.group_standings
    entryEditState.value = { entries: [...data.entries].sort((a,b) => a.id.localeCompare(b.id)),
      matches: matchVersions(data.matches), settings_revision: data.tournament.settings_revision }
    syncFailed.value = false
  },
  onError: error => {
    syncFailed.value = true
    if (!tournament.value) errorText.value = errorMessage(error, t)
  },
})

async function refreshScoreData() { return snapshotRefresh.refresh() }
function scheduleScoreReload() { snapshotRefresh.request() }
async function loadMatchesAndSets() {
  if (!(await refreshScoreData())) throw new Error(t('sync.unavailable'))
}
async function loadTournament() { return loadMatchesAndSets() }
async function loadEntries() { return loadMatchesAndSets() }

function retryLoad() {
  if (!tournament.value) errorText.value = ''
  void loadAll().catch(() => {})
}

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
      // The 30 s recovery poll fires with no payload. On a healthy channel it
      // cannot have missed a membership change, so re-reading the co-organizer
      // list every half minute is pure traffic; after a drop or a rejoin the
      // channel may well have missed one, and syncFailed marks exactly that.
      if (payload?.table === 'tournament_admins' || syncFailed.value) adminListStale = true
      snapshotRefresh.request()
    },
    onStatus: status => { if (status !== 'SUBSCRIBED') syncFailed.value = true },
  })
}

async function updateEntryStatus(entryId, status) {
  if (actionLoading.value) return
  actionLoading.value = true
  errorText.value = ''
  noticeText.value = ''
  try {
    // The capacity trigger rejects an approval beyond the limit with registration.full.
    const { error } = await supabase.from('entries').update({ status }).eq('id', entryId)
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = registrationError(error?.message, t)
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
    noticeText.value = ''
    const { data, error } = await supabase.rpc('approve_pending_entries', { p_tournament_id: props.id })
    if (error) throw error
    noticeText.value = data?.skipped
      ? t('registrationRules.approveAllResult', { approved: data.approved, skipped: data.skipped })
      : t('registrationRules.approveAllResultAll', { approved: data?.approved ?? 0 })
    await loadAll()
  } catch (error) {
    errorText.value = registrationError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function saveCourts(list) {
  if (actionLoading.value) return
  actionLoading.value = true
  errorText.value = ''
  noticeText.value = ''
  try {
    const { error } = await supabase.rpc('save_courts', {
      p_tournament_id: props.id, p_courts: list, p_expected_revision: tournament.value.settings_revision,
    })
    if (error) throw error
    noticeText.value = t('schedule.courtsSaved')
    await loadAll()
  } catch (error) {
    errorText.value = scheduleError(error?.message, t)
    await loadAll()
  } finally { actionLoading.value = false }
}

// One drop is one RPC, and the card moves before it is sent. The board is not
// disabled while the write is in flight: the server serialises schedule writes
// per tournament, so a burst of drops is safe and the organizer keeps dragging.
async function moveScheduleItem(action) {
  if (!action) return
  const previous = schedule.value
  pendingScheduleMoves.value = [...pendingScheduleMoves.value, action]
  schedule.value = applyScheduleAction(previous, action)
  errorText.value = ''
  noticeText.value = ''
  const settle = () => { pendingScheduleMoves.value = pendingScheduleMoves.value.filter(item => item !== action) }
  try {
    const call = action.kind === 'clear'
      ? supabase.rpc('clear_match_schedule', { p_match_id: action.matchId })
      : action.kind === 'assign'
        ? supabase.rpc('set_match_schedule', {
          p_match_id: action.matchId,
          p_court_id: action.courtId,
          p_scheduled_at: action.scheduledAt,
          p_time_kind: action.timeKind,
          p_queue_order: null,
          p_ignore_warnings: true,
        })
        : supabase.rpc('place_match_in_court_queue', {
          p_match_id: action.matchId,
          p_court_id: action.courtId,
          p_order: action.order,
          p_ignore_warnings: true,
        })
    const { error } = await call
    if (error) throw error
    // The snapshot still replays this move, so confirming it moves nothing.
    await refreshScoreData()
    settle()
  } catch (error) {
    // Drop this move and let the snapshot rebuild: restoring the array captured
    // before it would also throw away any later drop still in flight.
    settle()
    errorText.value = scheduleError(error?.message, t)
    await refreshScoreData()
  }
}

async function publishSchedule() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('schedule.publishConfirm')))) return
    errorText.value = ''
    noticeText.value = ''
    const { data, error } = await supabase.rpc('publish_schedule', { p_tournament_id: props.id })
    if (error) throw error
    noticeText.value = t('schedule.publishedOk', { count: data?.published ?? 0 })
    await loadAll()
  } catch (error) {
    errorText.value = scheduleError(error?.message, t)
  } finally { actionLoading.value = false }
}

async function revertSchedule() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('schedule.revertConfirm'), { danger: true }))) return
    errorText.value = ''
    noticeText.value = ''
    const { error } = await supabase.rpc('revert_schedule_draft', { p_tournament_id: props.id })
    if (error) throw error
    noticeText.value = t('schedule.revertedOk')
    await loadAll()
  } catch (error) {
    errorText.value = scheduleError(error?.message, t)
  } finally { actionLoading.value = false }
}

const hasBracket = computed(() => matches.value.length > 0)
const tournamentFormat = computed(() => tournament.value?.format || 'single_elimination')
const isRoundRobin = computed(() => tournamentFormat.value === 'round_robin')
const isGroupsPlayoff = computed(() => tournamentFormat.value === 'groups_playoff')
// The second tab holds a bracket, a round-robin table or groups: name it after what it shows.
// What each format will produce from the approved field, shown before generating.
const rrPlan = computed(() => roundRobinPlan(approvedEntries.value.length))
const groupOptions = computed(() => groupCountOptions(approvedEntries.value.length))
watch(groupOptions, (options) => {
  if (options.length && !options.includes(Number(groupCount.value))) groupCount.value = options[0]
}, { immediate: true })
const groupPlanText = computed(() => {
  const plan = groupPlan(approvedEntries.value.length, groupCount.value, tournament.value?.format_config?.advance_per_group)
  return t('admin.groupPlan', pluralParams({
    groups: plan.groups,
    size: plan.minSize === plan.maxSize ? plan.minSize : `${plan.minSize}–${plan.maxSize}`,
    matches: plan.matches,
    advance: plan.advance,
    qualifiers: plan.qualifiers,
  }, t, locale.value))
})
// Double elimination (v1) needs a power-of-two field; any other count builds nothing.
const doubleElimCountInvalid = computed(() => isDoubleElim.value && approvedEntries.value.length >= 2 && !bracketPlan(approvedEntries.value.length, 'double_elimination').valid)
const bracketPlanBlocked = computed(() => doubleElimCountInvalid.value && !hasBracket.value)
const bracketPlanText = computed(() => {
  const plan = bracketPlan(approvedEntries.value.length, tournamentFormat.value)
  if (plan.n < 2) return t('nextStep.entriesTooFew')
  if (isDoubleElim.value) return plan.valid ? t('admin.bracketPlanDE', pluralParams(plan, t, locale.value)) : ''
  return t(plan.byes ? 'admin.bracketPlanByes' : 'admin.bracketPlanSE', pluralParams(plan, t, locale.value))
})
const slotsEditable = computed(() => canManageTournament.value && (arrangeMode.value || bracketEditing.value)
  && !actionLoading.value && !isTournamentActive.value && !isTournamentFinished.value)
const bracketTabLabel = computed(() => t(isRoundRobin.value ? 'admin.tabTable' : isGroupsPlayoff.value ? 'admin.tabGroups' : 'admin.tabBracket'))
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
    if (hasBracket.value && !(await confirmDialog(rebuildConfirmText('admin.rebuildConfirm')))) return
    errorText.value = ''
    if (!(await ensureRegistrationClosed())) return
    const { error } = await supabase.rpc(fn, {
      p_tournament_id: props.id,
      p_mode: drawMode.value,
      p_manual_order: null,
    })
    if (error) throw error
    arrangeMode.value = drawMode.value === 'manual'
    await loadAll()
  } catch (error) {
    // A parallel draw (another tab or organizer) may have changed the bracket:
    // show what the server has now instead of a raw constraint error.
    errorText.value = /duplicate key|could not obtain lock|deadlock/i.test(error?.message ?? '') ? t('drafts.structureConflict') : scoringError(error, t)
    try { await loadAll() } catch { /* Keep the original error. */ }
  } finally { actionLoading.value = false }
}

async function generateGroups() {
  if (actionLoading.value) return
  actionLoading.value = true
  try {
    if (hasGroups.value && !(await confirmDialog(rebuildConfirmText('admin.rebuildConfirm')))) return
    errorText.value = ''
    if (!(await ensureRegistrationClosed())) return
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
    if (hasBracket.value && !(await confirmDialog(rebuildConfirmText('admin.rebuildConfirm'), { danger: true }))) return
    errorText.value = ''
    if (!(await ensureRegistrationClosed())) return
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
    if (!(await confirmDialog(rebuildConfirmText('admin.resetBracketConfirm'), { danger: true }))) return
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

  // Only first-round slots take players (a fed match fills itself from results)
  // and no match may be left empty; a BYE's free pass follows its player.
  const result = swapDraftSlots(localMatches.value, payload)
  if (result === 'empty') errorText.value = t('drafts.bracketLayoutInvalid')
  else if (result === 'ok' && errorText.value === t('drafts.bracketLayoutInvalid')) errorText.value = ''
}

async function saveBracketLayout() {
  if (actionLoading.value) return
  if (bracketConflict.value) { errorText.value = t('drafts.structureConflict'); return }
  // Next-round slots only mirror the BYEs locally; the server advances them itself.
  const changed = localMatches.value.filter((lm) => {
    if (isFedMatch(localMatches.value, lm.id)) return false
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
    const payload = { p_tournament_id: props.id, p_email: addAdminForm.email, p_role: addAdminForm.role }
    // A person already on the team keeps their role unless the organizer confirms the change.
    let { error } = await supabase.rpc('add_tournament_admin_by_email', { ...payload, p_only_new: true })
    if (error?.message?.includes('access.alreadyMember')) {
      const current = error.details
      const labels = { email: addAdminForm.email.trim(), current: t(`admin.${current}`), next: t(`admin.${addAdminForm.role}`) }
      if (current === addAdminForm.role) { errorText.value = t('access.alreadyMemberSame', labels); return }
      if (!(await confirmDialog(t('access.alreadyMemberConfirm', labels)))) return
      ;({ error } = await supabase.rpc('add_tournament_admin_by_email', payload))
    }
    if (error) throw error
    addAdminForm.email = ''
    addAdminForm.role = 'editor'
    addAdminOpen.value = false
    await loadAll()
  } catch (error) {
    errorText.value = accessError(error?.message, t)
  } finally { actionLoading.value = false }
}

// The same upsert RPC changes an existing member's role; the server keeps
// ownership changes to owners and protects the last owner.
async function changeAdminRole(admin, role) {
  if (actionLoading.value || !role || role === admin.role) return
  actionLoading.value = true
  errorText.value = ''
  noticeText.value = ''
  try {
    const { error } = await supabase.rpc('add_tournament_admin_by_email', {
      p_tournament_id: props.id,
      p_email: admin.email,
      p_role: role,
    })
    if (error) throw error
    noticeText.value = t('access.roleChanged')
    await loadAll()
  } catch (error) {
    errorText.value = accessError(error?.message, t)
    await loadAll()
  } finally { actionLoading.value = false }
}

async function removeAdmin(admin) {
  if (actionLoading.value) return
  actionLoading.value = true
  errorText.value = ''
  try {
    const confirmKey = admin.role === 'owner' ? 'access.removeOwnerConfirm' : 'access.removeConfirm'
    if (!(await confirmDialog(t(confirmKey, { email: admin.email }), { danger: true, confirmLabel: t('actions.remove') }))) return
    const { error } = await supabase.rpc('remove_tournament_admin', {
      p_tournament_id: props.id,
      p_admin_id: admin.id,
    })
    if (error) throw error
    await loadAll()
  } catch (error) {
    errorText.value = accessError(error?.message, t)
  } finally { actionLoading.value = false }
}
async function transferOwnership() {
  if (actionLoading.value || currentUserRole.value !== 'owner') return
  const email = addAdminForm.email.trim()
  if (!email) return
  actionLoading.value = true
  try {
    if (!(await confirmDialog(t('access.transfer.confirm', { email }), { danger: true }))) return
    errorText.value = ''
    noticeText.value = ''
    const { error } = await supabase.rpc('transfer_tournament_ownership', {
      p_tournament_id: props.id, p_new_owner_email: email, p_expected_revision: tournament.value.settings_revision,
    })
    if (error) throw error
    closeAddAdmin()
    noticeText.value = t('access.transfer.done')
    await loadAll()
  } catch (error) {
    errorText.value = accessError(error?.message, t)
    await loadAll()
  } finally { actionLoading.value = false }
}
const adminRoleOptions = computed(() => assignableRoles(currentUserRole.value))
const canEditAdmin = admin => canEditMembership(currentUserRole.value, admin.role) && admin.user_id !== auth.user?.id

// Typing the tournament's name is the confirmation for this one irreversible action.
const deleteConfirmName = ref('')
async function deleteTournament() {
  if (actionLoading.value || deleteConfirmName.value.trim() !== tournament.value?.name?.trim()) return
  actionLoading.value = true
  try {
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


const TABS = ['entries', 'bracket', 'courts', 'schedule', 'scores', 'settings']

// Организатору сетка нужна только с двумя одобренными участниками; до этого вкладка
// заблокирована с подсказкой, как «Счёт» до старта. Роль «только результаты» не
// управляет заявками, и для неё сетка остаётся единственным экраном — не блокируем.
// Пока данные грузятся, вкладка считается открытой, чтобы не сбросить deep-link #bracket.
const bracketTabEnabled = computed(() =>
  loading.value || !canManageTournament.value || matches.value.length > 0 || approvedEntries.value.length >= 2)

function isTabEnabled(tab) {
  if (tab === 'bracket') return bracketTabEnabled.value
  // Managers always reach "Scores": before the start it explains when entry opens.
  if (tab === 'scores') return canEditScores.value || canManageTournament.value
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
const pageErrorEl = ref(null)
// Without a loaded tournament errorText is the full-page error, not a banner.
onBeforeUnmount(usePageAlerts({ errorText, noticeText, activeTab, alertEl: pageErrorEl, keepError: () => !tournament.value }))

function setTab(tab) {
  if (!TABS.includes(tab) || !isTabEnabled(tab)) {
    return
  }
  activeTab.value = tab
  // Keep Vue Router's history.state (back/current/position); replacing it with null
  // triggers "history.state seems to have been manually replaced".
  const url = `${window.location.pathname}${window.location.search}#${tab}`
  history.replaceState({ ...(history.state || {}), current: url }, '', url)
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

watch(bracketTabEnabled, () => {
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

  // Wizard redirect flags are consumed once; strip them so refresh doesn't repeat them.
  const { qr, regfail, ...rest } = route.query
  if (qr === '1' && tournament.value?.slug) qrModalOpen.value = true
  if (regfail === '1') errorText.value = t('registrationRules.wizardSaveFailed')
  if (qr !== undefined || regfail !== undefined) router.replace(adminRouteLocation(rest))
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

    <section v-else-if="errorText && !tournament" class="card stack stack--sm" role="alert">
      <p class="error-text">{{ errorText }}</p>
      <p class="muted">{{ t('sync.loadFailedHint') }}</p>
      <div><button class="btn btn--secondary" type="button" @click="retryLoad">{{ t('sync.retry') }}</button></div>
    </section>

    <template v-else-if="tournament && !loading">
      <div v-if="syncFailed" class="alert alert--error" role="status">
        {{ t('sync.unavailable') }}
        <button class="btn btn--secondary btn--sm" type="button" @click="retryLoad">{{ t('sync.retry') }}</button>
      </div>
      <div v-if="errorText" ref="pageErrorEl" class="alert alert--error admin-page-alert" role="alert">
        <span>{{ errorText }}</span>
        <button type="button" class="admin-page-alert__close" :aria-label="t('actions.close')" @click="errorText = ''">×</button>
      </div>
      <div v-if="noticeText" class="alert alert--info admin-page-alert" role="status">
        <span>{{ noticeText }}</span>
        <button type="button" class="admin-page-alert__close" :aria-label="t('actions.close')" @click="noticeText = ''">×</button>
      </div>

      <section class="card card--elevated admin-tournament-overview stack stack--sm" aria-labelledby="adm-tournament-title">
        <div class="admin-tournament-overview__top">
          <div class="admin-tournament-overview__title-block stack stack--sm">
            <div class="admin-tournament-overview__title-row">
              <h1 id="adm-tournament-title" class="page-title">{{ tournament.name }}</h1>
              <span class="badge" :class="statusBadgeClass(tournament.status)">
                {{ t(`tournament.${tournament.status}`) }}
              </span>
            </div>
            <p v-if="tournament.description" class="muted">{{ tournament.description }}</p>
            <p v-if="showStartButton && startBlockReason" id="adm-start-reason" class="sr-only">{{ startBlockReason }}</p>
          </div>
          <div v-if="canManageTournament" class="admin-tournament-overview__actions">
            <CopyTournamentLink
              v-if="showPublicShareActions"
              :slug="tournament.slug"
              :name="tournament.name"
              compact
            />

            <span v-if="showPublicShareActions" class="tooltip-wrapper" :data-tooltip="t('share.qrButton')">
              <button
                class="btn btn--outline btn--sm btn--icon"
                type="button"
                :aria-label="t('share.qrButton')"
                @click="qrModalOpen = true"
              >
                <AppIcon name="qr" :size="18" />
              </button>
            </span>

            <!-- The tournament's main action is a labelled button, set apart from the share icons. -->
            <span v-if="showStartButton || isTournamentActive" class="admin-tournament-overview__divider" aria-hidden="true" />
            <button
              v-if="showStartButton"
              class="btn btn--success btn--sm"
              type="button"
              :disabled="!canStartTournament || actionLoading"
              :aria-describedby="startBlockReason ? 'adm-start-reason' : undefined"
              @click="startTournament"
            >
              <AppIcon name="play" :size="16" />
              {{ t('admin.startTournament') }}
            </button>
            <template v-if="isTournamentActive">
              <button
                class="btn btn--outline btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="stopTournament"
              >
                <AppIcon name="stop" :size="16" />
                {{ t('admin.stopTournament') }}
              </button>
              <button
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="finishTournament"
              >
                {{ t('admin.finishTournament') }}
              </button>
            </template>
          </div>
        </div>

      </section>

      <TournamentNextStep
        v-if="canManageTournament"
        :status="tournament.status"
        :format="tournament.format"
        :approved-count="approvedEntries.length"
        :pending-count="pendingEntries.length"
        :matches-count="matches.length"
        :busy="actionLoading || settingsSaving"
        @go="setTab"
        @close-registration="closeRegistration"
        @start="startTournament"
      />

      <TournamentChampion
        :format="tournament.format"
        :status="tournament.status"
        :matches="matches"
        :standings="standings"
        :entries-map="entriesMap"
        :can-finish="canManageTournament"
        :busy="actionLoading || settingsSaving"
        @finish="finishTournament"
      />

      <p v-if="showDeadlineHint" class="alert alert--info" role="status">{{ t('registrationRules.deadlineCloseHint') }}</p>

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
          {{ t('admin.tabParticipants') }}
          <span v-if="pendingEntries.length" class="tab__badge">{{ pendingEntries.length }}</span>
        </button>
        <span class="tooltip-wrapper" :data-tooltip="!bracketTabEnabled ? t('admin.bracketLockedTooltip') : undefined">
          <button
            id="tab-bracket"
            role="tab"
            class="tab"
            :class="{ 'tab--active': activeTab === 'bracket' }"
            :aria-selected="activeTab === 'bracket'"
            :aria-disabled="!bracketTabEnabled"
            :tabindex="activeTab === 'bracket' ? 0 : -1"
            :disabled="!bracketTabEnabled"
            aria-controls="panel-bracket"
            @click="setTab('bracket')"
          >
            {{ bracketTabLabel }}
          </button>
        </span>
        <button
          v-if="canManageTournament"
          id="tab-courts"
          role="tab"
          class="tab"
          :class="{ 'tab--active': activeTab === 'courts' }"
          :aria-selected="activeTab === 'courts'"
          :tabindex="activeTab === 'courts' ? 0 : -1"
          aria-controls="panel-courts"
          @click="setTab('courts')"
        >
          {{ t('schedule.courts') }}
        </button>
        <button
          v-if="canManageTournament"
          id="tab-schedule"
          role="tab"
          class="tab"
          :class="{ 'tab--active': activeTab === 'schedule' }"
          :aria-selected="activeTab === 'schedule'"
          :tabindex="activeTab === 'schedule' ? 0 : -1"
          aria-controls="panel-schedule"
          @click="setTab('schedule')"
        >
          {{ t('schedule.tab') }}
          <span v-if="scheduleDraftCount" class="tab__badge">{{ scheduleDraftCount }}</span>
        </button>
        <span class="tooltip-wrapper" :data-tooltip="!isTabEnabled('scores') ? t('admin.scoresLockedTooltip') : undefined">
          <button
            id="tab-scores"
            role="tab"
            class="tab"
            :class="{ 'tab--active': activeTab === 'scores' }"
            :aria-selected="activeTab === 'scores'"
            :aria-disabled="!isTabEnabled('scores')"
            :tabindex="activeTab === 'scores' ? 0 : -1"
            :disabled="!isTabEnabled('scores')"
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
            <div class="admin-list-header mb-3">
              <h3 class="section-title section-title--sm">
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
            <div v-if="pendingEntries.length" class="entry-list">
              <div v-for="entry in pendingEntries" :key="entry.id" class="participant-item">
                <span class="entry-avatar">{{ entryInitials(entry) }}</span>
                <strong class="entry-name">{{ entryLabel(entry) }}<EntryContact :contact="entryContacts[entry.id]" /></strong>
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

            <div v-if="waitlistedEntries.length" class="waitlist-entries">
              <h3 class="section-title section-title--sm my-3">
                {{ t('registrationRules.waitlistSection') }}
                <span class="badge badge--neutral">{{ waitlistedEntries.length }}</span>
              </h3>
              <p v-if="waitlistSeatFree" class="alert alert--info" role="status">
                {{ t('registrationRules.waitlistSeatFree', { count: waitlistedEntries.length }) }}
              </p>
              <div class="entry-list">
                <div v-for="(entry, index) in waitlistedEntries" :key="entry.id" class="participant-item">
                  <span class="entry-avatar" :aria-label="String(index + 1)">{{ index + 1 }}</span>
                  <strong class="entry-name">{{ entryLabel(entry) }}<EntryContact :contact="entryContacts[entry.id]" /></strong>
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
            </div>

            <details v-if="rejectedEntries.length" class="rejected-entries">
              <summary>
                {{ t('mobile.rejectedEntries') }}
                <span class="badge badge--neutral">{{ rejectedEntries.length }}</span>
              </summary>
              <div class="entry-list rejected-entries__list">
                <div v-for="entry in rejectedEntries" :key="entry.id" class="participant-item">
                  <span class="entry-avatar">{{ entryInitials(entry) }}</span>
                  <strong class="entry-name">{{ entryLabel(entry) }}<EntryContact :contact="entryContacts[entry.id]" /></strong>
                  <button class="btn btn--ghost btn--sm" type="button" :disabled="actionLoading" @click="updateEntryStatus(entry.id, 'pending')">
                    {{ t('mobile.restoreEntry') }}
                  </button>
                </div>
              </div>
            </details>
          </div>

          <div v-if="!isTournamentActive" class="divider" />

          <div>
            <div class="row row--between mb-3">
              <h3 class="section-title section-title--sm">
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
            <template v-if="approvedEntries.length">
              <p v-if="canSeed" class="field-hint mb-3">{{ t('admin.seedHint') }}</p>
              <input
                v-if="approvedEntries.length > 8"
                v-model="approvedQuery"
                class="input entry-search"
                type="search"
                :placeholder="t('admin.searchEntries')"
                :aria-label="t('admin.searchEntries')"
              />
              <div v-if="filteredApproved.length" class="entry-list">
                <div v-for="entry in filteredApproved" :key="entry.id" class="participant-item">
                  <span class="entry-seed" :title="t('admin.seedLabel')">{{ seedPosition(entry) }}</span>
                  <span class="entry-avatars" :class="{ 'entry-avatars--pair': memberInitials(entry).length > 1 }" aria-hidden="true">
                    <span v-for="(initials, i) in memberInitials(entry)" :key="i" class="entry-avatar entry-avatar--ok">{{ initials }}</span>
                  </span>
                  <strong class="entry-name">{{ entryLabel(entry) }}<EntryContact :contact="entryContacts[entry.id]" /></strong>
                  <KebabMenu
                    v-if="!isTournamentActive && !isTournamentFinished"
                    :aria-label="t('admin.rowActions', { name: entryLabel(entry) })"
                  >
                    <template v-if="canSeed">
                      <button type="button" role="menuitem" :disabled="actionLoading || seedPosition(entry) === 1" @click="moveSeed(entry, -1)">{{ t('admin.seedUp') }}</button>
                      <button type="button" role="menuitem" :disabled="actionLoading || seedPosition(entry) === sortedApproved.length" @click="moveSeed(entry, 1)">{{ t('admin.seedDown') }}</button>
                    </template>
                    <button type="button" role="menuitem" :disabled="actionLoading" @click="updateEntryStatus(entry.id, 'pending')">{{ t('admin.reopen') }}</button>
                    <button type="button" role="menuitem" class="kebab__danger" :disabled="actionLoading" @click="updateEntryStatus(entry.id, 'rejected')">{{ t('admin.reject') }}</button>
                  </KebabMenu>
                </div>
              </div>
              <p v-else class="muted">{{ t('admin.noSearchResults') }}</p>
            </template>
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
                <p v-else class="muted text-sm">{{ t('admin.allPlayersAssigned') }}</p>
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
                        :aria-label="t('actions.remove')"
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
                        :aria-label="t('actions.remove')"
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
                <p v-else class="muted text-sm">{{ t('admin.allPlayersAssigned') }}</p>
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
                        :aria-label="t('actions.remove')"
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
                        :aria-label="t('actions.remove')"
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
          <section v-if="isNarrowLayout && isTournamentActive && matches.length && adminMobileBracketSurface === 'matches'" class="card mobile-score-center mt-3">
            <TournamentMatchList :format="tournament.format" :matches="matches" :entries-map="entriesMap" :sets-by-match="setsByMatch" :live-scores-by-match="liveScoresByMatch" :can-edit-final="canEditFinalScores" :can-live-score="canUseLiveScoring" @edit-result="openRrMatch" @view-live="openLiveScoring" />
          </section>
        <!-- Round-robin: schedule + standings + fixtures -->
        <template v-if="isRoundRobin">
          <section v-if="canManageTournament && !isTournamentActive" class="card stack stack--sm">
            <h2 class="section-title">{{ t('standings.matchesTitle') }}</h2>
            <p class="muted">{{ t('standings.rrPlan', pluralParams(rrPlan, t, locale)) }}</p>
            <p v-if="hasBracket" class="muted">{{ t('standings.rrRegenerateWarn') }}</p>
            <div class="inline-actions">
              <button
                class="btn btn--sm"
                :class="hasBracket ? 'btn--danger' : 'btn--primary'"
                type="button"
                :disabled="actionLoading || approvedEntries.length < 2"
                @click="generateSchedule"
              >
                {{ hasBracket ? t('standings.regenerateSchedule') : t('standings.generateSchedule') }}
              </button>
            </div>
          </section>

          <section v-if="hasBracket && standings.length && showAdminBracketOverview" class="card stack stack--sm mt-4">
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

          <section v-if="hasBracket && !isNarrowLayout" class="card mt-4">
            <TournamentMatchList
              :format="tournament.format"
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
        </template>

        <!-- Groups + playoff -->
        <template v-else-if="isGroupsPlayoff">
          <section v-if="canManageTournament && !isTournamentActive" class="card stack stack--sm">
            <h2 class="section-title">{{ t('admin.groupStage') }}</h2>
            <fieldset v-if="!hasGroups" class="group-setup">
              <legend class="group-setup__legend">{{ t('admin.groupCount') }}</legend>
              <div v-if="groupOptions.length" class="group-setup__options" role="radiogroup" :aria-label="t('admin.groupCount')">
                <label v-for="g in groupOptions" :key="g" class="group-setup__option" :class="{ 'is-active': Number(groupCount) === g }">
                  <input v-model.number="groupCount" class="sr-only" type="radio" name="grp-count" :value="g" />
                  {{ g }}
                </label>
              </div>
              <p v-else class="muted">{{ t('admin.groupNeedMore') }}</p>
              <p v-if="groupOptions.length" class="format-plan">{{ groupPlanText }}</p>
              <p class="field-hint">{{ t('admin.groupSeedingHint') }}</p>
            </fieldset>
            <div class="inline-actions">
              <button
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading || (!hasGroups && !groupOptions.length)"
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

          <section v-if="hasGroups && showAdminBracketOverview" class="card stack stack--sm mt-4">
            <h2 class="section-title">{{ t('admin.groupStage') }}</h2>
            <GroupStageBoard :groups="groupsView" :entries-map="entriesMap" :family="tournamentScoringFamily"  :sets-by-match="setsByMatch" :live-scores-by-match="liveScoresByMatch" @view-live="openLiveScoring" />
          </section>

          <section v-if="hasPlayoff && showAdminBracketOverview" class="card stack stack--sm mt-4">
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
          <h2 class="section-title">{{ t('admin.drawSection') }}</h2>
          <p v-if="bracketPlanText" class="muted format-plan">{{ bracketPlanText }}</p>
          <p v-if="doubleElimCountInvalid" class="alert alert--info" role="status">{{ t('admin.doubleElimNeedsPow2', { n: approvedEntries.length }) }}</p>

          <div class="form-field form-field--narrow">
            <label for="adm-draw">{{ t('admin.drawMode') }}</label>
            <select id="adm-draw" v-model="drawMode" class="input" aria-describedby="adm-draw-hint">
              <option value="auto-random">{{ t('admin.drawRandom') }}</option>
              <option value="manual">{{ t('admin.drawManual') }}</option>
            </select>
            <p id="adm-draw-hint" class="field-hint">{{ t(drawMode === 'manual' ? 'admin.drawManualHint' : 'admin.drawRandomHint') }}</p>
          </div>

          <template v-if="!hasBracket">
            <div class="inline-actions">
              <button
                class="btn btn--primary btn--sm"
                type="button"
                :disabled="actionLoading || bracketPlanBlocked || approvedEntries.length < 2"
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
                :disabled="actionLoading || doubleElimCountInvalid"
                @click="generateBracket"
              >
                {{ drawMode === 'manual' ? t('admin.rebuildManual') : t('admin.rebuild') }}
              </button>
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="resetBracket"
              >
                {{ t('admin.resetBracket') }}
              </button>
              <button
                class="btn btn--sm"
                :class="arrangeMode ? 'btn--primary' : 'btn--outline'"
                type="button"
                :aria-pressed="arrangeMode"
                :disabled="actionLoading || bracketEditing"
                @click="arrangeMode = !arrangeMode"
              >
                {{ arrangeMode ? t('admin.arrangeDone') : t('admin.arrangeSlots') }}
              </button>
            </div>
            <p v-if="arrangeMode || bracketEditing" class="field-hint">{{ t(isDoubleElim ? 'admin.arrangeHintDE' : 'admin.arrangeHint') }}</p>
          </template>
        </section>

        <section v-if="!isRoundRobin && !isGroupsPlayoff && !hasBracket && !canManageTournament" class="card empty-state">
          <p class="empty-state__hint">{{ t('bracket.empty') }}</p>
        </section>
        <section v-if="!isRoundRobin && !isGroupsPlayoff && hasBracket && showAdminBracketOverview" class="card stack stack--sm mt-4">
          <DoubleElimBoard
            v-if="isDoubleElim"
            :matches="displayMatches"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :live-scores-by-match="liveScoresByMatch"
            :can-live-score="canEditScores"
            :editable-slots="slotsEditable"
            @swap-slots="swapBracketSlots"
            @view-live="openLiveScoring"
          />
          <BracketBoard
            v-else
            :matches="displayMatches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          :editable-slots="slotsEditable"
          :can-live-score="canEditScores"
          @swap-slots="swapBracketSlots"
          @view-live="openLiveScoring"
        />
          <div v-if="bracketConflict" class="alert alert--info" role="status">
            {{ t('drafts.structureConflict') }}
            <button class="btn btn--ghost btn--sm" type="button" :disabled="actionLoading" @click="reloadBracketDraft">{{ t('drafts.reload') }}</button>
          </div>
          <div v-if="bracketEditing" class="inline-actions mt-2">
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
        v-show="canManageTournament"
        id="panel-courts"
        role="tabpanel"
        aria-labelledby="tab-courts"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'courts' }"
      >
        <!-- Без v-if: черновик кортов не должен пропадать при переключении вкладок -->
        <CourtsEditor
          class="card courts-panel"
          :courts="courts"
          :schedule="schedule"
          :tournament="tournament"
          :disabled="actionLoading || settingsSaving || !canManageTournament"
          @save="saveCourts"
        />
      </div>

      <div
        v-show="canManageTournament"
        id="panel-schedule"
        role="tabpanel"
        aria-labelledby="tab-schedule"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'schedule' }"
      >
        <ScheduleBoard
          v-if="activeTab === 'schedule'"
          :tournament="tournament"
          :matches="matches"
          :entries-map="entriesMap"
          :courts="courts"
          :schedule="schedule"
          :live-scores-by-match="liveScoresByMatch"
          :busy="actionLoading || settingsSaving"
          :can-manage="canManageTournament"
          @assign="scheduleMatch = $event"
          @publish="publishSchedule"
          @revert="revertSchedule"
          @move="moveScheduleItem"
          @open-courts="setTab('courts')"
        />
      </div>

      <div
        id="panel-scores"
        role="tabpanel"
        aria-labelledby="tab-scores"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'scores' }"
      >
        <section v-if="isTournamentFinished" class="card empty-state">
          <AppIcon name="trophy" :size="28" class="empty-state__icon" />
          <h2 class="empty-state__title">{{ t('lifecycle.completedTitle') }}</h2>
          <p class="empty-state__hint">{{ t('lifecycle.scoresCompletedHint') }}</p>
          <button class="btn btn--outline btn--sm" type="button" @click="setTab('bracket')">{{ t('lifecycle.openBracket') }}</button>
        </section>
        <section v-else-if="!canEditScores" class="card empty-state">
          <AppIcon name="play" :size="28" class="empty-state__icon" />
          <h2 class="empty-state__title">{{ t('admin.scoresBeforeStartTitle') }}</h2>
          <p class="empty-state__hint">{{ startBlockReason || t('admin.scoresLockedTooltip') }}</p>
        </section>
        <section v-else-if="isNarrowLayout" class="card mobile-score-center">
          <TournamentMatchList
            :format="tournament.format"
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

          <section v-if="standings.length" class="card stack stack--sm mt-4">
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

        <section class="card stack stack--sm mt-4 admin-settings-card">
          <div class="settings-section__head">
            <h2 class="section-title" style="margin: 0">{{ t('access.whoManages') }}</h2>
            <InfoTip :text="`${t('access.matrixIntro')} ${t('access.ownerOnlyHint')}`" />
          </div>
          <AccessMatrix compact />
          <div class="divider" />
          <div class="settings-section__head">
            <h3 class="section-title section-title--sm">{{ t('admin.admins') }}</h3>
            <button v-if="canManageTournament" class="btn btn--outline btn--sm admin-add-btn" type="button" :disabled="actionLoading" @click="openAddAdmin">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
              {{ t('admin.addAssistant') }}
            </button>
          </div>
          <div class="entry-list">
            <div v-for="admin in admins" :key="admin.id" class="participant-item">
              <span class="entry-avatar">{{ (admin.email || '?').slice(0, 2).toUpperCase() }}</span>
              <div class="entry-name row">
                <span class="text-sm">{{ admin.email }}</span>
                <select
                  v-if="canEditAdmin(admin)"
                  class="input input--inline"
                  :value="admin.role"
                  :disabled="actionLoading"
                  :aria-label="`${t('access.changeRole')}: ${admin.email}`"
                  @change="changeAdminRole(admin, $event.target.value)"
                >
                  <option v-for="role in adminRoleOptions" :key="role" :value="role">{{ t(`admin.${role}`) }}</option>
                </select>
                <span v-else class="badge badge--neutral">{{ t(`admin.${admin.role}`) }}</span>
              </div>
              <button
                v-if="canEditAdmin(admin)"
                class="btn btn--ghost btn--sm"
                type="button"
                :disabled="actionLoading"
                @click="removeAdmin(admin)"
              >
                {{ t('actions.remove') }}
              </button>
            </div>
          </div>

        </section>

        <AppModal v-if="addAdminOpen" :label="t('admin.addAssistant')" @close="closeAddAdmin">
          <form class="modal-dialog add-admin-modal" @submit.prevent="submitAddAdmin">
            <header class="modal-dialog__head">
              <div>
                <h2 class="section-title" style="margin: 0">{{ t('admin.addAssistant') }}</h2>
                <p class="muted" style="margin: 4px 0 0">{{ t('admin.addAssistantHint') }}</p>
              </div>
              <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="closeAddAdmin">×</button>
            </header>
            <div class="form-field">
              <label for="adm-email">{{ t('admin.adminEmail') }}</label>
              <input id="adm-email" v-model="addAdminForm.email" class="input" type="email" required autocomplete="off" autofocus :disabled="actionLoading" :placeholder="t('admin.adminEmailPlaceholder')" />
            </div>
            <div class="form-field">
              <label for="adm-role">{{ t('admin.role') }}</label>
              <select id="adm-role" v-model="addAdminForm.role" class="input" :disabled="actionLoading">
                <option v-for="role in adminRoleOptions" :key="role" :value="role">{{ t(`admin.${role}`) }}</option>
              </select>
            </div>
            <label v-if="addAdminForm.role === 'owner' && currentUserRole === 'owner'" class="checkbox-row add-admin-modal__transfer" for="adm-transfer-mode">
              <input id="adm-transfer-mode" v-model="transferMode" type="checkbox" :disabled="actionLoading" />
              <span>
                <span class="add-admin-modal__transfer-title">{{ t('access.transfer.title') }}</span>
                <span class="muted add-admin-modal__transfer-hint">{{ t('access.transfer.hint') }}</span>
              </span>
            </label>
            <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
            <footer class="add-admin-modal__foot">
              <button class="btn btn--ghost" type="button" :disabled="actionLoading" @click="closeAddAdmin">{{ t('actions.cancel') }}</button>
              <button class="btn" :class="transferMode && addAdminForm.role === 'owner' ? 'btn--danger' : 'btn--primary'" type="submit" :disabled="actionLoading || !addAdminForm.email">
                {{ transferMode && addAdminForm.role === 'owner' ? t('access.transfer.button') : t('admin.add') }}
              </button>
            </footer>
          </form>
        </AppModal>

        <!-- Finishing lives in the page header; only the irreversible delete stays here. -->
        <section v-if="currentUserRole === 'owner'" class="card danger-zone" aria-labelledby="adm-danger-title">
          <h2 id="adm-danger-title" class="section-title danger-zone__title">{{ t('admin.dangerZone') }}</h2>
          <div class="danger-zone__row">
            <div class="danger-zone__text">
              <strong>{{ t('admin.deleteTournament') }}</strong>
              <p class="muted">{{ t('admin.deleteTournamentHint') }}</p>
              <label class="danger-zone__label" for="adm-delete-confirm">{{ t('admin.deleteTypeName', { name: tournament.name }) }}</label>
              <input id="adm-delete-confirm" v-model="deleteConfirmName" class="input danger-zone__input" type="text" autocomplete="off" spellcheck="false" />
            </div>
            <button
              class="btn btn--danger btn--sm"
              type="button"
              :disabled="actionLoading || deleteConfirmName.trim() !== tournament.name.trim()"
              @click="deleteTournament"
            >
              {{ t('admin.deleteTournament') }}
            </button>
          </div>
        </section>
      </div>

      <LiveScoringModal
        v-if="selectedLiveMatch && canUseLiveScoring"
        :match="matches.find(m => m.id === selectedLiveMatch.id) || selectedLiveMatch"
        :can-stop-live="scoreAccess.stopLive"
        :live-score="selectedLiveScore"
        :scoring-config="tournament.scoring_config || {}"
        :team-a="teamLabel(selectedLiveMatch.side_a_entry_id)"
        :team-b="teamLabel(selectedLiveMatch.side_b_entry_id)"
        @close="closeAdminScoreModal"
        @changed="scheduleScoreReload"
      />

      <MatchScheduleModal
        v-if="scheduleMatch && tournament"
        :match="scheduleMatch"
        :current="scheduleIndex.draft[scheduleMatch.id] || null"
        :courts="courts"
        :matches="matches"
        :entries-map="entriesMap"
        :tournament="tournament"
        @close="scheduleMatch = null"
        @saved="scheduleScoreReload"
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

.entry-seed {
  flex-shrink: 0;
  min-width: 1.75rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.entry-avatars { display: inline-flex; flex-shrink: 0; }
.entry-avatars--pair .entry-avatar { width: 30px; height: 30px; font-size: 0.7rem; border: 2px solid var(--surface); }
.entry-avatars--pair .entry-avatar + .entry-avatar { margin-left: -8px; }

.entry-search { max-width: 320px; margin-bottom: var(--space-3); }

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
.add-admin-modal { max-width: 440px; display: grid; gap: var(--space-4); }
.add-admin-modal__foot { display: flex; justify-content: flex-end; gap: var(--space-2); padding-top: var(--space-2); }
.admin-add-btn { margin-left: auto; }
.add-admin-modal__transfer { align-items: flex-start; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-row); }
.add-admin-modal__transfer input { margin-top: 3px; }
.add-admin-modal__transfer-title { display: block; font-weight: 600; }
.add-admin-modal__transfer-hint { display: block; font-size: 0.82rem; line-height: 1.4; margin-top: 2px; }
</style>
