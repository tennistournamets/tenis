<script setup>
// Single-match final score entry, opened from the round-robin crosstable/accordion.
// Form logic and RPC payloads mirror ScoreEditor.vue (sets) and
// FootballScoreEditor.vue (goals) — keep the three in sync on scoring changes.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'

import { entryMemberNames } from '../lib/entryDisplay'
import { supabase } from '../lib/supabase'
import { useUnsavedChanges, confirmDiscard } from '../lib/unsavedChanges'
import { sameForm, cloneForm } from '../lib/formDraft'
import { clearSessionDraft, readSessionDraft, writeSessionDraft } from '../lib/sessionDraft'
import { saveMatchResult } from '../lib/saveMatchResult'
import { confirmDialog } from '../lib/confirmDialog'
import { useAuthStore } from '../stores/auth'
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
const auth = useAuthStore()

const saving = ref(false)
const savedFlash = ref(false)
const errorText = ref('')
const draftRestored = ref(false)
const draftOwnerId = auth.user?.id || ''
const draftKey = draftOwnerId
  ? `bracketa:match-score:${draftOwnerId}:${props.match.tournament_id || 'tournament'}:${props.match.id}`
  : ''
const draftEnabled = ref(Boolean(draftKey))
const isDraftSessionCurrent = () => draftEnabled.value && auth.user?.id === draftOwnerId

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}

function goalLabel(metric, side) {
  return t('a11y.scoreField', { metric: t(`football.${metric}`), team: teamLabel(props.match[`side_${side}_entry_id`]), side: side.toUpperCase() })
}

// --- sets form ---
const serverInput = {
  sets: scoreRows(props.sets, props.setFormat),
  goals: {
    a: props.match.side_a_score ?? '',
    b: props.match.side_b_score ?? '',
    pa: props.match.side_a_pens ?? '',
    pb: props.match.side_b_pens ?? '',
  },
}
const setRows = ref(cloneForm(serverInput.sets))
const baseRevision = ref(props.match.score_revision)
const conflict = computed(() => baseRevision.value !== props.match.score_revision)
const manualBlocked = computed(() => !props.exists || props.liveStatus === 'active')

// --- goals form ---
const goals = ref(cloneForm(serverInput.goals))

const initialInput = ref(cloneForm(serverInput))
const storedDraft = readSessionDraft(draftKey)
if (
  storedDraft?.revision === props.match.score_revision
  && storedDraft.family === props.family
  && storedDraft.setFormat === props.setFormat
  && Array.isArray(storedDraft.input?.sets)
  && storedDraft.input?.goals
) {
  setRows.value = scoreRows(storedDraft.input.sets, props.setFormat)
  goals.value = { ...serverInput.goals, ...cloneForm(storedDraft.input.goals) }
  draftRestored.value = !sameForm({ sets: setRows.value, goals: goals.value }, initialInput.value)
} else if (storedDraft) {
  clearSessionDraft(draftKey)
}
const dirty = computed(() => !savedFlash.value && !sameForm({ sets: setRows.value, goals: goals.value }, initialInput.value))
function clearScoreDraft() {
  if (draftEnabled.value) clearSessionDraft(draftKey)
  draftRestored.value = false
}
useUnsavedChanges(() => dirty.value, () => saving.value, clearScoreDraft)
watch([setRows, goals], () => {
  if (!draftEnabled.value) return
  if (savedFlash.value || !dirty.value) {
    clearScoreDraft()
    return
  }
  writeSessionDraft(draftKey, {
    revision: baseRevision.value,
    family: props.family,
    setFormat: props.setFormat,
    input: { sets: cloneForm(setRows.value), goals: cloneForm(goals.value) },
  })
}, { deep: true })
watch(() => auth.user?.id, (userId) => {
  if (userId === draftOwnerId) return
  // Never carry an operator's visible input or storage key into a new session.
  draftEnabled.value = false
  setRows.value = cloneForm(initialInput.value.sets)
  goals.value = cloneForm(initialInput.value.goals)
  draftRestored.value = false
  errorText.value = ''
  emit('close')
})
async function close() {
  if (!(await confirmDiscard(t, dirty.value, saving.value))) return
  if (!isDraftSessionCurrent()) return
  clearScoreDraft()
  emit('close')
}
async function startLive() {
  if (!(await confirmDiscard(t, dirty.value, saving.value))) return
  if (!isDraftSessionCurrent()) return
  clearScoreDraft()
  emit('start-live', props.match)
}
function discardStoredDraft() {
  setRows.value = cloneForm(initialInput.value.sets)
  goals.value = cloneForm(initialInput.value.goals)
  clearScoreDraft()
}

