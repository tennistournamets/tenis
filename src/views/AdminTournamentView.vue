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
import LiveScoringModal from '../components/LiveScoringModal.vue'
import TournamentQrModal from '../components/TournamentQrModal.vue'
import ScoreEditor from '../components/ScoreEditor.vue'
import { entryMemberNames } from '../lib/entryDisplay'
import { confirmDialog } from '../lib/confirmDialog'
import { supabase } from '../lib/supabase'
import { copyTournamentLink } from '../lib/shareLink'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  id: {
    type: String,
    required: true,
  },
})

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const tournament = ref(null)
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
const copyFeedback = ref(false)
const qrModalOpen = ref(false)

const statusValue = ref('draft')
const settingsForm = reactive({
  name: '',
  slug: '',
  description: '',
  category: 'singles',
  set_format: 'best_of_3',
  doubles_pairing_mode: 'pre_agreed',
})
const settingsBaseline = ref({
  status: 'draft',
  is_public: false,
  name: '',
  slug: '',
  description: '',
  category: 'singles',
  set_format: 'best_of_3',
  doubles_pairing_mode: 'pre_agreed',
})
const drawMode = ref('auto-random')
const bracketEditing = ref(false)
const localMatches = ref([])
const selectedLiveMatch = ref(null)

const addAdminForm = reactive({
  email: '',
  role: 'editor',
})

const addEntryForm = reactive({
  memberOne: '',
  memberTwo: '',
  displayName: '',
  phoneOrEmail: '',
  asPending: false,
})

const addEntryError = ref('')
const addEntrySuccess = ref('')
const addEntryContactTouched = ref(false)
const addEntryAccordionOpen = ref(false)

const manualPairingOpen = ref(false)
const manualPairSlots = ref([])
const manualPairingDragOver = ref(null)
const pairingEditMode = ref(false)
const editModePlayers = ref([])

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phonePattern = /^\+?[\d\s\-()]{7,20}$/

function isValidContact(value) {
  const trimmed = String(value).trim()
  return emailPattern.test(trimmed) || phonePattern.test(trimmed)
}

const addEntryContactInvalid = computed(() => {
  const v = addEntryForm.phoneOrEmail.trim()
  return addEntryContactTouched.value && Boolean(v) && !isValidContact(addEntryForm.phoneOrEmail)
})

let addEntrySuccessTimer = null

let channel = null
let reloadTimer = null

const entriesMap = computed(() => {
  return entries.value.reduce((acc, entry) => {
    acc[entry.id] = entry
    return acc
  }, {})
})

const setsByMatch = computed(() => {
  return matchSets.value.reduce((acc, item) => {
    if (!acc[item.match_id]) {
      acc[item.match_id] = []
    }
    acc[item.match_id].push(item)
    return acc
  }, {})
})

const liveScoresByMatch = computed(() => {
  return liveScores.value.reduce((acc, item) => {
    acc[item.match_id] = item
    return acc
  }, {})
})

const pendingEntries = computed(() => entries.value.filter((entry) => entry.status === 'pending'))
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

const hasTournamentSettingsChanges = computed(() => {
  if (!tournament.value) {
    return false
  }
  const b = settingsBaseline.value
  return (
    statusValue.value !== b.status ||
    Boolean(tournament.value.is_public) !== b.is_public ||
    settingsForm.name !== b.name ||
    settingsForm.description !== b.description ||
    settingsForm.category !== b.category ||
    settingsForm.set_format !== b.set_format ||
    settingsForm.doubles_pairing_mode !== b.doubles_pairing_mode
  )
})

const canStartTournament = computed(
  () => tournament.value?.status === 'registration_closed' && matches.value.length > 0,
)
const isTournamentActive = computed(() => tournament.value?.status === 'in_progress')
const isTournamentFinished = computed(() => tournament.value?.status === 'completed')
const canManageTournament = computed(() => currentUserRole.value === 'owner' || currentUserRole.value === 'editor')
const canLiveScoreRole = computed(() => ['owner', 'editor', 'counter'].includes(currentUserRole.value))
const canEditScores = computed(() => isTournamentActive.value && canLiveScoreRole.value)
const canEditFinalScores = computed(() => isTournamentActive.value && canManageTournament.value)

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

const isSettingsDropdownDisabled = computed(() => isTournamentActive.value || isTournamentFinished.value)

