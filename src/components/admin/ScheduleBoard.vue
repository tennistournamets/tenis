<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { entryMemberNames } from '../../lib/entryDisplay'
import { supabase } from '../../lib/supabase'
import InfoTip from '../InfoTip.vue'
import { knockoutTotals, matchRoundName } from '../../lib/roundLabels'
import {
  blocksPublish, conflictText, draftDiff, mergeConflicts, queueOrderConflicts, formatScheduleTime, indexSchedule, scheduleDropAction, scheduleError,
  scheduleLocked, scheduleSummary, timezoneOf,
} from '../../lib/schedule'

const props = defineProps({
  tournament: { type: Object, required: true },
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  courts: { type: Array, default: () => [] },
  schedule: { type: Array, default: () => [] },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  busy: Boolean,
  canManage: Boolean,
})
const emit = defineEmits(['assign', 'publish', 'revert', 'move', 'open-courts'])
const { t, locale } = useI18n()

const view = ref('round')
const conflicts = ref([])
const conflictsError = ref('')
// Moving a match: drag for a mouse, two taps for everything else. Both build
// the same intent and go through the same commit, as the bracket board does.
const dragMatchId = ref('')
const selectedMatchId = ref('')
const dropTargetKey = ref('')
const timeZone = computed(() => timezoneOf(props.tournament))
const courtsById = computed(() => Object.fromEntries(props.courts.map(c => [c.id, c])))
const index = computed(() => indexSchedule(props.schedule))
const diff = computed(() => draftDiff(props.schedule))
const changedIds = computed(() => new Set(diff.value.changed))
// Server checks (time, court, rest) plus the court-queue order checked here.
const allConflicts = computed(() => mergeConflicts(conflicts.value, queueOrderConflicts(props.matches, index.value.draft)))
const conflictsByMatch = computed(() => Object.fromEntries(allConflicts.value.map(c => [c.match_id, c.conflicts])))
// Mirrors publish_schedule: a finished or live match keeps its schedule but
// never stands in the way of publishing the rest of the draft.
const publishBlocked = computed(() => conflicts.value.some(c => c.conflicts.some(blocksPublish)))
const disabled = computed(() => props.busy || !props.canManage)
const stageOrder = { group: 0, winners: 1, main: 1, losers: 2, grand_final: 3, third_place: 4 }

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}
const matchTitle = match => `${teamLabel(match.side_a_entry_id)} — ${teamLabel(match.side_b_entry_id)}`
const matchLabelById = id => { const m = props.matches.find(x => x.id === id); return m ? matchTitle(m) : '' }
const roundTotals = computed(() => knockoutTotals(props.matches, props.tournament?.format))
// Double elimination needs "Upper/Lower bracket" to tell its rounds apart;
// a single bracket or a group playoff reads fine as just "Semifinal".
const hasLosers = computed(() => props.matches.some(m => m.stage === 'losers'))
function roundLabel(match) {
  if (match.stage === 'grand_final' || match.stage === 'third_place') return t(`mobile.matchStage.${match.stage}`)
  const round = Number(match.round_number || 0)
  const base = t(`mobile.matchStage.${match.stage || 'main'}`)
  if (!round) return base
  const name = matchRoundName(match, roundTotals.value, t)
  const prefixed = match.stage === 'group' || match.stage === 'losers' || (match.stage === 'winners' && hasLosers.value)
  return prefixed ? `${base} · ${name}` : name
}
const summary = match => scheduleSummary(index.value.draft[match.id], { courtsById: courtsById.value, t, locale: locale.value, timeZone: timeZone.value })
// Court columns are the only place an assignment can be expressed by pointing
// at it; rounds are not assignments, and a read-only board moves nothing.
const moveEnabled = computed(() => view.value === 'court' && props.canManage)
const matchById = computed(() => Object.fromEntries(props.matches.map(m => [m.id, m])))
const lockedMatch = match => scheduleLocked(match, props.liveScoresByMatch[match?.id])
const canMove = match => moveEnabled.value && !disabled.value && !lockedMatch(match)
// The "Без корта" column holds rows that kept a time but lost their court.
// Dropping there is ambiguous for a match without a time, so it stays a source.
const dropTarget = key => moveEnabled.value && !disabled.value && key !== 'none'

function plannedMove(matchId, targetKey, beforeMatchId = null) {
  const match = matchById.value[matchId]
  if (!match || !canMove(match)) return null
  const column = (view.value === 'court' ? byCourt.value : []).find(c => c.key === targetKey)
  return scheduleDropAction({
    matchId,
    draftRow: index.value.draft[matchId] || null,
    locked: lockedMatch(match),
    targetKey,
    beforeMatchId,
    columnIds: (column?.items || []).map(m => m.id),
    draftByMatch: index.value.draft,
  })
}

