<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { entryMemberNames } from '../../lib/entryDisplay'
import { supabase } from '../../lib/supabase'
import {
  blocksPublish, conflictText, draftDiff, formatScheduleTime, indexSchedule, scheduleDropAction, scheduleError,
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
const conflictsByMatch = computed(() => Object.fromEntries(conflicts.value.map(c => [c.match_id, c.conflicts])))
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
function roundLabel(match) {
  if (match.stage === 'grand_final' || match.stage === 'third_place') return t(`mobile.matchStage.${match.stage}`)
  const round = Number(match.round_number || 0)
  const base = t(`mobile.matchStage.${match.stage || 'main'}`)
  return round ? `${base} · ${t('bracket.roundN', { n: round > 1000 ? round % 1000 : round })}` : base
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
  return [...columns, noCourt, unscheduled].filter(c => c.items.length || c.key !== 'none')
})

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
  <section class="card stack stack--sm schedule-board" aria-labelledby="schedule-title">
    <header class="schedule-board__head">
      <div>
        <h2 id="schedule-title" class="section-title" style="margin: 0">{{ t('schedule.title') }}</h2>
        <p class="muted" style="margin: 4px 0 0">{{ t('schedule.intro') }}</p>
      </div>
      <div class="schedule-board__publish">
        <p class="muted" style="margin: 0">
          <template v-if="tournament.schedule_published_at">{{ t('schedule.publishedAt', { date: publishedAt }) }}</template>
          <template v-else>{{ t('schedule.notPublished') }}</template>
        </p>
        <p class="muted" style="margin: 0">{{ diff.count ? t('schedule.draftChanges', { count: diff.count }) : t('schedule.noDraftChanges') }}</p>
        <div class="inline-actions">
          <button class="btn btn--primary btn--sm" type="button" :disabled="disabled || !diff.count || publishBlocked" @click="emit('publish')">{{ t('schedule.publish') }}</button>
          <button class="btn btn--ghost btn--sm" type="button" :disabled="disabled || !diff.count" @click="emit('revert')">{{ t('schedule.revert') }}</button>
        </div>
      </div>
    </header>

    <!-- Корты редактируются на своей вкладке; без них назначать матчи некуда -->
    <div v-if="!courts.length" class="alert alert--info row row--between" role="status">
      <span>{{ t('schedule.noCourts') }}</span>
      <button class="btn btn--outline btn--sm" type="button" :disabled="disabled" @click="emit('open-courts')">{{ t('schedule.goToCourts') }}</button>
    </div>

    <div class="divider" />

    <section v-if="conflicts.length || conflictsError" class="schedule-board__conflicts" aria-live="polite">
      <h3 class="section-title" style="font-size: 1rem">{{ t('schedule.conflicts') }}</h3>
      <p v-if="conflictsError" class="error-text" role="alert">{{ conflictsError }}</p>
      <ul v-else class="schedule-board__conflict-list">
        <li v-for="item in conflicts" :key="item.match_id">
          <strong>{{ matchLabelById(item.match_id) }}</strong>
          <ul>
            <li v-for="(conflict, i) in item.conflicts" :key="i" :class="blocksPublish(conflict) ? 'error-text' : ''">
              {{ t(blocksPublish(conflict) ? 'schedule.hard' : 'schedule.soft') }}: {{ conflictText(conflict, t, matchLabelById) }}
            </li>
          </ul>
        </li>
      </ul>
    </section>
    <p class="muted schedule-board__limits">{{ t('schedule.limitations') }}</p>

    <div class="schedule-board__toolbar">
      <div class="tab-group" role="tablist">
        <button type="button" role="tab" class="tab" :class="{ 'tab--active': view === 'round' }" :aria-selected="view === 'round'" @click="view = 'round'">{{ t('schedule.viewByRound') }}</button>
        <button type="button" role="tab" class="tab" :class="{ 'tab--active': view === 'court' }" :aria-selected="view === 'court'" @click="view = 'court'">{{ t('schedule.viewByCourt') }}</button>
      </div>
    </div>

    <p v-if="moveEnabled" class="schedule-board__move-hint" role="status">
      {{ selectedMatchId ? t('schedule.selectedMatch', { match: matchLabelById(selectedMatchId) }) : t('schedule.moveHint') }}
    </p>

    <p v-if="!matches.length" class="muted">{{ t('bracket.empty') }}</p>

    <div v-else class="schedule-board__groups" :class="{ 'schedule-board__groups--courts': view === 'court' }">
      <section
        v-for="group in (view === 'round' ? byRound : byCourt)"
        :key="group.key || group.label"
        class="schedule-group"
        :class="{ 'schedule-group--drop-over': dropTargetKey === `column:${group.key}` }"
        @dragover="onDragOver($event, `column:${group.key}`, group.key)"
        @dragleave="onDragLeave($event, `column:${group.key}`)"
        @drop="onDrop($event, group.key)"
      >
        <h3 class="schedule-group__title">{{ group.label }} <span class="badge badge--neutral">{{ group.items.length }}</span></h3>
        <p v-if="!group.items.length && !dropTarget(group.key)" class="muted" style="margin: 0">—</p>
        <ul v-else class="schedule-group__list">
          <li
            v-for="match in group.items"
            :key="match.id"
            class="schedule-item"
            :class="{
              'schedule-item--changed': changedIds.has(match.id),
              'schedule-item--conflict': conflictsByMatch[match.id],
              'schedule-item--dragging': dragMatchId === match.id,
              'schedule-item--selected': selectedMatchId === match.id,
              'schedule-item--drop-over': dropTargetKey === `before:${match.id}`,
            }"
            @dragover="onDragOver($event, `before:${match.id}`, group.key, match.id)"
            @dragleave="onDragLeave($event, `before:${match.id}`)"
            @drop.stop="onDrop($event, group.key, match.id)"
          >
            <div
              class="schedule-item__body"
              :class="{ 'schedule-item__body--movable': canMove(match) }"
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
              <strong class="schedule-item__teams">{{ matchTitle(match) }}</strong>
              <span v-if="view === 'court'" class="muted schedule-item__round">{{ roundLabel(match) }}</span>
              <span class="schedule-item__when" :class="{ muted: !index.draft[match.id] }">
                {{ summary(match) || t('schedule.unassigned') }}
              </span>
              <span v-if="changedIds.has(match.id)" class="badge badge--warn">{{ t('schedule.draft') }}</span>
              <span v-if="conflictsByMatch[match.id]" class="badge" :class="conflictsByMatch[match.id].some(blocksPublish) ? 'badge--danger' : 'badge--warn'">
                {{ conflictsByMatch[match.id].length }}
              </span>
            </div>
            <div class="schedule-item__actions">
              <button class="btn btn--secondary btn--sm" type="button" draggable="false" :disabled="disabled || match.status === 'finished'" @click="emit('assign', match)">
                {{ index.draft[match.id] ? t('schedule.change') : t('schedule.assign') }}
              </button>
            </div>
          </li>
          <li v-if="dropTarget(group.key)" class="schedule-group__drop" :class="{ 'schedule-group__drop--over': dropTargetKey === `column:${group.key}` }">
            <button type="button" class="schedule-group__drop-btn" :aria-label="targetLabel(group)" @click="onTargetActivate(group.key)">
              {{ targetLabel(group) }}
            </button>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.schedule-board__head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
