<script setup>
import { useI18n } from 'vue-i18n'
import { ruleForSet } from '../lib/tennisRules'
const props = defineProps({
  modelValue: { type: Array, required: true }, scoringConfig: { type: Object, default: () => ({}) },
  setFormat: { type: String, default: 'best_of_3' }, teamA: String, teamB: String, disabled: Boolean,
  idPrefix: { type: String, required: true },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const rule = row => ruleForSet(props.scoringConfig, row.set_index, props.setFormat)
const matchTb = row => rule(row).kind === 'match_tiebreak'
const tbVisible = row => {
  const at = rule(row).at
  return !matchTb(row) && (row.side_a_tiebreak !== '' || row.side_b_tiebreak !== '' ||
    (at !== null && row.side_a_games !== '' && row.side_b_games !== '' &&
      Number(row.side_a_games) >= at && Number(row.side_b_games) >= at))
}
function change(row, key, value) {
  emit('update:modelValue', props.modelValue.map(r => r.set_index === row.set_index ? { ...r, [key]: value } : r))
}
const label = (row, side, tb = false) => `${t('live.setN', { n: row.set_index })}, ${side === 'a' ? props.teamA : props.teamB}, ${t(tb || matchTb(row) ? 'tennisRules.tiebreakPoints' : 'tennisRules.games')}`
</script>

<template>
  <div class="tennis-set-inputs">
    <fieldset v-for="row in modelValue" :key="row.set_index" class="tennis-set" :disabled="disabled">
      <legend>{{ matchTb(row) ? t('tennisRules.matchTiebreak') : t('live.setN', { n: row.set_index }) }}</legend>
      <p class="tennis-set__hint muted">{{ matchTb(row) ? t('tennisRules.pointsTo', { to: rule(row).target }) : t('tennisRules.games') }}</p>
      <div v-for="side in ['a', 'b']" :key="side" class="tennis-set__row">
        <label :for="`${idPrefix}-${row.set_index}-${side}`">{{ side === 'a' ? teamA : teamB }}</label>
        <input :id="`${idPrefix}-${row.set_index}-${side}`" class="input" type="number" min="0" step="1" inputmode="numeric"
          :max="matchTb(row) || rule(row).at === null ? undefined : rule(row).at + 1"
          :aria-label="label(row, side)" placeholder="—"
          :value="row[`side_${side}_${matchTb(row) ? 'tiebreak' : 'games'}`]"
          @input="change(row, `side_${side}_${matchTb(row) ? 'tiebreak' : 'games'}`, $event.target.value)" />
      </div>
      <template v-if="tbVisible(row)">
        <p class="tennis-set__hint muted">{{ t('tennisRules.tbOptional', { to: rule(row).target }) }}</p>
        <div v-for="side in ['a', 'b']" :key="`tb-${side}`" class="tennis-set__row">
          <label :for="`${idPrefix}-${row.set_index}-tb-${side}`">{{ side === 'a' ? teamA : teamB }}</label>
          <input :id="`${idPrefix}-${row.set_index}-tb-${side}`" class="input" type="number" min="0" step="1" inputmode="numeric"
            :max="rule(row).margin === 1 ? rule(row).target : undefined" :aria-label="label(row, side, true)" placeholder="—"
            :value="row[`side_${side}_tiebreak`]" @input="change(row, `side_${side}_tiebreak`, $event.target.value)" />
        </div>
      </template>
    </fieldset>
  </div>
</template>

<style scoped>
.tennis-set-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; margin: 12px 0; }
.tennis-set { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 10px; }
.tennis-set legend { font-weight: 600; font-size: .85rem; padding: 0 5px; }
.tennis-set__row { display: grid; grid-template-columns: minmax(0, 1fr) 64px; align-items: center; gap: 8px; margin: 7px 0; }
.tennis-set__row label { font-size: .8rem; overflow-wrap: anywhere; }
.tennis-set__row input { width: 64px; text-align: center; padding: 8px 4px; }
.tennis-set__hint { font-size: .75rem; line-height: 1.5; margin: 4px 0; }
</style>
