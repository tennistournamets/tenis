<script setup>
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { entryMemberNames } from '../lib/entryDisplay'
import { formatSetScore } from '../lib/tennisRules'
import { pointLabel, scoreLine } from '../lib/useTennisScoring'

const props = defineProps({
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  setsByMatch: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  canEditFinal: { type: Boolean, default: false },
  canLiveScore: { type: Boolean, default: false },
})

const emit = defineEmits(['edit-result', 'view-live'])
const { t } = useI18n()
const titleId = useId()
const search = ref('')
const statusFilter = ref('current')
const stageFilter = ref('all')

const stageOrder = { group: 0, winners: 1, main: 1, losers: 2, grand_final: 3, third_place: 4 }

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}

function isLive(match) {
  return props.liveScoresByMatch[match.id]?.status === 'active'
}

function matchState(match) {
  if (isLive(match)) return 'live'
  if (match.status === 'finished') return 'finished'
  if (match.side_a_entry_id && match.side_b_entry_id) return 'ready'
  return 'waiting'
}

function stateLabel(match) {
  return t(`mobile.matchStatus.${matchState(match)}`)
}

function stageLabel(stage) {
  return t(`mobile.matchStage.${stage || 'main'}`)
}

function roundLabel(match) {
  if (match.stage === 'grand_final') return t('mobile.matchStage.grand_final')
  if (match.stage === 'third_place') return t('mobile.matchStage.third_place')
  const round = Number(match.round_number || 0)
  return round ? t('bracket.roundN', { n: round > 1000 ? round % 1000 : round }) : stageLabel(match.stage)
}

function finalScore(match) {
  const sets = [...(props.setsByMatch[match.id] || [])].sort((a, b) => a.set_index - b.set_index)
  if (sets.length) return sets.map(formatSetScore).join(' · ')
  if (match.side_a_score != null && match.side_b_score != null) {
    const base = `${match.side_a_score} : ${match.side_b_score}`
    return match.side_a_pens != null && match.side_b_pens != null
      ? `${base} (${match.side_a_pens}:${match.side_b_pens})`
      : base
  }
  return '—'
}

watch(() => props.matches, (next) => {
  if (statusFilter.value !== 'current' || !next.length) return
  const hasCurrent = next.some((match) => ['live', 'ready'].includes(matchState(match)))
  if (!hasCurrent && next.some((match) => match.status === 'finished')) statusFilter.value = 'finished'
}, { immediate: true })

const stages = computed(() => [...new Set(props.matches.map((match) => match.stage || 'main'))]
  .sort((a, b) => (stageOrder[a] ?? 8) - (stageOrder[b] ?? 8)))

const visibleMatches = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase()
  return [...props.matches]
    .filter((match) => {
      const state = matchState(match)
      if (statusFilter.value === 'current' && !['live', 'ready'].includes(state)) return false
      if (statusFilter.value !== 'all' && statusFilter.value !== 'current' && state !== statusFilter.value) return false
      if (stageFilter.value !== 'all' && (match.stage || 'main') !== stageFilter.value) return false
      if (!needle) return true
      return `${teamLabel(match.side_a_entry_id)} ${teamLabel(match.side_b_entry_id)}`.toLocaleLowerCase().includes(needle)
    })
    .sort((a, b) => {
      const stateOrder = { live: 0, ready: 1, waiting: 2, finished: 3 }
      return stateOrder[matchState(a)] - stateOrder[matchState(b)]
        || (stageOrder[a.stage] ?? 8) - (stageOrder[b.stage] ?? 8)
        || (a.round_number || 0) - (b.round_number || 0)
        || (a.match_number || 0) - (b.match_number || 0)
    })
})
</script>

