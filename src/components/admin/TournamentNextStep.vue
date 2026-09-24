<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

// The road from registration to the first match, as one checklist above the
// tabs: every step says whether it is done and offers the action that does it,
// so the organizer never has to guess why "Start" is not available yet.
const props = defineProps({
  status: { type: String, required: true },
  format: { type: String, default: 'single_elimination' },
  approvedCount: { type: Number, default: 0 },
  pendingCount: { type: Number, default: 0 },
  matchesCount: { type: Number, default: 0 },
  busy: Boolean,
})
const emit = defineEmits(['go', 'close-registration', 'start'])
const { t } = useI18n()

const PRE_START = ['draft', 'registration_open', 'registration_closed']
const visible = computed(() => PRE_START.includes(props.status))
const matchesKey = computed(() => (props.format === 'round_robin' ? 'matches' : props.format === 'groups_playoff' ? 'groups' : 'bracket'))
const registrationClosed = computed(() => props.status === 'registration_closed')

const steps = computed(() => {
  const entriesDone = props.approvedCount >= 2 && props.pendingCount === 0
  const matchesDone = props.matchesCount > 0
  return [
    {
      key: 'entries',
      done: entriesDone,
      title: t('nextStep.entries'),
      detail: props.pendingCount
        ? t('nextStep.entriesPending', { n: props.pendingCount })
        : props.approvedCount >= 2 ? t('nextStep.entriesApproved', { n: props.approvedCount }) : t('nextStep.entriesTooFew'),
      action: props.pendingCount ? { label: t('nextStep.review'), run: () => emit('go', 'entries') } : null,
    },
    {
      key: 'registration',
      done: registrationClosed.value,
      title: t('nextStep.registration'),
      detail: registrationClosed.value ? t('nextStep.registrationClosed') : t('nextStep.registrationOpen'),
      action: registrationClosed.value ? null : {
        label: t('nextStep.closeRegistration'),
        disabled: props.approvedCount < 2,
        run: () => emit('close-registration'),
      },
    },
    {
      key: 'matches',
      done: matchesDone,
      title: t(`nextStep.${matchesKey.value}`),
      detail: matchesDone ? t('nextStep.matchesReady', { n: props.matchesCount }) : t(`nextStep.${matchesKey.value}Hint`),
      warning: matchesDone && !registrationClosed.value ? t('nextStep.matchesBeforeClose') : '',
      action: matchesDone ? null : { label: t('nextStep.openBracket'), disabled: props.approvedCount < 2, run: () => emit('go', 'bracket') },
    },
    {
      key: 'start',
      done: false,
      title: t('nextStep.start'),
      detail: t('nextStep.startHint'),
      action: {
        label: t('admin.startTournament'),
        primary: true,
        disabled: !(registrationClosed.value && matchesDone),
        run: () => emit('start'),
      },
    },
  ]
})
const current = computed(() => steps.value.find(step => !step.done) || steps.value.at(-1))
const lead = computed(() => {
  const key = current.value.key
  if (key === 'entries') return t(props.approvedCount < 2 && !props.pendingCount ? 'nextStep.lead_entriesFew' : 'nextStep.lead_entries')
  if (key === 'matches') return t(`nextStep.lead_${matchesKey.value}`)
  return t(`nextStep.lead_${key}`)
})
</script>

<template>
  <section v-if="visible" class="next-step" :aria-label="t('nextStep.label')">
    <p class="next-step__lead">
      <span class="next-step__eyebrow">{{ t('nextStep.label') }}</span>
      <strong>{{ lead }}</strong>
    </p>
    <ol class="next-step__list">
      <li
        v-for="(step, index) in steps"
        :key="step.key"
        class="next-step__item"
        :class="{ 'is-done': step.done, 'is-current': step.key === current.key }"
      >
        <span class="next-step__mark" aria-hidden="true">
          <svg v-if="step.done" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          <template v-else>{{ index + 1 }}</template>
        </span>
        <span class="next-step__body">
          <span class="next-step__title">
            {{ step.title }}
            <span class="sr-only">{{ step.done ? t('nextStep.done') : '' }}</span>
          </span>
          <span class="next-step__detail">{{ step.detail }}</span>
          <span v-if="step.warning" class="next-step__warning" role="status">{{ step.warning }}</span>
        </span>
        <button
          v-if="step.action"
          type="button"
          class="btn btn--sm next-step__action"
          :class="step.action.primary ? 'btn--success' : step.key === current.key ? 'btn--primary' : 'btn--outline'"
          :disabled="busy || step.action.disabled"
          @click="step.action.run()"
        >
          {{ step.action.label }}
        </button>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.next-step {
  display: grid;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.next-step__lead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; font-size: 1rem; color: var(--heading); }
.next-step__eyebrow { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.next-step__list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.next-step__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-content: start;
  gap: 6px 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-row);
}
.next-step__item.is-current { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.next-step__mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--disabled-bg); color: var(--muted);
  font-size: 0.75rem; font-weight: 700; font-variant-numeric: tabular-nums;
}
.next-step__item.is-done .next-step__mark { background: var(--success-bg); color: var(--success); }
.next-step__item.is-current .next-step__mark { background: var(--primary); color: var(--primary-contrast); }
.next-step__body { display: grid; gap: 2px; min-width: 0; }
.next-step__title { font-weight: 600; color: var(--text); }
.next-step__detail { font-size: 0.8125rem; line-height: 1.4; color: var(--muted); }
.next-step__warning { font-size: 0.8125rem; line-height: 1.4; color: var(--warning-text); }
.next-step__action { grid-column: 1 / -1; justify-self: start; }
@media (max-width: 900px) {
  .next-step__list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 520px) {
  .next-step__list { grid-template-columns: 1fr; }
}
</style>
