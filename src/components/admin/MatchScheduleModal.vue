<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import DateTimeField from '../DateTimeField.vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import { entryDisplayNames } from '../../lib/entryDisplay'
import { supabase } from '../../lib/supabase'
import { conflictText, hasHardConflict, isoToZonedLocal, scheduleError, timezoneOf, zonedLocalToIso } from '../../lib/schedule'

const props = defineProps({
  match: { type: Object, required: true },
  current: { type: Object, default: null },
  courts: { type: Array, default: () => [] },
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  tournament: { type: Object, required: true },
})
const emit = defineEmits(['close', 'saved'])
const { t } = useI18n()

const timeZone = computed(() => timezoneOf(props.tournament))
const initialMode = props.current?.time_kind || (props.current?.court_id ? 'queue' : 'fixed')
const form = reactive({
  courtId: props.current?.court_id || '',
  mode: initialMode,
  time: isoToZonedLocal(props.current?.scheduled_at, timeZone.value),
  queueOrder: props.current?.queue_order ? String(props.current.queue_order) : '',
})

const saving = ref(false)
const checking = ref(false)
const conflicts = ref([])
const errorText = ref('')
let checkTimer = null
let checkVersion = 0

// v-model on a number input hands back a Number once the field is edited and
// a String before that, so every read goes through this one normaliser.
const queueText = computed(() => String(form.queueOrder ?? '').trim())
const queueNumber = computed(() => (queueText.value ? Number(queueText.value) : null))
const queueValid = computed(() => queueNumber.value === null || (Number.isInteger(queueNumber.value) && queueNumber.value > 0))
const timed = computed(() => form.mode !== 'queue')

const payload = computed(() => {
  const at = timed.value ? zonedLocalToIso(form.time, timeZone.value) : null
  return {
    p_match_id: props.match.id,
    p_court_id: form.courtId || null,
    p_scheduled_at: at,
    p_time_kind: at ? form.mode : null,
    p_queue_order: form.courtId && queueValid.value ? queueNumber.value : null,
  }
})
// Mirrors the checks in set_match_schedule, but names the one thing to fix.
const invalidReason = computed(() => {
  if (!timed.value && !form.courtId) return 'invalidAssignment'
  if (timed.value && !payload.value.p_scheduled_at) return form.courtId ? 'needTime' : 'invalidAssignment'
  if (form.courtId && !queueValid.value) return 'invalidQueue'
  return ''
})
const valid = computed(() => !invalidReason.value)
// "No time" needs a court to queue on; dropping the court falls back to a time.
watch(() => form.courtId, (courtId) => { if (!courtId && form.mode === 'queue') form.mode = 'fixed' })
const modes = computed(() => [
  { value: 'fixed', label: t('schedule.modeFixed'), hint: t('schedule.modeFixedHint') },
  { value: 'not_before', label: t('schedule.modeNotBefore'), hint: t('schedule.modeNotBeforeHint') },
  { value: 'queue', label: t('schedule.modeQueue'), hint: form.courtId ? t('schedule.modeQueueHint') : t('schedule.modeQueueNeedsCourt'), disabled: !form.courtId },
])
const hardConflict = computed(() => hasHardConflict(conflicts.value))
const softOnly = computed(() => conflicts.value.length > 0 && !hardConflict.value)

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryDisplayNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}
const title = computed(() => `${teamLabel(props.match.side_a_entry_id)} — ${teamLabel(props.match.side_b_entry_id)}`)
function matchLabel(matchId) {
  const other = props.matches.find(m => m.id === matchId)
  return other ? `${teamLabel(other.side_a_entry_id)} — ${teamLabel(other.side_b_entry_id)}` : ''
}

