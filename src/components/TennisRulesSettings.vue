<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DEFAULT_TENNIS_RULES, tennisRules, tennisRulesSummary, usesLongTiebreak } from '../lib/tennisRules'

const props = defineProps({ modelValue: { type: Object, default: () => ({}) }, disabled: Boolean, idPrefix: { type: String, default: 'tennis' } })
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const rules = computed(() => tennisRules(props.modelValue))
const summary = computed(() => tennisRulesSummary(props.modelValue, t))
function update(key, value) {
  if (props.disabled) return
  const { tiebreak_to, ...tennis } = rules.value
  emit('update:modelValue', { ...props.modelValue, tennis: { ...tennis, [key]: value } })
}
const presets = {
  standard: {}, final10: { final_set_rule: 'tiebreak_10' },
  match10: { game_rule: 'no_ad', final_set_rule: 'match_tiebreak_10' },
  short: { game_rule: 'no_ad', set_rule: 'short', short_tiebreak_at: 3, short_tiebreak_to: 5 },
}
function preset(name) {
  if (!props.disabled && presets[name]) emit('update:modelValue', { ...props.modelValue, tennis: { ...DEFAULT_TENNIS_RULES, ...presets[name] } })
}
const chosenPreset = computed(() => {
  if (!props.modelValue?.tennis && rules.value.tiebreak_to === 10) return ''
  return Object.keys(presets).find(name => Object.entries({ ...DEFAULT_TENNIS_RULES, ...presets[name] }).every(([k, v]) => rules.value[k] === v)) || ''
})
</script>

<template>
  <fieldset class="tennis-rules" :disabled="disabled">
    <legend>{{ t('tennisRules.title') }}</legend>
    <p class="muted tennis-rules__intro">{{ t('tennisRules.intro') }}</p>
    <div class="tennis-rules__grid">
      <div class="form-field tennis-rules__wide">
        <label :for="`${idPrefix}-preset`">{{ t('tennisRules.preset') }}</label>
        <select :id="`${idPrefix}-preset`" class="input" :value="chosenPreset" @change="preset($event.target.value)">
          <option value="" disabled>{{ t('tennisRules.custom') }}</option>
          <option v-for="name in Object.keys(presets)" :key="name" :value="name">{{ t(`tennisRules.preset_${name}`) }}</option>
        </select>
      </div>
      <div class="form-field">
        <label :for="`${idPrefix}-game`">{{ t('tennisRules.game') }}</label>
        <select :id="`${idPrefix}-game`" class="input" :value="rules.game_rule" @change="update('game_rule', $event.target.value)">
          <option v-for="value in ['advantage', 'no_ad']" :key="value" :value="value">{{ t(`tennisRules.game_${value}`) }}</option>
        </select>
      </div>
      <div class="form-field">
        <label :for="`${idPrefix}-set`">{{ t('tennisRules.set') }}</label>
        <select :id="`${idPrefix}-set`" class="input" :value="rules.set_rule" @change="update('set_rule', $event.target.value)">
          <option v-for="value in ['standard', 'advantage', 'short']" :key="value" :value="value">{{ t(`tennisRules.set_${value}`) }}</option>
        </select>
      </div>
      <template v-if="rules.set_rule === 'short'">
        <div class="form-field">
          <label :for="`${idPrefix}-short-at`">{{ t('tennisRules.shortAt') }}</label>
          <select :id="`${idPrefix}-short-at`" class="input" :value="rules.short_tiebreak_at" @change="update('short_tiebreak_at', Number($event.target.value))">
            <option :value="4">4:4</option><option :value="3">3:3</option>
          </select>
        </div>
        <div class="form-field">
          <label :for="`${idPrefix}-short-to`">{{ t('tennisRules.shortTo') }}</label>
          <select :id="`${idPrefix}-short-to`" class="input" :value="rules.short_tiebreak_to" @change="update('short_tiebreak_to', Number($event.target.value))">
            <option :value="7">{{ t('tennisRules.to7') }}</option><option :value="5">{{ t('tennisRules.to5') }}</option>
          </select>
        </div>
      </template>
      <div class="form-field tennis-rules__wide">
        <label :for="`${idPrefix}-final`">{{ t('tennisRules.final') }}</label>
        <select :id="`${idPrefix}-final`" class="input" :value="rules.final_set_rule" @change="update('final_set_rule', $event.target.value)">
          <option v-for="value in ['same', 'standard', 'advantage', 'tiebreak_10', 'match_tiebreak_7', 'match_tiebreak_10']" :key="value" :value="value">{{ t(`tennisRules.final_${value}`) }}</option>
        </select>
        <p class="tennis-rules__hint muted">{{ t('tennisRules.finalHint') }}</p>
      </div>
      <div v-if="usesLongTiebreak(modelValue)" class="form-field tennis-rules__wide">
        <label :for="`${idPrefix}-changeover`">{{ t('tennisRules.changeover') }}</label>
        <select :id="`${idPrefix}-changeover`" class="input" :value="rules.changeover" @change="update('changeover', $event.target.value)">
          <option value="every_six">{{ t('tennisRules.everySix') }}</option>
          <option value="one_then_four">{{ t('tennisRules.oneThenFour') }}</option>
        </select>
      </div>
    </div>
    <p v-if="rules.set_rule === 'short' && rules.short_tiebreak_to === 5" class="tennis-rules__hint muted">{{ t('tennisRules.shortEnds') }}</p>
    <p class="tennis-rules__summary">{{ summary }}</p>
    <p v-if="!modelValue.tennis && rules.tiebreak_to === 10" class="alert alert--info">{{ t('tennisRules.legacyHint') }}</p>
    <p v-if="disabled" class="muted tennis-rules__hint">{{ t('tennisRules.locked') }}</p>
    <a href="https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf" target="_blank" rel="noopener noreferrer" class="tennis-rules__source">{{ t('tennisRules.source') }} ↗</a>
  </fieldset>
</template>

<style scoped>
.tennis-rules { margin: 12px 0; padding: 20px; border: 1px solid var(--border); border-radius: 12px; min-width: 0; container-type: inline-size; }
.tennis-rules legend { font-weight: 700; padding: 0 8px; }
.tennis-rules__intro { margin: 0 0 18px; font-size: .875rem; }
.tennis-rules__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.tennis-rules__wide { grid-column: 1 / -1; }
.tennis-rules__hint, .tennis-rules__source { font-size: .8rem; line-height: 1.5; }
.tennis-rules__summary { margin: 18px 0 12px; font-size: .85rem; line-height: 1.6; }
.tennis-rules .input { width: 100%; min-width: 0; }
@container (max-width: 560px) { .tennis-rules__grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .tennis-rules { padding: 14px; } .tennis-rules__grid { grid-template-columns: minmax(0, 1fr); } }
</style>