const isSets = computed(() => props.family === 'sets')

async function reloadResult() {
  if (saving.value || !isDraftSessionCurrent()) return
  if (!(await confirmDialog(t('scoringFlow.reloadConfirm')))) return
  if (!isDraftSessionCurrent()) return
  saving.value = true
  try {
    const { data, error } = await supabase.rpc('get_tournament_score_state', { p_tournament_id: props.match.tournament_id })
    if (!isDraftSessionCurrent()) return
    if (error) { errorText.value = t('scoringFlow.unavailable'); return }
    const m = data.matches.find(m => m.id === props.match.id)
    if (!m) { clearScoreDraft(); emit('close'); return }
    setRows.value = scoreRows(data.sets.filter(s => s.match_id === m.id), props.setFormat)
    goals.value = { a:m.side_a_score ?? '', b:m.side_b_score ?? '', pa:m.side_a_pens ?? '', pb:m.side_b_pens ?? '' }
    initialInput.value = { sets: cloneForm(setRows.value), goals: cloneForm(goals.value) }
    baseRevision.value = m.score_revision
    errorText.value = ''
    clearScoreDraft()
    emit('saved')
  } catch {
    errorText.value = t('scoringFlow.unavailable')
  } finally { saving.value = false }
}
async function save() {
  if (!props.canEditFinal || saving.value || !isDraftSessionCurrent()) return
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
  let result
  try {
    result = await saveMatchResult(rpcName, rpcPayload, t, { isCurrent: isDraftSessionCurrent })
  } catch (error) {
    result = { error }
  } finally {
    saving.value = false
  }
  const { error, cancelled } = result || {}
  if (!isDraftSessionCurrent()) return

  if (cancelled) return
  if (error) {
    errorText.value = scoringError(error.message, t)
    emit('saved')
    return
  }

  savedFlash.value = true
  clearScoreDraft()
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
          <p class="muted msm-matchup">{{ teamLabel(match.side_a_entry_id) }} vs {{ teamLabel(match.side_b_entry_id) }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </div>

      <p v-if="!canEditFinal" class="alert alert--info" role="status">{{ t('admin.scoresLockedError') }}</p>

      <div v-if="draftRestored" class="alert alert--info msm-restored" role="status">
        <span>{{ t('drafts.restored') }}</span>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="saving" @click="discardStoredDraft">{{ t('drafts.discardStored') }}</button>
      </div>

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
          <input v-model="goals.a" class="input msm-grid__input" type="number" inputmode="numeric" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="goalLabel('goals', 'a')" />
          <span class="muted">:</span>
          <input v-model="goals.b" class="input msm-grid__input" type="number" inputmode="numeric" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="goalLabel('goals', 'b')" />
          <span class="msm-grid__name msm-goals__right">{{ teamLabel(match.side_b_entry_id) }}</span>
        </div>
        <div class="msm-goals">
          <span class="msm-goals__pens-label muted">{{ t('football.pens') }}</span>
          <input v-model="goals.pa" class="input msm-grid__input" type="number" inputmode="numeric" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="goalLabel('pens', 'a')" />
          <span class="muted">:</span>
          <input v-model="goals.pb" class="input msm-grid__input" type="number" inputmode="numeric" min="0" :disabled="!canEditFinal || manualBlocked || saving || savedFlash" :aria-label="goalLabel('pens', 'b')" />
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

      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
    </div>
  </AppModal>
</template>

<style scoped>
.msm-matchup {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
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
.msm-restored {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
