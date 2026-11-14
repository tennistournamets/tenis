<script setup>
// Team tie template: which matches make up one tie, how a tie is won, the playoff
// decider and the roster size. v-model is the flat shape of lib/teamTie.js.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { LINE_TYPES, MAX_LINES, TIE_PRESETS, playersNeeded, presetOf, tieError } from '../lib/teamTie'

const props = defineProps({
  modelValue: { type: Object, required: true },
  idPrefix: { type: String, default: 'tie' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const tie = computed(() => props.modelValue)
const preset = computed(() => presetOf(tie.value.lines))
const needed = computed(() => playersNeeded(tie.value.lines))
const problem = computed(() => tieError(tie.value))

function update(patch) {
  emit('update:modelValue', { ...tie.value, ...patch })
}
function choosePreset(id) {
  const found = TIE_PRESETS.find(p => p.id === id)
  if (found) update({ lines: [...found.lines] })
}
function setLine(index, type) {
  const lines = [...tie.value.lines]
  lines[index] = type
  update({ lines })
}
function addLine() {
  if (tie.value.lines.length < MAX_LINES) update({ lines: [...tie.value.lines, 'AD'] })
}
function removeLine(index) {
  if (tie.value.lines.length > 1) update({ lines: tie.value.lines.filter((_, i) => i !== index) })
}
const presetOptions = [...TIE_PRESETS.map(p => p.id), 'custom']
</script>

<template>
  <div class="tie-template">
    <p class="field-hint">{{ t('team.template.hint') }}</p>

    <fieldset class="tie-template__presets" :disabled="disabled">
      <legend class="tie-template__legend">{{ t('team.template.preset') }}</legend>
      <label v-for="id in presetOptions" :key="id" class="tie-template__preset" :class="{ 'is-active': preset === id }">
        <input type="radio" :name="`${idPrefix}-preset`" :value="id" :checked="preset === id"
          :disabled="id === 'custom'" @change="choosePreset(id)" />
        <span>{{ t(`team.template.presets.${id}`) }}</span>
      </label>
    </fieldset>

    <fieldset class="tie-template__lines" :disabled="disabled">
      <legend class="tie-template__legend">{{ t('team.template.matches') }}</legend>
      <ol class="tie-template__list">
        <li v-for="(type, index) in tie.lines" :key="index" class="tie-template__line">
          <label class="tie-template__no" :for="`${idPrefix}-line-${index}`">{{ index + 1 }}</label>
          <select :id="`${idPrefix}-line-${index}`" class="input" :value="type" @change="setLine(index, $event.target.value)">
            <option v-for="option in LINE_TYPES" :key="option" :value="option">{{ t(`team.lineTypes.${option}`) }}</option>
          </select>
          <button type="button" class="btn btn--ghost btn--sm tie-template__remove" :disabled="tie.lines.length < 2"
            :aria-label="t('team.template.removeMatch', { n: index + 1 })" @click="removeLine(index)">×</button>
        </li>
      </ol>
      <button type="button" class="btn btn--outline btn--sm" :disabled="tie.lines.length >= MAX_LINES" @click="addLine">
        + {{ t('team.template.addMatch') }}
      </button>
    </fieldset>

    <fieldset class="tie-template__rule" :disabled="disabled">
      <legend class="tie-template__legend">{{ t('team.template.winRule') }}</legend>
      <label class="tie-template__radio">
        <input type="radio" :name="`${idPrefix}-rule`" value="rubbers" :checked="tie.win_rule === 'rubbers'" @change="update({ win_rule: 'rubbers' })" />
        <span>{{ t('team.template.winRubbers') }}</span>
      </label>
      <label class="tie-template__radio">
        <input type="radio" :name="`${idPrefix}-rule`" value="games" :checked="tie.win_rule === 'games'" @change="update({ win_rule: 'games' })" />
        <span>{{ t('team.template.winGames') }}</span>
      </label>
    </fieldset>

    <div class="tie-template__grid">
      <div class="form-field">
        <label :for="`${idPrefix}-decider`">{{ t('team.template.decider') }}</label>
        <select :id="`${idPrefix}-decider`" class="input" :value="tie.decider" :disabled="disabled"
          :aria-describedby="`${idPrefix}-decider-hint`" @change="update({ decider: $event.target.value })">
          <option v-for="option in LINE_TYPES" :key="option" :value="option">{{ t(`team.lineTypes.${option}`) }}</option>
        </select>
        <p :id="`${idPrefix}-decider-hint`" class="field-hint">{{ t('team.template.deciderHint') }}</p>
      </div>
      <div class="form-field">
        <span class="tie-template__label" :id="`${idPrefix}-roster-label`">{{ t('team.template.roster') }}</span>
        <div class="tie-template__range" role="group" :aria-labelledby="`${idPrefix}-roster-label`">
          <label :for="`${idPrefix}-roster-min`">{{ t('team.template.rosterMin') }}</label>
          <input :id="`${idPrefix}-roster-min`" class="input" type="number" min="1" max="30" :value="tie.roster_min" :disabled="disabled"
            @input="update({ roster_min: Number($event.target.value) })" />
          <label :for="`${idPrefix}-roster-max`">{{ t('team.template.rosterMax') }}</label>
          <input :id="`${idPrefix}-roster-max`" class="input" type="number" min="1" max="30" :value="tie.roster_max" :disabled="disabled"
            @input="update({ roster_max: Number($event.target.value) })" />
        </div>
        <p class="field-hint">{{ t('team.template.needed', { n: needed }) }}</p>
      </div>
    </div>

    <p class="field-hint">{{ t('team.template.points') }}</p>
    <p v-if="problem" class="error-text" role="alert">{{ t(problem) }}</p>
  </div>
</template>

<style scoped>
.tie-template { display: flex; flex-direction: column; gap: 18px; }
.tie-template fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.tie-template__legend, .tie-template__label { font-weight: 600; font-size: 0.92rem; margin-bottom: 8px; display: block; padding: 0; }
.tie-template__presets { display: flex; flex-wrap: wrap; gap: 8px; }
.tie-template__presets .tie-template__legend { width: 100%; }
.tie-template__preset {
  display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px;
  border: 1px solid var(--border); cursor: pointer; font-size: 0.92rem;
}
.tie-template__preset.is-active { border-color: var(--primary); background: var(--primary-soft); }
.tie-template__preset input { margin: 0; }
.tie-template__preset:has(input:disabled) { cursor: default; opacity: 0.8; }
.tie-template__list { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 8px; }
.tie-template__line { display: grid; grid-template-columns: 2rem minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.tie-template__no {
  width: 2rem; height: 2rem; border-radius: 50%; display: grid; place-items: center; font-weight: 700;
  background: var(--surface-2); font-variant-numeric: tabular-nums;
}
.tie-template__remove { min-width: 2.25rem; font-size: 1.1rem; }
.tie-template__rule { display: grid; gap: 6px; }
.tie-template__radio { display: flex; gap: 8px; align-items: center; cursor: pointer; }
.tie-template__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.tie-template__range { display: flex; align-items: center; gap: 8px; }
.tie-template__range .input { width: 5rem; }
</style>