function commitMove(matchId, targetKey, beforeMatchId = null) {
  const action = plannedMove(matchId, targetKey, beforeMatchId)
  if (action) emit('move', action)
  return Boolean(action)
}

function clearDragState() {
  dragMatchId.value = ''
  dropTargetKey.value = ''
}

function onDragStart(event, match) {
  if (!canMove(match)) { event.preventDefault(); return }
  event.dataTransfer.setData('application/json', JSON.stringify({ source: 'schedule', matchId: match.id }))
  event.dataTransfer.effectAllowed = 'move'
  try {
    event.dataTransfer.setDragImage(event.currentTarget, 16, 16)
  } catch {
    /* the default drag image is fine */
  }
  dragMatchId.value = match.id
  selectedMatchId.value = ''
}

// Without preventDefault the browser shows "no drop", which is exactly the
// feedback a no-op or an illegal target deserves.
function onDragOver(event, key, targetKey, beforeMatchId = null) {
  if (!dropTarget(targetKey) || !plannedMove(dragMatchId.value, targetKey, beforeMatchId)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dropTargetKey.value = key
}

function onDragLeave(event, key) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  if (dropTargetKey.value === key) dropTargetKey.value = ''
}

function onDrop(event, targetKey, beforeMatchId = null) {
  event.preventDefault()
  dropTargetKey.value = ''
  if (!dropTarget(targetKey)) return
  let payload
  try {
    payload = JSON.parse(event.dataTransfer.getData('application/json') || '{}')
  } catch {
    return
  }
  // A drag from outside the board carries anything at all.
  if (payload?.source === 'schedule' && payload.matchId) commitMove(payload.matchId, targetKey, beforeMatchId)
  dragMatchId.value = ''
}

function onCardActivate(match, targetKey) {
  if (!moveEnabled.value || disabled.value) return
  if (!selectedMatchId.value) { if (canMove(match)) selectedMatchId.value = match.id; return }
  if (selectedMatchId.value === match.id) { selectedMatchId.value = ''; return }
  // In a court column a card is an insertion point; elsewhere there is no
  // stored order, so the card just means its column.
  const before = dropTarget(targetKey) && targetKey !== 'unassigned' ? match.id : null
  if (dropTarget(targetKey)) commitMove(selectedMatchId.value, targetKey, before)
  selectedMatchId.value = ''
}

function onTargetActivate(targetKey) {
  if (!selectedMatchId.value || !dropTarget(targetKey)) return
  commitMove(selectedMatchId.value, targetKey)
  selectedMatchId.value = ''
}

function cardLabel(match) {
  if (lockedMatch(match)) return t('schedule.cannotMove', { match: matchTitle(match) })
  if (selectedMatchId.value && selectedMatchId.value !== match.id) return t('schedule.dropBefore', { match: matchTitle(match) })
  return t('schedule.selectMatch', { match: matchTitle(match) })
}

const targetLabel = group => (group.key === 'unassigned'
  ? t('schedule.dropUnassign')
  : t('schedule.dropOnCourt', { court: group.label }))

// A refresh can unmount the card under the cursor, and leaving the court view
// must not strand a highlight or a selection.
watch([() => props.schedule, () => props.courts, moveEnabled, disabled], () => {
  clearDragState()
  if (!moveEnabled.value || disabled.value) selectedMatchId.value = ''
})

const sortedMatches = computed(() => [...props.matches].sort((a, b) =>
  (stageOrder[a.stage] ?? 8) - (stageOrder[b.stage] ?? 8) || (a.round_number || 0) - (b.round_number || 0) || (a.match_number || 0) - (b.match_number || 0)))

const byRound = computed(() => {
  const groups = new Map()
  for (const match of sortedMatches.value) {
    const key = roundLabel(match)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(match)
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }))
})
const byCourt = computed(() => {
  const columns = props.courts.map(court => ({ label: court.name, key: court.id, items: [] }))
  const noCourt = { label: t('schedule.noCourt'), key: 'none', items: [] }
  const unscheduled = { label: t('schedule.unassigned'), key: 'unassigned', items: [] }
  for (const match of sortedMatches.value) {
    const row = index.value.draft[match.id]
    if (!row) { unscheduled.items.push(match); continue }
    const column = columns.find(c => c.key === row.court_id) || noCourt
    column.items.push(match)
  }
  const timeOf = m => index.value.draft[m.id]?.scheduled_at ? new Date(index.value.draft[m.id].scheduled_at).getTime() : Number.MAX_SAFE_INTEGER
  for (const column of columns) column.items.sort((a, b) => (index.value.draft[a.id]?.queue_order || 0) - (index.value.draft[b.id]?.queue_order || 0) || timeOf(a) - timeOf(b))
  // The tray of unscheduled matches leads: it is where drags start, and it
  // stays pinned while a long row of courts scrolls past it.
  return [unscheduled, noCourt, ...columns].filter(c => c.items.length || c.key !== 'none')
})

