<script setup>
// Single-match final score entry, opened from the round-robin crosstable/accordion.
// Form logic and RPC payloads mirror ScoreEditor.vue (sets) and
// FootballScoreEditor.vue (goals) — keep the three in sync on scoring changes.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'

import { entryMemberNames } from '../lib/entryDisplay'
import { supabase } from '../lib/supabase'
import { useUnsavedChanges, confirmDiscard } from '../lib/unsavedChanges'
import { sameForm, cloneForm } from '../lib/formDraft'
import { saveMatchResult } from '../lib/saveMatchResult'
import { confirmDialog } from '../lib/confirmDialog'
import TennisSetInputs from './TennisSetInputs.vue'
import { scoreRows, buildSetPayload, scoringError } from '../lib/tennisRules'

const props = defineProps({
  scoringConfig: { type: Object, default: () => ({}) },
  match: { type: Object, required: true },
  exists: { type: Boolean, default: true },
  entriesMap: { type: Object, default: () => ({}) },
  family: { type: String, default: 'sets' },
  setFormat: { type: String, default: 'best_of_3' },
  sets: { type: Array, default: () => [] },
  canEditFinal: { type: Boolean, default: false },
  canLiveScore: { type: Boolean, default: false },
  liveStatus: { type: String, default: null },
})

const emit = defineEmits(['close', 'saved', 'start-live'])

const { t } = useI18n()

const saving = ref(false)
const savedFlash = ref(false)
const errorText = ref('')

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}

// --- sets form ---
const setRows = ref(scoreRows(props.sets, props.setFormat))
const baseRevision = ref(props.match.score_revision)
const conflict = computed(() => baseRevision.value !== props.match.score_revision)
const manualBlocked = computed(() => !props.exists || props.liveStatus === 'active')

// --- goals form ---
const goals = ref({
  a: props.match.side_a_score ?? '',
  b: props.match.side_b_score ?? '',
  pa: props.match.side_a_pens ?? '',
  pb: props.match.side_b_pens ?? '',
})

const initialInput = ref({ sets: cloneForm(setRows.value), goals: cloneForm(goals.value) })
const dirty = computed(() => !savedFlash.value && !sameForm({ sets: setRows.value, goals: goals.value }, initialInput.value))
useUnsavedChanges(() => dirty.value, () => saving.value)
async function close() {
  if (await confirmDiscard(t, dirty.value, saving.value)) emit('close')
}
async function startLive() {
  if (await confirmDiscard(t, dirty.value, saving.value)) emit('start-live', props.match)
}

const isSets = computed(() => props.family === 'sets')

async function reloadResult() {
  if (saving.value) return
  if (!(await confirmDialog(t('scoringFlow.reloadConfirm')))) return
  saving.value = true
  try {
    const { data, error } = await supabase.rpc('get_tournament_score_state', { p_tournament_id: props.match.tournament_id })
    if (error) { errorText.value = t('scoringFlow.unavailable'); return }
    const m = data.matches.find(m => m.id === props.match.id)
    if (!m) { emit('close'); return }
    setRows.value = scoreRows(data.sets.filter(s => s.match_id === m.id), props.setFormat)
    goals.value = { a:m.side_a_score ?? '', b:m.side_b_score ?? '', pa:m.side_a_pens ?? '', pb:m.side_b_pens ?? '' }
    initialInput.value = { sets: cloneForm(setRows.value), goals: cloneForm(goals.value) }
    baseRevision.value = m.score_revision
    errorText.value = ''
    emit('saved')
  } finally { saving.value = false }
}
async function save() {
  if (!props.canEditFinal || saving.value) return
  errorText.value = ''
  if (manualBlocked.value || conflict.value) { errorText.value = t(manualBlocked.value ? 'scoringFlow.liveBlocked' : 'scoringFlow.conflict'); return }
  let rpcName, rpcPayload

  if (isSets.value) {
    let payload
    try { payload = buildSetPayload(setRows.value, props.scoringConfig, props.setFormat) }
    catch (error) { errorText.value = scoringError(error.message, t); return }
    rpcName = 'update_match_sets'
    rpcPayload = { p_match_id: props.match.id, p_sets: payload, p_expected_revision: baseRevision.value }
  } else {
    if (goals.value.a === '' || goals.value.b === '') { errorText.value=t('scoringFlow.finalRequired'); return }
    const a = Number(goals.value.a)
    const b = Number(goals.value.b)
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      errorText.value = t('football.goals')
      return
    }
    rpcName = 'update_football_result'
    rpcPayload = {
      p_match_id: props.match.id,
      p_expected_revision: baseRevision.value,
      p_a_goals: a,
      p_b_goals: b,
      p_a_pens: goals.value.pa === '' || goals.value.pa == null ? null : Number(goals.value.pa),
      p_b_pens: goals.value.pb === '' || goals.value.pb == null ? null : Number(goals.value.pb),
    }
  }

  saving.value = true
  const { error, cancelled } = await saveMatchResult(rpcName, rpcPayload, t)
  saving.value = false

  if (cancelled) return
  if (error) {
    errorText.value = scoringError(error.message, t)
    emit('saved')
    return
  }

  savedFlash.value = true
  emit('saved')
  setTimeout(() => emit('close'), 600)
}
</script>