async function runCheck() {
  if (!valid.value) { conflicts.value = []; return }
  const version = ++checkVersion
  checking.value = true
  try {
    const { data, error } = await supabase.rpc('check_match_schedule', payload.value)
    if (version !== checkVersion) return
    if (error) throw error
    conflicts.value = Array.isArray(data) ? data : []
    errorText.value = ''
  } catch (error) {
    if (version === checkVersion) errorText.value = scheduleError(error?.message, t)
  } finally {
    if (version === checkVersion) checking.value = false
  }
}
watch(payload, () => {
  clearTimeout(checkTimer)
  checkTimer = setTimeout(runCheck, 300)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(checkTimer))

async function save(ignoreWarnings = false) {
  if (saving.value || !valid.value || hardConflict.value) return
  saving.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('set_match_schedule', { ...payload.value, p_ignore_warnings: ignoreWarnings })
    if (error) throw error
    emit('saved')
    emit('close')
  } catch (error) {
    errorText.value = scheduleError(error?.message, t)
    await runCheck()
  } finally { saving.value = false }
}

async function clear() {
  if (saving.value) return
  saving.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('clear_match_schedule', { p_match_id: props.match.id })
    if (error) throw error
    emit('saved')
    emit('close')
  } catch (error) {
    errorText.value = scheduleError(error?.message, t)
  } finally { saving.value = false }
}
</script>

<template>
  <AppModal :label="current ? t('schedule.change') : t('schedule.assign')" @close="emit('close')">
    <div class="modal-dialog schedule-modal">
      <header class="schedule-modal__head">
        <div class="schedule-modal__heading">
          <h2 class="schedule-modal__title">{{ current ? t('schedule.change') : t('schedule.assign') }}</h2>
          <p class="schedule-modal__match">{{ title }}</p>
        </div>
        <button class="btn btn--ghost btn--icon schedule-modal__close" type="button" :aria-label="t('actions.close')" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </header>

      <div class="form-field">
        <label for="sched-court">{{ t('schedule.court') }}</label>
        <select id="sched-court" v-model="form.courtId" class="input" :disabled="saving">
          <option value="">{{ t('schedule.noCourt') }}</option>
          <option v-for="court in courts" :key="court.id" :value="court.id">{{ court.name }}</option>
        </select>
      </div>

      <fieldset class="schedule-modal__modes" :disabled="saving">
        <legend class="schedule-modal__legend">{{ t('schedule.mode') }}</legend>
        <div class="schedule-modal__options">
          <label
            v-for="mode in modes"
            :key="mode.value"
            class="schedule-mode"
            :class="{ 'is-checked': form.mode === mode.value, 'is-disabled': mode.disabled }"
          >
            <input v-model="form.mode" class="schedule-mode__input" type="radio" name="sched-mode" :value="mode.value" :disabled="mode.disabled" />
            <span class="schedule-mode__label">{{ mode.label }}</span>
            <span class="schedule-mode__hint">{{ mode.hint }}</span>
          </label>
        </div>
      </fieldset>

      <div v-if="timed" class="form-field">
        <label for="sched-time">{{ t('schedule.time') }}</label>
        <DateTimeField id="sched-time" v-model="form.time" :disabled="saving" required teleport-to-dialog />
        <p v-if="timeZone" class="schedule-modal__hint">{{ t('schedule.timezoneNote', { zone: timeZone }) }}</p>
      </div>

      <div v-if="form.courtId" class="form-field">
        <label for="sched-queue">{{ t('schedule.queueOrder') }}</label>
        <input
          id="sched-queue"
          v-model="form.queueOrder"
          class="input"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          :aria-invalid="!queueValid"
          aria-describedby="sched-queue-hint"
          :disabled="saving"
        />
        <p id="sched-queue-hint" class="schedule-modal__hint">{{ t('schedule.queueHint') }}</p>
      </div>

      <section class="schedule-modal__status" :class="{ 'is-warn': valid && conflicts.length && !hardConflict, 'is-hard': valid && hardConflict, 'is-idle': !valid || checking }" aria-live="polite">
        <p v-if="!valid" class="schedule-modal__status-line">{{ t(`schedule.errors.${invalidReason}`) }}</p>
        <p v-else-if="checking" class="schedule-modal__status-line">{{ t('schedule.checking') }}</p>
        <p v-else-if="!conflicts.length" class="schedule-modal__status-line schedule-modal__status-line--ok">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
          {{ t('schedule.noConflicts') }}
        </p>
        <ul v-else class="schedule-modal__list">
          <li v-for="(conflict, index) in conflicts" :key="index" :class="conflict.severity === 'hard' ? 'is-hard' : 'is-soft'">
            <span class="schedule-modal__kind">{{ t(conflict.severity === 'hard' ? 'schedule.hard' : 'schedule.soft') }}</span>
            {{ conflictText(conflict, t, matchLabel) }}
          </li>
        </ul>
      </section>

      <p v-if="errorText" class="alert alert--error" role="alert" style="margin: 0">{{ errorText }}</p>

      <footer class="schedule-modal__actions">
        <button v-if="current" class="btn btn--ghost" type="button" :disabled="saving" @click="clear">{{ t('schedule.clear') }}</button>
        <button v-if="!softOnly" class="btn btn--primary" type="button" :disabled="saving || checking || !valid || hardConflict" @click="save(false)">{{ t('schedule.save') }}</button>
        <button v-else class="btn btn--warn" type="button" :disabled="saving || checking" @click="save(true)">{{ t('schedule.saveAnyway') }}</button>
      </footer>
    </div>
  </AppModal>