.schedule-board__publish { display: grid; gap: 6px; justify-items: end; text-align: right; }
.schedule-board__limits { margin: 0; font-size: 0.82rem; }
.schedule-board__conflict-list { margin: 0; padding: 0 0 0 18px; display: grid; gap: 8px; font-size: 0.9rem; }
.schedule-board__conflict-list ul { margin: 4px 0 0; padding-left: 16px; }
.schedule-board__toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.schedule-board__groups { display: grid; gap: 14px; }
.schedule-board__groups--courts { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: start; }
.schedule-group { display: grid; gap: 8px; }
.schedule-group__title { margin: 0; font-size: 0.95rem; display: flex; align-items: center; gap: 8px; }
.schedule-group__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.schedule-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-row); }
.schedule-item--changed { border-color: var(--primary); }
.schedule-item--conflict { border-style: dashed; }
.schedule-item__body { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; flex: 1 1 240px; }
.schedule-item__teams { overflow-wrap: anywhere; }
.schedule-item__round { font-size: 0.8rem; }
.schedule-item__when { font-size: 0.9rem; font-weight: 600; }
.schedule-item__actions .btn { min-height: 40px; }
.schedule-board__move-hint { margin: 0; font-size: 0.84rem; color: var(--text-muted); }
.schedule-group--drop-over { outline: 2px dashed var(--primary); outline-offset: 4px; border-radius: 12px; }
.schedule-item__body--movable { cursor: grab; }
.schedule-item__body--movable:active { cursor: grabbing; }
.schedule-item__body:focus-visible { outline: 3px solid var(--primary-muted); outline-offset: 2px; border-radius: 8px; }
.schedule-item--dragging { opacity: 0.45; }
.schedule-item--selected { outline: 2px solid var(--primary); outline-offset: 3px; }
/* Sits above --conflict, which only dashes the border. */
.schedule-item--drop-over { border-color: var(--primary); border-style: solid; box-shadow: inset 0 3px 0 -1px var(--primary); }
.schedule-group__drop { list-style: none; }
.schedule-group__drop-btn {
  width: 100%; min-height: 44px; padding: 8px 12px; border: 1px dashed var(--border); border-radius: 12px;
  background: transparent; color: var(--text-muted); font: inherit; font-size: 0.84rem; cursor: pointer;
}
.schedule-group__drop-btn:hover { border-color: var(--primary); color: var(--text); }
.schedule-group__drop--over .schedule-group__drop-btn { border-color: var(--primary); border-style: solid; color: var(--text); }
@media (max-width: 560px) {
  .schedule-board__publish { justify-items: start; text-align: left; }
  .schedule-item__actions { width: 100%; }
  .schedule-item__actions .btn { width: 100%; }
}
</style>
