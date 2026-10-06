<script setup>
// Plans every match still to be played (src/lib/autoSchedule.js), shows what
// the plan does and writes it as the schedule draft. "recalc" is the same plan
// from the current moment with the saved settings, after a match overran.
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import DateTimeField from '../DateTimeField.vue'
import { supabase } from '../../lib/supabase'
import { DEFAULT_MATCH_MINUTES, MATCH_MINUTES_PRESETS, MAX_MATCH_MINUTES, MIN_MATCH_MINUTES, planSchedule, planShift } from '../../lib/autoSchedule'
import { browserTimezone, formatScheduleTime, indexSchedule, isoToZonedLocal, scheduleError, timezoneOf, zonedLocalToIso } from '../../lib/schedule'

const props = defineProps({
  tournament: { type: Object, required: true },
  matches: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  courts: { type: Array, default: () => [] },
  schedule: { type: Array, default: () => [] },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  mode: { type: String, default: 'plan' },
})
const emit = defineEmits(['close', 'saved'])
const { t, locale } = useI18n()

const config = props.tournament.schedule_config || {}
const timeZone = computed(() => timezoneOf(props.tournament) || browserTimezone())
// Without a saved start: the next full hour, or 10:00 when that hour falls at night.
function defaultStart() {
  const next = new Date()
  next.setMinutes(60, 0, 0)
  const local = isoToZonedLocal(next.toISOString(), timeZone.value)
  const hour = Number(local.slice(11, 13))
  if (hour >= 8 && hour < 21) return next.toISOString()
  const day = hour < 8 ? local.slice(0, 10) : isoToZonedLocal(new Date(next.getTime() + 12 * 3_600_000).toISOString(), timeZone.value).slice(0, 10)
  return zonedLocalToIso(`${day}T10:00`, timeZone.value)
}
const savedMinutes = Number(config.match_minutes) || DEFAULT_MATCH_MINUTES
const form = reactive({
  start: isoToZonedLocal(config.start_at || defaultStart(), timeZone.value),
  preset: MATCH_MINUTES_PRESETS.includes(savedMinutes) ? String(savedMinutes) : 'custom',
  customMinutes: String(savedMinutes),
  rest: String(config.min_rest_minutes ?? 0),
  courtIds: props.courts.map(c => c.id),
})
const saving = ref(false)
const errorText = ref('')
// The plan starts no earlier than now; keep "now" fresh while the dialog is open.
const now = ref(Date.now())
const clock = setInterval(() => { now.value = Date.now() }, 30_000)
onBeforeUnmount(() => clearInterval(clock))

const matchMinutes = computed(() => Number(form.preset === 'custom' ? form.customMinutes : form.preset))
const restMinutes = computed(() => Math.max(0, Math.floor(Number(form.rest) || 0)))
const startIso = computed(() => zonedLocalToIso(form.start, timeZone.value))
const draft = computed(() => indexSchedule(props.schedule).draft)
const plan = computed(() => planSchedule({
  tournament: props.tournament,
  matches: props.matches,
  courts: props.courts,
  draft: draft.value,
  live: Object.values(props.liveScoresByMatch || {}),
  groups: props.groups,
  courtIds: form.courtIds,
  startAt: startIso.value,
  matchMinutes: matchMinutes.value,
  restMinutes: restMinutes.value,
  now: now.value,
}))
const shift = computed(() => (plan.value.ok ? planShift(draft.value, plan.value.rows) : { moved: 0, maxDelayMinutes: 0 }))
const endsAtText = computed(() => (plan.value.ok && plan.value.endsAt ? formatScheduleTime(plan.value.endsAt, locale.value, timeZone.value) : ''))
const startsLate = computed(() => startIso.value && new Date(startIso.value).getTime() < now.value)
const canSave = computed(() => plan.value.ok && plan.value.planned > 0 && !saving.value)
const title = computed(() => t(props.mode === 'recalc' ? 'schedule.auto.recalcTitle' : 'schedule.auto.title'))

async function save() {
  if (!canSave.value) return
  saving.value = true
  errorText.value = ''
  try {
    const { data, error } = await supabase.rpc('apply_auto_schedule', {
      p_tournament_id: props.tournament.id,
      p_rows: plan.value.rows,
      p_config: { match_minutes: matchMinutes.value, start_at: startIso.value, min_rest_minutes: restMinutes.value },
    })
    if (error) throw error
    emit('saved', { planned: plan.value.planned, scheduled: data?.scheduled ?? 0 })
    emit('close')
  } catch (error) {
    errorText.value = scheduleError(error?.message, t)
  } finally { saving.value = false }
}
</script>

