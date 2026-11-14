<script setup>
// One side's lineup for a tie: a player picker per match, filtered by the match type
// (men, women, mixed). Organizers save (submitted once complete); captains save a
// draft or submit. Checks mirror save_tie_lineup; the server has the last word.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { genderFits, lineSize, lineType, lineupDraftError } from '../lib/teamTie'

const props = defineProps({
  tie: { type: Object, required: true },        // flat template (lib/teamTie tieFromConfig)
  lines: { type: Array, required: true },       // the tie's line matches, by line_no
  roster: { type: Array, required: true },      // entry_members of this side's team
  initial: { type: Object, required: true },    // { [lineNo]: [memberId|''…] }
  locked: { type: Object, default: () => ({}) }, // { [lineNo]: true } once play has started
  mode: { type: String, default: 'organizer' }, // organizer | captain
  busy: { type: Boolean, default: false },
  idPrefix: { type: String, default: 'lineup' },
})
const emit = defineEmits(['save', 'cancel'])
const { t } = useI18n()

const draft = ref(JSON.parse(JSON.stringify(props.initial)))
const members = computed(() => Object.fromEntries(props.roster.map(m => [m.id, m])))
const errorKey = ref('')

const lineLabel = line => (line.line_no > props.tie.lines.length
  ? t('team.decider')
  : t('team.match', { n: line.line_no }))
const options = (line) => {
  const type = lineType(props.tie, line.line_no)
  return props.roster.filter(m => genderFits(type, m.gender))
}
const complete = computed(() => props.lines.every(line => (draft.value[line.line_no] || []).filter(Boolean).length === lineSize(lineType(props.tie, line.line_no))))

function payload() {
  return props.lines.map(line => ({ line_no: line.line_no, members: (draft.value[line.line_no] || []).filter(Boolean) }))
}
function save(submit) {
  errorKey.value = lineupDraftError(props.tie, props.lines, draft.value, members.value, { complete: submit }) || ''
  if (errorKey.value) return
  emit('save', { lines: payload(), submit })
}
</script>

<template>
  <div class="lineup-editor">
    <div v-for="line in lines" :key="line.id" class="lineup-editor__line">
      <div class="lineup-editor__label">
        <strong>{{ lineLabel(line) }}</strong>
        <span class="muted">{{ t(`team.lineTypes.${lineType(tie, line.line_no)}`) }}</span>
      </div>
      <div class="lineup-editor__slots">
        <select v-for="slot in lineSize(lineType(tie, line.line_no))" :key="slot"
          :id="`${idPrefix}-${line.line_no}-${slot}`"
          v-model="draft[line.line_no][slot - 1]" class="input"
          :disabled="busy || locked[line.line_no]"
          :aria-label="`${lineLabel(line)} · ${t('team.roster.player', { n: slot })}`">
          <option value="">{{ t('team.tie.pick') }}</option>
          <option v-for="m in options(line)" :key="m.id" :value="m.id">{{ m.member_name }}</option>
        </select>
      </div>
    </div>
    <p v-if="errorKey" class="error-text" role="alert">{{ t(errorKey) }}</p>
    <p v-if="mode === 'captain'" class="field-hint">{{ t('team.tie.submitHint') }}</p>
    <div class="lineup-editor__actions">
      <button type="button" class="btn btn--ghost btn--sm" :disabled="busy" @click="emit('cancel')">{{ t('actions.cancel') }}</button>
      <template v-if="mode === 'captain'">
        <button type="button" class="btn btn--outline btn--sm" :disabled="busy" @click="save(false)">{{ t('team.tie.saveDraft') }}</button>
        <button type="button" class="btn btn--primary btn--sm" :disabled="busy || !complete" @click="save(true)">{{ t('team.tie.submit') }}</button>
      </template>
      <button v-else type="button" class="btn btn--primary btn--sm" :disabled="busy" @click="save(complete)">{{ t('team.save') }}</button>
    </div>
  </div>
</template>

<style scoped>
.lineup-editor { display: flex; flex-direction: column; gap: 10px; }
.lineup-editor__line { display: grid; grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr); gap: 10px; align-items: center; }
.lineup-editor__label { display: flex; flex-direction: column; line-height: 1.25; }
.lineup-editor__label .muted { font-size: 0.85rem; }
.lineup-editor__slots { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 8px; }
.lineup-editor__actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
@media (max-width: 520px) { .lineup-editor__line { grid-template-columns: 1fr; } }
</style>