<template>
  <section class="match-center" :aria-labelledby="titleId">
    <header class="match-center__head">
      <div>
        <p class="match-center__eyebrow">{{ t('mobile.matchCenterEyebrow') }}</p>
        <h2 :id="titleId" class="match-center__title">{{ t('mobile.matches') }}</h2>
      </div>
      <span class="match-center__count">{{ visibleMatches.length }}</span>
    </header>

    <div class="match-center__tools">
      <label class="match-center__search">
        <span class="sr-only">{{ t('mobile.searchMatches') }}</span>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.7"/><path d="m13.5 13.5 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        <input v-model="search" type="search" :placeholder="t('mobile.searchMatches')" />
      </label>

      <div class="match-center__filters" :aria-label="t('mobile.filterMatches')">
        <button
          v-for="value in ['current', 'live', 'finished', 'all']"
          :key="value"
          type="button"
          class="match-filter"
          :class="{ 'match-filter--active': statusFilter === value }"
          :aria-pressed="statusFilter === value"
          @click="statusFilter = value"
        >
          {{ t(`mobile.matchFilter.${value}`) }}
        </button>
      </div>

      <label v-if="stages.length > 1" class="match-center__stage">
        <span>{{ t('mobile.stageFilter') }}</span>
        <select v-model="stageFilter" class="input">
          <option value="all">{{ t('mobile.allStages') }}</option>
          <option v-for="stage in stages" :key="stage" :value="stage">{{ stageLabel(stage) }}</option>
        </select>
      </label>
    </div>

    <div v-if="visibleMatches.length" class="match-list">
      <article
        v-for="match in visibleMatches"
        :key="match.id"
        class="mobile-match"
        :class="`mobile-match--${matchState(match)}`"
        :data-match-id="match.id"
      >
        <header class="mobile-match__meta">
          <span>
            {{ stageLabel(match.stage) }}<template v-if="roundLabel(match) !== stageLabel(match.stage)"> · {{ roundLabel(match) }}</template>
          </span>
          <span class="mobile-match__status"><i aria-hidden="true"></i>{{ stateLabel(match) }}</span>
        </header>

        <div class="mobile-match__teams">
          <strong :class="{ 'mobile-match__winner': match.winner_entry_id === match.side_a_entry_id }">{{ teamLabel(match.side_a_entry_id) }}</strong>
          <span aria-hidden="true">—</span>
          <strong :class="{ 'mobile-match__winner': match.winner_entry_id === match.side_b_entry_id }">{{ teamLabel(match.side_b_entry_id) }}</strong>
        </div>

        <div v-if="isLive(match)" class="mobile-match__score mobile-match__score--live">
          <span>{{ scoreLine(liveScoresByMatch[match.id].state) }}</span>
          <strong>{{ pointLabel(liveScoresByMatch[match.id].state, 'a') }} : {{ pointLabel(liveScoresByMatch[match.id].state, 'b') }}</strong>
        </div>
        <div v-else-if="match.status === 'finished'" class="mobile-match__score">
          <span>{{ t('mobile.finalScore') }}</span><strong>{{ finalScore(match) }}</strong>
        </div>

        <footer v-if="isLive(match) || (canEditFinal && match.side_a_entry_id && match.side_b_entry_id) || (canLiveScore && match.status !== 'finished' && match.side_a_entry_id && match.side_b_entry_id)" class="mobile-match__actions">
          <button
            v-if="isLive(match)"
            type="button"
            class="btn btn--primary btn--sm"
            @click="emit('view-live', match)"
          >{{ canLiveScore ? t('mobile.continueLive') : t('mobile.watchLive') }}</button>
          <button
            v-if="canEditFinal"
            type="button"
            class="btn btn--secondary btn--sm"
            @click="emit('edit-result', match)"
          >{{ match.status === 'finished' ? t('mobile.correctResult') : t('mobile.enterResult') }}</button>
          <button
            v-if="canLiveScore && !isLive(match) && match.status !== 'finished'"
            type="button"
            class="btn btn--ghost btn--sm"
            @click="emit('view-live', match)"
          >{{ t('live.start') }}</button>
        </footer>
      </article>
    </div>

    <div v-else class="match-center__empty" role="status">
      <span aria-hidden="true">⌕</span>
      <strong>{{ t('mobile.noMatchesFound') }}</strong>
      <button v-if="search || statusFilter !== 'all' || stageFilter !== 'all'" type="button" class="btn btn--ghost btn--sm" @click="search = ''; statusFilter = 'all'; stageFilter = 'all'">
        {{ t('mobile.resetFilters') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.match-center { display: grid; gap: 14px; }
.match-center__head { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
.match-center__eyebrow { margin: 0 0 3px; color: var(--primary); font-size: .72rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.match-center__title { margin: 0; font-size: clamp(1.35rem, 6vw, 1.75rem); }
.match-center__count { min-width: 36px; height: 36px; display: grid; place-items: center; border-radius: 12px; color: var(--primary); background: var(--primary-muted); font-weight: 800; }
.match-center__tools { display: grid; gap: 10px; }
.match-center__search { min-height: 46px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border: 1px solid var(--border); border-radius: 14px; color: var(--text-muted); background: var(--surface); }
.match-center__search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-muted); }
.match-center__search input { width: 100%; min-width: 0; border: 0; outline: 0; color: var(--text); background: transparent; font: inherit; }
.match-center__filters { display: flex; gap: 8px; overflow-x: auto; padding: 1px 1px 4px; scrollbar-width: none; }
.match-center__filters::-webkit-scrollbar { display: none; }
.match-filter { min-height: 38px; flex: 0 0 auto; padding: 0 13px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); background: var(--surface); font: inherit; font-size: .84rem; font-weight: 700; }
.match-filter--active { border-color: var(--primary); color: var(--primary); background: var(--primary-muted); }
.match-center__stage { display: flex; align-items: center; gap: 12px; color: var(--text-muted); font-size: .84rem; }
.match-center__stage .input { flex: 1; min-height: 42px; }
.match-list { display: grid; gap: 10px; }
.mobile-match { position: relative; overflow: hidden; padding: 14px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); box-shadow: 0 8px 24px rgb(15 23 42 / 5%); }
.mobile-match::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--border); }
.mobile-match--live::before { background: #ef4444; }
.mobile-match--ready::before { background: var(--primary); }
.mobile-match__meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-muted); font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.mobile-match__status { display: inline-flex; align-items: center; gap: 5px; text-align: right; }
.mobile-match__status i { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong, #94a3b8); }
.mobile-match--live .mobile-match__status { color: #dc2626; }
.mobile-match--live .mobile-match__status i { background: #ef4444; box-shadow: 0 0 0 4px rgb(239 68 68 / 12%); }
.mobile-match--ready .mobile-match__status i { background: var(--primary); }
.mobile-match__teams { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 9px; margin-top: 13px; }
.mobile-match__teams strong { min-width: 0; overflow-wrap: anywhere; font-size: .98rem; line-height: 1.32; }
.mobile-match__teams strong:last-child { text-align: right; }
.mobile-match__winner { color: var(--primary); }
.mobile-match__score { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 9px 11px; border-radius: 10px; color: var(--text-muted); background: var(--surface-row); font-size: .86rem; }
.mobile-match__score strong { color: var(--text); font-size: .95rem; }
.mobile-match__score--live { color: #b91c1c; background: rgb(239 68 68 / 8%); }
.mobile-match__score--live strong { color: #b91c1c; }
.mobile-match__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mobile-match__actions .btn { flex: 1 1 120px; min-height: 42px; }
.match-center__empty { min-height: 180px; display: grid; place-items: center; align-content: center; gap: 10px; padding: 24px; border: 1px dashed var(--border); border-radius: 18px; color: var(--text-muted); text-align: center; }
.match-center__empty > span { font-size: 2rem; }
@media (min-width: 721px) {
  .match-center__tools { grid-template-columns: minmax(240px, 1fr) auto; align-items: center; }
  .match-center__stage { grid-column: 1 / -1; max-width: 420px; }
  .match-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
