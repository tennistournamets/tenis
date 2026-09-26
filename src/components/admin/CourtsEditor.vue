<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { cloneForm, sameForm } from '../../lib/formDraft'
import { confirmDialog } from '../../lib/confirmDialog'
import { formatScheduleTime, indexSchedule, timezoneOf } from '../../lib/schedule'

const props = defineProps({
  courts: { type: Array, default: () => [] },
  schedule: { type: Array, default: () => [] },
  tournament: { type: Object, default: null },
  disabled: Boolean,
})
const emit = defineEmits(['save'])
const { t, locale } = useI18n()

// Per-court load from the draft schedule: how many matches and the earliest start.
const usage = computed(() => {
  const out = {}
  for (const row of Object.values(indexSchedule(props.schedule).draft)) {
    if (!row.court_id) continue
    const entry = out[row.court_id] ||= { count: 0, first: null }
    entry.count += 1
    if (row.scheduled_at && (!entry.first || row.scheduled_at < entry.first)) entry.first = row.scheduled_at
  }
  return out
})
const firstStart = id => formatScheduleTime(usage.value[id]?.first, locale.value, props.tournament ? timezoneOf(props.tournament) : '')

const toDraft = courts => courts.map(c => ({ id: c.id, name: c.name }))
const draft = ref(toDraft(props.courts))
const baseline = ref(cloneForm(draft.value))
const inputs = ref([])

// Server rows replace the draft only while nothing is being edited. A row that
// was just created comes back with an id, so it stops counting as unsaved.
watch(() => props.courts, courts => {
  const next = toDraft(courts)
  const idByName = new Map(next.map(c => [c.name.trim().toLowerCase(), c.id]))
  for (const row of draft.value) {
    if (!row.id) row.id = idByName.get(row.name.trim().toLowerCase()) ?? null
  }
  if (sameForm(draft.value, baseline.value)) draft.value = cloneForm(next)
  baseline.value = cloneForm(next)
}, { deep: true })

function isDirtyRow(index) {
  const row = draft.value[index]
  if (!row) return false
  if (!row.id) return row.name.trim().length > 0
  const saved = baseline.value.find(b => b.id === row.id)
  return !saved || saved.name !== row.name
}

/** Empty, too long or repeated names are the same three rules the RPC enforces. */
function rowProblem(index) {
  const row = draft.value[index]
  if (!row) return ''
  const name = row.name.trim()
  if (!name) return 'courtNameEmpty'
  if (name.length > 60) return 'courtNameTooLong'
  const clash = draft.value.some((other, i) => i !== index && other.name.trim().toLowerCase() === name.toLowerCase())
  return clash ? 'courtNameDuplicate' : ''
}
function rowError(index) {
  return rowProblem(index) ? t('schedule.errors.invalidCourts') : ''
}
// The short label under the row names the actual problem (a long name is not "empty or repeated").
const rowLabel = index => t(`schedule.errors.${rowProblem(index)}`)

/** One message for the list: only an edited row can be invalid. */
const listError = computed(() => {
  for (let i = 0; i < draft.value.length; i++) {
    if (isDirtyRow(i)) { const error = rowError(i); if (error) return error }
  }
  return ''
})

async function add() {
  draft.value.push({ id: null, name: '' })
  const index = draft.value.length - 1
  await nextTick()
  inputs.value[index]?.focus()
}

function onRowFocusOut(index, event) {
  // Leaving for this row's own buttons is not leaving the row.
  if (event.currentTarget.contains(event.relatedTarget)) return
  // An untouched new row leaves nothing behind.
  const row = draft.value[index]
  if (row && !row.id && !row.name.trim()) draft.value.splice(index, 1)
}

function payload(list) {
  return list.map(c => ({ id: c.id, name: c.name.trim() }))
}

function saveRow(index) {
  if (props.disabled || rowError(index)) return
  // The field keeps focus, so its actions stay until the organizer leaves the row.
  emit('save', payload(draft.value))
}

async function removeRow(index) {
  if (props.disabled) return
  const row = draft.value[index]
  if (!row) return
  // A saved court is removed on the server; an unsaved one only leaves the form.
  if (row.id) {
    if (!(await confirmDialog(t('schedule.removeCourtConfirm', { name: row.name.trim() }), { danger: true }))) return
    const next = draft.value.filter((_, i) => i !== index)
    draft.value = next
    emit('save', payload(next))
  } else {
    draft.value.splice(index, 1)
  }
}

/** Escape affects one row only: a saved court returns to its stored name, a new one disappears. */
function revertRow(index) {
  const row = draft.value[index]
  if (!row) return
  const saved = row.id ? baseline.value.find(b => b.id === row.id) : null
  if (saved) row.name = saved.name
  else draft.value.splice(index, 1)
}
</script>