</template>

<style scoped>
.schedule-modal { width: min(520px, 100%); display: grid; gap: 18px; }
.schedule-modal__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.schedule-modal__heading { min-width: 0; }
.schedule-modal__title { margin: 0; font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; color: var(--heading); }
.schedule-modal__match { margin: 4px 0 0; color: var(--muted); font-size: 0.9375rem; overflow-wrap: anywhere; }
.schedule-modal__close { margin: -6px -6px 0 0; }

.schedule-modal__modes { margin: 0; padding: 0; border: 0; min-width: 0; }
.schedule-modal__legend { padding: 0; margin-bottom: 8px; font-size: 0.875rem; font-weight: 600; color: var(--text); }
.schedule-modal__options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.schedule-mode {
  position: relative; display: grid; gap: 4px; align-content: start; padding: 12px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface);
  cursor: pointer; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.schedule-mode:hover:not(.is-disabled) { border-color: var(--primary); }
.schedule-mode.is-checked { border-color: var(--primary); background: var(--primary-soft); box-shadow: inset 0 0 0 1px var(--primary); }
.schedule-mode.is-disabled { cursor: not-allowed; opacity: 0.55; }
/* The native radio stays in the tab order and drives the group; the card is its visual. */
.schedule-mode__input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: inherit; }
.schedule-mode:has(.schedule-mode__input:focus-visible) { outline: 2px solid var(--primary); outline-offset: 2px; }
.schedule-mode__label { font-size: 0.9375rem; font-weight: 600; color: var(--text); }
.schedule-mode__hint { font-size: 0.78rem; line-height: 1.35; color: var(--muted); }

.schedule-modal__hint { margin: 6px 0 0; font-size: 0.8125rem; color: var(--muted); }

.schedule-modal__status { padding: 10px 12px; border-radius: var(--radius-sm); background: var(--success-bg); color: var(--success-text); font-size: 0.875rem; }
.schedule-modal__status.is-idle { background: var(--surface-row); color: var(--muted); }
.schedule-modal__status.is-warn { background: var(--warning-bg); color: var(--text); }
.schedule-modal__status.is-hard { background: var(--danger-bg); color: var(--text); }
.schedule-modal__status-line { display: flex; align-items: center; gap: 8px; margin: 0; }
.schedule-modal__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.schedule-modal__kind { margin-right: 6px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.schedule-modal__list .is-hard .schedule-modal__kind { color: var(--danger); }
.schedule-modal__list .is-soft .schedule-modal__kind { color: var(--warning-text); }

.schedule-modal__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.schedule-modal__actions .btn { flex: 0 1 auto; min-width: 140px; min-height: 44px; }
@media (max-width: 520px) {
  .schedule-modal__options { grid-template-columns: 1fr; }
  .schedule-modal__actions .btn { flex: 1 1 100%; }
}
</style>
