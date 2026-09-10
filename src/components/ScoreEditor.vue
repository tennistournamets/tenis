<script setup>
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { entryMemberNames } from '../lib/entryDisplay'
import { isByeMatch } from '../lib/bracketDisplay'
import { supabase } from '../lib/supabase'
import { useUnsavedChanges } from '../lib/unsavedChanges'
import { saveMatchResult } from '../lib/saveMatchResult'
import { confirmDialog } from '../lib/confirmDialog'
import TennisSetInputs from './TennisSetInputs.vue'
import { scoreRows, buildSetPayload, scoringError } from '../lib/tennisRules'

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

const stageOrder = { main: 0, group: 1, winners: 2, losers: 3, grand_final: 4 }
const multipleStages = computed(() => new Set(props.matches.map(m => m.stage)).size > 1)
const matchesByRound = computed(() => {
  const map = new Map()
  for (const m of visibleMatches.value) {
    const key = `${m.stage}:${m.round_number}`
    if (!map.has(key)) map.set(key, { key, stage: m.stage, roundNumber: m.round_number, matches: [] })
    map.get(key).matches.push(m)
  }
  return [...map.values()]
    .sort((a, b) => (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9) || a.roundNumber - b.roundNumber)
    .map(group => ({ ...group, matches: group.matches.sort((a, b) => a.match_number - b.match_number || a.id.localeCompare(b.id)) }))
})

function roundLabel(roundNumber, stage) {
  const n = Math.max(0, ...props.matches.filter(m => m.stage === stage).map(m => m.round_number))
  if (n === 0) return ''
  if (roundNumber === n) return t('bracket.final')
  if (roundNumber === n - 1) return t('bracket.semifinals')
  if (roundNumber === n - 2) return t('bracket.quarterfinals')
  return t('bracket.roundN', { n: roundNumber })
}

const isDoubles = computed(() => props.category === 'doubles')

function teamLabel(entryId, match) {
  if (removed(match.id)) return entryId === match.side_a_entry_id ? match.labelA : match.labelB
  if (!entryId) {
    return t(isByeMatch(match) ? 'bracket.bye' : 'bracket.tbd')
  }
  const names = entryMemberNames(props.entriesMap[entryId])
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
    <h2 class="section-title">{{ t('admin.saveScore') }}</h2>
    <p class="muted">{{ t('scoringFlow.hint') }}</p>
    <p v-if="disabled" class="alert alert--info" role="status">{{ t('admin.scoresLockedError') }}</p>

    <template v-for="group in matchesByRound" :key="group.key">
      <h3 class="section-title" style="font-size: 1rem; margin-top: var(--space-3)">
        {{ group.stage === 'grand_final' ? t('scoringFlow.stage_grand_final') : `${multipleStages ? `${t(`scoringFlow.stage_${group.stage}`)} · ` : ''}${roundLabel(group.roundNumber, group.stage)}` }}
      </h3>

      <article
        v-for="match in group.matches"
        :key="match.id"
        class="score-match"
        :class="{ 'score-match--saved': savedFlash[match.id], 'score-match--pending': !canScore(match) }"
      >
        <div class="score-match__head" :class="{ 'score-match__head--doubles': isDoubles }">
          <div class="score-match__teams">
            <div class="score-match__team">
              <span class="score-match__player">{{ teamLabel(match.side_a_entry_id, match) }}</span>
            </div>
            <span class="score-match__vs muted">vs</span>
            <div class="score-match__team">
              <span class="score-match__player">{{ teamLabel(match.side_b_entry_id, match) }}</span>
            </div>
          </div>
        </div>

        <div v-if="removed(match.id)" class="alert alert--info" role="status">
          {{ t('drafts.matchRemoved') }}
          <button class="btn btn--ghost btn--sm" @click="reloadResult(match)">{{ t('drafts.discardLeave') }}</button>
        </div>
        <p v-else-if="liveStatus(match.id) === 'active'" class="alert alert--info" role="status">{{ t('scoringFlow.liveBlocked') }}</p>
        <div v-else-if="stale(match) || setForms[match.id]?.[0]?.error === t('scoringFlow.conflict')" class="alert alert--info" role="status">
          {{ t('scoringFlow.conflict') }}
          <button class="btn btn--ghost btn--sm" @click="reloadResult(match)">{{ t('scoringFlow.reload') }}</button>
        </div>
        <TennisSetInputs v-model="setForms[match.id]" :scoring-config="scoringConfig" :set-format="setFormat"
          :team-a="teamLabel(match.side_a_entry_id, match)" :team-b="teamLabel(match.side_b_entry_id, match)"
          :id-prefix="`score-${match.id}`" :disabled="disabled || liveStatus(match.id) === 'active' || !canScore(match) || (setForms[match.id] || []).some(row => row.saving)" />

        <div class="score-match__actions">
          <button class="btn btn--primary btn--sm" type="button" :disabled="disabled || stale(match) || liveStatus(match.id) === 'active' || !canScore(match) || (setForms[match.id] || []).some(row => row.saving)" @click="save(match)">
            {{ t(match.status === 'finished' ? 'scoringFlow.correct' : 'scoringFlow.finish') }}
          </button>
          <Transition name="saved-pop">
            <span v-if="savedFlash[match.id]" class="score-saved-badge">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              {{ t('actions.saved') }}
            </span>
          </Transition>
          <button
            v-if="canLiveScore && match.status !== 'finished'"
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="!canScore(match)"
            @click="emit('start-live', match)"
          >
            {{ liveStatus(match.id) === 'active' ? t('live.openLive') : t('live.start') }}
          </button>
          <span v-if="liveStatus(match.id) === 'active'" class="badge badge--warn">
            <span class="live-dot"></span>
            {{ t('live.live') }}
          </span>
        </div>

        <p v-if="(setForms[match.id] || [])[0]?.error && setForms[match.id][0].error !== t('scoringFlow.conflict')" class="error-text" style="margin-top: var(--space-2)">
          {{ (setForms[match.id] || [])[0]?.error }}
        </p>
      </article>
    </template>

    <p v-if="!matches.length" class="muted">{{ t('bracket.empty') }}</p>
  </section>
</template>

<style scoped>
.score-match__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
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
