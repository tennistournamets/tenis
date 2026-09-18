<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import { entryMemberNames } from '../../lib/entryDisplay'
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

const payload = computed(() => {
  const at = form.mode === 'queue' ? null : zonedLocalToIso(form.time, timeZone.value)
  const queue = form.queueOrder.trim() ? Number(form.queueOrder) : null
  return {
    p_match_id: props.match.id,
    p_court_id: form.courtId || null,
    p_scheduled_at: at,
    p_time_kind: at ? form.mode : null,
    p_queue_order: form.courtId && Number.isInteger(queue) && queue > 0 ? queue : null,
  }
})
const valid = computed(() => Boolean(payload.value.p_court_id || payload.value.p_scheduled_at)
  && (form.mode === 'queue' || Boolean(payload.value.p_scheduled_at))
  && (!form.queueOrder.trim() || (Number.isInteger(Number(form.queueOrder)) && Number(form.queueOrder) > 0 && form.courtId)))
const hardConflict = computed(() => hasHardConflict(conflicts.value))
const softOnly = computed(() => conflicts.value.length > 0 && !hardConflict.value)

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryMemberNames(props.entriesMap[entryId])
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
  <AppModal :label="t('schedule.assign')" @close="emit('close')">
    <div class="modal-dialog schedule-modal stack stack--sm">
      <header class="modal-dialog__head schedule-modal__head">
        <div>
          <h2 class="section-title" style="margin: 0">{{ current ? t('schedule.change') : t('schedule.assign') }}</h2>
          <p class="muted" style="margin: 4px 0 0">{{ title }}</p>
        </div>
        <button class="btn btn--ghost btn--sm" type="button" :aria-label="t('actions.close')" @click="emit('close')">✕</button>
      </header>

      <div class="form-field">
        <label for="sched-court">{{ t('schedule.court') }}</label>
        <select id="sched-court" v-model="form.courtId" class="input" :disabled="saving">
          <option value="">{{ t('schedule.noCourt') }}</option>
          <option v-for="court in courts" :key="court.id" :value="court.id">{{ court.name }}</option>
        </select>
      </div>

      <fieldset class="schedule-modal__modes" :disabled="saving">
        <legend>{{ t('schedule.mode') }}</legend>
        <label class="checkbox-row"><input v-model="form.mode" type="radio" value="fixed" /> {{ t('schedule.modeFixed') }}</label>
        <label class="checkbox-row"><input v-model="form.mode" type="radio" value="not_before" /> {{ t('schedule.modeNotBefore') }}</label>
        <label class="checkbox-row" :class="{ 'schedule-modal__disabled': !form.courtId }">
          <input v-model="form.mode" type="radio" value="queue" :disabled="!form.courtId" /> {{ t('schedule.modeQueue') }}
        </label>
      </fieldset>

      <div v-if="form.mode !== 'queue'" class="form-field">
        <label for="sched-time">{{ t('schedule.time') }}</label>
        <input id="sched-time" v-model="form.time" class="input" type="datetime-local" :disabled="saving" required />
        <p v-if="timeZone" class="muted schedule-modal__hint">{{ t('schedule.timezoneNote', { zone: timeZone }) }}</p>
      </div>

      <div v-if="form.courtId" class="form-field">
        <label for="sched-queue">{{ t('schedule.queueOrder') }}</label>
        <input id="sched-queue" v-model="form.queueOrder" class="input" type="number" inputmode="numeric" min="1" step="1" :disabled="saving" />
      </div>

      <section class="schedule-modal__conflicts" aria-live="polite">
        <p v-if="checking" class="muted" style="margin: 0">{{ t('schedule.checking') }}</p>
        <template v-else-if="valid">
          <p v-if="!conflicts.length" class="muted" style="margin: 0">{{ t('schedule.noConflicts') }}</p>
          <ul v-else class="schedule-modal__list">
            <li v-for="(conflict, index) in conflicts" :key="index" :class="conflict.severity === 'hard' ? 'error-text' : 'schedule-modal__soft'">
              <strong>{{ t(conflict.severity === 'hard' ? 'schedule.hard' : 'schedule.soft') }}:</strong>
              {{ conflictText(conflict, t, matchLabel) }}
            </li>
          </ul>
        </template>
        <p v-else class="muted" style="margin: 0">{{ t('schedule.errors.invalidAssignment') }}</p>
      </section>

      <p v-if="errorText" class="alert alert--error" role="alert" style="margin: 0">{{ errorText }}</p>

      <footer class="schedule-modal__actions">
        <button v-if="!softOnly" class="btn btn--primary" type="button" :disabled="saving || checking || !valid || hardConflict" @click="save(false)">{{ t('admin.saveStatus') }}</button>
        <button v-else class="btn btn--primary" type="button" :disabled="saving || checking" @click="save(true)">{{ t('schedule.saveAnyway') }}</button>
        <button v-if="current" class="btn btn--ghost" type="button" :disabled="saving" @click="clear">{{ t('schedule.clear') }}</button>
      </footer>
    </div>
  </AppModal>
</template>

<style scoped>
.schedule-modal { width: min(520px, 100%); }
.schedule-modal__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.schedule-modal__modes { margin: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); display: grid; gap: 8px; }
.schedule-modal__modes legend { padding: 0 6px; font-weight: 750; }
.schedule-modal__disabled { color: var(--text-muted); }
.schedule-modal__hint { margin: 4px 0 0; font-size: 0.82rem; }
.schedule-modal__conflicts { min-height: 24px; }
.schedule-modal__list { margin: 0; padding: 0 0 0 18px; display: grid; gap: 6px; font-size: 0.9rem; }
.schedule-modal__soft { color: var(--text); }
.schedule-modal__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.schedule-modal__actions .btn { flex: 1 1 160px; min-height: 44px; }
</style>
