<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

// The card's leading mark: the sport in the middle, a ring coloured like the status badge and
// filled by progress (seats taken during registration, matches played later).
const props = defineProps({
  sport: { type: String, required: true },
  status: { type: String, required: true }, // display status
  value: { type: Number, default: null }, // 0..1, null = no measurable progress
  label: { type: String, default: '' },
})

const R = 23
const CIRCUMFERENCE = 2 * Math.PI * R
const dash = computed(() => {
  const v = props.status === 'completed' ? 1 : props.value
  if (v == null || v <= 0) return null
  return `${(Math.min(Math.max(v, 0), 1) * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`
})
</script>

<template>
  <span class="t-progress" :class="`t-progress--${status}`" role="img" :aria-label="label">
    <svg class="t-progress__ring" viewBox="0 0 52 52" aria-hidden="true">
      <circle class="t-progress__track" cx="26" cy="26" :r="R" />
      <circle v-if="dash" class="t-progress__value" cx="26" cy="26" :r="R" :stroke-dasharray="dash" />
    </svg>
    <span class="t-progress__icon"><AppIcon :name="sport" :size="22" /></span>
  </span>
</template>

<style scoped>
.t-progress {
  --ring: var(--muted);
  --ring-bg: var(--surface-2);
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  color: var(--ring);
}
/* Same colours as the status badges (lib/tournamentStatus.js). */
.t-progress--registration_open,
.t-progress--registration_closed { --ring: var(--warning); --ring-bg: var(--warning-bg); }
.t-progress--in_progress { --ring: var(--success); --ring-bg: var(--success-bg); }
.t-progress--completed { --ring: var(--done-dot); --ring-bg: var(--done-bg); }
.t-progress__ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.t-progress__track { fill: var(--ring-bg); stroke: var(--border); stroke-width: 3; }
.t-progress__value {
  fill: none;
  stroke: var(--ring);
  stroke-width: 3.5;
  stroke-linecap: round;
  transition: stroke-dasharray 0.4s ease;
}
.t-progress__icon { position: relative; display: inline-flex; }
@media (prefers-reduced-motion: reduce) {
  .t-progress__value { transition: none; }
}
</style>
