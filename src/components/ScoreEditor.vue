<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { entryDisplayNames } from '../lib/entryDisplay'
import { isByeMatch } from '../lib/bracketDisplay'
import { supabase } from '../lib/supabase'
import { useUnsavedChanges } from '../lib/unsavedChanges'
import { saveMatchResult } from '../lib/saveMatchResult'
import { confirmDialog } from '../lib/confirmDialog'
import TennisSetInputs from './TennisSetInputs.vue'
import { knockoutTotals, matchRoundName } from '../lib/roundLabels'
import { groupIndexOfRound, groupNamesById, groupRoundLabel, roundInGroup } from '../lib/groupsFlow'
import { scoreRows, buildSetPayload, scoringError, hasMatchWinner } from '../lib/tennisRules'

const props = defineProps({
  scoringConfig: { type: Object, default: () => ({}) },
  matches: {
    type: Array,
    default: () => [],
  },
  setsByMatch: {
    type: Object,
    default: () => ({}),
  },
  entriesMap: {
    type: Object,
    default: () => ({}),
  },
  setFormat: {
    type: String,
    default: 'best_of_3',
  },
  category: {
    type: String,
    default: 'singles',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  canLiveScore: {
    type: Boolean,
    default: false,
  },
  liveScoresByMatch: {
    type: Object,
    default: () => ({}),
  },
  // Groups + playoff: group letters in round headings, "Playoff" for its knockout.
  groups: { type: Array, default: () => [] },
  format: { type: String, default: '' },
})

const emit = defineEmits(['saved', 'start-live'])

const { t } = useI18n()
const setForms = reactive({})
const savedFlash = reactive({})
const drafts = reactive({})
const draftMatches = reactive({})
const removed = id => !props.matches.some(m => m.id === id)
const visibleMatches = computed(() => [...props.matches, ...Object.values(draftMatches).filter(m => removed(m.id) && changed(m.id))])
useUnsavedChanges(() => Object.keys(drafts).some(id => changed(id)), () => Object.values(setForms).some(rows => rows.some(r => r.saving)))
const rowsKey = rows => JSON.stringify((rows || []).map(({ saving, error, ...row }) => row))
function changed(matchId) { return Boolean(drafts[matchId] && drafts[matchId].key !== rowsKey(setForms[matchId])) }
function stale(match) { return drafts[match.id]?.revision !== match.score_revision }
async function reloadResult(match) {
  const rows = setForms[match.id] || []
  if (rows.some(r => r.saving)) return
  if (changed(match.id) && !(await confirmDialog(t('scoringFlow.reloadConfirm')))) return
  rows.forEach(r => { r.saving = true })
  try {
    const { data, error } = await supabase.rpc('get_tournament_score_state', { p_tournament_id: match.tournament_id })
    if (error) { setForms[match.id][0].error = t('scoringFlow.unavailable'); return }
    const current = data.matches.find(m => m.id === match.id)
    if (!current) {
      delete drafts[match.id]; delete setForms[match.id]; delete draftMatches[match.id]
      emit('saved'); return
    }
    setForms[match.id] = scoreRows(data.sets.filter(s => s.match_id === match.id), props.setFormat).map(row => ({...row, saving:false, error:''}))
    drafts[match.id] = { revision: current.score_revision, key: rowsKey(setForms[match.id]) }
    emit('saved')
  } catch {
    if (setForms[match.id]?.[0]) setForms[match.id][0].error = t('scoringFlow.unavailable')
  } finally { rows.forEach(r => { r.saving = false }) }
}

function initializeRows(matchId) {
  const match = props.matches.find(m => m.id === matchId)
  draftMatches[matchId] = { ...match, labelA: teamLabel(match.side_a_entry_id, match), labelB: teamLabel(match.side_b_entry_id, match) }
  setForms[matchId] = scoreRows(props.setsByMatch[matchId] || [], props.setFormat)
    .map(row => ({ ...row, saving: false, error: '' }))
  drafts[matchId] = { revision: props.matches.find(m => m.id === matchId)?.score_revision, key: rowsKey(setForms[matchId]) }
}

watch(
  () => [props.matches, props.setsByMatch, props.setFormat],
  () => {
    props.matches.forEach((match) => {
      if (!drafts[match.id] || (match.score_revision >= drafts[match.id].revision && !changed(match.id) && !(setForms[match.id] || []).some(r => r.saving || r.error))) initializeRows(match.id)
    })
  },
  { immediate: true, deep: true },
)

// Display filter only: hidden matches keep their drafts and unsaved guard.
const filter = ref('all')
const isFinished = m => m.status === 'finished'
const filterMatch = (m) => {
  if (filter.value === 'finished') return isFinished(m)
  if (filter.value === 'todo') return !isFinished(m) && canScore(m)
  if (filter.value === 'waiting') return !isFinished(m) && !canScore(m)
  return true
}
const counts = computed(() => ({
  all: visibleMatches.value.length,
  todo: visibleMatches.value.filter(m => !isFinished(m) && canScore(m)).length,
  finished: visibleMatches.value.filter(isFinished).length,
  waiting: visibleMatches.value.filter(m => !isFinished(m) && !canScore(m)).length,
}))
// Every match lands in exactly one filter besides "All", so the counts add up.
const filterKeys = computed(() => ['all', 'todo', 'finished', ...(counts.value.waiting ? ['waiting'] : [])])
const filterLabel = key => t(`scoringFlow.${{ all: 'filterAll', todo: 'filterToEnter', finished: 'filterFinished', waiting: 'filterWaiting' }[key]}`)
const liveCount = computed(() => playable.value.filter(m => liveStatus(m.id) === 'active').length)
// The server accepts only a complete result; say so before the click, not after.
const missingWinner = match => !hasMatchWinner(setForms[match.id] || [], props.scoringConfig, props.setFormat)
const requiredWins = computed(() => (props.setFormat === 'best_of_5' ? 3 : 2))
const playable = computed(() => props.matches.filter(m => !isByeMatch(m)))
const playedCount = computed(() => playable.value.filter(isFinished).length)
function matchStatus(match) {
  if (liveStatus(match.id) === 'active') return 'live'
  if (isFinished(match)) return 'finished'
  return canScore(match) ? 'ready' : 'pending'
}

const stageOrder = { main: 0, group: 1, winners: 2, losers: 3, grand_final: 4 }
const multipleStages = computed(() => new Set(props.matches.map(m => m.stage)).size > 1)
const matchesByRound = computed(() => {
  const map = new Map()
  for (const m of visibleMatches.value) {
    if (!filterMatch(m)) continue
    const key = `${m.stage}:${m.round_number}`
    if (!map.has(key)) map.set(key, { key, stage: m.stage, roundNumber: m.round_number, groupId: m.group_id, matches: [] })
    map.get(key).matches.push(m)
  }
  // Group rounds carry a per-group offset: order them tour by tour, A before B.
  const roundOrder = group => group.stage === 'group'
    ? roundInGroup(group.roundNumber) * 1000 + groupIndexOfRound(group.roundNumber) : group.roundNumber
  return [...map.values()]
    .sort((a, b) => (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9) || roundOrder(a) - roundOrder(b))
    .map(group => ({ ...group, matches: group.matches.sort((a, b) => a.match_number - b.match_number || a.id.localeCompare(b.id)) }))
})

const roundTotals = computed(() => knockoutTotals(props.matches))
function roundLabel(roundNumber, stage) {
  if (!roundNumber) return ''
  return matchRoundName({ stage, round_number: roundNumber }, roundTotals.value, t)
}
const groupNames = computed(() => groupNamesById(props.groups))
function roundHeading(group) {
  if (group.stage === 'grand_final') return t('scoringFlow.stage_grand_final')
  if (group.stage === 'group') return groupRoundLabel({ group_id: group.groupId, round_number: group.roundNumber }, groupNames.value, t)
  const stage = group.stage === 'winners' && props.format === 'groups_playoff' ? t('admin.playoff') : t(`scoringFlow.stage_${group.stage}`)
  return `${multipleStages.value ? `${stage} · ` : ''}${roundLabel(group.roundNumber, group.stage)}`
}

const isDoubles = computed(() => props.category === 'doubles')

function teamLabel(entryId, match) {
  if (removed(match.id)) return entryId === match.side_a_entry_id ? match.labelA : match.labelB
  if (!entryId) {
    return t(isByeMatch(match) ? 'bracket.bye' : 'bracket.tbd')
  }
  const names = entryDisplayNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}

function canScore(match) {
  return !removed(match.id) && Boolean(match.side_a_entry_id && match.side_b_entry_id)
}

function liveStatus(matchId) {
  return props.liveScoresByMatch[matchId]?.status || null
}

async function save(match) {
  const rows = setForms[match.id] || []
  rows.forEach((row) => {
    row.error = ''
  })

  if (props.disabled) {
    if (rows[0]) {
      rows[0].error = t('admin.scoresLockedError')
    }
    return
  }

  if (!canScore(match)) {
    return
  }

  if (rows.some(row => row.saving)) return
  if (liveStatus(match.id) === 'active' || stale(match)) {
    if (rows[0]) rows[0].error = t(liveStatus(match.id) === 'active' ? 'scoringFlow.liveBlocked' : 'scoringFlow.conflict')
    return
  }
  let payload
  try { payload = buildSetPayload(rows, props.scoringConfig, props.setFormat) }
  catch (error) { if (rows[0]) rows[0].error = scoringError(error.message, t); return }

  rows.forEach((row) => {
    row.saving = true
  })

  const { error, cancelled } = await saveMatchResult('update_match_sets', {
    p_match_id: match.id,
    p_sets: payload,
    p_expected_revision: drafts[match.id]?.revision,
  }, t)

  rows.forEach((row) => {
    row.saving = false
  })

  if (cancelled) return
  if (error) {
    if (rows[0]) {
      rows[0].error = scoringError(error.message, t)
    }
    emit('saved')
    return
  }

  savedFlash[match.id] = true
  setTimeout(() => {
    savedFlash[match.id] = false
  }, 2000)

  // Keep an edit baseline while the fresh server snapshot is in flight. Any
  // newly typed correction must survive that snapshot too.
  drafts[match.id] = { ...drafts[match.id], key: rowsKey(rows) }
  emit('saved')
}
</script>

<template>
  <section class="card score-editor">
    <header class="se-head">
      <div class="se-head__text">
        <h2 class="se-head__title">{{ t('scoringFlow.title') }}</h2>
        <p class="se-head__hint">{{ t('scoringFlow.hint') }}</p>
      </div>
      <div v-if="playable.length" class="se-progress">
        <span class="se-progress__label">{{ t('scoringFlow.progress', { done: playedCount, total: playable.length }) }}<template v-if="liveCount"> · {{ t('scoringFlow.progressLive', { n: liveCount }) }}</template></span>
        <span class="se-progress__bar" role="progressbar" :aria-valuenow="playedCount" aria-valuemin="0" :aria-valuemax="playable.length">
          <span class="se-progress__fill" :style="{ width: `${Math.round((playedCount / playable.length) * 100)}%` }" />
        </span>
      </div>
    </header>

    <p v-if="disabled" class="alert alert--info" role="status" style="margin: 0">{{ t('admin.scoresLockedError') }}</p>

    <div v-if="matches.length" class="se-filter" role="tablist">
      <button
        v-for="key in filterKeys"
        :key="key"
        type="button"
        role="tab"
        class="se-filter__btn"
        :class="{ 'is-active': filter === key }"
        :aria-selected="filter === key"
        @click="filter = key"
      >
        {{ filterLabel(key) }}
        <span class="se-filter__count">{{ counts[key] }}</span>
      </button>
    </div>

    <p v-if="matches.length && !matchesByRound.length" class="se-empty">{{ t('scoringFlow.filterEmpty') }}</p>

    <section v-for="group in matchesByRound" :key="group.key" class="se-round">
      <h3 class="se-round__title">
        <span>{{ roundHeading(group) }}</span>
        <span class="se-count">{{ group.matches.length }}</span>
      </h3>

      <div class="se-grid">
        <article
          v-for="match in group.matches"
          :key="match.id"
          class="score-match se-card"
          :class="[`se-card--${matchStatus(match)}`, { 'score-match--saved': savedFlash[match.id], 'se-card--compact': !canScore(match) && !removed(match.id) }]"
        >
          <header class="se-card__head">
            <span class="se-status" :class="`se-status--${matchStatus(match)}`">
              <span class="se-status__dot" aria-hidden="true" />
              {{ matchStatus(match) === 'live' ? t('live.live') : t(`scoringFlow.status${matchStatus(match).charAt(0).toUpperCase()}${matchStatus(match).slice(1)}`) }}
            </span>
            <button
              v-if="canLiveScore && match.status !== 'finished' && canScore(match)"
              class="btn btn--ghost btn--sm se-card__live"
              type="button"
              @click="emit('start-live', match)"
            >
              <span class="live-dot" aria-hidden="true" />
              {{ liveStatus(match.id) === 'active' ? t('live.openLive') : t('live.start') }}
            </button>
          </header>

          <!-- Both players still unknown: nothing to type yet. -->
          <template v-if="!canScore(match) && !removed(match.id)">
            <p class="se-card__teams-line">
              <span :class="{ 'is-tbd': !match.side_a_entry_id }">{{ teamLabel(match.side_a_entry_id, match) }}</span>
              <span class="se-card__vs">vs</span>
              <span :class="{ 'is-tbd': !match.side_b_entry_id }">{{ teamLabel(match.side_b_entry_id, match) }}</span>
            </p>
            <p class="se-card__note">{{ t('scoringFlow.pendingNote') }}</p>
          </template>

          <template v-else>
            <div v-if="removed(match.id)" class="alert alert--info" role="status">
              {{ t('drafts.matchRemoved') }}
              <button class="btn btn--ghost btn--sm" @click="reloadResult(match)">{{ t('drafts.discardLeave') }}</button>
            </div>
            <p v-else-if="liveStatus(match.id) === 'active'" class="alert alert--info" role="status">{{ t('scoringFlow.liveBlocked') }}</p>
            <div v-else-if="stale(match) || setForms[match.id]?.[0]?.error === t('scoringFlow.conflict')" class="alert alert--info" role="status">
              {{ t('scoringFlow.conflict') }}
              <button class="btn btn--ghost btn--sm" @click="reloadResult(match)">{{ t('scoringFlow.reload') }}</button>
            </div>

            <TennisSetInputs
              v-model="setForms[match.id]"
              variant="board"
              :scoring-config="scoringConfig"
              :set-format="setFormat"
              :team-a="teamLabel(match.side_a_entry_id, match)"
              :team-b="teamLabel(match.side_b_entry_id, match)"
              :id-prefix="`score-${match.id}`"
              :disabled="disabled || liveStatus(match.id) === 'active' || !canScore(match) || (setForms[match.id] || []).some(row => row.saving)"
            />

            <p v-if="(setForms[match.id] || [])[0]?.error && setForms[match.id][0].error !== t('scoringFlow.conflict')" class="error-text se-card__error" role="alert">
              {{ (setForms[match.id] || [])[0]?.error }}
            </p>

            <p
              v-if="missingWinner(match) && liveStatus(match.id) !== 'active' && !removed(match.id) && !(setForms[match.id] || [])[0]?.error"
              class="se-card__hint"
            >{{ t('scoringFlow.needWinner', { n: requiredWins }) }}</p>

            <footer class="score-match__actions se-card__foot">
              <Transition name="saved-pop">
                <span v-if="savedFlash[match.id]" class="score-saved-badge">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                  {{ t('actions.saved') }}
                </span>
              </Transition>
              <button
                class="btn btn--sm se-card__save"
                :class="match.status === 'finished' ? 'btn--outline' : 'btn--primary'"
                type="button"
                :title="t(match.status === 'finished' ? 'scoringFlow.correct' : 'scoringFlow.finish')"
                :disabled="disabled || stale(match) || liveStatus(match.id) === 'active' || !canScore(match) || missingWinner(match) || (setForms[match.id] || []).some(row => row.saving)"
                @click="save(match)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                {{ t(match.status === 'finished' ? 'scoringFlow.correctShort' : 'scoringFlow.finishShort') }}
              </button>
            </footer>
          </template>
        </article>
      </div>
    </section>

    <p v-if="!matches.length" class="muted">{{ t('bracket.empty') }}</p>
  </section>
</template>

<style scoped>
.score-editor { gap: 20px; padding: 24px; }
.se-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; }
.se-head__title { margin: 0; font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; color: var(--heading); }
.se-head__hint { margin: 4px 0 0; max-width: 64ch; color: var(--muted); font-size: 0.9375rem; line-height: 1.5; }
.se-progress { display: grid; gap: 6px; min-width: 200px; }
.se-progress__label { font-size: 0.8125rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.se-progress__bar { display: block; height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; }
.se-progress__fill { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 0.3s ease; }

.se-filter { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; justify-self: start; align-self: flex-start; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-row); }
.se-filter__btn {
  display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border: 0; border-radius: 8px;
  background: transparent; color: var(--muted); font: inherit; font-size: 0.875rem; font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.se-filter__btn:hover { color: var(--text); }
.se-filter__btn.is-active { background: var(--surface-raised); color: var(--text); box-shadow: var(--shadow-sm), 0 0 0 1px var(--border); }
.se-filter__btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.se-filter__count, .se-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
  background: var(--disabled-bg); color: var(--muted); font-size: 0.72rem; font-weight: 600; letter-spacing: 0; font-variant-numeric: tabular-nums;
}
.se-filter__btn.is-active .se-filter__count { background: var(--primary-soft); color: var(--primary); }
.se-card__hint { margin: 0; color: var(--muted); font-size: 0.8125rem; line-height: 1.45; }
.se-empty { margin: 0; padding: 24px 0; text-align: center; color: var(--muted); }