<template>
  <section class="courts-editor" :aria-label="t('schedule.courts')">
    <header class="courts-editor__head">
      <div class="courts-editor__heading">
        <h2 class="courts-editor__title">
          {{ t('schedule.courts') }}
          <span v-if="draft.length" class="courts-editor__total">{{ draft.length }}</span>
        </h2>
        <p class="courts-editor__intro">{{ t('schedule.courtsIntro') }}</p>
      </div>
      <button v-if="draft.length" class="btn btn--primary btn--sm" type="button" :disabled="disabled" @click="add">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
        {{ t('schedule.addCourt') }}
      </button>
    </header>

    <div v-if="!draft.length" class="courts-empty">
      <span class="courts-empty__art" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M12 5v14" /><path d="M3 12h18" /><path d="M7 5v14" opacity=".5" /><path d="M17 5v14" opacity=".5" /></svg>
      </span>
      <strong class="courts-empty__title">{{ t('schedule.emptyCourtsTitle') }}</strong>
      <p class="courts-empty__text">{{ t('schedule.noCourts') }}</p>
      <button class="btn btn--primary" type="button" :disabled="disabled" @click="add">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
        {{ t('schedule.addCourt') }}
      </button>
    </div>

    <ol v-else class="courts-grid">
      <!-- Keyed by position: a row that gains its server id must not be
           re-created, or the field being edited would lose focus. -->
      <li
        v-for="(court, index) in draft"
        :key="index"
        class="court-card"
        :class="{ 'court-card--dirty': isDirtyRow(index), 'court-card--error': isDirtyRow(index) && rowError(index) }"
        @focusout="onRowFocusOut(index, $event)"
      >
        <div class="court-card__top">
          <span class="court-card__no" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
          <span v-if="isDirtyRow(index)" class="court-card__unsaved">{{ t('schedule.unsavedCourt') }}</span>
          <button
            class="court-card__icon court-card__icon--remove"
            type="button"
            :disabled="disabled"
            :title="t('schedule.removeCourt')"
            :aria-label="t('schedule.removeCourt')"
            @mousedown.prevent
            @click="removeRow(index)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
          </button>
        </div>

        <input
          :ref="el => (inputs[index] = el)"
          v-model="court.name"
          class="court-card__input"
          :class="{ 'input--error': isDirtyRow(index) && rowError(index) }"
          type="text"
          maxlength="60"
          :aria-label="t('schedule.courtName')"
          :placeholder="t('schedule.courtName')"
          :disabled="disabled"
          @keydown.enter.prevent="saveRow(index)"
          @keydown.esc="revertRow(index)"
        />

        <div class="court-card__foot">
          <!-- Saving is offered only while the row differs from the stored court. -->
          <template v-if="isDirtyRow(index)">
            <span class="court-card__keys" :class="{ 'court-card__keys--error': rowError(index) }">{{ rowError(index) ? rowLabel(index) : t('schedule.courtKeysHint') }}</span>
            <button
              class="court-card__save"
              type="button"
              :disabled="disabled || Boolean(rowError(index))"
              :title="t('schedule.saveCourt')"
              :aria-label="t('schedule.saveCourt')"
              @mousedown.prevent
              @click="saveRow(index)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" /></svg>
              {{ t('schedule.save') }}
            </button>
          </template>
          <template v-else-if="court.id && usage[court.id]">
            <span class="court-card__stat">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>
              {{ t('schedule.matchesOnCourt', { n: usage[court.id].count }) }}
            </span>
            <span v-if="usage[court.id].first" class="court-card__stat court-card__stat--time">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              {{ t('schedule.firstStart', { time: firstStart(court.id) }) }}
            </span>
          </template>
          <span v-else class="court-card__stat court-card__stat--idle">{{ t('schedule.noMatchesOnCourt') }}</span>
        </div>
      </li>

      <li class="courts-grid__add">
        <button class="court-add" type="button" :disabled="disabled" @click="add">
          <span class="court-add__plus" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          </span>
          {{ t('schedule.addCourt') }}
        </button>
      </li>
    </ol>

    <p v-if="listError" class="courts-editor__error" role="alert">{{ listError }}</p>

    <p class="courts-editor__hint">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></svg>
      {{ t('schedule.courtsHint') }}
    </p>
  </section>
</template>

<style scoped>
.courts-editor { display: grid; gap: 20px; padding: 24px; }
.courts-editor__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 16px; }
.courts-editor__title {
  display: flex; align-items: center; gap: 10px; margin: 0;
  font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; color: var(--heading);
}
.courts-editor__total {
  display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 8px;
  border-radius: 999px; background: var(--primary-soft); color: var(--primary);
  font-family: var(--font-body); font-size: 0.8125rem; font-weight: 700; font-variant-numeric: tabular-nums;
}
.courts-editor__intro { margin: 4px 0 0; max-width: 72ch; color: var(--muted); font-size: 0.9375rem; line-height: 1.5; }