async function startTournament() {
  if (!(await confirmDialog(t('admin.startTournamentConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase
    .from('tournaments')
    .update({ status: 'in_progress' })
    .eq('id', props.id)

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function finishTournament() {
  if (!(await confirmDialog(t('admin.finishTournamentConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase
    .from('tournaments')
    .update({ status: 'completed' })
    .eq('id', props.id)

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function stopTournament() {
  if (!(await confirmDialog(t('admin.stopTournamentConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase
    .from('tournaments')
    .update({ status: 'registration_closed' })
    .eq('id', props.id)

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function assertAccess() {
  const { data, error } = await supabase.rpc('get_my_tournament_role', {
    p_tournament_id: props.id,
  })

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error(t('errors.noAccess'))
  }

  currentUserRole.value = data
}

async function loadTournament() {
  const { data, error } = await supabase
    .from('tournaments')
    .select('id, name, slug, description, sport, format, category, status, set_format, is_public, doubles_pairing_mode, format_config, scoring_config')
    .eq('id', props.id)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error(t('errors.notFound'))
  }

  tournament.value = data
  statusValue.value = data.status
  settingsForm.name = data.name
  settingsForm.slug = data.slug || ''
  settingsForm.description = data.description || ''
  settingsForm.category = data.category
  settingsForm.set_format = data.set_format
  settingsForm.doubles_pairing_mode = data.doubles_pairing_mode || 'pre_agreed'
  settingsBaseline.value = {
    status: data.status,
    is_public: Boolean(data.is_public),
    name: data.name,
    slug: data.slug || '',
    description: data.description || '',
    category: data.category,
    set_format: data.set_format,
    doubles_pairing_mode: data.doubles_pairing_mode || 'pre_agreed',
  }
}

async function loadEntries() {
  const { data, error } = await supabase
    .from('entries')
    .select('id, display_name, entry_type, status, created_at')
    .eq('tournament_id', props.id)
    .order('created_at', { ascending: true })

  if (error) {
    throw error
  }

  const entryRows = data || []
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

  entries.value = entryRows
}

async function loadMatchesAndSets() {
  const { data: matchesData, error: matchesError } = await supabase
    .from('matches')
    .select(
      'id, tournament_id, stage, group_id, round_number, match_number, side_a_entry_id, side_b_entry_id, winner_entry_id, side_a_score, side_b_score, side_a_pens, side_b_pens, status, next_match_id, next_slot, loser_next_match_id, loser_next_slot',
    )
    .eq('tournament_id', props.id)
    .order('round_number', { ascending: true })
    .order('match_number', { ascending: true })

  if (matchesError) {
    throw matchesError
  }

  matches.value = matchesData || []

  if (!matches.value.length) {
    matchSets.value = []
    liveScores.value = []
    return
  }

  const ids = matches.value.map((match) => match.id)

  const { data: setsData, error: setsError } = await supabase
    .from('match_sets')
    .select('id, match_id, set_index, side_a_games, side_b_games')
    .in('match_id', ids)
    .order('set_index', { ascending: true })

  if (setsError) {
    throw setsError
  }

  matchSets.value = setsData || []

  const { data: liveData, error: liveError } = await supabase
    .from('live_scores')
    .select('id, match_id, tournament_id, status, state, history, revision, created_at, updated_at')
    .eq('tournament_id', props.id)

  if (liveError) {
    throw liveError
  }

  liveScores.value = liveData || []
}

async function loadAdmins() {
  const { data, error } = await supabase.rpc('get_tournament_admins_with_email', {
    p_tournament_id: props.id,
  })

  if (error) {
    console.warn('loadAdmins:', error.message)
    admins.value = []
    return
  }

  admins.value = data || []
}

async function loadAll(silent = false) {
  if (!auth.user) {
    return
  }

  // Silent reloads (score saves, realtime pings) refresh data in place
  // without unmounting the page — keeps the scroll position.
  if (!silent) {
    loading.value = true
  }
  errorText.value = ''

  try {
    await assertAccess()
    await loadTournament()
    await Promise.all([
      loadEntries(),
      loadMatchesAndSets(),
      isRoundRobin.value ? loadStandings() : Promise.resolve((standings.value = [])),
      isGroupsPlayoff.value ? loadGroups() : Promise.resolve((groups.value = [])),
      canManageTournament.value ? loadAdmins() : Promise.resolve((admins.value = [])),
    ])
    setupRealtime()
  } catch (error) {
    errorText.value = error.message || t('errors.generic')
  } finally {
    if (!silent) {
      loading.value = false
    }
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    loadAll(true)
  }, 300)
}

function onMatchSetsChange(payload) {
  if (payload.eventType === 'DELETE') {
    // DELETE payloads may only carry the row id — remove by id, no
    // tournament check (ids of other tournaments are simply not in the list).
    if (!payload.old?.id) return
    matchSets.value = matchSets.value.filter((row) => row.id !== payload.old.id)
    return
  }
  const row = payload.new
  if (!row?.id || !row.match_id) return
  const belongsToTournament = matches.value.some((m) => m.id === row.match_id)
  if (!belongsToTournament) {
    return
  }
  const idx = matchSets.value.findIndex((item) => item.id === row.id)
  if (idx >= 0) {
    matchSets.value[idx] = row
  } else {
    // Drop any stale row occupying the same (match, set) slot before adding.
    matchSets.value = [
      ...matchSets.value.filter((item) => !(item.match_id === row.match_id && item.set_index === row.set_index)),
      row,
    ]
  }
}

function onMatchesChange(payload) {
  const tournamentId = payload.new?.tournament_id || payload.old?.tournament_id
  if (tournamentId !== props.id) {
    return
  }
  if (payload.eventType === 'DELETE') {
    if (!payload.old?.id) return
    matches.value = matches.value.filter((row) => row.id !== payload.old.id)
    return
  }
  if (!payload.new?.id) return
  const idx = matches.value.findIndex((row) => row.id === payload.new.id)
  if (idx >= 0) {
    matches.value[idx] = { ...matches.value[idx], ...payload.new }
  } else {
    matches.value = [...matches.value, payload.new]
  }
}

function onLiveScoresChange(payload) {
  const tournamentId = payload.new?.tournament_id || payload.old?.tournament_id
  if (tournamentId !== props.id) {
    return
  }
  if (payload.eventType === 'DELETE') {
    if (!payload.old?.id) return
    liveScores.value = liveScores.value.filter((row) => row.id !== payload.old.id)
    return
  }
  if (!payload.new?.id) return
  const idx = liveScores.value.findIndex((row) => row.id === payload.new.id)
  if (idx >= 0) {
    liveScores.value[idx] = payload.new
  } else {
    liveScores.value = [...liveScores.value, payload.new]
  }
}

function setupRealtime() {
  if (channel) {
    supabase.removeChannel(channel)
  }

  channel = supabase
    .channel(`admin-${props.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${props.id}` }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries', filter: `tournament_id=eq.${props.id}` }, scheduleReload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${props.id}` }, onMatchesChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'match_sets' }, onMatchSetsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_scores', filter: `tournament_id=eq.${props.id}` }, onLiveScoresChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_admins', filter: `tournament_id=eq.${props.id}` }, scheduleReload)

  channel.subscribe()
}

async function updateEntryStatus(entryId, status) {
  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase.from('entries').update({ status }).eq('id', entryId)

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function approveAllPending() {
  if (pendingEntries.value.length < 2) {
    return
  }
  if (!(await confirmDialog(t('admin.approveAllConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase
    .from('entries')
    .update({ status: 'approved' })
    .eq('tournament_id', props.id)
    .eq('status', 'pending')

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

function resetAddEntryFeedback() {
  addEntryError.value = ''
  addEntrySuccess.value = ''
  clearTimeout(addEntrySuccessTimer)
  addEntrySuccessTimer = null
}

async function addEntryManually() {
  resetAddEntryFeedback()
  addEntryContactTouched.value = true

  const category = tournament.value?.category
  const pMode = tournament.value?.doubles_pairing_mode
  const m1 = addEntryForm.memberOne.trim()
  const m2 = addEntryForm.memberTwo.trim()

  const requireBothMembers = category === 'doubles' && pMode !== 'pick_random'
  if (!m1 || (requireBothMembers && !m2)) {
    addEntryError.value = t('admin.addEntryInvalidMembers')
    return
  }

  if (addEntryForm.phoneOrEmail.trim() && !isValidContact(addEntryForm.phoneOrEmail)) {
    addEntryError.value = t('registrationForm.invalidContact')
    return
  }

  let phoneOrEmail = addEntryForm.phoneOrEmail.trim()
  if (!phoneOrEmail) {
    phoneOrEmail = `admin-entry-${crypto.randomUUID()}@local.tenis`
  }

  const customName = addEntryForm.displayName.trim()
  const displayName =
    customName || (category === 'singles' ? m1 : (m2 ? `${m1} / ${m2}` : m1))

  actionLoading.value = true

  const { data: entryRow, error: insertError } = await supabase
    .from('entries')
    .insert({
      tournament_id: props.id,
      entry_type: category,
      display_name: displayName,
      phone_or_email: phoneOrEmail,
      status: addEntryForm.asPending ? 'pending' : 'approved',
    })
    .select('id')
    .single()

  if (insertError || !entryRow) {
    actionLoading.value = false
    const msg = insertError?.message || ''
    const dup =
      /duplicate key|unique constraint|already exists/i.test(msg) ||
      insertError?.code === '23505'
    addEntryError.value = dup ? t('admin.addEntryDuplicateContact') : msg || t('errors.generic')
    return
  }

  const memberRows = [{ entry_id: entryRow.id, member_name: m1, member_order: 1 }]
  if (category === 'doubles' && m2) {
    memberRows.push({ entry_id: entryRow.id, member_name: m2, member_order: 2 })
  }

  const { error: membersError } = await supabase.from('entry_members').insert(memberRows)

  if (membersError) {
    await supabase.from('entries').delete().eq('id', entryRow.id)
    actionLoading.value = false
    addEntryError.value = membersError.message || t('errors.generic')
    return
  }

  actionLoading.value = false
  addEntryForm.memberOne = ''
  addEntryForm.memberTwo = ''
  addEntryForm.displayName = ''
  addEntryForm.phoneOrEmail = ''
  addEntryForm.asPending = false
  addEntryContactTouched.value = false

  addEntrySuccess.value = t('admin.addEntrySuccess')
  addEntrySuccessTimer = setTimeout(() => {
    addEntrySuccess.value = ''
    addEntrySuccessTimer = null
  }, 5000)

  await loadEntries()
}

async function saveTournamentSettings() {
  actionLoading.value = true
  errorText.value = ''

  const categoryChanged = settingsForm.category !== settingsBaseline.value.category
  const formatChanged = settingsForm.set_format !== settingsBaseline.value.set_format

  const { error } = await supabase
    .from('tournaments')
    .update({
      status: statusValue.value,
      is_public: tournament.value.is_public,
      name: settingsForm.name,
      description: settingsForm.description || null,
      category: settingsForm.category,
      set_format: settingsForm.set_format,
      doubles_pairing_mode:
        settingsForm.category === 'doubles' ? settingsForm.doubles_pairing_mode : null,
    })
    .eq('id', props.id)

  if (error) {
    actionLoading.value = false
    errorText.value = error.message
    return
  }

  if (categoryChanged && hasBracket.value) {
    const matchIds = matches.value.map((m) => m.id)
    if (matchIds.length) {
      await supabase.from('match_sets').delete().in('match_id', matchIds)
      await supabase.from('matches').delete().eq('tournament_id', props.id)
    }
  } else if (formatChanged && hasBracket.value) {
    const matchIds = matches.value.map((m) => m.id)
    if (matchIds.length) {
      await supabase.from('match_sets').delete().in('match_id', matchIds)
      await supabase
        .from('matches')
        .update({ winner_entry_id: null, status: 'ready' })
        .eq('tournament_id', props.id)
        .neq('status', 'pending')
    }
  }

  actionLoading.value = false
  await loadAll()
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
const selectedRrMatch = ref(null)

function openRrMatch(match) {
  if (!canEditFinalScores.value && !canEditScores.value) return
  selectedRrMatch.value = match
}

function startLiveFromRrModal(match) {
  selectedRrMatch.value = null
  openLiveScoring(match)
}

async function formRandomPairs() {
  if (unpairedCount.value % 2 !== 0) {
    errorText.value = t('admin.oddUnpairedWarning', { count: unpairedCount.value })
    return
  }

  if (!(await confirmDialog(t('admin.formPairsConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase.rpc('form_random_pairs', {
    p_tournament_id: props.id,
  })

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadEntries()
}

function openManualPairing() {
  const count = unpairedEntries.value.length
  const slotCount = Math.ceil(count / 2)
  manualPairSlots.value = Array.from({ length: slotCount }, (_, i) => ({
    slotIndex: i,
    playerA: null,
    playerB: null,
  }))
  manualPairingOpen.value = true
}

function closeManualPairing() {
  manualPairingOpen.value = false
  manualPairSlots.value = []
  manualPairingDragOver.value = null
  pairingEditMode.value = false
  editModePlayers.value = []
}

function findEntryById(id) {
  return allPairingPlayers.value.find((e) => e.id === id) || null
}

const isDragging = ref(false)

function onPlayerDragStart(event, entry, fromSlot, fromPosition) {
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
  manualPairingDragOver.value = null
  isDragging.value = false

  let payload
  try {
    payload = JSON.parse(event.dataTransfer.getData('application/json') || '{}')
  } catch {
    return
  }
  if (!payload.entryId) return

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

function removeFromSlot(slotIndex, position) {
  const key = position === 'A' ? 'playerA' : 'playerB'
  manualPairSlots.value[slotIndex][key] = null
}

async function saveManualPairs() {
  const completePairs = manualPairSlots.value.filter((s) => s.playerA && s.playerB)
  if (!completePairs.length) return

  actionLoading.value = true
  errorText.value = ''

  if (pairingEditMode.value) {
    const { error: splitErr } = await supabase.rpc('split_pairs', {
      p_tournament_id: props.id,
    })
    if (splitErr) {
      actionLoading.value = false
      errorText.value = splitErr.message
      return
    }
    await loadEntries()

    const nameToEntryId = {}
    for (const e of entries.value) {
      if (e.entry_members && e.entry_members.length === 1) {
        nameToEntryId[e.entry_members[0].member_name] = e.id
      }
    }

    const pairs = completePairs.map((s) => [
      nameToEntryId[s.playerA._memberName],
      nameToEntryId[s.playerB._memberName],
    ]).filter((p) => p[0] && p[1])

    if (!pairs.length) {
      actionLoading.value = false
      closeManualPairing()
      await loadEntries()
      return
    }

    const { error } = await supabase.rpc('form_manual_pairs', {
      p_tournament_id: props.id,
      p_pairs: pairs,
    })

    actionLoading.value = false
    if (error) {
      errorText.value = error.message
      return
    }
  } else {
    const pairs = completePairs.map((s) => [s.playerA.id, s.playerB.id])

    const { error } = await supabase.rpc('form_manual_pairs', {
      p_tournament_id: props.id,
      p_pairs: pairs,
    })

    actionLoading.value = false
    if (error) {
      errorText.value = error.message
      return
    }
  }

  const wasEditMode = pairingEditMode.value
  closeManualPairing()
  if (wasEditMode) {
    await loadAll()
  } else {
    await loadEntries()
  }
}

function openEditPairing() {
  const players = []
  const slots = []
  let virtualId = 0

  for (const entry of approvedEntries.value) {
    const members = entry.entry_members || []
    const m1 = members.find((m) => m.member_order === 1)
    const m2 = members.find((m) => m.member_order === 2)

    if (m1 && m2) {
      const playerA = { id: `edit-${virtualId++}`, display_name: m1.member_name, _sourceEntryId: entry.id, _memberName: m1.member_name, entry_members: [m1] }
      const playerB = { id: `edit-${virtualId++}`, display_name: m2.member_name, _sourceEntryId: entry.id, _memberName: m2.member_name, entry_members: [{ ...m2, member_order: 1 }] }
      players.push(playerA, playerB)
      slots.push({ slotIndex: slots.length, playerA, playerB })
    } else if (m1) {
      const playerA = { id: entry.id, display_name: m1.member_name, _sourceEntryId: entry.id, _memberName: m1.member_name, entry_members: [m1] }
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
  manualPairingOpen.value = true
  nextTick(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  })
}

async function loadStandings() {
  const { data, error } = await supabase.rpc('get_standings', {
    p_tournament_id: props.id,
    p_group_id: null,
  })
  if (error) {
    standings.value = []
    return
  }
  standings.value = data ?? []
}

async function generateBracket() {
  const fn = hasBracket.value ? 'rebuild_bracket' : 'generate_bracket'

  if (hasBracket.value && !(await confirmDialog(t('admin.rebuildConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase.rpc(fn, {
    p_tournament_id: props.id,
    p_mode: drawMode.value,
    p_manual_order: null,
  })

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function loadGroups() {
  const { data: groupRows } = await supabase
    .from('groups')
    .select('id, name, group_index')
    .eq('tournament_id', props.id)
    .order('group_index', { ascending: true })
  groups.value = groupRows ?? []

  const map = {}
  await Promise.all(
    groups.value.map(async (g) => {
      const { data } = await supabase.rpc('get_standings', {
        p_tournament_id: props.id,
        p_group_id: g.id,
      })
      map[g.id] = data ?? []
    }),
  )
  groupStandings.value = map
}

async function generateGroups() {
  if (hasGroups.value && !(await confirmDialog(t('admin.rebuildConfirm')))) {
    return
  }
  actionLoading.value = true
  errorText.value = ''
  const { error } = await supabase.rpc('generate_groups', {
    p_tournament_id: props.id,
    p_group_count: Number(groupCount.value) || 2,
  })
  actionLoading.value = false
  if (error) {
    errorText.value = error.message
    return
  }
  await loadAll()
}

async function startPlayoff() {
  actionLoading.value = true
  errorText.value = ''
  const { error } = await supabase.rpc('generate_group_playoff', {
    p_tournament_id: props.id,
  })
  actionLoading.value = false
  if (error) {
    errorText.value = error.message
    return
  }
  await loadAll()
}

async function generateSchedule() {
  if (hasBracket.value && !(await confirmDialog(t('admin.rebuildConfirm')))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase.rpc('generate_round_robin', {
    p_tournament_id: props.id,
  })

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function resetBracket() {
  if (!(await confirmDialog(t('admin.resetBracketConfirm'), { danger: true }))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase
    .from('matches')
    .delete()
    .eq('tournament_id', props.id)

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

const displayMatches = computed(() =>
  bracketEditing.value ? localMatches.value : matches.value
)

const bracketHasChanges = computed(() => {
  if (!bracketEditing.value) return false
  return localMatches.value.some((lm) => {
    const orig = matches.value.find((m) => m.id === lm.id)
    if (!orig) return false
    return orig.side_a_entry_id !== lm.side_a_entry_id || orig.side_b_entry_id !== lm.side_b_entry_id
  })
})

function startBracketEditing() {
  localMatches.value = matches.value.map((m) => ({ ...m }))
  bracketEditing.value = true
}

function cancelBracketEditing() {
  bracketEditing.value = false
  localMatches.value = []
}

function swapBracketSlots(payload) {
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
  const changed = localMatches.value.filter((lm) => {
    const orig = matches.value.find((m) => m.id === lm.id)
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

  const { error } = await supabase.rpc('apply_bracket_layout', {
    p_tournament_id: props.id,
    p_layout: layout,
  })

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  bracketEditing.value = false
  localMatches.value = []
  await loadAll()
}

async function addAdmin() {
  if (!addAdminForm.email) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase.rpc('add_tournament_admin_by_email', {
    p_tournament_id: props.id,
    p_email: addAdminForm.email,
    p_role: addAdminForm.role,
  })

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  addAdminForm.email = ''
  addAdminForm.role = 'editor'
  await loadAll()
}

async function removeAdmin(adminId) {
  actionLoading.value = true
  errorText.value = ''

  const { error } = await supabase.rpc('remove_tournament_admin', {
    p_tournament_id: props.id,
    p_admin_id: adminId,
  })

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await loadAll()
}

async function onCopyShareLink() {
  if (!tournament.value?.slug) {
    return
  }
  try {
    await copyTournamentLink(tournament.value.slug)
  } catch {
    /* still show feedback */
  }
  copyFeedback.value = true
  setTimeout(() => {
    copyFeedback.value = false
  }, 2000)
}

async function deleteTournament() {
  if (!(await confirmDialog(t('admin.deleteTournamentConfirm'), { danger: true }))) {
    return
  }

  actionLoading.value = true
  errorText.value = ''

  if (channel) {
    supabase.removeChannel(channel)
    channel = null
  }

  const { error } = await supabase.from('tournaments').delete().eq('id', props.id)

  actionLoading.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  await router.replace({ name: 'admin-tournaments' })
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
  if (!canManageTournament.value) {
    return tab === 'bracket'
  }
  return tab !== 'scores' || canEditScores.value
}

const enabledTabs = computed(() => TABS.filter(isTabEnabled))

function readHashTab() {
  const h = window.location.hash.replace('#', '')
  const fallback = canManageTournament.value ? 'entries' : 'bracket'
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
    setTab(canManageTournament.value ? 'entries' : 'bracket')
  }
})

watch(canManageTournament, () => {
  if (!isTabEnabled(activeTab.value)) {
    setTab(canManageTournament.value ? 'entries' : 'bracket')
  }
})

function openLiveScoring(match) {
  selectedLiveMatch.value = match
}

const selectedLiveScore = computed(() => (
  selectedLiveMatch.value ? liveScoresByMatch.value[selectedLiveMatch.value.id] : null
))

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
    router.replace({ query: rest, hash: route.hash })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)
  clearTimeout(reloadTimer)
  clearTimeout(addEntrySuccessTimer)
  if (channel) {
    supabase.removeChannel(channel)
  }
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
            <button
              v-if="showPublicShareActions"
              class="btn btn--outline btn--sm"
              type="button"
              @click="onCopyShareLink"
            >
              {{ copyFeedback ? t('share.copied') : t('share.copyLink') }}
            </button>

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
          v-if="canManageTournament"
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
        v-if="canManageTournament"
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

          <div v-if="!isTournamentActive" class="admin-add-entry" :class="{ 'admin-add-entry--open': addEntryAccordionOpen }">
            <h3 class="admin-add-entry__heading">
              <button
                id="adm-add-entry-trigger"
                type="button"
                class="admin-add-entry__trigger"
                :aria-expanded="addEntryAccordionOpen"
                aria-controls="adm-add-entry-panel"
                @click="addEntryAccordionOpen = !addEntryAccordionOpen"
              >
                <span class="admin-add-entry__trigger-text">{{ t('admin.addEntryTitle') }}</span>
                <svg
                  class="admin-add-entry__chevron"
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M5 7.5 10 12.5 15 7.5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </h3>

            <div
              v-show="addEntryAccordionOpen"
              id="adm-add-entry-panel"
              class="admin-add-entry__panel stack stack--sm"
              role="region"
              aria-labelledby="adm-add-entry-trigger"
            >
              <p class="muted admin-add-entry__hint">{{ t('admin.addEntryHint') }}</p>

              <form class="stack stack--sm" @submit.prevent="addEntryManually">
                <div class="grid-2 grid-2--admin">
                  <div class="form-field">
                    <label for="adm-add-m1">{{ isGoalsSport ? t('registrationForm.teamName') : tournament.category === 'doubles' ? t('registrationForm.memberOne') : t('registrationForm.member') }}</label>
                    <input
                      id="adm-add-m1"
                      v-model="addEntryForm.memberOne"
                      class="input"
                      type="text"
                      autocomplete="name"
                      :disabled="actionLoading"
                      required
                    />
                  </div>
                  <div v-if="tournament.category === 'doubles' && !isPickRandomDoubles" class="form-field">
                    <label for="adm-add-m2">{{ t('registrationForm.memberTwo') }}</label>
                    <input
                      id="adm-add-m2"
                      v-model="addEntryForm.memberTwo"
                      class="input"
                      type="text"
                      autocomplete="name"
                      :disabled="actionLoading"
                      required
                    />
                  </div>
                  <div v-if="isPickRandomDoubles" class="form-field">
                    <label for="adm-add-m2">{{ t('registrationForm.memberTwoOptional') }}</label>
                    <input
                      id="adm-add-m2"
                      v-model="addEntryForm.memberTwo"
                      class="input"
                      type="text"
                      autocomplete="name"
                      :disabled="actionLoading"
                    />
                  </div>
                  <div v-if="tournament.category === 'doubles' || isGoalsSport" class="form-field">
                    <label for="adm-add-display">{{ t('registrationForm.displayName') }}</label>
                    <input
                      id="adm-add-display"
                      v-model="addEntryForm.displayName"
                      class="input"
                      type="text"
                      :disabled="actionLoading"
                    />
                  </div>
                  <div class="form-field">
                    <label for="adm-add-contact">{{ t('admin.addEntryContactOptional') }}</label>
                    <input
                      id="adm-add-contact"
                      v-model="addEntryForm.phoneOrEmail"
                      class="input"
                      type="text"
                      inputmode="email"
                      autocomplete="off"
                      :class="{ 'input--error': addEntryContactInvalid }"
                      :disabled="actionLoading"
                      @blur="addEntryContactTouched = true"
                    />
                  </div>
                </div>

                <label class="checkbox-row" for="adm-add-pending">
                  <input id="adm-add-pending" v-model="addEntryForm.asPending" type="checkbox" :disabled="actionLoading" />
                  {{ t('admin.addEntryAsPending') }}
                </label>

                <div class="inline-actions">
                  <button class="btn btn--primary btn--sm" type="submit" :disabled="actionLoading">
                    {{ t('admin.addEntrySubmit') }}
                  </button>
                </div>

                <div v-if="addEntrySuccess" class="alert alert--success" role="status">{{ addEntrySuccess }}</div>
                <div v-if="addEntryError" class="alert alert--error" role="alert">{{ addEntryError }}</div>
              </form>
            </div>
          </div>

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
                :disabled="actionLoading"
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

          <template v-if="isPickRandomDoubles && unpairedCount > 0 && !pairingEditMode">
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
                  :disabled="actionLoading || unpairedCount % 2 !== 0"
                  @click="formRandomPairs"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
                  {{ t('admin.formPairs') }}
                </button>
                <button
                  class="btn btn--sm"
                  type="button"
                  :disabled="actionLoading"
                  @click="manualPairingOpen ? closeManualPairing() : openManualPairing()"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"/></svg>
                  {{ t('admin.formPairsManually') }}
                </button>
              </div>
            </div>

            <div v-if="manualPairingOpen" class="manual-pairing" :class="{ 'manual-pairing--dragging': isDragging }">
              <div class="manual-pairing-pool">
                <h4 class="manual-pairing-pool__title">{{ t('admin.manualPairingPool') }}</h4>
                <div v-if="unassignedPlayers.length" class="manual-pairing-pool__list">
                  <span
                    v-for="entry in unassignedPlayers"
                    :key="entry.id"
                    class="manual-pairing-pool__chip"
                    draggable="true"
                    @dragstart="onPlayerDragStart($event, entry, null, null)"
                    @dragend="onPlayerDragEnd"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    {{ entryLabel(entry) }}
                  </span>
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
                    @dragstart="slot.playerA && onPlayerDragStart($event, slot.playerA, idx, 'A')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'A')"
                    @dragleave="onSlotDragLeave($event, idx, 'A')"
                    @drop="onSlotDrop($event, idx, 'A')"
                  >
                    <template v-if="slot.playerA">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerA) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click="removeFromSlot(idx, 'A')"
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
                    @dragstart="slot.playerB && onPlayerDragStart($event, slot.playerB, idx, 'B')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'B')"
                    @dragleave="onSlotDragLeave($event, idx, 'B')"
                    @drop="onSlotDrop($event, idx, 'B')"
                  >
                    <template v-if="slot.playerB">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerB) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click="removeFromSlot(idx, 'B')"
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
                  :disabled="actionLoading || completePairsCount === 0"
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
              <div class="manual-pairing-pool">
                <h4 class="manual-pairing-pool__title">{{ t('admin.manualPairingPool') }}</h4>
                <div v-if="unassignedPlayers.length" class="manual-pairing-pool__list">
                  <span
                    v-for="entry in unassignedPlayers"
                    :key="entry.id"
                    class="manual-pairing-pool__chip"
                    draggable="true"
                    @dragstart="onPlayerDragStart($event, entry, null, null)"
                    @dragend="onPlayerDragEnd"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    {{ entryLabel(entry) }}
                  </span>
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
                    @dragstart="slot.playerA && onPlayerDragStart($event, slot.playerA, idx, 'A')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'A')"
                    @dragleave="onSlotDragLeave($event, idx, 'A')"
                    @drop="onSlotDrop($event, idx, 'A')"
                  >
                    <template v-if="slot.playerA">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerA) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click="removeFromSlot(idx, 'A')"
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
                    @dragstart="slot.playerB && onPlayerDragStart($event, slot.playerB, idx, 'B')"
                    @dragend="onPlayerDragEnd"
                    @dragover="onSlotDragOver($event, idx, 'B')"
                    @dragleave="onSlotDragLeave($event, idx, 'B')"
                    @drop="onSlotDrop($event, idx, 'B')"
                  >
                    <template v-if="slot.playerB">
                      <span class="pair-slot__player">{{ entryLabel(slot.playerB) }}</span>
                      <button
                        class="pair-slot__remove"
                        type="button"
                        aria-label="Remove"
                        @click="removeFromSlot(idx, 'B')"
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
                  :disabled="actionLoading || completePairsCount === 0"
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

          <section v-if="standings.length" class="card stack stack--sm" style="margin-top: var(--space-4)">
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

          <section v-if="hasGroups" class="card stack stack--sm" style="margin-top: var(--space-4)">
            <h2 class="section-title">{{ t('admin.groupStage') }}</h2>
            <GroupStageBoard :groups="groupsView" :entries-map="entriesMap" :family="tournamentScoringFamily" />
          </section>

          <section v-if="hasPlayoff" class="card stack stack--sm" style="margin-top: var(--space-4)">
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

        <section v-if="!isRoundRobin && !isGroupsPlayoff" class="card stack stack--sm" style="margin-top: var(--space-4)">
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
          :editable-slots="canManageTournament && drawMode === 'manual' && !actionLoading"
          :can-live-score="canEditScores"
          @swap-slots="swapBracketSlots"
          @view-live="openLiveScoring"
        />
          <div v-if="bracketEditing" class="inline-actions" style="margin-top: var(--space-2)">
            <button
              class="btn btn--primary btn--sm"
              type="button"
              :disabled="actionLoading || !bracketHasChanges"
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

      <div
        id="panel-scores"
        role="tabpanel"
        aria-labelledby="tab-scores"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'scores' }"
      >
        <!-- Round-robin: same crosstable as the bracket tab (no artificial rounds) -->
        <template v-if="isRoundRobin">
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
          @saved="() => loadAll(true)"
        />
        <ScoreEditor
          v-else
          :matches="matches"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :set-format="tournament.set_format"
          :category="tournament.category"
          :disabled="!canEditFinalScores"
          :can-live-score="canEditScores"
          :live-scores-by-match="liveScoresByMatch"
          @saved="() => loadAll(true)"
          @start-live="openLiveScoring"
        />
      </div>

      <div
        v-if="canManageTournament"
        id="panel-settings"
        role="tabpanel"
        aria-labelledby="tab-settings"
        class="tab-panel"
        :class="{ 'tab-panel--active': activeTab === 'settings' }"
      >
        <section class="card admin-settings-card stack stack--sm" aria-labelledby="adm-settings-heading">
          <div>
            <h2 id="adm-settings-heading" class="section-title" style="margin-bottom: var(--space-2)">
              {{ t('admin.tournamentSettings') }}
            </h2>
          </div>

          <div class="form-field">
            <label for="adm-name">{{ t('admin.name') }}</label>
            <input
              id="adm-name"
              v-model="settingsForm.name"
              class="input"
              type="text"
              required
              :disabled="isSettingsDropdownDisabled"
            />
          </div>

          <div class="form-field">
            <label for="adm-desc">{{ t('admin.description') }}</label>
            <textarea
              id="adm-desc"
              v-model="settingsForm.description"
              class="input"
              rows="3"
              :disabled="isSettingsDropdownDisabled"
            />
          </div>

          <p class="muted" style="font-size: var(--font-sm)">
            {{ t('sport.' + (tournament.sport || 'tennis')) }} · {{ t('tournamentFormat.' + (tournament.format || 'single_elimination')) }}
          </p>

          <div v-if="sportCfg.supportsCategory || sportCfg.supportsSetFormat" class="grid-2">
            <div v-if="sportCfg.supportsCategory" class="form-field">
              <label for="adm-cat">{{ t('admin.category') }}</label>
              <select id="adm-cat" v-model="settingsForm.category" class="input" :disabled="isSettingsDropdownDisabled">
                <option value="singles">{{ t('tournament.singles') }}</option>
                <option value="doubles">{{ t('tournament.doubles') }}</option>
              </select>
            </div>

            <div v-if="sportCfg.supportsSetFormat" class="form-field">
              <label for="adm-format">{{ t('admin.setFormat') }}</label>
              <select id="adm-format" v-model="settingsForm.set_format" class="input" :disabled="isSettingsDropdownDisabled">
                <option value="best_of_3">{{ t('format.best_of_3') }}</option>
                <option value="best_of_5">{{ t('format.best_of_5') }}</option>
              </select>
            </div>
          </div>

          <label v-if="sportCfg.supportsDoublesPairing && settingsForm.category === 'doubles'" class="checkbox-row">
            <input
              v-model="settingsForm.doubles_pairing_mode"
              type="checkbox"
              true-value="pick_random"
              false-value="pre_agreed"
              :disabled="isSettingsDropdownDisabled"
            />
            {{ t('admin.pickRandomPairs') }}
          </label>

          <div class="admin-settings-fields">
            <div class="form-field admin-settings-fields__status">
              <label for="adm-status">{{ t('admin.status') }}</label>
              <select id="adm-status" v-model="statusValue" class="input">
                <option value="draft" :disabled="isSettingsDropdownDisabled">{{ t('tournament.draft') }}</option>
                <option value="registration_open" :disabled="isSettingsDropdownDisabled">{{ t('tournament.registration_open') }}</option>
                <option value="registration_closed" :disabled="isSettingsDropdownDisabled">{{ t('tournament.registration_closed') }}</option>
                <option v-if="isTournamentActive" value="in_progress" disabled>{{ t('tournament.in_progress') }}</option>
                <option v-if="isTournamentFinished" value="completed" disabled>{{ t('tournament.completed') }}</option>
              </select>
            </div>

            <label class="checkbox-row admin-settings-fields__public" for="adm-public">
              <input id="adm-public" v-model="tournament.is_public" type="checkbox" :disabled="isSettingsDropdownDisabled" />
              {{ t('admin.isPublic') }}
            </label>
          </div>

          <footer class="admin-settings-card__footer">
            <button
              class="btn btn--primary"
              type="button"
              :disabled="actionLoading || !hasTournamentSettingsChanges"
              @click="saveTournamentSettings"
            >
              {{ t('admin.saveStatus') }}
            </button>
          </footer>
        </section>

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
              <input id="adm-email" v-model="addAdminForm.email" class="input" type="email" :placeholder="t('admin.adminEmailPlaceholder')" />
            </div>
            <div class="form-field">
              <label for="adm-role">{{ t('admin.role') }}</label>
              <select id="adm-role" v-model="addAdminForm.role" class="input">
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
        v-if="selectedLiveMatch"
        :match="selectedLiveMatch"
        :live-score="selectedLiveScore"
        :team-a="teamLabel(selectedLiveMatch.side_a_entry_id)"
        :team-b="teamLabel(selectedLiveMatch.side_b_entry_id)"
        @close="selectedLiveMatch = null"
      />

      <TournamentQrModal
        v-if="qrModalOpen && tournament.slug"
        :slug="tournament.slug"
        :name="tournament.name"
        @close="qrModalOpen = false"
      />

      <MatchScoreModal
        v-if="selectedRrMatch"
        :match="selectedRrMatch"
        :entries-map="entriesMap"
        :family="tournamentScoringFamily"
        :set-format="tournament.set_format || 'best_of_3'"
        :sets="setsByMatch[selectedRrMatch.id] || []"
        :can-edit-final="canEditFinalScores"
        :can-live-score="canEditScores && !isGoalsSport"
        :live-status="liveScoresByMatch[selectedRrMatch.id]?.status || null"
        @close="selectedRrMatch = null"
        @saved="loadAll(true)"
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
