<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { cloneForm, sameForm } from '../../lib/formDraft'
import { confirmDialog } from '../../lib/confirmDialog'

const props = defineProps({
  courts: { type: Array, default: () => [] },
  disabled: Boolean,
})
const emit = defineEmits(['save'])
const { t } = useI18n()

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
function rowError(index) {
  const row = draft.value[index]
  if (!row) return ''
  const name = row.name.trim()
  if (!name || name.length > 60) return t('schedule.errors.invalidCourts')
  const clash = draft.value.some((other, i) => i !== index && other.name.trim().toLowerCase() === name.toLowerCase())
  return clash ? t('schedule.errors.invalidCourts') : ''
}

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
  <section class="courts-editor stack stack--sm" :aria-label="t('schedule.courts')">
    <div class="courts-editor__head">
      <h3 class="section-title" style="margin: 0">{{ t('schedule.courts') }}</h3>
      <button class="btn btn--primary btn--sm" type="button" :disabled="disabled" @click="add">
        {{ t('schedule.addCourt') }}
      </button>
    </div>

    <p v-if="!draft.length" class="muted">{{ t('schedule.noCourts') }}</p>

    <ol v-else class="courts-editor__list">
      <!-- Keyed by position: a row that gains its server id must not be
           re-created, or the field being edited would lose focus. -->
      <li
        v-for="(court, index) in draft"
        :key="index"
        class="courts-editor__row"
        @focusout="onRowFocusOut(index, $event)"
      >
        <span class="courts-editor__index">{{ index + 1 }}</span>
        <input
          :ref="el => (inputs[index] = el)"
          v-model="court.name"
          class="input courts-editor__input"
          :class="{ 'input--error': isDirtyRow(index) && rowError(index) }"
          type="text"
          maxlength="60"
          :aria-label="t('schedule.courtName')"
          :placeholder="t('schedule.courtName')"
          :disabled="disabled"
          @keydown.enter.prevent="saveRow(index)"
          @keydown.esc="revertRow(index)"
        />
        <span class="courts-editor__actions">
          <button
            class="courts-editor__icon courts-editor__icon--remove"
            type="button"
            :disabled="disabled"
            :title="t('schedule.removeCourt')"
            :aria-label="t('schedule.removeCourt')"
            @mousedown.prevent
            @click="removeRow(index)"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
          </button>
          <!-- Saving is offered only while the row differs from the stored court. -->
          <button
            v-if="isDirtyRow(index)"
            class="courts-editor__icon courts-editor__icon--save"
            type="button"
            :disabled="disabled || Boolean(rowError(index))"
            :title="t('schedule.saveCourt')"
            :aria-label="t('schedule.saveCourt')"
            @mousedown.prevent
            @click="saveRow(index)"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 8 14.5 16 6" /></svg>
          </button>
        </span>
      </li>
    </ol>

    <p v-if="listError" class="error-text" role="alert" style="margin: 0">{{ listError }}</p>

    <p class="muted courts-editor__hint">{{ t('schedule.courtsHint') }}</p>
  </section>
</template>

<style scoped>
.courts-editor__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.courts-editor__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.courts-editor__row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.courts-editor__index { color: var(--text-muted); font-weight: 700; text-align: center; }

.courts-editor__input { width: 100%; }
.courts-editor__input.input--error,
.courts-editor__input.input--error:focus { border-color: var(--danger); box-shadow: none; }

/* Row controls live next to the field: remove is always there, save joins it
   as soon as the name differs from the stored one. The slot keeps its width so
   the field does not resize, and remove stays next to the field either way. */
.courts-editor__actions {
  display: inline-flex;
  gap: 4px;
  min-width: 68px;
  justify-content: flex-start;
}

.courts-editor__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}

.courts-editor__icon svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.courts-editor__icon:disabled { opacity: .45; cursor: not-allowed; }
.courts-editor__icon:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }

.courts-editor__icon--save:not(:disabled) { color: var(--primary); }
.courts-editor__icon--save:not(:disabled):hover { background: var(--primary-muted); border-color: var(--primary); }
.courts-editor__icon--remove:not(:disabled):hover { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border, var(--danger)); }

.courts-editor__hint { margin: 0; font-size: 0.82rem; }
</style>