/* Grid of court cards */
.courts-grid { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.court-card {
  position: relative; display: grid; grid-template-rows: auto auto 1fr; gap: 12px; padding: 14px 14px 12px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-row);
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.court-card:hover { border-color: var(--border-strong); }
.court-card:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-focus-ring); }
.court-card.court-card--dirty { border-color: var(--warning-border); }
.court-card.court-card--dirty:focus-within { border-color: var(--primary); }
.court-card.court-card--error { border-color: var(--danger); box-shadow: 0 0 0 3px var(--danger-bg); }

.court-card__top { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.court-card__no {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 28px; border-radius: 8px;
  background: var(--primary-soft); color: var(--primary); font-family: var(--font-mono); font-size: 0.8125rem; font-weight: 600;
}
.court-card__unsaved {
  height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px;
  background: var(--warning-bg); color: var(--warning-text); font-size: 0.72rem; font-weight: 600;
}
.court-card__icon {
  margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0;
  border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer;
  opacity: 0.7; transition: opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
}
.court-card:hover .court-card__icon, .court-card:focus-within .court-card__icon { opacity: 1; }
.court-card__icon svg, .court-card__save svg, .court-card__stat svg {
  width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none;
}
.court-card__icon--remove:not(:disabled):hover { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }
.court-card__icon:disabled { opacity: 0.35; cursor: not-allowed; }
.court-card__icon:focus-visible, .court-card__save:focus-visible, .court-add:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

/* The name reads as the card title and becomes a field on hover/focus. */
.court-card__input {
  box-sizing: border-box; width: calc(100% + 20px); min-width: 0; min-height: 44px; padding: 8px 10px; margin: 0 -10px;
  border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--heading);
  font-family: var(--font-display); font-size: 1.125rem; font-weight: 700; letter-spacing: -0.01em;
  transition: border-color 0.15s, background 0.15s;
}
.court-card__input::placeholder { color: var(--disabled); font-weight: 600; }
.court-card__input:hover:not(:disabled) { border-color: var(--border-strong); background: var(--input-bg); }
.court-card__input:focus { outline: none; border-color: var(--primary); background: var(--input-bg); }
.court-card__input.input--error { border-color: var(--danger); }

.court-card__foot { align-self: end; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-height: 32px; padding-top: 10px; border-top: 1px solid var(--border); }
.court-card__stat { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8125rem; color: var(--text); }
.court-card__stat svg { color: var(--primary); }
.court-card__stat--time { color: var(--muted); font-variant-numeric: tabular-nums; }
.court-card__stat--time svg { color: var(--muted); }
.court-card__stat--idle { color: var(--muted); }
.court-card__keys { font-size: 0.75rem; color: var(--muted); }
.court-card__keys--error { color: var(--danger); }
.court-card__save {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
  border: 0; border-radius: 8px; background: var(--primary); color: var(--primary-contrast);
  font: inherit; font-size: 0.8125rem; font-weight: 600; cursor: pointer; transition: background 0.15s;
}
.court-card__save:hover:not(:disabled) { background: var(--primary-hover); }
.court-card__save:disabled { background: var(--disabled-bg); color: var(--disabled); cursor: not-allowed; }

/* Add tile */
.courts-grid__add { display: grid; }
.court-add {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 148px; padding: 16px;
  border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: transparent;
  color: var(--muted); font: inherit; font-size: 0.875rem; font-weight: 600; cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.court-add__plus {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%;
  background: var(--disabled-bg); color: var(--muted); transition: background 0.15s, color 0.15s;
}
.court-add:hover:not(:disabled) { border-color: var(--primary); color: var(--text); background: var(--primary-soft); }
.court-add:hover:not(:disabled) .court-add__plus { background: var(--primary); color: var(--primary-contrast); }
.court-add:disabled { cursor: not-allowed; opacity: 0.5; }

/* Empty state */
.courts-empty {
  display: grid; justify-items: center; gap: 8px; padding: 40px 16px; text-align: center;
  border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-row);
}
.courts-empty__art {
  display: inline-flex; align-items: center; justify-content: center; width: 72px; height: 72px; margin-bottom: 6px;
  border-radius: 20px; background: var(--primary-soft); color: var(--primary);
}
.courts-empty__title { font-family: var(--font-display); font-size: 1.0625rem; color: var(--heading); }
.courts-empty__text { margin: 0 0 8px; max-width: 44ch; color: var(--muted); font-size: 0.9rem; }

.courts-editor__error { margin: 0; color: var(--danger); font-size: 0.875rem; }
.courts-editor__hint { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted); font-size: 0.8125rem; }
.courts-editor__hint svg { flex: none; }

@media (max-width: 560px) {
  .courts-editor { padding: 16px; }
  .courts-grid { grid-template-columns: 1fr; }
  .court-add { min-height: 72px; flex-direction: row; }
  .court-card__icon { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .court-card, .court-card__input, .court-add, .court-card__icon { transition: none; }
}
</style>