<template>
  <AppModal :label="t('standings.matchScore')" @close="close">
    <div class="modal-dialog">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('standings.matchScore') }}</h2>
          <p class="muted">{{ teamLabel(match.side_a_entry_id) }} vs {{ teamLabel(match.side_b_entry_id) }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </div>

      <p v-if="!canEditFinal" class="alert alert--info" role="status">{{ t('admin.scoresLockedError') }}</p>

      <p v-if="!exists" class="alert alert--info" role="status">{{ t('drafts.matchRemoved') }}</p>
      <p v-else-if="manualBlocked" class="alert alert--info" role="status">{{ t('scoringFlow.liveBlocked') }}</p>
      <div v-else-if="conflict || errorText === t('scoringFlow.conflict')" class="alert alert--info" role="status">
        {{ t('scoringFlow.conflict') }}
        <button class="btn btn--ghost btn--sm" @click="reloadResult">{{ t('scoringFlow.reload') }}</button>
      </div>
      <p v-else class="muted">{{ t('scoringFlow.hint') }}</p>
      <!-- sets sports -->
      <TennisSetInputs v-if="isSets" v-model="setRows" :scoring-config="scoringConfig" :set-format="setFormat"
        :team-a="teamLabel(match.side_a_entry_id)" :team-b="teamLabel(match.side_b_entry_id)"
        :id-prefix="`modal-${match.id}`" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" />

      <!-- goals sports -->
      <div v-else class="stack stack--sm">
        <div class="msm-goals">
          <span class="msm-grid__name">{{ teamLabel(match.side_a_entry_id) }}</span>
          <input v-model="goals.a" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="t('football.goals')" />
          <span class="muted">:</span>
          <input v-model="goals.b" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="t('football.goals')" />
          <span class="msm-grid__name msm-goals__right">{{ teamLabel(match.side_b_entry_id) }}</span>
        </div>
        <div class="msm-goals">
          <span class="msm-goals__pens-label muted">{{ t('football.pens') }}</span>
          <input v-model="goals.pa" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="t('football.pens')" />
          <span class="muted">:</span>
          <input v-model="goals.pb" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="t('football.pens')" />
          <span class="msm-goals__right"></span>
        </div>
        <p class="muted" style="font-size: var(--font-sm)">{{ t('football.penHint') }}</p>
      </div>

      <div class="msm-actions">
        <button class="btn btn--primary btn--sm" type="button" :disabled="!canEditFinal || manualBlocked || conflict || saving || savedFlash" @click="save">
          {{ t(match.status === 'finished' ? 'scoringFlow.correct' : 'scoringFlow.finish') }}
        </button>
        <button
          v-if="canLiveScore && match.status !== 'finished'"
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="saving || savedFlash || !exists"
          @click="startLive"
        >
          {{ liveStatus === 'active' ? t('live.openLive') : t('live.start') }}
        </button>
        <span v-if="liveStatus === 'active'" class="badge badge--warn">
          <span class="live-dot"></span>
          {{ t('live.live') }}
        </span>
        <Transition name="saved-pop">
          <span v-if="savedFlash" class="score-saved-badge">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            {{ t('actions.saved') }}
          </span>
        </Transition>
      </div>

      <p v-if="errorText" class="error-text">{{ errorText }}</p>
    </div>
  </AppModal>
</template>

<style scoped>
.msm-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.msm-grid__row {
  display: grid;
  grid-template-columns: 1fr repeat(var(--set-columns), 52px);
  gap: 8px;
  align-items: center;
}
.msm-grid__row--head {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
}
.msm-grid__set {
  text-align: center;
}
.msm-grid__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.msm-grid__input {
  width: 52px;
  text-align: center;
}
.msm-goals {
  display: flex;
  align-items: center;
  gap: 8px;
}
.msm-goals__right {
  flex: 1;
  text-align: right;
}
.msm-goals__pens-label {
  font-size: var(--font-sm);
  min-width: 0;
}
.msm-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
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
