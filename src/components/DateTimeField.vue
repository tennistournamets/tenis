<script setup>
/**
 * Дата+время на базе @vuepic/vue-datepicker.
 * Модель — та же строка, что у <input type="datetime-local"> («yyyy-MM-ddTHH:mm», локальное время),
 * поэтому конвертеры в registrationRules.js и MatchScheduleModal остаются без изменений.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VueDatePicker } from '@vuepic/vue-datepicker'
import '@vuepic/vue-datepicker/dist/main.css'
import { enUS, lt, ru } from 'date-fns/locale'
import { theme } from '../lib/theme'
import { formatDateTimeText, parseDateTimeText } from '../lib/dateTimeText'

// v14 ожидает объект локали date-fns, а не код языка.
const DP_LOCALES = { ru, en: enUS, lt }

const props = defineProps({
  modelValue: { type: String, default: '' },
  id: { type: String, required: true },
  disabled: Boolean,
  required: Boolean,
  ariaDescribedby: { type: String, default: undefined },
  minDate: { type: [String, Date], default: undefined },
  // Внутри <dialog> меню надо телепортировать в сам dialog: .modal-dialog режет overflow, а body лежит под top-layer.
  teleportToDialog: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const { t, locale } = useI18n()

const root = ref(null)
// The picker's `teleport` prop accepts a boolean or a selector (an element triggers a
// Vue prop warning), so the host dialog is marked and addressed by selector.
const teleportTarget = ref(false)
onMounted(() => {
  if (!props.teleportToDialog) return
  const dialog = root.value?.closest('dialog')
  if (!dialog) return
  if (!dialog.dataset.dtTeleport) dialog.dataset.dtTeleport = props.id
  teleportTarget.value = `dialog[data-dt-teleport="${dialog.dataset.dtTeleport}"]`
})

const pad = (n) => String(n).padStart(2, '0')
function parseLocal(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '')
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isNaN(d.getTime()) ? null : d
}
function formatLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const date = computed(() => parseLocal(props.modelValue))
function onUpdate(value) {
  emit('update:modelValue', value instanceof Date && !Number.isNaN(value.getTime()) ? formatLocal(value) : '')
}

const DISPLAY = 'dd.MM.yyyy HH:mm'
const display = computed(() => (date.value ? formatDateTimeText(props.modelValue) : ''))

// Typing is handled here, not by the picker's text-input mode: that mode parsed every
// partial keystroke ("1" -> the 1st of this month at the current time) and overwrote
// the field mid-typing. The text is committed only once it is a complete date and time.
// The picker's own input handlers are deliberately not wired to the element below.
const editing = ref(false)
const typed = ref('')
const shown = computed(() => (editing.value ? typed.value : display.value))
// A pick in the calendar (or "Now"/clear) while the input has focus replaces the text.
watch(() => props.modelValue, () => {
  // A value picked in the calendar clears a previous "required" message.
  root.value?.querySelector('input')?.setCustomValidity('')
  if (editing.value && parseDateTimeText(typed.value) !== (props.modelValue || '')) typed.value = display.value
})
function tooEarly(model) {
  const floor = min.value
  return Boolean(model && floor && parseLocal(model) < new Date(floor.getFullYear(), floor.getMonth(), floor.getDate()))
}
function onFocus() {
  editing.value = true
  typed.value = display.value
}
function onTyped(event) {
  event.target.setCustomValidity('')
  editing.value = true
  typed.value = event.target.value
  const parsed = parseDateTimeText(typed.value)
  if (parsed && !tooEarly(parsed) && parsed !== props.modelValue) emit('update:modelValue', parsed)
}
function commitTyped() {
  if (!editing.value) return
  const parsed = parseDateTimeText(typed.value)
  if (parsed === '') { if (props.modelValue) emit('update:modelValue', '') }
  else if (parsed && !tooEarly(parsed) && parsed !== props.modelValue) emit('update:modelValue', parsed)
  // Incomplete text never replaces the stored value: the field shows that value again.
  editing.value = false
}
function onEnter(event, isMenuOpen, toggleMenu) {
  event.preventDefault()
  commitTyped()
  if (isMenuOpen) toggleMenu()
}
const isDark = computed(() => theme.value === 'dark')
// The picker's own controls speak the page language, not English.
const ariaLabels = computed(() => {
  const dp = key => t(`actions.datePicker.${key}`)
  const unit = type => dp(type)
  return {
    clearInput: t('actions.clear'), calendarIcon: t('actions.pickDateTime'), input: t('actions.pickDateTime'),
    prevMonth: dp('prevMonth'), nextMonth: dp('nextMonth'), prevYear: dp('prevYear'), nextYear: dp('nextYear'),
    openMonthsOverlay: dp('openMonths'), openYearsOverlay: dp('openYears'), toggleOverlay: dp('toggleOverlay'), menu: dp('menu'),
    openTimePicker: dp('openTime'), closeTimePicker: dp('closeTime'), timePicker: dp('timePicker'),
    incrementValue: type => t('actions.datePicker.increment', { unit: unit(type) }),
    decrementValue: type => t('actions.datePicker.decrement', { unit: unit(type) }),
    openTpOverlay: type => t('actions.datePicker.openUnit', { unit: unit(type) }),
    timeOverlay: type => t('actions.datePicker.openUnit', { unit: unit(type) }),
    monthPicker: () => dp('openMonths'), yearPicker: () => dp('openYears'),
  }
})
// Native "required" bubbles use the browser language; give them the page's.
function onInvalid(event) {
  if (event.target.validity.valueMissing) event.target.setCustomValidity(t('actions.dateTimeRequired'))
}
const dpLocale = computed(() => DP_LOCALES[locale.value] || ru)
const min = computed(() => (typeof props.minDate === 'string' ? parseLocal(props.minDate) || undefined : props.minDate))
</script>

<template>
  <div ref="root" class="dt-field">
    <VueDatePicker
      :model-value="date"
      :dark="isDark"
      :locale="dpLocale"
      :formats="{ input: DISPLAY }"
      :text-input="{ format: DISPLAY, openMenu: 'open' }"
      :time-config="{ is24: true, minutesIncrement: 5, minutesGridIncrement: 5, timePickerInline: true }"
      :min-date="min"
      :disabled="disabled"
      :week-start="1"
      :teleport="teleportTarget"
      :menu-id="`${id}-menu`"
      auto-apply
      :action-row="{ showNow: true, showPreview: false, nowBtnLabel: t('actions.now') }"
      :placeholder="t('actions.pickDateTime')"
      :aria-labels="ariaLabels"
      @update:model-value="onUpdate"
    >
      <template #dp-input="{ isMenuOpen, toggleMenu, onClear }">
        <div class="dt-field__control" :class="{ 'dt-field__control--open': isMenuOpen }">
          <input
            :id="id"
            class="input dt-field__input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :value="shown"
            :placeholder="t('actions.pickDateTime')"
            :disabled="disabled"
            :required="required"
            :aria-describedby="ariaDescribedby"
            :aria-expanded="isMenuOpen"
            aria-haspopup="dialog"
            @focus="onFocus"
            @input="onTyped"
            @invalid="onInvalid"
            @keydown.enter="onEnter($event, isMenuOpen, toggleMenu)"
            @blur="commitTyped"
            @click="toggleMenu"
          />
          <button
            v-if="shown && !disabled"
            type="button"
            class="dt-field__btn dt-field__btn--clear"
            :aria-label="t('actions.clear')"
            @click.stop="onClear"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
          <button
            type="button"
            class="dt-field__btn"
            :aria-label="t('actions.pickDateTime')"
            :disabled="disabled"
            tabindex="-1"
            @click.stop="toggleMenu"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 10h18"/></svg>
          </button>
        </div>
      </template>
    </VueDatePicker>
  </div>
</template>

<style scoped>
.dt-field { min-width: 0; }
.dt-field__control { position: relative; display: flex; align-items: center; }
.dt-field__input { padding-right: 76px; }
.dt-field__input::placeholder { color: var(--muted); }
.dt-field__btn {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--muted); background: transparent; border: 0; border-radius: 8px; cursor: pointer;
  transition: color .15s, background .15s;
}
.dt-field__btn:hover:not(:disabled) { color: var(--text); background: var(--surface-row); }
.dt-field__btn:disabled { cursor: not-allowed; opacity: .5; }
.dt-field__btn--clear { right: 40px; }
.dt-field__control--open .dt-field__input { border-color: var(--primary); box-shadow: 0 0 0 4px var(--primary-focus-ring); }
</style>