// Pieces of the slot chip: court and time are shown apart so each can carry
// its own icon; scheduleSummary stays the one-line text for screen readers.
function slotParts(match) {
  const row = index.value.draft[match.id]
  if (!row) return null
  const court = row.court_id ? courtsById.value[row.court_id]?.name || '' : ''
  let time = ''
  if (row.scheduled_at) {
    const at = formatScheduleTime(row.scheduled_at, locale.value, timeZone.value)
    time = row.time_kind === 'not_before' ? t('schedule.notBefore', { time: at }) : at
  }
  const queue = row.queue_order ? t('schedule.queueLabel', { n: row.queue_order }) : ''
  return { court, time, queue }
}
const scheduledCount = computed(() => props.matches.filter(m => index.value.draft[m.id]).length)
const progressPct = computed(() => (props.matches.length ? Math.round((scheduledCount.value / props.matches.length) * 100) : 0))
const statusTone = computed(() => (diff.value.count ? 'dirty' : props.tournament.schedule_published_at ? 'live' : 'never'))

// Court board: a horizontal row of lanes. Arrows and edge fades appear only
// when the lanes do not fit.
const boardEl = ref(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)
function updateBoardScroll() {
  const el = boardEl.value
  if (!el || view.value !== 'court') { canScrollLeft.value = false; canScrollRight.value = false; return }
  canScrollLeft.value = el.scrollLeft > 4
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}
function scrollBoard(direction) {
  const el = boardEl.value
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollBy({ left: direction * Math.max(280, el.clientWidth * 0.7), behavior: reduce ? 'auto' : 'smooth' })
}
let boardObserver = null
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') boardObserver = new ResizeObserver(updateBoardScroll)
})
watch([boardEl, view, () => props.courts.length], async () => {
  await nextTick()
  boardObserver?.disconnect()
  if (boardEl.value) boardObserver?.observe(boardEl.value)
  updateBoardScroll()
}, { flush: 'post' })
onBeforeUnmount(() => boardObserver?.disconnect())
// Court view splits into a fixed tray of unscheduled matches and a scrolling
// row of lanes, so no lane ever slides underneath the tray.
const zones = computed(() => {
  if (view.value !== 'court') return [{ key: 'all', groups: byRound.value }]
  return [
    { key: 'tray', groups: byCourt.value.filter(g => g.key === 'unassigned') },
    { key: 'lanes', groups: byCourt.value.filter(g => g.key !== 'unassigned') },
  ]
})
const slotHidden = match => {
  // In a court lane the lane already names the court; a bare court slot says nothing more.
  const parts = slotParts(match)
  return view.value === 'court' && parts && !parts.time && !parts.queue
}

const publishedAt = computed(() => formatScheduleTime(props.tournament.schedule_published_at, locale.value, timeZone.value))

