<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DEFAULT_TENNIS_RULES, tennisRules, tennisRulesSummary, usesLongTiebreak } from '../lib/tennisRules'

// variant 'card'  — bordered fieldset with title, intro and summary (tournament settings tab)
// variant 'plain' — no box: preset select up front, detailed selects behind a disclosure (create wizard;
//                   the wizard's preview card already shows the summary)
const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  disabled: Boolean,
  idPrefix: { type: String, default: 'tennis' },
  variant: { type: String, default: 'card' },
})
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
const plain = computed(() => props.variant === 'plain')
// Custom rules (no preset matches) must be visible right away; otherwise details stay folded.
const advancedOpen = ref(chosenPreset.value === '')
</script>

<template>
  <fieldset class="tennis-rules" :class="{ 'tennis-rules--plain': plain }" :disabled="disabled">
    <legend :class="{ 'sr-only': plain }">{{ t('tennisRules.title') }}</legend>
    <p v-if="!plain" class="muted tennis-rules__intro">{{ t('tennisRules.intro') }}</p>

    <div class="form-field">
      <label :for="`${idPrefix}-preset`">{{ t('tennisRules.preset') }}</label>
      <select :id="`${idPrefix}-preset`" class="input" :value="chosenPreset" @change="preset($event.target.value)">
        <option value="" disabled>{{ t('tennisRules.custom') }}</option>
        <option v-for="name in Object.keys(presets)" :key="name" :value="name">{{ t(`tennisRules.preset_${name}`) }}</option>
      </select>
    </div>

    <component :is="plain ? 'details' : 'div'" class="tennis-rules__advanced" :open="plain ? advancedOpen : undefined" @toggle="plain && (advancedOpen = $event.target.open)">
      <summary v-if="plain" class="tennis-rules__toggle">
        <svg class="tennis-rules__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <span>{{ t('tennisRules.advanced') }}</span>
        <span v-if="chosenPreset === ''" class="tennis-rules__custom-badge">{{ t('tennisRules.custom') }}</span>
      </summary>

      <div class="tennis-rules__grid">
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
      <a href="https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf" target="_blank" rel="noopener noreferrer" class="tennis-rules__source">{{ t('tennisRules.source') }} ↗</a>
    </component>

    <p v-if="!plain" class="tennis-rules__summary">{{ summary }}</p>
    <p v-if="!modelValue.tennis && rules.tiebreak_to === 10" class="alert alert--info">{{ t('tennisRules.legacyHint') }}</p>
    <p v-if="disabled" class="muted tennis-rules__hint">{{ t('tennisRules.locked') }}</p>
  </fieldset>
</template>

<style scoped>
.tennis-rules { margin: 12px 0; padding: 20px; border: 1px solid var(--border); border-radius: 12px; min-width: 0; container-type: inline-size; display: flex; flex-direction: column; gap: 16px; }
.tennis-rules legend { font-weight: 700; padding: 0 8px; }
.tennis-rules__intro { margin: -4px 0 0; font-size: .875rem; }
.tennis-rules__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.tennis-rules__wide { grid-column: 1 / -1; }
.tennis-rules__hint, .tennis-rules__source { font-size: .8rem; line-height: 1.5; }
.tennis-rules__source { display: inline-block; margin-top: 12px; }
.tennis-rules__summary { margin: 0; font-size: .85rem; line-height: 1.6; }
.tennis-rules .input { width: 100%; min-width: 0; }
.tennis-rules__advanced { display: flex; flex-direction: column; gap: 16px; }
.tennis-rules__advanced > .tennis-rules__hint { margin: 0; }

/* plain: no box, disclosure for the detailed selects */
.tennis-rules--plain { margin: 0; padding: 0; border: 0; border-radius: 0; gap: var(--space-4); }
.tennis-rules--plain .tennis-rules__advanced { display: block; }
.tennis-rules--plain .tennis-rules__advanced[open] > .tennis-rules__grid { margin-top: var(--space-4); }
.tennis-rules__toggle {
  display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 12px 0 8px;
  font-size: .875rem; font-weight: 600; color: var(--text-muted); border-radius: 10px; cursor: pointer; list-style: none;
  transition: color .15s, background .15s;
}
.tennis-rules__toggle::-webkit-details-marker { display: none; }
.tennis-rules__toggle:hover { color: var(--text); background: var(--surface-row); }
.tennis-rules__chevron { transition: transform .2s; }
.tennis-rules__advanced[open] .tennis-rules__chevron { transform: rotate(90deg); }
.tennis-rules__custom-badge {
  padding: 2px 8px; font-size: .7rem; font-weight: 600; letter-spacing: .02em;
  color: var(--primary); background: var(--primary-soft, rgba(59,130,246,.1)); border-radius: 999px;
}
@media (prefers-reduced-motion: reduce) { .tennis-rules__chevron, .tennis-rules__toggle { transition: none; } }
@container (max-width: 560px) { .tennis-rules__grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .tennis-rules:not(.tennis-rules--plain) { padding: 14px; } .tennis-rules__grid { grid-template-columns: minmax(0, 1fr); } }
</style>
