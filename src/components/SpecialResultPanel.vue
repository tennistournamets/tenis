<script setup>
// W.O. (no-show) or RET (retired during the match) for one unfinished match:
// record_special_result writes the full result by the set rules, so the
// bracket and tables treat it like any finished match.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { matchSideLabel } from '../lib/entryDisplay'
import { errorMessage } from '../lib/errorMessages'
import { buildSetPayload, scoringError } from '../lib/tennisRules'
import { supabase } from '../lib/supabase'

const props = defineProps({
  match: { type: Object, required: true },
  entriesMap: { type: Object, default: () => ({}) },
  // 'sets' or 'goals'; points formats have no walkovers.
  family: { type: String, default: 'sets' },
  // Typed set rows of the score form: for RET, the score played so far.
  setRows: { type: Array, default: () => [] },
  scoringConfig: { type: Object, default: () => ({}) },
  setFormat: { type: String, default: 'best_of_3' },
  revision: { type: Number, default: null },
  disabled: Boolean,
  // { a, b } names when the caller has no entries map (live scoring).
  sideNames: { type: Object, default: null },
  // The live scoring window offers RET only.
  types: { type: Array, default: () => ['walkover', 'retired'] },
})
const emit = defineEmits(['saved'])
const { t } = useI18n()

const open = ref(false)
const type = ref(props.types[0])
const absent = ref(null)
const saving = ref(false)
const errorText = ref('')

const sideLabel = side => props.sideNames?.[side] || matchSideLabel(props.match, side, props.entriesMap, t('bracket.tbd'))
const winnerSide = computed(() => (absent.value === 'a' ? 'b' : absent.value === 'b' ? 'a' : null))
const typeChoices = computed(() => props.types.filter(value => value === 'walkover' || props.family === 'sets'))
const hint = computed(() => {
  if (type.value === 'retired') return t('walkover.retiredHint')
  return t(props.family === 'goals' ? 'walkover.walkoverHintGoals' : 'walkover.walkoverHint')
})
const idPrefix = computed(() => `special-${props.match.id}`)

async function submit() {
  if (saving.value || props.disabled || !winnerSide.value) return
  errorText.value = ''
  let sets = null
  if (type.value === 'retired') {
    try {
      const typed = buildSetPayload(props.setRows, props.scoringConfig, props.setFormat)
      sets = typed.length ? typed : null
    } catch (error) {
      errorText.value = scoringError(error.message, t)
      return
    }
  }
  saving.value = true
  try {
    const { error } = await supabase.rpc('record_special_result', {
      p_match_id: props.match.id,
      p_type: type.value,
      p_winner_entry_id: props.match[`side_${winnerSide.value}_entry_id`],
      p_sets: sets,
      p_expected_revision: props.revision,
    })
    if (error) throw error
    open.value = false
    emit('saved')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="special-result">
    <button
      class="btn btn--ghost btn--sm special-result__toggle"
      type="button"
      :aria-expanded="open"
      :aria-controls="`${idPrefix}-panel`"
      :disabled="disabled"
      @click="open = !open"
    >
      {{ typeChoices.length === 1 && typeChoices[0] === 'retired' ? t('walkover.retired') : t('walkover.open') }}
    </button>
    <div v-if="open" :id="`${idPrefix}-panel`" class="special-result__panel">
      <fieldset v-if="typeChoices.length > 1" class="special-result__group" :disabled="saving">
        <legend>{{ t('walkover.typeLabel') }}</legend>
        <label v-for="value in typeChoices" :key="value" class="checkbox-row">
          <input v-model="type" type="radio" :name="`${idPrefix}-type`" :value="value" />
          {{ t(`walkover.${value}`) }}
        </label>
      </fieldset>
      <fieldset class="special-result__group" :disabled="saving">
        <legend>{{ t('walkover.whoLabel') }}</legend>
        <label v-for="side in ['a', 'b']" :key="side" class="checkbox-row">
          <input v-model="absent" type="radio" :name="`${idPrefix}-who`" :value="side" />
          {{ sideLabel(side) }}
        </label>
      </fieldset>
      <p class="muted special-result__hint">{{ hint }}</p>
      <div>
        <button class="btn btn--primary btn--sm" type="button" :disabled="saving || disabled || !winnerSide" @click="submit">
          <span v-if="saving" class="spinner" aria-hidden="true" />
          {{ winnerSide ? t('walkover.confirm', { name: sideLabel(winnerSide) }) : t('walkover.whoLabel') }}
        </button>
      </div>
      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
    </div>
  </div>
</template>

<style scoped>
.special-result { display: grid; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.special-result__toggle { justify-self: start; }
.special-result__panel { display: grid; gap: var(--space-3); }
.special-result__group { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: 6px; }
.special-result__group legend { padding: 0; margin-bottom: 4px; font-weight: 600; font-size: 0.875rem; }
.special-result__group .checkbox-row { overflow-wrap: anywhere; }
.special-result__hint { margin: 0; font-size: var(--font-sm); line-height: 1.45; }
</style>
