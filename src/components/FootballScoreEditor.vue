<script setup>
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { scoringError } from '../lib/tennisRules'
import { confirmDialog } from '../lib/confirmDialog'
import { supabase } from '../lib/supabase'
import { useUnsavedChanges } from '../lib/unsavedChanges'
import { sameForm } from '../lib/formDraft'
import { saveMatchResult } from '../lib/saveMatchResult'

const props = defineProps({
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['saved'])
const { t } = useI18n()

const savingId = ref('')
const errorText = ref('')
const savedFlash = reactive({})
// local per-match input state, keyed by match id
const draft = reactive({})
const original = reactive({})
const draftMatches = reactive({})
const removed = id => !props.matches.some(m => m.id === id)
useUnsavedChanges(() => Object.keys(draft).some(id => !sameForm(draft[id], original[id])), () => Boolean(savingId.value))

// Matches with both sides assigned, ordered by round then match.
const scorable = computed(() =>
  [...props.matches, ...Object.values(draftMatches).filter(m => removed(m.id) && !sameForm(draft[m.id], original[m.id]))]
    .filter((m) => m.side_a_entry_id && m.side_b_entry_id)
    .sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number),
)

function fieldsFor(m) {
  if (draft[m.id] && savingId.value !== m.id && sameForm(draft[m.id], original[m.id]) && draft[m.id].revision < m.score_revision) {
    delete draft[m.id]; delete original[m.id]
  }
  if (!draft[m.id]) {
    draftMatches[m.id] = { ...m, labelA: name(m.side_a_entry_id), labelB: name(m.side_b_entry_id) }
    draft[m.id] = {
      revision: m.score_revision,
      a: m.side_a_score ?? '',
      b: m.side_b_score ?? '',
      pa: m.side_a_pens ?? '',
      pb: m.side_b_pens ?? '',
    }
  }
  if (!original[m.id]) original[m.id] = { ...draft[m.id] }
  return draft[m.id]
}

function name(id) {
  return props.entriesMap[id]?.display_name || '—'
}

async function reloadResult(m) {
  if (savingId.value) return
  if (!(await confirmDialog(t('scoringFlow.reloadConfirm')))) return
  savingId.value = m.id
  try {
    const { data, error } = await supabase.rpc('get_tournament_score_state', { p_tournament_id: m.tournament_id })
    if (error) { errorText.value=t('scoringFlow.unavailable'); return }
    const latest=data.matches.find(row=>row.id===m.id)
    delete draft[m.id]
    delete original[m.id]
    if(latest) fieldsFor(latest)
    errorText.value=''
    emit('saved')
  } finally { savingId.value = '' }
}
async function save(m) {
  if (props.disabled || savingId.value || removed(m.id)) return
  const f = fieldsFor(m)
  if (f.revision !== m.score_revision) { errorText.value=t('scoringFlow.conflict'); return }
  if (f.a === '' || f.b === '') { errorText.value=t('scoringFlow.finalRequired'); return }
  const a = Number(f.a)
  const b = Number(f.b)
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    errorText.value = t('football.goals')
    return
  }
  savingId.value = m.id
  errorText.value = ''
  const payload = {
    p_match_id: m.id,
    p_expected_revision: f.revision,
    p_a_goals: a,
    p_b_goals: b,
    p_a_pens: f.pa === '' ? null : Number(f.pa),
    p_b_pens: f.pb === '' ? null : Number(f.pb),
  }
  const { error, cancelled } = await saveMatchResult('update_football_result', payload, t)
  savingId.value = ''
  if (cancelled) return
  if (error) {
    errorText.value = scoringError(error.message,t)
    emit('saved')
    return
  }
  savedFlash[m.id] = true
  setTimeout(() => {
    savedFlash[m.id] = false
  }, 2000)
  original[m.id] = { ...draft[m.id] }
  emit('saved')
}
</script>

<template>
  <div class="stack stack--sm">
    <p class="muted" style="font-size: var(--font-sm)">{{ t('football.penHint') }}</p>
    <p v-if="!scorable.length" class="muted">{{ t('football.noMatches') }}</p>

    <div
      v-for="m in scorable"
      :key="m.id"
      class="fb-row card"
    >
      <div v-if="removed(m.id)" class="alert alert--info">
        {{ t('drafts.matchRemoved') }}
        <button class="btn btn--ghost btn--sm" @click="reloadResult(m)">{{ t('drafts.discardLeave') }}</button>
      </div>
      <div v-else-if="fieldsFor(m).revision !== m.score_revision" class="alert alert--info">
        {{ t('scoringFlow.conflict') }}
        <button class="btn btn--ghost btn--sm" @click="reloadResult(m)">{{ t('scoringFlow.reload') }}</button>
      </div>
      <span class="fb-row__team">{{ removed(m.id) ? m.labelA : name(m.side_a_entry_id) }}</span>
      <div class="fb-row__inputs">
        <input
          v-model="fieldsFor(m).a"
          class="input fb-input"
          type="number"
          min="0"
          :disabled="disabled || removed(m.id) || savingId === m.id"
          :aria-label="t('football.goals')"
        />
        <span class="fb-colon">:</span>
        <input
          v-model="fieldsFor(m).b"
          class="input fb-input"
          type="number"
          min="0"
          :disabled="disabled || removed(m.id) || savingId === m.id"
          :aria-label="t('football.goals')"
        />
      </div>
      <span class="fb-row__team fb-row__team--right">{{ removed(m.id) ? m.labelB : name(m.side_b_entry_id) }}</span>

      <div class="fb-row__pens">
        <label class="fb-pen-label">{{ t('football.pens') }}</label>
        <input
          v-model="fieldsFor(m).pa"
          class="input fb-input fb-input--pen"
          type="number"
          min="0"
          :disabled="disabled || removed(m.id) || savingId === m.id"
        />
        <span class="fb-colon">:</span>
        <input
          v-model="fieldsFor(m).pb"
          class="input fb-input fb-input--pen"
          type="number"
          min="0"
          :disabled="disabled || removed(m.id) || savingId === m.id"
        />
      </div>

      <button
        class="btn btn--primary btn--sm fb-row__save"
        type="button"
        :disabled="disabled || removed(m.id) || savingId === m.id || fieldsFor(m).revision !== m.score_revision"
        @click="save(m)"
      >
        {{ t(m.status === 'finished' ? 'scoringFlow.correct' : 'scoringFlow.finish') }}
      </button>
      <Transition name="saved-pop">
        <span v-if="savedFlash[m.id]" class="score-saved-badge">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
          {{ t('actions.saved') }}
        </span>
      </Transition>
    </div>

    <p v-if="errorText" class="error-text">{{ errorText }}</p>
  </div>
</template>

<style scoped>
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

.fb-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 12px;
}
.fb-row__team {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.fb-row__team--right {
  text-align: right;
}
.fb-row__inputs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.fb-input {
  width: 3.5rem;
  text-align: center;
}
.fb-input--pen {
  width: 3rem;
}
.fb-colon {
  font-weight: 700;
}
.fb-row__pens {
  display: flex;
  align-items: center;
  gap: 6px;
  grid-column: 1 / -1;
  color: var(--text-muted, #6b7280);
  font-size: var(--font-sm, 0.85rem);
}
.fb-pen-label {
  margin-right: 4px;
}
.fb-row__save {
  grid-column: 1 / -1;
  justify-self: start;
}
</style>