<template>
  <AppModal :label="title" @close="emit('close')">
    <div class="modal-dialog auto-schedule">
      <header class="auto-schedule__head">
        <div>
          <h2 class="auto-schedule__title">{{ title }}</h2>
          <p class="auto-schedule__intro">{{ t(mode === 'recalc' ? 'schedule.auto.recalcIntro' : 'schedule.auto.intro') }}</p>
        </div>
        <button class="btn btn--ghost btn--icon auto-schedule__close" type="button" :aria-label="t('actions.close')" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </header>

      <div class="form-field">
        <label for="auto-start">{{ t('schedule.auto.start') }}</label>
        <DateTimeField id="auto-start" v-model="form.start" :disabled="saving" required teleport-to-dialog aria-describedby="auto-start-hint" />
        <p id="auto-start-hint" class="auto-schedule__hint">
          {{ startsLate ? t('schedule.auto.startPast') : t('schedule.timezoneNote', { zone: timeZone }) }}
        </p>
      </div>

      <div class="auto-schedule__row">
        <div class="form-field">
          <label for="auto-duration">{{ t('schedule.auto.duration') }}</label>
          <select id="auto-duration" v-model="form.preset" class="input" :disabled="saving">
            <option v-for="n in MATCH_MINUTES_PRESETS" :key="n" :value="String(n)">{{ t('schedule.auto.minutes', { n }) }}</option>
            <option value="custom">{{ t('schedule.auto.customDuration') }}</option>
          </select>
        </div>
        <div v-if="form.preset === 'custom'" class="form-field">
          <label for="auto-custom">{{ t('schedule.auto.customLabel') }}</label>
          <input id="auto-custom" v-model="form.customMinutes" class="input" type="number" inputmode="numeric" :min="MIN_MATCH_MINUTES" :max="MAX_MATCH_MINUTES" step="5" :disabled="saving" />
        </div>
      </div>

      <div class="form-field">
        <label for="auto-rest">{{ t('schedule.minRest') }}</label>
        <input id="auto-rest" v-model="form.rest" class="input auto-schedule__rest" type="number" inputmode="numeric" min="0" step="5" :disabled="saving" aria-describedby="auto-rest-hint" />
        <p id="auto-rest-hint" class="auto-schedule__hint">{{ t('schedule.auto.restHint') }}</p>
      </div>

      <fieldset class="auto-schedule__courts" :disabled="saving">
        <legend class="auto-schedule__legend">{{ t('schedule.auto.courts') }}</legend>
        <label v-for="court in courts" :key="court.id" class="auto-schedule__court">
          <input v-model="form.courtIds" type="checkbox" :value="court.id" />
          <span>{{ court.name }}</span>
        </label>
      </fieldset>

      <section class="auto-schedule__preview" :class="{ 'is-error': !plan.ok || !plan.planned }" aria-live="polite">
        <p v-if="!plan.ok" class="auto-schedule__line">{{ t(`schedule.auto.errors.${plan.error}`) }}</p>
        <p v-else-if="!plan.planned" class="auto-schedule__line">{{ t('schedule.auto.nothing') }}</p>
        <template v-else>
          <p class="auto-schedule__line"><strong>{{ t('schedule.auto.summary', { count: plan.planned, time: endsAtText }) }}</strong></p>
          <p v-if="shift.moved" class="auto-schedule__line">
            {{ shift.maxDelayMinutes > 0 ? t('schedule.auto.shift', { count: shift.moved, minutes: shift.maxDelayMinutes }) : t('schedule.auto.moved', { count: shift.moved }) }}
          </p>
          <p v-if="plan.kept" class="auto-schedule__line">{{ t('schedule.auto.kept', { count: plan.kept }) }}</p>
          <p class="auto-schedule__line auto-schedule__muted">{{ t('schedule.auto.draftNote') }}</p>
        </template>
      </section>

      <p v-if="errorText" class="alert alert--error" role="alert" style="margin: 0">{{ errorText }}</p>

      <footer class="auto-schedule__actions">
        <button class="btn btn--ghost" type="button" :disabled="saving" @click="emit('close')">{{ t('actions.cancel') }}</button>
        <button class="btn btn--primary" type="button" :disabled="!canSave" @click="save">
          {{ t(mode === 'recalc' ? 'schedule.auto.applyRecalc' : 'schedule.auto.apply') }}
        </button>
      </footer>
    </div>
  </AppModal>
</template>

<style scoped>
.auto-schedule { width: min(560px, 100%); display: grid; gap: 18px; }
.auto-schedule__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.auto-schedule__title { margin: 0; font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; color: var(--heading); }
.auto-schedule__intro { margin: 4px 0 0; color: var(--muted); font-size: 0.9375rem; }
.auto-schedule__close { margin: -6px -6px 0 0; }
.auto-schedule__hint { margin: 6px 0 0; font-size: 0.8125rem; color: var(--muted); }
.auto-schedule__rest { max-width: 160px; }
.auto-schedule__row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.auto-schedule__row .form-field { margin: 0; }
.auto-schedule__courts { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.auto-schedule__legend { padding: 0; margin-bottom: 8px; font-size: 0.875rem; font-weight: 600; color: var(--text); }
.auto-schedule__court {
  display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface); cursor: pointer;
}
.auto-schedule__court:has(input:checked) { border-color: var(--primary); background: var(--primary-soft); }
.auto-schedule__preview { display: grid; gap: 4px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--success-bg); color: var(--success-text); font-size: 0.875rem; }
.auto-schedule__preview.is-error { background: var(--warning-bg); color: var(--text); }
.auto-schedule__line { margin: 0; }
.auto-schedule__muted { color: var(--muted); }
.auto-schedule__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.auto-schedule__actions .btn { flex: 0 1 auto; min-width: 140px; min-height: 44px; }
@media (max-width: 520px) {
  .auto-schedule__actions .btn { flex: 1 1 100%; }
}
</style>
