<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CourtsEditor from './CourtsEditor.vue'
import { entryMemberNames } from '../../lib/entryDisplay'
import { supabase } from '../../lib/supabase'
import { conflictText, draftDiff, formatScheduleTime, indexSchedule, scheduleError, scheduleSummary, timezoneOf } from '../../lib/schedule'

const props = defineProps({
  tournament: { type: Object, required: true },
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  courts: { type: Array, default: () => [] },
  schedule: { type: Array, default: () => [] },
  busy: Boolean,
  canManage: Boolean,
})
const emit = defineEmits(['assign', 'publish', 'revert', 'save-courts'])
const { t, locale } = useI18n()

const view = ref('round')
const conflicts = ref([])
const conflictsError = ref('')
const timeZone = computed(() => timezoneOf(props.tournament))
const courtsById = computed(() => Object.fromEntries(props.courts.map(c => [c.id, c])))
const index = computed(() => indexSchedule(props.schedule))
const diff = computed(() => draftDiff(props.schedule))
const changedIds = computed(() => new Set(diff.value.changed))
const conflictsByMatch = computed(() => Object.fromEntries(conflicts.value.map(c => [c.match_id, c.conflicts])))
const hasHard = computed(() => conflicts.value.some(c => c.conflicts.some(x => x.severity === 'hard')))
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
async function loadConflicts() {
  if (!props.canManage || !props.tournament?.id) { conflicts.value = []; return }
  try {
    const { data, error } = await supabase.rpc('schedule_draft_conflicts', { p_tournament_id: props.tournament.id })
    if (error) throw error
    conflicts.value = Array.isArray(data) ? data : []
    conflictsError.value = ''
  } catch (error) {
    conflictsError.value = scheduleError(error?.message, t)
  }
}
watch(() => [props.schedule, props.tournament?.schedule_config], () => {
  clearTimeout(conflictsTimer)
  conflictsTimer = setTimeout(loadConflicts, 200)
}, { deep: true, immediate: true })
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
          <button class="btn btn--primary btn--sm" type="button" :disabled="disabled || !diff.count || hasHard" @click="emit('publish')">{{ t('schedule.publish') }}</button>
          <button class="btn btn--ghost btn--sm" type="button" :disabled="disabled || !diff.count" @click="emit('revert')">{{ t('schedule.revert') }}</button>
        </div>
      </div>
    </header>

    <CourtsEditor :courts="courts" :disabled="disabled" @save="emit('save-courts', $event)" />

    <div class="divider" />

    <section v-if="conflicts.length || conflictsError" class="schedule-board__conflicts" aria-live="polite">
      <h3 class="section-title" style="font-size: 1rem">{{ t('schedule.conflicts') }}</h3>
      <p v-if="conflictsError" class="error-text" role="alert">{{ conflictsError }}</p>
      <ul v-else class="schedule-board__conflict-list">
        <li v-for="item in conflicts" :key="item.match_id">
          <strong>{{ matchLabelById(item.match_id) }}</strong>
          <ul>
            <li v-for="(conflict, i) in item.conflicts" :key="i" :class="conflict.severity === 'hard' ? 'error-text' : ''">
              {{ t(conflict.severity === 'hard' ? 'schedule.hard' : 'schedule.soft') }}: {{ conflictText(conflict, t, matchLabelById) }}
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

    <p v-if="!matches.length" class="muted">{{ t('bracket.empty') }}</p>

    <div v-else class="schedule-board__groups" :class="{ 'schedule-board__groups--courts': view === 'court' }">
      <section v-for="group in (view === 'round' ? byRound : byCourt)" :key="group.key || group.label" class="schedule-group">
        <h3 class="schedule-group__title">{{ group.label }} <span class="badge badge--neutral">{{ group.items.length }}</span></h3>
        <p v-if="!group.items.length" class="muted" style="margin: 0">—</p>
        <ul v-else class="schedule-group__list">
          <li v-for="match in group.items" :key="match.id" class="schedule-item" :class="{ 'schedule-item--changed': changedIds.has(match.id), 'schedule-item--conflict': conflictsByMatch[match.id] }">
            <div class="schedule-item__body">
              <strong class="schedule-item__teams">{{ matchTitle(match) }}</strong>
              <span v-if="view === 'court'" class="muted schedule-item__round">{{ roundLabel(match) }}</span>
              <span class="schedule-item__when" :class="{ muted: !index.draft[match.id] }">
                {{ summary(match) || t('schedule.unassigned') }}
              </span>
              <span v-if="changedIds.has(match.id)" class="badge badge--warn">{{ t('schedule.draft') }}</span>
              <span v-if="conflictsByMatch[match.id]" class="badge" :class="conflictsByMatch[match.id].some(c => c.severity === 'hard') ? 'badge--danger' : 'badge--warn'">
                {{ conflictsByMatch[match.id].length }}
              </span>
            </div>
            <div class="schedule-item__actions">
              <button class="btn btn--secondary btn--sm" type="button" :disabled="disabled || match.status === 'finished'" @click="emit('assign', match)">
                {{ index.draft[match.id] ? t('schedule.change') : t('schedule.assign') }}
              </button>
            </div>
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
@media (max-width: 560px) {
  .schedule-board__publish { justify-items: start; text-align: left; }
  .schedule-item__actions { width: 100%; }
  .schedule-item__actions .btn { width: 100%; }
}
</style>