let conflictsTimer = null
// Moves make these reads overlap, so a late answer must never overwrite a
// newer one — the panel is where silently applied warnings show up.
let conflictsVersion = 0
async function loadConflicts() {
  if (!props.canManage || !props.tournament?.id) { conflicts.value = []; return }
  const version = ++conflictsVersion
  try {
    const { data, error } = await supabase.rpc('schedule_draft_conflicts', { p_tournament_id: props.tournament.id })
    if (version !== conflictsVersion) return
    if (error) throw error
    conflicts.value = Array.isArray(data) ? data : []
    conflictsError.value = ''
  } catch (error) {
    if (version === conflictsVersion) conflictsError.value = scheduleError(error?.message, t)
  }
}
// The recovery poll re-reads the same snapshot every 30 seconds and hands the
// board a fresh array each time, so watching the array itself asked the server
// to recompute byte-identical conflicts forever. Key the read on what the
// server actually looks at instead.
const conflictsKey = computed(() => JSON.stringify([
  props.tournament?.schedule_config ?? null,
  props.schedule
    .filter(row => row.state === 'draft')
    .map((row) => {
      const match = matchById.value[row.match_id]
      return [
        row.match_id, row.court_id, row.scheduled_at, row.time_kind, row.queue_order,
        match?.status ?? null, match?.side_a_entry_id ?? null, match?.side_b_entry_id ?? null,
        match?.next_match_id ?? null, match?.loser_next_match_id ?? null,
        props.liveScoresByMatch[row.match_id]?.status ?? null,
      ]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
]))
watch(conflictsKey, () => {
  clearTimeout(conflictsTimer)
  conflictsTimer = setTimeout(loadConflicts, 200)
}, { immediate: true })
// The schedule tab is mounted with v-if, so a pending read would otherwise
// land on a dead instance.
onBeforeUnmount(() => { clearTimeout(conflictsTimer); conflictsVersion += 1 })
</script>

<template>
  <section class="card schedule-board" aria-labelledby="schedule-title">
    <header class="sb-head">
      <div class="sb-head__text">
        <h2 id="schedule-title" class="sb-head__title">
          {{ t('schedule.title') }}
          <InfoTip :text="t('schedule.limitations')" />
        </h2>
        <p class="sb-head__intro">{{ t('schedule.intro') }}</p>
      </div>
    </header>

    <!-- Статус публикации, прогресс и действия — одной панелью -->
    <div class="sb-status" :class="`sb-status--${statusTone}`">
      <div class="sb-status__state" role="status">
        <span class="sb-status__dot" aria-hidden="true" />
        <div class="sb-status__lines">
          <strong v-if="statusTone === 'dirty'">{{ t('schedule.statusDirty', { count: diff.count }) }}</strong>
          <strong v-else-if="statusTone === 'live'">{{ t('schedule.statusPublished', { date: publishedAt }) }}</strong>
          <strong v-else>{{ t('schedule.statusNever') }}</strong>
          <span>
            <template v-if="statusTone === 'dirty' && tournament.schedule_published_at">{{ t('schedule.publishedAt', { date: publishedAt }) }}</template>
            <template v-else-if="statusTone === 'dirty' || statusTone === 'never'">{{ t('schedule.statusNeverHint') }}</template>
            <template v-else>{{ t('schedule.noDraftChanges') }}</template>
          </span>
        </div>
      </div>

      <div v-if="matches.length" class="sb-status__progress">
        <span class="sb-status__progress-label">{{ t('schedule.progress', { done: scheduledCount, total: matches.length }) }}</span>
        <span class="sb-progress" role="progressbar" :aria-valuenow="scheduledCount" aria-valuemin="0" :aria-valuemax="matches.length">
          <span class="sb-progress__fill" :style="{ width: `${progressPct}%` }" />
        </span>
      </div>

      <div class="sb-status__actions">
        <button v-if="diff.count" class="btn btn--ghost btn--sm" type="button" :disabled="disabled" @click="emit('revert')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></svg>
          {{ t('schedule.revert') }}
        </button>
        <button class="btn btn--primary btn--sm" type="button" :disabled="disabled || !diff.count || publishBlocked" @click="emit('publish')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></svg>
          {{ t('schedule.publish') }}
        </button>
      </div>
    </div>

    <!-- Корты редактируются на своей вкладке; без них назначать матчи некуда -->
    <div v-if="!courts.length" class="sb-notice" role="status">
      <svg class="sb-notice__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>
      <span class="sb-notice__text">{{ t('schedule.noCourts') }}</span>
      <button class="btn btn--outline btn--sm" type="button" :disabled="disabled" @click="emit('open-courts')">{{ t('schedule.goToCourts') }}</button>
    </div>

    <section v-if="allConflicts.length || conflictsError" class="sb-conflicts" aria-live="polite">
      <h3 class="sb-conflicts__title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
        {{ t('schedule.conflicts') }}
        <span v-if="allConflicts.length" class="sb-count">{{ allConflicts.length }}</span>
      </h3>
      <p v-if="conflictsError" class="error-text" role="alert">{{ conflictsError }}</p>
      <ul v-else class="sb-conflicts__list">
        <li v-for="item in allConflicts" :key="item.match_id">
          <strong>{{ matchLabelById(item.match_id) }}</strong>
          <ul>
            <li v-for="(conflict, i) in item.conflicts" :key="i" :class="blocksPublish(conflict) ? 'is-hard' : 'is-soft'">
              <span class="sb-conflicts__kind">{{ t(blocksPublish(conflict) ? 'schedule.hard' : 'schedule.soft') }}</span>
              {{ conflictText(conflict, t, matchLabelById) }}
            </li>
          </ul>
        </li>
      </ul>
    </section>

    <div class="sb-toolbar">
      <div class="sb-segmented" role="tablist">
        <button type="button" role="tab" class="sb-segmented__btn" :class="{ 'is-active': view === 'round' }" :aria-selected="view === 'round'" @click="view = 'round'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>
          {{ t('schedule.viewByRound') }}
        </button>
        <button type="button" role="tab" class="sb-segmented__btn" :class="{ 'is-active': view === 'court' }" :aria-selected="view === 'court'" @click="view = 'court'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="18" rx="1.5" /><rect x="14" y="3" width="7" height="18" rx="1.5" /></svg>
          {{ t('schedule.viewByCourt') }}
        </button>
      </div>
      <div v-if="view === 'court' && (canScrollLeft || canScrollRight)" class="sb-toolbar__scroll">
        <button type="button" class="sb-scroll-btn" :disabled="!canScrollLeft" :aria-label="t('schedule.scrollLeft')" @click="scrollBoard(-1)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button type="button" class="sb-scroll-btn" :disabled="!canScrollRight" :aria-label="t('schedule.scrollRight')" @click="scrollBoard(1)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>
      <p v-if="moveEnabled" class="sb-toolbar__hint" role="status">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l-3 3 3 3" /><path d="M9 5l3-3 3 3" /><path d="M15 19l-3 3-3-3" /><path d="M19 9l3 3-3 3" /><path d="M2 12h20" /><path d="M12 2v20" /></svg>
        {{ selectedMatchId ? t('schedule.selectedMatch', { match: matchLabelById(selectedMatchId) }) : t('schedule.moveHint') }}
      </p>
    </div>

    <p v-if="!matches.length" class="sb-empty">{{ t('bracket.empty') }}</p>

    <div v-else class="sb-layout" :class="{ 'sb-layout--courts': view === 'court' }">
      <div
        v-for="zone in zones"
        :key="zone.key"
        :ref="el => { if (zone.key === 'lanes') boardEl = el }"
        class="sb-groups"
        :class="{
          'sb-groups--tray': zone.key === 'tray',
          'sb-groups--courts': zone.key === 'lanes',
          'is-fade-left': zone.key === 'lanes' && canScrollLeft,
          'is-fade-right': zone.key === 'lanes' && canScrollRight,
        }"
        @scroll.passive="zone.key === 'lanes' && updateBoardScroll()"
      >
      <section
        v-for="group in zone.groups"
        :key="group.key || group.label"
        class="sb-group"
        :class="{ 'sb-group--drop-over': dropTargetKey === `column:${group.key}`, 'sb-group--tray': view === 'court' && group.key === 'unassigned' }"
        @dragover="onDragOver($event, `column:${group.key}`, group.key)"
        @dragleave="onDragLeave($event, `column:${group.key}`)"
        @drop="onDrop($event, group.key)"
      >
        <h3 class="sb-group__title">
          <span>{{ group.label }}</span>
          <span class="sb-count">{{ group.items.length }}</span>
        </h3>
        <p v-if="!group.items.length && !dropTarget(group.key)" class="sb-group__empty">—</p>
        <ul v-else class="sb-group__list">
          <li
            v-for="match in group.items"
            :key="match.id"
            class="sb-item"
            :class="{
              'sb-item--changed': changedIds.has(match.id),
              'sb-item--conflict': conflictsByMatch[match.id],
              'sb-item--dragging': dragMatchId === match.id,
              'sb-item--selected': selectedMatchId === match.id,
              'sb-item--drop-over': dropTargetKey === `before:${match.id}`,
            }"
            @dragover="onDragOver($event, `before:${match.id}`, group.key, match.id)"
            @dragleave="onDragLeave($event, `before:${match.id}`)"
            @drop.stop="onDrop($event, group.key, match.id)"
          >
            <div
              class="sb-item__body"
              :class="{ 'sb-item__body--movable': canMove(match) }"
              :draggable="canMove(match)"
              :role="moveEnabled ? 'button' : undefined"
              :tabindex="moveEnabled ? 0 : undefined"
              :aria-label="moveEnabled ? cardLabel(match) : undefined"
              :aria-pressed="moveEnabled ? selectedMatchId === match.id : undefined"
              :aria-disabled="moveEnabled && !canMove(match) ? 'true' : undefined"
              @dragstart="onDragStart($event, match)"
              @dragend="clearDragState"
              @click="onCardActivate(match, group.key)"
              @keydown.enter="onCardActivate(match, group.key)"
              @keydown.space.prevent="onCardActivate(match, group.key)"
            >
              <div class="sb-item__main">
                <span v-if="view === 'court'" class="sb-item__round" :title="roundLabel(match)">{{ roundLabel(match) }}</span>
                <span class="sb-item__teams">
                  <span class="sb-item__team" :class="{ 'is-tbd': !match.side_a_entry_id }">{{ teamLabel(match.side_a_entry_id) }}</span>
                  <span class="sb-item__vs" aria-hidden="true">vs</span>
                  <span class="sb-item__team" :class="{ 'is-tbd': !match.side_b_entry_id }">{{ teamLabel(match.side_b_entry_id) }}</span>
                </span>
              </div>
              <span class="sb-item__flags">
                <span v-if="changedIds.has(match.id)" class="sb-tag sb-tag--draft">{{ t('schedule.draft') }}</span>
                <span v-if="conflictsByMatch[match.id]" class="sb-tag" :class="conflictsByMatch[match.id].some(blocksPublish) ? 'sb-tag--danger' : 'sb-tag--warn'">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
                  {{ conflictsByMatch[match.id].length }}
                </span>
              </span>
              <span v-if="view !== 'court'" class="sb-slot" :class="{ 'sb-slot--empty': !slotParts(match) }" :aria-label="summary(match) || t('schedule.unassigned')">
                <template v-if="slotParts(match)">
                  <span v-if="slotParts(match).court && view !== 'court'" class="sb-slot__part">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M12 5v14" /><path d="M3 12h18" /></svg>
                    {{ slotParts(match).court }}
                  </span>
                  <span v-if="slotParts(match).time" class="sb-slot__part sb-slot__part--time">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                    {{ slotParts(match).time }}
                  </span>
                  <span v-if="slotParts(match).queue" class="sb-slot__part">{{ slotParts(match).queue }}</span>
                </template>
                <template v-else>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>
                  {{ t('schedule.unassigned') }}
                </template>
              </span>
            </div>
            <div class="sb-item__actions">
              <!-- Lane footer: the lane names the court and "not scheduled" already,
                   so only time and queue place are left to show next to the action. -->
              <span v-if="view === 'court' && !slotHidden(match) && slotParts(match)" class="sb-slot sb-slot--lane" :aria-label="summary(match)">
                <span v-if="slotParts(match).time" class="sb-slot__part sb-slot__part--time">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                  {{ slotParts(match).time }}
                </span>
                <span v-if="slotParts(match).queue" class="sb-slot__part">{{ slotParts(match).queue }}</span>
              </span>
              <button
                class="btn btn--sm sb-assign"
                :class="index.draft[match.id] ? 'btn--ghost' : 'btn--outline'"
                type="button"
                draggable="false"
                :disabled="disabled || match.status === 'finished'"
                @click="emit('assign', match)"
              >
                <svg v-if="index.draft[match.id]" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
                {{ index.draft[match.id] ? t('schedule.change') : t('schedule.assign') }}
              </button>
            </div>
          </li>
          <li v-if="dropTarget(group.key)" class="sb-group__drop" :class="{ 'sb-group__drop--over': dropTargetKey === `column:${group.key}` }">
            <button type="button" class="sb-group__drop-btn" :aria-label="targetLabel(group)" @click="onTargetActivate(group.key)">
              {{ targetLabel(group) }}
            </button>
          </li>
        </ul>
      </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.schedule-board { display: grid; gap: 20px; padding: 24px; }