.se-round { display: grid; gap: 10px; }
.se-round__title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.se-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 12px; align-items: start; }

.se-card { display: grid; gap: 14px; padding: 14px 16px 14px; border-radius: var(--radius-sm); background: var(--surface-row); transition: background 0.25s ease, border-color 0.15s; }
.se-card:hover { border-color: var(--border-strong); }
.se-card--finished { background: var(--surface); }
.se-card--live { border-color: var(--accent); }
.se-card__head { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.se-status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8125rem; font-weight: 600; color: var(--muted); }
.se-status__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--disabled); }
.se-status--ready { color: var(--warning-text); }
.se-status--ready .se-status__dot { background: var(--warning); }
.se-status--finished { color: var(--success-text); }
.se-status--finished .se-status__dot { background: var(--success); }
.se-status--live { color: var(--accent-text); }
.se-status--live .se-status__dot { background: var(--accent); animation: livePulse 1.5s ease-in-out infinite; }
.se-card__live { margin-left: auto; min-height: 32px; height: 32px; padding: 0 10px; font-size: 0.8125rem; }
.se-card__teams-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; font-weight: 600; }
.se-card__teams-line .is-tbd { color: var(--disabled); font-weight: 500; }
.se-card__vs { font-size: 0.72rem; text-transform: uppercase; color: var(--disabled); }
.se-card__note { margin: -6px 0 0; font-size: 0.8125rem; color: var(--muted); }
.se-card--compact { gap: 10px; }
.se-card__error { margin: 0; font-size: 0.875rem; }
.se-card__foot { justify-content: flex-end; padding-top: 12px; border-top: 1px solid var(--border); }
.se-card__save { min-width: 160px; }

.score-match__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
@media (max-width: 560px) {
  .score-editor { padding: 16px; }
  .se-progress { min-width: 0; width: 100%; }
  .se-card__save { flex: 1 1 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .se-progress__fill, .se-card { transition: none; }
  .se-status--live .se-status__dot { animation: none; }
}

.score-saved-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--success-text);
  background: var(--success-bg);
  border-radius: 999px;
}

.saved-pop-enter-active,
.saved-pop-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.saved-pop-enter-from,
.saved-pop-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
</style>