/* Head */
.sb-head__title {
  display: flex; align-items: center; gap: 6px; margin: 0;
  font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; color: var(--heading);
}
.sb-head__intro { margin: 4px 0 0; max-width: 76ch; color: var(--muted); font-size: 0.9375rem; line-height: 1.5; }

/* Status bar */
.sb-status {
  --tone: var(--disabled); --tone-bg: var(--disabled-bg);
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(160px, 240px) auto; align-items: center; gap: 16px 24px;
  padding: 14px 14px 14px 18px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-row);
}
.sb-status--dirty { --tone: var(--warning); --tone-bg: var(--warning-bg); }
.sb-status--live { --tone: var(--success); --tone-bg: var(--success-bg); }
.sb-status__state { display: flex; align-items: center; gap: 12px; min-width: 0; }
.sb-status__dot { width: 10px; height: 10px; flex: none; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 4px var(--tone-bg); }
.sb-status__lines { display: grid; gap: 2px; min-width: 0; }
.sb-status__lines strong { font-size: 0.9375rem; font-weight: 600; color: var(--text); }
.sb-status__lines span { font-size: 0.8125rem; color: var(--muted); }
.sb-status__progress { display: grid; gap: 6px; }
.sb-status__progress-label { font-size: 0.8125rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.sb-progress { display: block; height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; }
.sb-progress__fill { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 0.3s ease; }
.sb-status__actions { display: flex; gap: 8px; justify-content: flex-end; }

/* Notice (no courts) */
.sb-notice {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px;
  padding: 12px 12px 12px 16px; border-radius: var(--radius-sm);
  background: var(--primary-soft); color: var(--text); font-size: 0.9rem;
}
.sb-notice__icon { color: var(--primary); flex: none; }
.sb-notice__text { flex: 1 1 240px; }

/* Conflicts */
.sb-conflicts { padding: 14px 16px; border: 1px solid var(--warning-border); border-radius: var(--radius-sm); background: var(--warning-bg); }
.sb-conflicts__title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 0.9375rem; font-weight: 600; color: var(--warning-text); }
.sb-conflicts__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; font-size: 0.875rem; }
.sb-conflicts__list ul { margin: 4px 0 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.sb-conflicts__list li li { color: var(--text); }
.sb-conflicts__kind { display: inline-block; margin-right: 6px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.is-hard .sb-conflicts__kind { color: var(--danger); }
.is-soft .sb-conflicts__kind { color: var(--warning-text); }

/* Toolbar */
.sb-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.sb-segmented { display: inline-flex; padding: 4px; gap: 4px; border-radius: 12px; background: var(--surface-row); border: 1px solid var(--border); }
.sb-segmented__btn {
  display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 14px;
  border: 0; border-radius: 8px; background: transparent; color: var(--muted);
  font: inherit; font-size: 0.875rem; font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.sb-segmented__btn:hover { color: var(--text); }
.sb-segmented__btn.is-active { background: var(--surface-raised); color: var(--text); box-shadow: var(--shadow-sm), 0 0 0 1px var(--border); }
.sb-segmented__btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.sb-toolbar__hint { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 0.8125rem; color: var(--muted); }
.sb-empty { margin: 0; padding: 32px 0; text-align: center; color: var(--muted); }

/* Groups */
.sb-groups { display: grid; gap: 24px; }
.sb-group { display: grid; gap: 10px; border-radius: var(--radius-sm); }
.sb-group__title {
  display: flex; align-items: center; gap: 8px; margin: 0;
  font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
}
.sb-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px;
  border-radius: 999px; background: var(--disabled-bg); color: var(--muted);
  font-size: 0.72rem; font-weight: 600; letter-spacing: 0; font-variant-numeric: tabular-nums;
}
.sb-group__empty { margin: 0; color: var(--muted); }
.sb-group__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }

/* Match row */
.sb-item {
  display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 14px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.sb-item:hover { border-color: var(--border-strong); background: var(--surface-hover); }
.sb-item--changed { box-shadow: inset 3px 0 0 var(--warning); }
.sb-item--conflict { border-color: var(--warning-border); }
.sb-item__body { display: flex; align-items: center; gap: 14px; flex: 1 1 auto; min-width: 0; }
.sb-item__main { display: grid; gap: 2px; flex: 1 1 auto; min-width: 0; }
.sb-item__round { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.sb-item__teams { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.sb-item__team { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.sb-item__team.is-tbd { font-weight: 500; color: var(--disabled); }
.sb-item__vs { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; color: var(--disabled); }
.sb-item__flags { display: flex; gap: 6px; flex: none; }
.sb-item__flags:empty { display: none; }
.sb-tag {
  display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 8px; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600;
}
.sb-tag--draft { color: var(--warning-text); background: var(--warning-bg); }
.sb-tag--warn { color: var(--warning-text); background: var(--warning-bg); }
.sb-tag--danger { color: var(--danger); background: var(--danger-bg); }

.sb-slot { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; flex: none; }
.sb-slot__part {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 8px;
  background: var(--primary-soft); color: var(--text); font-size: 0.8125rem; font-weight: 600; white-space: nowrap;
}
.sb-slot svg { flex: none; }
.sb-slot__part svg { color: var(--primary); }
.sb-slot__part--time { font-variant-numeric: tabular-nums; }
.sb-slot--empty {
  flex-wrap: nowrap; white-space: nowrap; height: 30px; padding: 0 10px; gap: 6px; border: 1px dashed var(--border-strong); border-radius: 8px;
  color: var(--muted); font-size: 0.8125rem; font-weight: 500;
}
.sb-item__actions { flex: none; }
.sb-assign { min-width: 128px; }

/* Court view: a board of lanes that scrolls sideways once courts outnumber
   the width. The unscheduled tray is pinned to the left edge. */
.sb-groups--courts {
  --lane: 280px;
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(var(--lane), 1fr); grid-template-columns: none;
  align-items: start; gap: 12px; overflow-x: auto; overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  padding-bottom: 12px;
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
  /* Dragging a card must not paint text selections across the board. */
  user-select: none; -webkit-user-select: none;
}
.sb-groups--courts.is-fade-right { mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent); }
.sb-groups--courts.is-fade-left.is-fade-right { mask-image: linear-gradient(to right, transparent, #000 32px, #000 calc(100% - 40px), transparent); }
.sb-groups--courts.is-fade-left:not(.is-fade-right) { mask-image: linear-gradient(to right, transparent, #000 32px); }
.sb-layout { display: grid; gap: 24px; }
.sb-layout--courts { grid-template-columns: 280px minmax(0, 1fr); align-items: start; gap: 12px; }
.sb-groups--tray { display: grid; }
.sb-groups--tray .sb-group, .sb-groups--courts .sb-group {
  align-content: start; scroll-snap-align: start; min-height: 160px; padding: 12px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-row);
}
/* The tray sits in its own column; a dashed frame marks it as the source of drags. */
.sb-groups--tray .sb-group--tray { background: var(--surface); border-style: dashed; border-color: var(--border-strong); }

/* Lane card, stacked: number · round · flags / teams / time and action. */
.sb-layout--courts .sb-item { position: relative; display: block; padding: 12px; }
.sb-layout--courts .sb-item__body {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 10px; min-width: 0;
}
.sb-layout--courts .sb-item__main { display: contents; }
.sb-layout--courts .sb-item__round {
  grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sb-layout--courts .sb-item__flags { grid-column: 2; grid-row: 1; }
.sb-layout--courts .sb-item__teams { grid-column: 1 / -1; grid-row: 2; flex-direction: column; align-items: flex-start; gap: 2px; padding: 4px 0 2px; }
.sb-layout--courts .sb-item__team { font-size: 0.9875rem; }
.sb-layout--courts .sb-item__vs { display: none; }
/* Footer row in flow: time/queue chips on the left, the action on the right; wraps when narrow. */
.sb-layout--courts .sb-item__actions {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 10px;
}
.sb-layout--courts .sb-slot--lane { flex: 1 1 auto; justify-content: flex-start; min-width: 0; }
.sb-layout--courts .sb-slot__part { white-space: nowrap; }
.sb-layout--courts .sb-assign { flex: none; min-width: 0; height: 32px; min-height: 32px; padding: 0 10px; font-size: 0.8125rem; border-radius: 8px; }

.sb-toolbar__scroll { display: inline-flex; gap: 6px; margin-left: auto; }
.sb-toolbar__scroll + .sb-toolbar__hint { margin-left: 0; }
.sb-scroll-btn {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface-row); color: var(--text); cursor: pointer;
  transition: border-color 0.15s, background 0.15s, opacity 0.15s;
}
.sb-scroll-btn:hover:not(:disabled) { border-color: var(--primary); }
.sb-scroll-btn:disabled { opacity: 0.35; cursor: default; }
.sb-scroll-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

/* Move / drag states */
.sb-item__body--movable { cursor: grab; }
.sb-item__body--movable:active { cursor: grabbing; }
.sb-item__body:focus-visible { outline: 2px solid var(--primary); outline-offset: 4px; border-radius: 8px; }
.sb-item--dragging { opacity: 0.45; }
.sb-item--selected { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-focus-ring); }
.sb-item--drop-over { border-color: var(--primary); box-shadow: inset 0 3px 0 -1px var(--primary); }
.sb-group--drop-over { outline: 2px dashed var(--primary); outline-offset: 4px; }
.sb-group__drop { list-style: none; }
.sb-group__drop-btn {
  width: 100%; min-height: 44px; padding: 8px 12px; border: 1px dashed var(--border-strong); border-radius: var(--radius-sm);
  background: transparent; color: var(--muted); font: inherit; font-size: 0.8125rem; cursor: pointer; transition: border-color 0.15s, color 0.15s;
}
.sb-group__drop-btn:hover { border-color: var(--primary); color: var(--text); }
.sb-group__drop--over .sb-group__drop-btn { border-color: var(--primary); border-style: solid; color: var(--text); }

@media (max-width: 900px) {
  .sb-status { grid-template-columns: 1fr; }
  .sb-status__actions { justify-content: flex-start; flex-wrap: wrap; }
}
@media (max-width: 640px) {
  .schedule-board { padding: 16px; }
  .sb-status__actions .btn { flex: 1 1 auto; }
  .sb-item { flex-wrap: wrap; padding: 12px; }
  .sb-item__body { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; width: 100%; }
  .sb-item__teams { flex-direction: column; align-items: flex-start; gap: 0; }
  .sb-item__vs { display: none; }
  .sb-item__flags { grid-column: 1 / -1; }
  .sb-slot { grid-column: 1 / -1; justify-self: start; justify-content: flex-start; }
  .sb-item__actions, .sb-assign { width: 100%; }
}
@media (max-width: 640px) {
  .sb-layout--courts { grid-template-columns: minmax(0, 1fr); }
  .sb-groups--courts { --lane: 84vw; }
  .sb-layout--courts .sb-item__actions, .sb-layout--courts .sb-assign { width: auto; }
  .sb-layout--courts .sb-item__body { grid-template-columns: minmax(0, 1fr) auto; }
  .sb-layout--courts .sb-item__flags { grid-column: 2; }
}
@media (prefers-reduced-motion: reduce) {
  .sb-progress__fill, .sb-item { transition: none; }
}
</style>
